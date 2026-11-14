
import { 
    App, Modal, ItemView, WorkspaceLeaf, Menu, TFile, Notice, 
    Setting, PluginSettingTab, setIcon, debounce 
} from 'obsidian';
import * as Diff from 'diff';
import type VersionControlPlugin from './main';
import type { VersionData, VersionMeta, GlobalHistoryItem, ViewMode, GlobalFilterMode } from './main';

type CurrentFilterMode = 'all' | 'starred' | 'manual';

// --- 日期分组与精简时间格式化工具 ---
function getDateGroupLabel(timestamp: number): string {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 86_400_000;

    if (timestamp >= todayStart) return '今天';
    if (timestamp >= yesterdayStart) return '昨天';

    const d = new Date(timestamp);
    if (d.getFullYear() === now.getFullYear()) {
        return `${d.getMonth() + 1}月${d.getDate()}日`;
    }
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

function formatClockTime(timestamp: number): string {
    const d = new Date(timestamp);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatSmartGlobalTime(timestamp: number): string {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const d = new Date(timestamp);
    if (timestamp >= todayStart) {
        return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    }
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function splitNotePath(filePath: string): { dir: string; name: string } {
    const lastSlash = filePath.lastIndexOf('/');
    const dir = lastSlash !== -1 ? filePath.substring(0, lastSlash) : '';
    const base = lastSlash !== -1 ? filePath.substring(lastSlash + 1) : filePath;
    const name = base.endsWith('.md') ? base.slice(0, -3) : base;
    return { dir, name };
}

// =======================================================================
// ==================== 极速轻量化代码审查模态框 ==========================
// =======================================================================
export class DiffModal extends Modal {
    plugin: VersionControlPlugin;
    file: TFile;
    versionId: string;
    secondVersionId: string;
    ignoreWhitespace = true;
    showLineNumbers = true;
    foldContext = true;
    leftContent = '';
    rightContent = '';
    
    private diffElements: HTMLElement[] = [];
    private currentDiffIdx = 0;
    private totalDiffCount = 0;
    private renderToken = 0;
    
    private metricsBar: HTMLElement;
    private textDiffContainer: HTMLElement;
    private allVersions: VersionData[] = [];
    private statsBadge: HTMLElement;
    private prevBtn: HTMLButtonElement;
    private nextBtn: HTMLButtonElement;
    private foldToggle: HTMLButtonElement;
    private restoreLeftBtn: HTMLButtonElement;

    constructor(app: App, plugin: VersionControlPlugin, file: TFile, versionId: string, secondVersionId = 'current') {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.versionId = versionId;
        this.secondVersionId = secondVersionId;
    }

    async onOpen() {
        const { contentEl } = this; 
        contentEl.addClass('diff-modal', 'vc-raycast-modal');

        // 注册差异快捷键（↑/↓ 或 k/j）
        this.scope.register([], 'ArrowDown', (e: KeyboardEvent) => { e.preventDefault(); this.navigateDiff(1); });
        this.scope.register([], 'ArrowUp', (e: KeyboardEvent) => { e.preventDefault(); this.navigateDiff(-1); });
        this.scope.register([], 'j', (e: KeyboardEvent) => { e.preventDefault(); this.navigateDiff(1); });
        this.scope.register([], 'k', (e: KeyboardEvent) => { e.preventDefault(); this.navigateDiff(-1); });

        const header = contentEl.createEl('div', { cls: 'vc-diff-header' });
        const titleArea = header.createEl('div', { cls: 'vc-diff-title-area' });
        const iconSpan = titleArea.createEl('span', { cls: 'vc-diff-type-icon' });
        setIcon(iconSpan, 'git-commit');
        titleArea.createEl('span', { text: this.file.basename, cls: 'vc-diff-filename' });
        titleArea.createEl('span', { text: this.file.path, cls: 'vc-diff-filepath' });

        const selectorBar = contentEl.createEl('div', { cls: 'vc-diff-version-bar' });
        
        const leftBtn = selectorBar.createEl('button', { cls: 'vc-diff-version-capsule is-left-history' });
        this.updateChipText(leftBtn, this.versionId, '左侧');
        leftBtn.addEventListener('click', (e: MouseEvent) => this.showVersionMenu(e, 'left'));

        const swapBtn = selectorBar.createEl('button', { cls: 'vc-diff-swap-btn', attr: { 'aria-label': '调换两侧对比版本' } });
        setIcon(swapBtn, 'arrow-right-left');
        swapBtn.addEventListener('click', async () => {
            [this.versionId, this.secondVersionId] = [this.secondVersionId, this.versionId];
            await this.updateDiffView();
        });

        const rightBtn = selectorBar.createEl('button', { cls: 'vc-diff-version-capsule is-right-latest' });
        this.updateChipText(rightBtn, this.secondVersionId, '右侧');
        rightBtn.addEventListener('click', (e: MouseEvent) => this.showVersionMenu(e, 'right'));

        this.metricsBar = contentEl.createEl('div', { cls: 'vc-diff-metrics-bar' });

        const toolbar = contentEl.createEl('div', { cls: 'vc-diff-toolbar' });
        
        const navPill = toolbar.createEl('div', { cls: 'vc-diff-nav-pill' });
        this.prevBtn = navPill.createEl('button', { cls: 'vc-diff-nav-arrow', attr: { 'aria-label': '上一个差异 (↑ / K)' } });
        setIcon(this.prevBtn, 'chevron-up');
        this.prevBtn.addEventListener('click', () => this.navigateDiff(-1));

        this.statsBadge = navPill.createEl('span', { text: '0 / 0', cls: 'vc-diff-nav-counter', attr: { title: '支持键盘 ↑/↓ 或 J/K 快捷跳转差异' } });

        this.nextBtn = navPill.createEl('button', { cls: 'vc-diff-nav-arrow', attr: { 'aria-label': '下一个差异 (↓ / J)' } });
        setIcon(this.nextBtn, 'chevron-down');
        this.nextBtn.addEventListener('click', () => this.navigateDiff(1));

        const togglesGroup = toolbar.createEl('div', { cls: 'vc-diff-toggles' });

        const copyLeftBtn = togglesGroup.createEl('button', {
            cls: 'vc-toggle-chip',
            attr: { 'aria-label': '复制左侧版本完整正文到剪贴板' }
        });
        const copyIcon = copyLeftBtn.createEl('span', { cls: 'vc-chip-icon' });
        setIcon(copyIcon, 'copy');
        copyLeftBtn.createEl('span', { text: '复制左侧' });
        copyLeftBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(this.leftContent);
                new Notice('📋 已复制左侧版本全文');
            } catch {
                new Notice('❌ 复制失败');
            }
        });

        this.restoreLeftBtn = togglesGroup.createEl('button', {
            cls: 'vc-toggle-chip vc-btn-restore-modal',
            attr: { 'aria-label': '将当前文件恢复为左侧历史版本' }
        });
        const restoreIcon = this.restoreLeftBtn.createEl('span', { cls: 'vc-chip-icon' });
        setIcon(restoreIcon, 'undo-2');
        this.restoreLeftBtn.createEl('span', { text: '恢复左侧' });
        this.restoreLeftBtn.disabled = this.versionId === 'current';
        this.restoreLeftBtn.addEventListener('click', () => {
            if (this.versionId === 'current') return;
            const targetVer = this.allVersions.find(v => v.id === this.versionId);
            const timeLabel = targetVer ? this.plugin.formatTime(targetVer.timestamp) : '选中版本';
            new ConfirmModal(
                this.app,
                '确认回退至左侧版本？',
                `将使用「${timeLabel}」的内容覆盖当前工作区（当前内容会自动打下备份）。`,
                async () => {
                    await this.plugin.restoreVersion(this.file, this.versionId);
                    this.allVersions = await this.plugin.getAllVersions(this.file.path);
                    await this.updateDiffView();
                },
                '确认覆盖'
            ).open();
        });

        const saveSnapshotBtn = togglesGroup.createEl('button', { 
            cls: 'vc-toggle-chip vc-btn-save-snapshot',
            attr: { 'aria-label': '保存当前工作区为新快照' }
        });
        const saveIcon = saveSnapshotBtn.createEl('span', { cls: 'vc-chip-icon' });
        setIcon(saveIcon, 'bookmark-plus');
        saveSnapshotBtn.createEl('span', { text: '保存快照' });

        saveSnapshotBtn.addEventListener('click', async () => {
            if (!this.app.vault.getAbstractFileByPath(this.file.path)) {
                new Notice('❌ 当前笔记文件已不存在');
                return;
            }
            saveSnapshotBtn.disabled = true;
            saveSnapshotBtn.setText('保存中...');
            try {
                await this.plugin.createVersion(this.file, '[Manual Save]', false, [], true);
                this.allVersions = await this.plugin.getAllVersions(this.file.path);
                await this.updateDiffView();
            } finally {
                saveSnapshotBtn.disabled = false;
                saveSnapshotBtn.empty();
                const icon = saveSnapshotBtn.createEl('span', { cls: 'vc-chip-icon' });
                setIcon(icon, 'bookmark-plus');
                saveSnapshotBtn.createEl('span', { text: '保存快照' });
            }
        });

        this.foldToggle = togglesGroup.createEl('button', {
            text: this.foldContext ? '折叠未改' : '全部展开',
            cls: `vc-toggle-chip ${this.foldContext ? 'is-active' : ''}`
        });
        this.foldToggle.addEventListener('click', () => {
            this.foldContext = !this.foldContext;
            this.foldToggle.setText(this.foldContext ? '折叠未改' : '全部展开');
            this.foldToggle.toggleClass('is-active', this.foldContext);
            this.renderDiff();
        });

        const numToggle = togglesGroup.createEl('button', { 
            text: this.showLineNumbers ? '# 行号' : '# 无行号',
            cls: `vc-toggle-chip ${this.showLineNumbers ? 'is-active' : ''}`
        });
        numToggle.addEventListener('click', () => {
            this.showLineNumbers = !this.showLineNumbers;
            numToggle.setText(this.showLineNumbers ? '# 行号' : '# 无行号');
            numToggle.toggleClass('is-active', this.showLineNumbers);
            this.textDiffContainer.toggleClass('vc-hide-gutter', !this.showLineNumbers);
        });

        const wsToggle = togglesGroup.createEl('button', { 
            text: this.ignoreWhitespace ? '忽略空白' : '严格对比',
            cls: `vc-toggle-chip ${this.ignoreWhitespace ? 'is-active' : ''}`
        });
        wsToggle.addEventListener('click', () => {
            this.ignoreWhitespace = !this.ignoreWhitespace;
            wsToggle.setText(this.ignoreWhitespace ? '忽略空白' : '严格对比');
            wsToggle.toggleClass('is-active', this.ignoreWhitespace);
            this.renderDiff();
        });

        this.textDiffContainer = contentEl.createEl('div', { cls: 'vc-diff-viewport' });
        this.textDiffContainer.toggleClass('vc-hide-gutter', !this.showLineNumbers);

        try {
            const [versions, left, right] = await Promise.all([
                this.plugin.getAllVersions(this.file.path),
                this.fetchContent(this.versionId),
                this.fetchContent(this.secondVersionId)
            ]);

            this.allVersions = versions;
            this.leftContent = left;
            this.rightContent = right;

            this.updateChipText(leftBtn, this.versionId, '左侧');
            this.updateChipText(rightBtn, this.secondVersionId, '右侧');

            this.renderMetricsBar();
            await this.renderDiff();
        } catch {
            this.textDiffContainer.empty();
            const errBox = this.textDiffContainer.createEl('div', { cls: 'vc-empty-hero' });
            errBox.createEl('h4', { text: '无法加载版本内容' });
            errBox.createEl('p', { text: '版本可能已被删除或损坏，请尝试选择其他版本。' });
        }
    }

    private async fetchContent(verId: string): Promise<string> {
        if (verId === 'current') {
            const raw = await this.app.vault.read(this.file);
            return this.plugin.normalizeText(raw);
        }
        return await this.plugin.getVersionContent(this.file.path, verId);
    }

    updateChipText(btn: HTMLButtonElement, versionId: string, rolePrefix: string) {
        btn.empty();
        const isMobile = window.innerWidth <= 768;
        const iconSpan = btn.createEl('span', { cls: 'vc-capsule-icon' });
        if (versionId === 'current') {
            setIcon(iconSpan, 'file-edit');
            btn.createEl('span', { text: isMobile ? '当前工作区' : `${rolePrefix} · 当前工作区` });
            btn.title = '当前工作区实时文件';
        } else {
            setIcon(iconSpan, 'history');
            const v = this.allVersions.find(item => item.id === versionId);
            if (v) {
                const note = this.plugin.getCustomNote(v.message);
                const shortNote = note ? ` · ${note.length > 12 ? note.slice(0, 12) + '…' : note}` : '';
                const timeText = isMobile
                    ? this.plugin.formatCompactTime(v.timestamp)
                    : `${rolePrefix} · ${this.plugin.formatTime(v.timestamp)}${shortNote}`;
                btn.createEl('span', { text: timeText });
                btn.title = `${this.plugin.formatTime(v.timestamp)} (${this.plugin.getSaveTypeLabel(v.message)})${note ? '\n备注: ' + note : ''}`;
            } else {
                btn.createEl('span', { text: '历史快照' });
                btn.title = '';
            }
        }
    }

    showVersionMenu(event: MouseEvent, side: 'left' | 'right') {
        const menu = new Menu();
        menu.addItem(i => i.setTitle('📄 当前工作区内容 (最新)').setIcon('file-edit').onClick(() => {
            if (side === 'left') this.versionId = 'current'; else this.secondVersionId = 'current';
            this.updateDiffView();
        }));
        this.allVersions.forEach((v: VersionData, idx: number) => {
            const isLatestTag = idx === 0 ? ' [最新]' : '';
            const note = this.plugin.getCustomNote(v.message);
            const noteSuffix = note ? ` · ${note}` : '';
            menu.addItem(i => i.setTitle(`🕒 ${this.plugin.formatTime(v.timestamp)} · ${this.plugin.getSaveTypeLabel(v.message)}${noteSuffix}${isLatestTag}`).setIcon('history').onClick(() => {
                if (side === 'left') this.versionId = v.id; else this.secondVersionId = v.id;
                this.updateDiffView();
            }));
        });
        menu.showAtMouseEvent(event);
    }

    private renderMetricsBar() {
        if (!this.metricsBar) return;
        this.metricsBar.empty();

        const leftStats = this.plugin.getTextStats(this.leftContent);
        const rightStats = this.plugin.getTextStats(this.rightContent);

        const diffLines = rightStats.lines - leftStats.lines;
        const diffWords = rightStats.words - leftStats.words;
        const diffChars = rightStats.chars - leftStats.chars;

        const formatDelta = (delta: number) => delta > 0 ? `+${delta.toLocaleString()}` : (delta < 0 ? `${delta.toLocaleString()}` : '+0');
        const getDeltaClass = (delta: number) => delta > 0 ? 'is-plus' : (delta < 0 ? 'is-minus' : 'is-zero');

        const buildMetricItem = (title: string, iconName: string, leftVal: number, rightVal: number, delta: number) => {
            const item = this.metricsBar.createEl('div', { cls: 'vc-metric-chip' });
            
            const titleWrap = item.createEl('div', { cls: 'vc-metric-header' });
            const labelGroup = titleWrap.createEl('div', { cls: 'vc-metric-label-group' });
            const icon = labelGroup.createEl('span', { cls: 'vc-metric-icon' });
            setIcon(icon, iconName);
            labelGroup.createEl('span', { text: title, cls: 'vc-metric-title' });

            titleWrap.createEl('span', { text: formatDelta(delta), cls: `vc-metric-delta ${getDeltaClass(delta)}` });

            const dataWrap = item.createEl('div', { cls: 'vc-metric-body' });
            dataWrap.createEl('span', { text: leftVal.toLocaleString(), cls: 'vc-metric-old', attr: { title: '左侧版本' } });
            dataWrap.createEl('span', { text: '➔', cls: 'vc-metric-arrow' });
            dataWrap.createEl('span', { text: rightVal.toLocaleString(), cls: 'vc-metric-new', attr: { title: '右侧版本' } });
        };

        buildMetricItem('行数', 'rows', leftStats.lines, rightStats.lines, diffLines);
        buildMetricItem('词数', 'file-text', leftStats.words, rightStats.words, diffWords);
        buildMetricItem('字符数', 'type', leftStats.chars, rightStats.chars, diffChars);
    }

    async updateDiffView() {
        const chips = this.contentEl.querySelectorAll('.vc-diff-version-capsule') as NodeListOf<HTMLButtonElement>;
        if (chips[0]) this.updateChipText(chips[0], this.versionId, '左侧');
        if (chips[1]) this.updateChipText(chips[1], this.secondVersionId, '右侧');
        if (this.restoreLeftBtn) this.restoreLeftBtn.disabled = this.versionId === 'current';

        try {
            const [left, right] = await Promise.all([
                this.fetchContent(this.versionId),
                this.fetchContent(this.secondVersionId)
            ]);

            this.leftContent = left;
            this.rightContent = right;

            this.renderMetricsBar();
            await this.renderDiff();
        } catch {
            this.textDiffContainer.empty();
            const errBox = this.textDiffContainer.createEl('div', { cls: 'vc-empty-hero' });
            errBox.createEl('h4', { text: '版本读取失败' });
        }
    }

    navigateDiff(step: number) {
        if (this.totalDiffCount === 0) return;
        this.currentDiffIdx = (this.currentDiffIdx + step + this.totalDiffCount) % this.totalDiffCount;
        
        this.diffElements.forEach(el => el.removeClass('is-active-diff-row'));
        const target = this.diffElements[this.currentDiffIdx];
        if (target) {
            target.addClass('is-active-diff-row');
            target.scrollIntoView({ behavior: 'auto', block: 'center' });
        }
        this.updateNavStats();
    }

    updateNavStats() {
        if (this.totalDiffCount === 0) {
            this.statsBadge.setText('无变动');
            this.prevBtn.disabled = true;
            this.nextBtn.disabled = true;
        } else {
            this.statsBadge.setText(`${this.currentDiffIdx + 1} / ${this.totalDiffCount}`);
            this.prevBtn.disabled = false;
            this.nextBtn.disabled = false;
        }
    }

    private fastDiffChars(oldLine: string, newLine: string): Diff.Change[] {
        let prefixLen = 0;
        const minLen = Math.min(oldLine.length, newLine.length);
        while (prefixLen < minLen && oldLine[prefixLen] === newLine[prefixLen]) {
            prefixLen++;
        }

        let oldEnd = oldLine.length;
        let newEnd = newLine.length;
        while (oldEnd > prefixLen && newEnd > prefixLen && oldLine[oldEnd - 1] === newLine[newEnd - 1]) {
            oldEnd--;
            newEnd--;
        }

        const result: Diff.Change[] = [];
        if (prefixLen > 0) {
            result.push({ value: oldLine.slice(0, prefixLen), count: prefixLen, added: false, removed: false });
        }

        const midOld = oldLine.slice(prefixLen, oldEnd);
        const midNew = newLine.slice(prefixLen, newEnd);
        if (midOld.length > 0 || midNew.length > 0) {
            const changes = (midOld.length + midNew.length > 800)
                ? Diff.diffWordsWithSpace(midOld, midNew)
                : Diff.diffChars(midOld, midNew);
            result.push(...changes);
        }

        if (oldEnd < oldLine.length) {
            const suffix = oldLine.slice(oldEnd);
            result.push({ value: suffix, count: suffix.length, added: false, removed: false });
        }

        return result;
    }

    async renderDiff() {
        const myToken = ++this.renderToken;
        this.textDiffContainer.empty();
        this.textDiffContainer.toggleClass('vc-hide-gutter', !this.showLineNumbers);
        this.diffElements = [];
        this.currentDiffIdx = 0;

        const rawLineDiff = Diff.diffLines(this.leftContent, this.rightContent, { ignoreWhitespace: this.ignoreWhitespace });
        const hasAnyDiff = rawLineDiff.some(p => p.added || p.removed);

        if (this.leftContent === this.rightContent || !hasAnyDiff) {
            this.totalDiffCount = 0;
            this.updateNavStats();

            const emptyCard = this.textDiffContainer.createEl('div', { cls: 'vc-empty-hero' });
            const iconBox = emptyCard.createEl('div', { cls: 'vc-empty-hero-icon' });
            setIcon(iconBox, 'check-circle-2');
            
            emptyCard.createEl('h4', { text: '两处内容完全一致' });
            emptyCard.createEl('p', { 
                text: (this.leftContent !== this.rightContent && this.ignoreWhitespace)
                    ? '两版本仅存在空格/缩进差异（已在忽略空白模式下自动忽略）。'
                    : '对比的两个版本内容完全相同。' 
            });

            const switchBtn = emptyCard.createEl('button', { text: '选择其他版本对比', cls: 'mod-cta' });
            switchBtn.addEventListener('click', (e: MouseEvent) => this.showVersionMenu(e, 'left'));
            return;
        }

        let oldLineNum = 1;
        let newLineNum = 1;
        let frag = document.createDocumentFragment();
        let batchLines = 0;
        let jumpedToFirst = false;

        const flushBatchIfNeeded = async (force = false) => {
            if (!force && batchLines < 350) return false;
            if (batchLines === 0 && !force) return false;

            this.textDiffContainer.appendChild(frag);
            frag = document.createDocumentFragment();
            batchLines = 0;

            this.totalDiffCount = this.diffElements.length;
            this.updateNavStats();

            if (!jumpedToFirst && this.diffElements.length > 0) {
                jumpedToFirst = true;
                this.navigateDiff(0);
            }

            if (!force) {
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                if (myToken !== this.renderToken || !this.textDiffContainer.isConnected) return true;
            }
            return false;
        };

        for (let i = 0; i < rawLineDiff.length; i++) {
            const part = rawLineDiff[i]!;
            const nextPart = rawLineDiff[i + 1];

            if (part.removed && nextPart && nextPart.added) {
                const oldLines = part.value.replace(/\n$/, '').split('\n');
                const newLines = nextPart.value.replace(/\n$/, '').split('\n');
                const maxLen = Math.max(oldLines.length, newLines.length);

                for (let k = 0; k < maxLen; k++) {
                    const lLine = oldLines[k];
                    const rLine = newLines[k];

                    if (lLine !== undefined && rLine !== undefined) {
                        const curOld = oldLineNum++;
                        const curNew = newLineNum++;
                        const charDiff = this.fastDiffChars(lLine, rLine);

                        const lineEl = document.createElement('div');
                        lineEl.className = 'vc-diff-line vc-diff-line-modified';
                        this.buildGutter(lineEl, curOld, curNew);
                        lineEl.createEl('span', { cls: 'vc-diff-sign', text: '~' });
                        
                        const textSpan = lineEl.createEl('span', { cls: 'vc-diff-code' });
                        charDiff.forEach((cp: Diff.Change) => {
                            if (cp.added) {
                                textSpan.createEl('span', { cls: 'vc-word-badge-added', text: cp.value });
                            } else if (cp.removed) {
                                textSpan.createEl('span', { cls: 'vc-word-badge-removed', text: cp.value });
                            } else {
                                textSpan.appendText(cp.value);
                            }
                        });
                        this.diffElements.push(lineEl);
                        frag.appendChild(lineEl);
                        batchLines++;
                    } else if (lLine !== undefined) {
                        frag.appendChild(this.buildLineDOM('-', lLine, 'removed', oldLineNum++, null));
                        batchLines++;
                    } else if (rLine !== undefined) {
                        frag.appendChild(this.buildLineDOM('+', rLine, 'added', null, newLineNum++));
                        batchLines++;
                    }
                    if (await flushBatchIfNeeded()) return;
                }
                i++;
            } else if (part.added) {
                const lines = part.value.replace(/\n$/, '').split('\n');
                for (let j = 0; j < lines.length; j++) {
                    frag.appendChild(this.buildLineDOM('+', lines[j]!, 'added', null, newLineNum++));
                    batchLines++;
                    if (await flushBatchIfNeeded()) return;
                }
            } else if (part.removed) {
                const lines = part.value.replace(/\n$/, '').split('\n');
                for (let j = 0; j < lines.length; j++) {
                    frag.appendChild(this.buildLineDOM('-', lines[j]!, 'removed', oldLineNum++, null));
                    batchLines++;
                    if (await flushBatchIfNeeded()) return;
                }
            } else {
                const contextLines = part.value.replace(/\n$/, '').split('\n');
                const len = contextLines.length;

                if (this.foldContext && len > 12) {
                    const headKeep = i === 0 ? 0 : 3;
                    const tailKeep = i === rawLineDiff.length - 1 ? 0 : 3;

                    for (let h = 0; h < headKeep; h++) {
                        frag.appendChild(this.buildLineDOM(' ', contextLines[h]!, 'context', oldLineNum++, newLineNum++));
                        batchLines++;
                    }

                    const foldCount = len - headKeep - tailKeep;
                    const startOld = oldLineNum;
                    const startNew = newLineNum;
                    const foldBar = document.createElement('div');
                    foldBar.className = 'vc-diff-fold-bar';
                    foldBar.setText(`··· 折叠 ${foldCount.toLocaleString()} 行未改动内容 (点击展开) ···`);

                    oldLineNum += foldCount;
                    newLineNum += foldCount;

                    foldBar.addEventListener('click', () => {
                        const unfoldFrag = document.createDocumentFragment();
                        let curOld = startOld;
                        let curNew = startNew;
                        for (let m = headKeep; m < len - tailKeep; m++) {
                            unfoldFrag.appendChild(this.buildLineDOM(' ', contextLines[m]!, 'context', curOld++, curNew++));
                        }
                        foldBar.replaceWith(unfoldFrag);
                    });

                    frag.appendChild(foldBar);
                    batchLines++;

                    for (let t = len - tailKeep; t < len; t++) {
                        frag.appendChild(this.buildLineDOM(' ', contextLines[t]!, 'context', oldLineNum++, newLineNum++));
                        batchLines++;
                    }
                    if (await flushBatchIfNeeded()) return;
                } else {
                    for (let j = 0; j < len; j++) {
                        frag.appendChild(this.buildLineDOM(' ', contextLines[j]!, 'context', oldLineNum++, newLineNum++));
                        batchLines++;
                        if (await flushBatchIfNeeded()) return;
                    }
                }
            }
        }

        await flushBatchIfNeeded(true);
        if (!jumpedToFirst && this.totalDiffCount > 0) {
            setTimeout(() => {
                if (myToken === this.renderToken && this.textDiffContainer.isConnected) {
                    this.navigateDiff(0);
                }
            }, 20);
        }
    }

    private buildGutter(container: HTMLElement, oldNum: number | null, newNum: number | null) {
        const gutter = container.createEl('div', { cls: 'vc-diff-gutter' });
        gutter.createEl('span', { cls: 'vc-gutter-num vc-gutter-old', text: oldNum !== null ? String(oldNum) : '' });
        gutter.createEl('span', { cls: 'vc-gutter-num vc-gutter-new', text: newNum !== null ? String(newNum) : '' });
    }

    private buildLineDOM(marker: string, text: string, type: 'added' | 'removed' | 'context', oldNum: number | null, newNum: number | null): HTMLElement {
        const lineEl = document.createElement('div');
        lineEl.className = `vc-diff-line vc-diff-line-${type}`;

        this.buildGutter(lineEl, oldNum, newNum);
        lineEl.createEl('span', { cls: 'vc-diff-sign', text: marker });
        lineEl.createEl('span', { cls: 'vc-diff-code', text });
        if (type !== 'context') this.diffElements.push(lineEl);
        return lineEl;
    }

    onClose() {
        this.renderToken++;
        if (this.textDiffContainer) {
            this.textDiffContainer.style.display = 'none';
            this.textDiffContainer.remove();
        }
        this.diffElements = [];
        this.contentEl.empty();
    }
}

