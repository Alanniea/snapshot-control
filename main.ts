import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, Modal, ItemView, WorkspaceLeaf, Menu, TextComponent } from 'obsidian';
import * as Diff from 'diff';
import * as pako from 'pako';

interface VersionData {
    id: string;
    timestamp: number;
    message: string;
    content?: string;
    diff?: string;
    baseVersionId?: string;
    size: number;
    hash?: string;
    tags?: string[]; // 新增：版本标签
    note?: string;   // 新增：版本备注
    starred?: boolean; // 新增：星标标记
}

interface VersionFile {
    filePath: string;
    versions: VersionData[];
    lastModified: number;
    baseVersion?: string;
    versionIndex?: Map<string, number>;
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
    enableIncrementalStorage: boolean;
    versionsPerPage: number;
    rebuildBaseInterval: number;
    autoSaveOnModify: boolean;
    autoSaveDelay: number;
    autoSaveMinChanges: number;
    autoSaveOnInterval: boolean;
    autoSaveOnFileSwitch: boolean;
    autoSaveOnFocusLost: boolean;
    enableQuickPreview: boolean; // 新增：快速预览
    enableVersionTags: boolean;  // 新增：版本标签
    defaultTags: string[];       // 新增：默认标签列表
    showVersionStats: boolean;   // 新增：显示统计信息
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
    enableCompression: true,
    enableIncrementalStorage: true,
    versionsPerPage: 20,
    rebuildBaseInterval: 10,
    autoSaveOnModify: true,
    autoSaveDelay: 3,
    autoSaveMinChanges: 10,
    autoSaveOnInterval: false,
    autoSaveOnFileSwitch: true,
    autoSaveOnFocusLost: false,
    enableQuickPreview: true,
    enableVersionTags: true,
    defaultTags: ['重要', '里程碑', '发布', '备份', '草稿'],
    showVersionStats: true
};

export default class VersionControlPlugin extends Plugin {
    settings: VersionControlSettings;
    autoSaveTimer: NodeJS.Timer | null = null;
    lastSavedContent: Map<string, string> = new Map();
    lastModifiedTime: Map<string, number> = new Map();
    pendingSaves: Map<string, NodeJS.Timeout> = new Map();
    statusBarItem: HTMLElement;
    versionCache: Map<string, VersionFile> = new Map();
    previousActiveFile: TFile | null = null;

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

