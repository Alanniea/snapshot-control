
import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, Modal, ItemView, WorkspaceLeaf, Menu, TextComponent, MarkdownRenderer } from 'obsidian';
import * as Diff from 'diff';
import * as pako from 'pako';

// VersionData 接口
interface VersionData {
    id: string;
    timestamp: number;
    message: string;
    content?: string;
    diff?: string;
    baseVersionId?: string;
    size: number;
    hash?: string;
    tags?: string[];
    note?: string;
    starred?: boolean;
    addedLines?: number;
    removedLines?: number;
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

    enableQuickPreview: boolean;
    enableVersionTags: boolean;
    defaultTags: string[];
    showVersionStats: boolean;
    enableStatusBarDiff: boolean;
    showLastSaveTimeInStatusBar: boolean;
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
    autoSaveDelay: 180,
    autoSaveMinChanges: 10,
    autoSaveOnInterval: false,
    autoSaveOnFileSwitch: true,
    autoSaveOnFocusLost: false,
    enableQuickPreview: true,
    enableVersionTags: true,
    defaultTags: ['重要', '里程碑', '发布', '备份', '草稿'],
    showVersionStats: true,
    enableStatusBarDiff: true,
    showLastSaveTimeInStatusBar: true,
};


export default class VersionControlPlugin extends Plugin {
    settings: VersionControlSettings;
    autoSaveTimer: number | null = null;
    lastModifiedTime: Map<string, number> = new Map();
    pendingSaves: Map<string, NodeJS.Timeout> = new Map();
    statusBarItem: HTMLElement;
    versionCache: Map<string, VersionFile> = new Map();
    previousActiveFile: TFile | null = null;
    globalTimeUpdater: number | null = null;