// =======================================================================
// ================= 快照备注与标签编辑弹窗 (SnapshotNoteModal) ===========
// =======================================================================
export class SnapshotNoteModal extends Modal {
    constructor(
        app: App,
        private plugin: VersionControlPlugin,
        private file: TFile,
        private editVersion?: VersionData,
        private onSaved?: () => void
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('vc-note-modal');
        const isEdit = Boolean(this.editVersion);

        contentEl.createEl('h3', { text: isEdit ? '✏️ 编辑快照备注与标签' : '🏷️ 保存带备注与标签的快照' });
        contentEl.createEl('div', {
            text: isEdit
                ? `${this.file.path} · ${this.plugin.formatTime(this.editVersion!.timestamp)}`
                : this.file.path,
            cls: 'vc-note-modal-sub'
        });

        const noteField = contentEl.createEl('div', { cls: 'vc-note-field' });
        noteField.createEl('label', { text: '快照备注 (Message)' });
        const noteInput = noteField.createEl('input', {
            type: 'text',
            placeholder: '例如：重大重构前备份 / 提交审稿定稿...'
        });
        if (this.editVersion) {
            noteInput.value = this.plugin.getCustomNote(this.editVersion.message);
        }

        const tagsField = contentEl.createEl('div', { cls: 'vc-note-field' });
        tagsField.createEl('label', { text: '标签 (Tags)' });
        const tagsInput = tagsField.createEl('input', {
            type: 'text',
            placeholder: '例如：里程碑, 初稿（用逗号或空格分隔）'
        });
        if (this.editVersion?.tags && this.editVersion.tags.length > 0) {
            tagsInput.value = this.editVersion.tags.join(', ');
        }
        tagsField.createEl('div', { text: '支持按备注或标签在时间线中快速检索', cls: 'vc-note-hint' });

        const actions = contentEl.createEl('div', { cls: 'vc-dialog-actions' });
        const cancelBtn = actions.createEl('button', { text: '取消' });
        cancelBtn.addEventListener('click', () => this.close());

        const submitBtn = actions.createEl('button', {
            text: isEdit ? '保存修改' : '保存快照',
            cls: 'mod-cta'
        });

        const handleSubmit = async () => {
            submitBtn.disabled = true;
            const rawNote = noteInput.value.trim();
            const tags = Array.from(new Set(
                tagsInput.value
                    .split(/[,，\s]+/)
                    .map(t => t.replace(/^#+/, '').trim())
                    .filter(Boolean)
            ));

            try {
                if (this.editVersion) {
                    const ok = await this.plugin.updateVersionMeta(this.file.path, this.editVersion.id, rawNote, tags);
                    if (ok) {
                        new Notice('✅ 快照备注与标签已更新');
                        this.onSaved?.();
                    }
                } else {
                    const msg = rawNote ? `[Manual Save] ${rawNote}` : '[Manual Save]';
                    await this.plugin.createVersion(this.file, msg, true, tags, true);
                    this.onSaved?.();
                }
                this.close();
            } finally {
                submitBtn.disabled = false;
            }
        };

        submitBtn.addEventListener('click', handleSubmit);
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                handleSubmit();
            }
        };
        noteInput.addEventListener('keydown', onKeyDown);
        tagsInput.addEventListener('keydown', onKeyDown);

        window.setTimeout(() => noteInput.focus(), 20);
    }

