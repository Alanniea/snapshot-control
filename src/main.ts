
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

export interface VersionFile {
    filePath: string;
    versions: VersionData[];
    lastModified: number;
    versionIndex?: Map<string, number>;
}

export interface GlobalHistoryItem {
    version: VersionData;
    prevVersion?: VersionData;
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

// =======================================================================
// ==================== 主插件类 (VersionControlPlugin) ===================
// =======================================================================
export default class VersionControlPlugin extends Plugin {
    settings: VersionControlSettings;
    debouncedSaves: Map<string, Function> = new Map();
    statusBarItem: HTMLElement;
    
    versionCache: SimpleLRU<string, VersionFile> = new SimpleLRU(50);
    contentCache: SimpleLRU<string, string> = new SimpleLRU(50); 
    globalHistoryCache: GlobalHistoryItem[] | null = null;
    
    snapshotMetaMap: Map<string, { latest: VersionData; prev?: VersionData; totalVersions: number }> = new Map();
    isSnapshotMetaLoaded = false;
    
    activeFileLastSaveTime: number | null = null;
    activeFileSaveLabel = '';
    fileLocks: Map<string, Promise<void>> = new Map();
    isRestoring = false; 
    isUnloaded = false;

    debouncedUpdateStatusBar: () => void;
    private lastRenderedStatusText = '';

