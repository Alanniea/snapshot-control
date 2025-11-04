import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, Modal, ItemView, WorkspaceLeaf, Menu, TextComponent } from 'obsidian';
import * as Diff from 'diff';

interface VersionData {
    id: string;
    timestamp: number;
    message: string;
    content: string;
    size: number;
    hash?: string;
}

interface VersionFile {
    filePath: string;
    versions: VersionData[];
    lastModified: number;
}

interface VersionControlSettings {
    versionFolder: string;
    autoSave: boolean;
    autoSaveInterval: number;
    autoClear: boolean;
    maxVersions: number;
    enableMaxVersions: boolean;
    maxDays: number;
    enableMaxDays: boolean;
    useRelativeTime: boolean;
    diffGranularity: 'char' | 'word' | 'line';
    diffViewMode: 'unified' | 'split';
    enableDeduplication: boolean;
    showNotifications: boolean;
    excludedFolders: string[];
    enableCompression: boolean;
}

const DEFAULT_SETTINGS: VersionControlSettings = {
    versionFolder: '.versions',
    autoSave: true,
    autoSaveInterval: 5,
    autoClear: true,
    maxVersions: 50,
    enableMaxVersions: true,
    maxDays: 30,
    enableMaxDays: false,
    useRelativeTime: false,
    diffGranularity: 'char',
    diffViewMode: 'unified',
    enableDeduplication: true,
    showNotifications: true,
    excludedFolders: [],
    enableCompression: false
};

export default class VersionControlPlugin extends Plugin {
    settings: VersionControlSettings;
    autoSaveTimer: NodeJS.Timer | null = null;
    lastSavedContent: Map<string, string> = new Map();
    statusBarItem: HTMLElement;
    versionCache: Map<string, VersionFile> = new Map();