    onClose() { this.contentEl.empty(); }
}

// =======================================================================
// ================= 已删除笔记在线预览与多版本复活模态框 ================
// =======================================================================
export class DeletedNoteModal extends Modal {
    private currentVersion: VersionMeta | VersionData;
    private allVersions: VersionData[] = [];
    private previewBox: HTMLElement;
    private sizeSpan: HTMLElement;
    private versionSelect: HTMLSelectElement;

    constructor(
        app: App,
        private plugin: VersionControlPlugin,
        private filePath: string,
        private initialVersion: VersionMeta
    ) {
        super(app);
        this.currentVersion = initialVersion;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.addClass('diff-modal', 'vc-raycast-modal');

        const header = contentEl.createEl('div', { cls: 'vc-diff-header' });
        const titleArea = header.createEl('div', { cls: 'vc-diff-title-area' });
        const iconSpan = titleArea.createEl('span', { cls: 'vc-diff-type-icon' });
        setIcon(iconSpan, 'trash-2');
        titleArea.createEl('span', { text: '回收站 · 已删除笔记历史', cls: 'vc-diff-filename' });
        titleArea.createEl('span', { text: this.filePath, cls: 'vc-diff-filepath' });

        const metaBar = contentEl.createEl('div', { cls: 'vc-deleted-meta-bar vc-deleted-toolbar' });

        this.versionSelect = metaBar.createEl('select', { cls: 'vc-deleted-version-select' });
        this.versionSelect.createEl('option', {
            value: this.currentVersion.id,
            text: `🕒 ${this.plugin.formatTime(this.currentVersion.timestamp)} (加载全部版本中...)`
        });

        this.sizeSpan = metaBar.createEl('span', { text: `📝 ${(this.currentVersion.size ?? 0).toLocaleString()} 字符` });

        const btnGroup = metaBar.createEl('div', { cls: 'vc-deleted-actions-group' });

        const purgeFileBtn = btnGroup.createEl('button', {
            text: '🗑️ 彻底销毁',
            cls: 'mod-warning'
        });
        purgeFileBtn.addEventListener('click', () => {
            new ConfirmModal(
                this.app,
                '彻底销毁回收站历史？',
                `将永久清空「${this.filePath}」的全部历史快照，操作不可逆。`,
                async () => {
                    const ok = await this.plugin.deleteAllVersionsForFile(this.filePath);
                    if (ok) this.close();
                },
                '彻底销毁'
            ).open();
        });

        const resurrectBtn = btnGroup.createEl('button', {
            text: '♻️ 复活此版本',
            cls: 'mod-cta'
        });
        resurrectBtn.addEventListener('click', async () => {
            resurrectBtn.disabled = true;
            resurrectBtn.setText('正在复活...');
            const created = await this.plugin.resurrectDeletedFile(this.filePath, this.currentVersion.id);
            if (created) {
                this.close();
                await this.app.workspace.getLeaf(false).openFile(created);
            } else {
                resurrectBtn.disabled = false;
                resurrectBtn.setText('♻️ 复活此版本');
            }
        });

        this.previewBox = contentEl.createEl('div', { cls: 'vc-deleted-preview-body' });
        this.previewBox.setText('正在读取历史正文...');

        const [, versions] = await Promise.all([
            this.loadVersionPreview(this.currentVersion.id),
            this.plugin.getAllVersions(this.filePath)
        ]);

        if (!this.versionSelect.isConnected) return;
        this.allVersions = versions;
        if (this.allVersions.length > 0) {
            this.versionSelect.empty();
            this.allVersions.forEach((v, idx) => {
                const note = this.plugin.getCustomNote(v.message);
                const noteText = note ? ` · ${note}` : '';
                const latestTag = idx === 0 ? ' [最新]' : '';
                const opt = this.versionSelect.createEl('option', {
                    value: v.id,
                    text: `${this.plugin.formatTime(v.timestamp)} · ${this.plugin.getSaveTypeLabel(v.message)}${noteText} (${v.size.toLocaleString()}字)${latestTag}`
                });
                if (v.id === this.currentVersion.id) opt.selected = true;
            });

            this.versionSelect.addEventListener('change', async () => {
                const chosen = this.allVersions.find(v => v.id === this.versionSelect.value);
                if (chosen) {
                    this.currentVersion = chosen;
                    this.sizeSpan.setText(`📝 ${(chosen.size ?? 0).toLocaleString()} 字符`);
                    await this.loadVersionPreview(chosen.id);
                }
            });
        }
    }

    private async loadVersionPreview(versionId: string) {
        if (!this.previewBox.isConnected) return;
        this.previewBox.setText('正在读取历史正文...');
        try {
            const text = await this.plugin.getVersionContent(this.filePath, versionId);
            if (this.previewBox.isConnected && this.currentVersion.id === versionId) {
                this.previewBox.setText(text || '(空笔记)');
            }
        } catch {
            if (this.previewBox.isConnected) {
                this.previewBox.setText('❌ 无法解析历史正文内容');
            }
        }
    }

    onClose() { this.contentEl.empty(); }
}

// =======================================================================
// ================= 现代化时间轴视图 (ItemView) =========================
// =======================================================================
export class VersionHistoryView extends ItemView {
    plugin: VersionControlPlugin;
    currentFile: TFile | null = null;
    searchQuery = '';
    globalSearchQuery = ''; 
    searchFullText = false;
    currentViewMode: ViewMode = 'current';
    currentFilterMode: CurrentFilterMode = 'all';
    globalFilterMode: GlobalFilterMode = 'all';

