import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, Modal, ItemView, WorkspaceLeaf, Menu, MarkdownRenderer, TFolder, setIcon, moment, normalizePath, debounce, DataAdapter } from 'obsidian';
import * as Diff from 'diff';

// --- 工具函数：安全提取错误信息 ---
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
    return 'Unknown error occurred';
}

// --- 高效哈希算法 (cyrb53) ---
function cyrb53(str: string, seed = 0): number {
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

function hashString(str: string): string {
    return cyrb53(str).toString(36);
}

// --- 纯净轻量级 LRU 缓存 ---
class SimpleLRU<K, V> {
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
interface VersionData {
    id: string;
    timestamp: number;
    message: string;
    content?: string;     
    diff?: string;        
    baseVersionId?: string; 
    size: number;
    hash: string;
    tags?: string[];
    note?: string;
    starred?: boolean;
}

interface VersionFile {
    filePath: string;
    versions: VersionData[];
    lastModified: number;
    versionIndex?: Map<string, number>;
}

export interface GlobalHistoryItem {
    version: VersionData;
    filePath: string;
    file: TFile | null;
    hasUnsavedChanges?: boolean;
    isUnversioned?: boolean;
}

interface VersionControlSettings {
    versionFolder: string;
    autoSave: boolean;
    autoSaveDelayOnModify: number;
    autoClear: boolean;
    maxVersions: number;
    enableMaxVersions: boolean;
    maxDays: number;
    enableMaxDays: boolean;
    useRelativeTime: boolean;
    enableDeduplication: boolean;
    showNotifications: boolean;
    excludedFolders: string[];
    enableCompression: boolean;
    enableIncrementalStorage: boolean;
    versionsPerPage: number;
    rebuildBaseInterval: number;
    enableStatusBarDiff: boolean;
    deleteHistoryOnDelete: boolean; 
}

const DEFAULT_SETTINGS: VersionControlSettings = {
    versionFolder: '.versions',
    autoSave: true,
    autoSaveDelayOnModify: 180,
    autoClear: true,
    maxVersions: 50,
    enableMaxVersions: true,
    maxDays: 30,
    enableMaxDays: false,
    useRelativeTime: true,
    enableDeduplication: true,
    showNotifications: true,
    excludedFolders: [],
    enableCompression: true,
    enableIncrementalStorage: true,
    versionsPerPage: 20,
    rebuildBaseInterval: 10,
    enableStatusBarDiff: true,
    deleteHistoryOnDelete: false, 
};

type ViewMode = 'current' | 'global';

// =======================================================================
// ==================== 主插件类 (VersionControlPlugin) ===================
// =======================================================================
export default class VersionControlPlugin extends Plugin {
    settings: VersionControlSettings;
    lastModifiedTime: Map<string, number> = new Map();
    debouncedSaves: Map<string, Function> = new Map();
    statusBarItem: HTMLElement;
    
    versionCache: SimpleLRU<string, VersionFile> = new SimpleLRU(50);
    contentCache: SimpleLRU<string, string> = new SimpleLRU(50); 
    globalHistoryCache: GlobalHistoryItem[] | null = null;
    
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
                if (file instanceof TFile && !this.isExcluded(file.path) && this.settings.autoSave) {
                    this.handleFileModify(file);
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

        this.registerInterval(
            window.setInterval(() => { 
                this.renderStatusBarTime();
                const leaves = this.app.workspace.getLeavesOfType('version-history');
                leaves.forEach(leaf => { 
                    if (leaf.view instanceof VersionHistoryView) leaf.view.updateRelativeTimes(); 
                });
            }, 1000) as unknown as number
        );
    }

    onunload() {
        this.isUnloaded = true;
        this.debouncedSaves.clear();
        this.versionCache.clear();
        this.contentCache.clear();
        this.globalHistoryCache = null;
    }

    clearGlobalCache() { this.globalHistoryCache = null; }
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

    normalizeText(text: string): string { return (!text) ? "" : text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"); }

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
                    this.lastModifiedTime.delete(oldPath);
                    this.lastModifiedTime.set(file.path, versionFile.lastModified);

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
                this.lastModifiedTime.delete(filePath);
                this.debouncedSaves.delete(filePath);
                this.clearGlobalCache();
                this.refreshVersionHistoryView();
            }
        });
    }

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); this.debouncedUpdateStatusBar(); }

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
            this.lastModifiedTime.set(file.path, this.activeFileLastSaveTime);
            this.renderStatusBarTime();
        } else {
            this.lastModifiedTime.delete(file.path);
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
            debouncer = debounce(async (f: TFile) => { 
                if (this.isUnloaded) return;
                await this.createVersion(f, '[Auto Save]', false); 
            }, this.settings.autoSaveDelayOnModify * 1000, true);
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
        await this.createVersion(file, '[Manual Save]', true, [], true);
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
                        this.clearGlobalCache(); 
                        this.refreshVersionHistoryView();
                        this.debouncedUpdateStatusBar();
                        if (showNotification && this.settings.showNotifications) new Notice(`✨ 已将自动保存转换为手动快照`);
                        return;
                    }
                    if (showNotification && this.settings.showNotifications) new Notice('ℹ️ 内容无变动，跳过版本创建');
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
                        prev.size = patch.length;
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
            await this.yieldToMain(); 
            await this.saveVersionFile(file.path, versionFile);
            
            this.versionCache.set(file.path, versionFile);
            this.contentCache.set(`${file.path}::${newVersion.id}`, content);

            // 清理缓存触发全局无感实时同步
            this.clearGlobalCache(); 
            this.refreshVersionHistoryView();
            this.lastModifiedTime.set(file.path, timestamp);
            this.debouncedUpdateStatusBar();
            
            if (showNotification && this.settings.showNotifications) new Notice(`✨ 快照保存成功`);
        } catch (error) {
            console.error('保存版本失败:', getErrorMessage(error));
            if (showNotification) new Notice('❌ 保存版本失败');
        }
    }

    buildVersionIndex(versionFile: VersionFile) { 
        const index = new Map<string, number>(); 
        versionFile.versions.forEach((v, idx) => { index.set(v.id, idx); }); 
        versionFile.versionIndex = index; 
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
        if (this.versionCache.get(filePath)) return this.versionCache.get(filePath)!;

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
        new IntegrityReportModal(this.app, this, report).open(); 
    }

    countWords(str: string): number {
        if (!str) return 0;
        const cjk = (str.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
        const western = (str.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[a-zA-Z0-9_]+/g) || []).length;
        return cjk + western;
    }

    // --- 高性能动态相对时间计算 (逐秒精准递增) ---
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

    // --- 全库时间线：按真实最近修改时间倒序排列 ---
    async getGlobalHistory(limit = 100): Promise<GlobalHistoryItem[]> {
        if (this.globalHistoryCache) return this.globalHistoryCache.slice(0, limit);

        const folder = this.settings.versionFolder;
        const adapter = this.app.vault.adapter;

        const snapshotMap = new Map<string, VersionData>();
        if (await adapter.exists(folder)) {
            const files = await this.getJSONFilesRecursively(folder);
            for (const file of files) {
                try {
                    const raw = await this.readCompressedOrRaw(file);
                    if (!raw) continue;
                    const vf = JSON.parse(raw) as VersionFile;
                    if (!vf || !Array.isArray(vf.versions) || vf.versions.length === 0) continue;
                    if (!vf.filePath) continue;

                    vf.versions.sort((a, b) => b.timestamp - a.timestamp);
                    snapshotMap.set(vf.filePath, vf.versions[0]!);
                } catch {}
                await this.yieldToMain();
            }
        }

        const entries: GlobalHistoryItem[] = [];
        const seenPaths = new Set<string>();

        const allVaultFiles = this.app.vault.getMarkdownFiles().filter(f => !this.isExcluded(f.path));

        for (const file of allVaultFiles) {
            seenPaths.add(file.path);
            const latestSnapshot = snapshotMap.get(file.path);

            if (latestSnapshot) {
                const hasUnsaved = file.stat.mtime > (latestSnapshot.timestamp + 2000);
                entries.push({
                    version: latestSnapshot,
                    filePath: file.path,
                    file: file,
                    hasUnsavedChanges: hasUnsaved,
                    isUnversioned: false
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
                    isUnversioned: true
                });
            }
        }

        for (const [filePath, snap] of snapshotMap.entries()) {
            if (!seenPaths.has(filePath)) {
                entries.push({
                    version: snap,
                    filePath: filePath,
                    file: null,
                    hasUnsavedChanges: false,
                    isUnversioned: false
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

    async updateVersionTags(filePath: string, versionId: string, tags: string[]) {
        await this.withLock(filePath, async () => {
            try {
                const vf = await this.loadVersionFile(filePath);
                const idx = vf.versionIndex?.get(versionId);
                if (idx !== undefined) {
                    vf.versions[idx]!.tags = tags.length > 0 ? tags : undefined;
                    await this.saveVersionFile(filePath, vf);
                    this.versionCache.set(filePath, vf);
                    this.clearGlobalCache(); 
                    this.refreshVersionHistoryView();
                }
            } catch {}
        });
    }

    async updateVersionNote(filePath: string, versionId: string, note: string) {
        await this.withLock(filePath, async () => {
            try {
                const vf = await this.loadVersionFile(filePath);
                const idx = vf.versionIndex?.get(versionId);
                if (idx !== undefined) {
                    vf.versions[idx]!.note = note.trim() || undefined;
                    await this.saveVersionFile(filePath, vf);
                    this.versionCache.set(filePath, vf);
                    this.clearGlobalCache(); 
                    this.refreshVersionHistoryView();
                }
            } catch {}
        });
    }

    async toggleVersionStar(filePath: string, versionId: string) {
        await this.withLock(filePath, async () => {
            try {
                const vf = await this.loadVersionFile(filePath);
                const idx = vf.versionIndex?.get(versionId);
                if (idx !== undefined) {
                    const next = !vf.versions[idx]!.starred;
                    vf.versions[idx]!.starred = next;
                    await this.saveVersionFile(filePath, vf);
                    this.versionCache.set(filePath, vf);
                    this.clearGlobalCache(); 
                }
            } catch {}
        });
    }

    async deleteVersion(filePath: string, versionId: string) {
        await this.withLock(filePath, async () => {
            try {
                const vf = await this.loadVersionFile(filePath);
                if (vf.versions.some(v => v.baseVersionId === versionId)) { 
                    new Notice('❌ 无法删除此版本，它被后续增量版本所依赖'); 
                    return; 
                }
                vf.versions = vf.versions.filter(v => v.id !== versionId);
                vf.lastModified = Date.now();
                this.buildVersionIndex(vf);
                await this.saveVersionFile(filePath, vf);
                this.versionCache.set(filePath, vf);
                this.clearGlobalCache(); 
                this.refreshVersionHistoryView();
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

// =======================================================================
// ==================== 现代代码审查模态框 (字符级高亮+无删除线) ==========
// =======================================================================
class DiffModal extends Modal {
    plugin: VersionControlPlugin;
    file: TFile;
    versionId: string;
    secondVersionId: string;
    ignoreWhitespace = true;
    showLineNumbers = true;
    leftContent = '';
    rightContent = '';
    
    private diffElements: HTMLElement[] = [];
    private currentDiffIdx = 0;
    private totalDiffCount = 0;
    
    private metricsBar: HTMLElement;
    private textDiffContainer: HTMLElement;
    private allVersions: VersionData[] = [];
    private statsBadge: HTMLElement;
    private prevBtn: HTMLButtonElement;
    private nextBtn: HTMLButtonElement;

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

        this.allVersions = await this.plugin.getAllVersions(this.file.path);

        const header = contentEl.createEl('div', { cls: 'vc-diff-header' });
        const titleArea = header.createEl('div', { cls: 'vc-diff-title-area' });
        const iconSpan = titleArea.createEl('span', { cls: 'vc-diff-type-icon' });
        setIcon(iconSpan, 'git-commit');
        titleArea.createEl('span', { text: this.file.basename, cls: 'vc-diff-filename' });
        titleArea.createEl('span', { text: this.file.path, cls: 'vc-diff-filepath' });

        const selectorBar = contentEl.createEl('div', { cls: 'vc-diff-version-bar' });
        
        const leftBtn = selectorBar.createEl('button', { cls: 'vc-diff-version-capsule is-left-history' });
        this.updateChipText(leftBtn, this.versionId, '左侧历史');
        leftBtn.addEventListener('click', (e: MouseEvent) => this.showVersionMenu(e, 'left'));

        const swapBtn = selectorBar.createEl('button', { cls: 'vc-diff-swap-btn', attr: { 'aria-label': '调换两侧对比版本' } });
        setIcon(swapBtn, 'arrow-right-left');
        swapBtn.addEventListener('click', async () => {
            [this.versionId, this.secondVersionId] = [this.secondVersionId, this.versionId];
            await this.updateDiffView();
        });

        const rightBtn = selectorBar.createEl('button', { cls: 'vc-diff-version-capsule is-right-latest' });
        this.updateChipText(rightBtn, this.secondVersionId, '右侧最新');
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
            saveSnapshotBtn.disabled = true;
            saveSnapshotBtn.setText('保存中...');
            try {
                await this.plugin.createVersion(this.file, '[Manual Save]', true, [], true);
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

        const numToggle = togglesGroup.createEl('button', { 
            text: this.showLineNumbers ? '# 行号' : '# 无行号',
            cls: `vc-toggle-chip ${this.showLineNumbers ? 'is-active' : ''}`
        });
        numToggle.addEventListener('click', () => {
            this.showLineNumbers = !this.showLineNumbers;
            numToggle.setText(this.showLineNumbers ? '# 行号' : '# 无行号');
            numToggle.toggleClass('is-active', this.showLineNumbers);
            this.renderDiff();
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
        await this.updateDiffView();
    }

    updateChipText(btn: HTMLButtonElement, versionId: string, rolePrefix: string) {
        btn.empty();
        const iconSpan = btn.createEl('span', { cls: 'vc-capsule-icon' });
        if (versionId === 'current') {
            setIcon(iconSpan, 'file-edit');
            btn.createEl('span', { text: `${rolePrefix} · 当前工作区` });
        } else {
            setIcon(iconSpan, 'history');
            const v = this.allVersions.find(item => item.id === versionId);
            btn.createEl('span', { text: v ? `${rolePrefix} · ${this.plugin.formatTime(v.timestamp)}` : '历史快照' });
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

        const leftLines = this.leftContent ? this.leftContent.split('\n').length : 0;
        const rightLines = this.rightContent ? this.rightContent.split('\n').length : 0;
        const diffLines = rightLines - leftLines;

        const leftWords = this.plugin.countWords(this.leftContent);
        const rightWords = this.plugin.countWords(this.rightContent);
        const diffWords = rightWords - leftWords;

        const leftChars = this.leftContent.length;
        const rightChars = this.rightContent.length;
        const diffChars = rightChars - leftChars;

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
            dataWrap.createEl('span', { text: leftVal.toLocaleString(), cls: 'vc-metric-old', attr: { title: '历史快照' } });
            dataWrap.createEl('span', { text: '➔', cls: 'vc-metric-arrow' });
            dataWrap.createEl('span', { text: rightVal.toLocaleString(), cls: 'vc-metric-new', attr: { title: '当前工作区' } });
        };

        buildMetricItem('行数', 'rows', leftLines, rightLines, diffLines);
        buildMetricItem('词数', 'file-text', leftWords, rightWords, diffWords);
        buildMetricItem('字符数', 'type', leftChars, rightChars, diffChars);
    }

    async updateDiffView() {
        const chips = this.contentEl.querySelectorAll('.vc-diff-version-capsule') as NodeListOf<HTMLButtonElement>;
        if (chips[0]) this.updateChipText(chips[0], this.versionId, '左侧历史');
        if (chips[1]) this.updateChipText(chips[1], this.secondVersionId, '右侧最新');

        this.leftContent = this.versionId === 'current' 
            ? await this.app.vault.read(this.file) 
            : await this.plugin.getVersionContent(this.file.path, this.versionId);

        this.rightContent = this.secondVersionId === 'current' 
            ? await this.app.vault.read(this.file) 
            : await this.plugin.getVersionContent(this.file.path, this.secondVersionId);

        this.renderMetricsBar();
        this.renderDiff();
    }

    navigateDiff(step: number) {
        if (this.totalDiffCount === 0) return;
        this.currentDiffIdx = (this.currentDiffIdx + step + this.totalDiffCount) % this.totalDiffCount;
        
        this.diffElements.forEach(el => el.removeClass('is-active-diff-row'));
        const target = this.diffElements[this.currentDiffIdx];
        if (target) {
            target.addClass('is-active-diff-row');
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

    renderDiff() {
        this.textDiffContainer.empty();
        this.diffElements = [];
        this.currentDiffIdx = 0;

        if (this.leftContent === this.rightContent) {
            this.totalDiffCount = 0;
            this.updateNavStats();

            const emptyCard = this.textDiffContainer.createEl('div', { cls: 'vc-empty-hero' });
            const iconBox = emptyCard.createEl('div', { cls: 'vc-empty-hero-icon' });
            setIcon(iconBox, 'check-circle-2');
            
            emptyCard.createEl('h4', { text: '两处内容完全一致' });
            emptyCard.createEl('p', { text: '历史版本与当前工作区完全相同。' });

            const switchBtn = emptyCard.createEl('button', { text: '选择其他快照版本', cls: 'mod-cta' });
            switchBtn.addEventListener('click', (e: MouseEvent) => this.showVersionMenu(e, 'left'));
            return;
        }

        let oldLineNum = 1;
        let newLineNum = 1;

        const rawLineDiff = Diff.diffLines(this.leftContent, this.rightContent, { ignoreWhitespace: this.ignoreWhitespace });
        const frag = document.createDocumentFragment();

        for (let i = 0; i < rawLineDiff.length; i++) {
            const part = rawLineDiff[i]!;
            const nextPart = rawLineDiff[i + 1];

            // 智能识别修改行：使用 Diff.diffChars 精确到每一个字符 (彻底解决如 111 ➔ 11 误判为整词删除的问题)
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
                        // 🌟 核心升级：行内采用纯字符级（Char-level）高精度对比
                        const charDiff = Diff.diffChars(lLine, rLine);

                        const lineEl = document.createElement('div');
                        lineEl.className = 'vc-diff-line vc-diff-line-modified';

                        if (this.showLineNumbers) {
                            this.buildGutter(lineEl, curOld, curNew);
                        }

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
                    } else if (lLine !== undefined) {
                        frag.appendChild(this.buildLineDOM('-', lLine, 'removed', oldLineNum++, null));
                    } else if (rLine !== undefined) {
                        frag.appendChild(this.buildLineDOM('+', rLine, 'added', null, newLineNum++));
                    }
                }
                i++;
            } else if (part.added) {
                part.value.replace(/\n$/, '').split('\n').forEach((l: string) => {
                    frag.appendChild(this.buildLineDOM('+', l, 'added', null, newLineNum++));
                });
            } else if (part.removed) {
                part.value.replace(/\n$/, '').split('\n').forEach((l: string) => {
                    frag.appendChild(this.buildLineDOM('-', l, 'removed', oldLineNum++, null));
                });
            } else {
                part.value.replace(/\n$/, '').split('\n').forEach((l: string) => {
                    frag.appendChild(this.buildLineDOM(' ', l, 'context', oldLineNum++, newLineNum++));
                });
            }
        }

        this.textDiffContainer.appendChild(frag);
        this.totalDiffCount = this.diffElements.length;
        this.updateNavStats();
        
        if (this.totalDiffCount > 0) {
            setTimeout(() => this.navigateDiff(0), 100);
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

        if (this.showLineNumbers) {
            this.buildGutter(lineEl, oldNum, newNum);
        }

        lineEl.createEl('span', { cls: 'vc-diff-sign', text: marker });
        lineEl.createEl('span', { cls: 'vc-diff-code', text });
        if (type !== 'context') this.diffElements.push(lineEl);
        return lineEl;
    }

    onClose() { this.contentEl.empty(); }
}

// =======================================================================
// ================= 现代化时间轴视图 (精准逐秒跳动版) ====================
// =======================================================================
class VersionHistoryView extends ItemView {
    plugin: VersionControlPlugin;
    currentFile: TFile | null = null;
    searchQuery = '';
    globalSearchQuery = ''; 
    currentViewMode: ViewMode = 'current';

    private debouncedAutoRefresh: () => void;

    constructor(leaf: WorkspaceLeaf, plugin: VersionControlPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.debouncedAutoRefresh = debounce(() => {
            this.plugin.clearGlobalCache();
            this.refresh();
        }, 300, true);
    }

    getViewType(): string { return 'version-history'; }
    getDisplayText(): string { return '版本历史'; }
    getIcon(): string { return 'history'; }

    async onOpen() {
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                if (this.currentViewMode === 'current') {
                    const active = this.app.workspace.getActiveFile();
                    if (active && (!this.currentFile || this.currentFile.path !== active.path)) {
                        this.refresh();
                    } else if (!active && this.currentFile) {
                        this.currentFile = null; 
                        this.refresh();
                    }
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile && !this.plugin.isExcluded(file.path)) {
                    this.debouncedAutoRefresh();
                }
            })
        );
        this.registerEvent(this.app.vault.on('rename', () => this.debouncedAutoRefresh()));
        this.registerEvent(this.app.vault.on('delete', () => this.debouncedAutoRefresh()));

        await this.refresh();
    }

    updateRelativeTimes() {
        const timeEls = this.contentEl.querySelectorAll('.vc-rel-time');
        timeEls.forEach((el: Element) => {
            const tsStr = (el as HTMLElement).dataset.timestamp;
            if (tsStr) {
                const ts = parseInt(tsStr, 10);
                if (!isNaN(ts) && ts > 0) {
                    el.textContent = `(${this.plugin.getRelativeTime(ts)})`;
                }
            }
        });
    }

    async refresh() {
        const container = this.contentEl;
        container.empty();
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
                this.currentViewMode = tab.id; 
                this.plugin.clearGlobalCache();
                await this.refresh(); 
            });
        });

        const contentArea = buffer.createEl('div', { cls: 'vc-timeline-container' });
        if (this.currentViewMode === 'current') await this.renderCurrentFileHistory(contentArea);
        else await this.renderGlobalHistory(contentArea);
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
        
        const searchInput = searchBox.createEl('input', { type: 'text', placeholder: '过滤历史版本...' });
        searchInput.value = this.searchQuery;
        searchInput.addEventListener('input', (e: Event) => { 
            this.searchQuery = (e.target as HTMLInputElement).value; 
            this.refresh(); 
        });

        const snapBtn = actionHeader.createEl('button', { cls: 'vc-btn-record', attr: { 'aria-label': '立即保存快照' } });
        setIcon(snapBtn, 'bookmark-plus');
        snapBtn.createEl('span', { text: '保存快照' });
        snapBtn.addEventListener('click', () => this.plugin.createManualVersion());

        const versionFile = await this.plugin.loadVersionFile(file.path);
        let versions = versionFile.versions;
        if (versions.length === 0) { 
            const empty = container.createEl('div', { cls: 'vc-timeline-empty' });
            const icon = empty.createEl('div', { cls: 'vc-timeline-empty-icon' });
            setIcon(icon, 'history');
            empty.createEl('h4', { text: '尚无快照记录' });
            empty.createEl('p', { text: '编辑笔记或点击上方按钮打下第一个版本快照。' });
            return; 
        }

        if (this.searchQuery) {
            const q = this.searchQuery.toLowerCase();
            versions = versions.filter((v: VersionData) => v.message.toLowerCase().includes(q) || (v.tags && v.tags.some(t => t.toLowerCase().includes(q))));
        }

        const timeline = container.createEl('div', { cls: 'vc-linear-timeline' });

        versions.forEach((v: VersionData, index: number) => {
            const isManual = !v.message.includes('[Auto Save]');
            const item = timeline.createEl('div', { cls: `vc-timeline-entry ${v.starred ? 'is-starred' : ''}` });
            
            const rail = item.createEl('div', { cls: 'vc-timeline-rail' });
            rail.createEl('div', { cls: `vc-timeline-node ${isManual ? 'is-manual' : ''} ${v.starred ? 'is-star' : ''}` });
            if (index !== versions.length - 1) {
                rail.createEl('div', { cls: 'vc-timeline-line' });
            }

            const body = item.createEl('div', { cls: 'vc-timeline-card' });
            
            const top = body.createEl('div', { cls: 'vc-timeline-top' });
            const badgeGroup = top.createEl('div', { cls: 'vc-badge-group' });

            const typeBadge = badgeGroup.createEl('span', { 
                cls: `vc-tag-badge ${isManual ? 'badge-manual' : 'badge-auto'}` 
            });
            typeBadge.setText(this.plugin.getSaveTypeLabel(v.message));

            if (v.tags) {
                v.tags.forEach((t: string) => {
                    badgeGroup.createEl('span', { cls: 'vc-tag-custom', text: t });
                });
            }

            const timeWrap = top.createEl('div', { cls: 'vc-timeline-time-box' });
            timeWrap.createEl('span', { text: this.plugin.formatTime(v.timestamp), cls: 'vc-abs-time' });
            timeWrap.createEl('span', { 
                text: `(${this.plugin.getRelativeTime(v.timestamp)})`, 
                cls: 'vc-rel-time',
                attr: { 'data-timestamp': String(v.timestamp) } 
            });

            const actions = body.createEl('div', { cls: 'vc-timeline-actions' });
            
            const starBtn = actions.createEl('button', { 
                cls: `vc-timeline-icon-btn ${v.starred ? 'is-starred' : ''}`, 
                attr: { 'aria-label': v.starred ? '取消收藏' : '标记为重要' } 
            });
            setIcon(starBtn, 'star');
            starBtn.addEventListener('click', async (e: MouseEvent) => {
                e.stopPropagation();
                await this.plugin.toggleVersionStar(file.path, v.id);
                this.refresh();
            });

            const diffBtn = actions.createEl('button', { cls: 'vc-timeline-icon-btn', attr: { 'aria-label': '对比版本改动' } });
            setIcon(diffBtn, 'git-compare');
            diffBtn.addEventListener('click', () => new DiffModal(this.app, this.plugin, file, v.id).open());

            const restoreBtn = actions.createEl('button', { cls: 'vc-timeline-icon-btn', attr: { 'aria-label': '恢复至此版本' } });
            setIcon(restoreBtn, 'undo-2');
            restoreBtn.addEventListener('click', () => {
                new ConfirmModal(this.app, '确认回退版本', '将使用该快照覆盖当前内容（当前最新状态会自动打下备份）。', async () => {
                    await this.plugin.restoreVersion(file, v.id);
                }).open();
            });
        });
    }

    async renderGlobalHistory(container: HTMLElement) {
        const actionHeader = container.createEl('div', { cls: 'vc-timeline-search-bar' });
        const searchBox = actionHeader.createEl('div', { cls: 'vc-search-capsule' });
        const searchIcon = searchBox.createEl('span', { cls: 'vc-search-icon' });
        setIcon(searchIcon, 'search');

        const searchInput = searchBox.createEl('input', { type: 'text', placeholder: '搜索笔记或路径...' });
        searchInput.value = this.globalSearchQuery;
        searchInput.addEventListener('input', (e: Event) => {
            this.globalSearchQuery = (e.target as HTMLInputElement).value;
            this.refresh();
        });

        let history: GlobalHistoryItem[] = await this.plugin.getGlobalHistory(100);
        if (this.globalSearchQuery) {
            const q = this.globalSearchQuery.toLowerCase();
            history = history.filter((item: GlobalHistoryItem) => item.filePath.toLowerCase().includes(q));
        }

        const timeline = container.createEl('div', { cls: 'vc-linear-timeline' });

        history.forEach(({ version, filePath, file, hasUnsavedChanges, isUnversioned }: GlobalHistoryItem, index: number) => {
            const item = timeline.createEl('div', { cls: `vc-timeline-entry ${hasUnsavedChanges ? 'is-modified-active' : ''}` });
            
            const rail = item.createEl('div', { cls: 'vc-timeline-rail' });
            rail.createEl('div', { cls: `vc-timeline-node ${isUnversioned ? 'is-unversioned' : (hasUnsavedChanges ? 'is-unsaved' : '')}` });
            if (index !== history.length - 1) rail.createEl('div', { cls: 'vc-timeline-line' });

            const body = item.createEl('div', { cls: 'vc-timeline-card' });
            
            const top = body.createEl('div', { cls: 'vc-timeline-top' });
            
            const titleRow = top.createEl('div', { cls: 'vc-timeline-title-row' });
            const link = titleRow.createEl('a', { text: filePath, cls: 'vc-timeline-link' });
            link.addEventListener('click', () => { if (file) this.app.workspace.getLeaf(false).openFile(file); });

            if (isUnversioned) {
                titleRow.createEl('span', { text: '● 待生成快照', cls: 'vc-status-pill is-unversioned' });
            } else if (hasUnsavedChanges) {
                titleRow.createEl('span', { text: '● 有新改动', cls: 'vc-status-pill is-unsaved' });
            }

            const timeCol = top.createEl('div', { cls: 'vc-global-time-col' });

            if (file && file.stat && file.stat.mtime) {
                const mtime = file.stat.mtime;
                const mtimeRow = timeCol.createEl('div', { cls: 'vc-meta-time-row' });
                const label = mtimeRow.createEl('span', { cls: `vc-meta-badge is-mtime ${hasUnsavedChanges ? 'is-highlight' : ''}` });
                const icon = label.createEl('span', { cls: 'vc-badge-icon' });
                setIcon(icon, 'pen-line');
                label.createEl('span', { text: '编辑' });

                mtimeRow.createEl('span', { text: this.plugin.formatTime(mtime), cls: 'vc-meta-time-abs' });
                mtimeRow.createEl('span', { 
                    text: `(${this.plugin.getRelativeTime(mtime)})`, 
                    cls: 'vc-rel-time',
                    attr: { 'data-timestamp': String(mtime) } 
                });
            }

            const snapRow = timeCol.createEl('div', { cls: 'vc-meta-time-row' });
            const snapLabel = snapRow.createEl('span', { cls: 'vc-meta-badge is-snap' });
            const snapIcon = snapLabel.createEl('span', { cls: 'vc-badge-icon' });
            setIcon(snapIcon, 'bookmark');
            snapLabel.createEl('span', { text: '快照' });

            if (isUnversioned) {
                snapRow.createEl('span', { text: '尚未保存快照', cls: 'vc-meta-time-abs is-empty-text' });
            } else {
                snapRow.createEl('span', { text: this.plugin.formatTime(version.timestamp), cls: 'vc-meta-time-abs' });
                snapRow.createEl('span', { 
                    text: `(${this.plugin.getRelativeTime(version.timestamp)})`, 
                    cls: 'vc-rel-time',
                    attr: { 'data-timestamp': String(version.timestamp) } 
                });
            }

            const actions = body.createEl('div', { cls: 'vc-timeline-actions' });

            if (file) {
                if (isUnversioned) {
                    const saveBtn = actions.createEl('button', { cls: 'vc-timeline-icon-btn is-accent', attr: { 'aria-label': '为此笔记保存首份快照' } });
                    setIcon(saveBtn, 'bookmark-plus');
                    saveBtn.addEventListener('click', async () => {
                        await this.plugin.createVersion(file, '[Manual Save]', true, [], true);
                        this.refresh();
                    });
                } else {
                    const diffBtn = actions.createEl('button', { cls: 'vc-timeline-icon-btn', attr: { 'aria-label': '对比版本' } });
                    setIcon(diffBtn, 'git-compare');
                    diffBtn.addEventListener('click', () => new DiffModal(this.app, this.plugin, file, version.id).open());
                }
            }
        });
    }
}

// =======================================================================
// ============================= 辅助模态框 ==============================
// =======================================================================
class ConfirmModal extends Modal {
    constructor(app: App, private title: string, private message: string, private onConfirm: () => void) { super(app); }
    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('vc-confirm-dialog');
        contentEl.createEl('h3', { text: this.title });
        contentEl.createEl('p', { text: this.message });
        const box = contentEl.createEl('div', { cls: 'vc-dialog-actions' });
        const cancel = box.createEl('button', { text: '放弃' });
        cancel.addEventListener('click', () => this.close());
        const ok = box.createEl('button', { text: '确认覆盖', cls: 'mod-warning' });
        ok.addEventListener('click', () => { this.close(); this.onConfirm(); });
    }
    onClose() { this.contentEl.empty(); }
}

class IntegrityReportModal extends Modal {
    constructor(app: App, private plugin: VersionControlPlugin, private report: { filePath: string; errors: string[] }[]) { super(app); }
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
class VersionControlSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: VersionControlPlugin) { super(app, plugin); }
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('vc-settings-tab');
        
        containerEl.createEl('h2', { text: '版本控制设置' });

        new Setting(containerEl)
            .setName('修改自动保存')
            .setDesc('停止输入后自动生成版本历史快照')
            .addToggle(t => t.setValue(this.plugin.settings.autoSave).onChange(async (v: boolean) => {
                this.plugin.settings.autoSave = v;
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName('保存延迟时间')
            .setDesc('停止键入等待多少秒后触发快照')
            .addSlider(s => s.setLimits(10, 300, 10).setValue(this.plugin.settings.autoSaveDelayOnModify).setDynamicTooltip().onChange(async (v: number) => {
                this.plugin.settings.autoSaveDelayOnModify = v;
                await this.plugin.saveSettings();
            }));

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