    async onload() {
        this.isUnloaded = false;
        await this.loadSettings();

        this.statusBarItem = this.addStatusBarItem();
        this.debouncedUpdateStatusBar = debounce(() => this.updateStatusBar(), 300, true);
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
            this.app.vault.on('modify', async (file) => {
                if (this.isRestoring) return;
                if (file instanceof TFile && !this.isExcluded(file.path)) {
                    if (this.settings.autoSave) {
                        this.handleFileModify(file);
                    }
                    await this.updateGlobalCacheOnModify(file);
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
        await this.cleanupTempFiles();

        // 🌟 降频为 30 秒执行一次时间刷新，彻底消除滑动中的每秒 Layout 重排掉帧
        this.registerInterval(
            window.setInterval(() => { 
                this.renderStatusBarTime();
                const leaves = this.app.workspace.getLeavesOfType('version-history');
                leaves.forEach(leaf => { 
                    if (leaf.view instanceof VersionHistoryView) leaf.view.updateRelativeTimes(); 
                });
            }, 30000) as unknown as number
        );
    }

    onunload() {
        this.isUnloaded = true;
        this.debouncedSaves.clear();
        this.versionCache.clear();
        this.contentCache.clear();
        this.globalHistoryCache = null;
        this.snapshotMetaMap.clear();
        this.isSnapshotMetaLoaded = false;
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
        try {
            if (await adapter.exists(folder)) {
                const list = await adapter.list(folder);
                for (const f of list.files) {
                    if (f.endsWith('.tmp')) { try { await adapter.remove(f); } catch {} }
                }
            }
        } catch {}
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
        return text ? text.replace(/\r\n?/g, "\n") : ""; 
    }

    async handleFolderRename(folder: TFolder, oldFolderPath: string) {
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            if (file.path.startsWith(folder.path + '/')) {
                const rel = file.path.substring(folder.path.length);
                await this.handleRename(file, oldFolderPath + rel);
            }
        }
    }

    async handleRename(file: TFile, oldPath: string) {
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

                    const meta = this.snapshotMetaMap.get(oldPath);
                    if (meta) {
                        this.snapshotMetaMap.delete(oldPath);
                        this.snapshotMetaMap.set(file.path, meta);
                    }

                    this.clearGlobalCache();
                    this.refreshVersionHistoryView();
                } catch (e) { console.error("Rename Error", e); }
            }
        });
        const oldDebouncer = this.debouncedSaves.get(oldPath);
        if (oldDebouncer) { this.debouncedSaves.delete(oldPath); this.handleFileModify(file); }
    }

    async handleDelete(filePath: string) {
        if (!this.settings.deleteHistoryOnDelete) return;
        await this.withLock(filePath, async () => {
            const adapter = this.app.vault.adapter;
            const versionPath = this.getVersionFilePath(filePath);
            if (await adapter.exists(versionPath)) {
                await adapter.remove(versionPath);
                this.versionCache.delete(filePath);
                this.contentCache.deletePrefix(filePath + "::");
                this.debouncedSaves.delete(filePath);
                this.snapshotMetaMap.delete(filePath);
                this.clearGlobalCache();
                this.refreshVersionHistoryView();
            }
        });
    }

    async loadSettings() { 
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); 
    }

    async saveSettings() { 
        await this.saveData(this.settings); 
        this.debouncedSaves.clear();
        this.debouncedUpdateStatusBar(); 
    }

    getSaveTypeLabel(message: string): string { 
        if (message.includes('[Auto Save]')) return '自动保存';
        if (message.includes('[Before Restore]')) return '恢复前备份';
        return '手动快照';
    }

    async updateStatusBar() {
        if (!this.settings.autoSave) { 
            this.statusBarItem.setText('⏸ 历史暂停'); 
            this.activeFileLastSaveTime = null;
            return; 
        }
        const file = this.app.workspace.getActiveFile();
        if (!this.settings.enableStatusBarDiff || !file) { 
            this.statusBarItem.setText(''); 
            this.activeFileLastSaveTime = null;
            return; 
        }
        
        const versions = await this.getAllVersions(file.path);
        if (versions.length > 0) {
            const last = versions[0]!;
            this.activeFileLastSaveTime = last.timestamp;
            this.activeFileSaveLabel = this.getSaveTypeLabel(last.message);
            this.renderStatusBarTime();
        } else {
            this.activeFileLastSaveTime = null;
            this.statusBarItem.setText('');
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
        this.statusBarItem.title = `${this.activeFileSaveLabel}于 ${new Date(this.activeFileLastSaveTime).toLocaleString('zh-CN')}。点击对比差异。`;
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
                await this.createVersion(f, '[Auto Save]', false); 
            }, delayMinutes * 60 * 1000, true);
            this.debouncedSaves.set(file.path, debouncer);
        }
        debouncer(file);
    }
    
    isExcluded(filePath: string): boolean { 
        return this.settings.excludedFolders.some(folder => filePath.startsWith(folder)); 
    }

    async createManualVersion() {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice('没有打开的文件'); return; }
        const debouncer = this.debouncedSaves.get(file.path);
        if (debouncer) this.debouncedSaves.delete(file.path);
        await this.createVersion(file, '[Manual Save]', false, [], true);
    }

    async createVersion(file: TFile, message: string, showNotification = false, tags: string[] = [], isManual = false) {
        await this.withLock(file.path, async () => {
             const raw = await this.app.vault.read(file);
             const content = this.normalizeText(raw);
             await this.createVersionInternal(file, message, showNotification, tags, isManual, content);
        });
    }

    private async createVersionInternal(file: TFile, message: string, showNotification: boolean, tags: string[], isManual: boolean, content: string) {
        try {
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
                            latest,
                            prev: versionFile.versions[1],
                            totalVersions: versionFile.versions.length
                        });
                        this.clearGlobalCache(); 
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
                latest: newVersion,
                prev: versionFile.versions[1],
                totalVersions: versionFile.versions.length
            });

            this.clearGlobalCache(); 
            this.refreshVersionHistoryView();
            this.debouncedUpdateStatusBar();
        } catch (error) {
            console.error('保存版本失败:', getErrorMessage(error));
            if (showNotification) new Notice('❌ 保存版本失败');
        }
    }

    async updateGlobalCacheOnModify(file: TFile) {
        if (!this.globalHistoryCache) return;
        let currentChars = file.stat.size;
        try {
            const text = await this.app.vault.cachedRead(file);
            currentChars = text.length;
        } catch {}

        const idx = this.globalHistoryCache.findIndex(item => item.filePath === file.path);
        if (idx !== -1) {
            const item = this.globalHistoryCache[idx]!;
            const snapshotChars = item.snapshotChars ?? item.version.size ?? 0;
            const workspaceDiff = currentChars - snapshotChars;

            item.hasUnsavedChanges = true;
            item.diffMode = 'workspace';
            item.currentChars = currentChars;
            item.charDiff = workspaceDiff;

            if (idx > 0) {
                this.globalHistoryCache.splice(idx, 1);
                this.globalHistoryCache.unshift(item);
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

        let currentKnownText = vf.versions[0]?.content ?? null;
        if (currentKnownText) {
            vf.versions[0]!.size = currentKnownText.length;
        }

        for (let i = 1; i < vf.versions.length; i++) {
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
        let success = false;
        await this.withLock(filePath, async () => {
            try {
                const vf = await this.loadVersionFile(filePath);
                const targetIdx = vf.versions.findIndex(v => v.id === versionId);
                if (targetIdx === -1) return;

                const dependent = vf.versions.find(v => v.baseVersionId === versionId);
                if (dependent) {
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
                await this.saveVersionFile(filePath, vf);

                this.versionCache.set(filePath, vf);
                this.contentCache.delete(`${filePath}::${versionId}`);

                if (vf.versions.length > 0) {
                    this.snapshotMetaMap.set(filePath, {
                        latest: vf.versions[0]!,
                        prev: vf.versions[1],
                        totalVersions: vf.versions.length
                    });
                } else {
                    this.snapshotMetaMap.delete(filePath);
                }

                this.clearGlobalCache();
                success = true;
                new Notice('🗑️ 快照已彻底删除');
            } catch (e) {
                console.error(e);
            }
        });
        return success;
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
            for (const file of files) {
                try {
                    const stat = await adapter.stat(file);
                    if (stat) actualDiskBytes += stat.size;
                    const raw = await this.readCompressedOrRaw(file);
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
            }
        }

        const savedPercent = rawEquivalentBytes > 0 
            ? Math.max(0, Math.round((1 - (actualDiskBytes / rawEquivalentBytes)) * 100))
            : 0;

        return { totalFiles, totalSnapshots, actualDiskBytes, rawEquivalentBytes, savedPercent };
    }

    async performStoragePurge(keepDays = 30, minKeepPerFile = 5): Promise<{ purgedCount: number; savedBytes: number }> {
        const folder = this.settings.versionFolder;
        const adapter = this.app.vault.adapter;
        let purgedCount = 0;
        const beforeDisk = (await this.getStorageStats()).actualDiskBytes;

        if (await adapter.exists(folder)) {
            const files = await this.getJSONFilesRecursively(folder);
            const cutoff = Date.now() - (keepDays * 24 * 60 * 60 * 1000);

            for (const file of files) {
                try {
                    const raw = await this.readCompressedOrRaw(file);
                    if (!raw) continue;
                    const vf = JSON.parse(raw) as VersionFile;
                    if (!vf || !Array.isArray(vf.versions)) continue;

                    const originalTotal = vf.versions.length;
                    const starred = vf.versions.filter(v => v.starred);
                    const nonStarred = vf.versions.filter(v => !v.starred);

                    const keepNonStarred = nonStarred.filter((v, idx) => idx < minKeepPerFile || v.timestamp >= cutoff);
                    const keepIds = new Set([...starred, ...keepNonStarred].map(v => v.id));

                    if (keepIds.size < originalTotal) {
                        const proposed = vf.versions.filter(v => keepIds.has(v.id));
                        for (let i = proposed.length - 1; i >= 0; i--) {
                            const v = proposed[i]!;
                            if (v.diff && v.baseVersionId && !keepIds.has(v.baseVersionId)) {
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
                        purgedCount += (originalTotal - vf.versions.length);
                    }
                } catch {}
            }
        }

        const afterDisk = (await this.getStorageStats()).actualDiskBytes;
        this.clearGlobalCache();
        this.snapshotMetaMap.clear();
        this.isSnapshotMetaLoaded = false;
        this.refreshVersionHistoryView();

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
                        finalVersionFile.versions.sort((a, b) => b.timestamp - a.timestamp);
                        this.repairVersionSizes(finalVersionFile);
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
        if (!await adapter.exists(path)) return "";
        
        try {
            const text = await adapter.read(path);
            if (text && (text.trim().startsWith('{') || text.includes('"versions"'))) {
                return text;
            }
        } catch {}

        try {
            const raw = await adapter.readBinary(path);
            return await this.decompressText(raw);
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
            return vf.versions.sort((a, b) => b.timestamp - a.timestamp); 
        } catch { return []; } 
    }
    
    async getVersionContent(filePath: string, versionId: string, suppressNotice = false, strictMode = false): Promise<string> { 
        const cacheKey = `${filePath}::${versionId}`;
        const cached = this.contentCache.get(cacheKey);
        if (cached) return cached;

        try { 
            const vf = await this.loadVersionFile(filePath); 
            let currentId = versionId;
            const patches: string[] = [];
            let baseContent = "";
            const visited = new Set<string>();

            while (true) {
                if (visited.has(currentId)) throw new Error("循环依赖");
                visited.add(currentId);

                const index = vf.versionIndex?.get(currentId);
                const version = index !== undefined ? vf.versions[index] : vf.versions.find(v => v.id === currentId);
                if (!version) throw new Error("版本不存在");

                if (version.content !== undefined && version.content !== null) { 
                    baseContent = this.normalizeText(version.content); 
                    break; 
                }
                
                if (version.diff && version.baseVersionId) {
                    patches.push(version.diff);
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
            }
            this.contentCache.set(cacheKey, result);
            return result;
        } catch (error) { 
            throw new Error(`无法读取内容: ${getErrorMessage(error)}`); 
        } 
    }

    async getJSONFilesRecursively(folder: string): Promise<string[]> {
        const adapter = this.app.vault.adapter;
        const result: string[] = [];
        const queue: string[] = [folder];
        while (queue.length > 0) {
            const cur = queue.shift()!;
            if (!(await adapter.exists(cur))) continue;
            const list = await adapter.list(cur);
            for (const f of list.files) {
                if (f.endsWith('.json') && !f.endsWith('global-index.json')) result.push(f);
            }
            for (const p of list.folders) queue.push(p);
        }
        return result;
    }

    async checkAllVersionsIntegrity() { 
        const adapter = this.app.vault.adapter; 
        const folder = this.settings.versionFolder; 
        if (!await adapter.exists(folder)) return; 
        const files = await this.getJSONFilesRecursively(folder);
        const total = files.length; 
        const notice = new Notice(`检查完整性... 0/${total}`, 0); 
        const report: { filePath: string; errors: string[] }[] = []; 

        for (let i = 0; i < total; i++) { 
            const f = files[i]!; 
            try { 
                const raw = await this.readCompressedOrRaw(f);
                if (raw) {
                    const vf = JSON.parse(raw) as VersionFile;
                    const errs: string[] = [];
                    for (const v of vf.versions) {
                        try {
                            const c = await this.getVersionContent(vf.filePath, v.id, true, true);
                            if (hashString(c) !== v.hash) {
                                errs.push(`版本 ${v.id.substring(0,8)}: 哈希不匹配`);
                            }
                        } catch (err) {
                            errs.push(`版本 ${v.id.substring(0,8)}: 还原失败 (${getErrorMessage(err)})`);
                        }
                    }
                    if (errs.length > 0) report.push({ filePath: vf.filePath, errors: errs });
                }
            } catch { report.push({ filePath: f, errors: ['文件损坏无法读取'] }); }
            if (i % 5 === 0) notice.setMessage(`检查完整性... ${i + 1}/${total}`);
            await this.yieldToMain();
        } 
        notice.hide(); 
        new IntegrityReportModal(this.app, report).open(); 
    }

    countWords(str: string): number {
        if (!str) return 0;
        const cjk = (str.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
        const western = (str.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[a-zA-Z0-9_]+/g) || []).length;
        return cjk + western;
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

    async getGlobalHistory(limit = 100): Promise<GlobalHistoryItem[]> {
        if (this.globalHistoryCache) return this.globalHistoryCache.slice(0, limit);

        const folder = this.settings.versionFolder;
        const adapter = this.app.vault.adapter;

        if (!this.isSnapshotMetaLoaded && await adapter.exists(folder)) {
            const files = await this.getJSONFilesRecursively(folder);
            
            const chunkSize = 10;
            for (let i = 0; i < files.length; i += chunkSize) {
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

                        if (latest.content) latest.size = latest.content.length;
                        if (prev) {
                            if (prev.content) {
                                prev.size = prev.content.length;
                            } else if (prev.diff && latest.content) {
                                try {
                                    const restored = Diff.applyPatch(latest.content, prev.diff);
                                    if (restored !== false) prev.size = restored.length;
                                } catch {}
                            }
                        }
                        this.snapshotMetaMap.set(vf.filePath, { 
                            latest, 
                            prev, 
                            totalVersions: vf.versions.length 
                        });
                    } catch {}
                }));
                await this.yieldToMain();
            }
            this.isSnapshotMetaLoaded = true;
        }

        const entries: GlobalHistoryItem[] = [];
        const seenPaths = new Set<string>();
        const allVaultFiles = this.app.vault.getMarkdownFiles().filter(f => !this.isExcluded(f.path));

        for (let i = 0; i < allVaultFiles.length; i++) {
            const file = allVaultFiles[i]!;
            seenPaths.add(file.path);
            const snaps = this.snapshotMetaMap.get(file.path);

            if (snaps) {
                const latest = snaps.latest;
                const prev = snaps.prev;
                const snapshotChars = latest.size;
                const prevSnapshotChars = prev ? prev.size : undefined;

                const isModified = file.stat.mtime > (latest.timestamp + 2000);
                let currentChars = snapshotChars;
                let hasUnsaved = isModified;

                if (isModified) {
                    try {
                        const curText = await this.app.vault.cachedRead(file);
                        currentChars = curText.length;
                        hasUnsaved = (currentChars !== snapshotChars);
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

                entries.push({
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
                    totalVersions: snaps.totalVersions
                });
            } else {
                entries.push({
                    version: {
                        id: 'unversioned',
                        timestamp: file.stat.mtime,
                        message: '未保存快照',
                        size: file.stat.size,
                        hash: ''
                    },
                    filePath: file.path,
                    file: file,
                    hasUnsavedChanges: true,
                    isUnversioned: true,
                    currentChars: file.stat.size,
                    snapshotChars: 0,
                    charDiff: file.stat.size,
                    diffMode: 'unversioned',
                    totalVersions: 0
                });
            }
        }

        for (const [filePath, snaps] of this.snapshotMetaMap.entries()) {
            if (!seenPaths.has(filePath)) {
                entries.push({
                    version: snaps.latest,
                    prevVersion: snaps.prev,
                    filePath: filePath,
                    file: null,
                    hasUnsavedChanges: false,
                    isUnversioned: false,
                    currentChars: 0,
                    snapshotChars: snaps.latest.size,
                    charDiff: 0,
                    diffMode: 'snapshot',
                    totalVersions: snaps.totalVersions
                });
            }
        }

        entries.sort((a, b) => {
            const timeA = a.file ? a.file.stat.mtime : a.version.timestamp;
            const timeB = b.file ? b.file.stat.mtime : b.version.timestamp;
            return timeB - timeA;
        });

        this.globalHistoryCache = entries;
        return entries.slice(0, limit);
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

    refreshVersionHistoryView() { 
        const leaves = this.app.workspace.getLeavesOfType('version-history'); 
        leaves.forEach(leaf => { 
            if (leaf.view instanceof VersionHistoryView) leaf.view.refresh(); 
        }); 
    }
}