    private currentResultsBox: HTMLElement | null = null;
    private globalResultsBox: HTMLElement | null = null;
    private timelineScrollEl: HTMLElement | null = null;
    private trashCountEl: HTMLElement | null = null;

    private currentRenderToken = 0;
    private globalRenderToken = 0;

    private relTimeEntries: { el: HTMLElement; ts: number }[] = [];
    private tickCount = 0;

    private searchCacheKey = '';
    private searchContentCache: Map<string, string> = new Map();
    private searchContentCacheChars = 0;

    private debouncedStructuralRefresh: () => void;
    private debouncedSearchCurrent: () => void;
    private debouncedSearchGlobal: () => void;

    constructor(leaf: WorkspaceLeaf, plugin: VersionControlPlugin) {
        super(leaf);
        this.plugin = plugin;

        this.debouncedStructuralRefresh = debounce(() => {
            const activeEl = document.activeElement;
            if (activeEl && activeEl.closest('.vc-search-capsule')) return;
            this.refreshSmart();
        }, 350, true);

        this.debouncedSearchCurrent = debounce(() => {
            if (this.currentResultsBox?.isConnected && this.currentFile) {
                this.renderCurrentResultsList(this.currentResultsBox, this.currentFile, false);
            }
        }, 220, true);

        this.debouncedSearchGlobal = debounce(() => {
            if (this.globalResultsBox?.isConnected) {
                this.renderGlobalResultsList(this.globalResultsBox, false);
            }
        }, 220, true);
    }

    getViewType(): string { return 'version-history'; }
    getDisplayText(): string { return '版本历史'; }
    getIcon(): string { return 'history'; }

    isGlobalViewVisible(): boolean {
        return this.currentViewMode === 'global' && this.contentEl.isConnected && this.contentEl.offsetParent !== null;
    }

    private invalidateSearchCache() {
        this.searchCacheKey = '';
        this.searchContentCache.clear();
        this.searchContentCacheChars = 0;
    }

