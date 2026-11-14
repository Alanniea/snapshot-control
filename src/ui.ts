
import { 
    App, Modal, ItemView, WorkspaceLeaf, Menu, TFile, Notice, 
    Setting, PluginSettingTab, setIcon, debounce 
} from 'obsidian';
import * as Diff from 'diff';
import type VersionControlPlugin from './main';
import type { VersionData, VersionMeta, GlobalHistoryItem, ViewMode } from './main';

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
        this.prevBtn = navPill.createEl('button', { cls: 'vc-diff-nav-arrow', attr: { 'aria-label': '上一个差异' } });
        setIcon(this.prevBtn, 'chevron-up');
        this.prevBtn.addEventListener('click', () => this.navigateDiff(-1));

        this.statsBadge = navPill.createEl('span', { text: '0 / 0', cls: 'vc-diff-nav-counter' });

        this.nextBtn = navPill.createEl('button', { cls: 'vc-diff-nav-arrow', attr: { 'aria-label': '下一个差异' } });
        setIcon(this.nextBtn, 'chevron-down');
        this.nextBtn.addEventListener('click', () => this.navigateDiff(1));

        const togglesGroup = toolbar.createEl('div', { cls: 'vc-diff-toggles' });

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
        // 纯 CSS 切换行号显隐，0ms 响应无需重跑 Diff
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
        } else {
            setIcon(iconSpan, 'history');
            const v = this.allVersions.find(item => item.id === versionId);
            if (v) {
                const timeText = isMobile ? this.plugin.formatCompactTime(v.timestamp) : `${rolePrefix} · ${this.plugin.formatTime(v.timestamp)}`;
                btn.createEl('span', { text: timeText });
            } else {
                btn.createEl('span', { text: '历史快照' });
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
            menu.addItem(i => i.setTitle(`🕒 ${this.plugin.formatTime(v.timestamp)} · ${this.plugin.getSaveTypeLabel(v.message)}${isLatestTag}`).setIcon('history').onClick(() => {
                if (side === 'left') this.versionId = v.id; else this.secondVersionId = v.id;
                this.updateDiffView();
            }));
        });
        menu.showAtMouseEvent(event);
    }

    private renderMetricsBar() {
        if (!this.metricsBar) return;
        this.metricsBar.empty();

        // 单次遍历零 GC 分配计算全部指标
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
            // 长段落降低阈值至 800，避免 Myers 字符矩阵卡顿
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
// ================= 已删除笔记在线预览与一键复活模态框 ====================
// =======================================================================
export class DeletedNoteModal extends Modal {
    constructor(
        app: App,
        private plugin: VersionControlPlugin,
        private filePath: string,
        private version: VersionMeta
    ) {
        super(app);
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.addClass('diff-modal', 'vc-raycast-modal');

        const header = contentEl.createEl('div', { cls: 'vc-diff-header' });
        const titleArea = header.createEl('div', { cls: 'vc-diff-title-area' });
        const iconSpan = titleArea.createEl('span', { cls: 'vc-diff-type-icon' });
        setIcon(iconSpan, 'trash-2');
        titleArea.createEl('span', { text: '已删除笔记快照预览', cls: 'vc-diff-filename' });
        titleArea.createEl('span', { text: this.filePath, cls: 'vc-diff-filepath' });

        const metaBar = contentEl.createEl('div', { cls: 'vc-deleted-meta-bar' });
        metaBar.createEl('span', { text: `🕒 快照时间: ${this.plugin.formatTime(this.version.timestamp)}` });
        metaBar.createEl('span', { text: `📝 字符数: ${(this.version.size ?? 0).toLocaleString()}` });

        const resurrectBtn = metaBar.createEl('button', {
            text: '♻️ 立即按原路径复活笔记',
            cls: 'mod-cta'
        });
        resurrectBtn.addEventListener('click', async () => {
            resurrectBtn.disabled = true;
            resurrectBtn.setText('正在复活...');
            const created = await this.plugin.resurrectDeletedFile(this.filePath, this.version.id);
            if (created) {
                this.close();
                await this.app.workspace.getLeaf(false).openFile(created);
            } else {
                resurrectBtn.disabled = false;
                resurrectBtn.setText('♻️ 立即按原路径复活笔记');
            }
        });

        const previewBox = contentEl.createEl('div', { cls: 'vc-deleted-preview-body' });
        previewBox.setText('正在读取历史正文...');

        try {
            const text = await this.plugin.getVersionContent(this.filePath, this.version.id);
            previewBox.setText(text || '(空笔记)');
        } catch {
            previewBox.setText('❌ 无法解析历史正文内容');
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

    private currentResultsBox: HTMLElement | null = null;
    private globalResultsBox: HTMLElement | null = null;
    private timelineScrollEl: HTMLElement | null = null;

    private currentRenderToken = 0;
    private globalRenderToken = 0;

    private relTimeEntries: { el: HTMLElement; ts: number }[] = [];
    private tickCount = 0;

    // 搜正文模式会话级正文缓存（避免 50 槽全局 LRU 抖动）
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
                }
            })
        );

        // 普通打字修改不再触发当前笔记视图重绘，全球时间线修改已由主插件防抖批量同步后驱动
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

        const actionHeader = container.createEl('div', { cls: 'vc-timeline-search-bar' });
        const searchBox = actionHeader.createEl('div', { cls: 'vc-search-capsule' });
        const searchIcon = searchBox.createEl('span', { cls: 'vc-search-icon' });
        setIcon(searchIcon, 'search');
        
        const searchInput = searchBox.createEl('input', { 
            type: 'text', 
            placeholder: this.searchFullText ? '搜索正文内容...' : '搜索快照或标签...' 
        });
        searchInput.value = this.searchQuery;

        const innerToggle = searchBox.createEl('button', {
            cls: `vc-search-inner-toggle ${this.searchFullText ? 'is-active' : ''}`,
            attr: { 'aria-label': this.searchFullText ? '当前正在检索正文（点击切换为普通搜索）' : '点击开启时光机正文全文检索' }
        });
        innerToggle.createEl('span', { text: '📄 搜正文' });

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
            searchInput.placeholder = this.searchFullText ? '搜索正文内容...' : '搜索快照或标签...';
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

        const snapBtn = actionHeader.createEl('button', { cls: 'vc-btn-record', attr: { 'aria-label': '立即保存快照' } });
        setIcon(snapBtn, 'bookmark-plus');
        snapBtn.createEl('span', { text: '保存快照' });
        snapBtn.addEventListener('click', () => this.plugin.createManualVersion());

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
            empty.createEl('p', { text: '编辑笔记或点击上方按钮打下第一个版本快照。' });
            return; 
        }

        const idToRealIndex = new Map<string, number>();
        allVersions.forEach((ver, idx) => idToRealIndex.set(ver.id, idx));

        let filteredVersions = allVersions;
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
                for (let idx = 0; idx < allVersions.length; idx++) {
                    const v = allVersions[idx]!;
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
                filteredVersions = allVersions.filter((v: VersionData) => v.message.toLowerCase().includes(q) || (v.tags && v.tags.some(t => t.toLowerCase().includes(q))));
            }
        }

        if (myToken !== this.currentRenderToken || !resultsContainer.isConnected) return;
        this.relTimeEntries = [];
        resultsContainer.empty();

        if (this.searchQuery) {
            const resultMeta = resultsContainer.createEl('div', { cls: 'vc-search-result-meta' });
            resultMeta.setText(`找到 ${filteredVersions.length} / ${totalCount} 个版本`);
        }

        const timeline = resultsContainer.createEl('div', { cls: 'vc-linear-timeline' });
        const frag = document.createDocumentFragment();

        filteredVersions.forEach((v: VersionData, index: number) => {
            const isManual = !v.message.includes('[Auto Save]');
            const item = document.createElement('div');
            item.className = `vc-timeline-entry ${v.starred ? 'is-starred' : ''}`;
            
            const rail = item.createEl('div', { cls: 'vc-timeline-rail' });
            rail.createEl('div', { cls: `vc-timeline-node ${isManual ? 'is-manual' : ''} ${v.starred ? 'is-star' : ''}` });
            if (index !== filteredVersions.length - 1) {
                rail.createEl('div', { cls: 'vc-timeline-line' });
            }

            const body = item.createEl('div', { cls: 'vc-timeline-card' });
            const top = body.createEl('div', { cls: 'vc-timeline-top' });
            const badgeGroup = top.createEl('div', { cls: 'vc-badge-group' });

            const typeBadge = badgeGroup.createEl('span', { 
                cls: `vc-tag-badge ${isManual ? 'badge-manual' : 'badge-auto'}` 
            });
            typeBadge.setText(this.plugin.getSaveTypeLabel(v.message));

            const realIdx = idToRealIndex.get(v.id) ?? -1;
            const realPrevVersion = realIdx !== -1 ? allVersions[realIdx + 1] : undefined;

            if (realPrevVersion) {
                const diff = v.size - realPrevVersion.size;
                const deltaClass = diff > 0 ? 'is-plus' : (diff < 0 ? 'is-minus' : 'is-zero');
                const sign = diff > 0 ? '+' : '';
                badgeGroup.createEl('span', {
                    text: `${sign}${diff.toLocaleString()} 字符`,
                    cls: `vc-diff-chars-badge ${deltaClass}`,
                    attr: { title: `较上一版本变动: ${sign}${diff} 字符 (当前: ${v.size.toLocaleString()} / 上版: ${realPrevVersion.size.toLocaleString()})` }
                });
            } else {
                badgeGroup.createEl('span', {
                    text: `${v.size.toLocaleString()} 字符`,
                    cls: 'vc-diff-chars-badge is-total',
                    attr: { title: `初始版本字符数: ${v.size.toLocaleString()}` }
                });
            }

            if (v.tags) {
                v.tags.forEach((t: string) => {
                    badgeGroup.createEl('span', { cls: 'vc-tag-custom', text: t });
                });
            }

            const timeWrap = top.createEl('div', { cls: 'vc-timeline-time-box' });
            timeWrap.createEl('span', { text: this.plugin.formatTime(v.timestamp), cls: 'vc-abs-time' });
            const relEl = timeWrap.createEl('span', { 
                text: `(${this.plugin.getRelativeTime(v.timestamp)})`, 
                cls: 'vc-rel-time',
                attr: { 'data-timestamp': String(v.timestamp) } 
            });
            this.relTimeEntries.push({ el: relEl, ts: v.timestamp });

            if (snippetMatchMap.has(v.id)) {
                const snipEl = top.createEl('div', { cls: 'vc-snippet-match' });
                snipEl.createEl('span', { text: '匹配片段: ', cls: 'vc-snippet-label' });
                snipEl.createEl('span', { text: `"...${snippetMatchMap.get(v.id)}..."`, cls: 'vc-snippet-text' });
            }

            const actions = body.createEl('div', { cls: 'vc-timeline-actions' });
            
            const starBtn = actions.createEl('button', { 
                cls: `vc-timeline-icon-btn ${v.starred ? 'is-starred' : ''}`, 
                attr: { 'aria-label': v.starred ? '取消收藏' : '标记为重要' } 
            });
            setIcon(starBtn, 'star');
            starBtn.addEventListener('click', async (e: MouseEvent) => {
                e.stopPropagation();
                await this.plugin.toggleVersionStar(file.path, v.id);
                this.renderCurrentResultsList(resultsContainer, file, true);
            });

            const prevDiffBtn = actions.createEl('button', { 
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

            const currentDiffBtn = actions.createEl('button', { 
                cls: 'vc-timeline-icon-btn', 
                attr: { 'aria-label': '对比当前工作区 (最新状态)' } 
            });
            setIcon(currentDiffBtn, 'git-compare');
            currentDiffBtn.addEventListener('click', () => {
                new DiffModal(this.app, this.plugin, file, v.id, 'current').open();
            });

            const restoreBtn = actions.createEl('button', { cls: 'vc-timeline-icon-btn', attr: { 'aria-label': '恢复至此版本' } });
            setIcon(restoreBtn, 'undo-2');
            restoreBtn.addEventListener('click', () => {
                new ConfirmModal(this.app, '确认回退版本', '将使用该快照覆盖当前内容（当前最新状态会自动打下备份）。', async () => {
                    await this.plugin.restoreVersion(file, v.id);
                }, '确认覆盖').open();
            });

            const delBtn = actions.createEl('button', { 
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

            frag.appendChild(item);
        });

        timeline.appendChild(frag);
        if (preserveScroll && prevScroll > 0 && this.timelineScrollEl) {
            this.timelineScrollEl.scrollTop = prevScroll;
        }
    }

    private buildGlobalHistoryCard(
        { version, prevVersion, filePath, file, hasUnsavedChanges, isUnversioned, currentChars, snapshotChars, prevSnapshotChars, charDiff, diffMode, totalVersions }: GlobalHistoryItem,
        isLast: boolean
    ): HTMLElement {
        const isDeleted = !file;
        const message = version?.message || '自动保存';
        const isManual = !message.includes('[Auto Save]');
        const saveType = this.plugin.getSaveTypeLabel(message);

        const item = document.createElement('div');
        item.className = 'vc-timeline-entry';
        
        const rail = item.createEl('div', { cls: 'vc-timeline-rail' });
        rail.createEl('div', { 
            cls: `vc-timeline-node ${isDeleted ? 'is-deleted' : (isUnversioned ? 'is-unversioned' : (hasUnsavedChanges ? 'is-unsaved' : (isManual ? 'is-manual' : '')))}` 
        });
        if (!isLast) rail.createEl('div', { cls: 'vc-timeline-line' });

        const body = item.createEl('div', { cls: 'vc-timeline-card' });
        const top = body.createEl('div', { cls: 'vc-timeline-top' });
        
        const titleRow = top.createEl('div', { cls: 'vc-timeline-title-row' });
        const link = titleRow.createEl('a', { text: filePath, cls: `vc-timeline-link ${isDeleted ? 'is-deleted-link' : ''}` });
        link.addEventListener('click', () => { 
            if (file) {
                this.app.workspace.getLeaf(false).openFile(file);
            } else if (version?.id) {
                new DeletedNoteModal(this.app, this.plugin, filePath, version).open();
            }
        });

        const badgesWrap = titleRow.createEl('div', { cls: 'vc-status-badges-wrap' });

        if (isDeleted) {
            badgesWrap.createEl('span', { text: '● 原文件已删除', cls: 'vc-status-pill is-deleted' });
            badgesWrap.createEl('span', { 
                text: `${(snapshotChars ?? 0).toLocaleString()} 字符`, 
                cls: 'vc-diff-chars-badge is-zero',
                attr: { title: '快照保存时的原笔记字数' }
            });
        } else if (diffMode === 'unversioned') {
            badgesWrap.createEl('span', { text: '● 待生成快照', cls: 'vc-status-pill is-unversioned' });
            badgesWrap.createEl('span', { 
                text: `${currentChars?.toLocaleString() ?? 0} 字符`, 
                cls: 'vc-diff-chars-badge is-total',
                attr: { title: '当前笔记总字符数' }
            });
        } else if (diffMode === 'workspace') {
            badgesWrap.createEl('span', { text: '● 工作区改动', cls: 'vc-status-pill is-unsaved' });
            const deltaClass = (charDiff ?? 0) > 0 ? 'is-plus' : ((charDiff ?? 0) < 0 ? 'is-minus' : 'is-zero');
            const sign = (charDiff ?? 0) > 0 ? '+' : '';
            badgesWrap.createEl('span', { 
                text: `${sign}${(charDiff ?? 0).toLocaleString()} 字符`, 
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
                    text: `${sign}${(charDiff ?? 0).toLocaleString()} 字符`, 
                    cls: `vc-diff-chars-badge ${deltaClass}`,
                    attr: { title: `最新快照相比上一版本：${sign}${charDiff} 字符` }
                });
            } else {
                badgesWrap.createEl('span', { 
                    text: `初始 ${(snapshotChars ?? 0).toLocaleString()} 字符`, 
                    cls: 'vc-diff-chars-badge is-zero',
                    attr: { title: '初始首版快照' }
                });
            }
        }

        if (totalVersions !== undefined && totalVersions > 0) {
            badgesWrap.createEl('span', {
                text: `${totalVersions} 个版本`,
                cls: 'vc-version-count-badge',
                attr: { title: `该笔记已累计保存 ${totalVersions} 个版本快照` }
            });
        }

        const timeCol = top.createEl('div', { cls: 'vc-global-time-col' });

        if (file && file.stat && file.stat.mtime) {
            const mtime = file.stat.mtime;
            const mtimeRow = timeCol.createEl('div', { cls: 'vc-meta-time-row' });
            const label = mtimeRow.createEl('span', { cls: `vc-meta-badge is-mtime ${hasUnsavedChanges ? 'is-highlight' : ''}` });
            const icon = label.createEl('span', { cls: 'vc-badge-icon' });
            setIcon(icon, 'pen-line');
            label.createEl('span', { text: '编辑' });

            const timeContainer = mtimeRow.createEl('div', { cls: 'vc-meta-time-cluster' });
            timeContainer.createEl('span', { text: this.plugin.formatTime(mtime), cls: 'vc-meta-time-abs' });
            const mtimeRelEl = timeContainer.createEl('span', { 
                text: `(${this.plugin.getRelativeTime(mtime)})`, 
                cls: 'vc-rel-time',
                attr: { 'data-timestamp': String(mtime) } 
            });
            this.relTimeEntries.push({ el: mtimeRelEl, ts: mtime });
        }

        const snapRow = timeCol.createEl('div', { cls: 'vc-meta-time-row' });
        const snapLabel = snapRow.createEl('span', { cls: 'vc-meta-badge is-snap' });
        const snapIcon = snapLabel.createEl('span', { cls: 'vc-badge-icon' });
        setIcon(snapIcon, 'bookmark');
        snapLabel.createEl('span', { text: '快照' });

        const snapTimeContainer = snapRow.createEl('div', { cls: 'vc-meta-time-cluster' });
        if (isUnversioned || !version?.timestamp) {
            snapTimeContainer.createEl('span', { text: '尚未保存快照', cls: 'vc-meta-time-abs is-empty-text' });
        } else {
            snapTimeContainer.createEl('span', { text: this.plugin.formatTime(version.timestamp), cls: 'vc-meta-time-abs' });
            const snapRelEl = snapTimeContainer.createEl('span', { 
                text: `(${this.plugin.getRelativeTime(version.timestamp)})`, 
                cls: 'vc-rel-time',
                attr: { 'data-timestamp': String(version.timestamp) } 
            });
            this.relTimeEntries.push({ el: snapRelEl, ts: version.timestamp });
        }

        const actions = body.createEl('div', { cls: 'vc-timeline-actions' });

        if (file) {
            const cardSnapBtn = actions.createEl('button', { 
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
                    const prevDiffBtn = actions.createEl('button', { cls: 'vc-timeline-icon-btn', attr: { 'aria-label': '对比上一版本 (查看最新快照改动)' } });
                    setIcon(prevDiffBtn, 'git-commit');
                    prevDiffBtn.addEventListener('click', () => new DiffModal(this.app, this.plugin, file, prevVersion.id, version.id).open());
                }

                const diffBtn = actions.createEl('button', { cls: 'vc-timeline-icon-btn', attr: { 'aria-label': '对比当前工作区' } });
                setIcon(diffBtn, 'git-compare');
                diffBtn.addEventListener('click', () => new DiffModal(this.app, this.plugin, file, version.id, 'current').open());
            }
        } else if (version?.id) {
            const previewBtn = actions.createEl('button', { 
                cls: 'vc-timeline-icon-btn', 
                attr: { 'aria-label': '预览已删除笔记的快照内容' } 
            });
            setIcon(previewBtn, 'eye');
            previewBtn.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                new DeletedNoteModal(this.app, this.plugin, filePath, version).open();
            });

            const resurrectBtn = actions.createEl('button', { 
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

    async renderGlobalHistory(container: HTMLElement) {
        const actionHeader = container.createEl('div', { cls: 'vc-timeline-search-bar' });
        const searchBox = actionHeader.createEl('div', { cls: 'vc-search-capsule' });
        const searchIcon = searchBox.createEl('span', { cls: 'vc-search-icon' });
        setIcon(searchIcon, 'search');

        const searchInput = searchBox.createEl('input', { type: 'text', placeholder: '搜索全库笔记或路径...' });
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

        const syncBtn = actionHeader.createEl('button', { 
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

        const snapBtn = actionHeader.createEl('button', { cls: 'vc-btn-record', attr: { 'aria-label': '为当前活动笔记保存快照' } });
        setIcon(snapBtn, 'bookmark-plus');
        snapBtn.createEl('span', { text: '保存快照' });
        snapBtn.addEventListener('click', async () => {
            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile) {
                new Notice('没有打开的文件');
                return;
            }
            await this.plugin.createVersion(activeFile, '[Manual Save]', false, [], true);
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

        let history: GlobalHistoryItem[] = [];
        try {
            history = await this.plugin.getGlobalHistory(100, this.globalSearchQuery);
        } catch (e) {
            console.error('获取全库时间线失败:', e);
        } finally {
            if (loadingEl) loadingEl.remove();
        }

        if (myToken !== this.globalRenderToken || !timelineArea.isConnected) return;
        this.relTimeEntries = [];
        timelineArea.empty();

        if (this.globalSearchQuery) {
            const resultMeta = timelineArea.createEl('div', { cls: 'vc-search-result-meta' });
            resultMeta.setText(`搜索到 ${history.length} 篇匹配笔记`);
        }

        if (history.length === 0) {
            const empty = timelineArea.createEl('div', { cls: 'vc-timeline-empty' });
            const icon = empty.createEl('div', { cls: 'vc-timeline-empty-icon' });
            setIcon(icon, 'history');
            empty.createEl('h4', { text: this.globalSearchQuery ? '未找到匹配笔记' : '暂无笔记快照' });
            empty.createEl('p', { text: this.globalSearchQuery ? '请尝试更换关键词或清空搜索条件。' : '打开任意笔记并点击右上角「保存快照」即可开始版本控制。' });
            return;
        }

        let renderedCount = 0;
        const batchSize = 25;
        const timeline = timelineArea.createEl('div', { cls: 'vc-linear-timeline' });

        const appendBatch = (count: number) => {
            const targetItems = history.slice(renderedCount, renderedCount + count);
            const frag = document.createDocumentFragment();
            targetItems.forEach((item, idx) => {
                try {
                    const isOverallLast = (renderedCount + idx) === (history.length - 1);
                    frag.appendChild(this.buildGlobalHistoryCard(item, isOverallLast));
                } catch (err) {
                    console.error('渲染单张卡片异常:', item.filePath, err);
                }
            });
            timeline.appendChild(frag);
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
                appendBatch(batchSize);

                const remaining = history.length - renderedCount;
                if (remaining > 0) {
                    moreBtn.setText(`加载更多笔记 (还有 ${remaining} 篇)...`);
                } else {
                    moreContainer.remove();
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

        containerEl.createEl('h3', { text: '常规选项', cls: 'vc-settings-subhead' });

        new Setting(containerEl)
            .setName('修改自动保存')
            .setDesc('停止输入后自动生成版本历史快照')
            .addToggle(t => t.setValue(this.plugin.settings.autoSave).onChange(async (v: boolean) => {
                this.plugin.settings.autoSave = v;
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('保存延迟时间')
            .setDesc('停止键入等待多少分钟后自动触发快照（例如输入 10 代表 10 分钟）')
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '0.5';
                text.inputEl.step = '1';
                text.inputEl.style.width = '80px';
                text.inputEl.style.textAlign = 'center';
                text.setPlaceholder('3')
                    .setValue(String(this.plugin.settings.autoSaveDelayOnModify ?? 3))
                    .onChange(async (val: string) => {
                        let num = parseFloat(val);
                        if (!isNaN(num) && num > 0) {
                            this.plugin.settings.autoSaveDelayOnModify = num;
                            await this.plugin.saveSettings();
                        }
                    });
            });

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
    }
}
