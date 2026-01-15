import { ItemView, WorkspaceLeaf, TFile, Menu, Notice } from 'obsidian';
import * as Diff from 'diff';
import VersionControlPlugin from './main';
import { VersionData, VersionFile, ViewMode } from './types';
import { ConfirmModal } from './modals/ConfirmModal';
import { DiffModal } from './modals/DiffModal';
import { QuickPreviewModal } from './modals/QuickPreviewModal';
import { TagEditModal } from './modals/TagEditModal';
import { NoteEditModal } from './modals/NoteEditModal';
import { VersionSelectModal } from './modals/VersionSelectModal';

export class VersionHistoryView extends ItemView {
    plugin: VersionControlPlugin;
    selectedVersions: Set<string> = new Set();
    currentFile: TFile | null = null;
    searchQuery: string = '';
    currentPage: number = 0;
    totalVersions: number = 0;
    filterTag: string | null = null;
    showStarredOnly: boolean = false;

    currentViewMode: ViewMode = 'current';

    // 锁，防止重复刷新
    isRefreshing: boolean = false;

    constructor(leaf: WorkspaceLeaf, plugin: VersionControlPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return 'version-history';
    }

    getDisplayText(): string {
        return '版本历史';
    }

    getIcon(): string {
        return 'history';
    }

