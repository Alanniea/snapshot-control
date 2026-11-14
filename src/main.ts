
import { 
    Plugin, TFile, TFolder, debounce, moment, normalizePath, DataAdapter, Notice 
} from 'obsidian';
import * as Diff from 'diff';
import { 
    VersionHistoryView, DiffModal, IntegrityReportModal, VersionControlSettingTab 
} from './ui';

// --- 工具函数：安全提取错误信息 ---
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
    return 'Unknown error occurred';
}

// --- 高效哈希算法 (cyrb53) ---
export function cyrb53(str: string, seed = 0): number {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function hashString(str: string): string {
    return cyrb53(str).toString(36);
}

// --- 纯净轻量级 LRU 缓存 ---
export class SimpleLRU<K, V> {
    private max: number;
    private cache: Map<K, V> = new Map();
    constructor(max = 50) { this.max = max; }
    get(key: K): V | undefined {
        if (!this.cache.has(key)) return undefined;
        const val = this.cache.get(key)!;
        this.cache.delete(key);
        this.cache.set(key, val);
        return val;
    }
    set(key: K, val: V) {
        if (this.cache.has(key)) this.cache.delete(key);
        else if (this.cache.size >= this.max) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(key, val);
    }
    delete(key: K): boolean { return this.cache.delete(key); }
    deletePrefix(prefix: string) {
        for (const key of this.cache.keys()) {
            if (typeof key === 'string' && key.startsWith(prefix)) this.cache.delete(key);
        }
    }
    clear() { this.cache.clear(); }
}

// --- 数据结构定义 ---
export interface VersionData {
    id: string;
    timestamp: number;
    message: string;
    content?: string;     
    diff?: string;        
    baseVersionId?: string; 
    size: number;
    hash: string;
    tags?: string[];
    starred?: boolean;
}

// 轻量元数据（剥离正文与补丁，专用于全局索引，避免内存与磁盘膨胀）
export type VersionMeta = Omit<VersionData, 'content' | 'diff' | 'baseVersionId'>;

export interface SnapshotIndexEntry {
    latest: VersionMeta;
    prev?: VersionMeta;
    totalVersions: number;
}

export interface VersionFile {
    filePath: string;
    versions: VersionData[];
    lastModified: number;
    versionIndex?: Map<string, number>;
}

export interface GlobalHistoryItem {
    version: VersionMeta;
    prevVersion?: VersionMeta;
    filePath: string;
    file: TFile | null;
    hasUnsavedChanges?: boolean;
    isUnversioned?: boolean;
    currentChars?: number;
    snapshotChars?: number;
    prevSnapshotChars?: number;
    charDiff: number;
    diffMode: 'workspace' | 'snapshot' | 'unversioned';
    totalVersions?: number;
}

export interface VersionControlSettings {
    versionFolder: string;
    autoSave: boolean;
    autoSaveDelayOnModify: number;
    autoClear: boolean;
    maxVersions: number;
    enableMaxVersions: boolean;
    maxDays: number;
    enableMaxDays: boolean;
    enableDeduplication: boolean;
    showNotifications: boolean;
    excludedFolders: string[];
    enableCompression: boolean;
    enableIncrementalStorage: boolean;
    rebuildBaseInterval: number;
    enableStatusBarDiff: boolean;
    deleteHistoryOnDelete: boolean; 
}

export const DEFAULT_SETTINGS: VersionControlSettings = {
    versionFolder: '.versions',
    autoSave: true,
    autoSaveDelayOnModify: 3,
    autoClear: true,
    maxVersions: 50,
    enableMaxVersions: true,
    maxDays: 30,
    enableMaxDays: false,
    enableDeduplication: true,
    showNotifications: false,
    excludedFolders: [],
    enableCompression: true,
    enableIncrementalStorage: true,
    rebuildBaseInterval: 10,
    enableStatusBarDiff: true,
    deleteHistoryOnDelete: false, 
};

export type ViewMode = 'current' | 'global';

type DebouncedFn = ((...args: any[]) => any) & { cancel?: () => void };

// =======================================================================
// ==================== 主插件类 (VersionControlPlugin) ===================
// =======================================================================
export default class VersionControlPlugin extends Plugin {
    settings: VersionControlSettings;
    debouncedSaves: Map<string, DebouncedFn> = new Map();
    statusBarItem: HTMLElement;
    
    versionCache: SimpleLRU<string, VersionFile> = new SimpleLRU(50);
    contentCache: SimpleLRU<string, string> = new SimpleLRU(50); 
    globalHistoryCache: GlobalHistoryItem[] | null = null;
    private readonly globalCacheLimit = 100;
    
    snapshotMetaMap: Map<string, SnapshotIndexEntry> = new Map();
    isSnapshotMetaLoaded = false;
    private loadingIndexPromise: Promise<void> | null = null;
    private debouncedSaveGlobalIndex: DebouncedFn;
    private debouncedRefreshViews: DebouncedFn;
    private debouncedFlushModifyCache: DebouncedFn;
    private pendingModifyPaths: Set<string> = new Set();
    private normalizedExcludedFolders: string[] = [];
    private textDecoder = new TextDecoder('utf-8');
    private cleanupTimer: number | null = null;
    
    activeFileLastSaveTime: number | null = null;
    activeFileSaveLabel = '';
    fileLocks: Map<string, Promise<void>> = new Map();
    isRestoring = false; 
    isUnloaded = false;

    debouncedUpdateStatusBar: DebouncedFn;
    private lastRenderedStatusText = '';
    private lastStatusTitleKey = '';

    async onload() {
        this.isUnloaded = false;
        await this.loadSettings();

        this.debouncedSaveGlobalIndex = debounce(() => this.persistGlobalIndex(), 1500, true);
        this.debouncedRefreshViews = debounce(() => this.performRefreshViews(), 80, true);
        this.debouncedFlushModifyCache = debounce(() => this.flushModifyCache(), 350, true);

        this.statusBarItem = this.addStatusBarItem();
        this.debouncedUpdateStatusBar = debounce(() => this.updateStatusBar(), 200, true);
        this.debouncedUpdateStatusBar();

        if (this.settings.enableStatusBarDiff) {
            this.statusBarItem.addClass('vc-statusbar-pill');
            this.statusBarItem.addEventListener('click', () => this.quickDiffFromStatusBar());
        }

        this.registerView('version-history', (leaf) => new VersionHistoryView(leaf, this));

        this.addCommand({ id: 'show-version-history', name: '显示版本历史', callback: () => this.activateVersionHistoryView() });
        this.addCommand({ id: 'create-manual-version', name: '保存当前文件快照', callback: () => this.createManualVersion() });
        this.addCommand({ id: 'check-version-integrity', name: '检查版本完整性', callback: () => this.checkAllVersionsIntegrity() });

        this.addSettingTab(new VersionControlSettingTab(this.app, this));

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (this.isRestoring) return;
                if (file instanceof TFile && !this.isExcluded(file.path)) {
                    if (this.settings.autoSave) {
                        this.handleFileModify(file);
                    }
                    this.pendingModifyPaths.add(file.path);
                    this.debouncedFlushModifyCache();
                }
            })
        );

        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.debouncedUpdateStatusBar()));
        this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
            if (file instanceof TFile) await this.handleRename(file, oldPath);
            else if (file instanceof TFolder) await this.handleFolderRename(file, oldPath);
        }));
        this.registerEvent(this.app.vault.on('delete', async (file) => {
            if (file instanceof TFile) await this.handleDelete(file.path);
        }));

        await this.ensureVersionFolder();

        // 后台异步加载索引并延迟清理 .tmp，避免阻塞 Obsidian 启动
        this.loadOrBuildGlobalIndex().catch(() => {});
        this.cleanupTimer = window.setTimeout(() => {
            this.cleanupTimer = null;
            if (!this.isUnloaded) this.cleanupTempFiles().catch(() => {});
        }, 5000);

        this.registerInterval(
            window.setInterval(() => { 
                if (document.hidden) return;
                this.renderStatusBarTime();
                const leaves = this.app.workspace.getLeavesOfType('version-history');
                for (const leaf of leaves) { 
                    if (leaf.view instanceof VersionHistoryView) leaf.view.updateRelativeTimes(); 
                }
            }, 1000) as unknown as number
        );
    }

    onunload() {
        this.isUnloaded = true;
        if (this.cleanupTimer !== null) {
            clearTimeout(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        for (const fn of this.debouncedSaves.values()) {
            fn.cancel?.();
        }
        this.debouncedSaves.clear();
        this.debouncedSaveGlobalIndex?.cancel?.();
        this.debouncedUpdateStatusBar?.cancel?.();
        this.debouncedRefreshViews?.cancel?.();
        this.debouncedFlushModifyCache?.cancel?.();
        this.pendingModifyPaths.clear();

        this.versionCache.clear();
        this.contentCache.clear();
        this.globalHistoryCache = null;
        this.snapshotMetaMap.clear();
        this.isSnapshotMetaLoaded = false;
        this.loadingIndexPromise = null;
    }

    clearGlobalCache() { 
        this.globalHistoryCache = null; 
    }

    async yieldToMain() { return new Promise(resolve => setTimeout(resolve, 0)); }

    async compressText(text: string): Promise<ArrayBuffer> {
        const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
        return await new Response(stream).arrayBuffer();
    }

    async decompressText(buffer: ArrayBuffer): Promise<string> {
        const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
        return await new Response(stream).text();
    }

    async safeWrite(adapter: DataAdapter, path: string, data: string | ArrayBuffer, isBinary: boolean): Promise<void> {
        const tempPath = path + '.tmp';
        try {
            if (isBinary) await adapter.writeBinary(tempPath, data as ArrayBuffer);
            else await adapter.write(tempPath, data as string);
            if (await adapter.exists(path)) await adapter.remove(path);
            await adapter.rename(tempPath, path);
        } catch (err) {
            if (await adapter.exists(tempPath)) { try { await adapter.remove(tempPath); } catch {} }
            throw err;
        }
    }

    async cleanupTempFiles() {
        const adapter = this.app.vault.adapter;
        const folder = this.settings.versionFolder;
        if (!(await adapter.exists(folder))) return;

        const queue: string[] = [folder];
        const visited = new Set<string>();

        while (queue.length > 0) {
            if (this.isUnloaded) return;
            const cur = queue.shift()!;
            if (visited.has(cur)) continue;
            visited.add(cur);
            try {
                const list = await adapter.list(cur);
                for (const f of list.files) {
                    if (f.endsWith('.tmp')) {
                        try { await adapter.remove(f); } catch {}
                    }
                }
                for (const sub of list.folders) {
                    const base = sub.split('/').pop() || '';
                    if (base !== '.' && base !== '..' && !visited.has(sub)) queue.push(sub);
                }
            } catch {}
            if (visited.size % 20 === 0) await this.yieldToMain();
        }
    }

    async withLock(filePath: string, fn: () => Promise<void>, timeoutMs = 30000): Promise<void> {
        const currentLock = this.fileLocks.get(filePath) || Promise.resolve();
        let resolveLock: () => void;
        const nextLock = new Promise<void>((res) => { resolveLock = res; });
        this.fileLocks.set(filePath, nextLock);
        try {
            await currentLock;
            let timer: any;
            const timeoutPromise = new Promise<void>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Timeout for ${filePath}`)), timeoutMs);
            });
            await Promise.race([fn(), timeoutPromise]);
            clearTimeout(timer);
        } finally {
            resolveLock!();
            if (this.fileLocks.get(filePath) === nextLock) this.fileLocks.delete(filePath);
        }
    }

    getVersionFilePath(filePath: string): string {
        const hash = hashString(filePath);
        const subFolder = hash.substring(0, 2); 
        const fileName = filePath.split('/').pop() || 'file';
        const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_');
        return normalizePath(`${this.settings.versionFolder}/${subFolder}/${safeName}_${hash}.json`);
    }

    normalizeText(text: string): string { 
        if (!text) return "";
        return text.indexOf('\r') === -1 ? text : text.replace(/\r\n?/g, "\n"); 
    }

    private stripVersionData(v?: VersionData | VersionMeta): VersionMeta | undefined {
        if (!v) return undefined;
        return {
            id: v.id,
            timestamp: v.timestamp,
            message: v.message,
            size: v.size,
            hash: v.hash,
            ...(v.tags && v.tags.length > 0 ? { tags: v.tags } : {}),
            ...(v.starred !== undefined ? { starred: v.starred } : {})
        };
    }

    private cancelDebouncer(filePath: string) {
        const old = this.debouncedSaves.get(filePath);
        if (old) {
            old.cancel?.();
            this.debouncedSaves.delete(filePath);
        }
    }

    private collectFilesInFolder(folder: TFolder, out: TFile[] = []): TFile[] {
        for (const child of folder.children) {
            if (child instanceof TFile) out.push(child);
            else if (child instanceof TFolder) this.collectFilesInFolder(child, out);
        }
        return out;
    }

    async handleFolderRename(folder: TFolder, oldFolderPath: string) {
        const files = this.collectFilesInFolder(folder);
        for (const file of files) {
            const rel = file.path.substring(folder.path.length);
            await this.handleRename(file, oldFolderPath + rel, true);
        }
        if (files.length > 0) {
            this.debouncedSaveGlobalIndex();
            this.clearGlobalCache();
            this.refreshVersionHistoryView();
        }
    }

    async handleRename(file: TFile, oldPath: string, skipBatchSideEffects = false) {
        this.cancelDebouncer(oldPath);

        await this.withLock(oldPath, async () => {
            const adapter = this.app.vault.adapter;
            const oldVersionPath = this.getVersionFilePath(oldPath);

            if (await adapter.exists(oldVersionPath)) {
                const newVersionPath = this.getVersionFilePath(file.path);
                const parentDir = newVersionPath.substring(0, newVersionPath.lastIndexOf('/'));
                if (!(await adapter.exists(parentDir))) await adapter.mkdir(parentDir);

                await adapter.rename(oldVersionPath, newVersionPath);
                try {
                    this.versionCache.delete(file.path); 
                    this.contentCache.deletePrefix(file.path + "::");
                    const versionFile = await this.loadVersionFile(file.path); 
                    versionFile.filePath = file.path;
                    await this.saveVersionFile(file.path, versionFile);
                    
                    this.versionCache.delete(oldPath);
                    this.contentCache.deletePrefix(oldPath + "::");

                    await this.loadOrBuildGlobalIndex();
                    const meta = this.snapshotMetaMap.get(oldPath);
                    if (meta) {
                        this.snapshotMetaMap.delete(oldPath);
                        this.snapshotMetaMap.set(file.path, meta);
                    }

                    if (!skipBatchSideEffects) {
                        this.debouncedSaveGlobalIndex();
                        this.clearGlobalCache();
                        this.refreshVersionHistoryView();
                    }
                } catch (e) { console.error("Rename Error", e); }
            }
        });
    }

    async handleDelete(filePath: string) {
        this.cancelDebouncer(filePath);

        if (!this.settings.deleteHistoryOnDelete) {
            this.clearGlobalCache();
            this.refreshVersionHistoryView();
            return;
        }

        await this.withLock(filePath, async () => {
            const adapter = this.app.vault.adapter;
            const versionPath = this.getVersionFilePath(filePath);
            if (await adapter.exists(versionPath)) {
                await adapter.remove(versionPath);
                this.versionCache.delete(filePath);
                this.contentCache.deletePrefix(filePath + "::");
                await this.loadOrBuildGlobalIndex();
                this.snapshotMetaMap.delete(filePath);
                this.debouncedSaveGlobalIndex();
                this.clearGlobalCache();
                this.refreshVersionHistoryView();
            }
        });
    }

    private updateExcludedCache() {
        this.normalizedExcludedFolders = (this.settings.excludedFolders || [])
            .map(folder => folder.replace(/\/+$/, ''))
            .filter(Boolean);
    }

    async loadSettings() { 
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); 
        this.updateExcludedCache();
    }

    async saveSettings() { 
        this.updateExcludedCache();
        await this.saveData(this.settings); 
        for (const fn of this.debouncedSaves.values()) {
            fn.cancel?.();
        }
        this.debouncedSaves.clear();
        this.debouncedUpdateStatusBar(); 
    }

    getSaveTypeLabel(message: string): string { 
        if (!message) return '自动保存';
        if (message.includes('[Auto Save]')) return '自动保存';
        if (message.includes('[Before Restore]')) return '恢复前备份';
        return '手动快照';
    }

    async updateStatusBar() {
        if (!this.settings.autoSave) { 
            this.statusBarItem.setText('⏸ 历史暂停'); 
            this.lastRenderedStatusText = '⏸ 历史暂停';
            this.statusBarItem.title = '';
            this.lastStatusTitleKey = '';
            this.activeFileLastSaveTime = null;
            return; 
        }
        const file = this.app.workspace.getActiveFile();
        if (!this.settings.enableStatusBarDiff || !file) { 
            this.statusBarItem.setText(''); 
            this.lastRenderedStatusText = '';
            this.statusBarItem.title = '';
            this.lastStatusTitleKey = '';
            this.activeFileLastSaveTime = null;
            return; 
        }

        // 优先 O(1) 读取内存快照索引，切笔记零磁盘 I/O
        let last: VersionMeta | VersionData | undefined = this.snapshotMetaMap.get(file.path)?.latest;
        if (!last && !this.isSnapshotMetaLoaded) {
            const cached = this.versionCache.get(file.path);
            if (cached && cached.versions.length > 0) {
                last = cached.versions[0];
            } else {
                const versions = await this.getAllVersions(file.path);
                if (this.app.workspace.getActiveFile()?.path !== file.path) return;
                last = versions[0];
            }
        }

        if (last) {
            this.activeFileLastSaveTime = last.timestamp;
            this.activeFileSaveLabel = this.getSaveTypeLabel(last.message);
            this.renderStatusBarTime();
        } else {
            this.activeFileLastSaveTime = null;
            this.statusBarItem.setText('');
            this.lastRenderedStatusText = '';
            this.statusBarItem.title = '';
            this.lastStatusTitleKey = '';
        }
    }

    renderStatusBarTime() {
        if (this.activeFileLastSaveTime === null) return;
        const relativeTime = this.getRelativeTime(this.activeFileLastSaveTime);
        const newText = `${this.activeFileSaveLabel} · ${relativeTime}`;
        if (this.lastRenderedStatusText !== newText) {
            this.statusBarItem.setText(newText);
            this.lastRenderedStatusText = newText;
        }
        const titleKey = `${this.activeFileSaveLabel}:${this.activeFileLastSaveTime}`;
        if (this.lastStatusTitleKey !== titleKey) {
            this.lastStatusTitleKey = titleKey;
            this.statusBarItem.title = `${this.activeFileSaveLabel}于 ${new Date(this.activeFileLastSaveTime).toLocaleString('zh-CN')}。点击对比差异。`;
        }
    }

    async quickDiffFromStatusBar() {
        if (!this.settings.enableStatusBarDiff) return;
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice('没有打开的文件'); return; }
        const versions = await this.getAllVersions(file.path);
        if (versions.length === 0) { new Notice('没有历史版本可对比'); return; }
        new DiffModal(this.app, this, file, versions[0]!.id).open();
    }

    async ensureVersionFolder() { 
        const adapter = this.app.vault.adapter;
        try { 
            if (!await adapter.exists(this.settings.versionFolder)) await adapter.mkdir(this.settings.versionFolder); 
        } catch (e) { console.error('无法创建版本文件夹:', e); }
    }

    async activateVersionHistoryView() { 
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType('version-history')[0];
        if (!leaf) { 
            const rightLeaf = workspace.getRightLeaf(false); 
            if (!rightLeaf) return; 
            leaf = rightLeaf; 
            await leaf.setViewState({ type: 'version-history', active: true }); 
        }
        workspace.revealLeaf(leaf);
    }

    handleFileModify(file: TFile) {
        if (this.isExcluded(file.path)) return;
        let debouncer = this.debouncedSaves.get(file.path);
        if (!debouncer) {
            const delayMinutes = Math.max(0.1, Number(this.settings.autoSaveDelayOnModify) || 3);
            debouncer = debounce(async (f: TFile) => { 
                if (this.isUnloaded) return;
                if (!this.app.vault.getAbstractFileByPath(f.path)) return;
                await this.createVersion(f, '[Auto Save]', false); 
            }, delayMinutes * 60 * 1000, true);
            this.debouncedSaves.set(file.path, debouncer);
        }
        debouncer(file);
    }
    
    isExcluded(filePath: string): boolean { 
        for (let i = 0; i < this.normalizedExcludedFolders.length; i++) {
            const clean = this.normalizedExcludedFolders[i]!;
            if (filePath === clean || filePath.startsWith(clean + '/')) return true;
        }
        return false;
    }

    async createManualVersion() {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice('没有打开的文件'); return; }
        this.cancelDebouncer(file.path);
        await this.createVersion(file, '[Manual Save]', false, [], true);
    }

    async createVersion(file: TFile, message: string, showNotification = false, tags: string[] = [], isManual = false) {
        await this.withLock(file.path, async () => {
             const raw = await this.app.vault.read(file);
             const content = this.normalizeText(raw);
             await this.createVersionInternal(file, message, showNotification, tags, isManual, content);
        });
    }

    private updateGlobalCacheOnSnapshot(file: TFile, versionFile: VersionFile, latestChars: number) {
        if (!this.globalHistoryCache) return;
        const latestMeta = this.stripVersionData(versionFile.versions[0]!)!;
        const prevMeta = this.stripVersionData(versionFile.versions[1]);
        const prevSnapshotChars = prevMeta?.size;

        const newItem: GlobalHistoryItem = {
            version: latestMeta,
            prevVersion: prevMeta,
            filePath: file.path,
            file: file,
            hasUnsavedChanges: false,
            isUnversioned: false,
            currentChars: latestChars,
            snapshotChars: latestChars,
            prevSnapshotChars,
            charDiff: prevSnapshotChars !== undefined ? (latestChars - prevSnapshotChars) : 0,
            diffMode: 'snapshot',
            totalVersions: versionFile.versions.length
        };

        const idx = this.globalHistoryCache.findIndex(item => item.filePath === file.path);
        if (idx !== -1) {
            this.globalHistoryCache.splice(idx, 1);
        }
        this.globalHistoryCache.unshift(newItem);
        if (this.globalHistoryCache.length > this.globalCacheLimit) {
            this.globalHistoryCache.pop();
        }
    }

    private async createVersionInternal(file: TFile, message: string, showNotification: boolean, tags: string[], isManual: boolean, content: string) {
        try {
            await this.loadOrBuildGlobalIndex();

            const timestamp = Date.now();
            const id = `${timestamp}-${Math.random().toString(36).substring(2, 9)}`;
            const hash = hashString(content);
            const versionFile = await this.loadVersionFile(file.path);
            
            if (this.settings.enableDeduplication) {
                const latest = versionFile.versions[0];
                if (latest && latest.hash === hash) {
                    if (isManual && latest.message.includes('[Auto Save]')) {
                        latest.message = message;
                        latest.timestamp = timestamp;
                        latest.tags = tags.length > 0 ? tags : latest.tags;
                        await this.saveVersionFile(file.path, versionFile);
                        this.versionCache.set(file.path, versionFile);
                        this.snapshotMetaMap.set(file.path, {
                            latest: this.stripVersionData(latest)!,
                            prev: this.stripVersionData(versionFile.versions[1]),
                            totalVersions: versionFile.versions.length
                        });
                        this.debouncedSaveGlobalIndex();
                        this.updateGlobalCacheOnSnapshot(file, versionFile, content.length);
                        this.refreshVersionHistoryView();
                        this.debouncedUpdateStatusBar();
                        return;
                    }
                    return;
                }
            }

            await this.yieldToMain();

            if (this.settings.enableIncrementalStorage && versionFile.versions.length > 0) {
                const prev = versionFile.versions[0]!;
                const prevContent = await this.getVersionContent(file.path, prev.id, true);
                
                let chainLength = 1;
                for (let i = 1; i < versionFile.versions.length; i++) {
                    const v = versionFile.versions[i]!;
                    if (v.diff && v.baseVersionId === versionFile.versions[i-1]!.id) chainLength++; else break;
                }

                if (chainLength < this.settings.rebuildBaseInterval) {
                    const patch = Diff.createPatch('file', content, prevContent, '', '');
                    const test = Diff.applyPatch(content, patch);
                    if (test !== false && this.normalizeText(test) === prevContent) {
                        prev.diff = patch;
                        prev.baseVersionId = id; 
                        prev.size = prevContent.length;
                        delete prev.content; 
                    }
                }
            }

            const newVersion: VersionData = {
                id, timestamp, message, content, size: content.length, hash,
                tags: tags.length > 0 ? tags : undefined, starred: false
            };

            versionFile.versions.unshift(newVersion);
            versionFile.lastModified = timestamp;

            if (this.settings.autoClear) {
                await this.yieldToMain();
                await this.cleanupVersionsInMemory(versionFile);
            }

            this.buildVersionIndex(versionFile);
            this.repairVersionSizes(versionFile);
            await this.yieldToMain(); 
            await this.saveVersionFile(file.path, versionFile);
            
            this.versionCache.set(file.path, versionFile);
            this.contentCache.set(`${file.path}::${newVersion.id}`, content);

            this.snapshotMetaMap.set(file.path, {
                latest: this.stripVersionData(newVersion)!,
                prev: this.stripVersionData(versionFile.versions[1]),
                totalVersions: versionFile.versions.length
            });
            this.debouncedSaveGlobalIndex();

            this.updateGlobalCacheOnSnapshot(file, versionFile, content.length);
            this.refreshVersionHistoryView();
            this.debouncedUpdateStatusBar();
        } catch (error) {
            console.error('保存版本失败:', getErrorMessage(error));
            if (showNotification) new Notice('❌ 保存版本失败');
        }
    }

    private async flushModifyCache() {
        if (this.isUnloaded || this.pendingModifyPaths.size === 0) return;
        const paths = Array.from(this.pendingModifyPaths);
        this.pendingModifyPaths.clear();

        let hasActiveVisibleGlobalView = false;
        const leaves = this.app.workspace.getLeavesOfType('version-history');
        for (const leaf of leaves) {
            if (leaf.view instanceof VersionHistoryView && leaf.view.isGlobalViewVisible()) {
                hasActiveVisibleGlobalView = true;
                break;
            }
        }

        if (!this.globalHistoryCache) {
            if (hasActiveVisibleGlobalView) {
                this.refreshGlobalViewsOnly();
            }
            return;
        }

        if (paths.length > 20) {
            this.clearGlobalCache();
            if (hasActiveVisibleGlobalView) this.refreshGlobalViewsOnly();
            return;
        }

        for (const filePath of paths) {
            const abstract = this.app.vault.getAbstractFileByPath(filePath);
            if (!(abstract instanceof TFile)) continue;

            let currentChars = abstract.stat.size;
            let normCur = '';
            try {
                const text = await this.app.vault.cachedRead(abstract);
                normCur = this.normalizeText(text);
                currentChars = normCur.length;
            } catch {}

            const snaps = this.snapshotMetaMap.get(filePath);
            const idx = this.globalHistoryCache.findIndex(item => item.filePath === filePath);

            if (idx !== -1) {
                const item = this.globalHistoryCache[idx]!;
                const snapshotChars = item.snapshotChars ?? item.version?.size ?? 0;
                const hasUnsaved = item.isUnversioned
                    ? true
                    : (snaps?.latest?.hash ? (hashString(normCur) !== snaps.latest.hash) : (currentChars !== snapshotChars));

                item.hasUnsavedChanges = hasUnsaved;
                if (item.isUnversioned) {
                    item.diffMode = 'unversioned';
                    item.charDiff = currentChars;
                } else if (hasUnsaved) {
                    item.diffMode = 'workspace';
                    item.charDiff = currentChars - snapshotChars;
                } else {
                    item.diffMode = 'snapshot';
                    item.charDiff = item.prevSnapshotChars !== undefined ? (snapshotChars - item.prevSnapshotChars) : 0;
                }
                item.currentChars = currentChars;

                if (idx > 0) {
                    this.globalHistoryCache.splice(idx, 1);
                    this.globalHistoryCache.unshift(item);
                }
            } else if (snaps && snaps.latest) {
                const latest = snaps.latest;
                const prev = snaps.prev;
                const snapshotChars = latest.size ?? 0;
                const prevSnapshotChars = prev ? prev.size : undefined;
                const hasUnsaved = latest.hash ? (hashString(normCur) !== latest.hash) : (currentChars !== snapshotChars);

                this.globalHistoryCache.unshift({
                    version: latest,
                    prevVersion: prev,
                    filePath,
                    file: abstract,
                    hasUnsavedChanges: hasUnsaved,
                    isUnversioned: false,
                    currentChars,
                    snapshotChars,
                    prevSnapshotChars,
                    charDiff: hasUnsaved ? (currentChars - snapshotChars) : (prevSnapshotChars !== undefined ? snapshotChars - prevSnapshotChars : 0),
                    diffMode: hasUnsaved ? 'workspace' : 'snapshot',
                    totalVersions: snaps.totalVersions ?? 1
                });
            } else {
                this.globalHistoryCache.unshift({
                    version: {
                        id: 'unversioned',
                        timestamp: abstract.stat?.mtime ?? Date.now(),
                        message: '未保存快照',
                        size: currentChars,
                        hash: ''
                    },
                    filePath,
                    file: abstract,
                    hasUnsavedChanges: true,
                    isUnversioned: true,
                    currentChars,
                    snapshotChars: 0,
                    charDiff: currentChars,
                    diffMode: 'unversioned',
                    totalVersions: 0
                });
            }

            if (this.globalHistoryCache.length > this.globalCacheLimit) {
                this.globalHistoryCache.pop();
            }
        }

        if (hasActiveVisibleGlobalView) {
            this.refreshGlobalViewsOnly();
        }
    }

    private refreshGlobalViewsOnly() {
        const leaves = this.app.workspace.getLeavesOfType('version-history');
        for (const leaf of leaves) {
            if (leaf.view instanceof VersionHistoryView && leaf.view.isGlobalViewVisible()) {
                leaf.view.refreshSmart();
            }
        }
    }

    buildVersionIndex(versionFile: VersionFile) { 
        const index = new Map<string, number>(); 
        versionFile.versions.forEach((v, idx) => { index.set(v.id, idx); }); 
        versionFile.versionIndex = index; 
    }

    repairVersionSizes(vf: VersionFile) {
        if (!vf || !vf.versions || vf.versions.length === 0) return;

        let lastBrokenIdx = -1;
        for (let i = vf.versions.length - 1; i >= 0; i--) {
            const v = vf.versions[i]!;
            if (
                typeof v.size !== 'number' ||
                v.size < 0 ||
                (v.content !== undefined && v.content !== null && v.size !== v.content.length)
            ) {
                lastBrokenIdx = i;
                break;
            }
        }
        if (lastBrokenIdx === -1) return;

        let currentKnownText: string | null = vf.versions[0]?.content ?? null;
        if (currentKnownText !== null) {
            vf.versions[0]!.size = currentKnownText.length;
        }

        for (let i = 1; i <= lastBrokenIdx; i++) {
            const v = vf.versions[i]!;

            if (v.content !== undefined && v.content !== null) {
                currentKnownText = v.content;
                v.size = v.content.length;
                continue;
            }

            if (currentKnownText !== null && v.diff) {
                try {
                    const restored = Diff.applyPatch(currentKnownText, v.diff);
                    if (restored !== false) {
                        currentKnownText = restored;
                        v.size = restored.length;
                        continue;
                    }
                } catch {}
            }

            currentKnownText = null;
        }
    }
    
    resolveContentFromList(versions: VersionData[], versionId: string): string { 
        let currentId = versionId;
        let currentVersion = versions.find(v => v.id === currentId);
        if (!currentVersion) throw new Error(`无法找到版本: ${versionId}`);

        const patches: string[] = [];
        const visited = new Set<string>();

        while (currentVersion) {
            if (visited.has(currentId)) throw new Error("检测到循环依赖");
            visited.add(currentId);

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
            } else throw new Error("版本数据不完整");
        }
        throw new Error("依赖链断裂");
    }

    async deleteSingleVersion(filePath: string, versionId: string): Promise<boolean> {
        await this.loadOrBuildGlobalIndex();
        let success = false;
        await this.withLock(filePath, async () => {
            try {
                const vf = await this.loadVersionFile(filePath);
                const targetIdx = vf.versions.findIndex(v => v.id === versionId);
                if (targetIdx === -1) return;

                const dependents = vf.versions.filter(v => v.baseVersionId === versionId);
                for (const dependent of dependents) {
                    try {
                        const full = this.resolveContentFromList(vf.versions, dependent.id);
                        dependent.content = full;
                        dependent.diff = undefined;
                        dependent.baseVersionId = undefined;
                        dependent.size = full.length;
                    } catch {
                        new Notice('❌ 无法删除：解除依赖链失败');
                        return;
                    }
                }

                vf.versions.splice(targetIdx, 1);
                vf.lastModified = Date.now();
                this.buildVersionIndex(vf);
                this.repairVersionSizes(vf);

                if (vf.versions.length > 0) {
                    await this.saveVersionFile(filePath, vf);
                    this.versionCache.set(filePath, vf);
                    this.snapshotMetaMap.set(filePath, {
                        latest: this.stripVersionData(vf.versions[0]!)!,
                        prev: this.stripVersionData(vf.versions[1]),
                        totalVersions: vf.versions.length
                    });
                } else {
                    const adapter = this.app.vault.adapter;
                    const vPath = this.getVersionFilePath(filePath);
                    if (await adapter.exists(vPath)) {
                        try { await adapter.remove(vPath); } catch {}
                    }
                    this.versionCache.delete(filePath);
                    this.snapshotMetaMap.delete(filePath);
                }

                this.contentCache.delete(`${filePath}::${versionId}`);
                this.debouncedSaveGlobalIndex();
                this.clearGlobalCache();
                this.debouncedUpdateStatusBar();
                success = true;
                new Notice('🗑️ 快照已彻底删除');
            } catch (e) {
                console.error(e);
            }
        });
        return success;
    }

    async resurrectDeletedFile(filePath: string, versionId: string): Promise<TFile | null> {
        try {
            const existing = this.app.vault.getAbstractFileByPath(filePath);
            if (existing instanceof TFile) {
                new Notice('ℹ️ 该笔记已存在于库中，为您直接打开');
                return existing;
            }

            const content = await this.getVersionContent(filePath, versionId);
            const parts = filePath.split('/');
            if (parts.length > 1) {
                let currentPath = '';
                for (let i = 0; i < parts.length - 1; i++) {
                    currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i]!;
                    if (!(await this.app.vault.adapter.exists(currentPath))) {
                        await this.app.vault.createFolder(currentPath);
                    }
                }
            }
            const created = await this.app.vault.create(filePath, content);
            this.clearGlobalCache();
            this.refreshVersionHistoryView();
            new Notice(`♻️ 已成功复活笔记: ${created.basename}`);
            return created;
        } catch (err) {
            new Notice(`❌ 复活失败: ${getErrorMessage(err)}`);
            return null;
        }
    }

    async getStorageStats(): Promise<{
        totalFiles: number;
        totalSnapshots: number;
        actualDiskBytes: number;
        rawEquivalentBytes: number;
        savedPercent: number;
    }> {
        const folder = this.settings.versionFolder;
        const adapter = this.app.vault.adapter;
        let totalFiles = 0;
        let totalSnapshots = 0;
        let actualDiskBytes = 0;
        let rawEquivalentBytes = 0;

        if (await adapter.exists(folder)) {
            const files = await this.getJSONFilesRecursively(folder);
            totalFiles = files.length;
            const chunkSize = 10;
            for (let i = 0; i < files.length; i += chunkSize) {
                if (this.isUnloaded) break;
                const chunk = files.slice(i, i + chunkSize);
                await Promise.all(chunk.map(async (file) => {
                    try {
                        const [stat, raw] = await Promise.all([
                            adapter.stat(file),
                            this.readCompressedOrRaw(file)
                        ]);
                        if (stat) actualDiskBytes += stat.size;
                        if (raw) {
                            const vf = JSON.parse(raw) as VersionFile;
                            if (vf && Array.isArray(vf.versions)) {
                                totalSnapshots += vf.versions.length;
                                for (const v of vf.versions) {
                                    rawEquivalentBytes += (v.size || 0);
                                }
                            }
                        }
                    } catch {}
                }));
                await this.yieldToMain();
            }
        }

        const savedPercent = rawEquivalentBytes > 0 
            ? Math.max(0, Math.round((1 - (actualDiskBytes / rawEquivalentBytes)) * 100))
            : 0;

        return { totalFiles, totalSnapshots, actualDiskBytes, rawEquivalentBytes, savedPercent };
    }

    private async sumFilesSizeBytes(files: string[]): Promise<number> {
        const adapter = this.app.vault.adapter;
        let total = 0;
        const chunkSize = 20;
        for (let i = 0; i < files.length; i += chunkSize) {
            const chunk = files.slice(i, i + chunkSize);
            await Promise.all(chunk.map(async (f) => {
                try {
                    const st = await adapter.stat(f);
                    if (st) total += st.size;
                } catch {}
            }));
        }
        return total;
    }

    async performStoragePurge(keepDays = 30, minKeepPerFile = 5): Promise<{ purgedCount: number; savedBytes: number }> {
        const folder = this.settings.versionFolder;
        const adapter = this.app.vault.adapter;
        let purgedCount = 0;

        if (!(await adapter.exists(folder))) {
            return { purgedCount: 0, savedBytes: 0 };
        }

        const files = await this.getJSONFilesRecursively(folder);
        const beforeDisk = await this.sumFilesSizeBytes(files);
        const cutoff = Date.now() - (keepDays * 24 * 60 * 60 * 1000);

        for (let idx = 0; idx < files.length; idx++) {
            if (this.isUnloaded) break;
            const file = files[idx]!;
            try {
                const raw = await this.readCompressedOrRaw(file);
                if (!raw) continue;
                const parsed = JSON.parse(raw) as VersionFile;
                if (!parsed || !parsed.filePath || !Array.isArray(parsed.versions)) continue;

                parsed.versions.sort((a, b) => b.timestamp - a.timestamp);
                const originalTotal = parsed.versions.length;
                const starred = parsed.versions.filter(v => v.starred);
                const nonStarred = parsed.versions.filter(v => !v.starred);
                const keepNonStarred = nonStarred.filter((v, i) => i < minKeepPerFile || v.timestamp >= cutoff);
                const keepIds = new Set([...starred, ...keepNonStarred].map(v => v.id));

                // 无需清理的文件直接跳过加锁与重读
                if (keepIds.size >= originalTotal) continue;

                await this.withLock(parsed.filePath, async () => {
                    const vf = await this.loadVersionFile(parsed.filePath);
                    const totalNow = vf.versions.length;
                    const starredNow = vf.versions.filter(v => v.starred);
                    const nonStarredNow = vf.versions.filter(v => !v.starred);
                    const keepNonStarredNow = nonStarredNow.filter((v, i) => i < minKeepPerFile || v.timestamp >= cutoff);
                    const keepIdsNow = new Set([...starredNow, ...keepNonStarredNow].map(v => v.id));

                    if (keepIdsNow.size < totalNow) {
                        const proposed = vf.versions.filter(v => keepIdsNow.has(v.id));
                        for (let i = proposed.length - 1; i >= 0; i--) {
                            const v = proposed[i]!;
                            if (v.diff && v.baseVersionId && !keepIdsNow.has(v.baseVersionId)) {
                                try {
                                    const full = this.resolveContentFromList(vf.versions, v.id);
                                    v.content = full;
                                    v.diff = undefined;
                                    v.baseVersionId = undefined;
                                    v.size = full.length;
                                } catch {}
                            }
                        }
                        vf.versions = proposed;
                        vf.lastModified = Date.now();
                        this.buildVersionIndex(vf);
                        this.repairVersionSizes(vf);
                        await this.saveVersionFile(vf.filePath, vf);
                        this.versionCache.delete(vf.filePath);
                        this.contentCache.deletePrefix(vf.filePath + "::");
                        if (vf.versions.length > 0) {
                            this.snapshotMetaMap.set(vf.filePath, {
                                latest: this.stripVersionData(vf.versions[0]!)!,
                                prev: this.stripVersionData(vf.versions[1]),
                                totalVersions: vf.versions.length
                            });
                        } else {
                            this.snapshotMetaMap.delete(vf.filePath);
                        }
                        purgedCount += (totalNow - vf.versions.length);
                    }
                });
            } catch {}
            if (idx % 5 === 0) await this.yieldToMain();
        }

        const afterDisk = await this.sumFilesSizeBytes(files);
        await this.persistGlobalIndex();
        this.clearGlobalCache();
        this.refreshVersionHistoryView();
        this.debouncedUpdateStatusBar();
        return { purgedCount, savedBytes: Math.max(0, beforeDisk - afterDisk) };
    }

    async cleanupVersionsInMemory(versionFile: VersionFile): Promise<number> {
        const originalCount = versionFile.versions.length;
        const starred = versionFile.versions.filter(v => v.starred);
        let nonStarred = versionFile.versions.filter(v => !v.starred);

        if (this.settings.enableMaxVersions) {
            const max = Math.max(this.settings.maxVersions - starred.length, 1);
            nonStarred = nonStarred.slice(0, max);
        }

        if (this.settings.enableMaxDays) {
            const cutoff = Date.now() - (this.settings.maxDays * 24 * 60 * 60 * 1000);
            nonStarred = nonStarred.filter(v => v.timestamp >= cutoff);
        }

        const keepSet = new Set([...starred, ...nonStarred].map(v => v.id));
        const proposedList = versionFile.versions.filter(v => keepSet.has(v.id));

        for (let i = proposedList.length - 1; i >= 0; i--) {
            const v = proposedList[i]!;
            if (v.diff && v.baseVersionId && !keepSet.has(v.baseVersionId)) {
                try {
                    const full = this.resolveContentFromList(versionFile.versions, v.id);
                    v.content = full; 
                    v.diff = undefined; 
                    v.baseVersionId = undefined; 
                    v.size = full.length;
                } catch { return 0; }
            }
        }

        versionFile.versions = proposedList;
        this.clearGlobalCache(); 
        return originalCount - versionFile.versions.length;
    }

    async loadVersionFile(filePath: string): Promise<VersionFile> {
        const cached = this.versionCache.get(filePath);
        if (cached) return cached;

        const adapter = this.app.vault.adapter;
        const path = this.getVersionFilePath(filePath); 
        let finalVersionFile: VersionFile | null = null;

        if (await adapter.exists(path)) {
            try {
                const loaded = await this.readCompressedOrRaw(path);
                if (loaded) {
                    finalVersionFile = JSON.parse(loaded) as VersionFile;
                    if (finalVersionFile && Array.isArray(finalVersionFile.versions)) {
                        let isSorted = true;
                        for (let i = 1; i < finalVersionFile.versions.length; i++) {
                            if (finalVersionFile.versions[i]!.timestamp > finalVersionFile.versions[i - 1]!.timestamp) {
                                isSorted = false;
                                break;
                            }
                        }
                        if (!isSorted) finalVersionFile.versions.sort((a, b) => b.timestamp - a.timestamp);
                        this.repairVersionSizes(finalVersionFile);

                        if (this.isSnapshotMetaLoaded && finalVersionFile.versions.length > 0) {
                            const latestDisk = finalVersionFile.versions[0]!;
                            const existingMeta = this.snapshotMetaMap.get(filePath);
                            if (!existingMeta || existingMeta.latest?.id !== latestDisk.id || existingMeta.totalVersions !== finalVersionFile.versions.length) {
                                this.snapshotMetaMap.set(filePath, {
                                    latest: this.stripVersionData(latestDisk)!,
                                    prev: this.stripVersionData(finalVersionFile.versions[1]),
                                    totalVersions: finalVersionFile.versions.length
                                });
                                this.debouncedSaveGlobalIndex();
                                this.clearGlobalCache();
                            }
                        }
                    }
                }
            } catch (e) { console.error("无法解析版本文件:", e); }
        }

        if (!finalVersionFile) finalVersionFile = { filePath, versions: [], lastModified: Date.now() };
        if (!finalVersionFile.versionIndex) this.buildVersionIndex(finalVersionFile);
        this.versionCache.set(filePath, finalVersionFile);
        return finalVersionFile;
    }

    async readCompressedOrRaw(path: string): Promise<string> {
        const adapter = this.app.vault.adapter;
        try {
            const raw = await adapter.readBinary(path);
            const bytes = new Uint8Array(raw);
            if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
                return await this.decompressText(raw);
            }
            return this.textDecoder.decode(bytes);
        } catch {
            return "";
        }
    }

    async saveVersionFile(filePath: string, versionFile: VersionFile) {
        const path = this.getVersionFilePath(filePath);
        const adapter = this.app.vault.adapter;
        try {
            const parentDir = path.substring(0, path.lastIndexOf('/'));
            if (!(await adapter.exists(parentDir))) await adapter.mkdir(parentDir);

            versionFile.versions.sort((a, b) => b.timestamp - a.timestamp);

            const content = JSON.stringify({ 
                filePath: versionFile.filePath, 
                versions: versionFile.versions, 
                lastModified: versionFile.lastModified 
            });
            
            if (this.settings.enableCompression) {
                const compressed = await this.compressText(content);
                await this.safeWrite(adapter, path, compressed, true);
            } else { 
                await this.safeWrite(adapter, path, content, false); 
            }
        } catch (e) { console.error("保存版本文件失败:", e); }
    }

    async getAllVersions(filePath: string): Promise<VersionData[]> { 
        try { 
            const vf = await this.loadVersionFile(filePath); 
            return [...vf.versions]; 
        } catch { return []; } 
    }
    
    async getVersionContent(filePath: string, versionId: string, suppressNotice = false, strictMode = false): Promise<string> { 
        const cacheKey = `${filePath}::${versionId}`;
        const cached = this.contentCache.get(cacheKey);
        if (cached !== undefined) return cached;

        try { 
            const vf = await this.loadVersionFile(filePath); 
            let currentId = versionId;
            const patches: string[] = [];
            const chainIds: string[] = [];
            let baseContent = "";
            const visited = new Set<string>();

            while (true) {
                if (visited.has(currentId)) throw new Error("循环依赖");
                visited.add(currentId);

                // 回溯依赖链时复用中间缓存，把 O(K^2) 降为 O(K)
                const midCached = this.contentCache.get(`${filePath}::${currentId}`);
                if (midCached !== undefined) {
                    baseContent = midCached;
                    break;
                }

                const index = vf.versionIndex?.get(currentId);
                const version = index !== undefined ? vf.versions[index] : vf.versions.find(v => v.id === currentId);
                if (!version) throw new Error("版本不存在");

                if (version.content !== undefined && version.content !== null) { 
                    baseContent = this.normalizeText(version.content); 
                    this.contentCache.set(`${filePath}::${currentId}`, baseContent);
                    break; 
                }
                
                if (version.diff && version.baseVersionId) {
                    patches.push(version.diff);
                    chainIds.push(currentId);
                    currentId = version.baseVersionId;
                } else throw new Error("增量基准丢失");
            }

            let result = baseContent;
            for (let i = patches.length - 1; i >= 0; i--) {
                const applied = Diff.applyPatch(result, patches[i]!);
                if (applied === false) {
                    if (strictMode) throw new Error("补丁应用失败");
                    if (!suppressNotice) new Notice(`⚠️ 版本 ${versionId.substring(0,8)} 损坏`);
                    return result;
                }
                result = this.normalizeText(applied);
                this.contentCache.set(`${filePath}::${chainIds[i]}`, result);
            }
            this.contentCache.set(cacheKey, result);
            return result;
        } catch (error) { 
            throw new Error(`无法读取内容: ${getErrorMessage(error)}`); 
        } 
    }

    async getJSONFilesRecursively(folder: string): Promise<string[]> {
        const adapter = this.app.vault.adapter;
        if (!(await adapter.exists(folder))) return [];

        const result: string[] = [];
        const queue: string[] = [folder];
        const visited = new Set<string>();

        while (queue.length > 0) {
            const cur = queue.shift()!;
            if (visited.has(cur)) continue;
            visited.add(cur);

            try {
                const list = await adapter.list(cur);
                for (const f of list.files) {
                    if (f.endsWith('.json') && !f.endsWith('global-index.json')) {
                        result.push(f);
                    }
                }
                for (const p of list.folders) {
                    const baseName = p.split('/').pop() || '';
                    if (baseName !== '.' && baseName !== '..' && !visited.has(p)) {
                        queue.push(p);
                    }
                }
            } catch {}
        }
        return result;
    }

    private verifyVersionFileIntegrity(vf: VersionFile): string[] {
        const errs: string[] = [];
        if (!vf || !Array.isArray(vf.versions)) {
            return ['版本数据结构无效'];
        }
        if (vf.versions.length === 0) return errs;

        const childrenMap = new Map<string, VersionData[]>();
        const roots: VersionData[] = [];

        for (const v of vf.versions) {
            if (v.content !== undefined && v.content !== null) {
                roots.push(v);
            } else if (v.diff && v.baseVersionId) {
                let list = childrenMap.get(v.baseVersionId);
                if (!list) {
                    list = [];
                    childrenMap.set(v.baseVersionId, list);
                }
                list.push(v);
            } else {
                errs.push(`版本 ${v.id.substring(0, 8)}: 增量基准丢失`);
            }
        }

        const visited = new Set<string>();
        const queue: { version: VersionData; text: string }[] = [];

        for (const root of roots) {
            visited.add(root.id);
            const text = this.normalizeText(root.content!);
            if (hashString(text) !== root.hash) {
                errs.push(`版本 ${root.id.substring(0, 8)}: 哈希不匹配`);
            }
            queue.push({ version: root, text });
        }

        let head = 0;
        while (head < queue.length) {
            const { version, text } = queue[head++]!;
            const children = childrenMap.get(version.id);
            if (!children) continue;

            for (const child of children) {
                if (visited.has(child.id)) {
                    errs.push(`版本 ${child.id.substring(0, 8)}: 检测到循环依赖`);
                    continue;
                }
                visited.add(child.id);
                const applied = Diff.applyPatch(text, child.diff!);
                if (applied === false) {
                    errs.push(`版本 ${child.id.substring(0, 8)}: 还原失败 (补丁应用失败)`);
                    continue;
                }
                const childText = this.normalizeText(applied);
                if (hashString(childText) !== child.hash) {
                    errs.push(`版本 ${child.id.substring(0, 8)}: 哈希不匹配`);
                }
                queue.push({ version: child, text: childText });
            }
        }

        for (const v of vf.versions) {
            if (!visited.has(v.id) && ((v.content !== undefined && v.content !== null) || (v.diff && v.baseVersionId))) {
                errs.push(`版本 ${v.id.substring(0, 8)}: 依赖链断裂或存在孤立环`);
            }
        }

        return errs;
    }

    async checkAllVersionsIntegrity() { 
        const adapter = this.app.vault.adapter; 
        const folder = this.settings.versionFolder; 
        if (!await adapter.exists(folder)) return; 
        const files = await this.getJSONFilesRecursively(folder);
        const total = files.length; 
        const notice = new Notice(`检查完整性... 0/${total}`, 0); 
        const report: { filePath: string; errors: string[] }[] = []; 

        const chunkSize = 5;
        for (let i = 0; i < total; i += chunkSize) { 
            if (this.isUnloaded) break;
            const chunk = files.slice(i, i + chunkSize);
            await Promise.all(chunk.map(async (f) => {
                try { 
                    const raw = await this.readCompressedOrRaw(f);
                    if (raw) {
                        const vf = JSON.parse(raw) as VersionFile;
                        const errs = this.verifyVersionFileIntegrity(vf);
                        if (errs.length > 0) report.push({ filePath: vf.filePath || f, errors: errs });
                    }
                } catch { 
                    report.push({ filePath: f, errors: ['文件损坏无法读取'] }); 
                }
            }));
            const done = Math.min(i + chunkSize, total);
            notice.setMessage(`检查完整性... ${done}/${total}`);
            await this.yieldToMain();
        } 
        notice.hide(); 
        new IntegrityReportModal(this.app, report).open(); 
    }

    // 零内存分配：单次遍历同时统计行数、CJK 字数与英文单词数
    getTextStats(str: string): { lines: number; words: number; chars: number } {
        if (!str) return { lines: 0, words: 0, chars: 0 };
        const len = str.length;
        let lines = 1;
        let cjk = 0;
        let western = 0;
        let inWord = false;

        for (let i = 0; i < len; i++) {
            const c = str.charCodeAt(i);
            if (c === 10) {
                lines++;
                inWord = false;
            } else if (
                (c >= 0x4e00 && c <= 0x9fa5) ||
                (c >= 0x3040 && c <= 0x30ff) ||
                (c >= 0xac00 && c <= 0xd7af)
            ) {
                cjk++;
                inWord = false;
            } else if (
                (c >= 97 && c <= 122) ||
                (c >= 65 && c <= 90) ||
                (c >= 48 && c <= 57) ||
                c === 95
            ) {
                if (!inWord) {
                    inWord = true;
                    western++;
                }
            } else {
                inWord = false;
            }
        }

        return { lines, words: cjk + western, chars: len };
    }

    countWords(str: string): number {
        return this.getTextStats(str).words;
    }

    getRelativeTime(timestamp: number): string { 
        const now = Date.now();
        const diff = Math.max(0, now - timestamp);
        
        if (diff < 60000) return `${Math.floor(diff / 1000)}秒前`;
        if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
        if (diff < 172800000) return '昨天';
        if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;
        return moment(timestamp).format('MM-DD');
    }

    private getGlobalIndexPath(): string {
        return normalizePath(`${this.settings.versionFolder}/global-index.json`);
    }

    private async persistGlobalIndex() {
        if (!this.isSnapshotMetaLoaded) return;
        const adapter = this.app.vault.adapter;
        const indexPath = this.getGlobalIndexPath();
        try {
            const serialized: Record<string, SnapshotIndexEntry> = {};
            for (const [k, v] of this.snapshotMetaMap.entries()) {
                if (v && v.latest) serialized[k] = v;
            }
            const json = JSON.stringify(serialized);
            if (this.settings.enableCompression) {
                const compressed = await this.compressText(json);
                await this.safeWrite(adapter, indexPath, compressed, true);
            } else {
                await this.safeWrite(adapter, indexPath, json, false);
            }
        } catch {}
    }

    async rebuildGlobalIndex(): Promise<void> {
        const adapter = this.app.vault.adapter;
        const indexPath = this.getGlobalIndexPath();
        if (await adapter.exists(indexPath)) {
            try { await adapter.remove(indexPath); } catch {}
        }
        this.snapshotMetaMap.clear();
        this.versionCache.clear();
        this.isSnapshotMetaLoaded = false;
        this.clearGlobalCache();
        await this.loadOrBuildGlobalIndex();
        this.refreshVersionHistoryView();
    }

    async loadOrBuildGlobalIndex(): Promise<void> {
        if (this.isSnapshotMetaLoaded) return;
        if (this.loadingIndexPromise) return this.loadingIndexPromise;

        this.loadingIndexPromise = (async () => {
            const adapter = this.app.vault.adapter;
            const indexPath = this.getGlobalIndexPath();

            if (await adapter.exists(indexPath)) {
                try {
                    const text = await this.readCompressedOrRaw(indexPath);
                    if (text && text.trim().startsWith('{')) {
                        const obj = JSON.parse(text) as Record<string, any>;
                        this.snapshotMetaMap.clear();
                        let needsSlimMigration = false;
                        for (const [k, v] of Object.entries(obj)) {
                            if (v && v.latest) {
                                if (
                                    'content' in v.latest || 'diff' in v.latest || 'baseVersionId' in v.latest ||
                                    (v.prev && ('content' in v.prev || 'diff' in v.prev || 'baseVersionId' in v.prev))
                                ) {
                                    needsSlimMigration = true;
                                }
                                this.snapshotMetaMap.set(k, {
                                    latest: this.stripVersionData(v.latest)!,
                                    prev: this.stripVersionData(v.prev),
                                    totalVersions: v.totalVersions ?? 1
                                });
                            }
                        }
                        if (this.snapshotMetaMap.size > 0) {
                            this.isSnapshotMetaLoaded = true;
                            if (needsSlimMigration) {
                                this.debouncedSaveGlobalIndex();
                            }
                            return;
                        }
                    }
                } catch {}
            }

            const folder = this.settings.versionFolder;
            if (await adapter.exists(folder)) {
                const files = await this.getJSONFilesRecursively(folder);
                const chunkSize = 10;
                for (let i = 0; i < files.length; i += chunkSize) {
                    if (this.isUnloaded) return;
                    const chunk = files.slice(i, i + chunkSize);
                    await Promise.all(chunk.map(async (file) => {
                        try {
                            const raw = await this.readCompressedOrRaw(file);
                            if (!raw) return;
                            const vf = JSON.parse(raw) as VersionFile;
                            if (!vf || !Array.isArray(vf.versions) || vf.versions.length === 0 || !vf.filePath) return;

                            vf.versions.sort((a, b) => b.timestamp - a.timestamp);
                            const latest = vf.versions[0]!;
                            const prev = vf.versions[1];

                            if (latest.content !== undefined && latest.content !== null) {
                                latest.size = latest.content.length;
                            }
                            if (prev) {
                                if (prev.content !== undefined && prev.content !== null) {
                                    prev.size = prev.content.length;
                                } else if (prev.diff && latest.content !== undefined && latest.content !== null) {
                                    try {
                                        const restored = Diff.applyPatch(latest.content, prev.diff);
                                        if (restored !== false) prev.size = restored.length;
                                    } catch {}
                                }
                            }
                            this.snapshotMetaMap.set(vf.filePath, { 
                                latest: this.stripVersionData(latest)!, 
                                prev: this.stripVersionData(prev), 
                                totalVersions: vf.versions.length 
                            });
                        } catch {}
                    }));
                    await this.yieldToMain();
                }
                this.isSnapshotMetaLoaded = true;
                this.persistGlobalIndex();
            } else {
                this.isSnapshotMetaLoaded = true;
            }
        })();

        try {
            await this.loadingIndexPromise;
        } finally {
            this.loadingIndexPromise = null;
        }
    }

    async getGlobalHistory(limit = 100, searchQuery = ''): Promise<GlobalHistoryItem[]> {
        const q = searchQuery.trim().toLowerCase();
        if (!q && this.globalHistoryCache) return this.globalHistoryCache.slice(0, limit);

        await this.loadOrBuildGlobalIndex();

        const allVaultFiles = this.app.vault.getMarkdownFiles();
        const seenPaths = new Set<string>();

        type Candidate = { file: TFile | null; filePath: string; latestTime: number; snaps?: SnapshotIndexEntry };
        const candidates: Candidate[] = [];

        for (let i = 0; i < allVaultFiles.length; i++) {
            const f = allVaultFiles[i]!;
            if (this.isExcluded(f.path)) continue;
            seenPaths.add(f.path);
            if (q && !f.path.toLowerCase().includes(q)) continue;
            const snaps = this.snapshotMetaMap.get(f.path);
            candidates.push({
                file: f,
                filePath: f.path,
                latestTime: f.stat?.mtime ?? (snaps?.latest?.timestamp ?? 0),
                snaps
            });
        }

        for (const [filePath, snaps] of this.snapshotMetaMap.entries()) {
            if (!seenPaths.has(filePath) && snaps?.latest) {
                if (q && !filePath.toLowerCase().includes(q)) continue;
                candidates.push({
                    file: null,
                    filePath: filePath,
                    latestTime: snaps.latest.timestamp ?? 0,
                    snaps
                });
            }
        }

        candidates.sort((a, b) => b.latestTime - a.latestTime);

        const topSlice = candidates.slice(0, limit);
        const entries: (GlobalHistoryItem | null)[] = new Array(topSlice.length).fill(null);

        const chunkSize = 10;
        for (let start = 0; start < topSlice.length; start += chunkSize) {
            const end = Math.min(start + chunkSize, topSlice.length);
            const tasks: Promise<void>[] = [];

            for (let idx = start; idx < end; idx++) {
                const item = topSlice[idx]!;
                tasks.push((async () => {
                    const file = item.file;
                    const snaps = item.snaps;
                    try {
                        if (file) {
                            if (snaps && snaps.latest) {
                                const latest = snaps.latest;
                                const prev = snaps.prev;
                                const snapshotChars = latest.size ?? 0;
                                const prevSnapshotChars = prev ? prev.size : undefined;

                                const maybeModified = (file.stat?.mtime ?? 0) > (latest.timestamp ?? 0);
                                let currentChars = snapshotChars;
                                let hasUnsaved = false;

                                if (maybeModified) {
                                    try {
                                        const rawCur = await this.app.vault.cachedRead(file);
                                        const normCur = this.normalizeText(rawCur);
                                        currentChars = normCur.length;
                                        hasUnsaved = latest.hash 
                                            ? (hashString(normCur) !== latest.hash) 
                                            : (currentChars !== snapshotChars);
                                    } catch {}
                                }

                                let charDiff = 0;
                                let diffMode: 'workspace' | 'snapshot' = 'snapshot';

                                if (hasUnsaved) {
                                    diffMode = 'workspace';
                                    charDiff = currentChars - snapshotChars;
                                } else {
                                    diffMode = 'snapshot';
                                    charDiff = prevSnapshotChars !== undefined ? (snapshotChars - prevSnapshotChars) : 0;
                                }

                                entries[idx] = {
                                    version: latest,
                                    prevVersion: prev,
                                    filePath: file.path,
                                    file: file,
                                    hasUnsavedChanges: hasUnsaved,
                                    isUnversioned: false,
                                    currentChars,
                                    snapshotChars,
                                    prevSnapshotChars,
                                    charDiff,
                                    diffMode,
                                    totalVersions: snaps.totalVersions ?? 1
                                };
                            } else {
                                entries[idx] = {
                                    version: {
                                        id: 'unversioned',
                                        timestamp: file.stat?.mtime ?? Date.now(),
                                        message: '未保存快照',
                                        size: file.stat?.size ?? 0,
                                        hash: ''
                                    },
                                    filePath: file.path,
                                    file: file,
                                    hasUnsavedChanges: true,
                                    isUnversioned: true,
                                    currentChars: file.stat?.size ?? 0,
                                    snapshotChars: 0,
                                    charDiff: file.stat?.size ?? 0,
                                    diffMode: 'unversioned',
                                    totalVersions: 0
                                };
                            }
                        } else if (snaps && snaps.latest) {
                            entries[idx] = {
                                version: snaps.latest,
                                prevVersion: snaps.prev,
                                filePath: item.filePath,
                                file: null,
                                hasUnsavedChanges: false,
                                isUnversioned: false,
                                currentChars: 0,
                                snapshotChars: snaps.latest.size ?? 0,
                                charDiff: 0,
                                diffMode: 'snapshot',
                                totalVersions: snaps.totalVersions ?? 1
                            };
                        }
                    } catch {}
                })());
            }

            await Promise.all(tasks);
            if (end < topSlice.length) await this.yieldToMain();
        }

        const result = entries.filter((x): x is GlobalHistoryItem => x !== null);
        if (!q && limit >= this.globalCacheLimit) this.globalHistoryCache = result;
        return result;
    }

    async toggleVersionStar(filePath: string, versionId: string) {
        await this.withLock(filePath, async () => {
            try {
                const vf = await this.loadVersionFile(filePath);
                const idx = vf.versionIndex?.get(versionId);
                if (idx !== undefined) {
                    vf.versions[idx]!.starred = !vf.versions[idx]!.starred;
                    await this.saveVersionFile(filePath, vf);
                    this.versionCache.set(filePath, vf);
                    if (idx === 0 || idx === 1) {
                        this.snapshotMetaMap.set(filePath, {
                            latest: this.stripVersionData(vf.versions[0]!)!,
                            prev: this.stripVersionData(vf.versions[1]),
                            totalVersions: vf.versions.length
                        });
                        this.debouncedSaveGlobalIndex();
                    }
                    this.clearGlobalCache(); 
                }
            } catch {}
        });
    }

    async restoreVersion(file: TFile, versionId: string) {
        this.isRestoring = true;
        try {
            await this.createVersion(file, '[Before Restore]', false);
            const content = await this.getVersionContent(file.path, versionId);
            await this.app.vault.modify(file, content);
            if (this.settings.showNotifications) new Notice('✅ 版本恢复成功');
            this.refreshVersionHistoryView();
        } catch { 
            new Notice('❌ 恢复版本失败'); 
        } finally { 
            setTimeout(() => { this.isRestoring = false; }, 500); 
        }
    }

    formatFileSize(bytes: number): string { 
        if (bytes < 1024) return `${bytes} B`; 
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; 
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`; 
    }

    formatTime(timestamp: number): string { 
        return moment(timestamp).format('YYYY-MM-DD HH:mm:ss'); 
    }

    formatCompactTime(timestamp: number): string {
        return moment(timestamp).format('MM-DD HH:mm');
    }

    refreshVersionHistoryView() { 
        this.debouncedRefreshViews();
    }

    private performRefreshViews() {
        if (this.isUnloaded) return;
        const leaves = this.app.workspace.getLeavesOfType('version-history'); 
        leaves.forEach(leaf => { 
            if (leaf.view instanceof VersionHistoryView) leaf.view.refreshSmart(); 
        }); 
    }
}