    async onOpen() {
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                if (this.currentViewMode === 'current') {
                    const active = this.app.workspace.getActiveFile();
                    if (active && (!this.currentFile || this.currentFile.path !== active.path)) {
                        this.invalidateSearchCache();
                        this.refresh();
                    } else if (!active && this.currentFile) {
                        this.currentFile = null; 
                        this.invalidateSearchCache();
                        this.refresh();
                    }
                } else if (this.currentViewMode === 'global' && this.globalResultsBox?.isConnected) {
                    // 切文件时刷新一下全库列表中「当前打开」的高亮标识
                    this.refreshSmart();
                }
            })
        );

        this.registerEvent(this.app.vault.on('rename', () => this.debouncedStructuralRefresh()));
        this.registerEvent(this.app.vault.on('delete', () => this.debouncedStructuralRefresh()));

        await this.refresh();
    }

    async onClose() {
        this.currentRenderToken++;
        this.globalRenderToken++;
        this.relTimeEntries = [];
        this.invalidateSearchCache();
        this.currentResultsBox = null;
        this.globalResultsBox = null;
        this.timelineScrollEl = null;
        this.trashCountEl = null;
        this.currentFile = null;
    }

    updateRelativeTimes() {
        if (!this.contentEl.isConnected || this.contentEl.offsetParent === null) return;
        if (this.relTimeEntries.length === 0) return;

        this.tickCount++;
        const checkOlder = (this.tickCount % 15) === 0;
        const now = Date.now();

        for (let i = 0; i < this.relTimeEntries.length; i++) {
            const entry = this.relTimeEntries[i]!;
            if (!entry.el.isConnected) continue;
            const age = now - entry.ts;
            if (age < 65000 || checkOlder) {
                const newText = `(${this.plugin.getRelativeTime(entry.ts)})`;
                if (entry.el.textContent !== newText) {
                    entry.el.textContent = newText;
                }
            }
        }
    }

    async refreshSmart() {
        const activeEl = document.activeElement;
        const isTypingInSearch = Boolean(activeEl && activeEl.closest('.vc-search-capsule'));

        if (this.currentViewMode === 'current') {
            const active = this.app.workspace.getActiveFile();
            if (active?.path !== this.currentFile?.path) {
                if (!isTypingInSearch) await this.refresh();
                return;
            }
            if (active && this.currentResultsBox?.isConnected) {
                await this.renderCurrentResultsList(this.currentResultsBox, active, true);
                return;
            }
        } else if (this.currentViewMode === 'global') {
            if (this.globalResultsBox?.isConnected) {
                await this.renderGlobalResultsList(this.globalResultsBox, true);
                return;
            }
        }
        await this.refresh();
    }

    async refresh() {
        const scrollBox = this.timelineScrollEl ?? this.contentEl.querySelector('.vc-timeline-container');
        const prevScrollTop = scrollBox ? scrollBox.scrollTop : 0;

        const container = this.contentEl;
        container.empty();
        this.currentResultsBox = null;
        this.globalResultsBox = null;
        this.timelineScrollEl = null;
        this.trashCountEl = null;
        this.relTimeEntries = [];

        const buffer = container.createDiv({ cls: 'vc-root-shell' });

        const headerBar = buffer.createEl('div', { cls: 'vc-segmented-nav' });
        const tabs: { id: ViewMode, label: string, icon: string }[] = [
            { id: 'current', label: '当前笔记', icon: 'file-text' },
            { id: 'global', label: '全库时间线', icon: 'git-branch' }
        ];

        tabs.forEach(tab => {
            const btn = headerBar.createEl('button', { 
                cls: `vc-nav-tab ${this.currentViewMode === tab.id ? 'is-active' : ''}` 
            });
            const icon = btn.createEl('span', { cls: 'vc-nav-icon' });
            setIcon(icon, tab.icon);
            btn.createEl('span', { text: tab.label });
            
            btn.addEventListener('click', async () => { 
                if (this.currentViewMode === tab.id) return;
                this.currentViewMode = tab.id; 
                await this.refresh(); 
            });
        });

        const contentArea = buffer.createEl('div', { cls: 'vc-timeline-container' });
        this.timelineScrollEl = contentArea;
        if (this.currentViewMode === 'current') await this.renderCurrentFileHistory(contentArea);
        else await this.renderGlobalHistory(contentArea);

        if (prevScrollTop > 0) {
            contentArea.scrollTop = prevScrollTop;
        }
    }

    async renderCurrentFileHistory(container: HTMLElement) {
        const file = this.app.workspace.getActiveFile();
        this.currentFile = file;
        if (!file) { 
            const empty = container.createEl('div', { cls: 'vc-timeline-empty' });
            const icon = empty.createEl('div', { cls: 'vc-timeline-empty-icon' });
            setIcon(icon, 'file-x');
            empty.createEl('h4', { text: '未聚焦文件' });
            empty.createEl('p', { text: '在工作区打开任意笔记即可浏览其修改脉络。' });
            return; 
        }

        // 第 1 行：快捷筛选胶囊 + 创建快照按钮组（彻底解决窄侧边栏拥挤）
        const topActionRow = container.createEl('div', { cls: 'vc-header-action-row' });
        const pillsGroup = topActionRow.createEl('div', { cls: 'vc-filter-pills-group' });
        const currentFilters: { id: CurrentFilterMode; label: string }[] = [
            { id: 'all', label: '全部' },
            { id: 'starred', label: '⭐ 星标' },
            { id: 'manual', label: '✋ 手动' }
        ];

        const pillBtns = new Map<CurrentFilterMode, HTMLButtonElement>();
        currentFilters.forEach(f => {
            const pill = pillsGroup.createEl('button', {
                cls: `vc-filter-pill ${this.currentFilterMode === f.id ? 'is-active' : ''}`,
                text: f.label
            });
            pillBtns.set(f.id, pill);
            pill.addEventListener('click', async () => {
                if (this.currentFilterMode === f.id) return;
                this.currentFilterMode = f.id;
                pillBtns.forEach((b, mode) => b.toggleClass('is-active', mode === f.id));
                if (this.currentResultsBox) {
                    await this.renderCurrentResultsList(this.currentResultsBox, file, false);
                }
            });
        });

        const ctaGroup = topActionRow.createEl('div', { cls: 'vc-header-cta-group' });
        const noteSnapBtn = ctaGroup.createEl('button', {
            cls: 'vc-btn-note-snap',
            attr: { 'aria-label': '保存带备注与标签的快照' }
        });
        setIcon(noteSnapBtn, 'tag');
        noteSnapBtn.addEventListener('click', () => {
            new SnapshotNoteModal(this.app, this.plugin, file).open();
        });

        const snapBtn = ctaGroup.createEl('button', { cls: 'vc-btn-record', attr: { 'aria-label': '立即保存快照' } });
        setIcon(snapBtn, 'bookmark-plus');
        snapBtn.createEl('span', { text: '保存快照' });
        snapBtn.addEventListener('click', () => this.plugin.createManualVersion());

        // 第 2 行：100% 宽度搜索框
        const searchRow = container.createEl('div', { cls: 'vc-header-search-row' });
        const searchBox = searchRow.createEl('div', { cls: 'vc-search-capsule' });
        const searchIcon = searchBox.createEl('span', { cls: 'vc-search-icon' });
        setIcon(searchIcon, 'search');
        
        const searchInput = searchBox.createEl('input', { 
            type: 'text', 
            placeholder: this.searchFullText ? '搜索正文内容...' : '搜索备注或标签...' 
        });
        searchInput.value = this.searchQuery;

        const innerToggle = searchBox.createEl('button', {
            cls: `vc-search-inner-toggle ${this.searchFullText ? 'is-active' : ''}`,
            attr: { 'aria-label': this.searchFullText ? '当前正在检索正文（点击切换为普通搜索）' : '点击开启时光机正文全文检索' }
        });
        innerToggle.createEl('span', { text: '搜正文' });

        const clearBtn = searchBox.createEl('button', { 
            cls: 'vc-search-clear-btn', 
            attr: { 'aria-label': '清空搜索' } 
        });
        clearBtn.setText('✕');
        clearBtn.style.display = this.searchQuery ? 'flex' : 'none';

        innerToggle.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            this.searchFullText = !this.searchFullText;
            if (!this.searchFullText) this.invalidateSearchCache();
            innerToggle.toggleClass('is-active', this.searchFullText);
            searchInput.placeholder = this.searchFullText ? '搜索正文内容...' : '搜索备注或标签...';
            if (this.currentResultsBox) this.renderCurrentResultsList(this.currentResultsBox, file, false);
        });

        clearBtn.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            this.searchQuery = '';
            searchInput.value = '';
            clearBtn.style.display = 'none';
            if (this.currentResultsBox) this.renderCurrentResultsList(this.currentResultsBox, file, false);
            searchInput.focus();
        });

        searchInput.addEventListener('input', (e: Event) => { 
            this.searchQuery = (e.target as HTMLInputElement).value;
            clearBtn.style.display = this.searchQuery ? 'flex' : 'none';
            this.debouncedSearchCurrent(); 
        });

        this.currentResultsBox = container.createEl('div', { cls: 'vc-results-container' });
        await this.renderCurrentResultsList(this.currentResultsBox, file, false);
    }

    async renderCurrentResultsList(resultsContainer: HTMLElement, file: TFile, preserveScroll = false) {
        const myToken = ++this.currentRenderToken;
        const prevScroll = preserveScroll && this.timelineScrollEl ? this.timelineScrollEl.scrollTop : 0;

        const versionFile = await this.plugin.loadVersionFile(file.path);
        if (myToken !== this.currentRenderToken || !resultsContainer.isConnected) return;

        const allVersions = [...versionFile.versions];
        const totalCount = allVersions.length;

        if (totalCount === 0) { 
            this.relTimeEntries = [];
            resultsContainer.empty();
            const empty = resultsContainer.createEl('div', { cls: 'vc-timeline-empty' });
            const icon = empty.createEl('div', { cls: 'vc-timeline-empty-icon' });
            setIcon(icon, 'history');
            empty.createEl('h4', { text: '尚无快照记录' });
            empty.createEl('p', { text: '编辑笔记或点击上方「保存快照」打下第一个版本。' });
            return; 
        }

        const idToRealIndex = new Map<string, number>();
        allVersions.forEach((ver, idx) => idToRealIndex.set(ver.id, idx));

        let filteredVersions = allVersions;
        if (this.currentFilterMode === 'starred') {
            filteredVersions = filteredVersions.filter(v => Boolean(v.starred));
        } else if (this.currentFilterMode === 'manual') {
            filteredVersions = filteredVersions.filter(v => !v.message.includes('[Auto Save]'));
        }

        const snippetMatchMap = new Map<string, string>();

        if (this.searchQuery) {
            const q = this.searchQuery.toLowerCase();
            if (this.searchFullText) {
                const expectedKey = `${file.path}::${allVersions.length}::${allVersions[0]?.id ?? ''}`;
                if (this.searchCacheKey !== expectedKey) {
                    this.searchContentCache.clear();
                    this.searchContentCacheChars = 0;
                    this.searchCacheKey = expectedKey;
                }

                const matched: VersionData[] = [];
                for (let idx = 0; idx < filteredVersions.length; idx++) {
                    const v = filteredVersions[idx]!;
                    if (myToken !== this.currentRenderToken) return;
                    try {
                        let content = this.searchContentCache.get(v.id);
                        if (content === undefined) {
                            content = await this.plugin.getVersionContent(file.path, v.id, true);
                            if (this.searchContentCacheChars + content.length <= 30_000_000) {
                                this.searchContentCache.set(v.id, content);
                                this.searchContentCacheChars += content.length;
                            }
                        }
                        const pos = content.toLowerCase().indexOf(q);
                        if (pos !== -1) {
                            matched.push(v);
                            const start = Math.max(0, pos - 15);
                            const end = Math.min(content.length, pos + q.length + 15);
                            snippetMatchMap.set(v.id, content.substring(start, end).replace(/\n/g, ' '));
                        }
                    } catch {}
                    if (idx % 5 === 4) await this.plugin.yieldToMain();
                }
                filteredVersions = matched;
            } else {
                const cleanQ = q.replace(/^#+/, '');
                filteredVersions = filteredVersions.filter((v: VersionData) =>
                    v.message.toLowerCase().includes(q) ||
                    (v.tags && v.tags.some(t => t.toLowerCase().includes(cleanQ)))
                );
            }
        }

        if (myToken !== this.currentRenderToken || !resultsContainer.isConnected) return;
        this.relTimeEntries = [];
        resultsContainer.empty();

        if (this.searchQuery || this.currentFilterMode !== 'all') {
            const resultMeta = resultsContainer.createEl('div', { cls: 'vc-search-result-meta' });
            resultMeta.setText(`显示 ${filteredVersions.length} / ${totalCount} 个版本`);
        }

        if (filteredVersions.length === 0) {
            const empty = resultsContainer.createEl('div', { cls: 'vc-timeline-empty' });
            const icon = empty.createEl('div', { cls: 'vc-timeline-empty-icon' });
            setIcon(icon, this.currentFilterMode === 'starred' ? 'star' : 'search');
            empty.createEl('h4', { text: '没有符合条件的快照' });
            empty.createEl('p', { text: '尝试更换搜索关键词或切回「全部」筛选。' });
            return;
        }

        // 按日期分组渲染
        const groups: { label: string; items: VersionData[] }[] = [];
        for (const v of filteredVersions) {
            const label = getDateGroupLabel(v.timestamp);
            const lastGroup = groups[groups.length - 1];
            if (lastGroup && lastGroup.label === label) {
                lastGroup.items.push(v);
            } else {
                groups.push({ label, items: [v] });
            }
        }

        const rootFrag = document.createDocumentFragment();

        for (const group of groups) {
            const groupWrap = document.createElement('div');
            groupWrap.className = 'vc-date-group';

            const groupHeader = groupWrap.createEl('div', { cls: 'vc-date-group-header' });
            groupHeader.createEl('span', { text: group.label, cls: 'vc-date-group-title' });
            groupHeader.createEl('span', { text: `${group.items.length} 版`, cls: 'vc-date-group-count' });

            const timeline = groupWrap.createEl('div', { cls: 'vc-linear-timeline' });

            group.items.forEach((v: VersionData, index: number) => {
                const isManual = !v.message.includes('[Auto Save]');
                const item = document.createElement('div');
                item.className = `vc-timeline-entry ${v.starred ? 'is-starred' : ''}`;
                
                const rail = item.createEl('div', { cls: 'vc-timeline-rail' });
                rail.createEl('div', { cls: `vc-timeline-node ${isManual ? 'is-manual' : ''} ${v.starred ? 'is-star' : ''}` });
                if (index !== group.items.length - 1) {
                    rail.createEl('div', { cls: 'vc-timeline-line' });
                }

                const card = item.createEl('div', { cls: 'vc-timeline-card' });

                // 第 1 行：左侧类型与字数变动 | 右侧精简时间
                const cardHeader = card.createEl('div', { cls: 'vc-card-header' });
                const headerLeft = cardHeader.createEl('div', { cls: 'vc-card-header-left' });

                const typeBadge = headerLeft.createEl('span', { 
                    cls: `vc-tag-badge ${isManual ? 'badge-manual' : 'badge-auto'}` 
                });
                typeBadge.setText(this.plugin.getSaveTypeLabel(v.message));

                const realIdx = idToRealIndex.get(v.id) ?? -1;
                const realPrevVersion = realIdx !== -1 ? allVersions[realIdx + 1] : undefined;

                if (realPrevVersion) {
                    const diff = v.size - realPrevVersion.size;
                    const deltaClass = diff > 0 ? 'is-plus' : (diff < 0 ? 'is-minus' : 'is-zero');
                    const sign = diff > 0 ? '+' : '';
                    headerLeft.createEl('span', {
                        text: `${sign}${diff.toLocaleString()} 字`,
                        cls: `vc-diff-chars-badge ${deltaClass}`,
                        attr: { title: `较上一版本变动: ${sign}${diff} 字符 (当前: ${v.size.toLocaleString()} / 上版: ${realPrevVersion.size.toLocaleString()})` }
                    });
                } else {
                    headerLeft.createEl('span', {
                        text: `${v.size.toLocaleString()} 字`,
                        cls: 'vc-diff-chars-badge is-total',
                        attr: { title: `初始版本字符数: ${v.size.toLocaleString()}` }
                    });
                }

                const headerRight = cardHeader.createEl('div', {
                    cls: 'vc-card-header-right',
                    attr: { title: this.plugin.formatTime(v.timestamp) }
                });
                headerRight.createEl('span', { text: formatClockTime(v.timestamp), cls: 'vc-abs-time' });
                const relEl = headerRight.createEl('span', { 
                    text: `(${this.plugin.getRelativeTime(v.timestamp)})`, 
                    cls: 'vc-rel-time',
                    attr: { 'data-timestamp': String(v.timestamp) } 
                });
                this.relTimeEntries.push({ el: relEl, ts: v.timestamp });

                // 第 2 行（按需）：备注、标签与全文搜索片段
                const customNote = this.plugin.getCustomNote(v.message);
                const hasTags = Boolean(v.tags && v.tags.length > 0);
                const hasSnippet = snippetMatchMap.has(v.id);

                if (customNote || hasTags || hasSnippet) {
                    const cardBody = card.createEl('div', { cls: 'vc-card-body' });
                    if (customNote) {
                        cardBody.createEl('div', { cls: 'vc-custom-note', text: `📝 ${customNote}` });
                    }
                    if (hasTags) {
                        const tagsRow = cardBody.createEl('div', { cls: 'vc-card-tags' });
                        v.tags!.forEach((t: string) => {
                            tagsRow.createEl('span', { cls: 'vc-tag-custom', text: `#${t}` });
                        });
                    }
                    if (hasSnippet) {
                        const snipEl = cardBody.createEl('div', { cls: 'vc-snippet-match' });
                        snipEl.createEl('span', { text: '命中: ', cls: 'vc-snippet-label' });
                        snipEl.createEl('span', { text: `"...${snippetMatchMap.get(v.id)}..."`, cls: 'vc-snippet-text' });
                    }
                }

                // 第 3 行：舒展底部操作栏
                const footer = card.createEl('div', { cls: 'vc-card-footer' });
                const footerLeft = footer.createEl('div', { cls: 'vc-footer-group' });
                const footerRight = footer.createEl('div', { cls: 'vc-footer-group' });

                const starBtn = footerLeft.createEl('button', { 
                    cls: `vc-timeline-icon-btn ${v.starred ? 'is-starred' : ''}`, 
                    attr: { 'aria-label': v.starred ? '取消收藏' : '标记为重要里程碑' } 
                });
                setIcon(starBtn, 'star');
                starBtn.addEventListener('click', async (e: MouseEvent) => {
                    e.stopPropagation();
                    await this.plugin.toggleVersionStar(file.path, v.id);
                    this.renderCurrentResultsList(resultsContainer, file, true);
                });

                const editMetaBtn = footerLeft.createEl('button', {
                    cls: 'vc-timeline-icon-btn',
                    attr: { 'aria-label': '编辑备注与标签' }
                });
                setIcon(editMetaBtn, 'pencil');
                editMetaBtn.addEventListener('click', (e: MouseEvent) => {
                    e.stopPropagation();
                    new SnapshotNoteModal(this.app, this.plugin, file, v, () => {
                        this.renderCurrentResultsList(resultsContainer, file, true);
                    }).open();
                });

                const delBtn = footerLeft.createEl('button', { 
                    cls: 'vc-timeline-icon-btn vc-btn-danger', 
                    attr: { 'aria-label': '彻底删除此版本快照' } 
                });
                setIcon(delBtn, 'trash-2');
                delBtn.addEventListener('click', (e: MouseEvent) => {
                    e.stopPropagation();
                    new ConfirmModal(this.app, '彻底删除此快照？', `将永久销毁版本「${this.plugin.formatTime(v.timestamp)}」。底层将自动重组依赖链，不影响其他版本。`, async () => {
                        const ok = await this.plugin.deleteSingleVersion(file.path, v.id);
                        if (ok) {
                            this.invalidateSearchCache();
                            this.renderCurrentResultsList(resultsContainer, file, true);
                        }
                    }, '确认删除').open();
                });

                const prevDiffBtn = footerRight.createEl('button', { 
                    cls: 'vc-timeline-icon-btn', 
                    attr: { 'aria-label': realPrevVersion ? '对比上一版本 (查看此快照改动)' : '首个初始版本，无上一版本' } 
                });
                setIcon(prevDiffBtn, 'git-commit');
                if (realPrevVersion) {
                    prevDiffBtn.addEventListener('click', () => {
                        new DiffModal(this.app, this.plugin, file, realPrevVersion.id, v.id).open();
                    });
                } else {
                    prevDiffBtn.disabled = true;
                }

                const currentDiffBtn = footerRight.createEl('button', { 
                    cls: 'vc-timeline-icon-btn', 
                    attr: { 'aria-label': '对比当前工作区 (最新状态)' } 
                });
                setIcon(currentDiffBtn, 'git-compare');
                currentDiffBtn.addEventListener('click', () => {
                    new DiffModal(this.app, this.plugin, file, v.id, 'current').open();
                });

                const restoreBtn = footerRight.createEl('button', { cls: 'vc-timeline-icon-btn is-restore-btn', attr: { 'aria-label': '恢复至此版本' } });
                setIcon(restoreBtn, 'undo-2');
                restoreBtn.addEventListener('click', () => {
                    new ConfirmModal(this.app, '确认回退版本', '将使用该快照覆盖当前内容（当前最新状态会自动打下备份）。', async () => {
                        await this.plugin.restoreVersion(file, v.id);
                    }, '确认覆盖').open();
                });

                timeline.appendChild(item);
            });

            rootFrag.appendChild(groupWrap);
        }

        resultsContainer.appendChild(rootFrag);
        if (preserveScroll && prevScroll > 0 && this.timelineScrollEl) {
            this.timelineScrollEl.scrollTop = prevScroll;
        }
    }

    private buildGlobalHistoryCard(
        { version, prevVersion, filePath, file, hasUnsavedChanges, isUnversioned, currentChars, snapshotChars, prevSnapshotChars, charDiff, diffMode, totalVersions, hasStarred }: GlobalHistoryItem,
        isLast: boolean,
        activeFilePath?: string
    ): HTMLElement {
        const isDeleted = !file;
        const isCurrentActive = Boolean(file && activeFilePath === file.path);
        const message = version?.message || '自动保存';
        const isManual = !message.includes('[Auto Save]');
        const saveType = this.plugin.getSaveTypeLabel(message);
        const { dir, name } = splitNotePath(filePath);

        const item = document.createElement('div');
        item.className = `vc-timeline-entry ${hasStarred ? 'is-starred' : ''} ${isCurrentActive ? 'is-current-active' : ''}`;
        
        const rail = item.createEl('div', { cls: 'vc-timeline-rail' });
        rail.createEl('div', { 
            cls: `vc-timeline-node ${isDeleted ? 'is-deleted' : (isUnversioned ? 'is-unversioned' : (hasUnsavedChanges ? 'is-unsaved' : (hasStarred ? 'is-star' : (isManual ? 'is-manual' : ''))))}` 
        });
        if (!isLast) rail.createEl('div', { cls: 'vc-timeline-line' });

        const card = item.createEl('div', { cls: 'vc-timeline-card' });

        // 第 1 行：路径角标 + 高亮纯文件名 + 当前打开标识
        const cardHeader = card.createEl('div', { cls: 'vc-global-header' });
        if (dir) {
            cardHeader.createEl('div', { text: `📁 ${dir}`, cls: 'vc-card-folder', attr: { title: filePath } });
        }
        const titleRow = cardHeader.createEl('div', { cls: 'vc-timeline-title-row' });
        const link = titleRow.createEl('a', {
            text: name,
            cls: `vc-timeline-link ${isDeleted ? 'is-deleted-link' : ''}`,
            attr: { title: filePath }
        });
        link.addEventListener('click', () => { 
            if (file) {
                this.app.workspace.getLeaf(false).openFile(file);
            } else if (version?.id) {
                new DeletedNoteModal(this.app, this.plugin, filePath, version).open();
            }
        });

        if (isCurrentActive) {
            titleRow.createEl('span', { text: '当前打开', cls: 'vc-status-pill is-current-open' });
        }

        // 第 2 行：状态徽章、字符差值、版本总数、标签与备注
        const badgesWrap = card.createEl('div', { cls: 'vc-status-badges-wrap' });

        if (isDeleted) {
            badgesWrap.createEl('span', { text: '● 已删除', cls: 'vc-status-pill is-deleted' });
            badgesWrap.createEl('span', { 
                text: `${(snapshotChars ?? 0).toLocaleString()} 字`, 
                cls: 'vc-diff-chars-badge is-zero',
                attr: { title: '快照保存时的原笔记字数' }
            });
        } else if (diffMode === 'unversioned') {
            badgesWrap.createEl('span', { text: '● 待建快照', cls: 'vc-status-pill is-unversioned' });
            badgesWrap.createEl('span', { 
                text: `${currentChars?.toLocaleString() ?? 0} 字`, 
                cls: 'vc-diff-chars-badge is-total',
                attr: { title: '当前笔记总字符数' }
            });
        } else if (diffMode === 'workspace') {
            badgesWrap.createEl('span', { text: '● 工作区改动', cls: 'vc-status-pill is-unsaved' });
            const deltaClass = (charDiff ?? 0) > 0 ? 'is-plus' : ((charDiff ?? 0) < 0 ? 'is-minus' : 'is-zero');
            const sign = (charDiff ?? 0) > 0 ? '+' : '';
            badgesWrap.createEl('span', { 
                text: `${sign}${(charDiff ?? 0).toLocaleString()} 字`, 
                cls: `vc-diff-chars-badge ${deltaClass}`,
                attr: { title: `工作区相比最新快照：${sign}${charDiff} 字符` }
            });
        } else {
            const typeBadge = badgesWrap.createEl('span', { 
                cls: `vc-tag-badge ${isManual ? 'badge-manual' : 'badge-auto'}` 
            });
            typeBadge.setText(saveType);

            if (prevSnapshotChars !== undefined) {
                const deltaClass = (charDiff ?? 0) > 0 ? 'is-plus' : ((charDiff ?? 0) < 0 ? 'is-minus' : 'is-zero');
                const sign = (charDiff ?? 0) > 0 ? '+' : '';
                badgesWrap.createEl('span', { 
                    text: `${sign}${(charDiff ?? 0).toLocaleString()} 字`, 
                    cls: `vc-diff-chars-badge ${deltaClass}`,
                    attr: { title: `最新快照相比上一版本：${sign}${charDiff} 字符` }
                });
            } else {
                badgesWrap.createEl('span', { 
                    text: `初始 ${(snapshotChars ?? 0).toLocaleString()} 字`, 
                    cls: 'vc-diff-chars-badge is-zero',
                    attr: { title: '初始首版快照' }
                });
            }
        }

        if (totalVersions !== undefined && totalVersions > 0) {
            badgesWrap.createEl('span', {
                text: `${totalVersions} 版`,
                cls: 'vc-version-count-badge',
                attr: { title: `该笔记已累计保存 ${totalVersions} 个版本快照` }
            });
        }

        if (!isUnversioned && version?.tags && version.tags.length > 0) {
            version.tags.forEach(t => {
                badgesWrap.createEl('span', { cls: 'vc-tag-custom', text: `#${t}` });
            });
        }

        if (!isUnversioned) {
            const customNote = this.plugin.getCustomNote(message);
            if (customNote) {
                card.createEl('div', { cls: 'vc-custom-note', text: `📝 ${customNote}` });
            }
        }

        // 第 3 行：精简对齐时间
        const timeCol = card.createEl('div', { cls: 'vc-global-time-col' });

        if (file && file.stat && file.stat.mtime) {
            const mtime = file.stat.mtime;
            const mtimeRow = timeCol.createEl('div', {
                cls: 'vc-meta-time-row',
                attr: { title: `文件最后编辑时间: ${this.plugin.formatTime(mtime)}` }
            });
            const label = mtimeRow.createEl('span', { cls: `vc-meta-badge is-mtime ${hasUnsavedChanges ? 'is-highlight' : ''}` });
            const icon = label.createEl('span', { cls: 'vc-badge-icon' });
            setIcon(icon, 'pen-line');
            label.createEl('span', { text: '编辑' });

            const timeContainer = mtimeRow.createEl('div', { cls: 'vc-meta-time-cluster' });
            timeContainer.createEl('span', { text: formatSmartGlobalTime(mtime), cls: 'vc-meta-time-abs' });
            const mtimeRelEl = timeContainer.createEl('span', { 
                text: `(${this.plugin.getRelativeTime(mtime)})`, 
                cls: 'vc-rel-time',
                attr: { 'data-timestamp': String(mtime) } 
            });
            this.relTimeEntries.push({ el: mtimeRelEl, ts: mtime });
        }

        const snapRow = timeCol.createEl('div', {
            cls: 'vc-meta-time-row',
            attr: { title: version?.timestamp ? `最新快照保存时间: ${this.plugin.formatTime(version.timestamp)}` : '尚未保存快照' }
        });
        const snapLabel = snapRow.createEl('span', { cls: 'vc-meta-badge is-snap' });
        const snapIcon = snapLabel.createEl('span', { cls: 'vc-badge-icon' });
        setIcon(snapIcon, 'bookmark');
        snapLabel.createEl('span', { text: '快照' });

        const snapTimeContainer = snapRow.createEl('div', { cls: 'vc-meta-time-cluster' });
        if (isUnversioned || !version?.timestamp) {
            snapTimeContainer.createEl('span', { text: '尚未保存快照', cls: 'vc-meta-time-abs is-empty-text' });
        } else {
            snapTimeContainer.createEl('span', { text: formatSmartGlobalTime(version.timestamp), cls: 'vc-meta-time-abs' });
            const snapRelEl = snapTimeContainer.createEl('span', { 
                text: `(${this.plugin.getRelativeTime(version.timestamp)})`, 
                cls: 'vc-rel-time',
                attr: { 'data-timestamp': String(version.timestamp) } 
            });
            this.relTimeEntries.push({ el: snapRelEl, ts: version.timestamp });
        }

        // 第 4 行：舒展底部操作条
        const footer = card.createEl('div', { cls: 'vc-card-footer' });
        const footerLeft = footer.createEl('div', { cls: 'vc-footer-group' });
        const footerRight = footer.createEl('div', { cls: 'vc-footer-group' });

        if (file) {
            const cardSnapBtn = footerLeft.createEl('button', { 
                cls: `vc-timeline-icon-btn ${hasUnsavedChanges ? 'is-accent' : ''}`, 
                attr: { 'aria-label': hasUnsavedChanges ? '立即为此笔记保存改动快照' : '为此笔记创建新快照' } 
            });
            setIcon(cardSnapBtn, 'bookmark-plus');
            cardSnapBtn.addEventListener('click', async (e: MouseEvent) => {
                e.stopPropagation();
                await this.plugin.createVersion(file, '[Manual Save]', false, [], true);
            });

            if (!isUnversioned && version?.id) {
                if (prevVersion?.id) {
                    const prevDiffBtn = footerRight.createEl('button', { cls: 'vc-timeline-icon-btn', attr: { 'aria-label': '对比上一版本 (查看最新快照改动)' } });
                    setIcon(prevDiffBtn, 'git-commit');
                    prevDiffBtn.addEventListener('click', () => new DiffModal(this.app, this.plugin, file, prevVersion.id, version.id).open());
                }

                const diffBtn = footerRight.createEl('button', { cls: 'vc-timeline-icon-btn', attr: { 'aria-label': '对比当前工作区' } });
                setIcon(diffBtn, 'git-compare');
                diffBtn.addEventListener('click', () => new DiffModal(this.app, this.plugin, file, version.id, 'current').open());
            }
        } else if (version?.id) {
            const previewBtn = footerLeft.createEl('button', { 
                cls: 'vc-timeline-icon-btn', 
                attr: { 'aria-label': '浏览全部版本与内容预览' } 
            });
            setIcon(previewBtn, 'eye');
            previewBtn.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                new DeletedNoteModal(this.app, this.plugin, filePath, version).open();
            });

            const resurrectBtn = footerRight.createEl('button', { 
                cls: 'vc-timeline-icon-btn is-accent', 
                attr: { 'aria-label': '复活此已删除笔记' } 
            });
            setIcon(resurrectBtn, 'rotate-ccw');
            resurrectBtn.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                new ConfirmModal(this.app, '♻️ 复活已删除的笔记？', `将在原路径「${filePath}」使用最新快照重新创建恢复此笔记。`, async () => {
                    const created = await this.plugin.resurrectDeletedFile(filePath, version.id);
                    if (created) await this.app.workspace.getLeaf(false).openFile(created);
                }, '确认复活').open();
            });
        }

        return item;
    }

    private updateTrashCountBadge() {
        if (!this.trashCountEl || !this.trashCountEl.isConnected) return;
        const count = this.plugin.getGlobalTrashCount();
        this.trashCountEl.setText(count > 0 ? `(${count})` : '');
    }

    async renderGlobalHistory(container: HTMLElement) {
        // 第 1 行：操作工具栏
        const topActionRow = container.createEl('div', { cls: 'vc-header-action-row' });
        const leftActionGroup = topActionRow.createEl('div', { cls: 'vc-header-cta-group' });

        const batchBtn = leftActionGroup.createEl('button', {
            cls: 'vc-btn-batch-snap',
            attr: { 'aria-label': '一键为全库所有未保存改动的笔记创建快照' }
        });
        setIcon(batchBtn, 'layers');
        batchBtn.createEl('span', { text: '归档变动' });
        batchBtn.addEventListener('click', () => {
            new ConfirmModal(
                this.app,
                '一键归档所有变动笔记？',
                '将为全库所有存在未保存改动的笔记（含未建过快照的笔记）生成手动快照。内容未变化的文件会自动去重跳过。',
                async () => {
                    batchBtn.disabled = true;
                    try {
                        const res = await this.plugin.snapshotAllModifiedNotes();
                        if (res.savedCount > 0) {
                            new Notice(`✅ 批量归档完成：已为 ${res.savedCount} 篇笔记创建快照`);
                        } else {
                            new Notice('✨ 所有笔记均已是最新快照，无需归档');
                        }
                    } finally {
                        if (batchBtn.isConnected) batchBtn.disabled = false;
                    }
                },
                '立即归档'
            ).open();
        });

        const rightActionGroup = topActionRow.createEl('div', { cls: 'vc-header-cta-group' });

        const syncBtn = rightActionGroup.createEl('button', { 
            cls: 'vc-btn-sync-icon', 
            attr: { 'aria-label': '重建全库快照索引（多端同步后可点击校准）' } 
        });
        setIcon(syncBtn, 'refresh-cw');
        syncBtn.addEventListener('click', async () => {
            syncBtn.addClass('is-spinning');
            syncBtn.disabled = true;
            try {
                await this.plugin.rebuildGlobalIndex();
                new Notice('✅ 全库快照索引已同步重建');
            } finally {
                syncBtn.removeClass('is-spinning');
                syncBtn.disabled = false;
            }
        });

        const snapBtn = rightActionGroup.createEl('button', { cls: 'vc-btn-record', attr: { 'aria-label': '为当前活动笔记保存快照' } });
        setIcon(snapBtn, 'bookmark-plus');
        snapBtn.createEl('span', { text: '快照当前' });
        snapBtn.addEventListener('click', async () => {
            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile) {
                new Notice('没有打开的文件');
                return;
            }
            await this.plugin.createVersion(activeFile, '[Manual Save]', false, [], true);
        });

        // 第 2 行：100% 宽度全库搜索栏
        const searchRow = container.createEl('div', { cls: 'vc-header-search-row' });
        const searchBox = searchRow.createEl('div', { cls: 'vc-search-capsule' });
        const searchIcon = searchBox.createEl('span', { cls: 'vc-search-icon' });
        setIcon(searchIcon, 'search');

        const searchInput = searchBox.createEl('input', { type: 'text', placeholder: '搜索笔记路径、备注或标签...' });
        searchInput.value = this.globalSearchQuery;

        const clearBtn = searchBox.createEl('button', { 
            cls: 'vc-search-clear-btn', 
            attr: { 'aria-label': '清空搜索' } 
        });
        clearBtn.setText('✕');
        clearBtn.style.display = this.globalSearchQuery ? 'flex' : 'none';

        clearBtn.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            this.globalSearchQuery = '';
            searchInput.value = '';
            clearBtn.style.display = 'none';
            if (this.globalResultsBox) this.renderGlobalResultsList(this.globalResultsBox, false);
            searchInput.focus();
        });

        searchInput.addEventListener('input', (e: Event) => {
            this.globalSearchQuery = (e.target as HTMLInputElement).value;
            clearBtn.style.display = this.globalSearchQuery ? 'flex' : 'none';
            this.debouncedSearchGlobal();
        });

        // 第 3 行：筛选胶囊栏
        const filterBar = container.createEl('div', { cls: 'vc-global-filter-bar' });
        const pillsGroup = filterBar.createEl('div', { cls: 'vc-filter-pills-group' });

        const filterDefs: { id: GlobalFilterMode; label: string; isTrash?: boolean }[] = [
            { id: 'all', label: '全部' },
            { id: 'unsaved', label: '● 未保存' },
            { id: 'trash', label: '🗑️ 回收站', isTrash: true },
            { id: 'starred', label: '⭐ 星标' }
        ];

        const pillButtons: Map<GlobalFilterMode, HTMLButtonElement> = new Map();
        filterDefs.forEach(def => {
            const pill = pillsGroup.createEl('button', {
                cls: `vc-filter-pill ${def.isTrash ? 'is-trash' : ''} ${this.globalFilterMode === def.id ? 'is-active' : ''}`
            });
            pill.createEl('span', { text: def.label });
            if (def.isTrash) {
                this.trashCountEl = pill.createEl('span', { cls: 'vc-filter-count' });
                this.updateTrashCountBadge();
            }
            pillButtons.set(def.id, pill);

            pill.addEventListener('click', async () => {
                if (this.globalFilterMode === def.id) return;
                this.globalFilterMode = def.id;
                pillButtons.forEach((btn, mode) => btn.toggleClass('is-active', mode === def.id));
                if (this.globalResultsBox) {
                    await this.renderGlobalResultsList(this.globalResultsBox, false);
                }
            });
        });

        this.globalResultsBox = container.createEl('div', { cls: 'vc-timeline-content-area' });
        await this.renderGlobalResultsList(this.globalResultsBox, false);
    }

    async renderGlobalResultsList(timelineArea: HTMLElement, preserveScroll = false) {
        const myToken = ++this.globalRenderToken;
        const prevScroll = preserveScroll && this.timelineScrollEl ? this.timelineScrollEl.scrollTop : 0;

        let loadingEl: HTMLElement | null = null;
        if (!this.plugin.globalHistoryCache && !this.plugin.isSnapshotMetaLoaded) {
            this.relTimeEntries = [];
            timelineArea.empty();
            loadingEl = timelineArea.createEl('div', { cls: 'vc-timeline-loading' });
            loadingEl.createEl('div', { cls: 'vc-spinner' });
            loadingEl.createEl('span', { text: '正在加载全库时间线...' });
        }

        const fetchLimit = this.globalFilterMode === 'all' ? 100 : 300;
        let history: GlobalHistoryItem[] = [];
        try {
            history = await this.plugin.getGlobalHistory(fetchLimit, this.globalSearchQuery, this.globalFilterMode);
        } catch (e) {
            console.error('获取全库时间线失败:', e);
        } finally {
            if (loadingEl) loadingEl.remove();
        }

        if (myToken !== this.globalRenderToken || !timelineArea.isConnected) return;
        this.relTimeEntries = [];
        timelineArea.empty();
        this.updateTrashCountBadge();

        if (this.globalSearchQuery || this.globalFilterMode !== 'all') {
            const resultMeta = timelineArea.createEl('div', { cls: 'vc-search-result-meta' });
            const modeLabelMap: Record<GlobalFilterMode, string> = {
                all: '全库匹配',
                unsaved: '未保存改动',
                trash: '回收站已删除笔记',
                starred: '含星标快照笔记'
            };
            resultMeta.setText(`${modeLabelMap[this.globalFilterMode]}：${history.length} 篇`);
        }

        if (history.length === 0) {
            const empty = timelineArea.createEl('div', { cls: 'vc-timeline-empty' });
            const icon = empty.createEl('div', { cls: 'vc-timeline-empty-icon' });
            setIcon(icon, this.globalFilterMode === 'trash' ? 'trash-2' : 'history');

            if (this.globalSearchQuery) {
                empty.createEl('h4', { text: '未找到匹配笔记' });
                empty.createEl('p', { text: '请尝试更换关键词或切换上方筛选条件。' });
            } else if (this.globalFilterMode === 'trash') {
                empty.createEl('h4', { text: '回收站空空如也' });
                empty.createEl('p', { text: '已删除但保留有快照的笔记会出现在这里，支持随时预览和按原路径复活。' });
            } else if (this.globalFilterMode === 'unsaved') {
                empty.createEl('h4', { text: '所有笔记均已快照归档' });
                empty.createEl('p', { text: '当前工作区没有任何未保存为快照的新改动。' });
            } else if (this.globalFilterMode === 'starred') {
                empty.createEl('h4', { text: '暂无星标收藏笔记' });
                empty.createEl('p', { text: '在任意笔记的时间轴上点击星标图标，即可将关键版本设为永久里程碑。' });
            } else {
                empty.createEl('h4', { text: '暂无笔记快照' });
                empty.createEl('p', { text: '打开任意笔记并点击上方「快照当前」即可开始版本控制。' });
            }
            return;
        }

        let renderedCount = 0;
        const batchSize = 25;
        let lastDateLabel = '';
        let currentTimelineEl: HTMLElement | null = null;
        const activeFilePath = this.app.workspace.getActiveFile()?.path;

        const appendBatch = (count: number) => {
            const targetItems = history.slice(renderedCount, renderedCount + count);
            const frag = document.createDocumentFragment();

            targetItems.forEach((item, idx) => {
                try {
                    const globalIdx = renderedCount + idx;
                    const itemTs = item.file?.stat?.mtime ?? item.version?.timestamp ?? 0;
                    const dateLabel = getDateGroupLabel(itemTs);

                    const nextItem = history[globalIdx + 1];
                    const nextDateLabel = nextItem
                        ? getDateGroupLabel(nextItem.file?.stat?.mtime ?? nextItem.version?.timestamp ?? 0)
                        : '';
                    const isLastInGroup = !nextItem || nextDateLabel !== dateLabel;

                    if (dateLabel !== lastDateLabel || !currentTimelineEl) {
                        // 如果是分批追加，先将上一个未闭合组的末尾节点时间线去掉（上面用 isLastInGroup 已精准控制）
                        lastDateLabel = dateLabel;
                        const groupWrap = document.createElement('div');
                        groupWrap.className = 'vc-date-group';

                        const groupHeader = groupWrap.createEl('div', { cls: 'vc-date-group-header' });
                        groupHeader.createEl('span', { text: dateLabel, cls: 'vc-date-group-title' });

                        currentTimelineEl = groupWrap.createEl('div', { cls: 'vc-linear-timeline' });
                        frag.appendChild(groupWrap);
                    }

                    currentTimelineEl.appendChild(this.buildGlobalHistoryCard(item, isLastInGroup, activeFilePath));
                } catch (err) {
                    console.error('渲染单张卡片异常:', item.filePath, err);
                }
            });

            timelineArea.appendChild(frag);
            renderedCount += targetItems.length;
        };

        appendBatch(batchSize);

        if (history.length > renderedCount) {
            const moreContainer = timelineArea.createEl('div', { cls: 'vc-load-more-container' });
            const moreBtn = moreContainer.createEl('button', { 
                text: `加载更多笔记 (还有 ${history.length - renderedCount} 篇)...`,
                cls: 'vc-load-more-btn'
            });
            moreBtn.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                moreContainer.remove();
                appendBatch(batchSize);

                const remaining = history.length - renderedCount;
                if (remaining > 0) {
                    moreBtn.setText(`加载更多笔记 (还有 ${remaining} 篇)...`);
                    timelineArea.appendChild(moreContainer);
                }
            });
        }

        if (preserveScroll && prevScroll > 0 && this.timelineScrollEl) {
            this.timelineScrollEl.scrollTop = prevScroll;
        }
    }
}