    async onload() {
        await this.loadSettings();

        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar();

        this.registerView(
            'version-history',
            (leaf) => new VersionHistoryView(leaf, this)
        );

        this.addRibbonIcon('history', '版本历史', () => {
            this.activateVersionHistoryView();
        });

        this.addCommand({
            id: 'create-version',
            name: '创建版本快照',
            callback: () => this.createManualVersion()
        });

        this.addCommand({
            id: 'show-version-history',
            name: '显示版本历史',
            callback: () => this.activateVersionHistoryView()
        });

        this.addCommand({
            id: 'create-full-snapshot',
            name: '创建全库版本',
            callback: () => this.createFullSnapshot()
        });

        this.addCommand({
            id: 'compare-with-version',
            name: '与历史版本对比',
            callback: () => this.quickCompare()
        });

        this.addCommand({
            id: 'restore-last-version',
            name: '恢复到上一版本',
            callback: () => this.restoreLastVersion()
        });

        this.addSettingTab(new VersionControlSettingTab(this.app, this));

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile && this.settings.autoSave) {
                    this.scheduleAutoSave(file);
                }
            })
        );

        if (this.settings.autoSave) {
            this.startAutoSave();
        }

        await this.ensureVersionFolder();

        if (this.settings.showNotifications) {
            new Notice('版本控制插件已启动');
        }
    }

    onunload() {
        if (this.autoSaveTimer) {
            clearInterval(this.autoSaveTimer);
        }
        this.versionCache.clear();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.updateStatusBar();
    }

    updateStatusBar() {
        if (this.settings.autoSave) {
            this.statusBarItem.setText(`⏱ 版本控制: ${this.settings.autoSaveInterval}分钟`);
        } else {
            this.statusBarItem.setText('⏸ 版本控制: 已暂停');
        }
    }

    async ensureVersionFolder() {
        const adapter = this.app.vault.adapter;
        const folderPath = this.settings.versionFolder;
        
        try {
            if (!await adapter.exists(folderPath)) {
                await adapter.mkdir(folderPath);
            }
        } catch (error) {
            console.error('创建版本文件夹失败:', error);
            new Notice('无法创建版本文件夹，请检查权限');
        }
    }

    async activateVersionHistoryView() {
        const { workspace } = this.app;
        
        let leaf = workspace.getLeavesOfType('version-history')[0];
        
        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            if (!rightLeaf) {
                new Notice('无法打开版本历史视图');
                return;
            }
            leaf = rightLeaf;
            await leaf.setViewState({
                type: 'version-history',
                active: true,
            });
        }
        
        workspace.revealLeaf(leaf);
    }

    startAutoSave() {
        if (this.autoSaveTimer) {
            clearInterval(this.autoSaveTimer);
        }
        
        this.autoSaveTimer = setInterval(() => {
            this.autoSaveCurrentFile();
        }, this.settings.autoSaveInterval * 60 * 1000);
    }

    scheduleAutoSave(file: TFile) {
        if (this.isExcluded(file.path)) {
            return;
        }

        setTimeout(() => {
            this.autoSaveFile(file);
        }, 3000);
    }

    async autoSaveFile(file: TFile) {
        try {
            const content = await this.app.vault.read(file);
            const lastContent = this.lastSavedContent.get(file.path);

            if (content !== lastContent) {
                await this.createVersion(file, '[Auto Save]', false);
                this.lastSavedContent.set(file.path, content);
            }
        } catch (error) {
            console.error('自动保存失败:', error);
        }
    }

    async autoSaveCurrentFile() {
        const file = this.app.workspace.getActiveFile();
        if (!file || this.isExcluded(file.path)) return;

        await this.autoSaveFile(file);
    }

    isExcluded(filePath: string): boolean {
        return this.settings.excludedFolders.some(folder => 
            filePath.startsWith(folder)
        );
    }

    async createManualVersion() {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
            new Notice('没有打开的文件');
            return;
        }

        new VersionMessageModal(this.app, async (message) => {
            await this.createVersion(file, message, true);
            if (this.settings.showNotifications) {
                new Notice('✓ 版本已创建');
            }
        }).open();
    }

    async createVersion(file: TFile, message: string, showNotification: boolean = false) {
        try {
            const content = await this.app.vault.read(file);
            const timestamp = Date.now();
            const id = `${timestamp}`;
            const hash = this.hashContent(content);
            
            // 加载版本文件
            const versionFile = await this.loadVersionFile(file.path);
            
            // 去重检查
            if (this.settings.enableDeduplication) {
                const duplicate = versionFile.versions.find(v => v.hash === hash);
                if (duplicate) {
                    if (showNotification && this.settings.showNotifications) {
                        new Notice('内容未变化，跳过创建版本');
                    }
                    return;
                }
            }

            // 添加新版本
            const newVersion: VersionData = {
                id,
                timestamp,
                message,
                content,
                size: content.length,
                hash
            };

            versionFile.versions.unshift(newVersion);
            versionFile.lastModified = timestamp;

            // 自动清理
            if (this.settings.autoClear) {
                this.cleanupVersionsInMemory(versionFile);
            }

            // 保存版本文件
            await this.saveVersionFile(file.path, versionFile);

            // 更新缓存
            this.versionCache.set(file.path, versionFile);

            // 刷新视图
            this.refreshVersionHistoryView();

            if (showNotification && this.settings.showNotifications) {
                new Notice(`✓ 版本已创建: ${message}`);
            }
        } catch (error) {
            console.error('创建版本失败:', error);
            new Notice('❌ 创建版本失败，请查看控制台');
        }
    }

    hashContent(content: string): string {
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(36);
    }

    cleanupVersionsInMemory(versionFile: VersionFile) {
        let versionsToKeep = versionFile.versions;

        // 按数量清理
        if (this.settings.enableMaxVersions) {
            versionsToKeep = versionsToKeep.slice(0, this.settings.maxVersions);
        }

        // 按天数清理
        if (this.settings.enableMaxDays) {
            const cutoffTime = Date.now() - (this.settings.maxDays * 24 * 60 * 60 * 1000);
            versionsToKeep = versionsToKeep.filter(v => v.timestamp >= cutoffTime);
        }

        const removedCount = versionFile.versions.length - versionsToKeep.length;
        versionFile.versions = versionsToKeep;

        return removedCount;
    }

    async loadVersionFile(filePath: string): Promise<VersionFile> {
        // 检查缓存
        if (this.versionCache.has(filePath)) {
            return this.versionCache.get(filePath)!;
        }

        const versionPath = this.getVersionFilePath(filePath);
        const adapter = this.app.vault.adapter;

        try {
            if (await adapter.exists(versionPath)) {
                const content = await adapter.read(versionPath);
                const versionFile = JSON.parse(content) as VersionFile;
                this.versionCache.set(filePath, versionFile);
                return versionFile;
            }
        } catch (error) {
            console.error('加载版本文件失败:', error);
        }

        // 返回新的版本文件
        const newVersionFile: VersionFile = {
            filePath,
            versions: [],
            lastModified: Date.now()
        };
        this.versionCache.set(filePath, newVersionFile);
        return newVersionFile;
    }

    async saveVersionFile(filePath: string, versionFile: VersionFile) {
        const versionPath = this.getVersionFilePath(filePath);
        const adapter = this.app.vault.adapter;

        try {
            const content = JSON.stringify(versionFile, null, 2);
            await adapter.write(versionPath, content);
        } catch (error) {
            console.error('保存版本文件失败:', error);
            throw error;
        }
    }

    getVersionFilePath(filePath: string): string {
        const sanitized = this.sanitizeFileName(filePath);
        return `${this.settings.versionFolder}/${sanitized}.json`;
    }

    async getVersions(filePath: string): Promise<VersionData[]> {
        try {
            const versionFile = await this.loadVersionFile(filePath);
            return versionFile.versions;
        } catch (error) {
            console.error('获取版本列表失败:', error);
            return [];
        }
    }

    async getVersionContent(filePath: string, versionId: string): Promise<string> {
        try {
            const versionFile = await this.loadVersionFile(filePath);
            const version = versionFile.versions.find(v => v.id === versionId);
            if (!version) {
                throw new Error('版本不存在');
            }
            return version.content;
        } catch (error) {
            console.error('读取版本内容失败:', error);
            throw new Error('无法读取版本内容');
        }
    }

    async deleteVersion(filePath: string, versionId: string) {
        try {
            const versionFile = await this.loadVersionFile(filePath);
            versionFile.versions = versionFile.versions.filter(v => v.id !== versionId);
            versionFile.lastModified = Date.now();
            await this.saveVersionFile(filePath, versionFile);
            this.versionCache.set(filePath, versionFile);
        } catch (error) {
            console.error('删除版本失败:', error);
        }
    }

    async deleteVersions(filePath: string, versionIds: string[]) {
        try {
            const versionFile = await this.loadVersionFile(filePath);
            const idsSet = new Set(versionIds);
            versionFile.versions = versionFile.versions.filter(v => !idsSet.has(v.id));
            versionFile.lastModified = Date.now();
            await this.saveVersionFile(filePath, versionFile);
            this.versionCache.set(filePath, versionFile);
        } catch (error) {
            console.error('批量删除版本失败:', error);
        }
    }

    async restoreVersion(file: TFile, versionId: string) {
        try {
            await this.createVersion(file, '[Before Restore]', false);
            
            const content = await this.getVersionContent(file.path, versionId);
            await this.app.vault.modify(file, content);
            
            if (this.settings.showNotifications) {
                new Notice('✓ 版本已恢复');
            }
            this.refreshVersionHistoryView();
        } catch (error) {
            console.error('恢复版本失败:', error);
            new Notice('❌ 恢复版本失败');
        }
    }

    async restoreLastVersion() {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
            new Notice('没有打开的文件');
            return;
        }

        const versions = await this.getVersions(file.path);
        if (versions.length === 0) {
            new Notice('没有可恢复的版本');
            return;
        }

        const lastVersion = versions[0];
        new ConfirmModal(
            this.app,
            '恢复到上一版本',
            `确定要恢复到版本: ${this.formatTime(lastVersion.timestamp)}？`,
            async () => {
                await this.restoreVersion(file, lastVersion.id);
            }
        ).open();
    }

    async quickCompare() {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
            new Notice('没有打开的文件');
            return;
        }

        const versions = await this.getVersions(file.path);
        if (versions.length === 0) {
            new Notice('没有历史版本可对比');
            return;
        }

        const lastVersion = versions[0];
        new DiffModal(this.app, this, file, lastVersion.id).open();
    }

    async createFullSnapshot() {
        const files = this.app.vault.getMarkdownFiles();
        let count = 0;
        let skipped = 0;

        const progressNotice = new Notice('正在创建全库版本...', 0);

        for (const file of files) {
            if (this.isExcluded(file.path)) {
                skipped++;
                continue;
            }

            try {
                await this.createVersion(file, '[Full Snapshot]', false);
                count++;
            } catch (error) {
                console.error(`创建版本失败: ${file.path}`, error);
            }
        }

        progressNotice.hide();
        
        if (this.settings.showNotifications) {
            new Notice(`✓ 全库版本已创建\n成功: ${count} 个文件${skipped > 0 ? `\n跳过: ${skipped} 个文件` : ''}`);
        }
    }

    async getStorageStats(): Promise<{ totalSize: number; versionCount: number; fileCount: number }> {
        const adapter = this.app.vault.adapter;
        const versionFolder = this.settings.versionFolder;
        
        try {
            if (!await adapter.exists(versionFolder)) {
                return { totalSize: 0, versionCount: 0, fileCount: 0 };
            }

            const files = await adapter.list(versionFolder);
            let totalSize = 0;
            let versionCount = 0;
            let fileCount = 0;

            for (const file of files.files) {
                if (file.endsWith('.json')) {
                    try {
                        const stat = await adapter.stat(file);
                        totalSize += stat?.size || 0;
                        
                        const content = await adapter.read(file);
                        const versionFile = JSON.parse(content) as VersionFile;
                        versionCount += versionFile.versions.length;
                        fileCount++;
                    } catch (error) {
                        console.error('读取版本文件失败:', error);
                    }
                }
            }

            return { totalSize, versionCount, fileCount };
        } catch (error) {
            console.error('获取存储统计失败:', error);
            return { totalSize: 0, versionCount: 0, fileCount: 0 };
        }
    }

    async exportVersions(filePath: string): Promise<void> {
        try {
            const versionFile = await this.loadVersionFile(filePath);
            const exportPath = `${this.settings.versionFolder}/export_${Date.now()}.json`;
            await this.app.vault.adapter.write(
                exportPath,
                JSON.stringify(versionFile, null, 2)
            );

            new Notice(`✓ 版本已导出到: ${exportPath}`);
        } catch (error) {
            console.error('导出版本失败:', error);
            new Notice('❌ 导出失败');
        }
    }

    sanitizeFileName(path: string): string {
        return path.replace(/[\/\\:*?"<>|]/g, '_');
    }

    formatFileSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    formatTime(timestamp: number): string {
        if (this.settings.useRelativeTime) {
            return this.getRelativeTime(timestamp);
        }
        return new Date(timestamp).toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    getRelativeTime(timestamp: number): string {
        const diff = Date.now() - timestamp;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        const months = Math.floor(days / 30);
        const years = Math.floor(days / 365);

        if (years > 0) return `${years} 年前`;
        if (months > 0) return `${months} 个月前`;
        if (days > 0) return `${days} 天前`;
        if (hours > 0) return `${hours} 小时前`;
        if (minutes > 0) return `${minutes} 分钟前`;
        return `${seconds} 秒前`;
    }

    refreshVersionHistoryView() {
        const leaves = this.app.workspace.getLeavesOfType('version-history');
        leaves.forEach(leaf => {
            if (leaf.view instanceof VersionHistoryView) {
                leaf.view.refresh();
            }
        });
    }
}

// VersionHistoryView 和其他类保持不变，只需要更新批量删除方法
class VersionHistoryView extends ItemView {
    plugin: VersionControlPlugin;
    selectedVersions: Set<string> = new Set();
    currentFile: TFile | null = null;
    searchQuery: string = '';

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
                this.refresh();
            })
        );

        await this.refresh();
    }

    async refresh() {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('version-history-view');

        const file = this.app.workspace.getActiveFile();
        this.currentFile = file;
        
        if (!file) {
            this.renderEmptyState(container, '请先打开一个文件');
            return;
        }

        const header = container.createEl('div', { cls: 'version-header' });
        
        const title = header.createEl('div', { cls: 'version-title' });
        title.createEl('h3', { text: file.basename });
        title.createEl('span', { 
            text: file.path,
            cls: 'version-file-path'
        });

        const actions = header.createEl('div', { cls: 'version-header-actions' });
        
        const searchInput = actions.createEl('input', {
            type: 'text',
            placeholder: '搜索版本...',
            cls: 'version-search'
        });
        searchInput.value = this.searchQuery;
        searchInput.addEventListener('input', (e) => {
            this.searchQuery = (e.target as HTMLInputElement).value;
            this.refresh();
        });

        const createBtn = actions.createEl('button', { 
            text: '创建版本',
            cls: 'mod-cta'
        });
        createBtn.addEventListener('click', () => {
            this.plugin.createManualVersion();
        });

        const exportBtn = actions.createEl('button', { text: '导出' });
        exportBtn.addEventListener('click', () => {
            this.plugin.exportVersions(file.path);
        });

        const versions = await this.plugin.getVersions(file.path);

        if (versions.length === 0) {
            this.renderEmptyState(container, '暂无版本历史');
            return;
        }

        const filteredVersions = this.searchQuery
            ? versions.filter(v => 
                v.message.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
                this.plugin.formatTime(v.timestamp).toLowerCase().includes(this.searchQuery.toLowerCase())
            )
            : versions;

        if (filteredVersions.length === 0) {
            this.renderEmptyState(container, `未找到匹配 "${this.searchQuery}" 的版本`);
            return;
        }

        if (this.selectedVersions.size > 0) {
            const toolbar = container.createEl('div', { cls: 'version-toolbar' });
            toolbar.createEl('span', { 
                text: `已选择 ${this.selectedVersions.size} 个版本` 
            });
            
            const clearBtn = toolbar.createEl('button', { text: '清空选择' });
            clearBtn.addEventListener('click', () => {
                this.selectedVersions.clear();
                this.refresh();
            });

            const deleteBtn = toolbar.createEl('button', { 
                text: '批量删除',
                cls: 'mod-warning'
            });
            deleteBtn.addEventListener('click', () => this.batchDelete(file));
        }

        const listContainer = container.createEl('div', { cls: 'version-list' });

        for (const version of filteredVersions) {
            const item = listContainer.createEl('div', { cls: 'version-item' });
            
            const checkbox = item.createEl('input', { 
                type: 'checkbox',
                cls: 'version-checkbox'
            });
            checkbox.checked = this.selectedVersions.has(version.id);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    this.selectedVersions.add(version.id);
                } else {
                    this.selectedVersions.delete(version.id);
                }
                this.refresh();
            });

            const info = item.createEl('div', { cls: 'version-info' });
            
            const timeRow = info.createEl('div', { cls: 'version-time-row' });
            timeRow.createEl('span', { 
                text: this.plugin.formatTime(version.timestamp),
                cls: 'version-time'
            });
            
            const messageEl = info.createEl('div', { cls: 'version-message-row' });
            
            if (version.message.includes('[Auto Save]')) {
                messageEl.createEl('span', { 
                    text: '自动保存',
                    cls: 'version-tag version-tag-auto'
                });
            } else if (version.message.includes('[Full Snapshot]')) {
                messageEl.createEl('span', { 
                    text: '全库版本',
                    cls: 'version-tag version-tag-snapshot'
                });
            } else if (version.message.includes('[Before Restore]')) {
                messageEl.createEl('span', { 
                    text: '恢复前备份',
                    cls: 'version-tag version-tag-backup'
                });
            }
            
            messageEl.createEl('span', { 
                text: version.message.replace(/\[.*?\]/g, '').trim() || '无描述',
                cls: 'version-message'
            });
            
            info.createEl('div', { 
                text: this.plugin.formatFileSize(version.size),
                cls: 'version-size'
            });

            const actions = item.createEl('div', { cls: 'version-actions' });
            
            const restoreBtn = actions.createEl('button', { 
                text: '恢复',
                cls: 'version-btn'
            });
            restoreBtn.addEventListener('click', () => {
                this.confirmRestore(file, version.id);
            });

            const diffBtn = actions.createEl('button', { 
                text: '比较',
                cls: 'version-btn'
            });
            diffBtn.addEventListener('click', () => {
                this.showDiffModal(file, version.id);
            });
            
            diffBtn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const menu = new Menu();
                menu.addItem((item) =>
                    item.setTitle('与当前文件对比')
                        .setIcon('file-diff')
                        .onClick(() => {
                            this.showDiffModal(file, version.id);
                        })
                );
                menu.addItem((item) =>
                    item.setTitle('选择另一个版本对比')
                        .setIcon('files')
                        .onClick(() => {
                            this.selectVersionForCompare(file, version.id);
                        })
                );
                menu.showAtMouseEvent(e as MouseEvent);
            });

            const deleteBtn = actions.createEl('button', { 
                text: '删除',
                cls: 'version-btn mod-warning'
            });
            deleteBtn.addEventListener('click', async () => {
                await this.plugin.deleteVersion(file.path, version.id);
                if (this.plugin.settings.showNotifications) {
                    new Notice('✓ 版本已删除');
                }
                this.refresh();
            });
        }

        const stats = container.createEl('div', { cls: 'version-footer' });
        stats.createEl('span', { text: `共 ${versions.length} 个版本` });
        if (this.searchQuery) {
            stats.createEl('span', { text: ` · 显示 ${filteredVersions.length} 个结果` });
        }
    }

    renderEmptyState(container: HTMLElement, message: string) {
        const empty = container.createEl('div', { cls: 'version-history-empty' });
        empty.createEl('div', { 
            text: '📝',
            cls: 'version-empty-icon'
        });
        empty.createEl('div', { text: message });
        
        if (this.currentFile && message === '暂无版本历史') {
            const createBtn = empty.createEl('button', { 
                text: '创建第一个版本',
                cls: 'mod-cta'
            });
            createBtn.addEventListener('click', () => {
                this.plugin.createManualVersion();
            });
        }
    }

    confirmRestore(file: TFile, versionId: string) {
        new ConfirmModal(
            this.app,
            '确认恢复版本',
            '当前未保存的修改将会丢失，插件会在恢复前自动创建备份版本。\n\n是否继续？',
            async () => {
                await this.plugin.restoreVersion(file, versionId);
            }
        ).open();
    }

    async batchDelete(file: TFile) {
        new ConfirmModal(
            this.app,
            '确认批量删除',
            `确定要删除选中的 ${this.selectedVersions.size} 个版本吗？\n\n此操作不可撤销！`,
            async () => {
                const versionIds = Array.from(this.selectedVersions);
                await this.plugin.deleteVersions(file.path, versionIds);
                this.selectedVersions.clear();
                if (this.plugin.settings.showNotifications) {
                    new Notice('✓ 已删除选中版本');
                }
                this.refresh();
            }
        ).open();
    }

    showDiffModal(file: TFile, versionId: string) {
        new DiffModal(this.app, this.plugin, file, versionId).open();
    }

    selectVersionForCompare(file: TFile, firstVersionId: string) {
        new VersionSelectModal(this.app, this.plugin, file, firstVersionId, (secondVersionId) => {
            new DiffModal(this.app, this.plugin, file, firstVersionId, secondVersionId).open();
        }).open();
    }
}

