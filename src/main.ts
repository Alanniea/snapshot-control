
import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, Modal, ItemView, WorkspaceLeaf, Menu, TextComponent, MarkdownRenderer, Platform, TFolder, setIcon } from 'obsidian';
import * as Diff from 'diff';
import * as pako from 'pako';

// VersionData 接口
interface VersionData {
    id: string;
    timestamp: number;
    message: string;
    content?: string;
    diff?: string;
    baseVersionId?: string; // 用于链式增量存储
    size: number;
    hash?: string;
    tags?: string[];
    note?: string;
    starred?: boolean;
    addedLines?: number;
    removedLines?: number;
    modifiedLines?: number;
}

interface VersionFile {
    filePath: string;
    versions: VersionData[];
    lastModified: number;
    baseVersion?: string; // 保留用于向后兼容
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
    autoSaveMinChanges: number;
    autoSaveOnInterval: boolean;
    
    autoSaveDelayOnModify: number;

    enableQuickPreview: boolean;
    enableVersionTags: boolean;
    defaultTags: string[];
    showVersionStats: boolean;
    enableStatusBarDiff: boolean;
    showLastSaveTimeInStatusBar: boolean;

    inlineDiffAlgorithm: 'word' | 'char' | 'line';
    diffContextLines: number;
    compactUnifiedDiff: boolean; 
    
    deleteHistoryOnDelete: boolean; // 是否随文件删除历史版本
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
    diffGranularity: 'line',
    diffViewMode: 'unified',
    enableDeduplication: true,
    showNotifications: true,
    excludedFolders: [],
    enableCompression: true,
    enableIncrementalStorage: true,
    versionsPerPage: 20,
    rebuildBaseInterval: 10,
    autoSaveOnModify: true,
    autoSaveMinChanges: 10,
    autoSaveOnInterval: false,
    
    autoSaveDelayOnModify: 180,

    enableQuickPreview: true,
    enableVersionTags: true,
    defaultTags: ['重要', '里程碑', '发布', '备份', '草稿'],
    showVersionStats: true,
    enableStatusBarDiff: true,
    showLastSaveTimeInStatusBar: true,
    
    inlineDiffAlgorithm: 'word',
    diffContextLines: 3,
    compactUnifiedDiff: false, 
    
    deleteHistoryOnDelete: false, // 默认防误删
};

// 视图模式类型定义
type ViewMode = 'current' | 'modified' | 'global';

export default class VersionControlPlugin extends Plugin {
    settings: VersionControlSettings;
    autoSaveTimer: number | null = null;
    lastModifiedTime: Map<string, number> = new Map();
    pendingSaves: Map<string, NodeJS.Timeout> = new Map();
    statusBarItem: HTMLElement;
    versionCache: Map<string, VersionFile> = new Map();