// =======================================================================
// ============================= 辅助模态框 ==============================
// =======================================================================
export class ConfirmModal extends Modal {
    constructor(
        app: App, 
        private title: string, 
        private message: string, 
        private onConfirm: () => void,
        private confirmText = '确认执行'
    ) { super(app); }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('vc-confirm-dialog');
        contentEl.createEl('h3', { text: this.title });
        contentEl.createEl('p', { text: this.message });
        const box = contentEl.createEl('div', { cls: 'vc-dialog-actions' });
        const cancel = box.createEl('button', { text: '放弃' });
        cancel.addEventListener('click', () => this.close());
        const ok = box.createEl('button', { text: this.confirmText, cls: 'mod-warning' });
        ok.addEventListener('click', () => { this.close(); this.onConfirm(); });
    }
    onClose() { this.contentEl.empty(); }
}

export class IntegrityReportModal extends Modal {
    constructor(app: App, private report: { filePath: string; errors: string[] }[]) { super(app); }
    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('vc-raycast-modal');
        contentEl.createEl('h3', { text: '🛡️ 完整性检查诊断报告' });
        if (this.report.length === 0) {
            contentEl.createEl('p', { text: '✅ 所有版本快照完好无损，哈希一致。' });
            return;
        }
        contentEl.createEl('p', { text: `⚠️ 发现 ${this.report.length} 个文件存在异常：`, attr: { style: 'color: var(--text-warning);' } });
        const list = contentEl.createEl('div', { cls: 'vc-report-box' });
        this.report.forEach((item: { filePath: string; errors: string[] }) => {
            const row = list.createEl('div', { cls: 'vc-report-row' });
            row.createEl('strong', { text: item.filePath });
            const ul = row.createEl('ul');
            item.errors.forEach((e: string) => ul.createEl('li', { text: e }));
        });
    }
    onClose() { this.contentEl.empty(); }
}

