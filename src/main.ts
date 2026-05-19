
import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, Modal, ItemView, WorkspaceLeaf, Menu, TextComponent, MarkdownRenderer, Platform, TFolder, setIcon, moment, normalizePath, debounce } from 'obsidian';
import * as Diff from 'diff';
import * as pako from 'pako';

// --- 工具函数：安全地提取错误信息 ---
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
    return 'Unknown error occurred';
}

// --- LRU 缓存：用于极速读取已解析的版本内容 ---
class LRUCache<K, V> {
    private max: number;
    private cache: Map<K, V>;
    constructor(max = 50) {
        this.max = max;
        this.cache = new Map();
    }
    get(key: K): V | undefined {
        if (!this.cache.has(key)) return undefined;
        const val = this.cache.get(key)!;
        this.cache.delete(key);
        this.cache.set(key, val);
        return val;
    }
    set(key: K, val: V) {
        if (this.cache.has(key)) this.cache.delete(key);
        else if (this.cache.size >= this.max) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, val);
    }
    clear() { this.cache.clear(); }
    deletePrefix(prefix: string) {
        for (const key of this.cache.keys()) {
            if (typeof key === 'string' && key.startsWith(prefix)) {
                this.cache.delete(key);
            }
        }
    }
}

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
    
    deleteHistoryOnDelete: boolean; 
    compactHistoryView: boolean; 
    globalHistoryTimeMode: 'modified' | 'saved'; // 新增：全库历史时间显示模式
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
    autoSaveMinChanges: 0, 
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
    
    deleteHistoryOnDelete: false, 
    compactHistoryView: false, 
    globalHistoryTimeMode: 'modified', // 默认显示文件修改时间
};

// 视图模式类型定义
type ViewMode = 'current' | 'modified' | 'global';

export default class VersionControlPlugin extends Plugin {
    settings: VersionControlSettings;
    autoSaveTimer: number | null = null;
    lastModifiedTime: Map<string, number> = new Map();
    debouncedSaves: Map<string, Function> = new Map();
    statusBarItem: HTMLElement;
    versionCache: Map<string, VersionFile> = new Map();
    contentCache: LRUCache<string, string> = new LRUCache(50); 
    
    // --- 极速秒开核心：全局历史内存缓存 ---
    globalHistoryCache: { version: VersionData, filePath: string, file: TFile | null }[] | null = null;
    
    // --- 智能变频刷新核心：状态栏内存锚点 ---
    activeFileLastSaveTime: number | null = null;
    activeFileSaveLabel: string = '';

    fileLocks: Map<string, Promise<void>> = new Map();
    isRestoring: boolean = false; 
    isUnloaded: boolean = false;