        // 命令注册
        this.addCommand({
            id: 'create-version',
            name: '创建版本快照',
            hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 's' }],
            callback: () => this.createManualVersion()
        });

        this.addCommand({
            id: 'show-version-history',
            name: '显示版本历史',
            hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'h' }],
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
            hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'd' }],
            callback: () => this.quickCompare()
        });

        this.addCommand({
            id: 'restore-last-version',
            name: '恢复到上一版本',
            hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'z' }],
            callback: () => this.restoreLastVersion()
        });

        this.addCommand({
            id: 'optimize-storage',
            name: '优化存储空间',
            callback: () => this.optimizeAllVersionFiles()
        });

        this.addCommand({
            id: 'quick-preview-version',
            name: '快速预览上一版本',
            hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'p' }],
            callback: () => this.quickPreviewLastVersion()
        });

        this.addCommand({
            id: 'star-current-version',
            name: '标记当前版本为重要',
            callback: () => this.starLastVersion()
        });

        this.addSettingTab(new VersionControlSettingTab(this.app, this));

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile && this.settings.autoSave && this.settings.autoSaveOnModify) {
                    this.scheduleAutoSave(file);
                }
            })
        );

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                if (this.settings.autoSave && this.settings.autoSaveOnFileSwitch) {
                    this.handleFileSwitch();
                }
            })
        );

        if (this.settings.autoSaveOnFocusLost) {
            this.registerDomEvent(window, 'blur', () => {
                if (this.settings.autoSave) {
                    this.saveCurrentFileOnFocusLost();
                }
            });
        }

        if (this.settings.autoSave && this.settings.autoSaveOnInterval) {
            this.startAutoSave();
        }

        await this.ensureVersionFolder();

        if (this.settings.showNotifications) {
            new Notice('✅ 版本控制插件已启动');
        }
    }

    onunload() {
        if (this.autoSaveTimer) {
            clearInterval(this.autoSaveTimer);
        }
        this.pendingSaves.forEach(timeout => clearTimeout(timeout));
        this.pendingSaves.clear();
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
        if (!this.settings.autoSave) {
            this.statusBarItem.setText('⏸ 版本控制: 已暂停');
            return;
        }

        const modes: string[] = [];
        if (this.settings.autoSaveOnModify) modes.push('修改');
        if (this.settings.autoSaveOnInterval) modes.push(`${this.settings.autoSaveInterval}分钟`);
        if (this.settings.autoSaveOnFileSwitch) modes.push('切换');
        if (this.settings.autoSaveOnFocusLost) modes.push('失焦');

        if (modes.length > 0) {
            this.statusBarItem.setText(`⏱ 版本控制: ${modes.join(' | ')}`);
        } else {
            this.statusBarItem.setText('⏱ 版本控制: 已启用');
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
            new Notice('⚠️ 无法创建版本文件夹,请检查权限');
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
        
        if (this.settings.autoSaveOnInterval) {
            this.autoSaveTimer = setInterval(() => {
                this.autoSaveCurrentFile();
            }, this.settings.autoSaveInterval * 60 * 1000);
        }
    }

    scheduleAutoSave(file: TFile) {
        if (this.isExcluded(file.path)) {
            return;
        }

        const existingTimeout = this.pendingSaves.get(file.path);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
        }

        const timeout = setTimeout(() => {
            this.autoSaveFile(file);
            this.pendingSaves.delete(file.path);
        }, this.settings.autoSaveDelay * 1000);

        this.pendingSaves.set(file.path, timeout);
    }

    async autoSaveFile(file: TFile) {
        try {
            const content = await this.app.vault.read(file);
            const lastContent = this.lastSavedContent.get(file.path);

            if (lastContent) {
                const changeCount = this.countChanges(lastContent, content);
                if (changeCount < this.settings.autoSaveMinChanges) {
                    return;
                }
            }

            if (content !== lastContent) {
                await this.createVersion(file, '[Auto Save]', false);
                this.lastSavedContent.set(file.path, content);
                this.lastModifiedTime.set(file.path, Date.now());
                this.updateStatusBarWithLastSave();
            }
        } catch (error) {
            console.error('自动保存失败:', error);
        }
    }

    countChanges(oldText: string, newText: string): number {
        let changes = 0;
        const maxLen = Math.max(oldText.length, newText.length);
        
        for (let i = 0; i < maxLen; i++) {
            if (oldText[i] !== newText[i]) {
                changes++;
            }
        }
        
        return changes;
    }

    async handleFileSwitch() {
        const currentFile = this.app.workspace.getActiveFile();
        
        if (this.previousActiveFile && this.previousActiveFile !== currentFile) {
            const pendingSave = this.pendingSaves.get(this.previousActiveFile.path);
            if (pendingSave) {
                clearTimeout(pendingSave);
                this.pendingSaves.delete(this.previousActiveFile.path);
                await this.autoSaveFile(this.previousActiveFile);
            }
        }
        
        this.previousActiveFile = currentFile;
    }

    async saveCurrentFileOnFocusLost() {
        const file = this.app.workspace.getActiveFile();
        if (!file || this.isExcluded(file.path)) return;

        const pendingSave = this.pendingSaves.get(file.path);
        if (pendingSave) {
            clearTimeout(pendingSave);
            this.pendingSaves.delete(file.path);
        }
        
        await this.autoSaveFile(file);
    }

    updateStatusBarWithLastSave() {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;

        const lastSaveTime = this.lastModifiedTime.get(file.path);
        if (lastSaveTime) {
            const elapsed = Date.now() - lastSaveTime;
            const seconds = Math.floor(elapsed / 1000);
            
            if (seconds < 60) {
                this.statusBarItem.title = `最近保存: ${seconds}秒前`;
            } else {
                const minutes = Math.floor(seconds / 60);
                this.statusBarItem.title = `最近保存: ${minutes}分钟前`;
            }
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

        new VersionMessageModal(this.app, this.settings, async (message, tags) => {
            await this.createVersion(file, message, true, tags);
            if (this.settings.showNotifications) {
                new Notice('✅ 版本已创建');
            }
        }).open();
    }

    async createVersion(file: TFile, message: string, showNotification: boolean = false, tags: string[] = []) {
        try {
            const content = await this.app.vault.read(file);
            const timestamp = Date.now();
            const id = `${timestamp}`;
            const hash = this.hashContent(content);
            
            const versionFile = await this.loadVersionFile(file.path);
            
            if (this.settings.enableDeduplication) {
                const duplicate = versionFile.versions.find(v => v.hash === hash);
                if (duplicate) {
                    if (showNotification && this.settings.showNotifications) {
                        new Notice('ℹ️ 内容未变化,跳过创建版本');
                    }
                    return;
                }
            }

            let newVersion: VersionData;

            if (this.settings.enableIncrementalStorage && versionFile.versions.length > 0) {
                const shouldRebuildBase = versionFile.versions.length % this.settings.rebuildBaseInterval === 0;
                
                if (shouldRebuildBase) {
                    newVersion = {
                        id,
                        timestamp,
                        message,
                        content,
                        size: content.length,
                        hash,
                        tags: tags.length > 0 ? tags : undefined,
                        starred: false
                    };
                    versionFile.baseVersion = content;
                } else {
                    const baseContent = versionFile.baseVersion || versionFile.versions[0].content || '';
                    const diff = this.createDiff(baseContent, content);
                    
                    newVersion = {
                        id,
                        timestamp,
                        message,
                        diff,
                        baseVersionId: versionFile.versions[0].id,
                        size: diff.length,
                        hash,
                        tags: tags.length > 0 ? tags : undefined,
                        starred: false
                    };
                }
            } else {
                newVersion = {
                    id,
                    timestamp,
                    message,
                    content,
                    size: content.length,
                    hash,
                    tags: tags.length > 0 ? tags : undefined,
                    starred: false
                };
                
                if (this.settings.enableIncrementalStorage) {
                    versionFile.baseVersion = content;
                }
            }

            versionFile.versions.unshift(newVersion);
            versionFile.lastModified = timestamp;

            if (this.settings.autoClear) {
                this.cleanupVersionsInMemory(versionFile);
            }

            this.buildVersionIndex(versionFile);
            await this.saveVersionFile(file.path, versionFile);
            this.versionCache.set(file.path, versionFile);
            this.refreshVersionHistoryView();

            if (showNotification && this.settings.showNotifications) {
                new Notice(`✅ 版本已创建: ${message}`);
            }
        } catch (error) {
            console.error('创建版本失败:', error);
            new Notice('❌ 创建版本失败,请查看控制台');
        }
    }

    createDiff(oldContent: string, newContent: string): string {
        const changes = Diff.diffLines(oldContent, newContent);
        return JSON.stringify(changes);
    }

    applyDiff(baseContent: string, diffStr: string): string {
        try {
            const changes = JSON.parse(diffStr);
            let result = '';
            
            for (const change of changes) {
                if (!change.removed) {
                    result += change.value;
                }
            }
            
            return result;
        } catch (error) {
            console.error('应用差异失败:', error);
            return baseContent;
        }
    }

    buildVersionIndex(versionFile: VersionFile) {
        const index = new Map<string, number>();
        versionFile.versions.forEach((version, idx) => {
            index.set(version.id, idx);
        });
        versionFile.versionIndex = index;
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

        if (this.settings.enableMaxVersions) {
            versionsToKeep = versionsToKeep.slice(0, this.settings.maxVersions);
        }

        if (this.settings.enableMaxDays) {
            const cutoffTime = Date.now() - (this.settings.maxDays * 24 * 60 * 60 * 1000);
            versionsToKeep = versionsToKeep.filter(v => v.timestamp >= cutoffTime);
        }

        const removedCount = versionFile.versions.length - versionsToKeep.length;
        versionFile.versions = versionsToKeep;

        return removedCount;
    }

    async loadVersionFile(filePath: string): Promise<VersionFile> {
        if (this.versionCache.has(filePath)) {
            return this.versionCache.get(filePath)!;
        }

        const versionPath = this.getVersionFilePath(filePath);
        const adapter = this.app.vault.adapter;

        try {
            if (await adapter.exists(versionPath)) {
                const rawData = await adapter.readBinary(versionPath);
                let content: string;
                
                if (this.settings.enableCompression) {
                    try {
                        const decompressed = pako.ungzip(new Uint8Array(rawData), { to: 'string' });
                        content = decompressed;
                    } catch (e) {
                        content = await adapter.read(versionPath);
                    }
                } else {
                    content = await adapter.read(versionPath);
                }
                
                const versionFile = JSON.parse(content) as VersionFile;
                
                if (!versionFile.versionIndex) {
                    this.buildVersionIndex(versionFile);
                }
                
                this.versionCache.set(filePath, versionFile);
                return versionFile;
            }
        } catch (error) {
            console.error('加载版本文件失败:', error);
        }

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
            const dataToSave = {
                ...versionFile,
                versionIndex: undefined
            };
            
            const content = JSON.stringify(dataToSave, null, 2);
            
            if (this.settings.enableCompression) {
                const compressed = pako.gzip(content);
                await adapter.writeBinary(versionPath, compressed.buffer);
            } else {
                await adapter.write(versionPath, content);
            }
        } catch (error) {
            console.error('保存版本文件失败:', error);
            throw error;
        }
    }

    getVersionFilePath(filePath: string): string {
        const sanitized = this.sanitizeFileName(filePath);
        return `${this.settings.versionFolder}/${sanitized}.json`;
    }

    async getVersions(filePath: string, page: number = 0): Promise<VersionData[]> {
        try {
            const versionFile = await this.loadVersionFile(filePath);
            
            if (this.settings.versionsPerPage > 0) {
                const start = page * this.settings.versionsPerPage;
                const end = start + this.settings.versionsPerPage;
                return versionFile.versions.slice(start, end);
            }
            
            return versionFile.versions;
        } catch (error) {
            console.error('获取版本列表失败:', error);
            return [];
        }
    }

    async getAllVersions(filePath: string): Promise<VersionData[]> {
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
            
            const index = versionFile.versionIndex?.get(versionId);
            const version = index !== undefined ? versionFile.versions[index] : 
                          versionFile.versions.find(v => v.id === versionId);
            
            if (!version) {
                throw new Error('版本不存在');
            }

            if (version.content) {
                return version.content;
            }

            if (version.diff && versionFile.baseVersion) {
                return this.applyDiff(versionFile.baseVersion, version.diff);
            }

            throw new Error('无法获取版本内容');
        } catch (error) {
            console.error('读取版本内容失败:', error);
            throw new Error('无法读取版本内容');
        }
    }

    async updateVersionTags(filePath: string, versionId: string, tags: string[]) {
        try {
            const versionFile = await this.loadVersionFile(filePath);
            const index = versionFile.versionIndex?.get(versionId);
            if (index !== undefined) {
                versionFile.versions[index].tags = tags;
                await this.saveVersionFile(filePath, versionFile);
                this.versionCache.set(filePath, versionFile);
                this.refreshVersionHistoryView();
            }
        } catch (error) {
            console.error('更新版本标签失败:', error);
        }
    }

    async updateVersionNote(filePath: string, versionId: string, note: string) {
        try {
            const versionFile = await this.loadVersionFile(filePath);
            const index = versionFile.versionIndex?.get(versionId);
            if (index !== undefined) {
                versionFile.versions[index].note = note;
                await this.saveVersionFile(filePath, versionFile);
                this.versionCache.set(filePath, versionFile);
                this.refreshVersionHistoryView();
            }
        } catch (error) {
            console.error('更新版本备注失败:', error);
        }
    }

    async toggleVersionStar(filePath: string, versionId: string) {
        try {
            const versionFile = await this.loadVersionFile(filePath);
            const index = versionFile.versionIndex?.get(versionId);
            if (index !== undefined) {
                versionFile.versions[index].starred = !versionFile.versions[index].starred;
                await this.saveVersionFile(filePath, versionFile);
                this.versionCache.set(filePath, versionFile);
                this.refreshVersionHistoryView();
            }
        } catch (error) {
            console.error('切换星标失败:', error);
        }
    }

    async starLastVersion() {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
            new Notice('没有打开的文件');
            return;
        }

        const versions = await this.getAllVersions(file.path);
        if (versions.length === 0) {
            new Notice('没有可标记的版本');
            return;
        }

        await this.toggleVersionStar(file.path, versions[0].id);
        new Notice('⭐ 已标记/取消标记');
    }

    async quickPreviewLastVersion() {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
            new Notice('没有打开的文件');
            return;
        }

        const versions = await this.getAllVersions(file.path);
        if (versions.length === 0) {
            new Notice('没有历史版本可预览');
            return;
        }

        new QuickPreviewModal(this.app, this, file, versions[0].id).open();
    }

    async deleteVersion(filePath: string, versionId: string) {
        try {
            const versionFile = await this.loadVersionFile(filePath);
            versionFile.versions = versionFile.versions.filter(v => v.id !== versionId);
            versionFile.lastModified = Date.now();
            this.buildVersionIndex(versionFile);
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
            this.buildVersionIndex(versionFile);
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
                new Notice('✅ 版本已恢复');
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

        const versions = await this.getAllVersions(file.path);
        if (versions.length === 0) {
            new Notice('没有可恢复的版本');
            return;
        }

        const lastVersion = versions[0];
        new ConfirmModal(
            this.app,
            '恢复到上一版本',
            `确定要恢复到版本: ${this.formatTime(lastVersion.timestamp)}?\n\n当前未保存的修改将会丢失,插件会在恢复前自动创建备份版本。`,
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

        const versions = await this.getAllVersions(file.path);
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
            new Notice(`✅ 全库版本已创建\n成功: ${count} 个文件${skipped > 0 ? `\n跳过: ${skipped} 个文件` : ''}`);
        }
    }

    async optimizeAllVersionFiles() {
        const progressNotice = new Notice('正在优化存储...', 0);
        
        try {
            const adapter = this.app.vault.adapter;
            const versionFolder = this.settings.versionFolder;
            
            if (!await adapter.exists(versionFolder)) {
                progressNotice.hide();
                new Notice('版本文件夹不存在');
                return;
            }

            const files = await adapter.list(versionFolder);
            let optimized = 0;
            let savedBytes = 0;

            for (const file of files.files) {
                if (file.endsWith('.json')) {
                    try {
                        const oldSize = (await adapter.stat(file))?.size || 0;
                        
                        const content = await adapter.read(file);
                        const versionFile = JSON.parse(content) as VersionFile;
                        
                        this.buildVersionIndex(versionFile);
                        await this.saveVersionFile(versionFile.filePath, versionFile);
                        
                        const newSize = (await adapter.stat(file))?.size || 0;
                        savedBytes += (oldSize - newSize);
                        optimized++;
                    } catch (error) {
                        console.error('优化文件失败:', file, error);
                    }
                }
            }

            progressNotice.hide();
            new Notice(`✅ 优化完成\n处理: ${optimized} 个文件\n节省: ${this.formatFileSize(savedBytes)}`);
        } catch (error) {
            progressNotice.hide();
            console.error('优化失败:', error);
            new Notice('❌ 优化失败');
        }
    }

    async getStorageStats(): Promise<{ totalSize: number; versionCount: number; fileCount: number; compressionRatio: number; starredCount: number; taggedCount: number }> {
        const adapter = this.app.vault.adapter;
        const versionFolder = this.settings.versionFolder;
        
        try {
            if (!await adapter.exists(versionFolder)) {
                return { totalSize: 0, versionCount: 0, fileCount: 0, compressionRatio: 0, starredCount: 0, taggedCount: 0 };
            }

            const files = await adapter.list(versionFolder);
            let totalSize = 0;
            let versionCount = 0;
            let fileCount = 0;
            let totalOriginalSize = 0;
            let starredCount = 0;
            let taggedCount = 0;

            for (const file of files.files) {
                if (file.endsWith('.json')) {
                    try {
                        // 获取文件大小
                        const stat = await adapter.stat(file);
                        const fileSize = stat?.size || 0;
                        totalSize += fileSize;
                        
                        // 读取并解析版本文件
                        let versionFile: VersionFile;
                        
                        if (this.settings.enableCompression) {
                            try {
                                // 尝试作为压缩文件读取
                                const rawData = await adapter.readBinary(file);
                                const decompressed = pako.ungzip(new Uint8Array(rawData), { to: 'string' });
                                versionFile = JSON.parse(decompressed) as VersionFile;
                            } catch (e) {
                                // 如果解压失败，尝试作为普通文本读取
                                const content = await adapter.read(file);
                                versionFile = JSON.parse(content) as VersionFile;
                            }
                        } else {
                            const content = await adapter.read(file);
                            versionFile = JSON.parse(content) as VersionFile;
                        }
                        
                        // 统计版本信息
                        if (versionFile.versions && Array.isArray(versionFile.versions)) {
                            versionCount += versionFile.versions.length;
                            
                            versionFile.versions.forEach(v => {
                                // 计算原始大小
                                if (v.content) {
                                    totalOriginalSize += v.content.length;
                                } else if (v.diff) {
                                    totalOriginalSize += v.diff.length;
                                }
                                
                                // 统计星标和标签
                                if (v.starred) starredCount++;
                                if (v.tags && v.tags.length > 0) taggedCount++;
                            });
                            
                            fileCount++;
                        }
                    } catch (error) {
                        console.error('读取版本文件失败:', file, error);
                    }
                }
            }

            const compressionRatio = totalOriginalSize > 0 ? 
                ((1 - totalSize / totalOriginalSize) * 100) : 0;

            return { totalSize, versionCount, fileCount, compressionRatio, starredCount, taggedCount };
        } catch (error) {
            console.error('获取存储统计失败:', error);
            return { totalSize: 0, versionCount: 0, fileCount: 0, compressionRatio: 0, starredCount: 0, taggedCount: 0 };
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

            new Notice(`✅ 版本已导出到: ${exportPath}`);
        } catch (error) {
            console.error('导出版本失败:', error);
            new Notice('❌ 导出失败');
        }
    }

    async exportVersionAsFile(filePath: string, versionId: string): Promise<void> {
        try {
            const content = await this.getVersionContent(filePath, versionId);
            const fileName = filePath.replace(/\.[^/.]+$/, '');
            const exportPath = `${fileName}_v${versionId}.md`;
            
            await this.app.vault.create(exportPath, content);
            new Notice(`✅ 版本已导出为: ${exportPath}`);
        } catch (error) {
            console.error('导出版本为文件失败:', error);
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

// 快速预览模态框
class QuickPreviewModal extends Modal {
    plugin: VersionControlPlugin;
    file: TFile;
    versionId: string;

    constructor(app: App, plugin: VersionControlPlugin, file: TFile, versionId: string) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.versionId = versionId;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.addClass('quick-preview-modal');

        try {
            const content = await this.plugin.getVersionContent(this.file.path, this.versionId);
            const versions = await this.plugin.getAllVersions(this.file.path);
            const version = versions.find(v => v.id === this.versionId);

            const header = contentEl.createEl('div', { cls: 'preview-header' });
            header.createEl('h2', { text: '快速预览' });
            
            if (version) {
                const info = header.createEl('div', { cls: 'preview-info' });
                info.createEl('span', { text: this.plugin.formatTime(version.timestamp) });
                info.createEl('span', { text: version.message });
            }

            const toolbar = contentEl.createEl('div', { cls: 'preview-toolbar' });
            
            const restoreBtn = toolbar.createEl('button', { text: '恢复此版本', cls: 'mod-cta' });
            restoreBtn.addEventListener('click', async () => {
                this.close();
                await this.plugin.restoreVersion(this.file, this.versionId);
            });

            const compareBtn = toolbar.createEl('button', { text: '详细对比' });
            compareBtn.addEventListener('click', () => {
                this.close();
                new DiffModal(this.app, this.plugin, this.file, this.versionId).open();
            });

            const exportBtn = toolbar.createEl('button', { text: '导出为文件' });
            exportBtn.addEventListener('click', async () => {
                await this.plugin.exportVersionAsFile(this.file.path, this.versionId);
            });

            const contentContainer = contentEl.createEl('div', { cls: 'preview-content' });
            const pre = contentContainer.createEl('pre');
            pre.createEl('code', { text: content });

        } catch (error) {
            contentEl.createEl('p', { text: '加载预览失败' });
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class VersionHistoryView extends ItemView {
    plugin: VersionControlPlugin;
    selectedVersions: Set<string> = new Set();
    currentFile: TFile | null = null;
    searchQuery: string = '';
    currentPage: number = 0;
    totalVersions: number = 0;
    filterTag: string | null = null;
    showStarredOnly: boolean = false;

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
                this.currentPage = 0;
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
            this.currentPage = 0;
            this.refresh();
        });

        // 星标筛选按钮
        const starFilterBtn = actions.createEl('button', { 
            text: this.showStarredOnly ? '⭐ 已筛选' : '⭐ 星标',
            cls: this.showStarredOnly ? 'mod-cta' : ''
        });
        starFilterBtn.addEventListener('click', () => {
            this.showStarredOnly = !this.showStarredOnly;
            this.currentPage = 0;
            this.refresh();
        });

        const createBtn = actions.createEl('button', { 
            text: '创建版本',
            cls: 'mod-cta'
        });
        createBtn.addEventListener('click', () => {
            this.plugin.createManualVersion();
        });

        const moreBtn = actions.createEl('button', { text: '...' });
        moreBtn.addEventListener('click', (e) => {
            const menu = new Menu();
            menu.addItem((item) =>
                item.setTitle('导出版本数据')
                    .setIcon('download')
                    .onClick(() => {
                        this.plugin.exportVersions(file.path);
                    })
            );
            menu.addItem((item) =>
                item.setTitle('查看统计信息')
                    .setIcon('bar-chart')
                    .onClick(() => {
                        this.showStats();
                    })
            );
            menu.showAtMouseEvent(e as MouseEvent);
        });

        const allVersions = await this.plugin.getAllVersions(file.path);
        this.totalVersions = allVersions.length;

        if (this.totalVersions === 0) {
            this.renderEmptyState(container, '暂无版本历史');
            return;
        }

        // 过滤版本
        let filteredVersions = allVersions;
        
        if (this.showStarredOnly) {
            filteredVersions = filteredVersions.filter(v => v.starred);
        }

        if (this.filterTag) {
            filteredVersions = filteredVersions.filter(v => 
                v.tags && v.tags.includes(this.filterTag!)
            );
        }

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

        // 分页逻辑
        const perPage = this.plugin.settings.versionsPerPage;
        const totalPages = Math.ceil(filteredVersions.length / perPage);
        const start = this.currentPage * perPage;
        const end = Math.min(start + perPage, filteredVersions.length);
        const pageVersions = filteredVersions.slice(start, end);

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

        for (const version of pageVersions) {
            const item = listContainer.createEl('div', { cls: 'version-item' });
            if (version.starred) {
                item.addClass('version-starred');
            }
            
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

            const info = listContainer.createEl('div', { cls: 'version-info' });
            
            const timeRow = info.createEl('div', { cls: 'version-time-row' });
            
            // 星标按钮
            const starBtn = timeRow.createEl('span', { 
                text: version.starred ? '⭐' : '☆',
                cls: 'version-star-btn'
            });
            starBtn.addEventListener('click', async () => {
                await this.plugin.toggleVersionStar(file.path, version.id);
            });
            
            timeRow.createEl('span', { 
                text: this.plugin.formatTime(version.timestamp),
                cls: 'version-time'
            });
            
            const messageEl = info.createEl('div', { cls: 'version-message-row' });
            
            // 自动标签
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
            
            // 存储类型标签
            if (version.diff) {
                messageEl.createEl('span', { 
                    text: '增量',
                    cls: 'version-tag version-tag-incremental'
                });
            } else if (version.content) {
                messageEl.createEl('span', { 
                    text: '完整',
                    cls: 'version-tag version-tag-full'
                });
            }
            
            // 用户标签
            if (version.tags && version.tags.length > 0) {
                version.tags.forEach(tag => {
                    const tagEl = messageEl.createEl('span', { 
                        text: tag,
                        cls: 'version-tag version-tag-custom'
                    });
                    tagEl.addEventListener('click', () => {
                        this.filterTag = tag;
                        this.currentPage = 0;
                        this.refresh();
                    });
                });
            }
            
            messageEl.createEl('span', { 
                text: version.message.replace(/\[.*?\]/g, '').trim() || '无描述',
                cls: 'version-message'
            });
            
            // 版本备注
            if (version.note) {
                info.createEl('div', { 
                    text: `📝 ${version.note}`,
                    cls: 'version-note'
                });
            }
            
            info.createEl('div', { 
                text: this.plugin.formatFileSize(version.size),
                cls: 'version-size'
            });

            const actions = item.createEl('div', { cls: 'version-actions' });
            
            // 快速预览按钮
            if (this.plugin.settings.enableQuickPreview) {
                const previewBtn = actions.createEl('button', { 
                    text: '👁',
                    cls: 'version-btn',
                    attr: { title: '快速预览' }
                });
                previewBtn.addEventListener('click', () => {
                    new QuickPreviewModal(this.app, this.plugin, file, version.id).open();
                });
            }
            
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
                this.showVersionContextMenu(e as MouseEvent, file, version);
            });

            const moreBtn = actions.createEl('button', { 
                text: '⋮',
                cls: 'version-btn'
            });
            moreBtn.addEventListener('click', (e) => {
                this.showVersionContextMenu(e as MouseEvent, file, version);
            });
        }

        // 分页控件
        if (totalPages > 1) {
            const pagination = container.createEl('div', { cls: 'version-pagination' });
            
            const prevBtn = pagination.createEl('button', { 
                text: '← 上一页',
                cls: 'version-pagination-btn'
            });
            prevBtn.disabled = this.currentPage === 0;
            prevBtn.addEventListener('click', () => {
                if (this.currentPage > 0) {
                    this.currentPage--;
                    this.refresh();
                }
            });

            const pageInfo = pagination.createEl('span', { 
                text: `第 ${this.currentPage + 1} / ${totalPages} 页`,
                cls: 'version-pagination-info'
            });

            const nextBtn = pagination.createEl('button', { 
                text: '下一页 →',
                cls: 'version-pagination-btn'
            });
            nextBtn.disabled = this.currentPage >= totalPages - 1;
            nextBtn.addEventListener('click', () => {
                if (this.currentPage < totalPages - 1) {
                    this.currentPage++;
                    this.refresh();
                }
            });
        }

        const stats = container.createEl('div', { cls: 'version-footer' });
        stats.createEl('span', { text: `共 ${this.totalVersions} 个版本` });
        if (this.searchQuery || this.showStarredOnly || this.filterTag) {
            stats.createEl('span', { text: ` · 显示 ${filteredVersions.length} 个结果` });
        }
        stats.createEl('span', { text: ` · 显示 ${start + 1}-${end}` });
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
            item.setTitle('选择另一个版本对比')
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
                            if (this.plugin.settings.showNotifications) {
                                new Notice('✅ 版本已删除');
                            }
                            this.refresh();
                        }
                    ).open();
                })
        );
        
        menu.showAtMouseEvent(event);
    }

    async showStats() {
        const file = this.currentFile;
        if (!file) return;

        const versions = await this.plugin.getAllVersions(file.path);
        const starredCount = versions.filter(v => v.starred).length;
        const taggedCount = versions.filter(v => v.tags && v.tags.length > 0).length;
        const totalSize = versions.reduce((sum, v) => sum + v.size, 0);

        new Notice(
            `📊 统计信息\n` +
            `总版本数: ${versions.length}\n` +
            `星标版本: ${starredCount}\n` +
            `已标签版本: ${taggedCount}\n` +
            `总大小: ${this.plugin.formatFileSize(totalSize)}`,
            5000
        );
    }

    renderEmptyState(container: HTMLElement, message: string) {
        const empty = container.createEl('div', { cls: 'version-history-empty' });
        empty.createEl('div', { 
            text: '📋',
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

        if (this.filterTag || this.showStarredOnly) {
            const clearFilterBtn = empty.createEl('button', { 
                text: '清除筛选',
                cls: 'mod-cta'
            });
            clearFilterBtn.addEventListener('click', () => {
                this.filterTag = null;
                this.showStarredOnly = false;
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
                if (this.plugin.settings.showNotifications) {
                    new Notice('✅ 已删除选中版本');
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

// 标签编辑模态框
class TagEditModal extends Modal {
    plugin: VersionControlPlugin;
    filePath: string;
    versionId: string;
    currentTags: string[];
    selectedTags: Set<string> = new Set();

    constructor(app: App, plugin: VersionControlPlugin, filePath: string, versionId: string, currentTags: string[]) {
        super(app);
        this.plugin = plugin;
        this.filePath = filePath;
        this.versionId = versionId;
        this.currentTags = currentTags;
        this.selectedTags = new Set(currentTags);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: '编辑版本标签' });

        const container = contentEl.createEl('div', { cls: 'tag-edit-container' });

        // 默认标签
        const defaultSection = container.createEl('div', { cls: 'tag-section' });
        defaultSection.createEl('h3', { text: '常用标签' });
        const defaultTags = defaultSection.createEl('div', { cls: 'tag-list' });

        this.plugin.settings.defaultTags.forEach(tag => {
            const tagEl = defaultTags.createEl('span', { 
                text: tag,
                cls: this.selectedTags.has(tag) ? 'tag-item tag-selected' : 'tag-item'
            });
            tagEl.addEventListener('click', () => {
                if (this.selectedTags.has(tag)) {
                    this.selectedTags.delete(tag);
                    tagEl.removeClass('tag-selected');
                } else {
                    this.selectedTags.add(tag);
                    tagEl.addClass('tag-selected');
                }
            });
        });

        // 自定义标签
        const customSection = container.createEl('div', { cls: 'tag-section' });
        customSection.createEl('h3', { text: '自定义标签' });
        
        const input = customSection.createEl('input', {
            type: 'text',
            placeholder: '输入新标签...'
        });
        input.style.width = '100%';

        const addBtn = customSection.createEl('button', { text: '添加', cls: 'mod-cta' });
        addBtn.addEventListener('click', () => {
            const tag = input.value.trim();
            if (tag && !this.selectedTags.has(tag)) {
                this.selectedTags.add(tag);
                this.renderSelectedTags(selectedTagsContainer);
                input.value = '';
            }
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                addBtn.click();
            }
        });

        // 已选标签
        const selectedSection = container.createEl('div', { cls: 'tag-section' });
        selectedSection.createEl('h3', { text: '已选标签' });
        const selectedTagsContainer = selectedSection.createEl('div', { cls: 'tag-list' });
        this.renderSelectedTags(selectedTagsContainer);

        // 按钮
        const btnContainer = contentEl.createEl('div', { cls: 'modal-button-container' });
        
        const cancelBtn = btnContainer.createEl('button', { text: '取消' });
        cancelBtn.addEventListener('click', () => this.close());

        const saveBtn = btnContainer.createEl('button', { text: '保存', cls: 'mod-cta' });
        saveBtn.addEventListener('click', async () => {
            await this.plugin.updateVersionTags(this.filePath, this.versionId, Array.from(this.selectedTags));
            new Notice('✅ 标签已更新');
            this.close();
        });
    }

    renderSelectedTags(container: HTMLElement) {
        container.empty();
        this.selectedTags.forEach(tag => {
            const tagEl = container.createEl('span', { text: tag, cls: 'tag-item tag-removable' });
            const removeBtn = tagEl.createEl('span', { text: '×', cls: 'tag-remove' });
            removeBtn.addEventListener('click', () => {
                this.selectedTags.delete(tag);
                this.renderSelectedTags(container);
            });
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// 备注编辑模态框
class NoteEditModal extends Modal {
    plugin: VersionControlPlugin;
    filePath: string;
    versionId: string;
    currentNote: string;

    constructor(app: App, plugin: VersionControlPlugin, filePath: string, versionId: string, currentNote: string) {
        super(app);
        this.plugin = plugin;
        this.filePath = filePath;
        this.versionId = versionId;
        this.currentNote = currentNote;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: '编辑版本备注' });

        const textarea = contentEl.createEl('textarea', {
            placeholder: '为此版本添加详细备注...'
        });
        textarea.value = this.currentNote;
        textarea.style.width = '100%';
        textarea.style.minHeight = '150px';

        const btnContainer = contentEl.createEl('div', { cls: 'modal-button-container' });
        
        const cancelBtn = btnContainer.createEl('button', { text: '取消' });
        cancelBtn.addEventListener('click', () => this.close());

        const saveBtn = btnContainer.createEl('button', { text: '保存', cls: 'mod-cta' });
        saveBtn.addEventListener('click', async () => {
            await this.plugin.updateVersionNote(this.filePath, this.versionId, textarea.value.trim());
            new Notice('✅ 备注已更新');
            this.close();
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class VersionMessageModal extends Modal {
    result: string = '';
    tags: string[] = [];
    onSubmit: (result: string, tags: string[]) => void;
    inputEl: TextComponent;
    settings: VersionControlSettings;

    constructor(app: App, settings: VersionControlSettings, onSubmit: (result: string, tags: string[]) => void) {
        super(app);
        this.settings = settings;
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
                text.setPlaceholder('例如:添加新章节、修复错误等...')
                    .onChange(value => {
                        this.result = value;
                    });
                text.inputEl.style.width = '100%';
                text.inputEl.focus();
            });

        if (this.settings.enableVersionTags && this.settings.defaultTags.length > 0) {
            const tagSection = contentEl.createEl('div', { cls: 'tag-section' });
            tagSection.createEl('h3', { text: '添加标签 (可选)' });
            const tagContainer = tagSection.createEl('div', { cls: 'tag-list' });

            this.settings.defaultTags.forEach(tag => {
                const tagEl = tagContainer.createEl('span', { text: tag, cls: 'tag-item' });
                tagEl.addEventListener('click', () => {
                    if (tagEl.hasClass('tag-selected')) {
                        tagEl.removeClass('tag-selected');
                        this.tags = this.tags.filter(t => t !== tag);
                    } else {
                        tagEl.addClass('tag-selected');
                        this.tags.push(tag);
                    }
                });
            });
        }

        const buttonContainer = contentEl.createEl('div', { cls: 'modal-button-container' });
        
        const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
        cancelBtn.addEventListener('click', () => this.close());

        const createBtn = buttonContainer.createEl('button', { 
            text: '创建',
            cls: 'mod-cta'
        });
        createBtn.addEventListener('click', () => {
            this.close();
            this.onSubmit(this.result || '[Manual Save]', this.tags);
        });

        this.inputEl.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.close();
                this.onSubmit(this.result || '[Manual Save]', this.tags);
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
                
                const versions = await this.plugin.getAllVersions(this.file.path);
                const leftVersion = versions.find(v => v.id === this.versionId);
                const rightVersion = versions.find(v => v.id === this.secondVersionId);
                
                leftLabel = leftVersion ? `版本 A: ${this.plugin.formatTime(leftVersion.timestamp)}` : '版本 A';
                rightLabel = rightVersion ? `版本 B: ${this.plugin.formatTime(rightVersion.timestamp)}` : '版本 B';
            } else {
                leftContent = await this.plugin.getVersionContent(this.file.path, this.versionId);
                rightContent = await this.app.vault.read(this.file);
                
                const versions = await this.plugin.getAllVersions(this.file.path);
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
            new Notice('✅ 差异内容已复制到剪贴板');
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

        const versions = await this.plugin.getAllVersions(this.file.path);
        
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

        if (this.plugin.settings.showVersionStats) {
            const stats = await this.plugin.getStorageStats();
            const statsEl = containerEl.createEl('div', { cls: 'version-stats' });
            statsEl.createEl('h3', { text: '📊 存储统计' });
            const statsGrid = statsEl.createEl('div', { cls: 'stats-grid' });
            statsGrid.createEl('div', { text: `总大小: ${this.plugin.formatFileSize(stats.totalSize)}` });
            statsGrid.createEl('div', { text: `版本数量: ${stats.versionCount}` });
            statsGrid.createEl('div', { text: `文件数量: ${stats.fileCount}` });
            statsGrid.createEl('div', { text: `星标版本: ${stats.starredCount}` });
            statsGrid.createEl('div', { text: `标签版本: ${stats.taggedCount}` });
            if (this.plugin.settings.enableCompression || this.plugin.settings.enableIncrementalStorage) {
                statsGrid.createEl('div', { text: `压缩率: ${stats.compressionRatio.toFixed(1)}%` });
            }

            const refreshBtn = statsEl.createEl('button', { text: '🔄 刷新统计' });
            refreshBtn.addEventListener('click', () => {
                this.display();
            });
        }

        containerEl.createEl('h3', { text: '⚙️ 基础设置' });

        new Setting(containerEl)
            .setName('版本存储路径')
            .setDesc('指定版本数据的存储位置(相对于库根目录)')
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

        new Setting(containerEl)
            .setName('显示统计信息')
            .setDesc('在设置页面显示版本统计')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showVersionStats)
                .onChange(async (value) => {
                    this.plugin.settings.showVersionStats = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        containerEl.createEl('h3', { text: '🏷️ 版本标签与备注' });

        new Setting(containerEl)
            .setName('启用版本标签')
            .setDesc('为版本添加标签以便分类和筛选')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableVersionTags)
                .onChange(async (value) => {
                    this.plugin.settings.enableVersionTags = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('默认标签列表')
            .setDesc('预设的常用标签(每行一个)')
            .addTextArea(text => {
                text.setValue(this.plugin.settings.defaultTags.join('\n'))
                    .setPlaceholder('重要\n里程碑\n发布\n备份\n草稿')
                    .onChange(async (value) => {
                        this.plugin.settings.defaultTags = value
                            .split('\n')
                            .map(line => line.trim())
                            .filter(line => line.length > 0);
                        await this.plugin.saveSettings();
                    });
                text.inputEl.rows = 4;
                text.inputEl.style.width = '100%';
            });

        new Setting(containerEl)
            .setName('启用快速预览')
            .setDesc('在版本历史中显示快速预览按钮')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableQuickPreview)
                .onChange(async (value) => {
                    this.plugin.settings.enableQuickPreview = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshVersionHistoryView();
                }));

        containerEl.createEl('h3', { text: '🤖 自动保存' });

        new Setting(containerEl)
            .setName('启用自动保存')
            .setDesc('自动创建版本快照')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSave)
                .onChange(async (value) => {
                    this.plugin.settings.autoSave = value;
                    await this.plugin.saveSettings();
                    
                    if (value && this.plugin.settings.autoSaveOnInterval) {
                        this.plugin.startAutoSave();
                    } else if (this.plugin.autoSaveTimer) {
                        clearInterval(this.plugin.autoSaveTimer);
                    }
                }));

        const autoSaveDesc = containerEl.createEl('div', { cls: 'setting-item-description' });
        autoSaveDesc.innerHTML = '选择以下一种或多种自动保存触发方式:';
        autoSaveDesc.style.marginBottom = '10px';
        autoSaveDesc.style.color = 'var(--text-muted)';

        new Setting(containerEl)
            .setName('✏️ 修改时自动保存')
            .setDesc('文件修改后延迟保存(推荐)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSaveOnModify)
                .onChange(async (value) => {
                    this.plugin.settings.autoSaveOnModify = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('保存延迟 (秒)')
            .setDesc('修改后等待多久才保存,避免频繁创建版本')
            .addSlider(slider => slider
                .setLimits(1, 30, 1)
                .setValue(this.plugin.settings.autoSaveDelay)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.autoSaveDelay = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('最小变化字符数')
            .setDesc('只有变化超过此字符数时才保存版本')
            .addSlider(slider => slider
                .setLimits(0, 100, 5)
                .setValue(this.plugin.settings.autoSaveMinChanges)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.autoSaveMinChanges = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('⏰ 定时自动保存')
            .setDesc('按固定时间间隔保存')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSaveOnInterval)
                .onChange(async (value) => {
                    this.plugin.settings.autoSaveOnInterval = value;
                    await this.plugin.saveSettings();
                    
                    if (value && this.plugin.settings.autoSave) {
                        this.plugin.startAutoSave();
                    } else if (this.plugin.autoSaveTimer) {
                        clearInterval(this.plugin.autoSaveTimer);
                        this.plugin.autoSaveTimer = null;
                    }
                }));

        new Setting(containerEl)
            .setName('定时间隔 (分钟)')
            .setDesc('每隔多久自动检查并保存')
            .addText(text => text
                .setPlaceholder('5')
                .setValue(String(this.plugin.settings.autoSaveInterval))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.autoSaveInterval = num;
                        await this.plugin.saveSettings();
                        if (this.plugin.settings.autoSave && this.plugin.settings.autoSaveOnInterval) {
                            this.plugin.startAutoSave();
                        }
                    }
                }));

        new Setting(containerEl)
            .setName('🔄 切换文件时保存')
            .setDesc('切换到其他文件时自动保存当前文件')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSaveOnFileSwitch)
                .onChange(async (value) => {
                    this.plugin.settings.autoSaveOnFileSwitch = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('👁️ 失去焦点时保存')
            .setDesc('窗口失去焦点时自动保存(切换应用时)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSaveOnFocusLost)
                .onChange(async (value) => {
                    this.plugin.settings.autoSaveOnFocusLost = value;
                    await this.plugin.saveSettings();
                    
                    if (value) {
                        new Notice('失去焦点保存将在重启 Obsidian 后生效');
                    }
                }));

        new Setting(containerEl)
            .setName('启用去重')
            .setDesc('跳过内容相同的版本创建,节省存储空间')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableDeduplication)
                .onChange(async (value) => {
                    this.plugin.settings.enableDeduplication = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('排除的文件夹')
            .setDesc('不对这些文件夹中的文件创建版本(每行一个路径)')
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

        containerEl.createEl('h3', { text: '💾 存储优化' });

        new Setting(containerEl)
            .setName('启用压缩')
            .setDesc('使用 gzip 压缩版本文件,显著减少存储空间占用')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableCompression)
                .onChange(async (value) => {
                    this.plugin.settings.enableCompression = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('启用增量存储')
            .setDesc('只保存版本间的差异,大幅降低存储空间使用')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableIncrementalStorage)
                .onChange(async (value) => {
                    this.plugin.settings.enableIncrementalStorage = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('基准版本间隔')
            .setDesc('每N个版本创建一次完整快照(建议10-20),用于增量存储的基准')
            .addText(text => text
                .setPlaceholder('10')
                .setValue(String(this.plugin.settings.rebuildBaseInterval))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.rebuildBaseInterval = num;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('每页显示版本数')
            .setDesc('版本历史视图中每页显示的版本数量(0=不分页)')
            .addText(text => text
                .setPlaceholder('20')
                .setValue(String(this.plugin.settings.versionsPerPage))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num >= 0) {
                        this.plugin.settings.versionsPerPage = num;
                        await this.plugin.saveSettings();
                        this.plugin.refreshVersionHistoryView();
                    }
                }));

        new Setting(containerEl)
            .setName('优化存储')
            .setDesc('重新压缩和优化所有版本文件')
            .addButton(button => button
                .setButtonText('立即优化')
                .onClick(async () => {
                    await this.plugin.optimizeAllVersionFiles();
                    this.display();
                }));

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
                .addOption('char', '字符级 - 最精确,显示每个字符的变化')
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
            .setDesc('删除所有版本数据(谨慎操作)')
            .addButton(button => button
                .setButtonText('清空所有版本')
                .setWarning()
                .onClick(async () => {
                    new ConfirmModal(
                        this.app,
                        '确认清空所有版本',
                        '此操作将删除所有文件的所有版本历史!\n\n此操作不可撤销,请谨慎操作!',
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

        // 添加使用说明
        containerEl.createEl('h3', { text: '📖 使用说明' });
        const infoEl = containerEl.createEl('div', { cls: 'version-info-section' });
        
        const feature1 = infoEl.createEl('div', { cls: 'feature-item' });
        feature1.createEl('strong', { text: '✨ 新功能:' });
        const ul1 = feature1.createEl('ul');
        ul1.createEl('li', { text: '版本标签系统 - 为重要版本添加标签进行分类' });
        ul1.createEl('li', { text: '快速预览 - 无需完整对比即可查看版本内容' });
        ul1.createEl('li', { text: '版本备注 - 为版本添加详细说明' });
        ul1.createEl('li', { text: '星标标记 - 标记重要版本便于查找' });
        ul1.createEl('li', { text: '高级筛选 - 按标签、星标筛选版本' });
        
        const feature2 = infoEl.createEl('div', { cls: 'feature-item' });
        feature2.createEl('strong', { text: '⌨️ 快捷键:' });
        const ul2 = feature2.createEl('ul');
        ul2.createEl('li', { text: 'Ctrl+Shift+S - 创建版本快照' });
        ul2.createEl('li', { text: 'Ctrl+Shift+H - 显示版本历史' });
        ul2.createEl('li', { text: 'Ctrl+Shift+D - 与历史版本对比' });
        ul2.createEl('li', { text: 'Ctrl+Shift+Z - 恢复到上一版本' });
        ul2.createEl('li', { text: 'Ctrl+Shift+P - 快速预览上一版本' });
        
        const feature3 = infoEl.createEl('div', { cls: 'feature-item' });
        feature3.createEl('strong', { text: '💡 使用技巧:' });
        const ul3 = feature3.createEl('ul');
        ul3.createEl('li', { text: '右键点击版本可查看更多操作选项' });
        ul3.createEl('li', { text: '点击标签可快速筛选相关版本' });
        ul3.createEl('li', { text: '使用星标标记重要的里程碑版本' });
        ul3.createEl('li', { text: '定期运行"优化存储"以保持最佳性能' });
        ul3.createEl('li', { text: '增量存储和压缩可节省90%以上的空间' });
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
                new Notice(`✅ 已清空所有版本(删除 ${deletedCount} 个版本文件)`);
                this.plugin.refreshVersionHistoryView();
                this.display();
            }
        } catch (error) {
            console.error('清空版本失败:', error);
            new Notice('❌ 清空失败,请查看控制台');
        }
    }
}