// =======================================================================
// ========================== 现代化设置面板 ==============================
// =======================================================================
export class VersionControlSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: VersionControlPlugin) { super(app, plugin); }
    
    async display(): Promise<void> {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('vc-settings-tab');
        
        containerEl.createEl('h2', { text: '版本控制设置' });

        // 1. 存储分析仪表盘
        const statsBox = containerEl.createEl('div', { cls: 'vc-storage-dashboard' });
        statsBox.createEl('div', { text: '📊 存储占用分析与健康管理', cls: 'vc-storage-header' });

        const statsGrid = statsBox.createEl('div', { cls: 'vc-storage-grid' });
        const renderItem = (label: string, val: string, sub: string) => {
            const col = statsGrid.createEl('div', { cls: 'vc-storage-item' });
            col.createEl('div', { text: label, cls: 'vc-storage-item-label' });
            col.createEl('div', { text: val, cls: 'vc-storage-item-val' });
            col.createEl('div', { text: sub, cls: 'vc-storage-item-sub' });
        };

        renderItem('快照总数', '计算中...', '');
        renderItem('磁盘占用', '计算中...', '');
        renderItem('节省空间', '计算中...', '');

        this.plugin.getStorageStats().then(stats => {
            if (!statsGrid.isConnected) return;
            statsGrid.empty();
            renderItem('快照总数', `${stats.totalSnapshots.toLocaleString()} 个`, `${stats.totalFiles} 篇笔记`);
            renderItem('磁盘占用', this.plugin.formatFileSize(stats.actualDiskBytes), `未压等效: ${this.plugin.formatFileSize(stats.rawEquivalentBytes)}`);
            renderItem('节省空间', `${stats.savedPercent}%`, 'Gzip + 增量存储');
        });

        const purgeRow = statsBox.createEl('div', { cls: 'vc-storage-actions' });
        const purgeBtn = purgeRow.createEl('button', { text: '🧹 一键安全瘦身', cls: 'mod-cta' });
        const rebuildBtn = purgeRow.createEl('button', { text: '🔄 重建索引' });

        purgeRow.createEl('span', { 
            text: '保护机制：永久保留所有⭐标星收藏版本和每篇笔记最近 5 个快照，自动安全清理 30 天前的超期零散快照。',
            cls: 'vc-storage-tip'
        });

        purgeBtn.addEventListener('click', () => {
            new ConfirmModal(this.app, '确认执行存储瘦身？', '将彻底清理 30 天前未标星的旧快照。所有收藏的里程碑版本及最近的 5 个快照将受到严格保护。', async () => {
                purgeBtn.disabled = true;
                purgeBtn.setText('瘦身清理中...');
                try {
                    const res = await this.plugin.performStoragePurge(30, 5);
                    new Notice(`✅ 瘦身完成：已清理 ${res.purgedCount} 个冗余快照，释放 ${this.plugin.formatFileSize(res.savedBytes)} 磁盘空间！`);
                    await this.display();
                } finally {
                    purgeBtn.disabled = false;
                }
            }, '确认清理').open();
        });

        rebuildBtn.addEventListener('click', async () => {
            rebuildBtn.disabled = true;
            rebuildBtn.setText('重建中...');
            try {
                await this.plugin.rebuildGlobalIndex();
                new Notice('✅ 全库索引重建同步完成');
                await this.display();
            } finally {
                rebuildBtn.disabled = false;
            }
        });

        // 2. 自动保存与过滤规则
        containerEl.createEl('h3', { text: '自动保存与排除范围', cls: 'vc-settings-subhead' });

        new Setting(containerEl)
            .setName('修改自动保存')
            .setDesc('停止输入后自动生成版本历史快照')
            .addToggle(t => t.setValue(this.plugin.settings.autoSave).onChange(async (v: boolean) => {
                this.plugin.settings.autoSave = v;
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('保存延迟时间（分钟）')
            .setDesc('停止键入等待多少分钟后自动触发快照（例如输入 3 代表 3 分钟）')
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '0.5';
                text.inputEl.step = '0.5';
                text.inputEl.style.width = '80px';
                text.inputEl.style.textAlign = 'center';
                text.setPlaceholder('3')
                    .setValue(String(this.plugin.settings.autoSaveDelayOnModify ?? 3))
                    .onChange(async (val: string) => {
                        const num = parseFloat(val);
                        if (!isNaN(num) && num > 0) {
                            this.plugin.settings.autoSaveDelayOnModify = num;
                            await this.plugin.saveSettings();
                        }
                    });
            });

        new Setting(containerEl)
            .setName('内容去重')
            .setDesc('如果当前文本与最新快照内容完全一致，自动跳过保存，防止重复冗余')
            .addToggle(t => t.setValue(this.plugin.settings.enableDeduplication).onChange(async (v: boolean) => {
                this.plugin.settings.enableDeduplication = v;
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('排除文件夹')
            .setDesc('不追踪这些目录内的笔记变化（每行填写一个相对于库根目录的路径，例如 Templates 或 Daily/Archive）')
            .addTextArea(area => {
                area.inputEl.addClass('vc-settings-textarea');
                area.setPlaceholder('Templates\nAttachments\nExcalidraw')
                    .setValue((this.plugin.settings.excludedFolders || []).join('\n'));
                area.inputEl.addEventListener('change', async () => {
                    this.plugin.settings.excludedFolders = area.getValue()
                        .split('\n')
                        .map(s => s.trim().replace(/^\/+|\/+$/g, ''))
                        .filter(Boolean);
                    await this.plugin.saveSettings();
                    this.plugin.clearGlobalCache();
                    this.plugin.refreshVersionHistoryView();
                });
            });

        // 3. 自动清理与回收站策略
        containerEl.createEl('h3', { text: '历史清理与回收站策略', cls: 'vc-settings-subhead' });

        const clearRulesBox = containerEl.createDiv({ cls: 'vc-settings-nested-group' });
        const updateClearRulesVisibility = () => {
            clearRulesBox.style.display = this.plugin.settings.autoClear ? 'block' : 'none';
        };

        new Setting(containerEl)
            .setName('自动清理旧快照')
            .setDesc('保存新快照时，自动按下方策略清理超限或超期的未标星快照（标星版本永远受到保护）')
            .addToggle(t => t.setValue(this.plugin.settings.autoClear).onChange(async (v: boolean) => {
                this.plugin.settings.autoClear = v;
                await this.plugin.saveSettings();
                updateClearRulesVisibility();
            }));

        containerEl.appendChild(clearRulesBox);
        updateClearRulesVisibility();

        new Setting(clearRulesBox)
            .setName('限制单篇最大版本数')
            .setDesc('开启后，单篇笔记的非标星版本超出上限时将自动淘汰最早的历史')
            .addToggle(t => t.setValue(this.plugin.settings.enableMaxVersions).onChange(async (v: boolean) => {
                this.plugin.settings.enableMaxVersions = v;
                await this.plugin.saveSettings();
            }));

        new Setting(clearRulesBox)
            .setName('单篇最多保留版本数')
            .setDesc('每篇笔记保留的快照数量上限（建议 20 ~ 200）')
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
                text.inputEl.step = '1';
                text.inputEl.style.width = '80px';
                text.inputEl.style.textAlign = 'center';
                text.setPlaceholder('50')
                    .setValue(String(this.plugin.settings.maxVersions ?? 50))
                    .onChange(async (val: string) => {
                        const num = parseInt(val, 10);
                        if (!isNaN(num) && num >= 1) {
                            this.plugin.settings.maxVersions = num;
                            await this.plugin.saveSettings();
                        }
                    });
            });

        new Setting(clearRulesBox)
            .setName('按天数自动清理过期快照')
            .setDesc('自动移除早于指定天数的未标星旧快照')
            .addToggle(t => t.setValue(this.plugin.settings.enableMaxDays).onChange(async (v: boolean) => {
                this.plugin.settings.enableMaxDays = v;
                await this.plugin.saveSettings();
            }));

        new Setting(clearRulesBox)
            .setName('快照保留天数')
            .setDesc('超过该天数的未标星快照将被自动清理')
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
                text.inputEl.step = '1';
                text.inputEl.style.width = '80px';
                text.inputEl.style.textAlign = 'center';
                text.setPlaceholder('30')
                    .setValue(String(this.plugin.settings.maxDays ?? 30))
                    .onChange(async (val: string) => {
                        const num = parseInt(val, 10);
                        if (!isNaN(num) && num >= 1) {
                            this.plugin.settings.maxDays = num;
                            await this.plugin.saveSettings();
                        }
                    });
            });

        new Setting(containerEl)
            .setName('删除笔记时同步删除版本历史')
            .setDesc('关闭时（推荐）将保留已删除笔记的全部历史快照，可在「全库时间线 → 回收站」随时预览并一键复活原笔记')
            .addToggle(t => t.setValue(this.plugin.settings.deleteHistoryOnDelete).onChange(async (v: boolean) => {
                this.plugin.settings.deleteHistoryOnDelete = v;
                await this.plugin.saveSettings();
            }));

        // 4. 存储引擎与路径
        containerEl.createEl('h3', { text: '存储引擎与目录', cls: 'vc-settings-subhead' });

        new Setting(containerEl)
            .setName('原生流压缩 (gzip)')
            .setDesc('采用浏览器标准 Web Stream gzip 压缩，大幅减少磁盘占用')
            .addToggle(t => t.setValue(this.plugin.settings.enableCompression).onChange(async (v: boolean) => {
                this.plugin.settings.enableCompression = v;
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('增量补丁存储')
            .setDesc('仅记录差异增量，防止全量副本膨胀')
            .addToggle(t => t.setValue(this.plugin.settings.enableIncrementalStorage).onChange(async (v: boolean) => {
                this.plugin.settings.enableIncrementalStorage = v;
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('增量基线重建间隔')
            .setDesc('连续多少个增量补丁后重新保留一份完整基线快照（建议 5 ~ 20，越小读取越快但略占空间）')
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
                text.inputEl.max = '100';
                text.inputEl.step = '1';
                text.inputEl.style.width = '80px';
                text.inputEl.style.textAlign = 'center';
                text.setPlaceholder('10')
                    .setValue(String(this.plugin.settings.rebuildBaseInterval ?? 10))
                    .onChange(async (val: string) => {
                        const num = parseInt(val, 10);
                        if (!isNaN(num) && num >= 1) {
                            this.plugin.settings.rebuildBaseInterval = num;
                            await this.plugin.saveSettings();
                        }
                    });
            });

        let pendingFolderPath = this.plugin.settings.versionFolder;
        new Setting(containerEl)
            .setName('版本仓库存储目录')
            .setDesc('历史快照文件存放的隐藏文件夹路径（修改后需点击右侧「应用目录」）')
            .addText(text => {
                text.setPlaceholder('.versions')
                    .setValue(this.plugin.settings.versionFolder)
                    .onChange((val: string) => {
                        pendingFolderPath = val.trim();
                    });
            })
            .addButton(btn => {
                btn.setButtonText('应用目录').onClick(() => {
                    const cleanNew = pendingFolderPath.replace(/^\/+|\/+$/g, '');
                    if (!cleanNew) {
                        new Notice('❌ 目录路径不能为空');
                        return;
                    }
                    if (cleanNew === this.plugin.settings.versionFolder) {
                        new Notice('ℹ️ 目录路径未发生变化');
                        return;
                    }
                    new ConfirmModal(
                        this.app,
                        '迁移并切换版本目录？',
                        `将把现有目录「${this.plugin.settings.versionFolder}」中的全部历史快照文件自动迁移到「${cleanNew}」并重建索引。`,
                        async () => {
                            await this.plugin.migrateVersionFolder(cleanNew, true);
                            await this.display();
                        },
                        '确认迁移'
                    ).open();
                });
            });

        // 5. 界面与通知
        containerEl.createEl('h3', { text: '界面与通知', cls: 'vc-settings-subhead' });

        new Setting(containerEl)
            .setName('状态栏显示快照与实时字数变动')
            .setDesc('在底部状态栏实时显示最近快照时间及未快照字数差值，点击可快速对比差异')
            .addToggle(t => t.setValue(this.plugin.settings.enableStatusBarDiff).onChange(async (v: boolean) => {
                this.plugin.settings.enableStatusBarDiff = v;
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('显示操作提示通知')
            .setDesc('手动保存快照或恢复版本时在右上角显示提示消息')
            .addToggle(t => t.setValue(this.plugin.settings.showNotifications).onChange(async (v: boolean) => {
                this.plugin.settings.showNotifications = v;
                await this.plugin.saveSettings();
            }));
    }
}