    async onload() {
        this.isUnloaded = false;
        await this.loadSettings();

        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar();

        if (this.settings.enableStatusBarDiff) {
            this.statusBarItem.addClass('version-control-statusbar-clickable');
            this.statusBarItem.addEventListener('click', () => {
                this.quickDiffFromStatusBar();
            });
        }

        this.registerView('version-history', (leaf) => new VersionHistoryView(leaf, this));

        this.addCommand({ id: 'show-version-history', name: '显示版本历史', callback: () => this.activateVersionHistoryView() });
        this.addCommand({ id: 'create-full-snapshot', name: '保存全库版本', callback: () => this.createFullSnapshot() });
        this.addCommand({ id: 'optimize-storage', name: '优化存储空间', callback: () => this.optimizeAllVersionFiles() });
        this.addCommand({ id: 'check-version-integrity', name: '检查版本完整性', callback: () => this.checkAllVersionsIntegrity() });

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
                if (file instanceof TFile) await this.handleRename(file, oldPath);
                else if (file instanceof TFolder) await this.handleFolderRename(file, oldPath);
            })
        );

        this.registerEvent(
            this.app.vault.on('delete', async (file) => {
                if (file instanceof TFile) await this.handleDelete(file.path);
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

        // --- 核心修复：绝对每秒刷新定时器 ---
        this.registerInterval(
            window.setInterval(() => { 
                
                // 1. 状态栏：无论过去多久，每秒强制更新文本，彻底解决卡死问题
                this.renderStatusBarTime();

                // 2. 侧边栏视图：每秒强制统一刷新一次相对时间 (解决跳动滞后问题)
                const leaves = this.app.workspace.getLeavesOfType('version-history');
                leaves.forEach(leaf => { 
                    if (leaf.view instanceof VersionHistoryView) leaf.view.updateRelativeTimes(); 
                });
                
            }, 1000)
        );

        // --- 极速秒开核心：后台静默预热缓存 ---
        setTimeout(() => {
            if (!this.isUnloaded) {
                this.getGlobalHistory(200).catch(() => {});
            }
        }, 5000); // 启动 5 秒后偷偷拉取数据

        if (this.settings.showNotifications) {
            new Notice('✅ 版本控制插件已启动');
        }
    }

    onunload() {
        this.isUnloaded = true;
        if (this.autoSaveTimer) window.clearInterval(this.autoSaveTimer);
        this.debouncedSaves.clear();
        this.versionCache.clear();
        this.contentCache.clear();
        this.globalHistoryCache = null;
    }

    // --- 极速秒开核心：清理全局缓存的方法 ---
    clearGlobalCache() {
        this.globalHistoryCache = null;
    }

    async yieldToMain() { return new Promise(resolve => setTimeout(resolve, 0)); }

    async withLock(filePath: string, fn: () => Promise<void>, timeoutMs: number = 30000): Promise<void> {
        let currentLock = this.fileLocks.get(filePath) || Promise.resolve();
        const nextLock = currentLock
            .then(() => {
                const timeoutPromise = new Promise<void>((_, reject) => {
                    setTimeout(() => reject(new Error(`Lock operation timed out after ${timeoutMs}ms`)), timeoutMs);
                });
                return Promise.race([fn(), timeoutPromise]);
            })
            .catch((error: unknown) => {
                console.error(`[VersionControl] Error in locked operation for ${filePath}:`, getErrorMessage(error), error);
            })
            .finally(() => {
                if (this.fileLocks.get(filePath) === nextLock) this.fileLocks.delete(filePath);
            });
        this.fileLocks.set(filePath, nextLock);
        await nextLock;
    }

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
                    if (p.added) { rightValue += p.value; rightCount += p.count || 0; j++; } 
                    else if (p.removed) { leftValue += p.value; leftCount += p.count || 0; j++; } 
                    else {
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
                        } else { break; }
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
        diff.forEach(part => { if (!part.added && !part.removed) { commonLength += part.value.length; } });
        const maxLen = Math.max(text1.length, text2.length);
        if (maxLen === 0) return 100;
        return (commonLength / maxLen) * 100;
    }

    calculateCompactBlockStats(leftLines: string[], rightLines: string[]): { mods: number, adds: number, rems: number } {
        let mods = 0; let adds = 0; let rems = 0;
        if (leftLines.length === rightLines.length) {
            for (let j = 0; j < leftLines.length; j++) { if (leftLines[j] !== rightLines[j]) mods++; }
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
                if (insertionSim > currentSim + threshold) { adds++; rIndex++; } 
                else if (deletionSim > currentSim + threshold) { rems++; lIndex++; } 
                else { if (lLine !== rLine) mods++; lIndex++; rIndex++; }
            }
        }
        return { mods, adds, rems };
    }

    // --- 架构解耦：MVC 计算下沉 (提取独立业务逻辑) ---
    async calculateDiffStatsForVersionAsync(versionFile: VersionFile, versionId: string): Promise<boolean> {
        const versionIndex = versionFile.versionIndex?.get(versionId);
        if (versionIndex === undefined) return false;
        
        const version = versionFile.versions[versionIndex!];
        if (!version) return false;
    
        try {
            const currentContent = await this.getVersionContent(versionFile.filePath, version.id, true);
            const previousVersion = versionFile.versions[versionIndex! + 1];
            
            let added = 0, removed = 0, modified = 0;
    
            if (previousVersion) {
                const previousContent = await this.getVersionContent(versionFile.filePath, previousVersion.id, true);
                const safePrev = previousContent + '\n';
                const safeCurr = currentContent + '\n';
                const diffResult = this.getCompactDiffLines(safePrev, safeCurr, true);
                
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
                        const stats = this.calculateCompactBlockStats(leftLines, rightLines);
                        modified += stats.mods; removed += stats.rems; added += stats.adds;
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
            return true; // 标记已发生改变
        } catch (error: unknown) {
            version.addedLines = 0; version.removedLines = 0; version.modifiedLines = 0;
            return true;
        }
    }

    getVersionFilePath(filePath: string): string {
        const hash = this.stringHash(filePath);
        const fileName = filePath.split('/').pop() || 'file';
        const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_');
        return normalizePath(`${this.settings.versionFolder}/${safeName}_${hash}.json`);
    }

    getLegacyHashVersionFilePath(filePath: string): string {
        const hash = this.legacyStringHash(filePath);
        const fileName = filePath.split('/').pop() || 'file';
        const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_');
        return normalizePath(`${this.settings.versionFolder}/${safeName}_${hash}.json`);
    }

    getLegacyStrictAsciiVersionFilePath(filePath: string): string {
        const hash = this.legacyStringHash(filePath);
        const fileName = filePath.split('/').pop() || 'file';
        const safeName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        return normalizePath(`${this.settings.versionFolder}/${safeName}_${hash}.json`);
    }

    getLegacyVersionFilePath(filePath: string): string {
        const sanitized = this.sanitizeFileName(filePath);
        return normalizePath(`${this.settings.versionFolder}/${sanitized}.json`);
    }

    async findExistingVersionPath(filePath: string): Promise<string | null> {
        const adapter = this.app.vault.adapter;
        const paths = [
            this.getVersionFilePath(filePath),
            this.getLegacyHashVersionFilePath(filePath),
            this.getLegacyStrictAsciiVersionFilePath(filePath),
            this.getLegacyVersionFilePath(filePath)
        ];
        for (const p of paths) { if (await adapter.exists(p)) return p; }
        return null;
    }

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
                    this.versionCache.delete(file.path); 
                    this.contentCache.deletePrefix(file.path + "::");
                    
                    const versionFile = await this.loadVersionFile(file.path); 
                    versionFile.filePath = file.path;
                    await this.saveVersionFile(file.path, versionFile);
                    
                    this.versionCache.delete(oldPath);
                    this.contentCache.deletePrefix(oldPath + "::");
                    this.lastModifiedTime.delete(oldPath);
                    this.lastModifiedTime.set(file.path, versionFile.lastModified);
                    this.clearGlobalCache(); // --- 极速秒开核心：数据改变，清除缓存 ---
                } catch (e: unknown) { console.error("Rename Error", getErrorMessage(e), e); }
            }
        });
        
        const oldDebouncer = this.debouncedSaves.get(oldPath);
        if (oldDebouncer) { this.debouncedSaves.delete(oldPath); this.handleFileModify(file); }
        const newDebouncer = this.debouncedSaves.get(file.path);
        if (newDebouncer) { this.debouncedSaves.delete(file.path); this.handleFileModify(file); }
    }

    async handleDelete(filePath: string) {
        if (!this.settings.deleteHistoryOnDelete) return;
        await this.withLock(filePath, async () => {
            const adapter = this.app.vault.adapter;
            let versionPath = await this.findExistingVersionPath(filePath);
            if (versionPath) {
                await adapter.remove(versionPath);
                this.versionCache.delete(filePath);
                this.contentCache.deletePrefix(filePath + "::");
                this.lastModifiedTime.delete(filePath);
                this.debouncedSaves.delete(filePath);
                this.clearGlobalCache(); // --- 极速秒开核心：数据改变，清除缓存 ---
            }
        });
    }

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); this.updateStatusBar(); }

    getSaveTypeLabel(message: string): string { 
        if (message.includes('[Auto Save - On Modify]')) return '修改保存';
        if (message.includes('[Auto Save - Interval]')) return '定时保存';
        if (message.includes('[Auto Save - Background]')) return '后台保存';
        if (message.includes('[Full Snapshot]')) return '全库版本';
        if (message.includes('[Before Restore]')) return '恢复前备份';
        if (message.includes('[Auto Save')) return '自动保存';
        return '手动保存';
    }

    // --- 重写：智能剥离耗时逻辑与渲染逻辑 ---
    async updateStatusBar() {
        if (!this.settings.autoSave) { 
            this.statusBarItem.setText('⏸ 版本控制: 已暂停'); this.statusBarItem.title = '自动保存已暂停'; 
            this.activeFileLastSaveTime = null;
            return; 
        }
        const file = this.app.workspace.getActiveFile();
        if (!this.settings.showLastSaveTimeInStatusBar || !file) { 
            this.statusBarItem.setText(''); this.statusBarItem.title = ''; 
            this.activeFileLastSaveTime = null;
            return; 
        }
        
        const versions = await this.getAllVersions(file.path);
        if (versions.length > 0) {
            const lastVersion = versions[0]!;
            this.activeFileLastSaveTime = lastVersion.timestamp;
            this.activeFileSaveLabel = this.getSaveTypeLabel(lastVersion.message);
            this.lastModifiedTime.set(file.path, this.activeFileLastSaveTime);
            
            this.renderStatusBarTime();
        } else {
            this.lastModifiedTime.delete(file.path);
            this.activeFileLastSaveTime = null;
            this.statusBarItem.setText(''); this.statusBarItem.title = '';
        }
    }

    // --- 新增：极轻量级状态栏文字渲染 ---
    renderStatusBarTime() {
        if (this.activeFileLastSaveTime === null) return;
        const relativeTime = this.getRelativeTime(this.activeFileLastSaveTime);
        this.statusBarItem.setText(`${this.activeFileSaveLabel}: ${relativeTime}`);
        this.statusBarItem.title = `${this.activeFileSaveLabel}于 ${new Date(this.activeFileLastSaveTime).toLocaleString('zh-CN')}. 点击可快速对比。`;
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
        catch (error: unknown) { console.error('创建版本文件夹失败:', getErrorMessage(error), error); new Notice('⚠️ 无法创建版本文件夹,请检查权限'); }
    }

    async activateVersionHistoryView() { 
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType('version-history')[0];
        if (!leaf) { const rightLeaf = workspace.getRightLeaf(false); if (!rightLeaf) { new Notice('无法打开版本历史视图'); return; } leaf = rightLeaf; await leaf.setViewState({ type: 'version-history', active: true, }); }
        workspace.revealLeaf(leaf);
    }

    startAutoSave() { 
        if (this.autoSaveTimer) { window.clearInterval(this.autoSaveTimer); this.autoSaveTimer = null; }
        if (this.settings.autoSaveOnInterval) { 
            this.autoSaveTimer = window.setInterval(() => { this.autoSaveAllModifiedFiles(); }, this.settings.autoSaveInterval * 60 * 1000);
            this.registerInterval(this.autoSaveTimer);
        }
    }

    scheduleSave(file: TFile, delay: number, message: string) { 
        if (this.isExcluded(file.path)) return;
        if (delay === 0) { this.autoSaveFile(file, message); return; }
        
        let debouncer = this.debouncedSaves.get(file.path);
        if (!debouncer) {
            debouncer = debounce((f: TFile, msg: string) => { 
                if (this.isUnloaded) return;
                this.autoSaveFile(f, msg); 
            }, delay * 1000, true);
            this.debouncedSaves.set(file.path, debouncer);
        }
        debouncer(file, message);
    }

    async autoSaveFile(file: TFile, message: string) {
        if (!file || !this.app.vault.getAbstractFileByPath(file.path)) return;

        await this.withLock(file.path, async () => {
            try {
                const rawContent = await this.app.vault.read(file);
                const content = this.normalizeText(rawContent);
                
                const versions = await this.getAllVersions(file.path);
                let lastContent = '';
                if (versions.length > 0) {
                    const latestVersion = versions[0]!;
                    const currentHash = this.hashContent(content);
                    const currentHashOld = this.legacyStringHash(content);
                    if (latestVersion.hash === currentHash || latestVersion.hash === currentHashOld) return;
                    lastContent = await this.getVersionContent(file.path, latestVersion.id);
                }

                if (content === lastContent) return;

                const changeCount = this.countChanges(lastContent, content);
                if (changeCount < this.settings.autoSaveMinChanges) return;

                await this.createVersionInternal(file, message, false, [], false, content);
            } catch (error: unknown) { console.error('自动保存失败:', getErrorMessage(error), error); }
        });
    }

    countChanges(oldText: string, newText: string): number { 
        const changes = Diff.diffChars(oldText, newText); let changeCount = 0;
        for (const part of changes) { if (part.added || part.removed) { changeCount += part.value.length; } }
        return changeCount;
    }
    
    handleFileModify(file: TFile) { this.scheduleSave(file, this.settings.autoSaveDelayOnModify, '[Auto Save - On Modify]'); }

    async autoSaveAllModifiedFiles() { 
        const modifiedFiles = await this.getModifiedFiles();
        for (const item of modifiedFiles) {
            if (!this.isExcluded(item.file.path)) { await this.autoSaveFile(item.file, '[Auto Save - Interval]'); }
        }
    }
    
    isExcluded(filePath: string): boolean { return this.settings.excludedFolders.some(folder => filePath.startsWith(folder)); }

    async createManualVersion() {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice('没有打开的文件'); return; }

        const existingDebouncer = this.debouncedSaves.get(file.path);
        if (existingDebouncer) this.debouncedSaves.delete(file.path);

        // 直接保存版本，跳过输入界面，默认描述为 [Manual Save]
        await this.createVersion(file, '[Manual Save]', true, [], true);
    }

    normalizeText(text: string): string { return (!text) ? "" : text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"); }

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
            const currentHashOld = this.legacyStringHash(content); 
            
            const versionFile = await this.loadVersionFile(file.path);
            
            if (this.settings.enableDeduplication) {
                const latestVersion = versionFile.versions[0];
                if (latestVersion && (latestVersion.hash === hash || latestVersion.hash === currentHashOld)) {
                    let contentReallyIdentical = false;
                    try {
                        const prevContent = await this.getVersionContent(file.path, latestVersion.id, true);
                        if (prevContent === content) contentReallyIdentical = true;
                    } catch (e: unknown) { console.warn("Deduplication check failed", getErrorMessage(e), e); }

                    if (contentReallyIdentical) {
                        if (isManual && latestVersion.message.includes('[Auto Save')) {
                            latestVersion.message = message;
                            latestVersion.timestamp = timestamp;
                            latestVersion.tags = tags.length > 0 ? tags : latestVersion.tags;
                            await this.saveVersionFile(file.path, versionFile);
                            this.versionCache.set(file.path, versionFile);
                            this.refreshVersionHistoryView();
                            this.updateStatusBar();
                            this.clearGlobalCache(); // --- 极速秒开核心：数据改变，清除缓存 ---
                            if (showNotification && this.settings.showNotifications) new Notice(`✅ 版本已保存 (自动保存已更新)`);
                            return;
                        }
                        if (showNotification && this.settings.showNotifications) new Notice('ℹ️ 内容未变化,跳过创建版本');
                        return;
                    }
                }
            }

            let addedLines = 0, removedLines = 0;
            if (versionFile.versions.length > 0) {
                try {
                    const previousContentRaw = await this.getVersionContent(file.path, versionFile.versions[0]!.id);
                    const previousContent = this.normalizeText(previousContentRaw);
                    const diffResult = Diff.diffLines(previousContent + '\n', content + '\n');
                    diffResult.forEach(part => {
                        if (part.added) addedLines += part.count || 0;
                        if (part.removed) removedLines += part.count || 0;
                    });
                } catch (e: unknown) {}
            } else {
                addedLines = content.split('\n').length;
            }

            let newVersion: VersionData = {
                id, timestamp, message, content, size: content.length, hash,
                tags: tags.length > 0 ? tags : undefined, starred: false, addedLines, removedLines
            };

            if (this.settings.enableIncrementalStorage && versionFile.versions.length > 0) {
                const prevVersion = versionFile.versions[0]!;
                if (prevVersion.content !== undefined && prevVersion.content !== null) {
                    let chainLength = 1;
                    for (let i = 1; i < versionFile.versions.length; i++) {
                        const v = versionFile.versions[i]!;
                        if (v.diff && v.baseVersionId === versionFile.versions[i-1]!.id) chainLength++; else break;
                    }

                    if (chainLength < this.settings.rebuildBaseInterval) {
                        try {
                            const reversePatch = this.createDiff(content, prevVersion.content);
                            const testApply = Diff.applyPatch(content, reversePatch);
                            if (testApply !== false && this.normalizeText(testApply) === prevVersion.content) {
                                prevVersion.diff = reversePatch;
                                prevVersion.baseVersionId = id; 
                                prevVersion.size = reversePatch.length;
                                delete prevVersion.content; 
                            }
                        } catch (err: unknown) { console.error("生成逆向增量出错", getErrorMessage(err), err); }
                    }
                }
            }

            if (!versionFile.baseVersion && versionFile.versions.length === 0) versionFile.baseVersion = content;

            versionFile.versions.unshift(newVersion);
            versionFile.lastModified = timestamp;

            if (this.settings.autoClear) await this.cleanupVersionsInMemory(versionFile);

            this.buildVersionIndex(versionFile);
            await this.saveVersionFile(file.path, versionFile);
            
            this.versionCache.set(file.path, versionFile);
            this.contentCache.set(`${file.path}::${newVersion.id}`, content);

            this.refreshVersionHistoryView();
            this.lastModifiedTime.set(file.path, timestamp);
            this.updateStatusBar();
            this.clearGlobalCache(); // --- 极速秒开核心：数据改变，清除缓存 ---
            if (showNotification && this.settings.showNotifications) new Notice(`✅ 版本已保存: ${message}`);
        } catch (error: unknown) {
            console.error('保存版本失败:', getErrorMessage(error), error);
            new Notice('❌ 保存版本失败,请查看控制台');
        }
    }

    createDiff(oldContent: string, newContent: string): string { return Diff.createPatch('file', oldContent, newContent, '', ''); }
    applyDiff(baseContent: string, diffStr: string, suppressNotice: boolean = false): string { try { const result = Diff.applyPatch(baseContent, diffStr); if (result === false) { console.error('应用差异补丁失败'); if (!suppressNotice) { new Notice('应用差异补丁失败，版本内容可能不完整。'); } return baseContent; } return result; } catch (error: unknown) { return baseContent; } }
    buildVersionIndex(versionFile: VersionFile) { const index = new Map<string, number>(); versionFile.versions.forEach((version, idx) => { index.set(version.id, idx); }); versionFile.versionIndex = index; }
    
    resolveContentFromList(versions: VersionData[], versionId: string): string { 
        let currentId = versionId;
        let currentVersion = versions.find(v => v.id === currentId);
        if (!currentVersion) throw new Error(`无法在内存中找到版本: ${versionId}`);

        const patches: string[] = [];
        while (currentVersion) {
            if (currentVersion.content !== undefined && currentVersion.content !== null) {
                let content = this.normalizeText(currentVersion.content);
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
                        const fullContent = this.resolveContentFromList(versionFile.versions, v.id);
                        v.content = fullContent; v.diff = undefined; v.baseVersionId = undefined; v.size = fullContent.length;
                    } catch (error: unknown) { return 0; }
                }
            }
        }

        versionFile.versions = proposedList;
        this.clearGlobalCache(); // --- 极速秒开核心：数据改变，清除缓存 ---
        return originalCount - versionFile.versions.length;
    }

    async loadVersionFile(filePath: string): Promise<VersionFile> {
        if (this.versionCache.has(filePath)) return this.versionCache.get(filePath)!;

        const adapter = this.app.vault.adapter;
        const versionPath = this.getVersionFilePath(filePath); 
        let loadedContent: string | null = null;
        let finalVersionFile: VersionFile;

        if (await adapter.exists(versionPath)) {
            try {
                loadedContent = await this.readCompressedOrRaw(versionPath);
                finalVersionFile = JSON.parse(loadedContent) as VersionFile;
            } catch (e: unknown) { finalVersionFile = { filePath, versions: [], lastModified: Date.now() }; }
        } else {
            finalVersionFile = { filePath, versions: [], lastModified: Date.now() };
        }

        const legacyPaths = [this.getLegacyHashVersionFilePath(filePath), this.getLegacyStrictAsciiVersionFilePath(filePath), this.getLegacyVersionFilePath(filePath)];
        for (const lp of legacyPaths) {
            if (lp !== versionPath && await adapter.exists(lp)) {
                try {
                    const oldContent = await this.readCompressedOrRaw(lp);
                    const oldData = JSON.parse(oldContent) as VersionFile;
                    if (finalVersionFile.versions.length === 0) { finalVersionFile = oldData; finalVersionFile.filePath = filePath; } 
                    else {
                        const existingIds = new Set(finalVersionFile.versions.map(v => v.id));
                        for (const v of oldData.versions) { if (!existingIds.has(v.id)) finalVersionFile.versions.push(v); }
                        finalVersionFile.versions.sort((a, b) => b.timestamp - a.timestamp);
                    }
                    this.buildVersionIndex(finalVersionFile);
                    await this.saveVersionFile(filePath, finalVersionFile);
                    await adapter.remove(lp); 
                } catch (e: unknown) {}
            }
        }

        if (!finalVersionFile.versionIndex) this.buildVersionIndex(finalVersionFile);
        this.versionCache.set(filePath, finalVersionFile);
        return finalVersionFile;
    }

    async readCompressedOrRaw(path: string): Promise<string> {
        const adapter = this.app.vault.adapter;
        if (!await adapter.exists(path)) return "";
        try {
            if (this.settings.enableCompression) {
                try {
                    const rawData = await adapter.readBinary(path);
                    return pako.ungzip(new Uint8Array(rawData), { to: 'string' });
                } catch (e: unknown) {
                    if (getErrorMessage(e).includes('incorrect header check')) return await adapter.read(path);
                    throw e; 
                }
            } else {
                try {
                    const text = await adapter.read(path);
                    if (text && (text.trim().startsWith('{') || text.includes('"versions"'))) return text;
                } catch (e: unknown) {}
                const rawData = await adapter.readBinary(path);
                return pako.ungzip(new Uint8Array(rawData), { to: 'string' });
            }
        } catch (error: unknown) { throw new Error(`无法读取或解压: ${path}`); }
    }

    async saveVersionFile(filePath: string, versionFile: VersionFile) {
        const versionPath = this.getVersionFilePath(filePath);
        const adapter = this.app.vault.adapter;
        try {
            const dataToSave: any = { filePath: versionFile.filePath, versions: versionFile.versions, lastModified: versionFile.lastModified };
            if (versionFile.baseVersion !== undefined) dataToSave.baseVersion = versionFile.baseVersion;
            const content = JSON.stringify(dataToSave, null, 2);
            if (this.settings.enableCompression) {
                const compressed = pako.gzip(content);
                const safeBuffer = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength);
                await adapter.writeBinary(versionPath, safeBuffer);
            } else { await adapter.write(versionPath, content); }
        } catch (error: unknown) { throw error; }
    }

    sanitizeFileName(path: string): string { return path.replace(/[\/\\:*?"<>|]/g, '_'); }
    async getAllVersions(filePath: string): Promise<VersionData[]> { try { const versionFile = await this.loadVersionFile(filePath); return versionFile.versions; } catch (error: unknown) { return []; } }
    
    async getVersionContent(filePath: string, versionId: string, suppressNotice: boolean = false, strictMode: boolean = false): Promise<string> { 
        const cacheKey = `${filePath}::${versionId}`;
        const cached = this.contentCache.get(cacheKey);
        if (cached) return cached;

        try { 
            const versionFile = await this.loadVersionFile(filePath); 
            let currentId = versionId;
            const patches: string[] = [];
            let baseContent = "";

            while (true) {
                const index = versionFile.versionIndex?.get(currentId);
                const version = index !== undefined ? versionFile.versions[index] : versionFile.versions.find(v => v.id === currentId);
                if (!version) throw new Error(`版本不存在`);

                if (version.content !== undefined && version.content !== null) { baseContent = this.normalizeText(version.content); break; }

                if (version.diff) {
                    patches.push(version.diff);
                    if (version.baseVersionId) currentId = version.baseVersionId;
                    else if (versionFile.baseVersion !== undefined && versionFile.baseVersion !== null) { baseContent = this.normalizeText(versionFile.baseVersion); break; } 
                    else throw new Error(`依赖断裂`);
                } else throw new Error(`数据丢失`);
            }

            let resultContent = baseContent;
            for (let i = patches.length - 1; i >= 0; i--) {
                const result = Diff.applyPatch(resultContent, patches[i]!);
                if (result === false) {
                    if (strictMode) throw new Error("增量补丁应用失败");
                    if (!suppressNotice) new Notice(`⚠️ 版本 ${versionId.substring(0,8)} 数据损坏，仅显示基准内容。`);
                    return resultContent;
                }
                resultContent = this.normalizeText(result);
            }
            this.contentCache.set(cacheKey, resultContent);
            return resultContent;
        } catch (error: unknown) { throw new Error(`无法读取版本内容: ${getErrorMessage(error)}`); } 
    }

    async verifyVersionFileIntegrity(filePath: string): Promise<boolean> { const errors = await this.verifyFileVersion(filePath); return errors.length === 0; }
    
    async verifyFileVersion(filePath: string): Promise<string[]> {
        const errors: string[] = [];
        let versionPath = await this.findExistingVersionPath(filePath);
        if (!versionPath) return []; 
        const adapter = this.app.vault.adapter;
        let versionFile: VersionFile;
        try {
            let content: string;
            if (this.settings.enableCompression) {
                try {
                    const rawData = await adapter.readBinary(versionPath);
                    content = pako.ungzip(new Uint8Array(rawData), { to: 'string' });
                } catch (e: unknown) {
                    try { content = await adapter.read(versionPath); JSON.parse(content); } 
                    catch (e2: unknown) { throw new Error("文件损坏"); }
                }
            } else { content = await adapter.read(versionPath); }
            versionFile = JSON.parse(content) as VersionFile;
        } catch (error: unknown) { errors.push(`文件读取失败`); return errors; }
        
        if (!versionFile.versions || !Array.isArray(versionFile.versions)) { errors.push("结构错误"); return errors; } 
        const versionMap = new Map<string, VersionData>(); 
        versionFile.versions.forEach(v => versionMap.set(v.id, v)); 
        for (const version of versionFile.versions) { 
            if (!version.id || !version.timestamp) continue; 
            if (version.diff) { 
                if (!version.baseVersionId && !versionFile.baseVersion) errors.push(`版本 ${version.id.substring(0,8)}: 缺少 baseVersionId`);
                else if (version.baseVersionId && !versionMap.has(version.baseVersionId)) errors.push(`版本 ${version.id.substring(0,8)}: 依赖基准丢失`);
            } else if (version.content === undefined) errors.push(`版本 ${version.id.substring(0,8)}: 数据丢失`); 
            try { 
                const content = await this.getVersionContent(filePath, version.id, true, true); 
                if (version.hash) { 
                    if (this.hashContent(content) !== version.hash && this.legacyStringHash(content) !== version.hash) { 
                        errors.push(`版本 ${version.id.substring(0,8)}: 哈希不匹配`); 
                    } 
                } 
            } catch (e: unknown) { errors.push(`版本 ${version.id.substring(0,8)}: 还原失败`); } 
        }
        return errors;
    }

    async checkAllVersionsIntegrity() { 
        const adapter = this.app.vault.adapter; 
        const folderPath = this.settings.versionFolder; 
        if (!await adapter.exists(folderPath)) return; 
        const files = await adapter.list(folderPath); 
        const jsonFiles = files.files.filter(f => f.endsWith('.json')); 
        const total = jsonFiles.length; 
        const notice = new Notice(`检查完整性... 0/${total}`, 0); 
        const report: { filePath: string; errors: string[] }[] = []; 
        for (let i = 0; i < total; i++) { 
            const file = jsonFiles[i]!; 
            let originalFilePath = file.replace(folderPath + '/', '').replace('.json', ''); 
            try { 
                let contentStr = await adapter.read(file).catch(()=>""); 
                if (!contentStr.startsWith('{')) { 
                    const bin = await adapter.readBinary(file).catch(()=>null); 
                    if(bin) contentStr = pako.ungzip(new Uint8Array(bin), { to: 'string' }); 
                } 
                if (contentStr) originalFilePath = (JSON.parse(contentStr) as VersionFile).filePath || originalFilePath; 
            } catch (e: unknown) {} 
            const errors = await this.verifyFileVersion(originalFilePath); 
            if (errors.length > 0) report.push({ filePath: originalFilePath, errors }); 
            if (i % 5 === 0) { notice.setMessage(`检查完整性... ${i + 1}/${total}`); await this.yieldToMain(); } 
        } 
        notice.hide(); 
        new IntegrityReportModal(this.app, this, report).open(); 
    }

    async repairVersionFile(filePath: string): Promise<boolean> {
        return new Promise(async (resolve) => {
             await this.withLock(filePath, async () => {
                const versionFile = await this.loadVersionFile(filePath);
                let fixedCount = 0;
                if (!versionFile.versionIndex) this.buildVersionIndex(versionFile);
                for (const version of versionFile.versions) { 
                    if (version.hash) { 
                        try { 
                            const content = await this.getVersionContent(filePath, version.id, true); 
                            const currentHash = this.hashContent(content); 
                            if (currentHash !== version.hash) { version.hash = currentHash; fixedCount++; } 
                        } catch (e: unknown) {} 
                    } 
                }
                if (fixedCount > 0) { await this.saveVersionFile(filePath, versionFile); this.versionCache.set(filePath, versionFile); resolve(true); } 
                else resolve(false);
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
                    this.clearGlobalCache(); // --- 极速秒开核心：数据改变，清除缓存 ---
                }
            } catch (error: unknown) { }
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
                    this.clearGlobalCache(); // --- 极速秒开核心：数据改变，清除缓存 ---
                }
            } catch (error: unknown) { }
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
                    this.clearGlobalCache(); // --- 极速秒开核心：数据改变，清除缓存 ---
                }
            } catch (error: unknown) {}
        });
    }

    async starLastVersion() { const file = this.app.workspace.getActiveFile(); if (!file) return; const versions = await this.getAllVersions(file.path); if (versions.length === 0) return; await this.toggleVersionStar(file.path, versions[0]!.id); this.refreshVersionHistoryView(); new Notice('⭐ 已标记/取消标记'); }
    async quickPreviewLastVersion() { const file = this.app.workspace.getActiveFile(); if (!file) return; const versions = await this.getAllVersions(file.path); if (versions.length === 0) return; new QuickPreviewModal(this.app, this, file, versions[0]!.id).open(); }

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
                this.clearGlobalCache(); // --- 极速秒开核心：数据改变，清除缓存 ---
            } catch (error: unknown) {}
        });
    }

    async deleteVersions(filePath: string, versionIds: string[]) {
        await this.withLock(filePath, async () => {
            try {
                const versionFile = await this.loadVersionFile(filePath);
                const idsSet = new Set(versionIds);
                const remainingVersions = versionFile.versions.filter(v => !idsSet.has(v.id));
                const isAnyDeletedVersionADependency = remainingVersions.some(v => v.baseVersionId && idsSet.has(v.baseVersionId));
                if (isAnyDeletedVersionADependency) { new Notice('❌ 包含被依赖的项，删除失败。', 5000); return; }
                versionFile.versions = remainingVersions;
                versionFile.lastModified = Date.now();
                this.buildVersionIndex(versionFile);
                await this.saveVersionFile(filePath, versionFile);
                this.versionCache.set(filePath, versionFile);
                this.refreshVersionHistoryView();
                this.clearGlobalCache(); // --- 极速秒开核心：数据改变，清除缓存 ---
            } catch (error: unknown) {}
        });
    }

    async restoreVersion(file: TFile, versionId: string) {
        this.isRestoring = true;
        try {
            await this.createVersion(file, '[Before Restore]', false);
            const content = await this.getVersionContent(file.path, versionId);
            await this.app.vault.modify(file, content);
            if (this.settings.showNotifications) new Notice('✅ 版本已恢复');
            this.refreshVersionHistoryView();
        } catch (error: unknown) { new Notice('❌ 恢复版本失败'); } 
        finally { setTimeout(() => { this.isRestoring = false; }, 500); }
    }

    async restoreLastVersion() { const file = this.app.workspace.getActiveFile(); if (!file) return; const versions = await this.getAllVersions(file.path); if (versions.length === 0) return; const lastVersion = versions[0]!; new ConfirmModal(this.app, '恢复到上一版本', `确定要恢复到: ${this.formatTime(lastVersion.timestamp)}?`, async () => { await this.restoreVersion(file!, lastVersion.id); }).open(); }
    async quickCompare() { const file = this.app.workspace.getActiveFile(); if (!file) return; const versions = await this.getAllVersions(file.path); if (versions.length === 0) return; const lastVersion = versions[0]!; new DiffModal(this.app, this, file!, lastVersion.id).open(); }
    async createFullSnapshot() { const files = this.app.vault.getMarkdownFiles(); const total = files.length; let count = 0; const progressNotice = new Notice(`正在保存全库版本... (0/${total})`, 0); for (let i = 0; i < total; i++) { const file = files[i]!; if (i % 10 === 0) { progressNotice.setMessage(`保存全库版本... (${i + 1}/${total})`); await this.yieldToMain(); } if (this.isExcluded(file.path)) continue; try { await this.createVersion(file!, '[Full Snapshot]', false, [], true); count++; } catch (e: unknown) {} } progressNotice.hide(); new Notice(`✅ 全库版本创建完成: ${count} 个文件`); }
    async optimizeAllVersionFiles() { const progressNotice = new Notice('正在优化存储...', 0); try { const adapter = this.app.vault.adapter; const versionFolder = this.settings.versionFolder; if (!await adapter.exists(versionFolder)) { progressNotice.hide(); return; } const files = await adapter.list(versionFolder); let optimized = 0; let savedBytes = 0; for (const file of files.files) { if (file.endsWith('.json')) { try { const oldSize = (await adapter.stat(file))?.size || 0; const filePath = file.replace(this.settings.versionFolder + '/', '').replace('.json', ''); const versionFile = await this.loadVersionFile(filePath); this.buildVersionIndex(versionFile); await this.saveVersionFile(versionFile.filePath, versionFile); const newSize = (await adapter.stat(file))?.size || 0; savedBytes += (oldSize - newSize); optimized++; } catch (error: unknown) {} } } progressNotice.hide(); new Notice(`✅ 优化完成: 节省 ${this.formatFileSize(savedBytes)}`); } catch (error: unknown) { progressNotice.hide(); } }
    async getStorageStats(): Promise<{ totalSize: number; versionCount: number; fileCount: number; compressionRatio: number; starredCount: number; taggedCount: number }> { const adapter = this.app.vault.adapter; const versionFolder = this.settings.versionFolder; try { if (!await adapter.exists(versionFolder)) { return { totalSize: 0, versionCount: 0, fileCount: 0, compressionRatio: 0, starredCount: 0, taggedCount: 0 }; } const files = await adapter.list(versionFolder); let totalSize = 0; let versionCount = 0; let fileCount = 0; let totalOriginalSize = 0; let starredCount = 0; let taggedCount = 0; for (const file of files.files) { if (file.endsWith('.json')) { try { const stat = await adapter.stat(file); const fileSize = stat?.size || 0; totalSize += fileSize; let versionFile: VersionFile; if (this.settings.enableCompression) { try { const rawData = await adapter.readBinary(file); const decompressed = pako.ungzip(new Uint8Array(rawData), { to: 'string' }); versionFile = JSON.parse(decompressed) as VersionFile; } catch (e: unknown) { const content = await adapter.read(file); versionFile = JSON.parse(content) as VersionFile; } } else { const content = await adapter.read(file); versionFile = JSON.parse(content) as VersionFile; } if (versionFile.versions && Array.isArray(versionFile.versions)) { versionCount += versionFile.versions.length; versionFile.versions.forEach(v => { if (v.content) { totalOriginalSize += v.content.length; } else if (v.diff) { totalOriginalSize += v.diff.length; } if (v.starred) starredCount++; if (v.tags && v.tags.length > 0) taggedCount++; }); fileCount++; } } catch (error: unknown) {} } } const compressionRatio = totalOriginalSize > 0 ? ((1 - totalSize / totalOriginalSize) * 100) : 0; return { totalSize, versionCount, fileCount, compressionRatio, starredCount, taggedCount }; } catch (error: unknown) { return { totalSize: 0, versionCount: 0, fileCount: 0, compressionRatio: 0, starredCount: 0, taggedCount: 0 }; } }
    async exportVersions(filePath: string): Promise<void> { try { const versionFile = await this.loadVersionFile(filePath); const exportPath = normalizePath(`${this.settings.versionFolder}/export_${this.sanitizeFileName(filePath)}_${Date.now()}.json`); await this.app.vault.adapter.write(exportPath, JSON.stringify(versionFile, null, 2)); new Notice(`✅ 已导出到: ${exportPath}`); } catch (error: unknown) { new Notice('❌ 导出失败'); } }
    async exportVersionAsFile(filePath: string, versionId: string): Promise<void> { try { const content = await this.getVersionContent(filePath, versionId); const fileName = filePath.replace(/\.[^/.]+$/, ''); const exportPath = normalizePath(`${fileName}_v${versionId.substring(0,8)}.md`); await this.app.vault.create(exportPath, content); new Notice(`✅ 已导出为: ${exportPath}`); } catch (error: unknown) { new Notice('❌ 导出失败'); } }
    
    async getModifiedFiles(): Promise<{ file: TFile, lastVersionTime: number }[]> {
        const files = this.app.vault.getMarkdownFiles();
        const modifiedFiles: { file: TFile, lastVersionTime: number }[] = [];
        let count = 0;
        for (const file of files) {
            if (this.isExcluded(file.path)) continue;
            count++; if (count % 20 === 0) await this.yieldToMain();
            const versionPath = await this.findExistingVersionPath(file.path);
            if (versionPath) {
                try {
                    const stat = await this.app.vault.adapter.stat(versionPath);
                    if (!stat) continue;
                    // 第一层拦截：如果文件修改时间确实更新了
                    if (file.stat.mtime > stat.mtime + 2000) {
                        const versionFile = await this.loadVersionFile(file.path);
                        const lastVersion = versionFile.versions.length > 0 ? versionFile.versions[0] : null;
                        
                        if (lastVersion) {
                            // --- 内容真实性校验 (防止改了又删回去的情况) ---
                            const rawContent = await this.app.vault.read(file);
                            const content = this.normalizeText(rawContent);
                            const currentHash = this.hashContent(content);
                            const currentHashOld = this.legacyStringHash(content);
                            
                            // 如果当前内容算出来的哈希，跟上一个版本的哈希完全一样，说明内容其实没变！直接跳过。
                            if (lastVersion.hash === currentHash || lastVersion.hash === currentHashOld) {
                                continue;
                            }
                            modifiedFiles.push({ file, lastVersionTime: lastVersion.timestamp });
                        } else {
                            modifiedFiles.push({ file, lastVersionTime: 0 });
                        }
                    }
                } catch (e: unknown) {}
            } else { modifiedFiles.push({ file, lastVersionTime: 0 }); }
        }
        return modifiedFiles.sort((a, b) => b.file.stat.mtime - a.file.stat.mtime);
    }

    // --- 智能相对时间格式化（平滑过渡到 1 分钟） ---
    getRelativeTime(timestamp: number): string { 
        const diff = Math.max(0, Date.now() - timestamp);
        if (diff < 60000) {
            const seconds = Math.floor(diff / 1000);
            return `${seconds}秒前`;
        } else if (diff >= 60000 && diff < 120000) {
            return `1分钟前`;
        }
        return moment(timestamp).fromNow(); 
    }

    async getGlobalHistory(limit: number = 100): Promise<{ version: VersionData, filePath: string, file: TFile | null }[]> {
        // --- 极速秒开核心：如果内存里有缓存，直接 0 毫秒返回！ ---
        if (this.globalHistoryCache) {
            return this.globalHistoryCache.slice(0, limit);
        }

        const adapter = this.app.vault.adapter;
        const versionFolder = this.settings.versionFolder;
        if (!await adapter.exists(versionFolder)) return [];

        const filesData = await adapter.list(versionFolder);
        const jsonFiles = filesData.files.filter(f => f.endsWith('.json'));
        
        const fileStats = await Promise.all(jsonFiles.map(async file => {
            const stat = await adapter.stat(file); return { file, mtime: stat ? stat.mtime : 0 };
        }));
        fileStats.sort((a, b) => b.mtime - a.mtime);

        // 为了极速响应，首次提取时只读取最近修改的前 20 个文件
        const targetFiles = fileStats.slice(0, 20).map(item => item.file);
        const allVersions: { version: VersionData, filePath: string, file: TFile | null }[] = [];

        let count = 0;
        for (const vFile of targetFiles) {
            count++; 
            // 增加防卡顿频率，每处理 4 个文件释放一下主线程，防假死
            if (count % 4 === 0) await this.yieldToMain();
            try {
                const contentStr = await this.readCompressedOrRaw(vFile);
                if (!contentStr) continue;
                const data = JSON.parse(contentStr) as VersionFile;
                if (!data.versions) continue;

                // 顺手塞进内存缓存，一会儿点击“对比”或者“预览”时就能秒开了
                this.versionCache.set(data.filePath, data);

                const tFile = this.app.vault.getAbstractFileByPath(data.filePath);
                data.versions.slice(0, 15).forEach(v => {
                    allVersions.push({ version: v, filePath: data.filePath, file: (tFile instanceof TFile) ? tFile : null });
                });
            } catch (e: unknown) {}
        }
        allVersions.sort((a, b) => b.version.timestamp - a.version.timestamp);
        
        // --- 极速秒开核心：保存到全局缓存 ---
        this.globalHistoryCache = allVersions;
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
    formatTime(timestamp: number): string { return this.settings.useRelativeTime ? moment(timestamp).fromNow() : moment(timestamp).format('YYYY-MM-DD HH:mm:ss'); }
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
                navigator.clipboard.writeText(this.versionContent).then(() => { new Notice('✅ 内容已复制'); }).catch(() => { new Notice('❌ 复制失败'); });
            });

            const restoreBtn = toolbar.createEl('button', { text: '↩️ 恢复此版本' });
            restoreBtn.addEventListener('click', async () => { this.close(); await this.plugin.restoreVersion(this.file, this.versionId); });

            const compareBtn = toolbar.createEl('button', { text: '🔀 详细对比' });
            compareBtn.addEventListener('click', () => { this.close(); new DiffModal(this.app, this.plugin, this.file, this.versionId).open(); });

            const exportBtn = toolbar.createEl('button', { text: '💾 导出文件' });
            exportBtn.addEventListener('click', async () => { await this.plugin.exportVersionAsFile(this.file.path, this.versionId); });

            this.contentContainer = contentEl.createEl('div', { cls: 'preview-content-container' });
            this.renderContent();

            const statsBar = contentEl.createEl('div', { cls: 'preview-stats-bar' });
            const lines = this.versionContent.split('\n');
            statsBar.createEl('span', { text: `📝 ${lines.length} 行` });
            statsBar.createEl('span', { text: `🔤 ${this.versionContent.length} 字符` });
            const words = this.plugin.countWords(this.versionContent);
            statsBar.createEl('span', { text: `📄 ${words.toLocaleString()} 词` });

        } catch (error: unknown) { contentEl.createEl('p', { text: '❌ 加载预览失败' }); }
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

    onClose() { this.contentEl.empty(); }
}