    async onload() {
        await this.loadSettings();

        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar();

        if (this.settings.enableStatusBarDiff) {
            this.statusBarItem.addClass('version-control-statusbar-clickable');
            this.statusBarItem.addEventListener('click', () => {
                this.quickDiffFromStatusBar();
            });
        }

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

        this.addCommand({
            id: 'optimize-storage',
            name: '优化存储空间',
            callback: () => this.optimizeAllVersionFiles()
        });

        this.addCommand({
            id: 'quick-preview-version',
            name: '快速预览上一版本',
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
                this.updateStatusBar();
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

        this.globalTimeUpdater = window.setInterval(() => {
            this.updateAllRelativeTimes();
        }, 60000);

        if (this.settings.showNotifications) {
            new Notice('✅ 版本控制插件已启动');
        }
    }

    onunload() {
        if (this.autoSaveTimer) {
            window.clearInterval(this.autoSaveTimer);
        }
        if (this.globalTimeUpdater) {
            window.clearInterval(this.globalTimeUpdater);
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

    updateAllRelativeTimes() {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;

        if (this.settings.useRelativeTime || this.settings.showLastSaveTimeInStatusBar) {
            this.updateStatusBar();

            const leaves = this.app.workspace.getLeavesOfType('version-history');
            leaves.forEach(leaf => {
                if (leaf.view instanceof VersionHistoryView) {
                    leaf.view.updateRelativeTimes();
                }
            });
        }
    }

    async updateStatusBar() {
        if (!this.settings.autoSave) {
            this.statusBarItem.setText('⏸ 版本控制: 已暂停');
            this.statusBarItem.title = '自动保存已暂停';
            return;
        }

        const file = this.app.workspace.getActiveFile();
        
        if (!this.settings.showLastSaveTimeInStatusBar || !file) {
            this.statusBarItem.setText('⏱ 版本控制: 已启用');
            this.statusBarItem.title = '点击可快速对比当前文件与最新版本';
            return;
        }

        let lastSaveTime = this.lastModifiedTime.get(file.path);

        if (!lastSaveTime) {
            const versions = await this.getAllVersions(file.path);
            if (versions.length > 0) {
                lastSaveTime = versions[0].timestamp;
                this.lastModifiedTime.set(file.path, lastSaveTime);
            }
        }

        if (lastSaveTime) {
            const relativeTime = this.getRelativeTime(lastSaveTime);
            this.statusBarItem.setText(`上次保存: ${relativeTime}`);
            this.statusBarItem.title = `上次保存于 ${new Date(lastSaveTime).toLocaleString('zh-CN')}. 点击可快速对比。`;
        } else {
            this.statusBarItem.setText('⏱ 版本控制: 已启用');
            this.statusBarItem.title = '当前文件无历史版本。点击可快速对比。';
        }
    }

    async quickDiffFromStatusBar() {
        if (!this.settings.enableStatusBarDiff) return;
        
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
            window.clearInterval(this.autoSaveTimer);
        }
        
        if (this.settings.autoSaveOnInterval) {
            this.autoSaveTimer = window.setInterval(() => {
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
            
            const versions = await this.getAllVersions(file.path);
            let lastContent = '';
            if (versions.length > 0) {
                const latestVersion = versions[0];
                const currentHash = this.hashContent(content);
                if (latestVersion.hash === currentHash) {
                    return;
                }
                lastContent = await this.getVersionContent(file.path, latestVersion.id);
            }

            if (content === lastContent) {
                return;
            }

            const changeCount = this.countChanges(lastContent, content);
            if (changeCount < this.settings.autoSaveMinChanges) {
                return;
            }

            await this.createVersion(file, '[Auto Save]', false);
            
        } catch (error) {
            console.error('自动保存失败:', error);
        }
    }

    countChanges(oldText: string, newText: string): number {
        const changes = Diff.diffChars(oldText, newText);
        let changeCount = 0;
        for (const part of changes) {
            if (part.added || part.removed) {
                changeCount += part.value.length;
            }
        }
        return changeCount;
    }

    async handleFileSwitch() {
        const currentFile = this.app.workspace.getActiveFile();
        
        if (this.previousActiveFile && this.previousActiveFile !== currentFile) {
            const fileStillExists = this.app.vault.getAbstractFileByPath(this.previousActiveFile.path);
            
            if (fileStillExists) {
                const pendingSave = this.pendingSaves.get(this.previousActiveFile.path);
                if (pendingSave) {
                    clearTimeout(pendingSave);
                    this.pendingSaves.delete(this.previousActiveFile.path);
                    
                    try {
                        await this.autoSaveFile(this.previousActiveFile as TFile);
                    } catch (error) {
                        console.error('切换文件时自动保存失败:', error);
                    }
                }
            } else {
                this.pendingSaves.delete(this.previousActiveFile.path);
                this.lastModifiedTime.delete(this.previousActiveFile.path);
            }
        }
        
        this.previousActiveFile = currentFile;
    }

    async saveCurrentFileOnFocusLost() {
        const file = this.app.workspace.getActiveFile();
        if (!file || this.isExcluded(file.path)) return;
    
        const fileStillExists = this.app.vault.getAbstractFileByPath(file.path);
        if (!fileStillExists) return;
    
        const pendingSave = this.pendingSaves.get(file.path);
        if (pendingSave) {
            clearTimeout(pendingSave);
            this.pendingSaves.delete(file.path);
        }
        
        try {
            await this.autoSaveFile(file);
        } catch (error) {
            console.error('失去焦点时自动保存失败:', error);
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
        }).open();
    }

    async createVersion(file: TFile, message: string, showNotification: boolean = false, tags: string[] = []) {
        try {
            const content = await this.app.vault.read(file);
            const timestamp = Date.now();
            const id = `${timestamp}-${Math.random().toString(36).substring(2, 9)}`;
            const hash = this.hashContent(content);
            
            const versionFile = await this.loadVersionFile(file.path);
            
            if (this.settings.enableDeduplication) {
                const latestVersion = versionFile.versions[0];
                if (latestVersion && latestVersion.hash === hash) {
                     if (showNotification && this.settings.showNotifications) {
                        new Notice('ℹ️ 内容未变化,跳过创建版本');
                    }
                    return;
                }
            }

            let newVersion: VersionData;

            let addedLines = 0;
            let removedLines = 0;
            if (versionFile.versions.length > 0) {
                const previousContent = await this.getVersionContent(file.path, versionFile.versions[0].id);
                const diffResult = Diff.diffLines(previousContent, content);
                diffResult.forEach(part => {
                    if (part.added) addedLines += part.count || 0;
                    if (part.removed) removedLines += part.count || 0;
                });
            } else {
                addedLines = content.split('\n').length;
            }

            if (this.settings.enableIncrementalStorage && versionFile.versions.length > 0) {
                const hasNoBase = (versionFile.baseVersion === undefined || versionFile.baseVersion === null);
                const shouldRebuildBase = hasNoBase || 
                    (versionFile.versions.length % this.settings.rebuildBaseInterval === 0);
                
                if (shouldRebuildBase) {
                    newVersion = {
                        id, timestamp, message, content, size: content.length, hash,
                        tags: tags.length > 0 ? tags : undefined,
                        starred: false, addedLines, removedLines
                    };
                    versionFile.baseVersion = content;
                } else {
                    const baseContent = versionFile.baseVersion || await this.reconstructLatestFullContent(versionFile);
                    const diff = this.createDiff(baseContent, content);
                    
                    newVersion = {
                        id, timestamp, message, diff, 
                        baseVersionId: versionFile.versions[0].id, 
                        size: diff.length, hash,
                        tags: tags.length > 0 ? tags : undefined,
                        starred: false, addedLines, removedLines
                    };
                }
            } else {
                newVersion = {
                    id, timestamp, message, content, size: content.length, hash,
                    tags: tags.length > 0 ? tags : undefined,
                    starred: false, addedLines, removedLines
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

            this.lastModifiedTime.set(file.path, timestamp);
            this.updateStatusBar();
            
            if (showNotification && this.settings.showNotifications) {
                new Notice(`✅ 版本已创建: ${message}`);
            }
        } catch (error) {
            console.error('创建版本失败:', error);
            new Notice('❌ 创建版本失败,请查看控制台');
        }
    }

    async reconstructLatestFullContent(versionFile: VersionFile): Promise<string> {
        if (versionFile.versions.length === 0) return "";
        return this.getVersionContent(versionFile.filePath, versionFile.versions[0].id);
    }

    createDiff(oldContent: string, newContent: string): string {
        const changes = Diff.createPatch('file', oldContent, newContent, '', '');
        return changes;
    }

    applyDiff(baseContent: string, diffStr: string): string {
        try {
            const result = Diff.applyPatch(baseContent, diffStr);
            if (result === false) {
                 console.error('应用差异补丁失败 (applyPatch returned false). 返回基础内容。');
                 new Notice('应用差异补丁失败，版本内容可能不完整。');
                 return baseContent;
            }
            return result;
        } catch (error) {
            console.error('应用差异时捕获到异常:', error);
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

        const starredVersions = versionsToKeep.filter(v => v.starred);
        let nonStarredVersions = versionsToKeep.filter(v => !v.starred);

        if (this.settings.enableMaxVersions) {
            const maxNonStarred = Math.max(this.settings.maxVersions - starredVersions.length, 10);
            nonStarredVersions = nonStarredVersions.slice(0, maxNonStarred);
        }

        if (this.settings.enableMaxDays) {
            const cutoffTime = Date.now() - (this.settings.maxDays * 24 * 60 * 60 * 1000);
            nonStarredVersions = nonStarredVersions.filter(v => v.timestamp >= cutoffTime);
        }

        versionsToKeep = [...starredVersions, ...nonStarredVersions].sort((a, b) => b.timestamp - a.timestamp);

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
                let content: string;
                
                if (this.settings.enableCompression) {
                    try {
                        const rawData = await adapter.readBinary(versionPath);
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
            const dataToSave: any = {
                filePath: versionFile.filePath,
                versions: versionFile.versions,
                lastModified: versionFile.lastModified,
            };

            if (versionFile.baseVersion !== undefined) {
                dataToSave.baseVersion = versionFile.baseVersion;
            }
            
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
                throw new Error(`版本 ${versionId} 不存在`);
            }
    
            if (version.content !== undefined && version.content !== null) {
                return version.content;
            }
    
            if (version.diff) {
                if (versionFile.baseVersion !== undefined && versionFile.baseVersion !== null) {
                    try {
                        return this.applyDiff(versionFile.baseVersion, version.diff);
                    } catch (error) {
                        console.warn('从基准版本应用差异失败，尝试使用 baseVersionId:', error);
                    }
                }
                
                if (version.baseVersionId) {
                    try {
                        const baseVersionContent = await this.getVersionContent(filePath, version.baseVersionId);
                        return this.applyDiff(baseVersionContent, version.diff);
                    } catch (error) {
                        console.error('从 baseVersionId 应用差异失败:', error);
                    }
                }
            }
    
            throw new Error(`无法获取版本 ${versionId} 的内容：缺少 content 和有效的 diff`);
        } catch (error) {
            console.error('读取版本内容失败:', error);
            throw new Error(`无法读取版本内容: ${error.message}`);
        }
    }

    async verifyVersionFileIntegrity(filePath: string): Promise<boolean> {
        try {
            const versionFile = await this.loadVersionFile(filePath);
            
            if (!versionFile.versions || !Array.isArray(versionFile.versions)) {
                console.error('版本文件结构无效');
                return false;
            }
            
            if (this.settings.enableIncrementalStorage) {
                let hasFullVersion = false;
                
                for (const version of versionFile.versions) {
                    if (version.content !== undefined) {
                        hasFullVersion = true;
                    }
                    
                    if (version.diff && !version.content) {
                        if (!version.baseVersionId && !versionFile.baseVersion) {
                            console.error(`版本 ${version.id} 缺少基准引用`);
                            return false;
                        }
                    }
                }
                
                if (!hasFullVersion && versionFile.versions.length > 0) {
                    console.warn('警告：没有找到完整版本，可能导致恢复失败');
                }
            }
            
            return true;
        } catch (error) {
            console.error('验证版本文件完整性失败:', error);
            return false;
        }
    }

    async updateVersionTags(filePath: string, versionId: string, tags: string[]) {
        try {
            const versionFile = await this.loadVersionFile(filePath);
            const index = versionFile.versionIndex?.get(versionId);
            if (index !== undefined) {
                versionFile.versions[index].tags = tags.length > 0 ? tags : undefined;
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
                versionFile.versions[index].note = note.trim() || undefined;
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
            
            const isBaseForOthers = versionFile.versions.some(v => v.baseVersionId === versionId);
            if (isBaseForOthers) {
                new Notice('❌ 无法删除此版本，因为它被其他增量版本所依赖。', 7000);
                return;
            }

            versionFile.versions = versionFile.versions.filter(v => v.id !== versionId);
            versionFile.lastModified = Date.now();
            this.buildVersionIndex(versionFile);
            await this.saveVersionFile(filePath, versionFile);
            this.versionCache.set(filePath, versionFile);
            this.refreshVersionHistoryView();
        } catch (error) {
            console.error('删除版本失败:', error);
        }
    }

    async deleteVersions(filePath: string, versionIds: string[]) {
        try {
            const versionFile = await this.loadVersionFile(filePath);
            const idsSet = new Set(versionIds);
            
            const remainingVersions = versionFile.versions.filter(v => !idsSet.has(v.id));
            const isAnyDeletedVersionADependency = remainingVersions.some(v => v.baseVersionId && idsSet.has(v.baseVersionId));

            if (isAnyDeletedVersionADependency) {
                new Notice('❌ 批量删除失败：选中的版本中包含其他版本的依赖项。', 7000);
                return;
            }

            versionFile.versions = remainingVersions;
            versionFile.lastModified = Date.now();
            this.buildVersionIndex(versionFile);
            await this.saveVersionFile(filePath, versionFile);
            this.versionCache.set(filePath, versionFile);
            this.refreshVersionHistoryView();
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
                        
                        const filePath = file.replace(this.settings.versionFolder + '/', '').replace('.json', '');
                        const versionFile = await this.loadVersionFile(filePath);
                        
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
                        const stat = await adapter.stat(file);
                        const fileSize = stat?.size || 0;
                        totalSize += fileSize;
                        
                        let versionFile: VersionFile;
                        
                        if (this.settings.enableCompression) {
                            try {
                                const rawData = await adapter.readBinary(file);
                                const decompressed = pako.ungzip(new Uint8Array(rawData), { to: 'string' });
                                versionFile = JSON.parse(decompressed) as VersionFile;
                            } catch (e) {
                                const content = await adapter.read(file);
                                versionFile = JSON.parse(content) as VersionFile;
                            }
                        } else {
                            const content = await adapter.read(file);
                            versionFile = JSON.parse(content) as VersionFile;
                        }
                        
                        if (versionFile.versions && Array.isArray(versionFile.versions)) {
                            versionCount += versionFile.versions.length;
                            
                            versionFile.versions.forEach(v => {
                                if (v.content) {
                                    totalOriginalSize += v.content.length;
                                } else if (v.diff) {
                                    totalOriginalSize += v.diff.length;
                                }
                                
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
            const exportPath = `${this.settings.versionFolder}/export_${this.sanitizeFileName(filePath)}_${Date.now()}.json`;
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
            const exportPath = `${fileName}_v${versionId.substring(0,8)}.md`;
            
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
        if (seconds < 10) return '刚刚';
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

class QuickPreviewModal extends Modal {
    plugin: VersionControlPlugin;
    file: TFile;
    versionId: string;
    
    private isRenderedView: boolean = true;
    private contentContainer: HTMLElement;
    private versionContent: string;
    private toggleButton: HTMLButtonElement;

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
            this.versionContent = await this.plugin.getVersionContent(this.file.path, this.versionId);
            const versions = await this.plugin.getAllVersions(this.file.path);
            const version = versions.find(v => v.id === this.versionId);

            const header = contentEl.createEl('div', { cls: 'preview-header' });
            header.createEl('h2', { text: '📄 快速预览' });
            
            if (version) {
                const info = header.createEl('div', { cls: 'preview-info' });
                info.createEl('span', { text: `⏰ ${this.plugin.formatTime(version.timestamp)}`, cls: 'preview-time' });
                info.createEl('span', { text: `💬 ${version.message}`, cls: 'preview-message' });
                info.createEl('span', { text: `📦 ${this.plugin.formatFileSize(version.size)}`, cls: 'preview-size' });
            }

            const toolbar = contentEl.createEl('div', { cls: 'preview-toolbar' });
            
            this.toggleButton = toolbar.createEl('button', { text: '👓 切换原始文本' });
            this.toggleButton.addEventListener('click', () => {
                this.isRenderedView = !this.isRenderedView;
                this.renderContent();
            });

            const copyBtn = toolbar.createEl('button', { text: '📋 复制内容', cls: 'mod-cta' });
            copyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(this.versionContent).then(() => {
                    new Notice('✅ 内容已复制到剪贴板');
                }).catch(() => {
                    new Notice('❌ 复制失败');
                });
            });

            const restoreBtn = toolbar.createEl('button', { text: '↩️ 恢复此版本' });
            restoreBtn.addEventListener('click', async () => {
                this.close();
                await this.plugin.restoreVersion(this.file, this.versionId);
            });

            const compareBtn = toolbar.createEl('button', { text: '🔀 详细对比' });
            compareBtn.addEventListener('click', () => {
                this.close();
                new DiffModal(this.app, this.plugin, this.file, this.versionId).open();
            });

            const exportBtn = toolbar.createEl('button', { text: '💾 导出文件' });
            exportBtn.addEventListener('click', async () => {
                await this.plugin.exportVersionAsFile(this.file.path, this.versionId);
            });

            this.contentContainer = contentEl.createEl('div', { cls: 'preview-content-container' });
            
            this.renderContent();

            const statsBar = contentEl.createEl('div', { cls: 'preview-stats-bar' });
            const lines = this.versionContent.split('\n');
            statsBar.createEl('span', { text: `📝 ${lines.length} 行` });
            statsBar.createEl('span', { text: `🔤 ${this.versionContent.length} 字符` });
            const words = this.versionContent.split(/\s+/).filter(w => w.length > 0).length;
            statsBar.createEl('span', { text: `📄 ${words} 词` });

        } catch (error) {
            contentEl.createEl('p', { text: '❌ 加载预览失败' });
            console.error('预览加载失败:', error);
        }
    }

    async renderContent() {
        this.contentContainer.empty();

        if (this.isRenderedView) {
            this.toggleButton.setText('👓 切换原始文本');
            const renderDiv = this.contentContainer.createEl('div', { cls: 'preview-rendered-content' });
            await MarkdownRenderer.renderMarkdown(this.versionContent, renderDiv, this.file.path, this.plugin);
        } else {
            this.toggleButton.setText('📖 切换渲染视图');
            const rawContainer = this.contentContainer.createEl('div', { cls: 'preview-raw-container' });
            
            const lines = this.versionContent.split('\n');
            const lineNumbers = rawContainer.createEl('div', { cls: 'preview-line-numbers' });
            lines.forEach((_, index) => {
                lineNumbers.createEl('div', { text: String(index + 1), cls: 'line-number' });
            });
            
            const pre = rawContainer.createEl('pre');
            pre.createEl('code', { text: this.versionContent });
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

    async onClose() {
        // No timer to clear
    }

    updateRelativeTimes() {
        if (!this.plugin.settings.useRelativeTime) return;

        const container = this.containerEl.children[1] as HTMLElement;
        if (!container) return;

        const timeElements = container.findAll('.version-time');

        timeElements.forEach(el => {
            const timestampStr = el.dataset.timestamp;
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

        if (versionDate.getTime() === today.getTime()) {
            return '今天';
        }
        if (versionDate.getTime() === yesterday.getTime()) {
            return '昨天';
        }
        if (now.getFullYear() === date.getFullYear() && now.getMonth() === date.getMonth()) {
            return '本月';
        }
        if (now.getFullYear() === date.getFullYear()) {
            return `${date.getMonth() + 1}月`;
        }
        return `${date.getFullYear()}年`;
    }

    async calculateDiffStatsForVersion(versionFile: VersionFile, versionId: string) {
        const versionIndex = versionFile.versionIndex?.get(versionId);
        if (versionIndex === undefined) return;
        
        const version = versionFile.versions[versionIndex];
    
        if (typeof version.addedLines === 'number' && typeof version.removedLines === 'number') {
            return;
        }
    
        try {
            const currentContent = await this.plugin.getVersionContent(versionFile.filePath, version.id);
            const previousVersion = versionFile.versions[versionIndex + 1];
            
            let added = 0;
            let removed = 0;
    
            if (previousVersion) {
                const previousContent = await this.plugin.getVersionContent(versionFile.filePath, previousVersion.id);
                const diffResult = Diff.diffLines(previousContent, currentContent);
                diffResult.forEach(part => {
                    if (part.added) added += part.count || 0;
                    if (part.removed) removed += part.count || 0;
                });
            } else {
                added = currentContent.split('\n').length;
            }
    
            version.addedLines = added;
            version.removedLines = removed;
    
        } catch (error) {
            console.error(`计算版本 ${version.id} 的差异统计失败:`, error);
            version.addedLines = 0;
            version.removedLines = 0;
        }
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

        const fileStats = header.createEl('div', { cls: 'version-file-stats' });
        try {
            const currentContent = await this.app.vault.read(file);
            const stat = await this.app.vault.adapter.stat(file.path);
            fileStats.createEl('span', { 
                text: `📄 大小: ${this.plugin.formatFileSize(currentContent.length)}`,
                cls: 'file-stat-item'
            });
            if (stat) {
                fileStats.createEl('span', { 
                    text: `📅 修改: ${new Date(stat.mtime).toLocaleString('zh-CN')}`,
                    cls: 'file-stat-item'
                });
            }
        } catch (error) {
            console.error('获取文件信息失败:', error);
        }

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

        const refreshBtn = actions.createEl('button', {
            text: '刷新',
            attr: { title: '手动刷新版本列表' }
        });
        refreshBtn.addEventListener('click', () => {
            new Notice('正在刷新...');
            this.plugin.versionCache.delete(file.path);
            this.refresh();
        });

        const createBtn = actions.createEl('button', { 
            text: '+ 创建',
            cls: 'mod-cta'
        });
        createBtn.addEventListener('click', () => {
            this.plugin.createManualVersion();
        });

        const moreBtn = actions.createEl('button', { 
            text: '更多',
            attr: { title: '更多操作' }
        });
        moreBtn.addEventListener('click', (e) => {
            const menu = new Menu();
            menu.addItem((item) =>
                item.setTitle('📊 查看统计')
                    .setIcon('bar-chart')
                    .onClick(() => {
                        this.showDetailedStats();
                    })
            );
            menu.addItem((item) =>
                item.setTitle('📥 导出版本数据')
                    .setIcon('download')
                    .onClick(() => {
                        this.plugin.exportVersions(file.path);
                    })
            );
            menu.addItem((item) =>
                item.setTitle('📂 创建全库版本')
                    .setIcon('folder')
                    .onClick(() => {
                        this.plugin.createFullSnapshot();
                    })
            );
            menu.addItem((item) =>
                item.setTitle('🗑️ 清理旧版本')
                    .setIcon('trash')
                    .onClick(async () => {
                        await this.cleanupOldVersions(file);
                    })
            );
            menu.showAtMouseEvent(e as MouseEvent);
        });

        const versionFile = await this.plugin.loadVersionFile(file.path);
        const allVersions = versionFile.versions;
        this.totalVersions = allVersions.length;

        if (this.totalVersions === 0) {
            this.renderEmptyState(container, '暂无版本历史');
            return;
        }

        if (allVersions.length > 0) {
            try {
                const currentContent = await this.app.vault.read(file);
                const lastVersion = allVersions[0];
                const lastContent = await this.plugin.getVersionContent(file.path, lastVersion.id);
                
                if (currentContent !== lastContent) {
                    const diffResult = Diff.diffLines(lastContent, currentContent);
                    let added = 0;
                    let removed = 0;
                    diffResult.forEach(part => {
                        if (part.added) added += part.count || 0;
                        if (part.removed) removed += part.count || 0;
                    });
                    
                    const diffBanner = container.createEl('div', { cls: 'version-diff-banner' });
                    diffBanner.createEl('span', { text: '⚠️ 文件已修改' });
                    diffBanner.createEl('span', { 
                        text: `+${added} -${removed}`,
                        cls: 'diff-stats'
                    });
                    
                    const quickSaveBtn = diffBanner.createEl('button', { 
                        text: '💾 立即保存',
                        cls: 'mod-cta'
                    });
                    quickSaveBtn.addEventListener('click', () => {
                        this.plugin.createManualVersion();
                    });

                    const viewDiffBtn = diffBanner.createEl('button', { 
                        text: '👁️ 查看差异'
                    });
                    viewDiffBtn.addEventListener('click', () => {
                        new DiffModal(this.app, this.plugin, file, lastVersion.id).open();
                    });
                }
            } catch (error) {
                console.error('检查文件差异失败:', error);
            }
        }

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

        const perPage = this.plugin.settings.versionsPerPage > 0 ? this.plugin.settings.versionsPerPage : filteredVersions.length;
        const totalPages = Math.ceil(filteredVersions.length / perPage);
        const start = this.currentPage * perPage;
        const end = Math.min(start + perPage, filteredVersions.length);
        const pageVersions = filteredVersions.slice(start, end);

        let statsChanged = false;
        const calculationPromises = pageVersions
            .filter(version => typeof version.addedLines !== 'number' || typeof version.removedLines !== 'number')
            .map(version => {
                statsChanged = true;
                return this.calculateDiffStatsForVersion(versionFile, version.id);
            });
        
        if (calculationPromises.length > 0) {
            await Promise.all(calculationPromises);
        }

        if (statsChanged) {
            await this.plugin.saveVersionFile(file.path, versionFile);
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

        const groupedVersions: { [key: string]: VersionData[] } = {};
        pageVersions.forEach(version => {
            const group = this.getRelativeDateGroup(version.timestamp);
            if (!groupedVersions[group]) {
                groupedVersions[group] = [];
            }
            groupedVersions[group].push(version);
        });

        for (const groupName in groupedVersions) {
            listContainer.createEl('h4', { text: groupName, cls: 'version-group-header' });
            
            const versionsInGroup = groupedVersions[groupName];
            for (const version of versionsInGroup) {
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

                const info = item.createEl('div', { cls: 'version-info' });
                
                const timeRow = info.createEl('div', { cls: 'version-time-row' });
                
                const starBtn = timeRow.createEl('span', { 
                    text: version.starred ? '⭐' : '☆',
                    cls: 'version-star-btn'
                });
                starBtn.addEventListener('click', async () => {
                    await this.plugin.toggleVersionStar(file.path, version.id);
                });
                
                const timeEl = timeRow.createEl('span', { 
                    text: this.plugin.formatTime(version.timestamp),
                    cls: 'version-time'
                });
                timeEl.dataset.timestamp = String(version.timestamp);
                
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
                
                if (version.note) {
                    info.createEl('div', { 
                        text: `📝 ${version.note}`,
                        cls: 'version-note'
                    });
                }
                
                const statsRow = info.createEl('div', { cls: 'version-stats-row' });
                statsRow.createEl('span', { 
                    text: this.plugin.formatFileSize(version.size),
                    cls: 'version-size'
                });

                const diffStatsContainer = statsRow.createEl('div', { cls: 'version-diff-stats' });
                if (typeof version.addedLines === 'number' && typeof version.removedLines === 'number') {
                    const totalChanges = version.addedLines + version.removedLines;
                    if (totalChanges > 0) {
                        const addedWidth = (version.addedLines / totalChanges) * 100;
                        const removedWidth = (version.removedLines / totalChanges) * 100;
                        
                        const bar = diffStatsContainer.createEl('div', { cls: 'diff-stats-bar' });
                        if (version.addedLines > 0) {
                            bar.createEl('div', { cls: 'diff-stats-added', attr: { style: `width: ${addedWidth}%` } });
                        }
                        if (version.removedLines > 0) {
                            bar.createEl('div', { cls: 'diff-stats-removed', attr: { style: `width: ${removedWidth}%` } });
                        }
                        
                        diffStatsContainer.createEl('span', { text: `+${version.addedLines}`, cls: 'diff-stats-text-added' });
                        diffStatsContainer.createEl('span', { text: `-${version.removedLines}`, cls: 'diff-stats-text-removed' });
                        diffStatsContainer.title = `新增 ${version.addedLines} 行, 删除 ${version.removedLines} 行`;
                    } else {
                        diffStatsContainer.setText('无代码变更');
                    }
                } else {
                    diffStatsContainer.setText('计算中...');
                }

                const actions = item.createEl('div', { cls: 'version-actions' });
                
                if (this.plugin.settings.enableQuickPreview) {
                    const previewBtn = actions.createEl('button', { 
                        text: '预览',
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

                const moreBtn = actions.createEl('button', { 
                    text: '更多',
                    cls: 'version-btn'
                });
                moreBtn.addEventListener('click', (e) => {
                    this.showVersionContextMenu(e as MouseEvent, file, version);
                });
            }
        }

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

            pagination.createEl('span', { 
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
                const removed = this.plugin.cleanupVersionsInMemory(versionFile);
                
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
        
        if (this.currentFile && message === '暂无版本历史') {
            const createBtn = empty.createEl('button', { 
                text: '创建第一个版本',
                cls: 'mod-cta'
            });
            createBtn.addEventListener('click', () => {
                this.plugin.createManualVersion();
            });
        }

        if (this.filterTag || this.showStarredOnly || this.searchQuery) {
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
        new VersionSelectModal(this.app, this.plugin, file, firstVersionId, (secondVersionId) => {
            new DiffModal(this.app, this.plugin, file, firstVersionId, secondVersionId).open();
        }).open();
    }
}

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

        const customSection = container.createEl('div', { cls: 'tag-section' });
        customSection.createEl('h3', { text: '自定义标签' });
        
        const inputContainer = customSection.createEl('div', { cls: 'tag-input-container' });
        const input = inputContainer.createEl('input', {
            type: 'text',
            placeholder: '输入新标签...'
        });
        input.style.width = '100%';

        const addBtn = inputContainer.createEl('button', { text: '添加', cls: 'mod-cta' });
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

        const selectedSection = container.createEl('div', { cls: 'tag-section' });
        selectedSection.createEl('h3', { text: '已选标签' });
        const selectedTagsContainer = selectedSection.createEl('div', { cls: 'tag-list' });
        this.renderSelectedTags(selectedTagsContainer);

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

// =======================================================================
// ======================= [START] FINAL DIFFMODAL =========================
// =======================================================================

type ProcessedDiff = {
    type: 'context' | 'added' | 'removed' | 'moved-from' | 'moved-to';
    moveId?: number;
} & Diff.Change;

interface MarkdownSection {
    heading: string;
    level: number;
    content: string;
    originalIndex: number;
}

type SectionDiffResult = 
    | { type: 'unchanged'; left: MarkdownSection; right: MarkdownSection }
    | { type: 'modified'; left: MarkdownSection; right: MarkdownSection; diff: ProcessedDiff[] }
    | { type: 'added'; section: MarkdownSection }
    | { type: 'removed'; section: MarkdownSection };

class DiffModal extends Modal {
    plugin: VersionControlPlugin;
    file: TFile;
    versionId: string;
    secondVersionId: string;
    currentDiffIndex: number = 0;
    totalDiffs: number = 0;
    diffElements: HTMLElement[] = [];
    collapsedSections: Set<number> = new Set();
    ignoreWhitespace: boolean = false;
    showLineNumbers: boolean = true;
    wrapLines: boolean = true;
    leftContent: string = '';
    rightContent: string = '';
    currentGranularity: 'char' | 'word' | 'line';
    // 【修复】默认不开启“仅显示变更”
    showOnlyChanges: boolean = false;
    enableMoveDetection: boolean = true;
    showWhitespace: boolean = false;

    private currentView: 'text' | 'rendered' | 'structured' = 'text';
    private textDiffContainer: HTMLElement;
    private renderedDiffContainer: HTMLElement;
    private structuredDiffContainer: HTMLElement;
    private isRenderedViewBuilt: boolean = false;
    private isStructuredViewBuilt: boolean = false;
    private allVersions: VersionData[] = [];
    private infoBannerContainer: HTMLElement;

    constructor(app: App, plugin: VersionControlPlugin, file: TFile, versionId: string, secondVersionId?: string) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.versionId = versionId;
        this.secondVersionId = secondVersionId || 'current';
        this.currentGranularity = this.plugin.settings.diffGranularity;
    }

    processDiffForMoves(diffResult: Diff.Change[]): ProcessedDiff[] {
        const processed: ProcessedDiff[] = diffResult.map(part => ({ ...part, type: part.added ? 'added' : part.removed ? 'removed' : 'context' }));

        const removed = new Map<string, number[]>();
        const added = new Map<string, number[]>();

        processed.forEach((part, index) => {
            if (part.removed) {
                const key = part.value.trim();
                if (!removed.has(key)) removed.set(key, []);
                removed.get(key)!.push(index);
            } else if (part.added) {
                const key = part.value.trim();
                if (!added.has(key)) added.set(key, []);
                added.get(key)!.push(index);
            }
        });

        let moveIdCounter = 0;
        for (const [key, removedIndices] of removed.entries()) {
            if (added.has(key)) {
                const addedIndices = added.get(key)!;
                const pairs = Math.min(removedIndices.length, addedIndices.length);

                for (let i = 0; i < pairs; i++) {
                    const removedIndex = removedIndices.shift()!;
                    const addedIndex = addedIndices.shift()!;
                    
                    processed[removedIndex].type = 'moved-from';
                    processed[removedIndex].moveId = moveIdCounter;
                    
                    processed[addedIndex].type = 'moved-to';
                    processed[addedIndex].moveId = moveIdCounter;
                    
                    moveIdCounter++;
                }
            }
        }

        return processed;
    }

    visualizeWhitespace(text: string): string {
        return text.replace(/\t/g, '→   ').replace(/ /g, '·');
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.addClass('diff-modal');

        contentEl.createEl('h2', { text: '📊 版本差异对比' });

        const headerContainer = contentEl.createEl('div');
        const mainContainer = contentEl.createEl('div', { cls: 'diff-main-container' });
        this.textDiffContainer = mainContainer.createEl('div', { cls: 'diff-container' });
        this.renderedDiffContainer = mainContainer.createEl('div', { cls: 'rendered-diff-container', attr: { style: 'display: none;' } });
        this.structuredDiffContainer = mainContainer.createEl('div', { cls: 'structured-diff-container', attr: { style: 'display: none;' } });

        this.addMobileInteraction(this.renderedDiffContainer);
        this.addMobileInteraction(this.structuredDiffContainer);

        try {
            this.allVersions = await this.plugin.getAllVersions(this.file.path);
        } catch (error) {
            new Notice('❌ 加载版本列表失败');
            this.close();
            return;
        }

        this.renderVersionSelectors(headerContainer);
        
        this.infoBannerContainer = headerContainer.createEl('div', { cls: 'diff-info-banner-compact' });

        const toolbar = headerContainer.createEl('div', { cls: 'diff-toolbar-redesigned' });
        
        const viewSwitcher = toolbar.createEl('div', { cls: 'diff-view-switcher' });
        const textDiffBtn = viewSwitcher.createEl('button', { text: '文本', cls: 'active' });
        const renderedDiffBtn = viewSwitcher.createEl('button', { text: '渲染' });
        const structuredDiffBtn = viewSwitcher.createEl('button', { text: '结构' });

        const navGroup = toolbar.createEl('div', { cls: 'diff-toolbar-group' });
        const firstDiffBtn = navGroup.createEl('button', { text: '«', attr: { 'aria-label': '第一个差异' } });
        const prevBtn = navGroup.createEl('button', { text: '‹', attr: { 'aria-label': '上一个差异 (↑)' } });
        const statsEl = navGroup.createEl('span', { cls: 'diff-stats' });
        const nextBtn = navGroup.createEl('button', { text: '›', attr: { 'aria-label': '下一个差异 (↓)' } });
        const lastDiffBtn = navGroup.createEl('button', { text: '»', attr: { 'aria-label': '最后一个差异' } });
        
        const spacer = toolbar.createEl('div');
        spacer.style.flexGrow = '1';

        const actionsGroup = toolbar.createEl('div', { cls: 'diff-toolbar-group' });
        const actionsBtn = actionsGroup.createEl('button', { text: '操作 ...', attr: { 'aria-label': '更多操作' } });
        actionsBtn.addEventListener('click', (e) => {
            const menu = new Menu();
            menu.addItem(item => item.setTitle('🔍 搜索').setIcon('search').onClick(() => this.showSearchBox()));
            menu.addItem(item => item.setTitle('📋 复制差异').setIcon('copy').onClick(() => this.copyDiffToClipboard()));
            menu.addItem(item => item.setTitle('💾 导出报告').setIcon('download').onClick(() => this.exportDiffReport()));
            menu.addItem(item => item.setTitle('📊 查看统计').setIcon('bar-chart').onClick(() => this.showDetailedStats()));
            menu.showAtMouseEvent(e as MouseEvent);
        });

        const settingsGroup = toolbar.createEl('div', { cls: 'diff-toolbar-group' });
        const settingsBtn = settingsGroup.createEl('button', { text: '设置 ⚙️', attr: { 'aria-label': '视图设置' } });
        settingsBtn.addEventListener('click', (e) => {
            const menu = new Menu();
            
            menu.addItem(item => item.setTitle('差异粒度').setDisabled(true));
            menu.addItem(item => item.setTitle('字符').setChecked(this.currentGranularity === 'char').onClick(() => this.updateGranularity('char')));
            menu.addItem(item => item.setTitle('单词').setChecked(this.currentGranularity === 'word').onClick(() => this.updateGranularity('word')));
            menu.addItem(item => item.setTitle('行').setChecked(this.currentGranularity === 'line').onClick(() => this.updateGranularity('line')));

            menu.addSeparator();
            menu.addItem(item => item.setTitle('视图模式').setDisabled(true));
            const modeSelect = this.containerEl.querySelector('.diff-select[aria-label="视图模式"]') as HTMLSelectElement;
            menu.addItem(item => item.setTitle('统一视图').setChecked(modeSelect.value === 'unified').onClick(() => { modeSelect.value = 'unified'; modeSelect.dispatchEvent(new Event('change')); }));
            menu.addItem(item => item.setTitle('左右分栏').setChecked(modeSelect.value === 'split').onClick(() => { modeSelect.value = 'split'; modeSelect.dispatchEvent(new Event('change')); }));

            menu.addSeparator();

            menu.addItem(item => item.setTitle('自动换行').setChecked(this.wrapLines).onClick(() => { this.wrapLines = !this.wrapLines; this.renderTextDiff(); }));
            menu.addItem(item => item.setTitle('显示行号').setChecked(this.showLineNumbers).onClick(() => { this.showLineNumbers = !this.showLineNumbers; this.renderTextDiff(); }));
            menu.addItem(item => item.setTitle('忽略空白').setChecked(this.ignoreWhitespace).onClick(() => { this.ignoreWhitespace = !this.ignoreWhitespace; this.renderTextDiff(); }));
            menu.addItem(item => item.setTitle('显示空白').setChecked(this.showWhitespace).onClick(() => { this.showWhitespace = !this.showWhitespace; this.renderTextDiff(); }));
            menu.addItem(item => item.setTitle('检测移动').setChecked(this.enableMoveDetection).onClick(() => { this.enableMoveDetection = !this.enableMoveDetection; this.renderTextDiff(); }));
            menu.addItem(item => item.setTitle('仅显示变更').setChecked(this.showOnlyChanges).onClick(() => { this.showOnlyChanges = !this.showOnlyChanges; this.renderTextDiff(); }));

            menu.addSeparator();
            menu.addItem(item => item.setTitle('展开所有').setIcon('chevrons-down-up').onClick(() => { this.collapsedSections.clear(); this.renderTextDiff(); }));
            menu.addItem(item => item.setTitle('折叠所有').setIcon('chevrons-up-down').onClick(() => {
                const collapseBtns = this.textDiffContainer.querySelectorAll('.diff-collapse-btn');
                collapseBtns.forEach((btn, idx) => this.collapsedSections.add(idx as number));
                this.renderTextDiff();
            }));

            menu.showAtMouseEvent(e as MouseEvent);
        });
        
        const modeSelect = headerContainer.createEl('select', { cls: 'diff-select', attr: { 'aria-label': '视图模式', 'style': 'display: none;' } });
        modeSelect.createEl('option', { text: '统一视图', value: 'unified' });
        modeSelect.createEl('option', { text: '左右分栏', value: 'split' });
        modeSelect.value = this.plugin.settings.diffViewMode;
        modeSelect.addEventListener('change', () => { this.collapsedSections.clear(); this.renderTextDiff(); });

        const switchView = (view: 'text' | 'rendered' | 'structured') => {
            this.currentView = view;
            
            textDiffBtn.toggleClass('active', view === 'text');
            renderedDiffBtn.toggleClass('active', view === 'rendered');
            structuredDiffBtn.toggleClass('active', view === 'structured');

            this.textDiffContainer.style.display = view === 'text' ? '' : 'none';
            this.renderedDiffContainer.style.display = view === 'rendered' ? '' : 'none';
            this.structuredDiffContainer.style.display = view === 'structured' ? '' : 'none';

            const showTextToolbar = view === 'text';
            [navGroup, actionsGroup, settingsGroup].forEach(g => g.style.display = showTextToolbar ? 'flex' : 'none');

            if (view === 'rendered' && !this.isRenderedViewBuilt) { this.renderRenderedView(); this.isRenderedViewBuilt = true; }
            if (view === 'structured' && !this.isStructuredViewBuilt) { this.renderStructuredDiff(); this.isStructuredViewBuilt = true; }
        };

        textDiffBtn.addEventListener('click', () => switchView('text'));
        renderedDiffBtn.addEventListener('click', () => switchView('rendered'));
        structuredDiffBtn.addEventListener('click', () => switchView('structured'));

        prevBtn.addEventListener('click', () => this.navigateDiff(-1));
        nextBtn.addEventListener('click', () => this.navigateDiff(1));
        firstDiffBtn.addEventListener('click', () => this.navigateDiff('first'));
        lastDiffBtn.addEventListener('click', () => this.navigateDiff('last'));

        this.scope.register([], 'ArrowUp', () => { if (this.currentView === 'text' && !prevBtn.disabled) prevBtn.click(); return false; });
        this.scope.register([], 'ArrowDown', () => { if (this.currentView === 'text' && !nextBtn.disabled) nextBtn.click(); return false; });
        this.scope.register(['Mod'], 'f', (evt) => { if (this.currentView === 'text') { evt.preventDefault(); this.showSearchBox(); } return false; });

        this.textDiffContainer.addEventListener('mouseover', (e) => {
            const target = e.target as HTMLElement;
            const line = target.closest('[data-move-id]') as HTMLElement;
            if (line) {
                const moveId = line.dataset.moveId;
                this.textDiffContainer.querySelectorAll(`[data-move-id="${moveId}"]`).forEach(el => el.addClass('diff-move-highlight'));
            }
        });
        this.textDiffContainer.addEventListener('mouseout', (e) => {
            const target = e.target as HTMLElement;
            const line = target.closest('[data-move-id]') as HTMLElement;
            if (line) {
                const moveId = line.dataset.moveId;
                this.textDiffContainer.querySelectorAll(`[data-move-id="${moveId}"]`).forEach(el => el.removeClass('diff-move-highlight'));
            }
        });

        await this.updateDiffView();
    }

    private addMobileInteraction(container: HTMLElement) {
        let pressTimer: NodeJS.Timeout;

        const startPress = (e: MouseEvent | TouchEvent) => {
            const target = e.target as HTMLElement;
            if (!target || target.tagName === 'A' || target.tagName === 'BUTTON') return;

            pressTimer = setTimeout(() => {
                this.handleViewDoubleClick(e);
                new Notice('长按跳转成功！');
            }, 800);
        };

        const cancelPress = () => {
            clearTimeout(pressTimer);
        };

        container.addEventListener('mousedown', startPress);
        container.addEventListener('mouseup', cancelPress);
        container.addEventListener('mouseleave', cancelPress);
        
        container.addEventListener('touchstart', startPress, { passive: true });
        container.addEventListener('touchend', cancelPress);
        container.addEventListener('touchcancel', cancelPress);

        container.addEventListener('dblclick', this.handleViewDoubleClick.bind(this));
    }

    private handleViewDoubleClick(e: MouseEvent | TouchEvent) {
        e.preventDefault();
        const target = e.target as HTMLElement;
        if (!target) return;

        const textContent = target.textContent?.trim();
        if (!textContent || textContent.length < 3) {
            return;
        }

        const isLeftPanel = target.closest('.rendered-diff-panel:first-child') !== null;
        const isRightPanel = target.closest('.rendered-diff-panel:last-child') !== null;
        const structuredSection = target.closest('.structured-section');

        let sourceContent: string | null = null;
        
        if (this.currentView === 'rendered') {
            if (isLeftPanel) sourceContent = this.leftContent;
            else if (isRightPanel) sourceContent = this.rightContent;
        } else if (this.currentView === 'structured' && structuredSection) {
            const sectionType = structuredSection.className.match(/structured-(added|removed|modified)/);
            if (sectionType) {
                if (sectionType[1] === 'removed') {
                    sourceContent = this.leftContent;
                } else {
                    sourceContent = this.rightContent;
                }
            }
        }

        if (sourceContent) {
            this.findLineAndSwitchToTextView(textContent, sourceContent);
        }
    }

    private findLineAndSwitchToTextView(searchText: string, sourceContent: string) {
        const snippet = searchText.substring(0, 50);
        const matchIndex = sourceContent.indexOf(snippet);

        if (matchIndex === -1) {
            new Notice('ℹ️ 未能定位到源码位置');
            return;
        }

        const precedingText = sourceContent.substring(0, matchIndex);
        const lineNumber = (precedingText.match(/\n/g) || []).length + 1;

        const viewSwitcher = this.containerEl.querySelector('.diff-view-switcher');
        const textBtn = viewSwitcher?.querySelector('button:first-child') as HTMLButtonElement;
        if (textBtn) {
            textBtn.click();
        }

        setTimeout(() => {
            const modeSelect = this.containerEl.querySelector('.diff-select[aria-label="视图模式"]') as HTMLSelectElement;
            let lineEl: HTMLElement | null = null;

            if (modeSelect.value === 'unified') {
                lineEl = this.textDiffContainer.querySelector(`.diff-line[data-line-number-right="${lineNumber}"]`) || this.textDiffContainer.querySelector(`.diff-line[data-line-number-left="${lineNumber}"]`);
            } else {
                lineEl = this.textDiffContainer.querySelector(`.diff-panel .diff-line[data-line-number="${lineNumber}"]`);
            }

            if (lineEl) {
                const highlightedEl = lineEl;
                highlightedEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                highlightedEl.addClass('diff-line-highlight');
                new Notice(`✅ 已定位到源码第 ${lineNumber} 行`);
                setTimeout(() => {
                    highlightedEl.removeClass('diff-line-highlight');
                }, 2000);
            } else {
                new Notice(`ℹ️ 已切换视图，但无法高亮第 ${lineNumber} 行`);
            }
        }, 100);
    }

    updateGranularity(granularity: 'char' | 'word' | 'line') {
        this.currentGranularity = granularity;
        this.collapsedSections.clear();
        this.renderTextDiff();
    }

    navigateDiff(direction: 1 | -1 | 'first' | 'last') {
        if (this.totalDiffs === 0) return;

        if (direction === 'first') {
            this.currentDiffIndex = 0;
        } else if (direction === 'last') {
            this.currentDiffIndex = this.totalDiffs - 1;
        } else {
            const newIndex = this.currentDiffIndex + direction;
            if (newIndex >= 0 && newIndex < this.totalDiffs) {
                this.currentDiffIndex = newIndex;
            }
        }
        this.updateNavState();
        this.scrollToDiff();
    }

    updateNavState() {
        const statsEl = this.containerEl.querySelector('.diff-stats') as HTMLElement;
        const navButtons = this.containerEl.querySelectorAll('.diff-toolbar-group button');
        const [firstBtn, prevBtn, , nextBtn, lastBtn] = Array.from(navButtons) as HTMLButtonElement[];

        if (this.totalDiffs > 0) {
            statsEl.setText(`${this.currentDiffIndex + 1} / ${this.totalDiffs}`);
            prevBtn.disabled = this.currentDiffIndex === 0;
            firstBtn.disabled = this.currentDiffIndex === 0;
            nextBtn.disabled = this.currentDiffIndex >= this.totalDiffs - 1;
            lastBtn.disabled = this.currentDiffIndex >= this.totalDiffs - 1;
        } else {
            statsEl.setText(this.leftContent === this.rightContent ? '✅' : '0/0');
            [firstBtn, prevBtn, nextBtn, lastBtn].forEach(btn => btn.disabled = true);
        }
    }
    
    async applyChanges(content: string, lineNumber: number) {
        if (this.secondVersionId !== 'current') return;

        try {
            const currentContent = await this.app.vault.read(this.file);
            const lines = currentContent.split('\n');
            
            lines.splice(lineNumber, 0, content);
            
            await this.app.vault.modify(this.file, lines.join('\n'));
            new Notice('✅ 已应用更改');
            await this.updateDiffView();
        } catch (error) {
            new Notice('❌ 应用更改失败');
            console.error(error);
        }
    }

    async revertChanges(content: string, lineNumber: number) {
        if (this.secondVersionId !== 'current') return;

        try {
            const currentContent = await this.app.vault.read(this.file);
            let lines = currentContent.split('\n');
            
            if (lines[lineNumber] === content) {
                lines.splice(lineNumber, 1);
            } else {
                const index = lines.indexOf(content);
                if (index > -1) {
                    lines.splice(index, 1);
                } else {
                    throw new Error("无法找到要撤销的行。");
                }
            }
            
            await this.app.vault.modify(this.file, lines.join('\n'));
            new Notice('✅ 已撤销更改');
            await this.updateDiffView();
        } catch (error) {
            new Notice(`❌ 撤销更改失败: ${error.message}`);
            console.error(error);
        }
    }

    async showLineHistory(lineText: string) {
        const notice = new Notice('正在搜索行历史...', 0);
        try {
            const matchingVersions = await this.findVersionsContainingLine(lineText);
            notice.hide();
            if (matchingVersions.length > 0) {
                new LineHistoryModal(this.app, this.plugin, this.file, lineText, matchingVersions).open();
            } else {
                new Notice('未在历史版本中找到该行内容。');
            }
        } catch (error) {
            notice.hide();
            new Notice('❌ 搜索行历史失败');
            console.error(error);
        }
    }

    async findVersionsContainingLine(lineText: string): Promise<VersionData[]> {
        const matchingVersions: VersionData[] = [];
        const allVersions = await this.plugin.getAllVersions(this.file.path);
        
        for (const version of allVersions) {
            try {
                const content = await this.plugin.getVersionContent(this.file.path, version.id);
                if (content.includes(lineText)) {
                    matchingVersions.push(version);
                }
            } catch (e) {
                console.warn(`无法获取版本 ${version.id} 的内容`);
            }
        }
        return matchingVersions;
    }
    
    renderVersionSelectors(container: HTMLElement) {
        const selectorContainer = container.createEl('div', { cls: 'diff-version-selector-container' });

        const leftSelector = selectorContainer.createEl('div', { cls: 'diff-version-selector' });
        leftSelector.createEl('span', { text: '版本 A:', cls: 'diff-selector-label' });
        const leftBtn = leftSelector.createEl('button', { 
            text: '加载中...', 
            cls: 'diff-selector-btn',
            attr: { id: 'diff-left-version-btn' }
        });
        leftBtn.addEventListener('click', (e) => {
            this.showVersionSelectionMenu(e as MouseEvent, 'left');
        });

        const swapBtn = selectorContainer.createEl('button', {
            text: '↔️',
            cls: 'diff-swap-btn',
            attr: { title: '交换对比版本' }
        });
        swapBtn.addEventListener('click', async () => {
            [this.versionId, this.secondVersionId] = [this.secondVersionId, this.versionId];
            await this.updateDiffView();
        });

        const rightSelector = selectorContainer.createEl('div', { cls: 'diff-version-selector' });
        rightSelector.createEl('span', { text: '版本 B:', cls: 'diff-selector-label' });
        const rightBtn = rightSelector.createEl('button', { 
            text: '加载中...', 
            cls: 'diff-selector-btn',
            attr: { id: 'diff-right-version-btn' }
        });
        rightBtn.addEventListener('click', (e) => {
            this.showVersionSelectionMenu(e as MouseEvent, 'right');
        });
    }

    showVersionSelectionMenu(event: MouseEvent, side: 'left' | 'right') {
        const menu = new Menu();
    
        menu.addItem((item) =>
            item
                .setTitle('📄 当前文件')
                .setIcon('file-text')
                .onClick(() => {
                    this.handleVersionChange(side, 'current');
                })
        );
    
        if (this.allVersions.length === 0) {
            menu.addSeparator();
            menu.addItem((item) =>
                item
                    .setTitle('暂无历史版本')
                    .setDisabled(true)
            );
        } else {
            menu.addSeparator();
    
            this.allVersions.forEach((version) => {
                menu.addItem((item) =>
                    item
                        .setTitle(`${this.plugin.formatTime(version.timestamp)} - ${version.message}`)
                        .setIcon('history')
                        .onClick(() => {
                            this.handleVersionChange(side, version.id);
                        })
                );
            });
        }
    
        menu.showAtMouseEvent(event);
    }

    async handleVersionChange(side: 'left' | 'right', newVersionId: string) {
        const currentLeft = this.versionId;
        const currentRight = this.secondVersionId;

        if (side === 'left') {
            if (newVersionId === currentLeft) return;
            if (newVersionId === currentRight) {
                [this.versionId, this.secondVersionId] = [this.secondVersionId, this.versionId];
            } else {
                this.versionId = newVersionId;
            }
        } else {
            if (newVersionId === currentRight) return;
            if (newVersionId === currentLeft) {
                [this.versionId, this.secondVersionId] = [this.secondVersionId, this.versionId];
            } else {
                this.secondVersionId = newVersionId;
            }
        }
        
        await this.updateDiffView();
    }

    async updateDiffView() {
        const loadingNotice = new Notice('正在加载新版本...', 0);
        
        try {
            if (this.versionId === 'current') {
                this.leftContent = await this.app.vault.read(this.file);
            } else {
                this.leftContent = await this.plugin.getVersionContent(this.file.path, this.versionId);
            }

            if (this.secondVersionId === 'current') {
                this.rightContent = await this.app.vault.read(this.file);
            } else {
                this.rightContent = await this.plugin.getVersionContent(this.file.path, this.secondVersionId);
            }

            this.updateSelectorButtonLabels();
            
            this.isRenderedViewBuilt = false;
            this.isStructuredViewBuilt = false;

            if (this.currentView === 'text') {
                this.renderTextDiff();
            } else if (this.currentView === 'rendered') {
                this.renderRenderedView();
                this.isRenderedViewBuilt = true;
            } else if (this.currentView === 'structured') {
                this.renderStructuredDiff();
                this.isStructuredViewBuilt = true;
            }

        } catch (error) {
            console.error("加载差异失败:", error);
            new Notice('❌ 加载版本内容失败');
        } finally {
            loadingNotice.hide();
        }
    }

    updateSelectorButtonLabels() {
        const leftBtn = this.containerEl.querySelector('#diff-left-version-btn') as HTMLButtonElement;
        const rightBtn = this.containerEl.querySelector('#diff-right-version-btn') as HTMLButtonElement;

        if (leftBtn) {
            if (this.versionId === 'current') {
                leftBtn.setText('📄 当前文件');
            } else {
                const version = this.allVersions.find(v => v.id === this.versionId);
                leftBtn.setText(version ? `🕒 ${this.plugin.formatTime(version.timestamp)}` : '未知版本');
            }
        }

        if (rightBtn) {
            if (this.secondVersionId === 'current') {
                rightBtn.setText('📄 当前文件');
            } else {
                const version = this.allVersions.find(v => v.id === this.secondVersionId);
                rightBtn.setText(version ? `🕒 ${this.plugin.formatTime(version.timestamp)}` : '未知版本');
            }
        }
    }

    async renderRenderedView() {
        this.renderedDiffContainer.empty();
        
        const leftPanel = this.renderedDiffContainer.createEl('div', { cls: 'rendered-diff-panel' });
        const rightPanel = this.renderedDiffContainer.createEl('div', { cls: 'rendered-diff-panel' });
    
        const leftVersion = this.allVersions.find(v => v.id === this.versionId);
        const rightVersion = this.allVersions.find(v => v.id === this.secondVersionId);
    
        const leftLabel = this.versionId === 'current' ? '当前文件' : (leftVersion ? `版本 A: ${this.plugin.formatTime(leftVersion.timestamp)}` : '版本 A');
        const rightLabel = this.secondVersionId === 'current' ? '当前文件' : (rightVersion ? `版本 B: ${this.plugin.formatTime(rightVersion.timestamp)}` : '版本 B');
    
        leftPanel.createEl('h3', { text: leftLabel });
        rightPanel.createEl('h3', { text: rightLabel });
    
        const leftContentEl = leftPanel.createEl('div', { cls: 'rendered-diff-content' });
        const rightContentEl = rightPanel.createEl('div', { cls: 'rendered-diff-content' });
    
        const diffResult = this.currentGranularity === 'line' 
            ? Diff.diffLines(this.leftContent, this.rightContent)
            : (this.currentGranularity === 'word' 
                ? Diff.diffWordsWithSpace(this.leftContent, this.rightContent) 
                : Diff.diffChars(this.leftContent, this.rightContent));
    
        let leftMarked = '';
        let rightMarked = '';
        const START_DEL = '[[VC-DEL]]'; const END_DEL = '[[/VC-DEL]]';
        const START_ADD = '[[VC-ADD]]'; const END_ADD = '[[/VC-ADD]]';
    
        for (const part of diffResult) {
            const value = part.value;
            if (part.added) {
                rightMarked += START_ADD + value + END_ADD;
            } else if (part.removed) {
                leftMarked += START_DEL + value + END_DEL;
            } else {
                leftMarked += value;
                rightMarked += value;
            }
        }
    
        const tempLeftDiv = createDiv();
        const tempRightDiv = createDiv();
        await MarkdownRenderer.renderMarkdown(leftMarked, tempLeftDiv, this.file.path, this.plugin);
        await MarkdownRenderer.renderMarkdown(rightMarked, tempRightDiv, this.file.path, this.plugin);
    
        let leftHtml = tempLeftDiv.innerHTML;
        let rightHtml = tempRightDiv.innerHTML;
    
        leftHtml = leftHtml.replace(/\[\[VC-DEL\]\]/g, '<span class="diff-rendered-removed">').replace(/\[\[\/VC-DEL\]\]/g, '</span>');
        rightHtml = rightHtml.replace(/\[\[VC-ADD\]\]/g, '<span class="diff-rendered-added">').replace(/\[\[\/VC-ADD\]\]/g, '</span>');
    
        leftContentEl.innerHTML = leftHtml;
        rightContentEl.innerHTML = rightHtml;
    
        let isScrolling = false;
        const syncScroll = (source: HTMLElement, target: HTMLElement) => {
            if (isScrolling) return;
            isScrolling = true;
            target.scrollTop = source.scrollTop;
            setTimeout(() => { isScrolling = false; }, 50);
        };
    
        leftContentEl.addEventListener('scroll', () => syncScroll(leftContentEl, rightContentEl));
        rightContentEl.addEventListener('scroll', () => syncScroll(rightContentEl, leftContentEl));
    }

    renderTextDiff() {
        const container = this.textDiffContainer;
        container.empty();
        this.diffElements = [];
        this.currentDiffIndex = 0;
        this.totalDiffs = 0;
        
        let leftProcessed = this.leftContent;
        let rightProcessed = this.rightContent;
        
        if (this.ignoreWhitespace) {
            leftProcessed = this.leftContent.replace(/\s+/g, ' ').trim();
            rightProcessed = this.rightContent.replace(/\s+/g, ' ').trim();
        }
        
        if (!leftProcessed && !rightProcessed) {
            container.createEl('div', { text: '两个版本都是空文件', cls: 'diff-empty-notice' });
            return;
        }
        
        container.toggleClass('show-whitespace-active', this.showWhitespace);
        
        const modeSelect = this.containerEl.querySelector('.diff-select[aria-label="视图模式"]') as HTMLSelectElement;
        if (modeSelect.value === 'unified') {
            container.removeClass('diff-split');
            this.renderUnifiedDiff(container, leftProcessed, rightProcessed, this.currentGranularity);
        } else {
            container.addClass('diff-split');
            const leftLabelEl = this.containerEl.querySelector('#diff-left-version-btn') as HTMLElement;
            const rightLabelEl = this.containerEl.querySelector('#diff-right-version-btn') as HTMLElement;
            this.renderSplitDiff(container, leftProcessed, rightProcessed, this.currentGranularity, leftLabelEl.textContent || '版本 A', rightLabelEl.textContent || '版本 B');
        }

        if (this.wrapLines) container.addClass('diff-wrap-lines');
        else container.removeClass('diff-wrap-lines');

        this.totalDiffs = this.diffElements.length;
        this.updateNavState();
        if (this.totalDiffs > 0) setTimeout(() => this.scrollToDiff(), 100);
        
        this.updateCompactDiffInfo();
        this.plugin.refreshVersionHistoryView();
    }
    
    updateCompactDiffInfo() {
        const container = this.infoBannerContainer;
        if (!container) return;
        container.empty();

        let leftProcessed = this.leftContent;
        let rightProcessed = this.rightContent;
        if (this.ignoreWhitespace) {
            leftProcessed = this.leftContent.replace(/\s+/g, ' ').trim();
            rightProcessed = this.rightContent.replace(/\s+/g, ' ').trim();
        }
        
        const diffResult = Diff.diffLines(leftProcessed, rightProcessed);
        let addedLines = 0;
        let removedLines = 0;
        
        for (const part of diffResult) {
            if (part.added) {
                addedLines += part.count || 0;
            } else if (part.removed) {
                removedLines += part.count || 0;
            }
        }
        
        const totalLines = this.leftContent.split('\n').length;
        const changedLines = addedLines + removedLines;
        const changePercent = totalLines > 0 ? ((changedLines / totalLines) * 100).toFixed(1) : '0';
        
        container.createEl('span', { text: `📊 总行数: ${totalLines}`, cls: 'diff-info-item' });
        container.createEl('span', { text: `+${addedLines}`, cls: 'diff-info-added' });
        container.createEl('span', { text: `-${removedLines}`, cls: 'diff-info-removed' });
        container.createEl('span', { text: `~${changedLines}`, cls: 'diff-info-changed' });
        container.createEl('span', { text: `变化率: ${changePercent}%`, cls: 'diff-info-percent' });

        container.addClass('diff-info-updated');
        setTimeout(() => {
            container.removeClass('diff-info-updated');
        }, 500);
    }

    showDetailedStats() {
        const diffResult = Diff.diffLines(this.leftContent, this.rightContent);
        let addedLines = 0;
        let removedLines = 0;
        let addedChars = 0;
        let removedChars = 0;
        
        for (const part of diffResult) {
            if (part.added) {
                addedLines += (part.value.match(/\n/g) || []).length;
                addedChars += part.value.length;
            } else if (part.removed) {
                removedLines += (part.value.match(/\n/g) || []).length;
                removedChars += part.value.length;
            }
        }
        
        const leftLines = this.leftContent.split('\n').length;
        const rightLines = this.rightContent.split('\n').length;
        const similarity = this.calculateSimilarity(this.leftContent, this.rightContent);
        
        new Notice(
            '📊 详细统计\n\n' +
            `左侧版本: ${leftLines} 行, ${this.leftContent.length} 字符\n` +
            `右侧版本: ${rightLines} 行, ${this.rightContent.length} 字符\n\n` +
            `新增: ${addedLines} 行, ${addedChars} 字符\n` +
            `删除: ${removedLines} 行, ${removedChars} 字符\n` +
            `相似度: ${similarity.toFixed(1)}%\n` +
            `差异块: ${this.totalDiffs} 个`,
            10000
        );
    }

    calculateSimilarity(text1: string, text2: string): number {
        const len1 = text1.length;
        const len2 = text2.length;
        const maxLen = Math.max(len1, len2);
        
        if (maxLen === 0) return 100;
        
        let matches = 0;
        const minLen = Math.min(len1, len2);
        
        for (let i = 0; i < minLen; i++) {
            if (text1[i] === text2[i]) matches++;
        }
        
        return (matches / maxLen) * 100;
    }

    showSearchBox() {
        const searchContainer = this.containerEl.createEl('div', { cls: 'diff-search-container' });
        
        const searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: '搜索差异内容...',
            cls: 'diff-search-input'
        });
        
        const searchResults = searchContainer.createEl('span', { cls: 'diff-search-results' });
        const closeBtn = searchContainer.createEl('button', { text: '×', cls: 'diff-search-close' });
        
        let searchMatches: HTMLElement[] = [];
        let currentMatch = 0;
        
        searchInput.addEventListener('input', () => {
            const query = searchInput.value.toLowerCase();
            
            searchMatches.forEach(el => el.removeClass('diff-search-match'));
            searchMatches = [];
            currentMatch = 0;
            
            if (query.length < 2) {
                searchResults.setText('');
                return;
            }
            
            this.diffElements.forEach(el => {
                const text = el.textContent?.toLowerCase() || '';
                if (text.includes(query)) {
                    el.addClass('diff-search-match');
                    searchMatches.push(el);
                }
            });
            
            if (searchMatches.length > 0) {
                searchResults.setText(`${currentMatch + 1} / ${searchMatches.length}`);
                searchMatches[0].addClass('diff-search-current');
                searchMatches[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
                searchResults.setText('无结果');
            }
        });
        
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (searchMatches.length > 0) {
                    searchMatches[currentMatch].removeClass('diff-search-current');
                    currentMatch = (currentMatch + 1) % searchMatches.length;
                    searchMatches[currentMatch].addClass('diff-search-current');
                    searchMatches[currentMatch].scrollIntoView({ behavior: 'smooth', block: 'center' });
                    searchResults.setText(`${currentMatch + 1} / ${searchMatches.length}`);
                }
            } else if (e.key === 'Escape') {
                searchContainer.remove();
            }
        });
        
        closeBtn.addEventListener('click', () => {
            searchMatches.forEach(el => {
                el.removeClass('diff-search-match');
                el.removeClass('diff-search-current');
            });
            searchContainer.remove();
        });
        
        const toolbar = this.containerEl.querySelector('.diff-toolbar-redesigned');
        if (toolbar) {
            toolbar.insertAdjacentElement('afterend', searchContainer);
        }
        
        searchInput.focus();
    }

    async exportDiffReport() {
        try {
            const diffResult = Diff.diffLines(this.leftContent, this.rightContent);
            let report = `# 版本差异报告\n\n`;
            report += `**文件**: ${this.file.path}\n`;
            report += `**生成时间**: ${new Date().toLocaleString('zh-CN')}\n\n`;
            
            const versions = await this.plugin.getAllVersions(this.file.path);
            const leftVersion = versions.find(v => v.id === this.versionId);
            
            if (leftVersion) {
                report += `**对比版本**: ${this.plugin.formatTime(leftVersion.timestamp)}\n`;
            } else if (this.versionId === 'current') {
                report += `**对比版本**: 当前文件\n`;
            }
            
            if (this.secondVersionId) {
                const rightVersion = versions.find(v => v.id === this.secondVersionId);
                if (rightVersion) {
                    report += `**目标版本**: ${this.plugin.formatTime(rightVersion.timestamp)}\n`;
                } else if (this.secondVersionId === 'current') {
                    report += `**目标版本**: 当前文件\n`;
                }
            }
            
            report += `\n## 统计信息\n\n`;
            
            let addedLines = 0, removedLines = 0, unchangedLines = 0;
            for (const part of diffResult) {
                const lineCount = part.value.split('\n').length - 1;
                if (part.added) addedLines += lineCount;
                else if (part.removed) removedLines += lineCount;
                else unchangedLines += lineCount;
            }
            
            report += `- 新增行数: ${addedLines}\n`;
            report += `- 删除行数: ${removedLines}\n`;
            report += `- 未变化行数: ${unchangedLines}\n`;
            report += `- 总行数: ${addedLines + removedLines + unchangedLines}\n\n`;
            
            report += `## 差异内容\n\n`;
            report += `\`\`\`diff\n`;
            
            for (const part of diffResult) {
                const prefix = part.added ? '+' : part.removed ? '-' : ' ';
                const lines = part.value.split('\n');
                lines.forEach((line, idx) => {
                    if (idx < lines.length - 1) {
                        report += `${prefix} ${line}\n`;
                    }
                });
            }
            
            report += `\`\`\`\n`;
            
            const fileName = `diff_report_${Date.now()}.md`;
            await this.app.vault.create(fileName, report);
            new Notice(`✅ 差异报告已导出: ${fileName}`);
        } catch (error) {
            console.error('导出差异报告失败:', error);
            new Notice('❌ 导出失败');
        }
    }

    // =======================================================================
    // ======================= [BUG FIX] RENDER UNIFIED DIFF =================
    // =======================================================================
    /**
     * 【修复】重构了统一视图的渲染逻辑，以支持行内差异高亮和正确的行号计数。
     */
    renderUnifiedDiff(container: HTMLElement, left: string, right: string, granularity: 'char' | 'word' | 'line') {
        if (granularity !== 'line') {
            const diffResult = granularity === 'word' ? Diff.diffWordsWithSpace(left, right) : Diff.diffChars(left, right);
            this.renderInlineDiff(container, diffResult);
            return;
        }

        const diffResult = Diff.diffLines(left, right);
        const processedDiff: ProcessedDiff[] = this.enableMoveDetection 
            ? this.processDiffForMoves(diffResult) 
            : diffResult.map(part => ({ ...part, type: (part.added ? 'added' : part.removed ? 'removed' : 'context') as any }));

        let leftLineNum = 1;
        let rightLineNum = 1;
        let diffIdx = 0;

        const createHighlightedFragment = (diffParts: Diff.Change[]): DocumentFragment => {
            const fragment = document.createDocumentFragment();
            diffParts.forEach(part => {
                const className = part.added ? 'diff-word-added' : part.removed ? 'diff-word-removed' : '';
                const processedText = this.showWhitespace ? this.visualizeWhitespace(part.value) : part.value;
                
                if (className) {
                    fragment.append(createEl('span', { text: processedText, cls: className }));
                } else {
                    fragment.append(document.createTextNode(processedText));
                }
            });
            return fragment;
        };

        const renderLine = (content: string | DocumentFragment, type: ProcessedDiff['type'], lineNumLeft: number | null, lineNumRight: number | null, moveId?: number) => {
            const lineEl = container.createEl('div', { cls: `diff-line diff-${type}` });
            if (type !== 'context') {
                lineEl.dataset.diffIndex = String(diffIdx++);
                this.diffElements.push(lineEl);
            }
            if (moveId !== undefined) lineEl.dataset.moveId = String(moveId);
            if (lineNumLeft) lineEl.dataset.lineNumberLeft = String(lineNumLeft);
            if (lineNumRight) lineEl.dataset.lineNumberRight = String(lineNumRight);
            
            lineEl.addEventListener('click', (e) => {
                const target = e.target as HTMLElement;
                if (!target.closest('.diff-line-action-btn, .diff-line-history-btn')) {
                    if (lineEl.hasClass('line-active')) {
                        lineEl.removeClass('line-active');
                    } else {
                        this.textDiffContainer.findAll('.line-active').forEach(el => el.removeClass('line-active'));
                        lineEl.addClass('line-active');
                    }
                }
            });

            const lineNumContainer = lineEl.createEl('div', { cls: 'line-number-container' });
            if (this.showLineNumbers) {
                lineNumContainer.createEl('span', { cls: 'line-number line-number-left', text: lineNumLeft ? String(lineNumLeft) : '' });
                lineNumContainer.createEl('span', { cls: 'line-number line-number-right', text: lineNumRight ? String(lineNumRight) : '' });
            }
            
            const historyBtn = lineNumContainer.createEl('span', { text: '📜', cls: 'diff-line-history-btn', attr: { 'aria-label': '查看行历史' } });
            historyBtn.addEventListener('click', () => this.showLineHistory(typeof content === 'string' ? content : content.textContent || ''));
    
            if ((this.versionId === 'current' && type === 'removed') || (this.secondVersionId === 'current' && type === 'added')) {
                if (type === 'added' && this.secondVersionId === 'current') {
                    const revertBtn = lineNumContainer.createEl('span', { text: '-', cls: 'diff-line-action-btn', attr: { 'aria-label': '撤销此更改' } });
                    revertBtn.addEventListener('click', () => this.revertChanges(typeof content === 'string' ? content : content.textContent || '', rightLineNum - 1));
                }
            }
            if ((this.versionId === 'current' && type === 'added') || (this.secondVersionId === 'current' && type === 'removed')) {
                 if (type === 'removed' && this.secondVersionId === 'current') {
                    const applyBtn = lineNumContainer.createEl('span', { text: '+', cls: 'diff-line-action-btn', attr: { 'aria-label': '应用此更改' } });
                    applyBtn.addEventListener('click', () => this.applyChanges(typeof content === 'string' ? content : content.textContent || '', rightLineNum));
                }
            }
    
            let marker = ' ';
            if (type === 'added') marker = '+';
            else if (type === 'removed') marker = '-';
            else if (type === 'moved-from') marker = '⮫';
            else if (type === 'moved-to') marker = '⮪';

            lineEl.createEl('span', { cls: 'diff-marker', text: marker });
            
            const contentEl = lineEl.createEl('span', { cls: 'line-content' });
            if (typeof content === 'string') {
                contentEl.setText(this.showWhitespace ? this.visualizeWhitespace(content) : content);
                if (content.trim() === '') contentEl.innerHTML = '&nbsp;';
            } else {
                contentEl.appendChild(content);
            }
        };

        for (let i = 0; i < processedDiff.length; i++) {
            const part = processedDiff[i];
            const nextPart = processedDiff[i + 1];

            if (part.removed && nextPart && nextPart.added) {
                const leftLines = part.value.replace(/\n$/, '').split('\n');
                const rightLines = nextPart.value.replace(/\n$/, '').split('\n');
                const maxLines = Math.max(leftLines.length, rightLines.length);

                for (let j = 0; j < maxLines; j++) {
                    const leftLine = leftLines[j];
                    const rightLine = rightLines[j];

                    if (leftLine !== undefined && rightLine !== undefined) {
                        const lineDiff = Diff.diffWordsWithSpace(leftLine, rightLine);
                        const leftFrag = createHighlightedFragment(lineDiff.filter(p => !p.added));
                        const rightFrag = createHighlightedFragment(lineDiff.filter(p => !p.removed));
                        renderLine(leftFrag, 'removed', leftLineNum++, null);
                        renderLine(rightFrag, 'added', null, rightLineNum++);
                    } else if (leftLine !== undefined) {
                        renderLine(leftLine, 'removed', leftLineNum++, null);
                    } else if (rightLine !== undefined) {
                        renderLine(rightLine, 'added', null, rightLineNum++);
                    }
                }
                i++; // Skip next part
            } else {
                const lines = part.value.replace(/\n$/, '').split('\n');
                for (const line of lines) {
                    if (part.added) {
                        renderLine(line, 'added', null, rightLineNum++);
                    } else if (part.removed) {
                        renderLine(line, 'removed', leftLineNum++, null);
                    } else if (part.type === 'moved-from') {
                        renderLine(line, 'moved-from', leftLineNum++, null, part.moveId);
                    } else if (part.type === 'moved-to') {
                        renderLine(line, 'moved-to', null, rightLineNum++, part.moveId);
                    } else { // context
                        if (!this.showOnlyChanges) {
                            renderLine(line, 'context', leftLineNum, rightLineNum);
                        }
                        leftLineNum++;
                        rightLineNum++;
                    }
                }
            }
        }
    }
    // ======================= [END BUG FIX] RENDER UNIFIED DIFF =================

    renderInlineDiff(container: HTMLElement, diffResult: Diff.Change[]) {
        let leftLineNum = 1;
        let rightLineNum = 1;
        let lineHasChange = false;
        let currentLineFragment = document.createDocumentFragment();
    
        const finalizeLine = () => {
            if (this.showOnlyChanges && !lineHasChange) {
                // Skip
            } else {
                const lineEl = container.createEl('div', { cls: 'diff-line diff-context' });
                if (lineHasChange) {
                    this.diffElements.push(lineEl);
                    lineEl.dataset.diffIndex = String(this.diffElements.length - 1);
                }
                lineEl.dataset.lineNumberLeft = String(leftLineNum);
                lineEl.dataset.lineNumberRight = String(rightLineNum);
    
                if (this.showLineNumbers) {
                    const lineNumContainer = lineEl.createEl('div', { cls: 'line-number-container' });
                    lineNumContainer.createEl('span', { cls: 'line-number line-number-left', text: String(leftLineNum) });
                    lineNumContainer.createEl('span', { cls: 'line-number line-number-right', text: String(rightLineNum) });
                }
                const contentEl = lineEl.createEl('span', { cls: 'line-content' });
                contentEl.appendChild(currentLineFragment);
            }
    
            currentLineFragment = document.createDocumentFragment();
            leftLineNum++;
            rightLineNum++;
            lineHasChange = false;
        };
    
        for (const part of diffResult) {
            const text = this.showWhitespace ? this.visualizeWhitespace(part.value) : part.value;
            const className = part.added ? 'diff-char-added' : part.removed ? 'diff-char-removed' : '';
            if (className) {
                lineHasChange = true;
            }
    
            const lines = text.split('\n');
            lines.forEach((lineChunk, index) => {
                if (lineChunk) {
                    if (className) {
                        currentLineFragment.append(createEl('span', { text: lineChunk, cls: className }));
                    } else {
                        currentLineFragment.append(document.createTextNode(lineChunk));
                    }
                }
    
                if (index < lines.length - 1) {
                    finalizeLine();
                }
            });
        }
    
        if (currentLineFragment.hasChildNodes()) {
            finalizeLine();
        }
    }

    renderSplitDiff(container: HTMLElement, left: string, right: string, granularity: 'char' | 'word' | 'line', leftLabel: string, rightLabel: string) {
        const leftPanel = container.createEl('div', { cls: 'diff-panel' });
        const rightPanel = container.createEl('div', { cls: 'diff-panel' });

        leftPanel.createEl('h3', { text: leftLabel });
        rightPanel.createEl('h3', { text: rightLabel });

        const leftContentEl = leftPanel.createEl('div', { cls: 'diff-content' });
        const rightContentEl = rightPanel.createEl('div', { cls: 'diff-content' });

        this.renderSplitViewAdvanced(leftContentEl, rightContentEl, left, right, granularity);
    }

    // =======================================================================
    // ======================= [BUG FIX] RENDER SPLIT VIEW ===================
    // =======================================================================
    /**
     * 【修复】增强的分栏视图渲染逻辑，增加了行内差异高亮功能并修复了行号计数问题。
     */
    renderSplitViewAdvanced(leftPanel: HTMLElement, rightPanel: HTMLElement, leftText: string, rightText: string, granularity: 'char' | 'word' | 'line') {
        const rawDiff = Diff.diffLines(leftText, rightText);
        const diff: ProcessedDiff[] = this.enableMoveDetection
            ? this.processDiffForMoves(rawDiff)
            : rawDiff.map(p => ({ ...p, type: p.added ? 'added' : p.removed ? 'removed' : 'context' }));

        let leftLineNum = 1;
        let rightLineNum = 1;
        let diffIdx = 0;
    
        const createHighlightedFragment = (diffParts: Diff.Change[]): DocumentFragment => {
            const fragment = document.createDocumentFragment();
            diffParts.forEach(part => {
                const className = part.added ? 'diff-word-added' : part.removed ? 'diff-word-removed' : '';
                const processedText = this.showWhitespace ? this.visualizeWhitespace(part.value) : part.value;
                
                if (className) {
                    fragment.append(createEl('span', { text: processedText, cls: className }));
                } else {
                    fragment.append(document.createTextNode(processedText));
                }
            });
            return fragment;
        };
    
        const renderLine = (panel: HTMLElement, content: string | DocumentFragment, type: string, lineNum: number | null, moveId?: number) => {
            const lineEl = panel.createEl('div', { cls: `diff-line diff-${type}` });
            if (type !== 'context' && type !== 'placeholder') {
                lineEl.dataset.diffIndex = String(diffIdx++);
                this.diffElements.push(lineEl);
            }
            if (lineNum) lineEl.dataset.lineNumber = String(lineNum);
            if (moveId !== undefined) lineEl.dataset.moveId = String(moveId);

            lineEl.addEventListener('click', (e) => {
                const target = e.target as HTMLElement;
                if (!target.closest('.diff-line-action-btn, .diff-line-history-btn')) {
                    if (lineEl.hasClass('line-active')) {
                        lineEl.removeClass('line-active');
                    } else {
                        this.textDiffContainer.findAll('.line-active').forEach(el => el.removeClass('line-active'));
                        lineEl.addClass('line-active');
                    }
                }
            });

            if (this.showLineNumbers) {
                lineEl.createEl('span', { cls: 'line-number', text: lineNum ? String(lineNum) : '' });
            }
            const contentEl = lineEl.createEl('span', { cls: 'line-content' });
            if (typeof content === 'string') {
                contentEl.setText(this.showWhitespace ? this.visualizeWhitespace(content) : content);
            } else {
                contentEl.appendChild(content);
            }
        };
    
        for (let i = 0; i < diff.length; i++) {
            const part = diff[i];
            const nextPart = diff[i + 1];
    
            if (part.removed && nextPart && nextPart.added) {
                const leftLines = part.value.replace(/\n$/, '').split('\n');
                const rightLines = nextPart.value.replace(/\n$/, '').split('\n');
                const maxLines = Math.max(leftLines.length, rightLines.length);
    
                for (let j = 0; j < maxLines; j++) {
                    const leftLine = leftLines[j];
                    const rightLine = rightLines[j];
    
                    if (leftLine !== undefined && rightLine !== undefined) {
                        const lineDiff = Diff.diffWordsWithSpace(leftLine, rightLine);
                        const leftFrag = createHighlightedFragment(lineDiff.filter(p => !p.added));
                        const rightFrag = createHighlightedFragment(lineDiff.filter(p => !p.removed));
                        renderLine(leftPanel, leftFrag, 'modified', leftLineNum++);
                        renderLine(rightPanel, rightFrag, 'modified', rightLineNum++);
                    } else if (leftLine !== undefined) {
                        renderLine(leftPanel, leftLine, 'removed', leftLineNum++);
                        renderLine(rightPanel, '', 'placeholder', null);
                    } else if (rightLine !== undefined) {
                        renderLine(leftPanel, '', 'placeholder', null);
                        renderLine(rightPanel, rightLine, 'added', rightLineNum++);
                    }
                }
                i++;
            } else if (part.added || part.type === 'moved-to') {
                const lines = part.value.replace(/\n$/, '').split('\n');
                for (const line of lines) {
                    renderLine(leftPanel, '', 'placeholder', null);
                    renderLine(rightPanel, line, part.type || 'added', rightLineNum++, part.moveId);
                }
            } else if (part.removed || part.type === 'moved-from') {
                const lines = part.value.replace(/\n$/, '').split('\n');
                for (const line of lines) {
                    renderLine(leftPanel, line, part.type || 'removed', leftLineNum++, part.moveId);
                    renderLine(rightPanel, '', 'placeholder', null);
                }
            } else { // context
                const lines = part.value.replace(/\n$/, '').split('\n');
                for (const line of lines) {
                    if (!this.showOnlyChanges) {
                        renderLine(leftPanel, line, 'context', leftLineNum);
                        renderLine(rightPanel, line, 'context', rightLineNum);
                    }
                    leftLineNum++;
                    rightLineNum++;
                }
            }
        }
    }
    // ======================= [END BUG FIX] RENDER SPLIT VIEW ===================

    scrollToDiff() {
        if (this.diffElements.length === 0 || this.currentDiffIndex >= this.diffElements.length) return;
        const element = this.diffElements[this.currentDiffIndex];
        this.diffElements.forEach(el => el.removeClass('diff-current'));
        element.addClass('diff-current');
        element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }

    copyDiffToClipboard() {
        const diffContainer = this.containerEl.querySelector('.diff-container');
        if (!diffContainer) return;
        navigator.clipboard.writeText(diffContainer.textContent || '').then(() => {
            new Notice('✅ 差异内容已复制到剪贴板');
        }).catch(() => {
            new Notice('❌ 复制失败');
        });
    }

    renderStructuredDiff() {
        const container = this.structuredDiffContainer;
        container.empty();
        const leftSections = this.parseMarkdownSections(this.leftContent);
        const rightSections = this.parseMarkdownSections(this.rightContent);
        const diffResults = this.compareSections(leftSections, rightSections);
        if (diffResults.length === 0) {
            container.createEl('div', { text: '✅ 内容相同', cls: 'diff-empty-notice' });
            return;
        }
        for (const result of diffResults) {
            const details = container.createEl('details', { cls: `structured-section structured-${result.type}` });
            const summary = details.createEl('summary');
            let badgeText = '', headingText = '', openByDefault = false;
            switch (result.type) {
                case 'added': badgeText = '新增'; headingText = result.section.heading; openByDefault = true; break;
                case 'removed': badgeText = '删除'; headingText = result.section.heading; openByDefault = true; break;
                case 'modified': badgeText = '修改'; headingText = result.right.heading; openByDefault = true; break;
                case 'unchanged': badgeText = '未变'; headingText = result.right.heading; break;
            }
            summary.createEl('span', { text: badgeText, cls: `diff-badge diff-badge-${result.type}` });
            summary.createEl('span', { text: headingText, cls: 'section-heading' });
            details.open = openByDefault;
            const contentContainer = details.createEl('div', { cls: 'section-content' });
            if (result.type === 'modified') {
                const granularDiff = this.currentGranularity === 'line' 
                    ? result.diff 
                    : (this.currentGranularity === 'word' 
                        ? Diff.diffWordsWithSpace(result.left.content, result.right.content) 
                        : Diff.diffChars(result.left.content, result.right.content));
                
                if (this.currentGranularity === 'line') {
                    this.renderUnifiedDiff(contentContainer, result.left.content, result.right.content, 'line');
                } else {
                    this.renderInlineDiff(contentContainer, granularDiff);
                }
            } else if (result.type === 'added') {
                contentContainer.createEl('pre', { text: result.section.content });
            } else if (result.type === 'removed') {
                contentContainer.createEl('pre', { text: result.section.content });
            }
        }
    }

    private parseMarkdownSections(content: string): MarkdownSection[] {
        const sections: MarkdownSection[] = [];
        const headingRegex = /^(#+)\s+(.*)/;
        const lines = content.split('\n');
        let currentSection: MarkdownSection | null = null;
        let sectionContent: string[] = [];
        let index = 0;
        for (const line of lines) {
            const match = line.match(headingRegex);
            if (match) {
                if (currentSection) {
                    currentSection.content = sectionContent.join('\n').trim();
                    sections.push(currentSection);
                } else if (sectionContent.length > 0 && sectionContent.join('').trim() !== '') {
                    sections.push({ heading: '（文档开头）', level: 0, content: sectionContent.join('\n').trim(), originalIndex: index++ });
                }
                sectionContent = [];
                currentSection = { heading: match[2], level: match[1].length, content: '', originalIndex: index++ };
            } else {
                sectionContent.push(line);
            }
        }
        if (currentSection) {
            currentSection.content = sectionContent.join('\n').trim();
            sections.push(currentSection);
        } else if (sectionContent.length > 0 && sectionContent.join('').trim() !== '') {
            sections.push({ heading: sections.length > 0 ? '（文档末尾）' : '（全文）', level: 0, content: sectionContent.join('\n').trim(), originalIndex: index++ });
        }
        return sections;
    }

    private compareSections(left: MarkdownSection[], right: MarkdownSection[]): SectionDiffResult[] {
        const results: SectionDiffResult[] = [];
        const leftMap = new Map(left.map(s => [s.heading, s]));
        const processedLeftHeadings = new Set<string>();
        for (const rightSection of right) {
            const leftSection = leftMap.get(rightSection.heading);
            if (leftSection) {
                if (leftSection.content.trim() === rightSection.content.trim()) {
                    results.push({ type: 'unchanged', left: leftSection, right: rightSection });
                } else {
                    const diff = Diff.diffLines(leftSection.content, rightSection.content);
                    const processedDiff = this.processDiffForMoves(diff);
                    results.push({ type: 'modified', left: leftSection, right: rightSection, diff: processedDiff });
                }
                processedLeftHeadings.add(rightSection.heading);
            } else {
                results.push({ type: 'added', section: rightSection });
            }
        }
        for (const leftSection of left) {
            if (!processedLeftHeadings.has(leftSection.heading)) {
                results.push({ type: 'removed', section: leftSection });
            }
        }
        return results.sort((a, b) => {
            const getIndex = (res: SectionDiffResult) => {
                if (res.type === 'added') return res.section.originalIndex;
                if (res.type === 'modified' || res.type === 'unchanged') return res.right.originalIndex;
                return Infinity;
            };
            return getIndex(a) - getIndex(b);
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class LineHistoryModal extends Modal {
    plugin: VersionControlPlugin;
    file: TFile;
    lineText: string;
    versions: VersionData[];

    constructor(app: App, plugin: VersionControlPlugin, file: TFile, lineText: string, versions: VersionData[]) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.lineText = lineText;
        this.versions = versions;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('line-history-modal');

        contentEl.createEl('h2', { text: '行历史' });
        contentEl.createEl('p', { text: '以下版本中包含了这行内容:' });
        contentEl.createEl('pre', { text: this.lineText });

        const listContainer = contentEl.createEl('div', { cls: 'version-select-list' });

        if (this.versions.length === 0) {
            listContainer.createEl('div', { text: '没有找到匹配的历史版本。', cls: 'version-select-empty' });
            return;
        }

        for (const version of this.versions) {
            const item = listContainer.createEl('div', { cls: 'version-select-item' });
            
            const info = item.createEl('div', { cls: 'version-info' });
            info.createEl('div', { text: this.plugin.formatTime(version.timestamp), cls: 'version-time' });
            info.createEl('div', { text: version.message, cls: 'version-message' });

            const compareBtn = item.createEl('button', { text: '对比' });
            compareBtn.addEventListener('click', () => {
                this.close();
                new DiffModal(this.app, this.plugin, this.file, version.id).open();
            });
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}

// =======================================================================
// ======================== [END] FINAL DIFFMODAL ==========================
// =======================================================================

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
            .setName('在状态栏显示上次保存时间')
            .setDesc('开启后，状态栏将显示相对的上次保存时间；关闭则显示通用状态。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showLastSaveTimeInStatusBar)
                .onChange(async (value) => {
                    this.plugin.settings.showLastSaveTimeInStatusBar = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('启用状态栏快速对比')
            .setDesc('点击状态栏可快速对比当前文件与最新版本')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableStatusBarDiff)
                .onChange(async (value) => {
                    this.plugin.settings.enableStatusBarDiff = value;
                    await this.plugin.saveSettings();
                    
                    if (value) {
                        this.plugin.statusBarItem.addClass('version-control-statusbar-clickable');
                    } else {
                        this.plugin.statusBarItem.removeClass('version-control-statusbar-clickable');
                    }
                }));

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
                        window.clearInterval(this.plugin.autoSaveTimer);
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
                .setLimits(30, 600, 30)
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
                        window.clearInterval(this.plugin.autoSaveTimer);
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
            .setName('📄 切换文件时保存')
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
                .addOption('line', '行级 - [推荐] 按行显示差异,并高亮行内单词/字符变化')
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
        ul1.createEl('li', { text: '增强差异对比 - 智能行内高亮、智能折叠、键盘导航' });
        
        const feature2 = infoEl.createEl('div', { cls: 'feature-item' });
        feature2.createEl('strong', { text: '💡 使用技巧:' });
        const ul2 = feature2.createEl('ul');
        ul2.createEl('li', { text: '右键点击版本可查看更多操作选项' });
        ul2.createEl('li', { text: '点击标签可快速筛选相关版本' });
        ul2.createEl('li', { text: '使用星标标记重要的里程碑版本' });
        ul2.createEl('li', { text: '定期运行"优化存储"以保持最佳性能' });
        ul2.createEl('li', { text: '增量存储和压缩可节省90%以上的空间' });
        ul2.createEl('li', { text: '差异对比中使用方向键 ↑/↓ 快速导航' });
    }

    async clearAllVersions() {
        try {
            const adapter = this.app.vault.adapter;
            const versionFolder = this.plugin.settings.versionFolder;
            
            if (await adapter.exists(versionFolder)) {
                await adapter.rmdir(versionFolder, true);
                await this.plugin.ensureVersionFolder();

                this.plugin.versionCache.clear();
                new Notice(`✅ 已清空所有版本`);
                this.plugin.refreshVersionHistoryView();
                this.display();
            }
        } catch (error) {
            console.error('清空版本失败:', error);
            new Notice('❌ 清空失败,请查看控制台');
        }
    }
}