    async onOpen() {
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                // 如果当前视图不可见或不是 'current' 模式，可以减少不必要的刷新
                if (this.currentViewMode === 'current') {
                    // 这里可以加入简单的防抖逻辑，但 refresh 内部已有锁
                    this.currentPage = 0;
                    this.refresh();
                }
            })
        );

        // Add basic styles
        this.addStyles();
        await this.refresh();
    }

    addStyles() {
        if (!document.getElementById('vc-tab-styles')) {
            const style = document.createElement('style');
            style.id = 'vc-tab-styles';
            // 使用 Flex 布局固定头部，内容区域自适应滚动，防止外部容器高度抖动
            style.textContent = `
                .version-history-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
                .vc-tab-bar { flex-shrink: 0; display: flex; justify-content: flex-start; border-bottom: 1px solid var(--background-modifier-border); margin-bottom: 10px; padding-bottom: 5px; gap: 10px; }
                .vc-tab-btn { background: transparent; border: none; border-bottom: 2px solid transparent; cursor: pointer; padding: 6px 12px; font-weight: bold; color: var(--text-muted); }
                .vc-tab-btn:hover { color: var(--text-normal); }
                .vc-tab-btn.mod-cta { color: var(--text-accent); border-bottom-color: var(--text-accent); background-color: var(--background-secondary); }
                .vc-content-area { flex-grow: 1; overflow-y: auto; padding-right: 5px; } /* 内容独立滚动 */
                .vc-batch-bar { display: flex; justify-content: flex-end; padding: 4px; background: var(--background-secondary); border-radius: 4px; margin-bottom: 10px; }
                .internal-link { color: var(--text-accent); text-decoration: none; cursor: pointer; }
                .internal-link:hover { text-decoration: underline; }
            `;
            document.head.appendChild(style);
        }
    }

    updateRelativeTimes() {
        if (!this.plugin.settings.useRelativeTime) return;

        const container = this.contentEl; // Use contentEl
        const timeElements = container.querySelectorAll('.version-time');

        timeElements.forEach(el => {
            const timestampStr = (el as HTMLElement).dataset.timestamp;
            if (timestampStr) {
                const timestamp = parseInt(timestampStr, 10);
                el.textContent = this.plugin.getRelativeTime(timestamp);
            }
        });
    }

    getRelativeDateGroup(timestamp: number): string {
        const now = new Date();
        const date = new Date(timestamp);
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        const versionDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

        if (versionDate.getTime() === today.getTime()) return '今天';
        if (versionDate.getTime() === yesterday.getTime()) return '昨天';
        if (now.getFullYear() === date.getFullYear() && now.getMonth() === date.getMonth()) return '本月';
        if (now.getFullYear() === date.getFullYear()) return `${date.getMonth() + 1}月`;
        return `${date.getFullYear()}年`;
    }

    async calculateDiffStatsForVersion(versionFile: VersionFile, versionId: string) {
        const versionIndex = versionFile.versionIndex?.get(versionId);
        if (versionIndex === undefined) return;

        const version = versionFile.versions[versionIndex];
        if (typeof version.addedLines === 'number' && typeof version.removedLines === 'number' && typeof version.modifiedLines === 'number') {
            return;
        }

        try {
            const currentContent = await this.plugin.getVersionContent(versionFile.filePath, version.id, true);
            const previousVersion = versionFile.versions[versionIndex + 1];

            let added = 0;
            let removed = 0;
            let modified = 0;

            if (previousVersion) {
                const previousContent = await this.plugin.getVersionContent(versionFile.filePath, previousVersion.id, true);
                const diffResult = Diff.diffLines(previousContent, currentContent, { ignoreWhitespace: true });

                for (let i = 0; i < diffResult.length; i++) {
                    const part = diffResult[i];
                    const nextPart = diffResult[i + 1];
                    if (part.removed && nextPart && nextPart.added) {
                        const remCount = part.count || 0;
                        const addCount = nextPart.count || 0;
                        const overlap = Math.min(remCount, addCount);
                        modified += overlap;
                        removed += (remCount - overlap);
                        added += (addCount - overlap);
                        i++;
                    } else {
                        if (part.added) added += part.count || 0;
                        if (part.removed) removed += part.count || 0;
                    }
                }
            } else {
                added = currentContent.split('\n').length;
            }
            version.addedLines = added;
            version.removedLines = removed;
            version.modifiedLines = modified;
        } catch (error) {
            version.addedLines = 0;
            version.removedLines = 0;
            version.modifiedLines = 0;
        }
    }


    async refresh() {
        // 防止重复刷新
        if (this.isRefreshing) return;
        this.isRefreshing = true;

        const realContainer = this.contentEl;

        try {
            // 离屏渲染：创建一个内存中的缓冲区
            const buffer = createDiv();
            buffer.addClass('version-history-view');

            this.renderTabs(buffer);

            const contentContainer = buffer.createEl('div', { cls: 'vc-content-area' });

            // 异步加载数据到缓冲区
            if (this.currentViewMode === 'current') {
                await this.renderCurrentFileHistory(contentContainer);
            } else if (this.currentViewMode === 'modified') {
                await this.renderModifiedFiles(contentContainer);
            } else if (this.currentViewMode === 'global') {
                await this.renderGlobalHistory(contentContainer);
            }

            // 数据加载完成，一次性替换 DOM，避免白屏闪烁
            realContainer.empty();
            realContainer.appendChild(buffer);

        } catch (error) {
            console.error("Version History Refresh Error:", error);
            realContainer.empty();
            realContainer.createEl('div', { text: '加载出错，请查看控制台。' });
        } finally {
            this.isRefreshing = false;
        }
    }

    renderTabs(container: HTMLElement) {
        const tabBar = container.createEl('div', { cls: 'vc-tab-bar' });

        const tabs: {id: ViewMode, label: string}[] = [
            { id: 'current', label: '当前文件' },
            { id: 'modified', label: '待保存' },
            { id: 'global', label: '全库历史' }
        ];

        tabs.forEach(tab => {
            const btn = tabBar.createEl('button', {
                cls: `vc-tab-btn ${this.currentViewMode === tab.id ? 'mod-cta' : ''}`,
                attr: { title: tab.label }
            });
            btn.setText(tab.label);
            btn.addEventListener('click', () => {
                this.currentViewMode = tab.id;
                this.currentPage = 0;
                this.refresh();
            });
        });
    }

    async renderCurrentFileHistory(container: HTMLElement) {
        const file = this.app.workspace.getActiveFile();
        this.currentFile = file;

        if (!file) {
            this.renderEmptyState(container, '请先打开一个文件');
            return;
        }

        const header = container.createEl('div', { cls: 'version-header' });

        const title = header.createEl('div', { cls: 'version-title' });
        title.createEl('h3', { text: file.basename });
        title.createEl('span', { text: file.path, cls: 'version-file-path' });

        const fileStats = header.createEl('div', { cls: 'version-file-stats' });
        try {
            const currentContent = await this.app.vault.read(file);
            const stat = await this.app.vault.adapter.stat(file.path);
            fileStats.createEl('span', { text: `📄 大小: ${this.plugin.formatFileSize(currentContent.length)}`, cls: 'file-stat-item' });
            if (stat) {
                fileStats.createEl('span', { text: `📅 修改: ${new Date(stat.mtime).toLocaleString('zh-CN')}`, cls: 'file-stat-item' });
            }
        } catch (error) { console.error('获取文件信息失败:', error); }

        const actions = header.createEl('div', { cls: 'version-header-actions' });

        const searchInput = actions.createEl('input', { type: 'text', placeholder: '搜索版本...', cls: 'version-search' });
        searchInput.value = this.searchQuery;
        searchInput.addEventListener('input', (e) => {
            this.searchQuery = (e.target as HTMLInputElement).value;
            this.currentPage = 0;
            this.refresh();
        });

        const starFilterBtn = actions.createEl('button', {
            text: this.showStarredOnly ? '已筛选星标' : '筛选星标',
            cls: this.showStarredOnly ? 'mod-cta' : '',
            attr: { title: '仅显示星标版本' }
        });
        starFilterBtn.addEventListener('click', () => {
            this.showStarredOnly = !this.showStarredOnly;
            this.currentPage = 0;
            this.refresh();
        });

        const refreshBtn = actions.createEl('button', { text: '刷新' });
        refreshBtn.addEventListener('click', () => {
            new Notice('正在刷新...');
            this.plugin.versionCache.delete(file.path);
            this.refresh();
        });

        const createBtn = actions.createEl('button', { text: '+ 创建', cls: 'mod-cta' });
        createBtn.addEventListener('click', () => {
            this.plugin.createManualVersion();
        });

        const moreBtn = actions.createEl('button', { text: '更多' });
        moreBtn.addEventListener('click', (e) => {
            const menu = new Menu();
            menu.addItem((item) => item.setTitle('📊 查看统计').setIcon('bar-chart').onClick(() => { this.showDetailedStats(); }));
            menu.addItem((item) => item.setTitle('📥 导出版本数据').setIcon('download').onClick(() => { this.plugin.exportVersions(file.path); }));
            menu.addItem((item) => item.setTitle('📂 保存全库版本').setIcon('folder').onClick(() => { this.plugin.createFullSnapshot(); }));
            menu.addItem((item) => item.setTitle('🗑️ 清理旧版本').setIcon('trash').onClick(async () => { await this.cleanupOldVersions(file); }));
            menu.showAtMouseEvent(e as MouseEvent);
        });

        const versionFile = await this.plugin.loadVersionFile(file.path);
        const allVersions = versionFile.versions;
        this.totalVersions = allVersions.length;

        if (this.totalVersions === 0) {
            this.renderEmptyState(container, '暂无版本历史');
            return;
        }

        let filteredVersions = allVersions;
        if (this.showStarredOnly) filteredVersions = filteredVersions.filter(v => v.starred);
        if (this.filterTag) filteredVersions = filteredVersions.filter(v => v.tags && v.tags.includes(this.filterTag!));
        if (this.searchQuery) {
            filteredVersions = filteredVersions.filter(v =>
                v.message.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
                this.plugin.formatTime(v.timestamp).toLowerCase().includes(this.searchQuery.toLowerCase()) ||
                (v.tags && v.tags.some(tag => tag.toLowerCase().includes(this.searchQuery.toLowerCase())))
            );
        }

        if (filteredVersions.length === 0) {
            this.renderEmptyState(container, `未找到匹配的版本`);
            return;
        }

        const perPage = this.plugin.settings.versionsPerPage > 0 ? this.plugin.settings.versionsPerPage : filteredVersions.length;
        const totalPages = Math.ceil(filteredVersions.length / perPage);
        const start = this.currentPage * perPage;
        const end = Math.min(start + perPage, filteredVersions.length);
        const pageVersions = filteredVersions.slice(start, end);

        let statsChanged = false;
        const calculationPromises = pageVersions
            .filter(version => typeof version.addedLines !== 'number' || typeof version.removedLines !== 'number' || typeof version.modifiedLines !== 'number')
            .map(version => {
                statsChanged = true;
                return this.calculateDiffStatsForVersion(versionFile, version.id);
            });

        if (calculationPromises.length > 0) await Promise.all(calculationPromises);
        if (statsChanged) await this.plugin.saveVersionFile(file.path, versionFile);

        if (this.selectedVersions.size > 0) {
            const toolbar = container.createEl('div', { cls: 'version-toolbar' });
            toolbar.createEl('span', { text: `已选择 ${this.selectedVersions.size} 个版本` });
            const clearBtn = toolbar.createEl('button', { text: '清空选择' });
            clearBtn.addEventListener('click', () => {
                this.selectedVersions.clear();
                this.refresh();
            });
            const deleteBtn = toolbar.createEl('button', { text: '批量删除', cls: 'mod-warning' });
            deleteBtn.addEventListener('click', () => this.batchDelete(file));
        }

        const listContainer = container.createEl('div', { cls: 'version-list' });

        const groupedVersions: { [key: string]: VersionData[] } = {};
        pageVersions.forEach(version => {
            const group = this.getRelativeDateGroup(version.timestamp);
            if (!groupedVersions[group]) groupedVersions[group] = [];
            groupedVersions[group].push(version);
        });

        for (const groupName in groupedVersions) {
            listContainer.createEl('h4', { text: groupName, cls: 'version-group-header' });
            const versionsInGroup = groupedVersions[groupName];
            for (const version of versionsInGroup) {
                const item = listContainer.createEl('div', { cls: 'version-item' });
                if (version.starred) item.addClass('version-starred');

                const checkbox = item.createEl('input', { type: 'checkbox', cls: 'version-checkbox' });
                checkbox.checked = this.selectedVersions.has(version.id);
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) this.selectedVersions.add(version.id);
                    else this.selectedVersions.delete(version.id);
                    this.refresh();
                });

                const info = item.createEl('div', { cls: 'version-info' });

                const timeRow = info.createEl('div', { cls: 'version-time-row' });
                const starBtn = timeRow.createEl('span', { text: version.starred ? '⭐' : '☆', cls: 'version-star-btn' });
                starBtn.addEventListener('click', async () => { await this.plugin.toggleVersionStar(file.path, version.id); });

                const absoluteTimeStr = new Date(version.timestamp).toLocaleString('zh-CN');
                const timeEl = timeRow.createEl('span', { text: this.plugin.formatTime(version.timestamp), cls: 'version-time', attr: { title: absoluteTimeStr } });
                timeEl.dataset.timestamp = String(version.timestamp);

                const messageEl = info.createEl('div', { cls: 'version-message-row' });
                const saveTypeLabel = this.plugin.getSaveTypeLabel(version.message);
                let tagClass = 'version-tag-auto';
                if (saveTypeLabel === '手动保存') tagClass = 'version-tag-manual';
                else if (saveTypeLabel === '全库版本') tagClass = 'version-tag-snapshot';
                else if (saveTypeLabel === '恢复前备份') tagClass = 'version-tag-backup';

                messageEl.createEl('span', { text: saveTypeLabel, cls: `version-tag ${tagClass}` });

                if (version.diff) messageEl.createEl('span', { text: '增量', cls: 'version-tag version-tag-incremental' });
                else if (version.content) messageEl.createEl('span', { text: '完整', cls: 'version-tag version-tag-full' });

                if (version.tags && version.tags.length > 0) {
                    version.tags.forEach(tag => {
                        const tagEl = messageEl.createEl('span', { text: tag, cls: 'version-tag version-tag-custom' });
                        tagEl.addEventListener('click', () => { this.filterTag = tag; this.currentPage = 0; this.refresh(); });
                    });
                }

                messageEl.createEl('span', { text: version.message.replace(/\[.*?\]/g, '').trim() || '无描述', cls: 'version-message' });
                if (version.note) info.createEl('div', { text: `📝 ${version.note}`, cls: 'version-note' });

                const statsRow = info.createEl('div', { cls: 'version-stats-row' });
                statsRow.createEl('span', { text: this.plugin.formatFileSize(version.size), cls: 'version-size' });

                const diffStatsContainer = statsRow.createEl('div', { cls: 'version-diff-stats' });
                const vAdded = version.addedLines || 0;
                const vRemoved = version.removedLines || 0;
                const vModified = version.modifiedLines || 0;
                const totalChanges = vAdded + vRemoved + vModified;

                if (totalChanges > 0) {
                    const addedWidth = (vAdded / totalChanges) * 100;
                    const removedWidth = (vRemoved / totalChanges) * 100;
                    const modifiedWidth = (vModified / totalChanges) * 100;
                    const bar = diffStatsContainer.createEl('div', { cls: 'diff-stats-bar' });
                    if (vModified > 0) bar.createEl('div', { cls: 'diff-stats-modified', attr: { style: `width: ${modifiedWidth}%; background-color: var(--text-accent);` } });
                    if (vAdded > 0) bar.createEl('div', { cls: 'diff-stats-added', attr: { style: `width: ${addedWidth}%` } });
                    if (vRemoved > 0) bar.createEl('div', { cls: 'diff-stats-removed', attr: { style: `width: ${removedWidth}%` } });

                    if (vModified > 0) diffStatsContainer.createEl('span', { text: `~${vModified}`, cls: 'diff-stats-text-modified', attr: { style: 'color: var(--text-accent); margin-right: 4px;' } });
                    if (vAdded > 0) diffStatsContainer.createEl('span', { text: `+${vAdded}`, cls: 'diff-stats-text-added' });
                    if (vRemoved > 0) diffStatsContainer.createEl('span', { text: `-${vRemoved}`, cls: 'diff-stats-text-removed' });
                    diffStatsContainer.title = `修改 ${vModified} 行, 新增 ${vAdded} 行, 删除 ${vRemoved} 行`;
                } else {
                    diffStatsContainer.setText('无代码变更');
                }

                const actions = item.createEl('div', { cls: 'version-actions' });
                if (this.plugin.settings.enableQuickPreview) {
                    const previewBtn = actions.createEl('button', { text: '预览', cls: 'version-btn', attr: { title: '快速预览' } });
                    previewBtn.addEventListener('click', () => { new QuickPreviewModal(this.app, this.plugin, file, version.id).open(); });
                }
                const restoreBtn = actions.createEl('button', { text: '恢复', cls: 'version-btn' });
                restoreBtn.addEventListener('click', () => { this.confirmRestore(file, version.id); });
                const diffBtn = actions.createEl('button', { text: '比较', cls: 'version-btn' });
                diffBtn.addEventListener('click', () => { this.showDiffModal(file, version.id); });
                const moreBtn = actions.createEl('button', { text: '更多', cls: 'version-btn' });
                moreBtn.addEventListener('click', (e) => { this.showVersionContextMenu(e as MouseEvent, file, version); });
            }
        }

        if (totalPages > 1) {
            const pagination = container.createEl('div', { cls: 'version-pagination' });
            const prevBtn = pagination.createEl('button', { text: '← 上一页', cls: 'version-pagination-btn' });
            prevBtn.disabled = this.currentPage === 0;
            prevBtn.addEventListener('click', () => { if (this.currentPage > 0) { this.currentPage--; this.refresh(); } });
            pagination.createEl('span', { text: `第 ${this.currentPage + 1} / ${totalPages} 页`, cls: 'version-pagination-info' });
            const nextBtn = pagination.createEl('button', { text: '下一页 →', cls: 'version-pagination-btn' });
            nextBtn.disabled = this.currentPage >= totalPages - 1;
            nextBtn.addEventListener('click', () => { if (this.currentPage < totalPages - 1) { this.currentPage++; this.refresh(); } });
        }

        const stats = container.createEl('div', { cls: 'version-footer' });
        stats.createEl('span', { text: `共 ${this.totalVersions} 个版本` });
        if (this.searchQuery || this.showStarredOnly || this.filterTag) stats.createEl('span', { text: ` · 显示 ${filteredVersions.length} 个结果` });
        stats.createEl('span', { text: ` · 显示 ${start + 1}-${end}` });
    }

    async renderModifiedFiles(container: HTMLElement) {
        container.createEl('h3', { text: '📝 已修改但未保存的文件' });
        container.createEl('p', { text: '以下文件自上次保存版本后已有新的修改:', cls: 'vc-desc' });

        const loading = container.createEl('div', { text: '正在扫描...' });

        setTimeout(async () => {
            const modifiedFiles = await this.plugin.getModifiedFiles();
            loading.remove();

            if (modifiedFiles.length === 0) {
                this.renderEmptyState(container, '所有文件均已包含最新版本 ✅');
                return;
            }

            const batchBar = container.createEl('div', { cls: 'vc-batch-bar' });
            const snapshotAllBtn = batchBar.createEl('button', { text: '全部保存版本', cls: 'mod-cta' });
            snapshotAllBtn.addEventListener('click', async () => {
                new Notice(`开始为 ${modifiedFiles.length} 个文件保存版本...`);
                for (const item of modifiedFiles) {
                    await this.plugin.createVersion(item.file, '[Batch Save] 批量保存', false);
                }
                new Notice('批量保存完成');
                this.refresh();
            });

            const list = container.createEl('div', { cls: 'vc-modified-list' });

            modifiedFiles.forEach(({ file, lastVersionTime }) => {
                const item = list.createEl('div', { cls: 'version-item' });
                item.style.cursor = 'default';

                const info = item.createEl('div', { cls: 'version-info' });

                const titleRow = info.createEl('div', { cls: 'version-message-row' });
                const link = titleRow.createEl('a', { text: file.path, cls: 'internal-link' });
                link.addEventListener('click', () => {
                    this.app.workspace.getLeaf(false).openFile(file);
                });

                const metaRow = info.createEl('div', { cls: 'version-time-row' });
                const lastSaveStr = lastVersionTime === 0 ? '从未保存' : this.plugin.getRelativeTime(lastVersionTime);
                const modifiedStr = this.plugin.getRelativeTime(file.stat.mtime);

                metaRow.createEl('small', {
                    text: `上次保存: ${lastSaveStr} | 最近修改: ${modifiedStr}`,
                    attr: { style: 'color: var(--text-muted);' }
                });

                const actions = item.createEl('div', { cls: 'version-actions' });

                if (lastVersionTime > 0) {
                    const diffBtn = actions.createEl('button', { text: '对比', cls: 'version-btn' });
                    diffBtn.setAttribute('title', '对比当前内容与最新版本');
                    diffBtn.addEventListener('click', async () => {
                        const versions = await this.plugin.getAllVersions(file.path);
                        if (versions.length > 0) {
                            new DiffModal(this.app, this.plugin, file, versions[0].id).open();
                        } else {
                            new Notice('未找到历史版本记录');
                        }
                    });
                }

                const saveBtn = actions.createEl('button', { text: '保存', cls: 'version-btn' });
                saveBtn.addEventListener('click', async () => {
                    saveBtn.setText('保存中...');
                    saveBtn.disabled = true;
                    await this.plugin.createVersion(file, '[Manual] 列表补录', true);
                    item.remove();
                    if (list.children.length === 0) this.refresh();
                });
            });
        }, 10);
    }

    async renderGlobalHistory(container: HTMLElement) {
        container.createEl('h3', { text: '🌍 全库版本时间轴' });
        const loading = container.createEl('div', { text: '正在加载全库数据...' });

        setTimeout(async () => {
            const history = await this.plugin.getGlobalHistory(100);
            loading.remove();

            if (history.length === 0) {
                this.renderEmptyState(container, '未找到任何版本记录');
                return;
            }

            const list = container.createEl('div', { cls: 'version-list' });

            let currentDay = '';

            history.forEach(({ version, filePath, file }) => {
                const dateObj = new Date(version.timestamp);
                const dateStr = dateObj.toLocaleDateString();

                if (dateStr !== currentDay) {
                    currentDay = dateStr;
                    list.createEl('h4', { text: currentDay, cls: 'version-group-header' });
                }

                const item = list.createEl('div', { cls: 'version-item' });
                if (version.starred) item.addClass('version-starred');

                const info = item.createEl('div', { cls: 'version-info' });

                const headerRow = info.createEl('div', { cls: 'version-time-row', attr: { style: 'justify-content:flex-start; gap:8px;' } });

                headerRow.createEl('span', {
                    text: new Date(version.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second: '2-digit'}),
                    cls: 'version-time',
                    attr: { style: 'font-family:var(--font-monospace); color:var(--text-accent);' }
                });

                const fileLink = headerRow.createEl('span', {
                    text: filePath,
                    attr: { style: 'font-weight:bold; cursor:pointer; text-decoration:underline;' }
                });
                fileLink.addEventListener('click', () => {
                    if (file) {
                        this.app.workspace.getLeaf(false).openFile(file);
                    } else {
                        new Notice('文件已删除，无法打开');
                    }
                });

                if (!file) headerRow.createEl('span', { text: '(已删除)', attr: { style: 'color:var(--text-error); font-size:0.8em;' } });

                const msgRow = info.createEl('div', { cls: 'version-message-row' });
                if (version.message.includes('[Auto Save')) {
                    msgRow.createEl('span', { text: '自动', cls: 'version-tag version-tag-auto' });
                } else {
                    msgRow.createEl('span', { text: '手动', cls: 'version-tag version-tag-manual' });
                }
                msgRow.createEl('span', { text: version.message.replace(/\[.*?\]/g, '').trim() || '无描述' });

                const actions = item.createEl('div', { cls: 'version-actions' });

                if (file) {
                    const diffBtn = actions.createEl('button', { text: '对比', cls: 'version-btn' });
                    diffBtn.addEventListener('click', () => {
                        new DiffModal(this.app, this.plugin, file, version.id).open();
                    });
                }

                if (file && this.plugin.settings.enableQuickPreview) {
                    const viewBtn = actions.createEl('button', { text: '预览', cls: 'version-btn' });
                    viewBtn.addEventListener('click', () => {
                         new QuickPreviewModal(this.app, this.plugin, file, version.id).open();
                    });
                }
            });

        }, 10);
    }

    showVersionContextMenu(event: MouseEvent, file: TFile, version: VersionData) {
        const menu = new Menu();

        menu.addItem((item) =>
            item.setTitle('与当前文件对比')
                .setIcon('file-diff')
                .onClick(() => {
                    this.showDiffModal(file, version.id);
                })
        );

        menu.addItem((item) =>
            item.setTitle('与另一个版本对比')
                .setIcon('files')
                .onClick(() => {
                    this.selectVersionForCompare(file, version.id);
                })
        );

        menu.addSeparator();

        menu.addItem((item) =>
            item.setTitle(version.starred ? '取消星标' : '添加星标')
                .setIcon('star')
                .onClick(async () => {
                    await this.plugin.toggleVersionStar(file.path, version.id);
                })
        );

        if (this.plugin.settings.enableVersionTags) {
            menu.addItem((item) =>
                item.setTitle('编辑标签')
                    .setIcon('tag')
                    .onClick(() => {
                        new TagEditModal(this.app, this.plugin, file.path, version.id, version.tags || []).open();
                    })
            );
        }

        menu.addItem((item) =>
            item.setTitle('添加/编辑备注')
                .setIcon('edit')
                .onClick(() => {
                    new NoteEditModal(this.app, this.plugin, file.path, version.id, version.note || '').open();
                })
        );

        menu.addSeparator();

        menu.addItem((item) =>
            item.setTitle('导出为文件')
                .setIcon('download')
                .onClick(async () => {
                    await this.plugin.exportVersionAsFile(file.path, version.id);
                })
        );

        menu.addItem((item) =>
            item.setTitle('删除版本')
                .setIcon('trash')
                .onClick(async () => {
                    new ConfirmModal(
                        this.app,
                        '确认删除',
                        '确定要删除此版本吗?\n\n此操作不可撤销!',
                        async () => {
                            await this.plugin.deleteVersion(file.path, version.id);
                        }
                    ).open();
                })
        );

        menu.showAtMouseEvent(event);
    }

    async showDetailedStats() {
        const file = this.currentFile;
        if (!file) return;

        const versions = await this.plugin.getAllVersions(file.path);
        const starredCount = versions.filter(v => v.starred).length;
        const taggedCount = versions.filter(v => v.tags && v.tags.length > 0).length;
        const totalSize = versions.reduce((sum, v) => sum + v.size, 0);
        const autoSaveCount = versions.filter(v => v.message.includes('[Auto Save]')).length;
        const manualSaveCount = versions.length - autoSaveCount;

        let timeSpan = '';
        if (versions.length > 1) {
            const oldest = versions[versions.length - 1].timestamp;
            const newest = versions[0].timestamp;
            const days = Math.floor((newest - oldest) / (1000 * 60 * 60 * 24));
            timeSpan = days > 0 ? `${days} 天` : '不足1天';
        } else if (versions.length === 1) {
            timeSpan = '仅一个版本';
        }

        new Notice(
            `📊 ${file.basename} 统计\n\n` +
            `总版本数: ${versions.length}\n` +
            `⭐ 星标: ${starredCount}\n` +
            `🏷️ 已标签: ${taggedCount}\n` +
            `🤖 自动: ${autoSaveCount}\n` +
            `✋ 手动: ${manualSaveCount}\n` +
            `📦 总大小: ${this.plugin.formatFileSize(totalSize)}\n` +
            `📅 时间跨度: ${timeSpan}`,
            8000
        );
    }

    async cleanupOldVersions(file: TFile) {
        new ConfirmModal(
            this.app,
            '清理旧版本',
            '根据设置的清理规则删除旧版本。\n星标版本将被保留。\n\n是否继续?',
            async () => {
                const versionFile = await this.plugin.loadVersionFile(file.path);
                const beforeCount = versionFile.versions.length;
                const removed = await this.plugin.cleanupVersionsInMemory(versionFile);

                if (removed > 0) {
                    await this.plugin.saveVersionFile(file.path, versionFile);
                    this.plugin.versionCache.set(file.path, versionFile);
                    new Notice(`✅ 已清理 ${removed} 个旧版本`);
                    this.refresh();
                } else {
                    new Notice('ℹ️ 没有需要清理的版本');
                }
            }
        ).open();
    }

    renderEmptyState(container: HTMLElement, message: string) {
        const empty = container.createEl('div', { cls: 'version-history-empty' });
        empty.createEl('div', {
            text: '📋',
            cls: 'version-empty-icon'
        });
        empty.createEl('div', { text: message });

        if (this.currentFile && message === '暂无版本历史' && this.currentViewMode === 'current') {
            const createBtn = empty.createEl('button', {
                text: '创建第一个版本',
                cls: 'mod-cta'
            });
            createBtn.addEventListener('click', () => {
                this.plugin.createManualVersion();
            });
        }

        if (this.currentViewMode === 'current' && (this.filterTag || this.showStarredOnly || this.searchQuery)) {
            const clearFilterBtn = empty.createEl('button', {
                text: '清除筛选/搜索',
                cls: 'mod-cta'
            });
            clearFilterBtn.addEventListener('click', () => {
                this.filterTag = null;
                this.showStarredOnly = false;
                this.searchQuery = '';
                this.currentPage = 0;
                this.refresh();
            });
        }
    }

    confirmRestore(file: TFile, versionId: string) {
        new ConfirmModal(
            this.app,
            '确认恢复版本',
            '当前未保存的修改将会丢失,插件会在恢复前自动创建备份版本。\n\n是否继续?',
            async () => {
                await this.plugin.restoreVersion(file, versionId);
            }
        ).open();
    }

    async batchDelete(file: TFile) {
        new ConfirmModal(
            this.app,
            '确认批量删除',
            `确定要删除选中的 ${this.selectedVersions.size} 个版本吗?\n\n此操作不可撤销!`,
            async () => {
                const versionIds = Array.from(this.selectedVersions);
                await this.plugin.deleteVersions(file.path, versionIds);
                this.selectedVersions.clear();
            }
        ).open();
    }

    showDiffModal(file: TFile, versionId: string) {
        new DiffModal(this.app, this.plugin, file, versionId).open();
    }

    selectVersionForCompare(file: TFile, firstVersionId: string) {
        new VersionSelectModal(this.app, this.plugin, file, firstVersionId, (secondVersionId: string) => {
            new DiffModal(this.app, this.plugin, file, firstVersionId, secondVersionId).open();
        }).open();
    }
}