// --- 性能重构：侧边栏视图全面解耦、事件委托与局部刷新 ---
class VersionHistoryView extends ItemView {
    plugin: VersionControlPlugin;
    selectedVersions: Set<string> = new Set();
    currentFile: TFile | null = null;
    searchQuery: string = '';
    currentPage: number = 0;
    totalVersions: number = 0;
    filterTag: string | null = null;
    showStarredOnly: boolean = false;
    showUniqueFilesOnly: boolean = true; 
    
    currentViewMode: ViewMode = 'current';
    isRefreshing: boolean = false;
    collapsedGroups: Set<string> = new Set(); 
    scrollPositions: Map<ViewMode, number> = new Map(); // 新增：分 Tab 记忆滚动条位置

    constructor(leaf: WorkspaceLeaf, plugin: VersionControlPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string { return 'version-history'; }
    getDisplayText(): string { return '版本历史'; }
    getIcon(): string { return 'history'; }

    async onOpen() {
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                if (this.currentViewMode === 'current') {
                    const activeFile = this.app.workspace.getActiveFile();
                    if (activeFile && (!this.currentFile || this.currentFile.path !== activeFile.path)) {
                        this.currentPage = 0; this.selectedVersions.clear(); this.refresh();
                    } else if (!activeFile && this.currentFile) {
                        this.currentFile = null; this.refresh();
                    }
                }
            })
        );
        
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (this.currentViewMode === 'current' && this.currentFile && oldPath === this.currentFile.path) {
                    if (file instanceof TFile) { this.currentFile = file; this.refresh(); }
                }
            })
        );
        
        await this.refresh();
    }

    updateRelativeTimes() {
        if (this.plugin.settings.useRelativeTime) {
            const timeElements = this.contentEl.querySelectorAll('.version-time');
            timeElements.forEach(el => {
                const timestampStr = (el as HTMLElement).dataset.timestamp;
                if (timestampStr) {
                    const timestamp = parseInt(timestampStr, 10);
                    el.textContent = this.plugin.getRelativeTime(timestamp);
                }
            });
        }
        
        // 强制定时刷新的内联相对时间元素
        const inlineRelativeElements = this.contentEl.querySelectorAll('.version-global-relative-time-inline');
        inlineRelativeElements.forEach(el => {
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

    async refresh() {
        if (this.isRefreshing) return;
        this.isRefreshing = true;

        const realContainer = this.contentEl;
        
        // 刷新前，捕获并保存当前的滚动条位置
        const currentScrollArea = realContainer.querySelector('.vc-content-area');
        if (currentScrollArea) {
            this.scrollPositions.set(this.currentViewMode, currentScrollArea.scrollTop);
        }

        try {
            const buffer = createDiv();
            buffer.addClass('version-history-view');
            if (this.plugin.settings.compactHistoryView) buffer.addClass('is-compact');

            this.renderTabs(buffer);

            const contentContainer = buffer.createEl('div', { cls: 'vc-content-area' });
            
            // 下方渲染是异步的，所以在各渲染函数底部执行滚动条恢复
            if (this.currentViewMode === 'current') await this.renderCurrentFileHistory(contentContainer);
            else if (this.currentViewMode === 'modified') await this.renderModifiedFiles(contentContainer);
            else if (this.currentViewMode === 'global') await this.renderGlobalHistory(contentContainer);

            realContainer.empty();
            realContainer.appendChild(buffer);

        } catch (error: unknown) {
            console.error("Version History Refresh Error:", getErrorMessage(error), error);
            realContainer.empty(); realContainer.createEl('div', { text: '加载出错，请查看控制台。' });
        } finally {
            this.isRefreshing = false;
        }
    }

    renderTabs(container: HTMLElement) {
        const tabBar = container.createEl('div', { cls: 'vc-tab-bar' });
        const tabs: {id: ViewMode, label: string}[] = [
            { id: 'current', label: '当前文件' }, { id: 'modified', label: '待保存' }, { id: 'global', label: '全库历史' }
        ];

        tabs.forEach(tab => {
            const btn = tabBar.createEl('button', { cls: `vc-tab-btn ${this.currentViewMode === tab.id ? 'mod-cta' : ''}`, attr: { title: tab.label } });
            btn.setText(tab.label);
            btn.addEventListener('click', () => { 
                this.currentViewMode = tab.id; 
                this.currentPage = 0; 
                this.scrollPositions.set(tab.id, 0); // 切换 Tab 时重置滚动条为顶部
                this.refresh(); 
            });
        });

        // 紧凑模式切换按钮
        const compactBtn = tabBar.createEl('button', { 
            cls: 'vc-global-refresh', 
            attr: { 'aria-label': '切换紧凑/宽松视图', 'title': '切换紧凑视图' } 
        });
        setIcon(compactBtn, this.plugin.settings.compactHistoryView ? 'list' : 'align-justify');
        compactBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            this.plugin.settings.compactHistoryView = !this.plugin.settings.compactHistoryView;
            await this.plugin.saveSettings();
            this.refresh();
        });

        const refreshBtn = tabBar.createEl('button', { cls: 'vc-global-refresh', attr: { 'aria-label': '强制刷新', 'title': '强制刷新全库缓存' } });
        setIcon(refreshBtn, 'refresh-cw'); 
        refreshBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            if (this.isRefreshing) return; 
            refreshBtn.addClass('is-spinning'); 
            
            // 手动点击刷新按钮时，强制清空缓存
            if (this.currentViewMode === 'current' && this.currentFile) this.plugin.versionCache.delete(this.currentFile.path);
            else if (this.currentViewMode === 'global' || this.currentViewMode === 'modified') {
                this.plugin.versionCache.clear(); 
                this.plugin.clearGlobalCache(); // --- 极速秒开核心：手动刷新强制清除全局缓存 ---
            }
            
            await this.refresh(); 
            setTimeout(() => { refreshBtn.removeClass('is-spinning'); }, 300);
        });
    }

    // 更新批量操作工具栏（局部刷新）
    updateBatchToolbar(container: HTMLElement, file: TFile) {
        let toolbar = container.querySelector('.version-batch-toolbar') as HTMLElement;
        if (this.selectedVersions.size > 0) {
            if (!toolbar) {
                toolbar = container.createEl('div', { cls: 'version-toolbar version-batch-toolbar' });
                // 插入到 header 下方，list 上方
                const header = container.querySelector('.version-header');
                if (header && header.nextSibling) {
                    header.parentNode?.insertBefore(toolbar, header.nextSibling);
                } else {
                    container.prepend(toolbar);
                }
                const label = toolbar.createEl('span', { cls: 'batch-count-label' });
                const clearBtn = toolbar.createEl('button', { text: '清空选择' });
                clearBtn.addEventListener('click', () => {
                    this.selectedVersions.clear();
                    const checkboxes = container.querySelectorAll('.version-checkbox') as NodeListOf<HTMLInputElement>;
                    checkboxes.forEach(cb => cb.checked = false);
                    this.updateBatchToolbar(container, file);
                });
                const deleteBtn = toolbar.createEl('button', { text: '批量删除', cls: 'mod-warning' });
                deleteBtn.addEventListener('click', () => this.batchDelete(file));
            }
            toolbar.querySelector('.batch-count-label')!.textContent = `已选择 ${this.selectedVersions.size} 个版本`;
        } else if (toolbar) {
            toolbar.remove();
        }
    }

    async renderCurrentFileHistory(container: HTMLElement) {
        const file = this.app.workspace.getActiveFile();
        this.currentFile = file;
        if (!file) { this.renderEmptyState(container, '请先打开一个文件'); return; }

        // --- Header 吸顶 ---
        const header = container.createEl('div', { cls: 'version-header' });
        const title = header.createEl('div', { cls: 'version-title' });
        title.createEl('h3', { text: file.basename });
        title.createEl('span', { text: file.path, cls: 'version-file-path' });

        const fileStats = header.createEl('div', { cls: 'version-file-stats' });
        try {
            const currentContent = await this.app.vault.read(file);
            const stat = await this.app.vault.adapter.stat(file.path);
            fileStats.createEl('span', { text: `📄 ${this.plugin.formatFileSize(currentContent.length)}`, cls: 'file-stat-item' });
            if (stat) fileStats.createEl('span', { text: `📅 ${new Date(stat.mtime).toLocaleString('zh-CN')}`, cls: 'file-stat-item' });
        } catch (error: unknown) {}

        const actions = header.createEl('div', { cls: 'version-header-actions' });
        const searchInput = actions.createEl('input', { type: 'text', placeholder: '搜索版本...', cls: 'version-search' });
        searchInput.value = this.searchQuery;
        searchInput.addEventListener('input', (e) => { this.searchQuery = (e.target as HTMLInputElement).value; this.currentPage = 0; this.refresh(); });

        // --- 重构：为按钮添加图标以便在移动端显示 ---
        const starFilterBtn = actions.createEl('button', { 
            cls: this.showStarredOnly ? 'mod-cta' : '',
            attr: { 'aria-label': '仅显示星标版本' }
        });
        setIcon(starFilterBtn, 'star');
        starFilterBtn.createEl('span', { text: this.showStarredOnly ? '已筛星标' : '筛选星标' });
        starFilterBtn.addEventListener('click', () => { this.showStarredOnly = !this.showStarredOnly; this.currentPage = 0; this.refresh(); });

        const createBtn = actions.createEl('button', { cls: 'mod-cta', attr: { 'aria-label': '创建新版本' } });
        setIcon(createBtn, 'plus-circle');
        createBtn.createEl('span', { text: '创建' });
        createBtn.addEventListener('click', () => { this.plugin.createManualVersion(); });

        const moreMenuBtn = actions.createEl('button', { attr: { 'aria-label': '更多操作' } });
        setIcon(moreMenuBtn, 'more-horizontal');
        moreMenuBtn.createEl('span', { text: '更多' });
        moreMenuBtn.addEventListener('click', (e) => {
            const menu = new Menu();
            menu.addItem((item) => item.setTitle('📊 查看统计').setIcon('bar-chart').onClick(() => { this.showDetailedStats(); }));
            menu.addItem((item) => item.setTitle('📥 导出版本数据').setIcon('download').onClick(() => { this.plugin.exportVersions(file.path); }));
            menu.addItem((item) => item.setTitle('🗑️ 清理旧版本').setIcon('trash').onClick(async () => { await this.cleanupOldVersions(file); }));
            menu.showAtMouseEvent(e as MouseEvent);
        });

        // 异步加载版本文件
        const versionFile = await this.plugin.loadVersionFile(file.path);
        const allVersions = versionFile.versions;
        this.totalVersions = allVersions.length;

        // 收集被依赖的基准版本 ID (锁定标记)
        const dependentIds = new Set<string>();
        allVersions.forEach(v => { if (v.baseVersionId) dependentIds.add(v.baseVersionId); });

        if (this.totalVersions === 0) { this.renderEmptyState(container, '暂无版本历史'); return; }

        // 过滤
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

        if (filteredVersions.length === 0) { this.renderEmptyState(container, `未找到匹配的版本`); return; }

        // 分页
        const perPage = this.plugin.settings.versionsPerPage > 0 ? this.plugin.settings.versionsPerPage : filteredVersions.length;
        const totalPages = Math.ceil(filteredVersions.length / perPage);
        if (this.currentPage >= totalPages) this.currentPage = Math.max(0, totalPages - 1);
        const start = this.currentPage * perPage;
        const end = Math.min(start + perPage, filteredVersions.length);
        const pageVersions = filteredVersions.slice(start, end);

        this.updateBatchToolbar(container, file);

        const listContainer = container.createEl('div', { cls: 'version-list' });

        // --- 事件委托：统一拦截所有版本卡片的点击事件 ---
        listContainer.addEventListener('click', async (e) => {
            const target = e.target as HTMLElement;
            const actionEl = target.closest('[data-action]');
            if (!actionEl) return;

            const action = actionEl.getAttribute('data-action');
            const versionId = actionEl.getAttribute('data-version-id');
            if (!versionId) return;

            if (action === 'star') {
                e.stopPropagation();
                // 局部刷新：先乐观修改 DOM
                const isStarred = actionEl.textContent === '⭐';
                actionEl.textContent = isStarred ? '☆' : '⭐';
                const itemEl = actionEl.closest('.version-item');
                if (itemEl) {
                    if (isStarred) itemEl.classList.remove('version-starred');
                    else itemEl.classList.add('version-starred');
                }
                // 后台更新文件
                await this.plugin.toggleVersionStar(file.path, versionId);
            } else if (action === 'restore') {
                this.confirmRestore(file, versionId);
            } else if (action === 'compare') {
                this.showDiffModal(file, versionId);
            } else if (action === 'preview') {
                new QuickPreviewModal(this.app, this.plugin, file, versionId).open();
            } else if (action === 'more') {
                const version = pageVersions.find(v => v.id === versionId);
                if (version) this.showVersionContextMenu(e as MouseEvent, file, version, dependentIds.has(versionId));
            } else if (action === 'filter-tag') {
                this.filterTag = actionEl.textContent; this.currentPage = 0; this.refresh();
            }
        });

        // 统一拦截复选框
        listContainer.addEventListener('change', (e) => {
            const target = e.target as HTMLInputElement;
            if (target.matches('.version-checkbox')) {
                const versionId = target.getAttribute('data-version-id');
                if (versionId) {
                    if (target.checked) this.selectedVersions.add(versionId);
                    else this.selectedVersions.delete(versionId);
                    this.updateBatchToolbar(container, file);
                }
            }
        });

        // --- 渲染卡片分组 ---
        const groupedVersions: { [key: string]: VersionData[] } = {};
        pageVersions.forEach(version => {
            const group = this.getRelativeDateGroup(version.timestamp);
            if (!groupedVersions[group]) groupedVersions[group] = [];
            groupedVersions[group]!.push(version);
        });

        const pendingStatsQueue: string[] = []; // 用于异步计算差异统计的任务队列

        for (const groupName in groupedVersions) {
            const versionsInGroup = groupedVersions[groupName]!;
            
            // 可折叠分组 Header
            const groupHeader = listContainer.createEl('h4', { cls: 'version-group-header' });
            const isCollapsed = this.collapsedGroups.has(groupName);
            groupHeader.innerHTML = `<span class="group-chevron">${isCollapsed ? '▶' : '▼'}</span> ${groupName} <span class="group-count">(${versionsInGroup.length})</span>`;
            
            const groupContent = listContainer.createEl('div', { cls: 'version-group-content' });
            if (isCollapsed) groupContent.style.display = 'none';

            groupHeader.addEventListener('click', () => {
                const collapsed = groupContent.style.display === 'none';
                if (collapsed) {
                    groupContent.style.display = '';
                    groupHeader.querySelector('.group-chevron')!.textContent = '▼';
                    this.collapsedGroups.delete(groupName);
                } else {
                    groupContent.style.display = 'none';
                    groupHeader.querySelector('.group-chevron')!.textContent = '▶';
                    this.collapsedGroups.add(groupName);
                }
            });

            // 渲染组内的卡片
            for (const version of versionsInGroup) {
                this.createVersionCard(groupContent, version, dependentIds);
                
                // 收集需要异步计算差异的任务
                if (typeof version.addedLines !== 'number') {
                    pendingStatsQueue.push(version.id);
                }
            }
        }

        // 分页组件
        if (totalPages > 1) {
            const pagination = container.createEl('div', { cls: 'version-pagination' });
            const prevBtn = pagination.createEl('button', { text: '←', cls: 'version-pagination-btn' });
            prevBtn.disabled = this.currentPage === 0;
            prevBtn.addEventListener('click', () => { if (this.currentPage > 0) { this.currentPage--; this.refresh(); } });
            pagination.createEl('span', { text: `${this.currentPage + 1} / ${totalPages}`, cls: 'version-pagination-info' });
            const nextBtn = pagination.createEl('button', { text: '→', cls: 'version-pagination-btn' });
            nextBtn.disabled = this.currentPage >= totalPages - 1;
            nextBtn.addEventListener('click', () => { if (this.currentPage < totalPages - 1) { this.currentPage++; this.refresh(); } });
        }

        // 底部统计
        const stats = container.createEl('div', { cls: 'version-footer' });
        stats.createEl('span', { text: `共 ${this.totalVersions} 个版本` });
        if (this.searchQuery || this.showStarredOnly || this.filterTag) stats.createEl('span', { text: ` · 筛选后 ${filteredVersions.length} 个` });

        // 恢复滚动条位置
        requestAnimationFrame(() => {
            const savedScroll = this.scrollPositions.get('current') || 0;
            if (savedScroll > 0) {
                container.scrollTop = savedScroll;
            }
        });

        // --- 异步执行后台 Diff 统计 (不阻塞主线程 UI) ---
        if (pendingStatsQueue.length > 0) {
            setTimeout(async () => {
                let changed = false;
                for (const id of pendingStatsQueue) {
                    const success = await this.plugin.calculateDiffStatsForVersionAsync(versionFile, id);
                    if (success) {
                        changed = true;
                        // 局部刷新 DOM：找到对应的进度条并替换
                        const version = versionFile.versions.find(v => v.id === id);
                        if (version) {
                            const statsContainer = listContainer.querySelector(`#stats-${id}`) as HTMLElement;
                            if (statsContainer) this.renderDiffStatsBar(statsContainer, version);
                        }
                    }
                    await this.plugin.yieldToMain(); // 防卡死
                }
                if (changed) await this.plugin.saveVersionFile(file.path, versionFile);
            }, 100);
        }
    }

    // 创建独立的版本卡片 DOM
    createVersionCard(container: HTMLElement, version: VersionData, dependentIds: Set<string>) {
        const item = container.createEl('div', { cls: 'version-item' });
        if (version.starred) item.addClass('version-starred');
        
        const isLocked = dependentIds.has(version.id);

        const checkbox = item.createEl('input', { type: 'checkbox', cls: 'version-checkbox' });
        checkbox.setAttribute('data-version-id', version.id);
        checkbox.checked = this.selectedVersions.has(version.id);
        if (isLocked) {
            checkbox.disabled = true;
            checkbox.title = "此版本被其他增量版本依赖，无法删除";
            checkbox.style.cursor = "not-allowed";
            checkbox.style.opacity = "0.5";
        }

        const info = item.createEl('div', { cls: 'version-info' });
        const timeRow = info.createEl('div', { cls: 'version-time-row' });
        
        // 星标使用 data-action 委托
        timeRow.createEl('span', { 
            text: version.starred ? '⭐' : '☆', 
            cls: 'version-star-btn',
            attr: { 'data-action': 'star', 'data-version-id': version.id }
        });
        
        timeRow.createEl('span', { 
            text: this.plugin.formatTime(version.timestamp), 
            cls: 'version-time', 
            attr: { title: new Date(version.timestamp).toLocaleString('zh-CN'), 'data-timestamp': String(version.timestamp) } 
        });

        const messageEl = info.createEl('div', { cls: 'version-message-row' });
        const saveTypeLabel = this.plugin.getSaveTypeLabel(version.message);
        let tagClass = 'version-tag-auto';
        if (saveTypeLabel === '手动保存') tagClass = 'version-tag-manual';
        else if (saveTypeLabel === '全库版本') tagClass = 'version-tag-snapshot';
        else if (saveTypeLabel === '恢复前备份') tagClass = 'version-tag-backup';
        
        messageEl.createEl('span', { text: saveTypeLabel, cls: `version-tag ${tagClass}` });
        if (version.diff) messageEl.createEl('span', { text: '增量', cls: 'version-tag version-tag-incremental' });
        else if (version.content) messageEl.createEl('span', { text: '完整', cls: 'version-tag version-tag-full' });
        
        if (isLocked) {
            messageEl.createEl('span', { 
                text: '🔒 依赖基准', 
                cls: 'version-tag version-tag-locked',
                attr: { title: '被其他增量版本依赖，为保证数据完整性，不可删除' }
            });
        }

        if (version.tags && version.tags.length > 0) {
            version.tags.forEach(tag => {
                messageEl.createEl('span', { 
                    text: tag, cls: 'version-tag version-tag-custom',
                    attr: { 'data-action': 'filter-tag' }
                });
            });
        }
        
        if (version.note && !this.plugin.settings.compactHistoryView) info.createEl('div', { text: `📝 ${version.note}`, cls: 'version-note' });
        
        const statsRow = info.createEl('div', { cls: 'version-stats-row' });
        statsRow.createEl('span', { text: this.plugin.formatFileSize(version.size), cls: 'version-size' });

        // Diff 统计占位符或渲染
        const diffStatsContainer = statsRow.createEl('div', { cls: 'version-diff-stats', attr: { id: `stats-${version.id}` } });
        if (typeof version.addedLines === 'number') {
            this.renderDiffStatsBar(diffStatsContainer, version);
        } else {
            diffStatsContainer.innerHTML = `<span style="color:var(--text-faint); font-size:10px;">计算中...</span>`;
        }

        // 按钮全部使用 data-action 事件委托
        const actions = item.createEl('div', { cls: 'version-actions' });
        if (this.plugin.settings.enableQuickPreview) {
            actions.createEl('button', { text: '预览', cls: 'version-btn', attr: { 'data-action': 'preview', 'data-version-id': version.id } });
        }
        actions.createEl('button', { text: '恢复', cls: 'version-btn', attr: { 'data-action': 'restore', 'data-version-id': version.id } });
        actions.createEl('button', { text: '比较', cls: 'version-btn', attr: { 'data-action': 'compare', 'data-version-id': version.id } });
        actions.createEl('button', { text: '更多', cls: 'version-btn', attr: { 'data-action': 'more', 'data-version-id': version.id } });
    }

    // 独立渲染统计红绿条的方法
    renderDiffStatsBar(container: HTMLElement, version: VersionData) {
        container.empty();
        const vAdded = version.addedLines || 0;
        const vRemoved = version.removedLines || 0;
        const vModified = version.modifiedLines || 0;
        const totalChanges = vAdded + vRemoved + vModified;

        if (totalChanges > 0) {
            const addedWidth = (vAdded / totalChanges) * 100;
            const removedWidth = (vRemoved / totalChanges) * 100;
            const modifiedWidth = (vModified / totalChanges) * 100;
            const bar = container.createEl('div', { cls: 'diff-stats-bar' });
            if (vModified > 0) bar.createEl('div', { cls: 'diff-stats-modified', attr: { style: `width: ${modifiedWidth}%;` } });
            if (vAdded > 0) bar.createEl('div', { cls: 'diff-stats-added', attr: { style: `width: ${addedWidth}%` } });
            if (vRemoved > 0) bar.createEl('div', { cls: 'diff-stats-removed', attr: { style: `width: ${removedWidth}%` } });
            
            if (vModified > 0) container.createEl('span', { text: `~${vModified}`, cls: 'diff-stats-text-modified', attr: { style: 'color: var(--text-accent); margin-right: 4px;' } });
            if (vAdded > 0) container.createEl('span', { text: `+${vAdded}`, cls: 'diff-stats-text-added' });
            if (vRemoved > 0) container.createEl('span', { text: `-${vRemoved}`, cls: 'diff-stats-text-removed' });
            container.title = `修改 ${vModified}, 新增 ${vAdded}, 删除 ${vRemoved}`;
        } else {
            container.setText('无内容变更');
        }
    }

    async renderModifiedFiles(container: HTMLElement) {
        container.createEl('h3', { text: '📝 已修改但未保存' });
        container.createEl('p', { text: '以下文件自上次保存版本后已有新的修改:', cls: 'vc-desc' });

        const modifiedFiles = await this.plugin.getModifiedFiles();
        if (modifiedFiles.length === 0) { this.renderEmptyState(container, '所有文件均已包含最新版本 ✅'); return; }

        const batchBar = container.createEl('div', { cls: 'vc-batch-bar' });
        const snapshotAllBtn = batchBar.createEl('button', { text: '全部保存版本', cls: 'mod-cta' });
        snapshotAllBtn.addEventListener('click', async () => {
            new Notice(`开始为 ${modifiedFiles.length} 个文件保存版本...`);
            for (const item of modifiedFiles) { await this.plugin.createVersion(item.file, '[Batch Save] 批量保存', false); }
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
            link.addEventListener('click', () => { this.app.workspace.getLeaf(false).openFile(file); });

            const metaRow = info.createEl('div', { cls: 'version-time-row' });
            const lastSaveStr = lastVersionTime === 0 ? '从未保存' : this.plugin.getRelativeTime(lastVersionTime);
            metaRow.createEl('small', { text: `上次保存: ${lastSaveStr} | 最近修改: ${this.plugin.getRelativeTime(file.stat.mtime)}`, attr: { style: 'color: var(--text-muted);' } });

            const actions = item.createEl('div', { cls: 'version-actions' });
            if (lastVersionTime > 0) {
                const diffBtn = actions.createEl('button', { text: '对比', cls: 'version-btn' });
                diffBtn.addEventListener('click', async () => {
                    const versions = await this.plugin.getAllVersions(file.path);
                    if (versions.length > 0) new DiffModal(this.app, this.plugin, file, versions[0]!.id).open();
                });
            }
            const saveBtn = actions.createEl('button', { text: '保存', cls: 'version-btn' });
            saveBtn.addEventListener('click', async () => {
                saveBtn.setText('保存中...'); saveBtn.disabled = true;
                await this.plugin.createVersion(file, '[Manual] 列表补录', true);
                item.remove();
                if (list.children.length === 0) this.refresh();
            });
        });

        // 恢复滚动条位置
        requestAnimationFrame(() => {
            const savedScroll = this.scrollPositions.get('modified') || 0;
            if (savedScroll > 0) {
                container.scrollTop = savedScroll;
            }
        });
    }

    async renderGlobalHistory(container: HTMLElement) {
        const header = container.createEl('div', { attr: { style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;' } });
        header.createEl('h3', { text: '🌍 全库版本时间轴', attr: { style: 'margin: 0;' } });
        
        const btnGroup = header.createEl('div', { attr: { style: 'display: flex; gap: 8px;' } });

        // --- 新增：时间模式切换按钮 ---
        const timeModeBtn = btnGroup.createEl('button', {
            cls: this.plugin.settings.globalHistoryTimeMode === 'modified' ? 'mod-cta' : '',
            attr: { 'aria-label': '切换全库排序与显示时间', style: 'padding: 4px 10px; font-size: 12px; display: flex; align-items: center; gap: 4px;' }
        });
        setIcon(timeModeBtn, 'clock');
        timeModeBtn.createEl('span', { text: this.plugin.settings.globalHistoryTimeMode === 'modified' ? '按修改时间' : '按保存时间' });
        timeModeBtn.addEventListener('click', async () => {
            this.plugin.settings.globalHistoryTimeMode = this.plugin.settings.globalHistoryTimeMode === 'modified' ? 'saved' : 'modified';
            await this.plugin.saveSettings();
            this.refresh();
        });

        const filterBtn = btnGroup.createEl('button', { 
            cls: this.showUniqueFilesOnly ? 'mod-cta' : '',
            attr: { 'aria-label': '切换：只显示最新 / 显示全部', style: 'padding: 4px 10px; font-size: 12px; display: flex; align-items: center; gap: 4px;' }
        });
        setIcon(filterBtn, this.showUniqueFilesOnly ? 'files' : 'list');
        filterBtn.createEl('span', { text: this.showUniqueFilesOnly ? '单文件最新' : '显示全部' });
        filterBtn.addEventListener('click', () => { 
            this.showUniqueFilesOnly = !this.showUniqueFilesOnly; 
            this.refresh(); 
        });

        const listWrapper = container.createEl('div', { cls: 'version-list-wrapper' });
        
        // --- 极速秒开核心：如果缓存没有就绪，显示骨架屏（不阻塞界面切换） ---
        let loadingEl: HTMLElement | null = null;
        if (!this.plugin.globalHistoryCache) {
            loadingEl = listWrapper.createEl('div', { 
                text: '✨ 首次加载全库数据中...', 
                attr: { style: 'text-align: center; padding: 40px 20px; color: var(--text-muted); font-size: 13px;' } 
            });
        }

        // --- 异步渲染机制，确保切页永不卡顿 ---
        setTimeout(async () => {
            let history = await this.plugin.getGlobalHistory(200); 
            if (loadingEl) loadingEl.remove();

            if (history.length === 0) { 
                this.renderEmptyState(listWrapper, '未找到任何版本记录'); 
                return; 
            }

            if (this.showUniqueFilesOnly) {
                const seen = new Set<string>();
                history = history.filter(item => {
                    if (seen.has(item.filePath)) return false;
                    seen.add(item.filePath);
                    return true;
                });
            }
            
            const isModifiedMode = this.plugin.settings.globalHistoryTimeMode === 'modified';

            // --- 重构：根据模式智能排序 ---
            history.sort((a, b) => {
                const timeA = isModifiedMode ? (a.file ? a.file.stat.mtime : a.version.timestamp) : a.version.timestamp;
                const timeB = isModifiedMode ? (b.file ? b.file.stat.mtime : b.version.timestamp) : b.version.timestamp;
                return timeB - timeA;
            });

            history = history.slice(0, 50);

            const list = listWrapper.createEl('div', { cls: 'version-list' });

            const globalDependentIds = new Set<string>();
            history.forEach(item => {
                if (item.version.baseVersionId) globalDependentIds.add(item.version.baseVersionId);
            });

            let currentDay = '';

            history.forEach(({ version, filePath, file }) => {
                
                const primaryTime = isModifiedMode ? (file ? file.stat.mtime : version.timestamp) : version.timestamp;
                // 如果是修改模式，且有 file，副时间是 version；如果是保存模式，且有 file，副时间是 mtime
                const secondaryTime = isModifiedMode ? version.timestamp : (file ? file.stat.mtime : null);
                const secondaryLabel = isModifiedMode ? '保存时间' : '修改时间';

                const dateObj = new Date(primaryTime);
                const dateStr = dateObj.toLocaleDateString();

                if (dateStr !== currentDay) {
                    currentDay = dateStr;
                    list.createEl('h4', { text: currentDay, cls: 'version-group-header' });
                }

                const item = list.createEl('div', { cls: 'version-item' });
                if (version.starred) item.addClass('version-starred');

                const info = item.createEl('div', { cls: 'version-info' });

                const headerRow = info.createEl('div', { cls: 'version-time-row', attr: { style: 'justify-content:flex-start; gap:8px; flex-wrap: nowrap;' } });
                
                const timeContainer = headerRow.createEl('div', { attr: { style: 'display: flex; align-items: baseline; gap: 4px; flex-shrink: 0; white-space: nowrap;' } });
                timeContainer.createEl('span', { 
                    text: new Date(primaryTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second: '2-digit'}),
                    cls: 'version-time', attr: { style: 'font-family:var(--font-monospace); color:var(--text-accent); font-weight: bold;', title: isModifiedMode ? '文件最后修改时间' : '版本保存时间' }
                });
                
                // 将相对时间挂载在绝对时间的紧后方，并加入自动刷新类名
                const primaryRelSpan = timeContainer.createEl('span', { attr: { style: 'color: var(--text-accent); font-size: 0.9em; white-space: nowrap;' } });
                primaryRelSpan.appendText('(');
                primaryRelSpan.createEl('span', {
                    text: this.plugin.getRelativeTime(primaryTime),
                    cls: 'version-global-relative-time-inline',
                    attr: { 'data-timestamp': String(primaryTime) }
                });
                primaryRelSpan.appendText(')');

                const fileLink = headerRow.createEl('span', { text: filePath, cls: 'internal-link' });
                fileLink.addEventListener('click', () => {
                    if (file) this.app.workspace.getLeaf(false).openFile(file);
                    else new Notice('文件已删除，无法打开');
                });
                if (!file) headerRow.createEl('span', { text: '(已删除)', attr: { style: 'color:var(--text-error); font-size:0.8em;' } });

                const msgRow = info.createEl('div', { cls: 'version-message-row' });
                
                const saveTypeLabel = this.plugin.getSaveTypeLabel(version.message);
                let tagClass = 'version-tag-auto';
                if (saveTypeLabel === '手动保存') tagClass = 'version-tag-manual';
                else if (saveTypeLabel === '全库版本') tagClass = 'version-tag-snapshot';
                else if (saveTypeLabel === '恢复前备份') tagClass = 'version-tag-backup';
                msgRow.createEl('span', { text: saveTypeLabel, cls: `version-tag ${tagClass}` });

                if (version.diff) msgRow.createEl('span', { text: '增量', cls: 'version-tag version-tag-incremental' });
                else if (version.content) msgRow.createEl('span', { text: '完整', cls: 'version-tag version-tag-full' });

                if (globalDependentIds.has(version.id)) {
                    msgRow.createEl('span', { text: '🔒 依赖基准', cls: 'version-tag version-tag-locked', attr: { title: '被其他增量版本依赖，为保证数据完整性，不可删除' } });
                }

                if (version.tags && version.tags.length > 0) {
                    version.tags.forEach(tag => {
                        msgRow.createEl('span', { text: tag, cls: 'version-tag version-tag-custom' });
                    });
                }

                const pureMessage = version.message.replace(/\[.*?\]/g, '').trim();
                if (pureMessage) {
                    msgRow.createEl('span', { text: pureMessage });
                }

                if (version.note && !this.plugin.settings.compactHistoryView) {
                    info.createEl('div', { text: `📝 ${version.note}`, cls: 'version-note' });
                }

                const statsRow = info.createEl('div', { cls: 'version-stats-row' });
                statsRow.createEl('span', { text: this.plugin.formatFileSize(version.size), cls: 'version-size' });
                
                // 智能切换副时间的显示
                if (secondaryTime) {
                    const secSpan = statsRow.createEl('span', { cls: 'version-size' });
                    secSpan.appendText(`| ${secondaryLabel}: ${new Date(secondaryTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second: '2-digit'})} (`);
                    secSpan.createEl('span', {
                        text: this.plugin.getRelativeTime(secondaryTime),
                        cls: 'version-global-relative-time-inline',
                        attr: { 'data-timestamp': String(secondaryTime) }
                    });
                    secSpan.appendText(`)`);
                }

                const actions = item.createEl('div', { cls: 'version-actions' });
                if (file) {
                    const diffBtn = actions.createEl('button', { text: '对比', cls: 'version-btn' });
                    diffBtn.addEventListener('click', () => { new DiffModal(this.app, this.plugin, file, version.id).open(); });
                    if (this.plugin.settings.enableQuickPreview) {
                        const viewBtn = actions.createEl('button', { text: '预览', cls: 'version-btn' });
                        viewBtn.addEventListener('click', () => { new QuickPreviewModal(this.app, this.plugin, file, version.id).open(); });
                    }
                }
            });

            // 恢复滚动条位置
            requestAnimationFrame(() => {
                const savedScroll = this.scrollPositions.get('global') || 0;
                if (savedScroll > 0) {
                    container.scrollTop = savedScroll;
                }
            });

        }, 10); // 极短的延迟，优先让浏览器渲染页面框架，消除顿挫感
    }
    
    showVersionContextMenu(event: MouseEvent, file: TFile, version: VersionData, isLocked: boolean = false) {
        const menu = new Menu();
        
        menu.addSeparator();
        if (this.plugin.settings.enableVersionTags) {
            menu.addItem((item) => item.setTitle('编辑标签').setIcon('tag').onClick(() => { new TagEditModal(this.app, this.plugin, file.path, version.id, version.tags || []).open(); }));
        }
        menu.addItem((item) => item.setTitle('添加/编辑备注').setIcon('edit').onClick(() => { new NoteEditModal(this.app, this.plugin, file.path, version.id, version.note || '').open(); }));
        menu.addSeparator();
        menu.addItem((item) => item.setTitle('导出为文件').setIcon('download').onClick(async () => { await this.plugin.exportVersionAsFile(file.path, version.id); }));
        
        menu.addItem((item) => {
            item.setIcon('trash');
            if (isLocked) {
                item.setDisabled(true);
                item.setTitle('删除版本 (被依赖锁定)');
            } else {
                item.setTitle('删除版本');
                item.onClick(async () => {
                    new ConfirmModal(this.app, '确认删除', '确定要删除此版本吗?\n\n此操作不可撤销!', async () => {
                        await this.plugin.deleteVersion(file.path, version.id);
                    }).open();
                });
            }
        });
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
            const days = Math.floor((versions[0]!.timestamp - versions[versions.length - 1]!.timestamp) / (1000 * 60 * 60 * 24));
            timeSpan = days > 0 ? `${days} 天` : '不足1天';
        } else if (versions.length === 1) { timeSpan = '仅一个版本'; }

        new Notice(`📊 ${file.basename} 统计\n\n总版本数: ${versions.length}\n⭐ 星标: ${starredCount}\n🏷️ 已标签: ${taggedCount}\n🤖 自动: ${autoSaveCount}\n✋ 手动: ${manualSaveCount}\n📦 总大小: ${this.plugin.formatFileSize(totalSize)}\n📅 时间跨度: ${timeSpan}`, 8000);
    }

    async cleanupOldVersions(file: TFile) {
        new ConfirmModal(this.app, '清理旧版本', '根据设置的清理规则删除旧版本。\n星标版本将被保留。\n\n是否继续?', async () => {
            const versionFile = await this.plugin.loadVersionFile(file.path);
            const removed = await this.plugin.cleanupVersionsInMemory(versionFile);
            if (removed > 0) {
                await this.plugin.saveVersionFile(file.path, versionFile);
                this.plugin.versionCache.set(file.path, versionFile);
                new Notice(`✅ 已清理 ${removed} 个旧版本`);
                this.refresh();
            } else { new Notice('ℹ️ 没有需要清理的版本'); }
        }).open();
    }

    renderEmptyState(container: HTMLElement, message: string) {
        const empty = container.createEl('div', { cls: 'version-history-empty' });
        empty.createEl('div', { text: '📋', cls: 'version-empty-icon' });
        empty.createEl('div', { text: message });
        
        if (this.currentFile && message === '暂无版本历史' && this.currentViewMode === 'current') {
            const createBtn = empty.createEl('button', { text: '创建第一个版本', cls: 'mod-cta' });
            createBtn.addEventListener('click', () => { this.plugin.createManualVersion(); });
        }

        if (this.currentViewMode === 'current' && (this.filterTag || this.showStarredOnly || this.searchQuery)) {
            const clearFilterBtn = empty.createEl('button', { text: '清除筛选/搜索', cls: 'mod-cta' });
            clearFilterBtn.addEventListener('click', () => { this.filterTag = null; this.showStarredOnly = false; this.searchQuery = ''; this.currentPage = 0; this.refresh(); });
        }
    }

    confirmRestore(file: TFile, versionId: string) {
        new ConfirmModal(this.app, '确认恢复版本', '当前未保存的修改将会丢失,插件会在恢复前自动创建备份版本。\n\n是否继续?', async () => { await this.plugin.restoreVersion(file, versionId); }).open();
    }

    async batchDelete(file: TFile) {
        // --- 补全：在 UI 层面提供更友好的拦截 ---
        new ConfirmModal(
            this.app,
            '确认批量删除',
            `确定要删除选中的 ${this.selectedVersions.size} 个版本吗?\n\n此操作不可撤销!`,
            async () => {
                const versionIds = Array.from(this.selectedVersions);
                const versionFile = await this.plugin.loadVersionFile(file.path);
                
                const dependentIds = new Set(versionFile.versions.map(v => v.baseVersionId).filter(Boolean));
                const hasLocked = versionIds.some(id => dependentIds.has(id));

                if (hasLocked) {
                    new Notice('❌ 包含被依赖的基准版本，无法删除。已为您自动取消勾选这些版本。', 5000);
                    versionIds.forEach(id => { if (dependentIds.has(id)) this.selectedVersions.delete(id); });
                    this.refresh();
                    return;
                }

                await this.plugin.deleteVersions(file.path, versionIds);
                this.selectedVersions.clear();
            }
        ).open();
    }

    showDiffModal(file: TFile, versionId: string) { new DiffModal(this.app, this.plugin, file, versionId).open(); }
    selectVersionForCompare(file: TFile, firstVersionId: string) {
        new VersionSelectModal(this.app, this.plugin, file, firstVersionId, (secondVersionId) => { new DiffModal(this.app, this.plugin, file, firstVersionId, secondVersionId).open(); }).open();
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
        const tokenize = (str: string) => str.split(/([ \t\n\r]+|[，。！？；：、()（）""'']+)/).filter(Boolean);
        const tokens1 = tokenize(text1);
        const tokens2 = tokenize(text2);
        const result = Diff.diffArrays(tokens1, tokens2);
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

        if (Platform.isMobile) {
            contentEl.addClass('is-mobile');
        }

        // 使用原生事件监听，并在 onClose 中安全移除
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
        saveNewVersionBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            saveNewVersionBtn.innerHTML = '⏳';
            saveNewVersionBtn.disabled = true;
            try {
                await this.plugin.createVersion(this.file, '[Manual Save]', true, [], true);
                this.allVersions = await this.plugin.getAllVersions(this.file.path);
                this.updateSelectorButtonLabels();
                
                if (this.versionId === 'current' || this.secondVersionId === 'current') {
                    await this.updateDiffView();
                }
            } catch (err: unknown) {
                console.error("保存新版本或刷新视图失败", getErrorMessage(err), err);
            } finally {
                saveNewVersionBtn.innerHTML = '💾';
                saveNewVersionBtn.disabled = false;
            }
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
        } catch (error: unknown) {
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

        const settingsGroup = toolbar.createEl('div', { cls: 'diff-toolbar-group' });
        const settingsBtn = settingsGroup.createEl('button', { text: '设置 ⚙️', attr: { 'aria-label': '视图设置' } });
        
        settingsBtn.addEventListener('click', (e) => {
            const menu = new Menu();
            const modeSelect = this.containerEl.querySelector('.diff-select[aria-label="视图模式"]') as HTMLSelectElement;
            const isLineBased = this.currentGranularity === 'line';
            const isUnified = modeSelect.value === 'unified';

            // --- 组 1：基础差异粒度 (最核心的底层逻辑) ---
            menu.addItem(item => item.setTitle('行级对比').setIcon('list').setChecked(isLineBased).onClick(() => this.updateGranularity('line')));
            menu.addItem(item => item.setTitle('单词级对比').setIcon('whole-word').setChecked(this.currentGranularity === 'word').onClick(() => this.updateGranularity('word')));
            menu.addItem(item => item.setTitle('字符级对比').setIcon('type').setChecked(this.currentGranularity === 'char').onClick(() => this.updateGranularity('char')));

            menu.addSeparator();

            // --- 组 2：视图模式 (整体 UI 框架) ---
            menu.addItem(item => item.setTitle('统一视图').setIcon('align-justify').setChecked(isUnified).onClick(() => { modeSelect.value = 'unified'; modeSelect.dispatchEvent(new Event('change')); }));
            menu.addItem(item => item.setTitle('左右分栏').setIcon('columns').setChecked(!isUnified).onClick(() => { modeSelect.value = 'split'; modeSelect.dispatchEvent(new Event('change')); }));
            
            if (isUnified) {
                menu.addItem(item => item.setTitle('紧凑型统一视图').setIcon('shrink').setChecked(this.plugin.settings.compactUnifiedDiff).onClick(async () => {
                    this.plugin.settings.compactUnifiedDiff = !this.plugin.settings.compactUnifiedDiff;
                    await this.plugin.saveSettings();
                    this.renderTextDiff();
                }));
            }

            menu.addSeparator();

            // --- 组 3：行内高亮算法 (作为行级对比的细化，紧跟其后) ---
            if (isLineBased) {
                menu.addItem(item => item.setTitle('行内高亮: 按行').setIcon('rows').setChecked(this.plugin.settings.inlineDiffAlgorithm === 'line').onClick(async () => {
                    this.plugin.settings.inlineDiffAlgorithm = 'line';
                    await this.plugin.saveSettings();
                    this.renderTextDiff();
                }));
                menu.addItem(item => item.setTitle('行内高亮: 按单词 (推荐)').setIcon('text-cursor').setChecked(this.plugin.settings.inlineDiffAlgorithm === 'word').onClick(async () => {
                    this.plugin.settings.inlineDiffAlgorithm = 'word';
                    await this.plugin.saveSettings();
                    this.renderTextDiff();
                }));
                menu.addItem(item => item.setTitle('行内高亮: 按字符').setIcon('text-select').setChecked(this.plugin.settings.inlineDiffAlgorithm === 'char').onClick(async () => {
                    this.plugin.settings.inlineDiffAlgorithm = 'char';
                    await this.plugin.saveSettings();
                    this.renderTextDiff();
                }));
                
                menu.addSeparator();
            }

            // --- 组 4：通用显示与辅助排版 ---
            menu.addItem(item => item.setTitle('自动换行').setIcon('wrap-text').setChecked(this.wrapLines).onClick(() => { this.wrapLines = !this.wrapLines; this.renderTextDiff(); }));
            
            if (isLineBased) {
                menu.addItem(item => item.setTitle('显示行号').setIcon('list-ordered').setChecked(this.showLineNumbers).onClick(() => { 
                    this.showLineNumbers = !this.showLineNumbers; 
                    this.renderTextDiff(); 
                }));
                menu.addItem(item => item.setTitle(`修改上下文行数... (当前: ${this.contextLines >= 9999 ? '全部' : this.contextLines})`).setIcon('settings').onClick(() => {
                    new ContextLineInputModal(this.app, this.contextLines, (lines) => {
                        this.contextLines = lines;
                        this.renderTextDiff();
                    }).open();
                }));
            }

            menu.addItem(item => item.setTitle('忽略空白字符').setIcon('eye-off').setChecked(this.ignoreWhitespace).onClick(() => { this.ignoreWhitespace = !this.ignoreWhitespace; this.renderTextDiff(); }));
            menu.addItem(item => item.setTitle('显示空白字符').setIcon('eye').setChecked(this.showWhitespace).onClick(() => { this.showWhitespace = !this.showWhitespace; this.renderTextDiff(); }));

            menu.showAtMouseEvent(e as MouseEvent);
        });
        
        const modeSelect = controlsContainer.createEl('select', { cls: 'diff-select', attr: { 'aria-label': '视图模式', 'style': 'display: none;' } });
        modeSelect.createEl('option', { text: '统一视图', value: 'unified' });
        modeSelect.createEl('option', { text: '左右分栏', value: 'split' });
        modeSelect.value = this.plugin.settings.diffViewMode;
        modeSelect.addEventListener('change', () => { this.renderTextDiff(); });

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
        const navButtons = this.containerEl.querySelectorAll('#diff-nav-group button');
        const [firstBtn, prevBtn, nextBtn, lastBtn] = Array.from(navButtons) as HTMLButtonElement[];

        if (this.totalDiffs > 0) {
            statsEl.setText(`${this.currentDiffIndex + 1} / ${this.totalDiffs}`);
            if(prevBtn) prevBtn.disabled = this.currentDiffIndex === 0;
            if(firstBtn) firstBtn.disabled = this.currentDiffIndex === 0;
            if(nextBtn) nextBtn.disabled = this.currentDiffIndex >= this.totalDiffs - 1;
            if(lastBtn) lastBtn.disabled = this.currentDiffIndex >= this.totalDiffs - 1;
        } else {
            statsEl.setText('0 / 0');
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
                        .setTitle(`${this.plugin.formatTime(version.timestamp)}`) 
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

        } catch (error: unknown) {
            console.error("加载差异失败:", getErrorMessage(error), error);
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

    // 🚀 性能重构：时间切片渲染引擎 (Time-Slicing Render Engine)
    async executeRenderTasks(container: HTMLElement, tasks: ((frag: DocumentFragment) => void)[]) {
        const CHUNK_SIZE = 100; // 每一帧渲染 100 行差异
        this.loadingOverlay.style.display = 'flex';
        const msgEl = this.loadingOverlay.querySelector('.diff-loading-message') as HTMLElement;
        
        for (let i = 0; i < tasks.length; i += CHUNK_SIZE) {
            await new Promise<void>(resolve => {
                requestAnimationFrame(() => {
                    const frag = document.createDocumentFragment();
                    const chunk = tasks.slice(i, i + CHUNK_SIZE);
                    chunk.forEach(task => task(frag));
                    container.appendChild(frag);
                    resolve();
                });
            });
            if (i % 300 === 0 && msgEl) {
                 msgEl.textContent = `正在渲染视图... ${Math.round((i / tasks.length) * 100)}%`;
            }
        }
        this.loadingOverlay.style.display = 'none';
        
        if (this.textDiffContainer.hasClass('diff-split')) {
            this.alignSplitViewLines();
        }
    }

    async renderTextDiff() {
        const container = this.textDiffContainer;
        container.empty();
        this.diffElements = [];
        this.currentDiffIndex = 0;
        this.totalDiffs = 0;
        
        let leftProcessed = this.leftContent;
        let rightProcessed = this.rightContent;
        
        const modeSelect = this.containerEl.querySelector('.diff-select[aria-label="视图模式"]') as HTMLSelectElement;
        
        if (modeSelect.value === 'unified') {
            container.removeClass('diff-split');
            await this.renderUnifiedDiff(container, leftProcessed, rightProcessed);
        } else {
            container.addClass('diff-split');
            const leftLabelEl = this.containerEl.querySelector('.diff-left-version-btn') as HTMLElement;
            const rightLabelEl = this.containerEl.querySelector('.diff-right-version-btn') as HTMLElement;
            await this.renderSplitDiff(container, leftProcessed, rightProcessed, leftLabelEl.textContent || '版本 A', rightLabelEl.textContent || '版本 B');
        }

        if (this.wrapLines) container.addClass('diff-wrap-lines');
        else container.removeClass('diff-wrap-lines');

        this.totalDiffs = this.diffElements.length;

        // === 【新增：空白恐慌 空状态 (Empty State)】 ===
        if (this.totalDiffs === 0) {
            container.empty();
            container.removeClass('diff-split');
            const emptyState = container.createEl('div', { 
                attr: { style: 'display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; height: 100%; min-height: 250px; color: var(--text-muted); text-align: center;' } 
            });
            emptyState.createEl('div', { text: '✨', attr: { style: 'font-size: 48px; margin-bottom: 16px; opacity: 0.9;' } });
            emptyState.createEl('h3', { text: '这两个版本完全一致', attr: { style: 'color: var(--text-normal); margin: 0 0 8px 0; font-size: 16px;' } });
            emptyState.createEl('p', { text: '没有检测到任何修改内容' + (this.ignoreWhitespace ? ' (已忽略空白字符)' : ''), attr: { style: 'margin: 0; font-size: 13px;' } });
        }
        // ==============================================

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
        } catch (error: unknown) {
            console.error('导出差异报告失败:', getErrorMessage(error), error);
            new Notice('❌ 导出失败');
        }
    }

    async renderUnifiedDiff(container: HTMLElement, left: string, right: string) {
        const renderTasks: ((frag: DocumentFragment) => void)[] = [];

        if (this.currentGranularity === 'char' || this.currentGranularity === 'word') {
            const diffResult = this.currentGranularity === 'char'
                ? Diff.diffChars(left, right)
                : this.diffWordsCJK(left, right);
            
            let diffIdx = 0;

            renderTasks.push((frag: DocumentFragment) => {
                const contentEl = frag.createEl('div', { cls: 'line-content' });
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
            });
            await this.executeRenderTasks(container, renderTasks);
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

        const renderLine = (content: string | DocumentFragment, type: ProcessedDiff['type'], lineNumLeft: number | null, lineNumRight: number | null) => {
            renderTasks.push((frag: DocumentFragment) => {
                // @ts-ignore Obsidian 的 createEl 绑定在 Node 原型上，可以直接给 fragment 使用
                const lineEl = frag.createEl('div', { cls: `diff-line diff-${type}` });
                
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
                        allLines?.forEach((el:Element) => el.removeClass('actions-visible'));
                        if (!wasVisible) {
                            lineEl.addClass('actions-visible');
                        }
                    });
                }
            });
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
                                renderLine(combinedFrag, 'modified', leftLineNum++, rightLineNum++);
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
                                    renderLine(combinedFrag, 'modified', leftLineNum++, rightLineNum++);
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
                        renderLine(rightFrag, 'added', null, rightLineNum++);
                    }
                } else {
                    leftLines.forEach(line => renderLine(line, 'removed', leftLineNum++, null));
                    rightLines.forEach(line => renderLine(line, 'added', null, rightLineNum++));
                }
                i++; 
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
                                 renderTasks.push((frag: DocumentFragment) => {
                                     // @ts-ignore
                                     const skippedEl = frag.createEl('div', { cls: 'diff-line diff-context-gap' });
                                     skippedEl.createEl('span', { cls: 'line-number-container' });
                                     skippedEl.createEl('span', { cls: 'diff-marker', text: '...' });
                                 });
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
        
        await this.executeRenderTasks(container, renderTasks);
    }

    async renderSplitDiff(container: HTMLElement, left: string, right: string, leftLabel: string, rightLabel: string) {
        const leftPanel = container.createEl('div', { cls: 'diff-panel' });
        const rightPanel = container.createEl('div', { cls: 'diff-panel' });

        leftPanel.createEl('h3', { text: leftLabel });
        rightPanel.createEl('h3', { text: rightLabel });

        const leftContentEl = leftPanel.createEl('div', { cls: 'diff-content' });
        const rightContentEl = rightPanel.createEl('div', { cls: 'diff-content' });

        await this.renderSplitViewAdvancedAsync(leftContentEl, rightContentEl, left, right);
    }

    async renderSplitViewAdvancedAsync(leftPanel: HTMLElement, rightPanel: HTMLElement, leftText: string, rightText: string) {
        const renderTasksLeft: ((frag: DocumentFragment) => void)[] = [];
        const renderTasksRight: ((frag: DocumentFragment) => void)[] = [];

        if (this.currentGranularity === 'char' || this.currentGranularity === 'word') {
            const diffResult = this.currentGranularity === 'char'
                ? Diff.diffChars(leftText, rightText)
                : this.diffWordsCJK(leftText, rightText);
            let diffIdx = 0;

            renderTasksLeft.push((frag: DocumentFragment) => {
                diffResult.forEach(part => {
                    const text = this.showWhitespace ? this.visualizeWhitespace(part.value) : part.value;
                    if (part.removed) {
                        // @ts-ignore
                        const span = frag.createEl('span', { text, cls: 'diff-word-removed' });
                        span.dataset.diffIndex = String(diffIdx);
                        this.diffElements.push(span);
                    } else if (!part.added && this.contextLines > 0) {
                        // @ts-ignore
                        frag.createEl('span', { text });
                    }
                });
            });
            
            let rightDiffIdx = 0;
            renderTasksRight.push((frag: DocumentFragment) => {
                diffResult.forEach(part => {
                    const text = this.showWhitespace ? this.visualizeWhitespace(part.value) : part.value;
                    if (part.added) {
                        // @ts-ignore
                        const span = frag.createEl('span', { text, cls: 'diff-word-added' });
                        span.dataset.diffIndex = String(rightDiffIdx++);
                        this.diffElements.push(span);
                    } else if (!part.removed && this.contextLines > 0) {
                        // @ts-ignore
                        frag.createEl('span', { text });
                        rightDiffIdx++;
                    }
                });
            });

            await Promise.all([
                this.executeRenderTasks(leftPanel, renderTasksLeft),
                this.executeRenderTasks(rightPanel, renderTasksRight)
            ]);
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
    
        const renderLine = (isLeft: boolean, content: string | DocumentFragment, type: string, lineNum: number | null) => {
            const task = (frag: DocumentFragment) => {
                // @ts-ignore
                const lineEl = frag.createEl('div', { cls: `diff-line diff-${type}` });

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
                        allLines?.forEach((el:Element) => el.removeClass('actions-visible'));
                        if (!wasVisible) {
                            lineEl.addClass('actions-visible');
                        }
                    });
                }
            };
            if (isLeft) renderTasksLeft.push(task);
            else renderTasksRight.push(task);
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
                                renderLine(true, lLine, 'context', leftLineNum++);
                                renderLine(false, rLine, 'context', rightLineNum++);
                            } else {
                                const lineDiff = secondaryDiffFn(lLine, rLine);
                                const leftFrag = createHighlightedFragment((lineDiff || []).filter((p: Diff.Change) => !p.added));
                                const rightFrag = createHighlightedFragment((lineDiff || []).filter((p: Diff.Change) => !p.removed));
                                renderLine(true, leftFrag, 'modified', leftLineNum++);
                                renderLine(false, rightFrag, 'modified', rightLineNum++);
                            }
                        }
                    } else {
                        let lIndex = 0;
                        let rIndex = 0;

                        while (lIndex < leftLines.length || rIndex < rightLines.length) {
                            const lLine = leftLines[lIndex];
                            const rLine = rightLines[rIndex];

                            if (lLine === undefined) {
                                renderLine(true, '', 'placeholder', null);
                                renderLine(false, rLine!, 'added', rightLineNum++);
                                rIndex++;
                                continue;
                            }

                            if (rLine === undefined) {
                                renderLine(true, lLine!, 'removed', leftLineNum++);
                                renderLine(false, '', 'placeholder', null);
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
                                renderLine(true, '', 'placeholder', null);
                                renderLine(false, rLine!, 'added', rightLineNum++);
                                rIndex++;
                            } else if (deletionSim > currentSim + threshold) {
                                renderLine(true, lLine!, 'removed', leftLineNum++);
                                renderLine(false, '', 'placeholder', null);
                                lIndex++;
                            } else {
                                if (lLine === rLine) {
                                    renderLine(true, lLine, 'context', leftLineNum++);
                                    renderLine(false, rLine, 'context', rightLineNum++);
                                } else {
                                    const lineDiff = secondaryDiffFn(lLine!, rLine!);
                                    const leftFrag = createHighlightedFragment((lineDiff || []).filter((p: Diff.Change) => !p.added));
                                    const rightFrag = createHighlightedFragment((lineDiff || []).filter((p: Diff.Change) => !p.removed));
                                    renderLine(true, leftFrag, 'modified', leftLineNum++);
                                    renderLine(false, rightFrag, 'modified', rightLineNum++);
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
                        renderLine(true, leftFrag, 'removed', leftLineNum++);
                        renderLine(false, rightFrag, 'added', rightLineNum++);
                    }
                } else {
                    leftLines.forEach(line => {
                        renderLine(true, line, 'removed', leftLineNum++);
                        renderLine(false, '', 'placeholder', null);
                    });
                    rightLines.forEach(line => {
                        renderLine(true, '', 'placeholder', null);
                        renderLine(false, line, 'added', rightLineNum++);
                    });
                }
                i++; // 跳过下一个已处理的 part
            } else if (part.added) {
                const lines = part.value.replace(/\n$/, '').split('\n');
                for (const line of lines) {
                    renderLine(true, '', 'placeholder', null);
                    renderLine(false, line, 'added', rightLineNum++);
                }
            } else if (part.removed) {
                const lines = part.value.replace(/\n$/, '').split('\n');
                for (const line of lines) {
                    renderLine(true, line, 'removed', leftLineNum++);
                    renderLine(false, '', 'placeholder', null);
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
                            renderTasksLeft.push((frag: DocumentFragment) => {
                                // @ts-ignore
                                const skippedLeft = frag.createEl('div', { cls: 'diff-line diff-context-gap' });
                                skippedLeft.createEl('span', { cls: 'line-number-container' });
                                skippedLeft.createEl('span', { cls: 'diff-marker', text: '...' });
                            });
                            renderTasksRight.push((frag: DocumentFragment) => {
                                // @ts-ignore
                                const skippedRight = frag.createEl('div', { cls: 'diff-line diff-context-gap' });
                                skippedRight.createEl('span', { cls: 'line-number-container' });
                                skippedRight.createEl('span', { cls: 'diff-marker', text: '...' });
                            });
                        }
                        renderLine(true, line, 'context', leftLineNum);
                        renderLine(false, line, 'context', rightLineNum);
                        lastLineShown = lineIdx;
                    }
                    leftLineNum++;
                    rightLineNum++;
                }
            }
        }
        
        await Promise.all([
            this.executeRenderTasks(leftPanel, renderTasksLeft),
            this.executeRenderTasks(rightPanel, renderTasksRight)
        ]);
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
        
        this.leftContent = '';
        this.rightContent = '';
        this.diffElements = [];
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
            
            // 头部：标题与刷新按钮同行
            const headerEl = statsEl.createEl('div', { cls: 'stats-header' });
            headerEl.createEl('h3', { text: '📊 存储统计' });
            const refreshBtn = headerEl.createEl('button', { text: '🔄 刷新', cls: 'stats-refresh-btn' });
            refreshBtn.addEventListener('click', () => {
                this.display();
            });

            // 数据网格
            const statsGrid = statsEl.createEl('div', { cls: 'stats-grid' });
            
            // 辅助函数：创建单个数据卡片
            const createStatCard = (label: string, value: string | number, highlight: boolean = false) => {
                const card = statsGrid.createEl('div', { cls: 'stat-card' });
                const valEl = card.createEl('div', { text: String(value), cls: 'stat-value' });
                if (highlight) valEl.style.color = 'var(--text-accent)';
                card.createEl('div', { text: label, cls: 'stat-label' });
            };

            createStatCard('总占用空间', this.plugin.formatFileSize(stats.totalSize), true);
            createStatCard('版本总数', stats.versionCount);
            createStatCard('文件总数', stats.fileCount);
            createStatCard('星标版本', stats.starredCount);
            createStatCard('带有标签', stats.taggedCount);
            
            if (this.plugin.settings.enableCompression || this.plugin.settings.enableIncrementalStorage) {
                createStatCard('存储压缩率', `${stats.compressionRatio.toFixed(1)}%`, true);
            }
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
            .setName('修改时保存延迟 (秒)')
            .setDesc('文件修改后等待多久才执行自动保存。例如 180 代表 3 分钟。')
            .addText(text => text
                .setValue(String(this.plugin.settings.autoSaveDelayOnModify))
                .onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num >= 0) {
                        this.plugin.settings.autoSaveDelayOnModify = num;
                        await this.plugin.saveSettings();
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

        containerEl.createEl('h3', { text: '🗑️ 自动清理' });

        new Setting(containerEl)
            .setName('启用自动清理')
            .setDesc('自动删除旧版本以节省空间')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoClear)
                .onChange(async (value) => {
                    this.plugin.settings.autoClear = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        if (this.plugin.settings.autoClear) {
            new Setting(containerEl)
                .setName('按数量清理')
                .setDesc('保留指定数量的最新版本')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.enableMaxVersions)
                    .onChange(async (value) => {
                        this.plugin.settings.enableMaxVersions = value;
                        await this.plugin.saveSettings();
                        this.display(); 
                    }));

            if (this.plugin.settings.enableMaxVersions) {
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
            }

            new Setting(containerEl)
                .setName('按天数清理')
                .setDesc('自动删除超过指定天数的版本')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.enableMaxDays)
                    .onChange(async (value) => {
                        this.plugin.settings.enableMaxDays = value;
                        await this.plugin.saveSettings();
                        this.display(); 
                    }));

            if (this.plugin.settings.enableMaxDays) {
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
            }
        }

        containerEl.createEl('h3', { text: '🎨 显示设置' });

        new Setting(containerEl)
            .setName('全库历史默认时间模式')
            .setDesc('在全库版本历史中，默认按“文件修改时间”还是“版本保存时间”进行排序和展示。')
            .addDropdown(dropdown => dropdown
                .addOption('modified', '文件修改时间')
                .addOption('saved', '版本保存时间')
                .setValue(this.plugin.settings.globalHistoryTimeMode)
                .onChange(async (value: 'modified' | 'saved') => {
                    this.plugin.settings.globalHistoryTimeMode = value;
                    await this.plugin.saveSettings();
                    this.plugin.refreshVersionHistoryView();
                }));

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
        } catch (error: unknown) {
            console.error('清空版本失败:', getErrorMessage(error), error);
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
            const headerContainer = contentEl.createEl('div', { attr: { style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;' } });
            headerContainer.createEl('p', { text: `⚠️ 发现 ${this.report.length} 个文件存在问题:`, attr: { style: 'margin: 0;' } });
            
            const repairAllBtn = headerContainer.createEl('button', { text: '✨ 一键修复所有哈希', cls: 'mod-cta' });
            
            repairAllBtn.addEventListener('click', async () => {
                repairAllBtn.setText('正在努力修复中...');
                repairAllBtn.disabled = true;
                
                let successCount = 0;
                let failCount = 0;
                const total = this.report.length;
                const notice = new Notice(`正在批量修复哈希... 0/${total}`, 0);

                for (let i = 0; i < total; i++) {
                    const item = this.report[i]!;
                    try {
                        const repaired = await this.plugin.repairVersionFile(item.filePath);
                        if (repaired) successCount++;
                        else failCount++; 
                    } catch (e: unknown) {
                        failCount++;
                    }
                    
                    if (i % 5 === 0) {
                        notice.setMessage(`正在批量修复哈希... ${i + 1}/${total}`);
                        repairAllBtn.setText(`修复中 ${i + 1}/${total}...`);
                        await this.plugin.yieldToMain();
                    }
                }

                notice.hide();
                new Notice(`✅ 批量修复完成！\n成功修复 ${successCount} 个文件。\n（若有残留错误，可能是文件严重损坏）`, 8000);
                this.close(); 
            });
            
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
                    repairBtn.setText('修复中...');
                    repairBtn.disabled = true;
                    const repaired = await this.plugin.repairVersionFile(item.filePath);
                    if (repaired) {
                        repairBtn.setText('✅ 修复成功');
                        repairBtn.addClass('mod-cta'); 
                    } else {
                        repairBtn.setText('修复失败');
                        new Notice('无法自动修复，可能是依赖链断裂或内容已损坏。');
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