// 其他模态框类保持不变
class VersionMessageModal extends Modal {
    result: string = '';
    onSubmit: (result: string) => void;
    inputEl: TextComponent;

    constructor(app: App, onSubmit: (result: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: '创建版本' });

        new Setting(contentEl)
            .setName('提交信息')
            .setDesc('描述此版本的更改内容')
            .addText(text => {
                this.inputEl = text;
                text.setPlaceholder('例如：添加新章节、修复错误等...')
                    .onChange(value => {
                        this.result = value;
                    });
                text.inputEl.style.width = '100%';
                text.inputEl.focus();
            });

        const buttonContainer = contentEl.createEl('div', { cls: 'modal-button-container' });
        
        const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
        cancelBtn.addEventListener('click', () => this.close());

        const createBtn = buttonContainer.createEl('button', { 
            text: '创建',
            cls: 'mod-cta'
        });
        createBtn.addEventListener('click', () => {
            this.close();
            this.onSubmit(this.result || '[Manual Save]');
        });

        this.inputEl.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.close();
                this.onSubmit(this.result || '[Manual Save]');
            }
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class ConfirmModal extends Modal {
    title: string;
    message: string;
    onConfirm: () => void;

    constructor(app: App, title: string, message: string, onConfirm: () => void) {
        super(app);
        this.title = title;
        this.message = message;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: this.title });
        
        const messageEl = contentEl.createEl('p', { cls: 'confirm-message' });
        messageEl.style.whiteSpace = 'pre-line';
        messageEl.textContent = this.message;

        const btnContainer = contentEl.createEl('div', { cls: 'modal-button-container' });
        
        const cancelBtn = btnContainer.createEl('button', { text: '取消' });
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = btnContainer.createEl('button', { 
            text: '确认', 
            cls: 'mod-warning' 
        });
        confirmBtn.addEventListener('click', () => {
            this.close();
            this.onConfirm();
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class DiffModal extends Modal {
    plugin: VersionControlPlugin;
    file: TFile;
    versionId: string;
    secondVersionId?: string;
    currentDiffIndex: number = 0;
    totalDiffs: number = 0;
    diffElements: HTMLElement[] = [];

    constructor(app: App, plugin: VersionControlPlugin, file: TFile, versionId: string, secondVersionId?: string) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.versionId = versionId;
        this.secondVersionId = secondVersionId;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.addClass('diff-modal');

        contentEl.createEl('h2', { text: '版本差异对比' });

        const toolbar = contentEl.createEl('div', { cls: 'diff-toolbar' });
        
        const prevBtn = toolbar.createEl('button', { text: '⬆ 上一个差异' });
        const nextBtn = toolbar.createEl('button', { text: '⬇ 下一个差异' });
        const statsEl = toolbar.createEl('span', { cls: 'diff-stats' });
        
        const granularitySelect = toolbar.createEl('select');
        granularitySelect.createEl('option', { text: '字符级', value: 'char' });
        granularitySelect.createEl('option', { text: '单词级', value: 'word' });
        granularitySelect.createEl('option', { text: '行级', value: 'line' });
        granularitySelect.value = this.plugin.settings.diffGranularity;
        
        const modeSelect = toolbar.createEl('select');
        modeSelect.createEl('option', { text: '统一视图', value: 'unified' });
        modeSelect.createEl('option', { text: '左右分栏', value: 'split' });
        modeSelect.value = this.plugin.settings.diffViewMode;

        const copyBtn = toolbar.createEl('button', { text: '📋 复制差异' });
        copyBtn.addEventListener('click', () => {
            this.copyDiffToClipboard();
        });

        let leftContent: string;
        let rightContent: string;
        let leftLabel: string;
        let rightLabel: string;

        try {
            if (this.secondVersionId) {
                leftContent = await this.plugin.getVersionContent(this.file.path, this.versionId);
                rightContent = await this.plugin.getVersionContent(this.file.path, this.secondVersionId);
                
                const versions = await this.plugin.getVersions(this.file.path);
                const leftVersion = versions.find(v => v.id === this.versionId);
                const rightVersion = versions.find(v => v.id === this.secondVersionId);
                
                leftLabel = leftVersion ? `版本 A: ${this.plugin.formatTime(leftVersion.timestamp)}` : '版本 A';
                rightLabel = rightVersion ? `版本 B: ${this.plugin.formatTime(rightVersion.timestamp)}` : '版本 B';
            } else {
                leftContent = await this.plugin.getVersionContent(this.file.path, this.versionId);
                rightContent = await this.app.vault.read(this.file);
                
                const versions = await this.plugin.getVersions(this.file.path);
                const version = versions.find(v => v.id === this.versionId);
                
                leftLabel = version ? `历史版本: ${this.plugin.formatTime(version.timestamp)}` : '历史版本';
                rightLabel = '当前文件';
            }
        } catch (error) {
            new Notice('❌ 加载版本内容失败');
            this.close();
            return;
        }

        const diffContainer = contentEl.createEl('div', { cls: 'diff-container' });

        const renderDiff = () => {
            diffContainer.empty();
            this.diffElements = [];
            this.currentDiffIndex = 0;
            
            const granularity = granularitySelect.value as 'char' | 'word' | 'line';
            
            if (modeSelect.value === 'unified') {
                this.renderUnifiedDiff(diffContainer, leftContent, rightContent, granularity);
            } else {
                this.renderSplitDiff(diffContainer, leftContent, rightContent, granularity, leftLabel, rightLabel);
            }

            if (this.totalDiffs > 0) {
                statsEl.setText(`${this.currentDiffIndex + 1} / ${this.totalDiffs}`);
                prevBtn.disabled = false;
                nextBtn.disabled = false;
            } else {
                statsEl.setText('无差异');
                prevBtn.disabled = true;
                nextBtn.disabled = true;
            }
        };

        granularitySelect.addEventListener('change', () => {
            renderDiff();
        });
        
        modeSelect.addEventListener('change', () => {
            renderDiff();
        });
        
        prevBtn.addEventListener('click', () => {
            if (this.currentDiffIndex > 0) {
                this.currentDiffIndex--;
                this.scrollToDiff();
                statsEl.setText(`${this.currentDiffIndex + 1} / ${this.totalDiffs}`);
            }
        });

        nextBtn.addEventListener('click', () => {
            if (this.currentDiffIndex < this.totalDiffs - 1) {
                this.currentDiffIndex++;
                this.scrollToDiff();
                statsEl.setText(`${this.currentDiffIndex + 1} / ${this.totalDiffs}`);
            }
        });

        renderDiff();
    }

    renderUnifiedDiff(container: HTMLElement, left: string, right: string, granularity: 'char' | 'word' | 'line') {
        let diffResult;
        
        if (granularity === 'char') {
            diffResult = Diff.diffChars(left, right);
        } else if (granularity === 'word') {
            diffResult = Diff.diffWords(left, right);
        } else {
            diffResult = Diff.diffLines(left, right);
        }
        
        this.totalDiffs = diffResult.filter(part => part.added || part.removed).length;

        if (granularity === 'line') {
            let lineNumber = 1;
            let diffIndex = 0;

            for (const part of diffResult) {
                const lines = part.value.split('\n');
                if (lines[lines.length - 1] === '') lines.pop();

                for (const line of lines) {
                    const lineEl = container.createEl('div', { cls: 'diff-line' });
                    
                    if (part.added || part.removed) {
                        lineEl.dataset.diffIndex = String(diffIndex);
                        this.diffElements.push(lineEl);
                    }

                    if (part.added) {
                        lineEl.addClass('diff-added');
                        lineEl.createEl('span', { cls: 'line-number', text: String(lineNumber) });
                        lineEl.createEl('span', { text: `+ ${line}` });
                        lineNumber++;
                        diffIndex++;
                    } else if (part.removed) {
                        lineEl.addClass('diff-removed');
                        lineEl.createEl('span', { cls: 'line-number', text: '' });
                        lineEl.createEl('span', { text: `- ${line}` });
                        diffIndex++;
                    } else {
                        lineEl.createEl('span', { cls: 'line-number', text: String(lineNumber) });
                        lineEl.createEl('span', { text: `  ${line}` });
                        lineNumber++;
                    }
                }
            }
        } else {
            const wrapper = container.createEl('div', { cls: 'diff-line-inline-wrapper' });
            
            for (const part of diffResult) {
                const span = wrapper.createEl('span');
                span.textContent = part.value;
                
                if (part.added) {
                    span.addClass('diff-char-added');
                    this.diffElements.push(span);
                } else if (part.removed) {
                    span.addClass('diff-char-removed');
                    this.diffElements.push(span);
                }
            }
        }

        if (this.totalDiffs > 0) {
            setTimeout(() => this.scrollToDiff(), 100);
        }
    }

    renderSplitDiff(container: HTMLElement, left: string, right: string, granularity: 'char' | 'word' | 'line', leftLabel: string, rightLabel: string) {
        container.addClass('diff-split');
        
        const leftPanel = container.createEl('div', { cls: 'diff-panel' });
        const rightPanel = container.createEl('div', { cls: 'diff-panel' });

        leftPanel.createEl('h3', { text: leftLabel });
        rightPanel.createEl('h3', { text: rightLabel });

        const leftContent = leftPanel.createEl('div', { cls: 'diff-content' });
        const rightContent = rightPanel.createEl('div', { cls: 'diff-content' });

        let diffResult;
        
        if (granularity === 'char') {
            diffResult = Diff.diffChars(left, right);
        } else if (granularity === 'word') {
            diffResult = Diff.diffWords(left, right);
        } else {
            diffResult = Diff.diffLines(left, right);
        }
        
        this.totalDiffs = diffResult.filter(part => part.added || part.removed).length;

        if (granularity === 'line') {
            let leftLine = 1;
            let rightLine = 1;
            let diffIndex = 0;

            for (const part of diffResult) {
                const lines = part.value.split('\n');
                if (lines[lines.length - 1] === '') lines.pop();

                for (const line of lines) {
                    if (part.removed) {
                        const lineEl = leftContent.createEl('div', { cls: 'diff-line diff-removed' });
                        lineEl.dataset.diffIndex = String(diffIndex);
                        lineEl.createEl('span', { cls: 'line-number', text: String(leftLine) });
                        lineEl.createEl('span', { text: line });
                        this.diffElements.push(lineEl);
                        leftLine++;
                        diffIndex++;
                    } else if (part.added) {
                        const lineEl = rightContent.createEl('div', { cls: 'diff-line diff-added' });
                        lineEl.dataset.diffIndex = String(diffIndex);
                        lineEl.createEl('span', { cls: 'line-number', text: String(rightLine) });
                        lineEl.createEl('span', { text: line });
                        this.diffElements.push(lineEl);
                        rightLine++;
                        diffIndex++;
                    } else {
                        const leftLineEl = leftContent.createEl('div', { cls: 'diff-line' });
                        leftLineEl.createEl('span', { cls: 'line-number', text: String(leftLine) });
                        leftLineEl.createEl('span', { text: line });

                        const rightLineEl = rightContent.createEl('div', { cls: 'diff-line' });
                        rightLineEl.createEl('span', { cls: 'line-number', text: String(rightLine) });
                        rightLineEl.createEl('span', { text: line });

                        leftLine++;
                        rightLine++;
                    }
                }
            }
        } else {
            const leftWrapper = leftContent.createEl('div', { cls: 'diff-line-inline-wrapper' });
            const rightWrapper = rightContent.createEl('div', { cls: 'diff-line-inline-wrapper' });
            
            for (const part of diffResult) {
                if (part.removed) {
                    const span = leftWrapper.createEl('span', { text: part.value });
                    span.addClass('diff-char-removed');
                    this.diffElements.push(span);
                } else if (part.added) {
                    const span = rightWrapper.createEl('span', { text: part.value });
                    span.addClass('diff-char-added');
                    this.diffElements.push(span);
                } else {
                    leftWrapper.createEl('span', { text: part.value });
                    rightWrapper.createEl('span', { text: part.value });
                }
            }
        }

        let isScrolling = false;
        
        leftContent.addEventListener('scroll', () => {
            if (isScrolling) return;
            isScrolling = true;
            rightContent.scrollTop = leftContent.scrollTop;
            setTimeout(() => { isScrolling = false; }, 50);
        });

        rightContent.addEventListener('scroll', () => {
            if (isScrolling) return;
            isScrolling = true;
            leftContent.scrollTop = rightContent.scrollTop;
            setTimeout(() => { isScrolling = false; }, 50);
        });
    }

    scrollToDiff() {
        if (this.diffElements.length === 0 || this.currentDiffIndex >= this.diffElements.length) {
            return;
        }

        const element = this.diffElements[this.currentDiffIndex];
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        this.diffElements.forEach(el => el.removeClass('diff-current'));
        element.addClass('diff-current');
    }

    copyDiffToClipboard() {
        const diffContainer = this.containerEl.querySelector('.diff-container');
        if (!diffContainer) return;

        const text = diffContainer.textContent || '';
        navigator.clipboard.writeText(text).then(() => {
            new Notice('✓ 差异内容已复制到剪贴板');
        }).catch(() => {
            new Notice('❌ 复制失败');
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class VersionSelectModal extends Modal {
    plugin: VersionControlPlugin;
    file: TFile;
    firstVersionId: string;
    onSelect: (versionId: string) => void;
    searchQuery: string = '';

    constructor(app: App, plugin: VersionControlPlugin, file: TFile, firstVersionId: string, onSelect: (versionId: string) => void) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.firstVersionId = firstVersionId;
        this.onSelect = onSelect;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.addClass('version-select-modal');

        contentEl.createEl('h2', { text: '选择对比版本' });
        
        contentEl.createEl('p', { 
            text: '选择要与之对比的版本', 
            cls: 'version-select-hint' 
        });

        const searchContainer = contentEl.createEl('div', { cls: 'version-search-container' });
        const searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: '搜索版本...',
            cls: 'version-search-input'
        });
        searchInput.addEventListener('input', (e) => {
            this.searchQuery = (e.target as HTMLInputElement).value;
            this.renderVersionList();
        });

        const listContainer = contentEl.createEl('div', { cls: 'version-select-list' });
        this.renderVersionList();
    }

    async renderVersionList() {
        const listContainer = this.containerEl.querySelector('.version-select-list') as HTMLElement;
        if (!listContainer) return;

        listContainer.empty();

        const versions = await this.plugin.getVersions(this.file.path);
        
        const filteredVersions = versions.filter(v => {
            if (v.id === this.firstVersionId) return false;
            if (!this.searchQuery) return true;
            
            const query = this.searchQuery.toLowerCase();
            return v.message.toLowerCase().includes(query) ||
                   this.plugin.formatTime(v.timestamp).toLowerCase().includes(query);
        });

        if (filteredVersions.length === 0) {
            listContainer.createEl('div', { 
                text: this.searchQuery ? `未找到匹配 "${this.searchQuery}" 的版本` : '没有其他版本',
                cls: 'version-select-empty'
            });
            return;
        }

        for (const version of filteredVersions) {
            const item = listContainer.createEl('div', { cls: 'version-select-item' });
            
            const info = item.createEl('div', { cls: 'version-info' });
            info.createEl('div', { 
                text: this.plugin.formatTime(version.timestamp),
                cls: 'version-time'
            });
            info.createEl('div', { 
                text: version.message,
                cls: 'version-message'
            });
            info.createEl('div', { 
                text: this.plugin.formatFileSize(version.size),
                cls: 'version-size'
            });

            const selectBtn = item.createEl('button', { text: '选择' });
            selectBtn.addEventListener('click', () => {
                this.close();
                this.onSelect(version.id);
            });
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class VersionControlSettingTab extends PluginSettingTab {
    plugin: VersionControlPlugin;

    constructor(app: App, plugin: VersionControlPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    async display(): Promise<void> {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: '版本控制设置' });

        const stats = await this.plugin.getStorageStats();
        const statsEl = containerEl.createEl('div', { cls: 'version-stats' });
        statsEl.createEl('h3', { text: '📊 存储统计' });
        const statsGrid = statsEl.createEl('div', { cls: 'stats-grid' });
        statsGrid.createEl('div', { text: `总大小: ${this.plugin.formatFileSize(stats.totalSize)}` });
        statsGrid.createEl('div', { text: `版本数量: ${stats.versionCount}` });
        statsGrid.createEl('div', { text: `文件数量: ${stats.fileCount}` });

        const refreshBtn = statsEl.createEl('button', { text: '🔄 刷新统计' });
        refreshBtn.addEventListener('click', () => {
            this.display();
        });

        containerEl.createEl('h3', { text: '⚙️ 基础设置' });

        new Setting(containerEl)
            .setName('版本存储路径')
            .setDesc('指定版本数据的存储位置（相对于库根目录）')
            .addText(text => text
                .setPlaceholder('.versions')
                .setValue(this.plugin.settings.versionFolder)
                .onChange(async (value) => {
                    this.plugin.settings.versionFolder = value || '.versions';
                    await this.plugin.saveSettings();
                    await this.plugin.ensureVersionFolder();
                }));

        new Setting(containerEl)
            .setName('显示通知')
            .setDesc('在创建、恢复版本时显示提示消息')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showNotifications)
                .onChange(async (value) => {
                    this.plugin.settings.showNotifications = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: '🤖 自动保存' });

        new Setting(containerEl)
            .setName('启用自动保存')
            .setDesc('定期自动创建版本')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSave)
                .onChange(async (value) => {
                    this.plugin.settings.autoSave = value;
                    await this.plugin.saveSettings();
                    
                    if (value) {
                        this.plugin.startAutoSave();
                    } else if (this.plugin.autoSaveTimer) {
                        clearInterval(this.plugin.autoSaveTimer);
                    }
                }));

        new Setting(containerEl)
            .setName('自动保存间隔 (分钟)')
            .setDesc('检测文件变化的时间间隔')
            .addText(text => text
                .setPlaceholder('5')
                .setValue(String(this.plugin.settings.autoSaveInterval))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.autoSaveInterval = num;
                        await this.plugin.saveSettings();
                        if (this.plugin.settings.autoSave) {
                            this.plugin.startAutoSave();
                        }
                    }
                }));

        new Setting(containerEl)
            .setName('启用去重')
            .setDesc('跳过内容相同的版本创建，节省存储空间')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableDeduplication)
                .onChange(async (value) => {
                    this.plugin.settings.enableDeduplication = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('排除的文件夹')
            .setDesc('不对这些文件夹中的文件创建版本（每行一个路径）')
            .addTextArea(text => {
                text.setValue(this.plugin.settings.excludedFolders.join('\n'))
                    .setPlaceholder('例如:\ntemplates/\n.trash/')
                    .onChange(async (value) => {
                        this.plugin.settings.excludedFolders = value
                            .split('\n')
                            .map(line => line.trim())
                            .filter(line => line.length > 0);
                        await this.plugin.saveSettings();
                    });
                text.inputEl.rows = 4;
                text.inputEl.style.width = '100%';
            });

        containerEl.createEl('h3', { text: '🗑️ 自动清理' });

        new Setting(containerEl)
            .setName('启用自动清理')
            .setDesc('自动删除旧版本以节省空间')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoClear)
                .onChange(async (value) => {
                    this.plugin.settings.autoClear = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('按数量清理')
            .setDesc('保留指定数量的最新版本')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableMaxVersions)
                .onChange(async (value) => {
                    this.plugin.settings.enableMaxVersions = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('最大版本数')
            .setDesc('每个文件最多保留的版本数量')
            .addText(text => text
                .setPlaceholder('50')
                .setValue(String(this.plugin.settings.maxVersions))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.maxVersions = num;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('按天数清理')
            .setDesc('自动删除超过指定天数的版本')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableMaxDays)
                .onChange(async (value) => {
                    this.plugin.settings.enableMaxDays = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('最大保留天数')
            .setDesc('删除超过此天数的旧版本')
            .addText(text => text
                .setPlaceholder('30')
                .setValue(String(this.plugin.settings.maxDays))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.maxDays = num;
                        await this.plugin.saveSettings();
                    }
                }));

        containerEl.createEl('h3', { text: '🎨 显示设置' });

        new Setting(containerEl)
            .setName('使用相对时间')
            .setDesc('显示"3小时前"而不是具体时间')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useRelativeTime)
                .onChange(async (value) => {
                    this.plugin.settings.useRelativeTime = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshVersionHistoryView();
                }));

        containerEl.createEl('h3', { text: '🔀 差异对比设置' });

        new Setting(containerEl)
            .setName('差异粒度')
            .setDesc('选择差异计算的精细程度')
            .addDropdown(dropdown => dropdown
                .addOption('char', '字符级 - 最精确，显示每个字符的变化')
                .addOption('word', '单词级 - 按单词显示差异')
                .addOption('line', '行级 - 按行显示差异')
                .setValue(this.plugin.settings.diffGranularity)
                .onChange(async (value: 'char' | 'word' | 'line') => {
                    this.plugin.settings.diffGranularity = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('默认视图模式')
            .setDesc('选择差异对比的默认显示方式')
            .addDropdown(dropdown => dropdown
                .addOption('unified', '统一视图 - 上下对比')
                .addOption('split', '左右分栏 - 并排显示')
                .setValue(this.plugin.settings.diffViewMode)
                .onChange(async (value: 'unified' | 'split') => {
                    this.plugin.settings.diffViewMode = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: '🛠️ 维护操作' });

        new Setting(containerEl)
            .setName('清理所有版本')
            .setDesc('删除所有版本数据（谨慎操作）')
            .addButton(button => button
                .setButtonText('清空所有版本')
                .setWarning()
                .onClick(async () => {
                    new ConfirmModal(
                        this.app,
                        '确认清空所有版本',
                        '此操作将删除所有文件的所有版本历史！\n\n此操作不可撤销，请谨慎操作！',
                        async () => {
                            await this.clearAllVersions();
                        }
                    ).open();
                }));

        new Setting(containerEl)
            .setName('导出版本数据')
            .setDesc('将版本文件夹打包导出')
            .addButton(button => button
                .setButtonText('创建备份')
                .onClick(async () => {
                    new Notice('请手动复制 .versions 文件夹进行备份');
                }));
    }

    async clearAllVersions() {
        try {
            const adapter = this.app.vault.adapter;
            const versionFolder = this.plugin.settings.versionFolder;
            
            if (await adapter.exists(versionFolder)) {
                const files = await adapter.list(versionFolder);
                
                let deletedCount = 0;
                for (const file of files.files) {
                    if (file.endsWith('.json')) {
                        await adapter.remove(file);
                        deletedCount++;
                    }
                }

                this.plugin.versionCache.clear();
                new Notice(`✓ 已清空所有版本（删除 ${deletedCount} 个版本文件）`);
                this.plugin.refreshVersionHistoryView();
                this.display();
            }
        } catch (error) {
            console.error('清空版本失败:', error);
            new Notice('❌ 清空失败，请查看控制台');
        }
    }
}