    fileLocks: Map<string, Promise<void>> = new Map();
    isRestoring: boolean = false; 

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
            name: '保存新版本',
            callback: () => this.createManualVersion()
        });

        this.addCommand({
            id: 'show-version-history',
            name: '显示版本历史',
            callback: () => this.activateVersionHistoryView()
        });

        this.addCommand({
            id: 'create-full-snapshot',
            name: '保存全库版本',
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
            id: 'check-version-integrity',
            name: '检查版本完整性',
            callback: () => this.checkAllVersionsIntegrity()
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
                if (this.isRestoring) return;

                if (file instanceof TFile && this.settings.autoSave && this.settings.autoSaveOnModify) {
                    this.handleFileModify(file);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', async (file, oldPath) => {
                if (file instanceof TFile) {
                    await this.handleRename(file, oldPath);
                } else if (file instanceof TFolder) {
                    await this.handleFolderRename(file, oldPath);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('delete', async (file) => {
                if (file instanceof TFile) {
                    await this.handleDelete(file.path);
                }
            })
        );

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.updateStatusBar();
            })
        );

        if (this.settings.autoSave && this.settings.autoSaveOnInterval) {
            this.startAutoSave();
        }

        await this.ensureVersionFolder();

        this.registerInterval(
            window.setInterval(() => {
                this.updateAllRelativeTimes();
            }, 60000)
        );

        if (this.settings.showNotifications) {
            new Notice('✅ 版本控制插件已启动');
        }
    }

    onunload() {
        if (this.autoSaveTimer) {
            window.clearInterval(this.autoSaveTimer);
        }
        this.pendingSaves.forEach(timeout => clearTimeout(timeout));
        this.pendingSaves.clear();
        this.versionCache.clear();
    }

    // 执行带锁的异步操作，确保任务完毕后清理锁释放内存
    async withLock(filePath: string, fn: () => Promise<void>): Promise<void> {
        let currentLock = this.fileLocks.get(filePath) || Promise.resolve();
        const nextLock = currentLock
            .then(() => fn())
            .catch((err: any) => {
                console.error(`[VersionControl] Error in locked operation for ${filePath}:`, err);
            })
            .finally(() => {
                if (this.fileLocks.get(filePath) === nextLock) {
                    this.fileLocks.delete(filePath);
                }
            });
        this.fileLocks.set(filePath, nextLock);
        await nextLock;
    }

    // 高安全性的 53 位 Hash 算法
    cyrb53(str: string, seed = 0): number {
        let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
        for(let i = 0, ch; i < str.length; i++) {
            ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1  = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
        h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2  = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
        h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return 4294967296 * (2097151 & h2) + (h1 >>> 0);
    }

    // 兼容旧版的 DJB2 Hash 算法（用于寻找以前生成的老文件）
    legacyStringHash(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0; 
        }
        return (hash >>> 0).toString(16);
    }

    stringHash(str: string): string { return this.cyrb53(str).toString(36); }
    hashContent(content: string): string { return this.cyrb53(content).toString(36); }

    // 高级 Diff 压缩算法，解决因空行导致的块分离问题
    getCompactDiffLines(left: string, right: string, ignoreWhitespace: boolean): Diff.Change[] {
        const rawDiff = Diff.diffLines(left, right, { ignoreWhitespace });
        const result: Diff.Change[] = [];
        let i = 0;
        while (i < rawDiff.length) {
            let part = rawDiff[i]!;
            if (part.added || part.removed) {
                let leftValue = ''; let rightValue = '';
                let leftCount = 0; let rightCount = 0;
                let j = i;
                while (j < rawDiff.length) {
                    const p = rawDiff[j]!;
                    if (p.added) {
                        rightValue += p.value; rightCount += p.count || 0; j++;
                    } else if (p.removed) {
                        leftValue += p.value; leftCount += p.count || 0; j++;
                    } else {
                        let nextChangeIdx = -1;
                        for (let k = j + 1; k < rawDiff.length; k++) {
                            if (rawDiff[k]!.added || rawDiff[k]!.removed) { nextChangeIdx = k; break; }
                        }
                        let canMerge = false;
                        if (nextChangeIdx !== -1) {
                            let purelyMergeable = true;
                            for (let k = j; k < nextChangeIdx; k++) {
                                const ctx = rawDiff[k]!;
                                const isWhitespace = ctx.value.trim() === '';
                                const isShort = ctx.count !== undefined && ctx.count <= 2;
                                if (!isWhitespace && !isShort) { purelyMergeable = false; break; }
                            }
                            canMerge = purelyMergeable;
                        }
                        if (canMerge) {
                            leftValue += p.value; leftCount += p.count || 0;
                            rightValue += p.value; rightCount += p.count || 0;
                            j++;
                        } else {
                            break;
                        }
                    }
                }
                if (leftCount > 0) result.push({ removed: true, added: false, value: leftValue, count: leftCount });
                if (rightCount > 0) result.push({ added: true, removed: false, value: rightValue, count: rightCount });
                i = j;
            } else {
                result.push(part); i++;
            }
        }
        return result;
    }

    calculateSimilarity(text1: string, text2: string): number {
        if (!text1 && !text2) return 100;
        if (!text1 || !text2) return 0;
        const diff = Diff.diffChars(text1, text2);
        let commonLength = 0;
        diff.forEach(part => {
            if (!part.added && !part.removed) {
                commonLength += part.value.length;
            }
        });
        const maxLen = Math.max(text1.length, text2.length);
        if (maxLen === 0) return 100;
        return (commonLength / maxLen) * 100;
    }

    // 独立计算块内真正修改、增加、删除的行数
    calculateCompactBlockStats(leftLines: string[], rightLines: string[]): { mods: number, adds: number, rems: number } {
        let mods = 0; let adds = 0; let rems = 0;
        if (leftLines.length === rightLines.length) {
            for (let j = 0; j < leftLines.length; j++) {
                if (leftLines[j] !== rightLines[j]) mods++;
            }
        } else {
            let lIndex = 0; let rIndex = 0;
            while (lIndex < leftLines.length || rIndex < rightLines.length) {
                const lLine = leftLines[lIndex]; const rLine = rightLines[rIndex];
                if (lLine === undefined) { adds++; rIndex++; continue; }
                if (rLine === undefined) { rems++; lIndex++; continue; }
                
                const currentSim = this.calculateSimilarity(lLine, rLine);
                const nextRightLine = rightLines[rIndex + 1];
                const insertionSim = nextRightLine !== undefined ? this.calculateSimilarity(lLine, nextRightLine) : 0;
                const nextLeftLine = leftLines[lIndex + 1];
                const deletionSim = nextLeftLine !== undefined ? this.calculateSimilarity(nextLeftLine, rLine) : 0;

                const threshold = 30;
                if (insertionSim > currentSim + threshold) {
                    adds++; rIndex++;
                } else if (deletionSim > currentSim + threshold) {
                    rems++; lIndex++;
                } else {
                    if (lLine !== rLine) mods++;
                    lIndex++; rIndex++;
                }
            }
        }
        return { mods, adds, rems };
    }

    // --- 文件名处理与兼容逻辑 ---

    // 1. 新版路径获取 (使用新 Hash)
    getVersionFilePath(filePath: string): string {
        const hash = this.stringHash(filePath);
        const fileName = filePath.split('/').pop() || 'file';
        const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_');
        return `${this.settings.versionFolder}/${safeName}_${hash}.json`;
    }

    // 2. 旧版路径获取 (使用旧 Hash 和新过滤规则)
    getLegacyHashVersionFilePath(filePath: string): string {
        const hash = this.legacyStringHash(filePath);
        const fileName = filePath.split('/').pop() || 'file';
        const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_');
        return `${this.settings.versionFolder}/${safeName}_${hash}.json`;
    }

    // 3. 更旧版的严格 ASCII 过滤路径
    getLegacyStrictAsciiVersionFilePath(filePath: string): string {
        const hash = this.legacyStringHash(filePath);
        const fileName = filePath.split('/').pop() || 'file';
        const safeName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        return `${this.settings.versionFolder}/${safeName}_${hash}.json`;
    }

    // 4. 最早的纯路径过滤 (无 Hash)
    getLegacyVersionFilePath(filePath: string): string {
        const sanitized = this.sanitizeFileName(filePath);
        return `${this.settings.versionFolder}/${sanitized}.json`;
    }

    // 核心寻址函数：按优先级依次查找，确保旧历史文件不丢
    async findExistingVersionPath(filePath: string): Promise<string | null> {
        const adapter = this.app.vault.adapter;
        const paths = [
            this.getVersionFilePath(filePath),
            this.getLegacyHashVersionFilePath(filePath),
            this.getLegacyStrictAsciiVersionFilePath(filePath),
            this.getLegacyVersionFilePath(filePath)
        ];

        for (const p of paths) {
            if (await adapter.exists(p)) return p;
        }
        return null;
    }

    // 处理文件夹重命名递归更新
    async handleFolderRename(folder: TFolder, oldFolderPath: string) {
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            if (file.path.startsWith(folder.path + '/')) {
                const relativePath = file.path.substring(folder.path.length);
                const oldFilePath = oldFolderPath + relativePath;
                await this.handleRename(file, oldFilePath);
            }
        }
    }

    async handleRename(file: TFile, oldPath: string) {
        await this.withLock(oldPath, async () => {
            const adapter = this.app.vault.adapter;
            
            let oldVersionPath = await this.findExistingVersionPath(oldPath);

            if (oldVersionPath) {
                const newVersionPath = this.getVersionFilePath(file.path);
                
                await adapter.rename(oldVersionPath, newVersionPath);
                
                try {
                    // 清理目标缓存，防止读取到脏数据
                    this.versionCache.delete(file.path); 
                    
                    const versionFile = await this.loadVersionFile(file.path); 
                    versionFile.filePath = file.path;
                    await this.saveVersionFile(file.path, versionFile);
                    
                    this.versionCache.delete(oldPath);
                    this.lastModifiedTime.delete(oldPath);
                    this.lastModifiedTime.set(file.path, versionFile.lastModified);
                } catch (e: any) {
                    console.error("Rename: Error updating internal file path", e);
                }
            }
        });
        
        const pendingOld = this.pendingSaves.get(oldPath);
        if (pendingOld) {
            clearTimeout(pendingOld);
            this.pendingSaves.delete(oldPath);
            // [FIX 3] 为新文件续上自动保存任务，防止重命名丢失缓存
            this.handleFileModify(file);
        }

        const pendingNew = this.pendingSaves.get(file.path);
        if (pendingNew) {
            clearTimeout(pendingNew);
            this.pendingSaves.delete(file.path);
            this.handleFileModify(file); 
        }
    }

    async handleDelete(filePath: string) {
        // 增加防误删保护，只在用户开启了设置时才删除历史记录
        if (!this.settings.deleteHistoryOnDelete) {
            return;
        }

        await this.withLock(filePath, async () => {
            const adapter = this.app.vault.adapter;
            let versionPath = await this.findExistingVersionPath(filePath);

            if (versionPath) {
                await adapter.remove(versionPath);
                this.versionCache.delete(filePath);
                this.lastModifiedTime.delete(filePath);
                this.pendingSaves.delete(filePath);
            }
        });
    }

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); this.updateStatusBar(); }
    
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

    getSaveTypeLabel(message: string): string { 
        if (message.includes('[Auto Save - On Modify]')) return '修改保存';
        if (message.includes('[Auto Save - Interval]')) return '定时保存';
        if (message.includes('[Full Snapshot]')) return '全库版本';
        if (message.includes('[Before Restore]')) return '恢复前备份';
        if (message.includes('[Auto Save')) return '自动保存';
        return '手动保存';
    }

    async updateStatusBar() {
        if (!this.settings.autoSave) { 
            this.statusBarItem.setText('⏸ 版本控制: 已暂停'); 
            this.statusBarItem.title = '自动保存已暂停'; 
            return; 
        }
        
        const file = this.app.workspace.getActiveFile();
        
        if (!this.settings.showLastSaveTimeInStatusBar || !file) { 
            this.statusBarItem.setText(''); 
            this.statusBarItem.title = ''; 
            return; 
        }
        
        const versions = await this.getAllVersions(file.path);
        if (versions.length > 0) {
            const lastVersion = versions[0]!;
            const lastSaveTime = lastVersion.timestamp;
            this.lastModifiedTime.set(file.path, lastSaveTime);
            const saveTypeLabel = this.getSaveTypeLabel(lastVersion.message);
            const relativeTime = this.getRelativeTime(lastSaveTime);
            this.statusBarItem.setText(`${saveTypeLabel}: ${relativeTime}`);
            this.statusBarItem.title = `${saveTypeLabel}于 ${new Date(lastSaveTime).toLocaleString('zh-CN')}. 点击可快速对比。`;
        } else {
            this.lastModifiedTime.delete(file.path);
            this.statusBarItem.setText(''); 
            this.statusBarItem.title = '';
        }
    }

    async quickDiffFromStatusBar() {
        if (!this.settings.enableStatusBarDiff) return;
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice('没有打开的文件'); return; }
        const versions = await this.getAllVersions(file.path);
        if (versions.length === 0) { new Notice('没有历史版本可对比'); return; }
        const lastVersion = versions[0]!;
        new DiffModal(this.app, this, file, lastVersion.id).open();
    }

    async ensureVersionFolder() { 
        const adapter = this.app.vault.adapter;
        const folderPath = this.settings.versionFolder;
        try { if (!await adapter.exists(folderPath)) { await adapter.mkdir(folderPath); } } 
        catch (error: any) { console.error('创建版本文件夹失败:', error); new Notice('⚠️ 无法创建版本文件夹,请检查权限'); }
    }

    async activateVersionHistoryView() { 
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType('version-history')[0];
        if (!leaf) { const rightLeaf = workspace.getRightLeaf(false); if (!rightLeaf) { new Notice('无法打开版本历史视图'); return; } leaf = rightLeaf; await leaf.setViewState({ type: 'version-history', active: true, }); }
        workspace.revealLeaf(leaf);
    }

    startAutoSave() { 
        if (this.autoSaveTimer) { window.clearInterval(this.autoSaveTimer); this.autoSaveTimer = null; }
        if (this.settings.autoSaveOnInterval) { this.autoSaveTimer = window.setInterval(() => { this.autoSaveAllModifiedFiles(); }, this.settings.autoSaveInterval * 60 * 1000); }
    }

    scheduleSave(file: TFile, delay: number, message: string) { 
        if (this.isExcluded(file.path)) { return; }
        const existingTimeout = this.pendingSaves.get(file.path);
        if (existingTimeout) { clearTimeout(existingTimeout); }
        if (delay === 0) { this.autoSaveFile(file, message); this.pendingSaves.delete(file.path); return; }
        const timeout = setTimeout(() => { this.autoSaveFile(file, message); this.pendingSaves.delete(file.path); }, delay * 1000);
        this.pendingSaves.set(file.path, timeout);
    }

    async autoSaveFile(file: TFile, message: string) {
        if (!file || !this.app.vault.getAbstractFileByPath(file.path)) {
            this.pendingSaves.delete(file.path);
            return;
        }

        await this.withLock(file.path, async () => {
            try {
                const rawContent = await this.app.vault.read(file);
                const content = this.normalizeText(rawContent);
                
                const versions = await this.getAllVersions(file.path);
                let lastContent = '';
                if (versions.length > 0) {
                    const latestVersion = versions[0]!;
                    const currentHash = this.hashContent(content);
                    const currentHashOld = this.legacyStringHash(content); // 双重校验兼容
                    
                    if (latestVersion.hash === currentHash || latestVersion.hash === currentHashOld) {
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

                await this.createVersionInternal(file, message, false, [], false, content);
                
            } catch (error: any) {
                console.error('自动保存失败:', error);
            }
        });
    }

    countChanges(oldText: string, newText: string): number { 
        const changes = Diff.diffChars(oldText, newText); let changeCount = 0;
        for (const part of changes) { if (part.added || part.removed) { changeCount += part.value.length; } }
        return changeCount;
    }
    
    handleFileModify(file: TFile) { 
        this.scheduleSave(file, this.settings.autoSaveDelayOnModify, '[Auto Save - On Modify]');
    }

    async autoSaveAllModifiedFiles() { 
        const modifiedFiles = await this.getModifiedFiles();
        for (const item of modifiedFiles) {
            if (!this.isExcluded(item.file.path)) {
                await this.autoSaveFile(item.file, '[Auto Save - Interval]');
            }
        }
    }
    
    isExcluded(filePath: string): boolean { 
        return this.settings.excludedFolders.some(folder => filePath.startsWith(folder));
    }

    async createManualVersion() {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
            new Notice('没有打开的文件');
            return;
        }

        const existingTimeout = this.pendingSaves.get(file.path);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
            this.pendingSaves.delete(file.path);
        }

        new VersionMessageModal(this.app, this.settings, async (message, tags) => {
            await this.createVersion(file, message, true, tags, true);
        }).open();
    }

    normalizeText(text: string): string {
        if (!text) return "";
        return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }

    async createVersion(file: TFile, message: string, showNotification: boolean = false, tags: string[] = [], isManual: boolean = false) {
        await this.withLock(file.path, async () => {
             const rawContent = await this.app.vault.read(file);
             const content = this.normalizeText(rawContent);
             await this.createVersionInternal(file, message, showNotification, tags, isManual, content);
        });
    }

    private async createVersionInternal(file: TFile, message: string, showNotification: boolean, tags: string[], isManual: boolean, content: string) {
        try {
            const timestamp = Date.now();
            const id = `${timestamp}-${Math.random().toString(36).substring(2, 9)}`;
            const hash = this.hashContent(content);
            const currentHashOld = this.legacyStringHash(content); // 用于防冗余的兼容比对
            
            const versionFile = await this.loadVersionFile(file.path);
            
            if (this.settings.enableDeduplication) {
                const latestVersion = versionFile.versions[0];
                if (latestVersion && (latestVersion.hash === hash || latestVersion.hash === currentHashOld)) {
                    let contentReallyIdentical = false;
                    try {
                        const prevContent = await this.getVersionContent(file.path, latestVersion.id, true);
                        if (prevContent === content) {
                            contentReallyIdentical = true;
                        }
                    } catch (e: any) {
                        console.warn("Deduplication check: could not read previous version content", e);
                    }

                    if (contentReallyIdentical) {
                        if (isManual && latestVersion.message.includes('[Auto Save')) {
                            latestVersion.message = message;
                            latestVersion.timestamp = timestamp;
                            latestVersion.tags = tags.length > 0 ? tags : latestVersion.tags;

                            await this.saveVersionFile(file.path, versionFile);
                            this.versionCache.set(file.path, versionFile);
                            this.refreshVersionHistoryView();
                            this.updateStatusBar();
                            
                            if (showNotification && this.settings.showNotifications) {
                                new Notice(`✅ 版本已保存 (自动保存已更新)`);
                            }
                            return;
                        }

                        if (showNotification && this.settings.showNotifications) {
                            new Notice('ℹ️ 内容未变化,跳过创建版本');
                        }
                        return;
                    } else {
                        console.warn(`[VersionControl] Hash collision detected for ${file.path}. Saving new version.`);
                    }
                }
            }

            let newVersion: VersionData;
            let addedLines = 0;
            let removedLines = 0;

            if (versionFile.versions.length > 0) {
                try {
                    const previousContentRaw = await this.getVersionContent(file.path, versionFile.versions[0]!.id);
                    const previousContent = this.normalizeText(previousContentRaw);
                    
                    // 无条件强制附加 \n 确保底层统计换行符不出错
                    const safePrev = previousContent + '\n';
                    const safeCurr = content + '\n';
                    const diffResult = Diff.diffLines(safePrev, safeCurr);
                    
                    diffResult.forEach(part => {
                        if (part.added) addedLines += part.count || 0;
                        if (part.removed) removedLines += part.count || 0;
                    });
                } catch (e: any) {
                    console.warn("无法计算 Diff 统计", e);
                }
            } else {
                addedLines = content.split('\n').length;
            }

            let useIncremental = false;
            let diffStr = "";
            let baseVersionId = "";

            if (this.settings.enableIncrementalStorage && versionFile.versions.length > 0) {
                let continuousIncrementalCount = 0;
                for (const v of versionFile.versions) {
                    if (v.content !== undefined && v.content !== null && !v.diff) {
                        break;
                    }
                    continuousIncrementalCount++;
                }

                const shouldRebuildBase = (continuousIncrementalCount >= this.settings.rebuildBaseInterval);
                
                if (!shouldRebuildBase) {
                    try {
                        const prevVersionId = versionFile.versions[0]!.id;
                        const baseContentRaw = await this.getVersionContent(file.path, prevVersionId);
                        const baseContent = this.normalizeText(baseContentRaw);

                        const tempDiff = this.createDiff(baseContent, content);
                        
                        const testApply = Diff.applyPatch(baseContent, tempDiff);
                        
                        if (testApply !== false && this.normalizeText(testApply) === content) {
                            useIncremental = true;
                            diffStr = tempDiff;
                            baseVersionId = prevVersionId;
                        } else {
                            console.warn(`[VersionControl] 增量补丁验证失败，降级为完整版本。File: ${file.path}`);
                        }
                    } catch (err: any) {
                        console.error("生成增量版本时出错，降级为完整版本", err);
                        useIncremental = false;
                    }
                }
            }

            if (useIncremental) {
                newVersion = {
                    id, timestamp, message, 
                    diff: diffStr, 
                    baseVersionId: baseVersionId, 
                    size: diffStr.length, hash, // 使用新版本强 Hash 记录
                    tags: tags.length > 0 ? tags : undefined,
                    starred: false, addedLines, removedLines
                };
            } else {
                newVersion = {
                    id, timestamp, message, 
                    content: content,
                    size: content.length, hash,
                    tags: tags.length > 0 ? tags : undefined,
                    starred: false, addedLines, removedLines
                };
                
                if (!versionFile.baseVersion && versionFile.versions.length === 0) {
                    versionFile.baseVersion = content;
                }
            }

            versionFile.versions.unshift(newVersion);
            versionFile.lastModified = timestamp;

            if (this.settings.autoClear) {
                await this.cleanupVersionsInMemory(versionFile);
            }

            this.buildVersionIndex(versionFile);
            await this.saveVersionFile(file.path, versionFile);
            this.versionCache.set(file.path, versionFile);
            this.refreshVersionHistoryView();

            this.lastModifiedTime.set(file.path, timestamp);
            this.updateStatusBar();
            
            if (showNotification && this.settings.showNotifications) {
                new Notice(`✅ 版本已保存: ${message}`);
            }
        } catch (error: any) {
            console.error('保存版本失败:', error);
            new Notice('❌ 保存版本失败,请查看控制台');
        }
    }

    createDiff(oldContent: string, newContent: string): string { 
        const changes = Diff.createPatch('file', oldContent, newContent, '', ''); return changes;
    }
    applyDiff(baseContent: string, diffStr: string, suppressNotice: boolean = false): string { 
        try { const result = Diff.applyPatch(baseContent, diffStr); if (result === false) { console.error('应用差异补丁失败 (applyPatch returned false). 返回基础内容。'); if (!suppressNotice) { new Notice('应用差异补丁失败，版本内容可能不完整。'); } return baseContent; } return result; } catch (error: any) { console.error('应用差异时捕获到异常:', error); return baseContent; }
    }
    buildVersionIndex(versionFile: VersionFile) { 
        const index = new Map<string, number>(); versionFile.versions.forEach((version, idx) => { index.set(version.id, idx); }); versionFile.versionIndex = index;
    }
    
    // 使用迭代替代递归，解除增量恢复的 100 层深度限制
    resolveContentFromList(versions: VersionData[], versionId: string): string { 
        let currentId = versionId;
        let currentVersion = versions.find(v => v.id === currentId);
        if (!currentVersion) throw new Error(`无法在内存中找到版本: ${versionId}`);

        const patches: string[] = [];
        
        while (currentVersion) {
            if (currentVersion.content !== undefined && currentVersion.content !== null) {
                let content = this.normalizeText(currentVersion.content);
                // 逆向应用所有补丁
                for (let i = patches.length - 1; i >= 0; i--) {
                    const result = Diff.applyPatch(content, patches[i]!);
                    if (result === false) throw new Error("增量补丁应用失败");
                    content = this.normalizeText(result);
                }
                return content;
            } else if (currentVersion.diff && currentVersion.baseVersionId) {
                patches.push(currentVersion.diff);
                currentId = currentVersion.baseVersionId;
                currentVersion = versions.find(v => v.id === currentId);
            } else {
                throw new Error(`版本 ${currentId} 数据不完整`);
            }
        }
        throw new Error(`版本依赖链条断裂，无法追溯到完整基础版本。起点: ${versionId}`);
    }

    async cleanupVersionsInMemory(versionFile: VersionFile): Promise<number> {
        const originalCount = versionFile.versions.length;
        
        let versionsToKeep = versionFile.versions;
        const starredVersions = versionsToKeep.filter(v => v.starred);
        let nonStarredVersions = versionsToKeep.filter(v => !v.starred);

        if (this.settings.enableMaxVersions) {
            const maxNonStarred = Math.max(this.settings.maxVersions - starredVersions.length, 1);
            nonStarredVersions = nonStarredVersions.slice(0, maxNonStarred);
        }

        if (this.settings.enableMaxDays) {
            const cutoffTime = Date.now() - (this.settings.maxDays * 24 * 60 * 60 * 1000);
            nonStarredVersions = nonStarredVersions.filter(v => v.timestamp >= cutoffTime);
        }

        const proposedKeepSet = new Set([...starredVersions, ...nonStarredVersions].map(v => v.id));
        
        const proposedList = versionFile.versions.filter(v => proposedKeepSet.has(v.id));

        for (let i = proposedList.length - 1; i >= 0; i--) {
            const v = proposedList[i]!;
            
            if (v.diff && v.baseVersionId) {
                if (!proposedKeepSet.has(v.baseVersionId)) {
                    try {
                        console.log(`[VersionControl] 版本 ${v.id} 的基准将被清理，正在将其转换为完整版本...`);
                        
                        const fullContent = this.resolveContentFromList(versionFile.versions, v.id);
                        
                        v.content = fullContent;
                        v.diff = undefined;
                        v.baseVersionId = undefined;
                        v.size = fullContent.length;
                        
                    } catch (error: any) {
                        console.error(`[VersionControl] 严重错误：无法固化版本 ${v.id}，为防止数据丢失，取消本次清理。`, error);
                        new Notice(`⚠️ 自动清理中止：版本 ${v.id.substring(0,8)} 无法重构，这可能是由于数据链损坏。`);
                        return 0; 
                    }
                }
            }
        }

        versionFile.versions = proposedList;
        return originalCount - versionFile.versions.length;
    }

    // 智能迁移旧版本：在打开或修改文件时，如果发现由旧算法生成的文件，将其合并并升级到新文件
    async loadVersionFile(filePath: string): Promise<VersionFile> {
        if (this.versionCache.has(filePath)) {
            return this.versionCache.get(filePath)!;
        }

        const adapter = this.app.vault.adapter;
        const versionPath = this.getVersionFilePath(filePath); 
        let loadedContent: string | null = null;
        let finalVersionFile: VersionFile;

        if (await adapter.exists(versionPath)) {
            try {
                loadedContent = await this.readCompressedOrRaw(versionPath);
                finalVersionFile = JSON.parse(loadedContent) as VersionFile;
            } catch (e: any) {
                console.error("Failed to load new version file, will try to recover.", e);
                finalVersionFile = { filePath, versions: [], lastModified: Date.now() };
            }
        } else {
            finalVersionFile = { filePath, versions: [], lastModified: Date.now() };
        }

        const processOldFile = async (oldPath: string) => {
            if (await adapter.exists(oldPath)) {
                try {
                    const oldContent = await this.readCompressedOrRaw(oldPath);
                    const oldData = JSON.parse(oldContent) as VersionFile;
                    
                    if (finalVersionFile.versions.length === 0) {
                        console.log(`[VersionControl] Migrating (Rename): ${oldPath} -> ${versionPath}`);
                        finalVersionFile = oldData;
                        finalVersionFile.filePath = filePath;
                    } else {
                        console.log(`[VersionControl] Merging legacy file: ${oldPath} into ${versionPath}`);
                        const existingIds = new Set(finalVersionFile.versions.map(v => v.id));
                        let mergedCount = 0;
                        for (const v of oldData.versions) {
                            if (!existingIds.has(v.id)) {
                                finalVersionFile.versions.push(v);
                                mergedCount++;
                            }
                        }
                        if (mergedCount > 0) {
                            finalVersionFile.versions.sort((a, b) => b.timestamp - a.timestamp);
                            new Notice(`已合并 ${mergedCount} 条历史版本记录`);
                        }
                    }
                    
                    this.buildVersionIndex(finalVersionFile);
                    await this.saveVersionFile(filePath, finalVersionFile);
                    await adapter.remove(oldPath); 
                    console.log(`[VersionControl] Deleted legacy file: ${oldPath}`);

                } catch (e: any) {
                    console.error(`[VersionControl] Error processing legacy file ${oldPath}`, e);
                }
            }
        };

        const legacyPaths = [
            this.getLegacyHashVersionFilePath(filePath),
            this.getLegacyStrictAsciiVersionFilePath(filePath),
            this.getLegacyVersionFilePath(filePath)
        ];

        for (const lp of legacyPaths) {
            if (lp !== versionPath) {
                await processOldFile(lp);
            }
        }

        if (!finalVersionFile.versionIndex) {
            this.buildVersionIndex(finalVersionFile);
        }
        
        this.versionCache.set(filePath, finalVersionFile);
        return finalVersionFile;
    }

    // [FIX 1] 修复关闭压缩后旧历史版本的读取
    async readCompressedOrRaw(path: string): Promise<string> {
        const adapter = this.app.vault.adapter;
        if (!await adapter.exists(path)) return "";
        
        try {
            if (this.settings.enableCompression) {
                try {
                    const rawData = await adapter.readBinary(path);
                    return pako.ungzip(new Uint8Array(rawData), { to: 'string' });
                } catch (e: any) {
                    if (e.message && e.message.includes('incorrect header check')) {
                        // 如果不是压缩文件，尝试直接读取
                        return await adapter.read(path);
                    }
                    throw e; 
                }
            } else {
                try {
                    // 先尝试普通文本读取
                    const text = await adapter.read(path);
                    // 简单校验是否为预期的 JSON 文本
                    if (text && (text.trim().startsWith('{') || text.includes('"versions"'))) {
                        return text;
                    }
                } catch (e) {
                    // 读取文本失败（可能是乱码导致），忽略并在下方处理二进制解压
                }
                
                // Fallback：尝试按压缩文件格式读取并解压
                const rawData = await adapter.readBinary(path);
                return pako.ungzip(new Uint8Array(rawData), { to: 'string' });
            }
        } catch (error) {
            throw new Error(`无法读取或解压历史文件: ${path}`);
        }
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
                // [FIX 4] 截取准确的字节长度写入，防止底层写入大量空白缓冲浪费磁盘空间
                const safeBuffer = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength);
                await adapter.writeBinary(versionPath, safeBuffer);
            } else {
                await adapter.write(versionPath, content);
            }
        } catch (error: any) {
            console.error('保存版本文件失败:', error);
            throw error;
        }
    }

    sanitizeFileName(path: string): string {
        return path.replace(/[\/\\:*?"<>|]/g, '_');
    }

    async getAllVersions(filePath: string): Promise<VersionData[]> { try { const versionFile = await this.loadVersionFile(filePath); return versionFile.versions; } catch (error: any) { console.error('获取版本列表失败:', error); return []; } }
    
    // 彻底重写 getVersionContent 移除递归
    async getVersionContent(filePath: string, versionId: string, suppressNotice: boolean = false, strictMode: boolean = false): Promise<string> { 
        try { 
            const versionFile = await this.loadVersionFile(filePath); 
            
            let currentId = versionId;
            const patches: string[] = [];
            let baseContent = "";

            while (true) {
                const index = versionFile.versionIndex?.get(currentId);
                const version = index !== undefined ? versionFile.versions[index] : versionFile.versions.find(v => v.id === currentId);
                
                if (!version) throw new Error(`版本 ${currentId} 不存在`);

                if (version.content !== undefined && version.content !== null) {
                    baseContent = this.normalizeText(version.content);
                    break;
                }

                if (version.diff) {
                    patches.push(version.diff);
                    if (version.baseVersionId) {
                        currentId = version.baseVersionId;
                    } else if (versionFile.baseVersion !== undefined && versionFile.baseVersion !== null) {
                        baseContent = this.normalizeText(versionFile.baseVersion);
                        break;
                    } else {
                        throw new Error(`版本 ${currentId} 既无内容也无有效基准引用`);
                    }
                } else {
                    throw new Error(`无法获取版本 ${currentId} 的内容：缺少 content 和 diff`);
                }
            }

            let resultContent = baseContent;
            for (let i = patches.length - 1; i >= 0; i--) {
                const result = Diff.applyPatch(resultContent, patches[i]!);
                if (result === false) {
                    if (strictMode) throw new Error("增量补丁应用失败 (Patch Mismatch)");
                    console.warn(`[VersionControl] 版本增量还原失败: Diff Patch 不匹配。`);
                    if (!suppressNotice) new Notice(`⚠️ 版本 ${versionId.substring(0,8)} 数据损坏，仅显示基准内容。`);
                    return resultContent;
                }
                resultContent = this.normalizeText(result);
            }
            return resultContent;

        } catch (error: any) { 
            console.error('读取版本内容失败:', error); 
            throw new Error(`无法读取版本内容: ${error.message}`); 
        } 
    }

    async verifyVersionFileIntegrity(filePath: string): Promise<boolean> { const errors = await this.verifyFileVersion(filePath); return errors.length === 0; }
    
    async verifyFileVersion(filePath: string): Promise<string[]> {
        const errors: string[] = [];
        let versionPath = await this.findExistingVersionPath(filePath);
        
        if (!versionPath) return []; // Missing files return no error

        const adapter = this.app.vault.adapter;
        let versionFile: VersionFile;
        try {
            let content: string;
            if (this.settings.enableCompression) {
                try {
                    const rawData = await adapter.readBinary(versionPath);
                    content = pako.ungzip(new Uint8Array(rawData), { to: 'string' });
                } catch (e: any) {
                    try {
                        content = await adapter.read(versionPath);
                        JSON.parse(content);
                    } catch (e2: any) {
                        throw new Error("文件损坏：无法解压且不是有效的 JSON");
                    }
                }
            } else {
                content = await adapter.read(versionPath);
            }
            versionFile = JSON.parse(content) as VersionFile;
        } catch (error: any) {
            errors.push(`文件读取失败: ${error.message}`);
            return errors;
        }
        
        if (!versionFile.versions || !Array.isArray(versionFile.versions)) { errors.push("文件结构错误: versions 字段丢失或无效"); return errors; } 
        const versionMap = new Map<string, VersionData>(); 
        versionFile.versions.forEach(v => versionMap.set(v.id, v)); 
        for (const version of versionFile.versions) { 
            if (!version.id || !version.timestamp) { errors.push(`版本记录损坏: 缺少 ID 或时间戳`); continue; } 
            if (version.diff) { 
                if (!version.baseVersionId && !versionFile.baseVersion) { errors.push(`版本 ${version.id.substring(0,8)}: 是增量版本但缺少 baseVersionId`); } 
                else if (version.baseVersionId && !versionMap.has(version.baseVersionId)) { errors.push(`版本 ${version.id.substring(0,8)}: 依赖的基准版本 (${version.baseVersionId.substring(0,8)}) 丢失 (链条断裂)`); } 
            } else if (version.content === undefined) { 
                errors.push(`版本 ${version.id.substring(0,8)}: 既无 content 也无 diff，数据丢失`); 
            } 
            try { 
                const content = await this.getVersionContent(filePath, version.id, true, true); 
                if (version.hash) { 
                    const currentHash = this.hashContent(content); 
                    const oldHash = this.legacyStringHash(content); // 验证老 Hash 是否对应
                    if (currentHash !== version.hash && oldHash !== version.hash) { 
                        errors.push(`版本 ${version.id.substring(0,8)}: 哈希校验失败 (内容不匹配)`); 
                    } 
                } 
            } catch (e: any) { errors.push(`版本 ${version.id.substring(0,8)}: 内容还原失败 - ${e.message}`); } 
        }
        return errors;
    }

    async checkAllVersionsIntegrity() { 
        const adapter = this.app.vault.adapter; 
        const folderPath = this.settings.versionFolder; 
        if (!await adapter.exists(folderPath)) { new Notice("版本文件夹不存在，无需检查。"); return; } 
        const files = await adapter.list(folderPath); 
        const jsonFiles = files.files.filter(f => f.endsWith('.json')); 
        const total = jsonFiles.length; 
        const notice = new Notice(`正在检查完整性... 0/${total}`, 0); 
        const report: { filePath: string; errors: string[] }[] = []; 
        
        for (let i = 0; i < total; i++) { 
            const file = jsonFiles[i]!; 
            const rawFileName = file.replace(folderPath + '/', '').replace('.json', ''); 
            let originalFilePath = rawFileName; 
            try { 
                let contentStr = ""; 
                try { 
                    contentStr = await adapter.read(file); 
                    if (!contentStr.startsWith('{')) { 
                        const bin = await adapter.readBinary(file); 
                        contentStr = pako.ungzip(new Uint8Array(bin), { to: 'string' }); 
                    } 
                } catch(e: any) { /* ignore */ } 
                if (contentStr) { 
                    const vData = JSON.parse(contentStr) as VersionFile; 
                    if (vData.filePath) originalFilePath = vData.filePath; 
                } 
            } catch (e: any) { 
                report.push({ filePath: rawFileName, errors: ["文件完全无法读取/解压"] }); 
                continue; 
            } 
            const errors = await this.verifyFileVersion(originalFilePath); 
            if (errors.length > 0) { 
                report.push({ filePath: originalFilePath, errors }); 
            } 
            
            if (i % 5 === 0) { 
                notice.setMessage(`正在检查完整性... ${i + 1}/${total}`); 
                await new Promise(resolve => setTimeout(resolve, 5)); 
            } 
        } 
        notice.hide(); 
        new IntegrityReportModal(this.app, this, report).open(); 
    }

    async repairVersionFile(filePath: string): Promise<boolean> {
        return new Promise(async (resolve) => {
             await this.withLock(filePath, async () => {
                const versionFile = await this.loadVersionFile(filePath);
                let fixedCount = 0;
                if (!versionFile.versionIndex) { this.buildVersionIndex(versionFile); }
                for (const version of versionFile.versions) { 
                    if (version.hash) { 
                        try { 
                            const content = await this.getVersionContent(filePath, version.id, true); 
                            const currentHash = this.hashContent(content); 
                            if (currentHash !== version.hash && this.legacyStringHash(content) !== version.hash) { 
                                version.hash = currentHash; 
                                fixedCount++; 
                            } else if (this.legacyStringHash(content) === version.hash) {
                                // 顺便帮老版本升级到强哈希
                                version.hash = currentHash; 
                                fixedCount++; 
                            }
                        } catch (e: any) { console.warn(`Skipping repair for ${version.id}: content unreadable`); } 
                    } 
                }
                if (fixedCount > 0) { await this.saveVersionFile(filePath, versionFile); this.versionCache.set(filePath, versionFile); new Notice(`✅ 已修复并升级 ${fixedCount} 个版本记录的哈希值`); resolve(true); } else { new Notice(`ℹ️ 未发现可修复的哈希问题`); resolve(false); }
             });
        });
    }

    async updateVersionTags(filePath: string, versionId: string, tags: string[]) {
        await this.withLock(filePath, async () => {
            try {
                const versionFile = await this.loadVersionFile(filePath);
                const index = versionFile.versionIndex?.get(versionId);
                if (index !== undefined) {
                    versionFile.versions[index!]!.tags = tags.length > 0 ? tags : undefined;
                    await this.saveVersionFile(filePath, versionFile);
                    this.versionCache.set(filePath, versionFile);
                    this.refreshVersionHistoryView();
                }
            } catch (error: any) {
                console.error('更新版本标签失败:', error);
            }
        });
    }

    async updateVersionNote(filePath: string, versionId: string, note: string) {
        await this.withLock(filePath, async () => {
            try {
                const versionFile = await this.loadVersionFile(filePath);
                const index = versionFile.versionIndex?.get(versionId);
                if (index !== undefined) {
                    versionFile.versions[index!]!.note = note.trim() || undefined;
                    await this.saveVersionFile(filePath, versionFile);
                    this.versionCache.set(filePath, versionFile);
                    this.refreshVersionHistoryView();
                }
            } catch (error: any) {
                console.error('更新版本备注失败:', error);
            }
        });
    }

    async toggleVersionStar(filePath: string, versionId: string) {
        await this.withLock(filePath, async () => {
            try {
                const versionFile = await this.loadVersionFile(filePath);
                const index = versionFile.versionIndex?.get(versionId);
                if (index !== undefined) {
                    versionFile.versions[index!]!.starred = !versionFile.versions[index!]!.starred;
                    await this.saveVersionFile(filePath, versionFile);
                    this.versionCache.set(filePath, versionFile);
                    this.refreshVersionHistoryView();
                }
            } catch (error: any) {
                console.error('切换星标失败:', error);
            }
        });
    }

    async starLastVersion() { const file = this.app.workspace.getActiveFile(); if (!file) { new Notice('没有打开的文件'); return; } const versions = await this.getAllVersions(file.path); if (versions.length === 0) { new Notice('没有可标记的版本'); return; } await this.toggleVersionStar(file.path, versions[0]!.id); new Notice('⭐ 已标记/取消标记'); }
    async quickPreviewLastVersion() { const file = this.app.workspace.getActiveFile(); if (!file) { new Notice('没有打开的文件'); return; } const versions = await this.getAllVersions(file.path); if (versions.length === 0) { new Notice('没有历史版本可预览'); return; } new QuickPreviewModal(this.app, this, file, versions[0]!.id).open(); }

    async deleteVersion(filePath: string, versionId: string) {
        await this.withLock(filePath, async () => {
            try {
                const versionFile = await this.loadVersionFile(filePath);
                const isBaseForOthers = versionFile.versions.some(v => v.baseVersionId === versionId);
                if (isBaseForOthers) { new Notice('❌ 无法删除此版本，因为它被其他增量版本所依赖。', 7000); return; }
                versionFile.versions = versionFile.versions.filter(v => v.id !== versionId);
                versionFile.lastModified = Date.now();
                this.buildVersionIndex(versionFile);
                await this.saveVersionFile(filePath, versionFile);
                this.versionCache.set(filePath, versionFile);
                this.refreshVersionHistoryView();
            } catch (error: any) {
                console.error('删除版本失败:', error);
            }
        });
    }

    async deleteVersions(filePath: string, versionIds: string[]) {
        await this.withLock(filePath, async () => {
            try {
                const versionFile = await this.loadVersionFile(filePath);
                const idsSet = new Set(versionIds);
                const remainingVersions = versionFile.versions.filter(v => !idsSet.has(v.id));
                const isAnyDeletedVersionADependency = remainingVersions.some(v => v.baseVersionId && idsSet.has(v.baseVersionId));
                if (isAnyDeletedVersionADependency) { new Notice('❌ 批量删除失败：选中的版本中包含其他版本的依赖项。', 7000); return; }
                versionFile.versions = remainingVersions;
                versionFile.lastModified = Date.now();
                this.buildVersionIndex(versionFile);
                await this.saveVersionFile(filePath, versionFile);
                this.versionCache.set(filePath, versionFile);
                this.refreshVersionHistoryView();
            } catch (error: any) {
                console.error('批量删除版本失败:', error);
            }
        });
    }

    async restoreVersion(file: TFile, versionId: string) {
        this.isRestoring = true;
        try {
            await this.createVersion(file, '[Before Restore]', false);
            
            const content = await this.getVersionContent(file.path, versionId);
            await this.app.vault.modify(file, content);
            
            if (this.settings.showNotifications) {
                new Notice('✅ 版本已恢复');
            }
            this.refreshVersionHistoryView();
        } catch (error: any) {
            console.error('恢复版本失败:', error);
            new Notice('❌ 恢复版本失败');
        } finally {
            setTimeout(() => {
                this.isRestoring = false;
            }, 500);
        }
    }

    async restoreLastVersion() { const file = this.app.workspace.getActiveFile(); if (!file) { new Notice('没有打开的文件'); return; } const versions = await this.getAllVersions(file.path); if (versions.length === 0) { new Notice('没有可恢复的版本'); return; } const lastVersion = versions[0]!; new ConfirmModal(this.app, '恢复到上一版本', `确定要恢复到版本: ${this.formatTime(lastVersion.timestamp)}?\n\n当前未保存的修改将会丢失,插件会在恢复前自动创建备份版本。`, async () => { await this.restoreVersion(file!, lastVersion.id); }).open(); }
    async quickCompare() { const file = this.app.workspace.getActiveFile(); if (!file) { new Notice('没有打开的文件'); return; } const versions = await this.getAllVersions(file.path); if (versions.length === 0) { new Notice('没有历史版本可对比'); return; } const lastVersion = versions[0]!; new DiffModal(this.app, this, file!, lastVersion.id).open(); }
    async createFullSnapshot() { const files = this.app.vault.getMarkdownFiles(); const total = files.length; let count = 0; let skipped = 0; const progressNotice = new Notice(`正在准备全库版本... (0/${total})`, 0); const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)); for (let i = 0; i < total; i++) { const file = files[i]!; if (i % 10 === 0) { progressNotice.setMessage(`正在保存全库版本... (${i + 1}/${total})`); await sleep(10); } if (this.isExcluded(file.path)) { skipped++; continue; } try { await this.createVersion(file!, '[Full Snapshot]', false, [], true); count++; } catch (error: any) { console.error(`创建版本失败: ${file.path}`, error); } } progressNotice.hide(); if (this.settings.showNotifications) { setTimeout(() => { new Notice(`✅ 全库版本创建完成\n处理: ${count} 个文件${skipped > 0 ? `\n跳过: ${skipped} 个文件` : ''}`); }, 500); } }
    async optimizeAllVersionFiles() { const progressNotice = new Notice('正在优化存储...', 0); try { const adapter = this.app.vault.adapter; const versionFolder = this.settings.versionFolder; if (!await adapter.exists(versionFolder)) { progressNotice.hide(); new Notice('版本文件夹不存在'); return; } const files = await adapter.list(versionFolder); let optimized = 0; let savedBytes = 0; for (const file of files.files) { if (file.endsWith('.json')) { try { const oldSize = (await adapter.stat(file))?.size || 0; const filePath = file.replace(this.settings.versionFolder + '/', '').replace('.json', ''); const versionFile = await this.loadVersionFile(filePath); this.buildVersionIndex(versionFile); await this.saveVersionFile(versionFile.filePath, versionFile); const newSize = (await adapter.stat(file))?.size || 0; savedBytes += (oldSize - newSize); optimized++; } catch (error: any) { console.error('优化文件失败:', file, error); } } } progressNotice.hide(); new Notice(`✅ 优化完成\n处理: ${optimized} 个文件\n节省: ${this.formatFileSize(savedBytes)}`); } catch (error: any) { progressNotice.hide(); console.error('优化失败:', error); new Notice('❌ 优化失败'); } }
    async getStorageStats(): Promise<{ totalSize: number; versionCount: number; fileCount: number; compressionRatio: number; starredCount: number; taggedCount: number }> { const adapter = this.app.vault.adapter; const versionFolder = this.settings.versionFolder; try { if (!await adapter.exists(versionFolder)) { return { totalSize: 0, versionCount: 0, fileCount: 0, compressionRatio: 0, starredCount: 0, taggedCount: 0 }; } const files = await adapter.list(versionFolder); let totalSize = 0; let versionCount = 0; let fileCount = 0; let totalOriginalSize = 0; let starredCount = 0; let taggedCount = 0; for (const file of files.files) { if (file.endsWith('.json')) { try { const stat = await adapter.stat(file); const fileSize = stat?.size || 0; totalSize += fileSize; let versionFile: VersionFile; if (this.settings.enableCompression) { try { const rawData = await adapter.readBinary(file); const decompressed = pako.ungzip(new Uint8Array(rawData), { to: 'string' }); versionFile = JSON.parse(decompressed) as VersionFile; } catch (e: any) { const content = await adapter.read(file); versionFile = JSON.parse(content) as VersionFile; } } else { const content = await adapter.read(file); versionFile = JSON.parse(content) as VersionFile; } if (versionFile.versions && Array.isArray(versionFile.versions)) { versionCount += versionFile.versions.length; versionFile.versions.forEach(v => { if (v.content) { totalOriginalSize += v.content.length; } else if (v.diff) { totalOriginalSize += v.diff.length; } if (v.starred) starredCount++; if (v.tags && v.tags.length > 0) taggedCount++; }); fileCount++; } } catch (error: any) { console.error('读取版本文件失败:', file, error); } } } const compressionRatio = totalOriginalSize > 0 ? ((1 - totalSize / totalOriginalSize) * 100) : 0; return { totalSize, versionCount, fileCount, compressionRatio, starredCount, taggedCount }; } catch (error: any) { console.error('获取存储统计失败:', error); return { totalSize: 0, versionCount: 0, fileCount: 0, compressionRatio: 0, starredCount: 0, taggedCount: 0 }; } }
    async exportVersions(filePath: string): Promise<void> { try { const versionFile = await this.loadVersionFile(filePath); const exportPath = `${this.settings.versionFolder}/export_${this.sanitizeFileName(filePath)}_${Date.now()}.json`; await this.app.vault.adapter.write(exportPath, JSON.stringify(versionFile, null, 2)); new Notice(`✅ 版本已导出到: ${exportPath}`); } catch (error: any) { console.error('导出版本失败:', error); new Notice('❌ 导出失败'); } }
    async exportVersionAsFile(filePath: string, versionId: string): Promise<void> { try { const content = await this.getVersionContent(filePath, versionId); const fileName = filePath.replace(/\.[^/.]+$/, ''); const exportPath = `${fileName}_v${versionId.substring(0,8)}.md`; await this.app.vault.create(exportPath, content); new Notice(`✅ 版本已导出为: ${exportPath}`); } catch (error: any) { console.error('导出版本为文件失败:', error); new Notice('❌ 导出失败'); } }
    
    // 移除全库文件内容读取，改用 mtime 快速比对，交出主线程防止卡顿
    async getModifiedFiles(): Promise<{ file: TFile, lastVersionTime: number }[]> {
        const files = this.app.vault.getMarkdownFiles();
        const modifiedFiles: { file: TFile, lastVersionTime: number }[] = [];

        let count = 0;
        for (const file of files) {
            if (this.isExcluded(file.path)) continue;

            count++;
            if (count % 50 === 0) await new Promise(r => setTimeout(r, 0));

            const versionPath = await this.findExistingVersionPath(file.path);

            if (versionPath) {
                try {
                    const stat = await this.app.vault.adapter.stat(versionPath);
                    if (!stat) continue;
                    
                    if (file.stat.mtime > stat.mtime + 2000) {
                        const versionFile = await this.loadVersionFile(file.path);
                        const lastTime = versionFile.versions.length > 0 ? versionFile.versions[0]!.timestamp : 0;
                        modifiedFiles.push({ file, lastVersionTime: lastTime });
                    }
                } catch (e: any) {
                    console.error(`Error checking modified file ${file.path}`, e);
                }
            } else {
                modifiedFiles.push({ file, lastVersionTime: 0 });
            }
        }
        
        return modifiedFiles.sort((a, b) => b.file.stat.mtime - a.file.stat.mtime);
    }

    // 按文件修改时间排序，只读取最近修改过的30个文件，避免解析全库巨型 JSON 卡死
    async getGlobalHistory(limit: number = 100): Promise<{ version: VersionData, filePath: string, file: TFile | null }[]> {
        const adapter = this.app.vault.adapter;
        const versionFolder = this.settings.versionFolder;
        
        if (!await adapter.exists(versionFolder)) return [];

        const filesData = await adapter.list(versionFolder);
        const jsonFiles = filesData.files.filter(f => f.endsWith('.json'));
        
        const fileStats = await Promise.all(jsonFiles.map(async file => {
            const stat = await adapter.stat(file);
            return { file, mtime: stat ? stat.mtime : 0 };
        }));
        fileStats.sort((a, b) => b.mtime - a.mtime);

        const targetFiles = fileStats.slice(0, 30).map(item => item.file);

        const allVersions: { version: VersionData, filePath: string, file: TFile | null }[] = [];

        let count = 0;
        for (const vFile of targetFiles) {
            count++;
            if (count % 5 === 0) await new Promise(r => setTimeout(r, 0));

            try {
                const contentStr = await this.readCompressedOrRaw(vFile);
                if (!contentStr) continue;
                
                const data = JSON.parse(contentStr) as VersionFile;
                if (!data.versions) continue;

                const tFile = this.app.vault.getAbstractFileByPath(data.filePath);
                
                const relevantVersions = data.versions.slice(0, 10); 

                relevantVersions.forEach(v => {
                    allVersions.push({
                        version: v,
                        filePath: data.filePath,
                        file: (tFile instanceof TFile) ? tFile : null
                    });
                });

            } catch (e: any) {
                // ignore errors
            }
        }

        allVersions.sort((a, b) => b.version.timestamp - a.version.timestamp);
        return allVersions.slice(0, limit);
    }

    formatFileSize(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`; return `${(bytes / (1024 * 1024)).toFixed(2)} MB`; }
    
    countWords(str: string): number {
        if (!str) return 0;
        const cjkMatches = str.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g);
        const cjkCount = cjkMatches ? cjkMatches.length : 0;
        const westernStr = str.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ');
        const westernMatches = westernStr.match(/[a-zA-Z0-9_]+/g);
        const westernCount = westernMatches ? westernMatches.length : 0;
        return cjkCount + westernCount;
    }

    formatTime(timestamp: number): string { if (this.settings.useRelativeTime) { return this.getRelativeTime(timestamp); } return new Date(timestamp).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    getRelativeTime(timestamp: number): string { const diff = Date.now() - timestamp; const seconds = Math.floor(diff / 1000); const minutes = Math.floor(seconds / 60); const hours = Math.floor(minutes / 60); const days = Math.floor(hours / 24); const months = Math.floor(days / 30); const years = Math.floor(days / 365); if (years > 0) return `${years} 年前`; if (months > 0) return `${months} 个月前`; if (days > 0) return `${days} 天前`; if (hours > 0) return `${hours} 小时前`; if (minutes > 0) return `${minutes} 分钟前`; if (seconds < 10) return '刚刚'; return `${seconds} 秒前`; }
    refreshVersionHistoryView() { const leaves = this.app.workspace.getLeavesOfType('version-history'); leaves.forEach(leaf => { if (leaf.view instanceof VersionHistoryView) { leaf.view.refresh(); } }); }
}

class QuickPreviewModal extends Modal {
    plugin: VersionControlPlugin;
    file: TFile;
    versionId: string;
    
    private isRenderedView: boolean = true;
    private contentContainer: HTMLElement;
    private versionContent: string;
    private toggleButton: HTMLButtonElement;

    constructor(App: App, plugin: VersionControlPlugin, file: TFile, versionId: string) {
        super(App);
        this.plugin = plugin;
        this.file = file;
        this.versionId = versionId;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.addClass('quick-preview-modal');
        
        const style = document.createElement('style');
        style.textContent = `
            .quick-preview-modal .preview-content-container,
            .quick-preview-modal pre,
            .quick-preview-modal code,
            .quick-preview-modal .preview-rendered-content {
                user-select: text !important;
                -webkit-user-select: text !important;
                cursor: text;
            }
            
            .quick-preview-modal .preview-content-container {
                margin: 15px 0;
                max-height: 60vh;
                overflow-y: auto;
                border: 1px solid var(--background-modifier-border);
                border-radius: 6px;
                background: var(--background-primary);
            }
            .quick-preview-modal .preview-rendered-content {
                padding: 15px;
            }
            
            .quick-preview-modal .preview-raw-container {
                display: flex;
                flex-direction: column;
                background: var(--background-primary-alt);
                padding: 15px 0;
                overflow-x: hidden;
            }
            .quick-preview-modal .preview-line-row {
                display: flex;
                flex-direction: row;
                width: 100%;
            }
            .quick-preview-modal .preview-line-number {
                min-width: 45px;
                padding-right: 12px;
                padding-left: 10px;
                border-right: 1px solid var(--background-modifier-border);
                color: var(--text-muted);
                text-align: right;
                user-select: none;
                font-family: var(--font-monospace);
                font-size: var(--font-ui-small);
                flex-shrink: 0;
                line-height: 1.6;
            }
            .quick-preview-modal .preview-line-code {
                font-family: var(--font-monospace);
                font-size: var(--font-ui-small);
                line-height: 1.6;
                white-space: pre-wrap; 
                word-break: break-word; 
                padding-left: 15px;
                padding-right: 15px;
                flex-grow: 1;
                min-height: 1.6em; 
            }
            
            .quick-preview-modal .preview-header { margin-bottom: 15px; }
            .quick-preview-modal .preview-toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
            .quick-preview-modal .preview-stats-bar { display: flex; gap: 15px; font-size: 0.9em; color: var(--text-muted); margin-top: 10px;}
        `;
        contentEl.appendChild(style);

        try {
            this.versionContent = await this.plugin.getVersionContent(this.file.path, this.versionId);
            const versions = await this.plugin.getAllVersions(this.file.path);
            const version = versions.find(v => v.id === this.versionId);

            const header = contentEl.createEl('div', { cls: 'preview-header' });
            header.createEl('h2', { text: '📄 快速预览' });
            
            if (version) {
                const info = header.createEl('div', { cls: 'preview-info' });
                info.createEl('span', { text: `⏰ ${this.plugin.formatTime(version.timestamp)}`, cls: 'preview-time' });
                info.createEl('span', { text: `💬 ${version.message}`, cls: 'preview-message', attr: {style: 'margin-left: 10px;'} });
                info.createEl('span', { text: `📦 ${this.plugin.formatFileSize(version.size)}`, cls: 'preview-size', attr: {style: 'margin-left: 10px;'} });
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
            
            const words = this.plugin.countWords(this.versionContent);
            statsBar.createEl('span', { text: `📄 ${words.toLocaleString()} 词` });

        } catch (error: any) {
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
            lines.forEach((line, index) => {
                const row = rawContainer.createEl('div', { cls: 'preview-line-row' });
                row.createEl('div', { text: String(index + 1), cls: 'preview-line-number' });
                const code = row.createEl('div', { cls: 'preview-line-code' });
                code.setText(line); 
            });
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
    
    currentViewMode: ViewMode = 'current';

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
                if (this.currentViewMode === 'current') {
                    const activeFile = this.app.workspace.getActiveFile();
                    if (activeFile && (!this.currentFile || this.currentFile.path !== activeFile.path)) {
                        this.currentPage = 0;
                        this.refresh();
                    } else if (!activeFile && this.currentFile) {
                        this.currentFile = null;
                        this.refresh();
                    }
                }
            })
        );
        
        // 监听文件重命名，自动刷新侧边栏引用
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (this.currentViewMode === 'current' && this.currentFile && oldPath === this.currentFile.path) {
                    if (file instanceof TFile) {
                        this.currentFile = file; 
                        this.refresh();
                    }
                }
            })
        );
        
        this.addStyles();
        await this.refresh();
    }

    addStyles() {
        if (!document.getElementById('vc-tab-styles')) {
            const style = document.createElement('style');
            style.id = 'vc-tab-styles';
            style.textContent = `
                .version-history-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
                .vc-tab-bar { flex-shrink: 0; display: flex; justify-content: flex-start; border-bottom: 1px solid var(--background-modifier-border); margin-bottom: 10px; padding-bottom: 5px; gap: 10px; align-items: center; }
                .vc-tab-btn { background: transparent; border: none; border-bottom: 2px solid transparent; cursor: pointer; padding: 6px 12px; font-weight: bold; color: var(--text-muted); }
                .vc-tab-btn:hover { color: var(--text-normal); }
                .vc-tab-btn.mod-cta { color: var(--text-accent); border-bottom-color: var(--text-accent); background-color: var(--background-secondary); }
                .vc-content-area { flex-grow: 1; overflow-y: auto; padding-right: 5px; }
                .vc-batch-bar { display: flex; justify-content: flex-end; padding: 4px; background: var(--background-secondary); border-radius: 4px; margin-bottom: 10px; }
                .internal-link { color: var(--text-accent); text-decoration: none; cursor: pointer; }
                .internal-link:hover { text-decoration: underline; }
                
                /* 全局刷新按钮与旋转动画 */
                .vc-global-refresh { background: transparent; border: none; box-shadow: none; cursor: pointer; color: var(--text-muted); padding: 4px; border-radius: 4px; display: flex; align-items: center; justify-content: center; margin-left: auto; height: 100%; }
                .vc-global-refresh:hover { color: var(--text-normal); background-color: var(--background-modifier-hover); }
                .vc-global-refresh.is-spinning svg { animation: vc-spin 1s linear infinite; color: var(--text-accent); }
                @keyframes vc-spin { 100% { transform: rotate(360deg); } }
            `;
            document.head.appendChild(style);
        }
    }

    updateRelativeTimes() {
        if (!this.plugin.settings.useRelativeTime) return;

        const container = this.contentEl; 
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
        
        const version = versionFile.versions[versionIndex!];
        if (!version || (typeof version.addedLines === 'number' && typeof version.removedLines === 'number' && typeof version.modifiedLines === 'number')) {
            return;
        }
    
        try {
            const currentContent = await this.plugin.getVersionContent(versionFile.filePath, version.id, true);
            const previousVersion = versionFile.versions[versionIndex! + 1];
            
            let added = 0;
            let removed = 0;
            let modified = 0;
    
            if (previousVersion) {
                const previousContent = await this.plugin.getVersionContent(versionFile.filePath, previousVersion.id, true);
                
                // 强制附加 \n 确保底层统计换行符不出错
                const safePrev = previousContent + '\n';
                const safeCurr = currentContent + '\n';
                
                // 使用自带的紧凑算法计算
                const diffResult = this.plugin.getCompactDiffLines(safePrev, safeCurr, true);
                
                for (let i = 0; i < diffResult.length; i++) {
                    const part = diffResult[i]!;
                    const nextPart = diffResult[i + 1];

                    const isRemoveAdd = part.removed && nextPart?.added;
                    const isAddRemove = part.added && nextPart?.removed;

                    if (isRemoveAdd || isAddRemove) {
                        const removedPart = isRemoveAdd ? part : nextPart!;
                        const addedPart = isRemoveAdd ? nextPart! : part;
                        
                        const leftLines = removedPart.value.replace(/\n$/, '').split('\n');
                        const rightLines = addedPart.value.replace(/\n$/, '').split('\n');
                        const stats = this.plugin.calculateCompactBlockStats(leftLines, rightLines);
                        
                        modified += stats.mods;
                        removed += stats.rems;
                        added += stats.adds;
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
        } catch (error: any) {
            version.addedLines = 0;
            version.removedLines = 0;
            version.modifiedLines = 0;
        }
    }


    async refresh() {
        if (this.isRefreshing) return;
        this.isRefreshing = true;

        const realContainer = this.contentEl;
        
        const currentScrollArea = realContainer.querySelector('.vc-content-area');
        const scrollTop = currentScrollArea ? currentScrollArea.scrollTop : 0;

        try {
            const buffer = createDiv();
            buffer.addClass('version-history-view');

            this.renderTabs(buffer);

            const contentContainer = buffer.createEl('div', { cls: 'vc-content-area' });
            
            if (this.currentViewMode === 'current') {
                await this.renderCurrentFileHistory(contentContainer);
            } else if (this.currentViewMode === 'modified') {
                await this.renderModifiedFiles(contentContainer);
            } else if (this.currentViewMode === 'global') {
                await this.renderGlobalHistory(contentContainer);
            }

            realContainer.empty();
            realContainer.appendChild(buffer);

            const newScrollArea = realContainer.querySelector('.vc-content-area');
            if (newScrollArea && scrollTop > 0) {
                newScrollArea.scrollTop = scrollTop;
            }

        } catch (error: any) {
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

        // 引入全局动态刷新按钮
        const refreshBtn = tabBar.createEl('button', { 
            cls: 'vc-global-refresh', 
            attr: { 'aria-label': '强制刷新当前视图', 'title': '刷新' } 
        });
        setIcon(refreshBtn, 'refresh-cw'); 
        
        refreshBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            if (this.isRefreshing) return; 
            
            refreshBtn.addClass('is-spinning'); 
            
            if (this.currentViewMode === 'current' && this.currentFile) {
                this.plugin.versionCache.delete(this.currentFile.path);
            } else if (this.currentViewMode === 'global' || this.currentViewMode === 'modified') {
                this.plugin.versionCache.clear(); 
            }

            await this.refresh(); 
            
            setTimeout(() => {
                refreshBtn.removeClass('is-spinning');
            }, 300);
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
        } catch (error: any) { console.error('获取文件信息失败:', error); }

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
        
        // 增加分页越界保护
        if (this.currentPage >= totalPages) {
            this.currentPage = Math.max(0, totalPages - 1);
        }

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
            groupedVersions[group]!.push(version);
        });

        for (const groupName in groupedVersions) {
            listContainer.createEl('h4', { text: groupName, cls: 'version-group-header' });
            const versionsInGroup = groupedVersions[groupName]!;
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

        const modifiedFiles = await this.plugin.getModifiedFiles();

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
                        new DiffModal(this.app, this.plugin, file, versions[0]!.id).open();
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
    }

    async renderGlobalHistory(container: HTMLElement) {
        container.createEl('h3', { text: '🌍 全库版本时间轴' });

        const history = await this.plugin.getGlobalHistory(100); 

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
            const oldest = versions[versions.length - 1]!.timestamp;
            const newest = versions[0]!.timestamp;
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
                setTimeout(() => {
                    if (text.inputEl) {
                        text.inputEl.focus();
                    }
                }, 50);
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

type ProcessedDiff = {
    type: 'context' | 'added' | 'removed' | 'modified';
} & Diff.Change;

class DiffModal extends Modal {
    plugin: VersionControlPlugin;
    file: TFile;
    versionId: string;
    secondVersionId: string;
    currentDiffIndex: number = 0;
    totalDiffs: number = 0;
    diffElements: HTMLElement[] = [];
    collapsedSections: Set<number> = new Set();
    ignoreWhitespace: boolean = true;
    showLineNumbers: boolean = true;
    wrapLines: boolean = true;
    leftContent: string = '';
    rightContent: string = '';
    currentGranularity: 'char' | 'word' | 'line'; 
    contextLines: number;
    showWhitespace: boolean = false;

    private textDiffContainer: HTMLElement;
    private allVersions: VersionData[] = [];
    private infoBannerContainer: HTMLElement;
    private loadingOverlay: HTMLElement;
    private resizeHandler: () => void;

    constructor(app: App, plugin: VersionControlPlugin, file: TFile, versionId: string, secondVersionId?: string) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.versionId = versionId;
        this.secondVersionId = secondVersionId || 'current';
        this.currentGranularity = this.plugin.settings.diffGranularity;
        this.contextLines = this.plugin.settings.diffContextLines;
        this.resizeHandler = () => {
             if (this.textDiffContainer && this.textDiffContainer.hasClass('diff-split')) {
                this.alignSplitViewLines();
            }
        };
    }

    visualizeWhitespace(text: string): string {
        return text.replace(/\t/g, '→   ').replace(/ /g, '·');
    }

    diffWordsCJK(text1: string, text2: string): Diff.Change[] {
        // 以空格、制表符、换行、常见中英文标点为界限进行切块
        // 保留分隔符，以便还原完整字符串
        const tokenize = (str: string) => str.split(/([ \t\n\r]+|[，。！？；：、()（）""'']+)/).filter(Boolean);
        const tokens1 = tokenize(text1);
        const tokens2 = tokenize(text2);
        
        // 使用 diffArrays 对切好的块进行对比
        const result = Diff.diffArrays(tokens1, tokens2);
        
        // 转换回标准的 Diff.Change 格式
        return result.map(part => {
            const textValue = part.value ? part.value.join('') : '';
            return {
                count: textValue.length,
                added: part.added || false,
                removed: part.removed || false,
                value: textValue
            };
        }) as Diff.Change[];
    }

    async onOpen() {
        const { contentEl, modalEl } = this; 
        contentEl.addClass('diff-modal');

        const styleId = 'version-control-diff-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                /* 标题栏布局 */
                .diff-modal-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    margin-bottom: 12px;
                    padding-bottom: 8px;
                    border-bottom: 1px solid var(--background-modifier-border);
                }
                .diff-modal-title-group {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                    flex-grow: 1;
                    overflow: hidden;
                }
                .diff-modal-title {
                    margin: 0 !important;
                    line-height: 1.2;
                }
                .diff-file-path {
                    font-size: 0.8em;
                    color: var(--text-muted);
                    font-family: var(--font-monospace);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .diff-header-actions {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-left: 10px;
                }
                .diff-fullscreen-btn {
                    background: transparent;
                    border: none;
                    box-shadow: none;
                    padding: 4px 8px;
                    cursor: pointer;
                    opacity: 0.7;
                    transition: opacity 0.2s;
                    font-size: 1.2em;
                }
                .diff-fullscreen-btn:hover {
                    opacity: 1;
                    background-color: var(--background-modifier-hover);
                    border-radius: 4px;
                }

                /* 基础 Diff 行布局调整 (原有样式) */
                .diff-line {
                    display: flex !important;
                    align-items: stretch !important; 
                    flex-direction: row !important;
                    padding-left: 0 !important; 
                }
                
                /* 新的侧边栏容器 (Gutter) */
                .diff-gutter-column {
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    align-items: center;
                    min-width: 48px; 
                    padding: 2px 4px;
                    background-color: var(--background-secondary);
                    border-right: 1px solid var(--background-modifier-border);
                    margin-right: 8px;
                    flex-shrink: 0;
                    user-select: none !important;
                    -webkit-user-select: none !important;
                }

                /* 第一排：行号 */
                .diff-gutter-nums {
                    display: flex;
                    justify-content: center;
                    gap: 4px;
                    font-family: var(--font-monospace);
                    font-size: 0.65em;
                    color: var(--text-muted);
                    line-height: 1.2;
                    margin-bottom: 2px;
                    width: 100%;
                }

                /* 第二排：操作按钮 */
                .diff-gutter-ops {
                    display: flex;
                    justify-content: center;
                    gap: 6px;
                    line-height: 1;
                    font-size: 0.85em;
                    width: 100%;
                    opacity: 0.6;
                    transition: opacity 0.2s;
                }
                .diff-gutter-ops:hover {
                    opacity: 1;
                }

                /* 允许选择属性 */
                .diff-line .line-content {
                    padding-top: 4px; 
                    padding-bottom: 4px;
                    flex-grow: 1;
                    word-break: break-all;
                    user-select: text !important;
                    -webkit-user-select: text !important;
                    cursor: text;
                }
                
                .diff-word-added, .diff-word-removed {
                    user-select: text !important;
                    -webkit-user-select: text !important;
                    text-decoration: none !important; 
                }
                
                .diff-line-bg-removed .line-content {
                     text-decoration: none !important;
                }

                /* 标记符号 (+/-) 的位置 */
                .diff-line .diff-marker {
                    margin-right: 6px;
                    opacity: 0.5;
                    font-family: var(--font-monospace);
                    align-self: center;
                    user-select: none !important;
                    -webkit-user-select: none !important;
                }
            `;
            contentEl.appendChild(style);
        }
        
        if (Platform.isMobile) {
            contentEl.addClass('is-mobile');
            const mobileStyleId = 'version-control-diff-styles-mobile';
            if (!document.getElementById(mobileStyleId)) {
                const style = document.createElement('style');
                style.id = mobileStyleId;
                style.textContent = `
                    .is-mobile .diff-line.actions-visible .line-number-container {
                        width: auto !important;
                        min-width: 45px !important;
                        display: flex !important;
                        flex-direction: row !important;
                        align-items: center !important;
                        justify-content: flex-start !important;
                        background: var(--background-primary);
                        z-index: 5;
                    }
                    .is-mobile .diff-line.actions-visible .line-number {
                        display: inline-block !important;
                        opacity: 1 !important;
                        margin-right: 4px !important;
                        font-size: 0.7em !important;
                    }
                `;
                contentEl.appendChild(style);
            }
        }

        window.addEventListener('resize', this.resizeHandler);

        const headerContainer = contentEl.createEl('div', { cls: 'diff-modal-header' });
        
        const titleGroup = headerContainer.createEl('div', { cls: 'diff-modal-title-group' });
        titleGroup.createEl('h2', { text: '📊 版本差异对比', cls: 'diff-modal-title' });
        titleGroup.createEl('div', { text: this.file.path, cls: 'diff-file-path', attr: { title: this.file.path } });

        const headerActions = headerContainer.createEl('div', { cls: 'diff-header-actions' });
        
        const saveNewVersionBtn = headerActions.createEl('button', { 
            cls: 'diff-fullscreen-btn', 
            attr: { 'aria-label': '保存当前文件为新版本', 'title': '保存新版本' } 
        });
        saveNewVersionBtn.innerHTML = '💾'; 
        saveNewVersionBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const currentModalContainer = this.modalEl.parentElement;
            if (currentModalContainer) {
                currentModalContainer.style.display = 'none';
            }

            const msgModal = new VersionMessageModal(this.app, this.plugin.settings, async (message, tags) => {
                saveNewVersionBtn.innerHTML = '⏳';
                saveNewVersionBtn.disabled = true;
                try {
                    await this.plugin.createVersion(this.file, message, true, tags, true);
                    this.allVersions = await this.plugin.getAllVersions(this.file.path);
                    this.updateSelectorButtonLabels();
                    
                    if (this.versionId === 'current' || this.secondVersionId === 'current') {
                        await this.updateDiffView();
                    }
                } catch (err: any) {
                    console.error("保存新版本或刷新视图失败", err);
                } finally {
                    saveNewVersionBtn.innerHTML = '💾';
                    saveNewVersionBtn.disabled = false;
                }
            });

            const originalOnClose = msgModal.onClose.bind(msgModal);
            msgModal.onClose = () => {
                originalOnClose();
                if (currentModalContainer) {
                    currentModalContainer.style.display = '';
                }
            };

            msgModal.open();
        });

        const togglePanelBtn = headerActions.createEl('button', { 
            cls: 'diff-fullscreen-btn', 
            attr: { 'aria-label': '收起统计与工具栏', 'title': '收起统计与工具栏' } 
        });
        setIcon(togglePanelBtn, 'chevron-up');

        const controlsContainer = contentEl.createEl('div');
        const mainContainer = contentEl.createEl('div', { cls: 'diff-main-container' });
        this.textDiffContainer = mainContainer.createEl('div', { cls: 'diff-container' });

        this.loadingOverlay = mainContainer.createEl('div', { cls: 'diff-loading-overlay', attr: { style: 'display: none;' } });
        this.loadingOverlay.createEl('div', { text: '正在加载新版本...', cls: 'diff-loading-message' });

        try {
            this.allVersions = await this.plugin.getAllVersions(this.file.path);
        } catch (error: any) {
            new Notice('❌ 加载版本列表失败');
            this.close();
            return;
        }

        this.renderVersionSelectors(controlsContainer);

        const collapsiblePanel = controlsContainer.createEl('div');
        
        let panelVisible = true;
        togglePanelBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            panelVisible = !panelVisible;
            if (panelVisible) {
                collapsiblePanel.style.display = '';
                setIcon(togglePanelBtn, 'chevron-up');
                togglePanelBtn.setAttribute('title', '收起统计与工具栏');
                togglePanelBtn.setAttribute('aria-label', '收起统计与工具栏');
            } else {
                collapsiblePanel.style.display = 'none';
                setIcon(togglePanelBtn, 'chevron-down');
                togglePanelBtn.setAttribute('title', '展开统计与工具栏');
                togglePanelBtn.setAttribute('aria-label', '展开统计与工具栏');
            }
        });
        
        this.infoBannerContainer = collapsiblePanel.createEl('div', { cls: 'diff-info-banner-compact' });

        const toolbar = collapsiblePanel.createEl('div', { cls: 'diff-toolbar-redesigned' });
        
        const navGroup = toolbar.createEl('div', { cls: 'diff-toolbar-group', attr: { id: 'diff-nav-group' } });
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

            menu.addItem(item => item.setTitle('行内差异算法').setDisabled(true));
            menu.addItem(item => item.setTitle('按单词').setChecked(this.plugin.settings.inlineDiffAlgorithm === 'word').onClick(async () => {
                this.plugin.settings.inlineDiffAlgorithm = 'word';
                await this.plugin.saveSettings();
                this.renderTextDiff();
            }));
            menu.addItem(item => item.setTitle('按字符').setChecked(this.plugin.settings.inlineDiffAlgorithm === 'char').onClick(async () => {
                this.plugin.settings.inlineDiffAlgorithm = 'char';
                await this.plugin.saveSettings();
                this.renderTextDiff();
            }));
            menu.addItem(item => item.setTitle('按行').setChecked(this.plugin.settings.inlineDiffAlgorithm === 'line').onClick(async () => {
                this.plugin.settings.inlineDiffAlgorithm = 'line';
                await this.plugin.saveSettings();
                this.renderTextDiff();
            }));

            menu.addSeparator();
            menu.addItem(item => item.setTitle('视图模式').setDisabled(true));
            const modeSelect = this.containerEl.querySelector('.diff-select[aria-label="视图模式"]') as HTMLSelectElement;
            menu.addItem(item => item.setTitle('统一视图').setChecked(modeSelect.value === 'unified').onClick(() => { modeSelect.value = 'unified'; modeSelect.dispatchEvent(new Event('change')); }));
            menu.addItem(item => item.setTitle('左右分栏').setChecked(modeSelect.value === 'split').onClick(() => { modeSelect.value = 'split'; modeSelect.dispatchEvent(new Event('change')); }));

            menu.addItem(item => item.setTitle('紧凑型统一视图')
                .setChecked(this.plugin.settings.compactUnifiedDiff)
                .setDisabled(modeSelect.value !== 'unified')
                .onClick(async () => {
                    this.plugin.settings.compactUnifiedDiff = !this.plugin.settings.compactUnifiedDiff;
                    await this.plugin.saveSettings();
                    this.renderTextDiff();
                }));

            menu.addSeparator();

            const isLineBased = this.currentGranularity === 'line';
            const isWordCharBased = this.currentGranularity === 'char' || this.currentGranularity === 'word';

            const lineNumTitle = '显示行号' + (!isLineBased ? ' (仅行模式可用)' : '');
            
            let contextTitle = '上下文设置';
            if (isWordCharBased) {
                contextTitle += ' (不适用于字符/单词模式)';
            } else if (isLineBased) {
                contextTitle += ' (0=仅变更, N=显示N行)';
            }

            menu.addItem(item => item.setTitle('自动换行').setChecked(this.wrapLines).onClick(() => { this.wrapLines = !this.wrapLines; this.renderTextDiff(); }));
            
            menu.addItem(item => item
                .setTitle(lineNumTitle)
                .setChecked(this.showLineNumbers)
                .setDisabled(!isLineBased)
                .onClick(() => { 
                    if (isLineBased) {
                        this.showLineNumbers = !this.showLineNumbers; 
                        this.renderTextDiff(); 
                    }
                }));
            
            menu.addItem(item => item.setTitle('忽略空白').setChecked(this.ignoreWhitespace).onClick(() => { this.ignoreWhitespace = !this.ignoreWhitespace; this.renderTextDiff(); }));
            menu.addItem(item => item.setTitle('显示空白').setChecked(this.showWhitespace).onClick(() => { this.showWhitespace = !this.showWhitespace; this.renderTextDiff(); }));
            
            menu.addItem(item => item
                .setTitle(contextTitle)
                .setDisabled(true)
                .setSection('diff-settings-group-label'));
            
            if (isWordCharBased) {
                menu.addItem(item => item
                    .setTitle('字符/单词模式不使用上下文')
                    .setDisabled(true));
            } else {
                menu.addItem(item => item
                    .setTitle(`自定义上下文行数... (当前: ${this.contextLines >= 9999 ? '全部' : this.contextLines})`)
                    .onClick(() => {
                        new ContextLineInputModal(this.app, this.contextLines, (lines) => {
                            this.contextLines = lines;
                            this.renderTextDiff();
                        }).open();
                    }));
            }

            menu.showAtMouseEvent(e as MouseEvent);
        });
        
        const modeSelect = controlsContainer.createEl('select', { cls: 'diff-select', attr: { 'aria-label': '视图模式', 'style': 'display: none;' } });
        modeSelect.createEl('option', { text: '统一视图', value: 'unified' });
        modeSelect.createEl('option', { text: '左右分栏', value: 'split' });
        modeSelect.value = this.plugin.settings.diffViewMode;
        modeSelect.addEventListener('change', () => { this.collapsedSections.clear(); this.renderTextDiff(); });

        prevBtn.addEventListener('click', () => this.navigateDiff(-1));
        nextBtn.addEventListener('click', () => this.navigateDiff(1));
        firstDiffBtn.addEventListener('click', () => this.navigateDiff('first'));
        lastDiffBtn.addEventListener('click', () => this.navigateDiff('last'));

        this.scope.register([], 'ArrowUp', () => { if (!prevBtn.disabled) prevBtn.click(); return false; });
        this.scope.register([], 'ArrowDown', () => { if (!nextBtn.disabled) nextBtn.click(); return false; });
        this.scope.register(['Mod'], 'f', (evt) => { evt.preventDefault(); this.showSearchBox(); return false; });

        await this.updateDiffView();
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
        // [FIX 2] 精准定位到特定的按钮组，防止影响其他菜单按钮
        const navButtons = this.containerEl.querySelectorAll('#diff-nav-group button');
        const [firstBtn, prevBtn, nextBtn, lastBtn] = Array.from(navButtons) as HTMLButtonElement[];

        if (this.totalDiffs > 0) {
            statsEl.setText(`${this.currentDiffIndex + 1} / ${this.totalDiffs}`);
            if(prevBtn) prevBtn.disabled = this.currentDiffIndex === 0;
            if(firstBtn) firstBtn.disabled = this.currentDiffIndex === 0;
            if(nextBtn) nextBtn.disabled = this.currentDiffIndex >= this.totalDiffs - 1;
            if(lastBtn) lastBtn.disabled = this.currentDiffIndex >= this.totalDiffs - 1;
        } else {
            statsEl.setText(this.leftContent === this.rightContent ? '✅' : '0/0');
            [firstBtn, prevBtn, nextBtn, lastBtn].forEach(btn => { if(btn) btn.disabled = true; });
        }
    }
    
    renderVersionSelectors(container: HTMLElement) {
        const selectorContainer = container.createEl('div', { cls: 'diff-version-selector-container' });

        const leftSelector = selectorContainer.createEl('div', { cls: 'diff-version-selector' });
        leftSelector.createEl('span', { text: '版本 A:', cls: 'diff-selector-label' });
        const leftBtn = leftSelector.createEl('button', { 
            text: '加载中...', 
            cls: 'diff-selector-btn diff-left-version-btn'
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
            cls: 'diff-selector-btn diff-right-version-btn'
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
        this.loadingOverlay.style.display = 'flex';
        
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
            this.renderTextDiff();

        } catch (error: any) {
            console.error("加载差异失败:", error);
            new Notice('❌ 加载版本内容失败');
        } finally {
            this.loadingOverlay.style.display = 'none';
        }
    }

    updateSelectorButtonLabels() {
        const leftBtn = this.containerEl.querySelector('.diff-left-version-btn') as HTMLButtonElement;
        const rightBtn = this.containerEl.querySelector('.diff-right-version-btn') as HTMLButtonElement;

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
    
    alignSplitViewLines() {
        setTimeout(() => {
            const leftPanel = this.textDiffContainer.querySelector('.diff-panel:first-child');
            const rightPanel = this.textDiffContainer.querySelector('.diff-panel:last-child');
            
            if (!leftPanel || !rightPanel) return;

            const leftLines = Array.from(leftPanel.querySelectorAll('.diff-line')) as HTMLElement[];
            const rightLines = Array.from(rightPanel.querySelectorAll('.diff-line')) as HTMLElement[];

            const count = Math.min(leftLines.length, rightLines.length);

            for (let i = 0; i < count; i++) {
                const left = leftLines[i];
                const right = rightLines[i];
                if (!left || !right) continue;
                
                left.style.height = '';
                right.style.height = '';

                const lHeight = left.offsetHeight;
                const rHeight = right.offsetHeight;

                if (lHeight !== rHeight) {
                    const maxHeight = Math.max(lHeight, rHeight);
                    left.style.height = `${maxHeight}px`;
                    right.style.height = `${maxHeight}px`;
                }
            }
        }, 50);
    }

    renderTextDiff() {
        const container = this.textDiffContainer;
        container.empty();
        this.diffElements = [];
        this.currentDiffIndex = 0;
        this.totalDiffs = 0;
        
        let leftProcessed = this.leftContent;
        let rightProcessed = this.rightContent;
        
        if (!leftProcessed && !rightProcessed) {
            container.createEl('div', { text: '两个版本都是空文件', cls: 'diff-empty-notice' });
            return;
        }
        
        container.toggleClass('show-whitespace-active', this.showWhitespace);
        
        const modeSelect = this.containerEl.querySelector('.diff-select[aria-label="视图模式"]') as HTMLSelectElement;
        
        if (modeSelect.value === 'unified') {
            container.removeClass('diff-split');
            this.renderUnifiedDiff(container, leftProcessed, rightProcessed);
        } else {
            container.addClass('diff-split');
            const leftLabelEl = this.containerEl.querySelector('.diff-left-version-btn') as HTMLElement;
            const rightLabelEl = this.containerEl.querySelector('.diff-right-version-btn') as HTMLElement;
            this.renderSplitDiff(container, leftProcessed, rightProcessed, leftLabelEl.textContent || '版本 A', rightLabelEl.textContent || '版本 B');
            
            this.alignSplitViewLines();
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
        
        // 强制无条件追加 \n 确保底层统计不出错
        const safeLeft = leftProcessed + '\n';
        const safeRight = rightProcessed + '\n';
        
        const useCompact = this.plugin.settings.compactUnifiedDiff; 
        const diffResult = useCompact 
            ? this.plugin.getCompactDiffLines(safeLeft, safeRight, this.ignoreWhitespace)
            : Diff.diffLines(safeLeft, safeRight, { ignoreWhitespace: this.ignoreWhitespace });
        
        let addedLines = 0;
        let removedLines = 0;
        let modifiedLines = 0; 

        for (let i = 0; i < diffResult.length; i++) {
            const part = diffResult[i]!;
            const nextPart = diffResult[i + 1];

            const isRemoveAdd = part.removed && nextPart?.added;
            const isAddRemove = part.added && nextPart?.removed;

            if (useCompact && (isRemoveAdd || isAddRemove)) {
                 const removedPart = isRemoveAdd ? part : nextPart!;
                 const addedPart = isRemoveAdd ? nextPart! : part;
                 
                 const leftLines = removedPart.value.replace(/\n$/, '').split('\n');
                 const rightLines = addedPart.value.replace(/\n$/, '').split('\n');
                 const stats = this.plugin.calculateCompactBlockStats(leftLines, rightLines);
                 
                 modifiedLines += stats.mods;
                 removedLines += stats.rems; 
                 addedLines += stats.adds;   
                 
                 i++; 
            } else {
                if (part.added) {
                    addedLines += part.count || 0;
                } else if (part.removed) {
                    removedLines += part.count || 0;
                }
            }
        }
        
        const leftLinesCount = this.leftContent.split('\n').length;
        const rightLinesCount = this.rightContent.split('\n').length;
        
        const totalChangesCount = addedLines + removedLines + modifiedLines;
        const changePercent = leftLinesCount > 0 ? ((totalChangesCount / leftLinesCount) * 100).toFixed(1) : '0';
        
        const leftWordCountNum = this.plugin.countWords(this.leftContent);
        const rightWordCountNum = this.plugin.countWords(this.rightContent);
        
        const leftCharCountNum = this.leftContent.length;
        const rightCharCountNum = this.rightContent.length;

        const formatDiff = (diff: number) => 
            diff > 0 ? ` (+${diff.toLocaleString()})` : 
            (diff < 0 ? ` (${diff.toLocaleString()})` : ` (+0)`);

        container.createEl('span', { 
            text: `📊 总行数: ${leftLinesCount.toLocaleString()} ➔ ${rightLinesCount.toLocaleString()}${formatDiff(rightLinesCount - leftLinesCount)}`, 
            cls: 'diff-info-item',
            attr: { title: `版本 A: ${leftLinesCount.toLocaleString()} 行\n版本 B: ${rightLinesCount.toLocaleString()} 行` }
        });
        container.createEl('span', { 
            text: `📝 词数: ${leftWordCountNum.toLocaleString()} ➔ ${rightWordCountNum.toLocaleString()}${formatDiff(rightWordCountNum - leftWordCountNum)}`, 
            cls: 'diff-info-item',
            attr: { style: 'margin-left: 8px;', title: `版本 A: ${leftWordCountNum.toLocaleString()} 词\n版本 B: ${rightWordCountNum.toLocaleString()} 词` }
        });
        container.createEl('span', { 
            text: `🔤 字符: ${leftCharCountNum.toLocaleString()} ➔ ${rightCharCountNum.toLocaleString()}${formatDiff(rightCharCountNum - leftCharCountNum)}`, 
            cls: 'diff-info-item',
            attr: { style: 'margin-left: 8px;', title: `版本 A: ${leftCharCountNum.toLocaleString()} 字符\n版本 B: ${rightCharCountNum.toLocaleString()} 字符` }
        });
        
        if (modifiedLines > 0) {
            const modSpan = container.createEl('span', { text: `~${modifiedLines} (修)`, cls: 'diff-info-changed' });
            modSpan.style.color = 'var(--text-accent)'; 
        }

        container.createEl('span', { text: `+${addedLines}`, cls: 'diff-info-added' });
        container.createEl('span', { text: `-${removedLines}`, cls: 'diff-info-removed' });
        container.createEl('span', { text: `变化率: ${changePercent}%`, cls: 'diff-info-percent' });

        container.addClass('diff-info-updated');
        setTimeout(() => {
            container.removeClass('diff-info-updated');
        }, 500);
    }

    showDetailedStats() {
        const safeLeft = this.leftContent + '\n';
        const safeRight = this.rightContent + '\n';
        const useCompact = this.plugin.settings.compactUnifiedDiff;
        
        const diffResult = useCompact
            ? this.plugin.getCompactDiffLines(safeLeft, safeRight, this.ignoreWhitespace)
            : Diff.diffLines(safeLeft, safeRight, { ignoreWhitespace: this.ignoreWhitespace });
        
        let addedLines = 0;
        let removedLines = 0;
        let modifiedLines = 0;
        let addedChars = 0;
        let removedChars = 0;

        for (let i = 0; i < diffResult.length; i++) {
            const part = diffResult[i]!;
            const nextPart = diffResult[i + 1];

            const isRemoveAdd = part.removed && nextPart?.added;
            const isAddRemove = part.added && nextPart?.removed;

            if (useCompact && (isRemoveAdd || isAddRemove)) {
                const removedPart = isRemoveAdd ? part : nextPart!;
                const addedPart = isRemoveAdd ? nextPart! : part;

                const leftLines = removedPart.value.replace(/\n$/, '').split('\n');
                const rightLines = addedPart.value.replace(/\n$/, '').split('\n');
                const stats = this.plugin.calculateCompactBlockStats(leftLines, rightLines);
                
                modifiedLines += stats.mods;
                removedLines += stats.rems;
                addedLines += stats.adds;
                
                removedChars += removedPart.value.length;
                addedChars += addedPart.value.length;

                i++;
            } else {
                if (part.added) {
                    addedLines += part.count || 0;
                    addedChars += part.value.length;
                } else if (part.removed) {
                    removedLines += part.count || 0;
                    removedChars += part.value.length;
                }
            }
        }
        
        const leftLines = this.leftContent.split('\n').length;
        const rightLines = this.rightContent.split('\n').length;
        const similarity = this.plugin.calculateSimilarity(this.leftContent, this.rightContent);
        
        let statsMsg = '📊 详细统计\n\n' +
            `左侧版本: ${leftLines} 行, ${this.leftContent.length} 字符\n` +
            `右侧版本: ${rightLines} 行, ${this.rightContent.length} 字符\n\n`;
            
        if (modifiedLines > 0) {
            statsMsg += `修改: ${modifiedLines} 行\n`;
        }
        
        statsMsg += `新增: ${addedLines} 行, ${addedChars} 字符\n` +
            `删除: ${removedLines} 行, ${removedChars} 字符\n` +
            `相似度: ${similarity.toFixed(1)}%\n` +
            `差异块: ${this.totalDiffs} 个`;

        new Notice(statsMsg, 10000);
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
                searchMatches[0]!.addClass('diff-search-current');
                searchMatches[0]!.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
                searchResults.setText('无结果');
            }
        });
        
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (searchMatches.length > 0) {
                    searchMatches[currentMatch]!.removeClass('diff-search-current');
                    currentMatch = (currentMatch + 1) % searchMatches.length;
                    searchMatches[currentMatch]!.addClass('diff-search-current');
                    searchMatches[currentMatch]!.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
        
        const mainContainer = this.containerEl.querySelector('.diff-main-container');
        if (mainContainer) {
            mainContainer.parentElement?.insertBefore(searchContainer, mainContainer);
        }
        
        searchInput.focus();
    }

    exportDiffReport() {
        try {
            const safeLeft = this.leftContent + '\n';
            const safeRight = this.rightContent + '\n';
            const diffResult = Diff.diffLines(safeLeft, safeRight, { ignoreWhitespace: this.ignoreWhitespace });
            
            let report = `# 版本差异报告\n\n`;
            report += `**文件**: ${this.file.path}\n`;
            report += `**生成时间**: ${new Date().toLocaleString('zh-CN')}\n\n`;
            
            const versions = this.allVersions; 
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
                const lineCount = part.count || 0;
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
            this.app.vault.create(fileName, report);
            new Notice(`✅ 差异报告已导出: ${fileName}`);
        } catch (error: any) {
            console.error('导出差异报告失败:', error);
            new Notice('❌ 导出失败');
        }
    }

    renderUnifiedDiff(container: HTMLElement, left: string, right: string) {
        if (this.currentGranularity === 'char' || this.currentGranularity === 'word') {
            const diffResult = this.currentGranularity === 'char'
                ? Diff.diffChars(left, right)
                : this.diffWordsCJK(left, right);
            
            const contentEl = container.createEl('div', { cls: 'line-content' });
            let diffIdx = 0;

            diffResult.forEach(part => {
                const text = this.showWhitespace ? this.visualizeWhitespace(part.value) : part.value;
                if (part.added) {
                    const span = contentEl.createEl('span', { text });
                    span.addClass('diff-word-added');
                    span.dataset.diffIndex = String(diffIdx++);
                    this.diffElements.push(span);
                } else if (part.removed) {
                    const span = contentEl.createEl('span', { text });
                    span.addClass('diff-word-removed');
                    span.dataset.diffIndex = String(diffIdx++);
                    this.diffElements.push(span);
                } else {
                    if (this.contextLines > 0) {
                        contentEl.createEl('span', { text });
                    }
                }
            });
            return;
        }

        const safeLeft = left + '\n';
        const safeRight = right + '\n';
        
        const useCompactView = this.plugin.settings.compactUnifiedDiff;
        const rawDiff = useCompactView
            ? this.plugin.getCompactDiffLines(safeLeft, safeRight, this.ignoreWhitespace)
            : Diff.diffLines(safeLeft, safeRight, { ignoreWhitespace: this.ignoreWhitespace });
        
        const processedDiff: ProcessedDiff[] = rawDiff.map(part => ({ ...part, type: (part.added ? 'added' : part.removed ? 'removed' : 'context') as any }));

        let leftLineNum = 1;
        let rightLineNum = 1;
        let diffIdx = 0;
        
        const secondaryDiffFn = (text1: string, text2: string): Diff.Change[] => {
             if (this.plugin.settings.inlineDiffAlgorithm === 'line') {
                 return Diff.diffLines(text1, text2);
             } else if (this.plugin.settings.inlineDiffAlgorithm === 'char') {
                 // @ts-ignore
                 return Diff.diffChars(text1, text2);
             } else {
                 return this.diffWordsCJK(text1, text2);
             }
        };

        const createHighlightedFragment = (diffParts: Diff.Change[], includeRemoved: boolean = true): DocumentFragment => {
            const fragment = document.createDocumentFragment();
            (diffParts || []).forEach((part: Diff.Change) => {
                const className = part.added ? 'diff-word-added' : (part.removed ? 'diff-word-removed' : '');
                const processedText = this.showWhitespace ? this.visualizeWhitespace(part.value) : part.value;
                
                if (part.removed && !includeRemoved) {
                    return;
                }

                const lines = processedText.split('\n');
                lines.forEach((line, index) => {
                    if (index > 0) {
                        fragment.appendChild(createEl('br'));
                    }
                    if (line.length > 0) {
                        if (className) {
                            fragment.append(createEl('span', { text: line, cls: className }));
                        } else {
                            fragment.append(document.createTextNode(line));
                        }
                    }
                });
            });
            return fragment;
        };

        const renderLine = (content: string | DocumentFragment, type: ProcessedDiff['type'], lineNumLeft: number | null, lineNumRight: number | null, oldContentForRevert: string | null = null) => {
            const lineEl = container.createEl('div', { cls: `diff-line diff-${type}` });
            
            if (type === 'added') lineEl.addClass('diff-line-bg-added');
            else if (type === 'removed') lineEl.addClass('diff-line-bg-removed');
            else if (type === 'modified') lineEl.addClass('diff-line-bg-modified');

            if (type !== 'context') {
                lineEl.dataset.diffIndex = String(diffIdx++);
                this.diffElements.push(lineEl);
            }
            if (lineNumLeft) lineEl.dataset.lineNumberLeft = String(lineNumLeft);
            if (lineNumRight) lineEl.dataset.lineNumberRight = String(lineNumRight);
            
            const gutterCol = lineEl.createEl('div', { cls: 'diff-gutter-column' });

            const numsRow = gutterCol.createEl('div', { cls: 'diff-gutter-nums' });
            if (this.showLineNumbers) {
                if (lineNumLeft) numsRow.createEl('span', { text: String(lineNumLeft) });
                if (lineNumLeft && lineNumRight) numsRow.createEl('span', { text: '|', attr: {style: 'opacity:0.3'} });
                if (lineNumRight) numsRow.createEl('span', { text: String(lineNumRight) });
            }
    
            let marker = ' ';
            if (type === 'added') marker = '+';
            else if (type === 'removed') marker = '-';
            else if (type === 'modified') marker = '~';

            lineEl.createEl('span', { cls: 'diff-marker', text: marker });
            
            const contentEl = lineEl.createEl('span', { cls: 'line-content' });
            if (typeof content === 'string') {
                contentEl.setText(this.showWhitespace ? this.visualizeWhitespace(content) : content);
            } else {
                contentEl.appendChild(content);
            }
            
            if (Platform.isMobile) {
                lineEl.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    const wasVisible = lineEl.hasClass('actions-visible');
                    const allLines = lineEl.parentElement?.querySelectorAll('.diff-line');
                    allLines?.forEach(el => el.removeClass('actions-visible'));
                    if (!wasVisible) {
                        lineEl.addClass('actions-visible');
                    }
                });
            }
        };

        for (let i = 0; i < processedDiff.length; i++) {
            const part = processedDiff[i]!;
            const nextPart = processedDiff[i + 1];

            const isRemoveAdd = part.removed && nextPart?.added;
            const isAddRemove = part.added && nextPart?.removed;

            if (isRemoveAdd || isAddRemove) {
                const removedPart = isRemoveAdd ? part : nextPart!;
                const addedPart = isRemoveAdd ? nextPart! : part;

                const leftLines = removedPart.value.replace(/\n$/, '').split('\n');
                const rightLines = addedPart.value.replace(/\n$/, '').split('\n');

                if (useCompactView) {
                    if (leftLines.length === rightLines.length) {
                        for (let j = 0; j < leftLines.length; j++) {
                            const lLine = leftLines[j]!;
                            const rLine = rightLines[j]!;
                            if (lLine === rLine) {
                                renderLine(lLine, 'context', leftLineNum++, rightLineNum++);
                            } else {
                                const lineDiff = secondaryDiffFn(lLine, rLine);
                                const combinedFrag = createHighlightedFragment(lineDiff, true);
                                renderLine(combinedFrag, 'modified', leftLineNum++, rightLineNum++, lLine);
                            }
                        }
                    } else {
                        let lIndex = 0;
                        let rIndex = 0;

                        while (lIndex < leftLines.length || rIndex < rightLines.length) {
                            const lLine = leftLines[lIndex];
                            const rLine = rightLines[rIndex];

                            if (lLine === undefined) {
                                renderLine(rLine!, 'added', null, rightLineNum++);
                                rIndex++;
                                continue;
                            }

                            if (rLine === undefined) {
                                renderLine(lLine!, 'removed', leftLineNum++, null);
                                lIndex++;
                                continue;
                            }

                            const currentSim = this.plugin.calculateSimilarity(lLine, rLine);

                            const nextRightLine = rightLines[rIndex + 1];
                            const insertionSim = nextRightLine !== undefined ? this.plugin.calculateSimilarity(lLine, nextRightLine) : 0;

                            const nextLeftLine = leftLines[lIndex + 1];
                            const deletionSim = nextLeftLine !== undefined ? this.plugin.calculateSimilarity(nextLeftLine, rLine) : 0;

                            const threshold = 30; 

                            if (insertionSim > currentSim + threshold) {
                                renderLine(rLine!, 'added', null, rightLineNum++);
                                rIndex++;
                            } else if (deletionSim > currentSim + threshold) {
                                renderLine(lLine!, 'removed', leftLineNum++, null);
                                lIndex++;
                            } else {
                                if (lLine === rLine) {
                                    renderLine(lLine, 'context', leftLineNum++, rightLineNum++);
                                } else {
                                    const lineDiff = secondaryDiffFn(lLine!, rLine!);
                                    const combinedFrag = createHighlightedFragment(lineDiff, true);
                                    renderLine(combinedFrag, 'modified', leftLineNum++, rightLineNum++, lLine);
                                }
                                lIndex++;
                                rIndex++;
                            }
                        }
                    }
                } else if (leftLines.length === rightLines.length) {
                    for (let j = 0; j < leftLines.length; j++) {
                        const oldLine = leftLines[j]!;
                        const newLine = rightLines[j]!;
                        const lineDiff = secondaryDiffFn(oldLine, newLine);
                        
                        const leftFrag = createHighlightedFragment((lineDiff || []).filter((p: Diff.Change) => !p.added), true);
                        renderLine(leftFrag, 'removed', leftLineNum++, null);
                        
                        const rightFrag = createHighlightedFragment((lineDiff || []).filter((p: Diff.Change) => !p.removed), false);
                        renderLine(rightFrag, 'added', null, rightLineNum++, oldLine);
                    }
                } else {
                    leftLines.forEach(line => renderLine(line, 'removed', leftLineNum++, null));
                    rightLines.forEach(line => renderLine(line, 'added', null, rightLineNum++));
                }
                i++; // 跳过下一个已处理的 part
            } else { 
                const lines = part.value.replace(/\n$/, '').split('\n');
                
                if (part.type === 'context') {
                   const prevPartIsChange = i > 0 && processedDiff[i - 1]!.type !== 'context';
                   const nextPartIsChange = i < processedDiff.length - 1 && processedDiff[i + 1]!.type !== 'context';
                    
                   let lastLineShown = -1;
                   for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                        const line = lines[lineIdx]!;
                        let showLine = false;
                        if (this.contextLines >= 9999) { showLine = true; } 
                        else {
                             const distanceToPrev = prevPartIsChange ? lineIdx : Infinity;
                             const distanceToNext = nextPartIsChange ? (lines.length - 1 - lineIdx) : Infinity;
                             if (distanceToPrev < this.contextLines || distanceToNext < this.contextLines) { showLine = true; }
                        }

                        if (showLine) {
                             if (lineIdx > lastLineShown + 1 && this.contextLines < 9999) {
                                 const skippedEl = container.createEl('div', { cls: 'diff-line diff-context-gap' });
                                 skippedEl.createEl('span', { cls: 'line-number-container' });
                                 skippedEl.createEl('span', { cls: 'diff-marker', text: '...' });
                             }
                             renderLine(line, 'context', leftLineNum, rightLineNum);
                             lastLineShown = lineIdx;
                        }
                        leftLineNum++;
                        rightLineNum++;
                   }
                } else {
                    for (const line of lines) {
                        if (part.added) renderLine(line, 'added', null, rightLineNum++);
                        else if (part.removed) renderLine(line, 'removed', leftLineNum++, null);
                    }
                }
            }
        }
    }

    renderSplitDiff(container: HTMLElement, left: string, right: string, leftLabel: string, rightLabel: string) {
        const leftPanel = container.createEl('div', { cls: 'diff-panel' });
        const rightPanel = container.createEl('div', { cls: 'diff-panel' });

        leftPanel.createEl('h3', { text: leftLabel });
        rightPanel.createEl('h3', { text: rightLabel });

        const leftContentEl = leftPanel.createEl('div', { cls: 'diff-content' });
        const rightContentEl = rightPanel.createEl('div', { cls: 'diff-content' });

        this.renderSplitViewAdvanced(leftContentEl, rightContentEl, left, right);
    }

    renderSplitViewAdvanced(leftPanel: HTMLElement, rightPanel: HTMLElement, leftText: string, rightText: string) {
        if (this.currentGranularity === 'char' || this.currentGranularity === 'word') {
            const diffResult = this.currentGranularity === 'char'
                ? Diff.diffChars(leftText, rightText)
                : this.diffWordsCJK(leftText, rightText);
            let diffIdx = 0;

            diffResult.forEach(part => {
                const text = this.showWhitespace ? this.visualizeWhitespace(part.value) : part.value;
                if (part.added) {
                    const span = rightPanel.createEl('span', { text, cls: 'diff-word-added' });
                    span.dataset.diffIndex = String(diffIdx++);
                    this.diffElements.push(span);
                } else if (part.removed) {
                    const span = leftPanel.createEl('span', { text, cls: 'diff-word-removed' });
                    span.dataset.diffIndex = String(diffIdx++);
                    this.diffElements.push(span);
                } else {
                    if (this.contextLines > 0) { 
                        leftPanel.createEl('span', { text });
                        rightPanel.createEl('span', { text });
                    }
                }
            });
            return;
        }

        const safeLeft = leftText + '\n';
        const safeRight = rightText + '\n';

        const useCompactView = this.plugin.settings.compactUnifiedDiff;
        const rawDiff = useCompactView
            ? this.plugin.getCompactDiffLines(safeLeft, safeRight, this.ignoreWhitespace)
            : Diff.diffLines(safeLeft, safeRight, { ignoreWhitespace: this.ignoreWhitespace });
        
        const diff: ProcessedDiff[] = rawDiff.map(p => ({ ...p, type: (p.added ? 'added' : p.removed ? 'removed' : 'context') as any }));

        let leftLineNum = 1;
        let rightLineNum = 1;
        let diffIdx = 0;

        const secondaryDiffFn = (text1: string, text2: string): Diff.Change[] => {
            if (this.plugin.settings.inlineDiffAlgorithm === 'line') {
                return Diff.diffLines(text1, text2);
            } else if (this.plugin.settings.inlineDiffAlgorithm === 'char') {
                // @ts-ignore
                return Diff.diffChars(text1, text2);
            } else {
                return this.diffWordsCJK(text1, text2);
            }
        };
    
        const createHighlightedFragment = (diffParts: Diff.Change[]): DocumentFragment => {
            const fragment = document.createDocumentFragment();
            (diffParts || []).forEach((part: Diff.Change) => {
                const className = part.added ? 'diff-word-added' : part.removed ? 'diff-word-removed' : '';
                const processedText = this.showWhitespace ? this.visualizeWhitespace(part.value) : part.value;
                
                const lines = processedText.split('\n');
                lines.forEach((line, index) => {
                    if (index > 0) {
                        fragment.appendChild(createEl('br'));
                    }
                    if (line.length > 0) {
                        if (className) {
                            fragment.append(createEl('span', { text: line, cls: className }));
                        } else {
                            fragment.append(document.createTextNode(line));
                        }
                    }
                });
            });
            return fragment;
        };
    
        const renderLine = (panel: HTMLElement, content: string | DocumentFragment, type: string, lineNum: number | null, oldContentForRevert: string | null = null) => {
            const lineEl = panel.createEl('div', { cls: `diff-line diff-${type}` });

            if (type === 'added') lineEl.addClass('diff-line-bg-added');
            else if (type === 'removed') lineEl.addClass('diff-line-bg-removed');
            else if (type === 'modified') lineEl.addClass('diff-line-bg-modified');

            if (type !== 'context' && type !== 'placeholder') {
                lineEl.dataset.diffIndex = String(diffIdx++);
                this.diffElements.push(lineEl);
            }
            if (lineNum) lineEl.dataset.lineNumber = String(lineNum);

            const gutterCol = lineEl.createEl('div', { cls: 'diff-gutter-column' });

            const numsRow = gutterCol.createEl('div', { cls: 'diff-gutter-nums' });
            if (this.showLineNumbers) {
                numsRow.createEl('span', { text: lineNum ? String(lineNum) : '' });
            }

            const contentEl = lineEl.createEl('span', { cls: 'line-content' });
            if (typeof content === 'string') {
                contentEl.setText(this.showWhitespace ? this.visualizeWhitespace(content) : content);
            } else {
                contentEl.appendChild(content);
            }

            if (Platform.isMobile) {
                lineEl.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    const wasVisible = lineEl.hasClass('actions-visible');
                    const allLines = lineEl.parentElement?.parentElement?.querySelectorAll('.diff-line');
                    allLines?.forEach(el => el.removeClass('actions-visible'));
                    if (!wasVisible) {
                        lineEl.addClass('actions-visible');
                    }
                });
            }
        };
    
        for (let i = 0; i < diff.length; i++) {
            const part = diff[i]!;
            const nextPart = diff[i + 1];
    
            const isRemoveAdd = part.removed && nextPart?.added;
            const isAddRemove = part.added && nextPart?.removed;

            if (isRemoveAdd || isAddRemove) {
                const removedPart = isRemoveAdd ? part : nextPart!;
                const addedPart = isRemoveAdd ? nextPart! : part;

                const leftLines = removedPart.value.replace(/\n$/, '').split('\n');
                const rightLines = addedPart.value.replace(/\n$/, '').split('\n');

                if (useCompactView) {
                    if (leftLines.length === rightLines.length) {
                        for (let j = 0; j < leftLines.length; j++) {
                            const lLine = leftLines[j]!;
                            const rLine = rightLines[j]!;
                            if (lLine === rLine) {
                                renderLine(leftPanel, lLine, 'context', leftLineNum++);
                                renderLine(rightPanel, rLine, 'context', rightLineNum++);
                            } else {
                                const lineDiff = secondaryDiffFn(lLine, rLine);
                                const leftFrag = createHighlightedFragment((lineDiff || []).filter((p: Diff.Change) => !p.added));
                                const rightFrag = createHighlightedFragment((lineDiff || []).filter((p: Diff.Change) => !p.removed));
                                renderLine(leftPanel, leftFrag, 'modified', leftLineNum++);
                                renderLine(rightPanel, rightFrag, 'modified', rightLineNum++, lLine);
                            }
                        }
                    } else {
                        let lIndex = 0;
                        let rIndex = 0;

                        while (lIndex < leftLines.length || rIndex < rightLines.length) {
                            const lLine = leftLines[lIndex];
                            const rLine = rightLines[rIndex];

                            if (lLine === undefined) {
                                renderLine(leftPanel, '', 'placeholder', null);
                                renderLine(rightPanel, rLine!, 'added', rightLineNum++);
                                rIndex++;
                                continue;
                            }

                            if (rLine === undefined) {
                                renderLine(leftPanel, lLine!, 'removed', leftLineNum++);
                                renderLine(rightPanel, '', 'placeholder', null);
                                lIndex++;
                                continue;
                            }

                            const currentSim = this.plugin.calculateSimilarity(lLine, rLine);

                            const nextRightLine = rightLines[rIndex + 1];
                            const insertionSim = nextRightLine !== undefined ? this.plugin.calculateSimilarity(lLine, nextRightLine) : 0;

                            const nextLeftLine = leftLines[lIndex + 1];
                            const deletionSim = nextLeftLine !== undefined ? this.plugin.calculateSimilarity(nextLeftLine, rLine) : 0;

                            const threshold = 30; 

                            if (insertionSim > currentSim + threshold) {
                                renderLine(leftPanel, '', 'placeholder', null);
                                renderLine(rightPanel, rLine!, 'added', rightLineNum++);
                                rIndex++;
                            } else if (deletionSim > currentSim + threshold) {
                                renderLine(leftPanel, lLine!, 'removed', leftLineNum++);
                                renderLine(rightPanel, '', 'placeholder', null);
                                lIndex++;
                            } else {
                                if (lLine === rLine) {
                                    renderLine(leftPanel, lLine, 'context', leftLineNum++);
                                    renderLine(rightPanel, rLine, 'context', rightLineNum++);
                                } else {
                                    const lineDiff = secondaryDiffFn(lLine!, rLine!);
                                    const leftFrag = createHighlightedFragment((lineDiff || []).filter((p: Diff.Change) => !p.added));
                                    const rightFrag = createHighlightedFragment((lineDiff || []).filter((p: Diff.Change) => !p.removed));
                                    renderLine(leftPanel, leftFrag, 'modified', leftLineNum++);
                                    renderLine(rightPanel, rightFrag, 'modified', rightLineNum++, lLine);
                                }
                                lIndex++;
                                rIndex++;
                            }
                        }
                    }
                } else if (leftLines.length === rightLines.length) {
                    for (let j = 0; j < leftLines.length; j++) {
                        const oldLine = leftLines[j]!;
                        const newLine = rightLines[j]!;
                        const lineDiff = secondaryDiffFn(oldLine, newLine);
                        
                        const leftFrag = createHighlightedFragment((lineDiff || []).filter((p: Diff.Change) => !p.added));
                        const rightFrag = createHighlightedFragment((lineDiff || []).filter((p: Diff.Change) => !p.removed));
                        renderLine(leftPanel, leftFrag, 'removed', leftLineNum++);
                        renderLine(rightPanel, rightFrag, 'added', rightLineNum++);
                    }
                } else {
                    leftLines.forEach(line => {
                        renderLine(leftPanel, line, 'removed', leftLineNum++);
                        renderLine(rightPanel, '', 'placeholder', null);
                    });
                    rightLines.forEach(line => {
                        renderLine(leftPanel, '', 'placeholder', null);
                        renderLine(rightPanel, line, 'added', rightLineNum++);
                    });
                }
                i++; // 跳过下一个已处理的 part
            } else if (part.added) {
                const lines = part.value.replace(/\n$/, '').split('\n');
                for (const line of lines) {
                    renderLine(leftPanel, '', 'placeholder', null);
                    renderLine(rightPanel, line, 'added', rightLineNum++);
                }
            } else if (part.removed) {
                const lines = part.value.replace(/\n$/, '').split('\n');
                for (const line of lines) {
                    renderLine(leftPanel, line, 'removed', leftLineNum++);
                    renderLine(rightPanel, '', 'placeholder', null);
                }
            } else { 
                const lines = part.value.replace(/\n$/, '').split('\n');
                const prevPartIsChange = i > 0 && diff[i - 1]!.type !== 'context';
                const nextPartIsChange = i < diff.length - 1 && diff[i + 1]!.type !== 'context';

                let lastLineShown = -1;
                for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                    const line = lines[lineIdx]!;
                    let showLine = false;

                    if (this.contextLines >= 9999) { 
                        showLine = true;
                    } else { 
                        const distanceToPrev = prevPartIsChange ? lineIdx : Infinity;
                        const distanceToNext = nextPartIsChange ? (lines.length - 1 - lineIdx) : Infinity;
                        
                        if (distanceToPrev < this.contextLines || distanceToNext < this.contextLines) {
                            showLine = true;
                        }
                    }

                    if (showLine) {
                        if (lineIdx > lastLineShown + 1 && this.contextLines < 9999) {
                            const skippedLeft = leftPanel.createEl('div', { cls: 'diff-line diff-context-gap' });
                            skippedLeft.createEl('span', { cls: 'line-number-container' });
                            skippedLeft.createEl('span', { cls: 'diff-marker', text: '...' });
                            
                            const skippedRight = rightPanel.createEl('div', { cls: 'diff-line diff-context-gap' });
                            skippedRight.createEl('span', { cls: 'line-number-container' });
                            skippedRight.createEl('span', { cls: 'diff-marker', text: '...' });
                        }
                        renderLine(leftPanel, line, 'context', leftLineNum);
                        renderLine(rightPanel, line, 'context', rightLineNum);
                        lastLineShown = lineIdx;
                    }
                    leftLineNum++;
                    rightLineNum++;
                }
            }
        }
    }

    scrollToDiff() {
        if (this.diffElements.length === 0 || this.currentDiffIndex >= this.diffElements.length) return;
        const element = this.diffElements[this.currentDiffIndex]!;
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

    onClose() {
        window.removeEventListener('resize', this.resizeHandler);
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
            .setName('状态栏：显示时间与快速对比')
            .setDesc('在状态栏显示上次保存的相对时间，点击即可快速对比。关闭后仅显示状态图标。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableStatusBarDiff)
                .onChange(async (value) => {
                    this.plugin.settings.enableStatusBarDiff = value;
                    this.plugin.settings.showLastSaveTimeInStatusBar = value;
                    await this.plugin.saveSettings();
                    
                    if (value) {
                        this.plugin.statusBarItem.addClass('version-control-statusbar-clickable');
                    } else {
                        this.plugin.statusBarItem.removeClass('version-control-statusbar-clickable');
                    }
                    this.plugin.updateStatusBar();
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
            .setName('删除文件时同步删除历史 (危险)')
            .setDesc('在 Obsidian 中删除 Markdown 文件时，连同它的版本历史一并永久删除。关闭此选项可在误删文件后从恢复历史中找回（推荐关闭）。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.deleteHistoryOnDelete)
                .onChange(async (value) => {
                    this.plugin.settings.deleteHistoryOnDelete = value;
                    await this.plugin.saveSettings();
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
            .setDesc('自动保存版本')
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
            .setName('修改时保存延迟 (分钟)')
            .setDesc('修改后等待多久才保存。支持小数,例如 0.5 代表30秒。')
            .addText(text => text
                .setValue(String(this.plugin.settings.autoSaveDelayOnModify / 60))
                .onChange(async (value) => {
                    const num = parseFloat(value);
                    if (!isNaN(num) && num >= 0) {
                        this.plugin.settings.autoSaveDelayOnModify = num * 60;
                        await this.plugin.saveSettings();
                    }
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
            .setDesc('按固定时间间隔扫描所有已修改的文件并保存')
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
            .setName('默认差异粒度')
            .setDesc('选择差异对比的默认精细程度')
            .addDropdown(dropdown => dropdown
                .addOption('char', '字符级')
                .addOption('word', '单词级')
                .addOption('line', '行级')
                .setValue(this.plugin.settings.diffGranularity)
                .onChange(async (value: 'char' | 'word' | 'line') => {
                    this.plugin.settings.diffGranularity = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('默认视图模式')
            .setDesc('选择差异对比的默认显示方式')
            .addDropdown(dropdown => dropdown
                .addOption('unified', '统一视图')
                .addOption('split', '左右分栏')
                .setValue(this.plugin.settings.diffViewMode)
                .onChange(async (value: 'unified' | 'split') => {
                    this.plugin.settings.diffViewMode = value;
                    await this.plugin.saveSettings();
                }));
        
        new Setting(containerEl)
            .setName('差异上下文行数')
            .setDesc('差异对比时，在变更内容周围显示的上下文行数 (0=仅变更, 9999=显示全部)。')
            .addText(text => text
                .setPlaceholder('3')
                .setValue(String(this.plugin.settings.diffContextLines))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num >= 0) {
                        this.plugin.settings.diffContextLines = num;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('行内差异算法')
            .setDesc('当使用“行级”对比时，指定行内高亮的算法。')
            .addDropdown(dropdown => dropdown
                .addOption('word', '按单词（推荐）')
                .addOption('char', '按字符（更精确）')
                .addOption('line', '按行')
                .setValue(this.plugin.settings.inlineDiffAlgorithm)
                .onChange(async (value: 'word' | 'char' | 'line') => {
                    this.plugin.settings.inlineDiffAlgorithm = value;
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
            .setName('检查版本完整性')
            .setDesc('扫描所有版本文件，检测结构损坏、增量链条断裂或哈希不匹配的问题。')
            .addButton(button => button
                .setButtonText('开始检查')
                .onClick(async () => {
                    await this.plugin.checkAllVersionsIntegrity();
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
        } catch (error: any) {
            console.error('清空版本失败:', error);
            new Notice('❌ 清空失败,请查看控制台');
        }
    }
}

class IntegrityReportModal extends Modal {
    plugin: VersionControlPlugin;
    report: { filePath: string; errors: string[] }[];

    constructor(app: App, plugin: VersionControlPlugin, report: { filePath: string; errors: string[] }[]) {
        super(app);
        this.plugin = plugin;
        this.report = report;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: '🛡️ 版本完整性检查报告' });

        if (this.report.length === 0) {
            const successDiv = contentEl.createEl('div', { cls: 'integrity-success' });
            successDiv.createEl('h3', { text: '✅ 所有检查通过' });
            successDiv.createEl('p', { text: '未发现损坏的版本记录。' });
        } else {
            contentEl.createEl('p', { text: `⚠️ 发现 ${this.report.length} 个文件存在问题:` });
            
            const listContainer = contentEl.createEl('div', { cls: 'integrity-report-list' });
            
            this.report.forEach(item => {
                const fileContainer = listContainer.createEl('div', { cls: 'integrity-item' });
                fileContainer.createEl('h4', { text: item.filePath });
                
                const errorList = fileContainer.createEl('ul');
                item.errors.forEach(err => {
                    errorList.createEl('li', { text: err, attr: { style: 'color: var(--text-error);' } });
                });

                const repairBtn = fileContainer.createEl('button', { text: '尝试修复哈希' });
                repairBtn.addEventListener('click', async () => {
                    const repaired = await this.plugin.repairVersionFile(item.filePath);
                    if (repaired) {
                        repairBtn.setText('修复成功');
                        repairBtn.disabled = true;
                    } else {
                        new Notice('无法自动修复，请手动检查文件。');
                    }
                });
            });
        }

        const btnContainer = contentEl.createEl('div', { cls: 'modal-button-container', attr: { style: 'margin-top: 20px;' } });
        btnContainer.createEl('button', { text: '关闭' }).addEventListener('click', () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }
}

class VersionSelectModal extends Modal {
    plugin: VersionControlPlugin;
    file: TFile;
    currentVersionId: string;
    onSelect: (versionId: string) => void;
    versions: VersionData[] = [];

    constructor(app: App, plugin: VersionControlPlugin, file: TFile, currentVersionId: string, onSelect: (versionId: string) => void) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.currentVersionId = currentVersionId;
        this.onSelect = onSelect;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: '选择对比版本' });
        contentEl.createEl('p', { text: '选择一个版本与当前选中的版本进行对比:' });

        this.versions = await this.plugin.getAllVersions(this.file.path);

        const listContainer = contentEl.createEl('div', { cls: 'version-select-list', attr: { style: 'max-height: 400px; overflow-y: auto;' } });

        if (this.currentVersionId !== 'current') {
            this.renderItem(listContainer, {
                id: 'current',
                timestamp: Date.now(),
                message: '📄 当前编辑器中的内容',
                size: 0
            } as any, true);
        }

        this.versions.forEach(v => {
            if (v.id !== this.currentVersionId) {
                this.renderItem(listContainer, v);
            }
        });

        const cancelBtn = contentEl.createEl('button', { text: '取消', attr: { style: 'margin-top: 15px;' } });
        cancelBtn.addEventListener('click', () => this.close());
    }

    renderItem(container: HTMLElement, version: VersionData, isCurrentFile: boolean = false) {
        const item = container.createEl('div', { cls: 'version-item', attr: { style: 'padding: 10px; border-bottom: 1px solid var(--background-modifier-border); cursor: pointer;' } });
        item.addEventListener('mouseenter', () => item.style.backgroundColor = 'var(--background-secondary)');
        item.addEventListener('mouseleave', () => item.style.backgroundColor = '');
        
        const header = item.createEl('div', { cls: 'version-item-header', attr: { style: 'display: flex; justify-content: space-between;' } });
        
        if (isCurrentFile) {
            header.createEl('strong', { text: version.message });
        } else {
            header.createEl('span', { text: this.plugin.formatTime(version.timestamp) });
            header.createEl('span', { text: this.plugin.formatFileSize(version.size), attr: { style: 'color: var(--text-muted); font-size: 0.9em;' } });
        }

        if (!isCurrentFile) {
            item.createEl('div', { text: version.message, attr: { style: 'color: var(--text-normal); margin-top: 4px;' } });
        }

        item.addEventListener('click', () => {
            this.onSelect(version.id);
            this.close();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

class ContextLineInputModal extends Modal {
    currentValue: number;
    onSubmit: (lines: number) => void;

    constructor(app: App, currentValue: number, onSubmit: (lines: number) => void) {
        super(app);
        this.currentValue = currentValue;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: '设置上下文行数' });
        contentEl.createEl('p', { text: '输入在差异行周围显示的未修改行数 (0 表示只显示修改行, 9999 表示显示全部)。' });

        const inputContainer = contentEl.createEl('div', { attr: { style: 'margin: 20px 0;' } });
        const input = inputContainer.createEl('input', { type: 'number' });
        input.value = String(this.currentValue);
        input.focus();

        const btnContainer = contentEl.createEl('div', { cls: 'modal-button-container' });
        
        btnContainer.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
        
        const saveBtn = btnContainer.createEl('button', { text: '保存', cls: 'mod-cta' });
        saveBtn.addEventListener('click', () => {
            const val = parseInt(input.value);
            if (!isNaN(val) && val >= 0) {
                this.onSubmit(val);
                this.close();
            } else {
                new Notice('请输入有效的正整数');
            }
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveBtn.click();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}