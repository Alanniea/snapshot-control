
import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, Modal, ItemView, WorkspaceLeaf, Menu, TextComponent, MarkdownRenderer, Platform } from 'obsidian';
import * as Diff from 'diff';
import * as pako from 'pako';
import { VersionData, VersionFile, VersionControlSettings, DEFAULT_SETTINGS } from './types';
import { VersionHistoryView } from './view';
import { QuickPreviewModal, TagEditModal, NoteEditModal, VersionMessageModal, ConfirmModal, DiffModal, VersionSelectModal, ContextLineInputModal, LineHistoryModal } from './modals';
import { VersionControlSettingTab, IntegrityReportModal } from './settings';
import { registerCommands } from './commands';

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

        registerCommands(this);

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

    async withLock(filePath: string, fn: () => Promise<void>): Promise<void> {
        let currentLock = this.fileLocks.get(filePath) || Promise.resolve();
        const nextLock = currentLock
            .then(() => fn())
            .catch((err) => {
                console.error(`[VersionControl] Error in locked operation for ${filePath}:`, err);
            });
        this.fileLocks.set(filePath, nextLock);
        await nextLock;
    }

    stringHash(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return (hash >>> 0).toString(16);
    }

    getVersionFilePath(filePath: string): string {
        const hash = this.stringHash(filePath);
        const fileName = filePath.split('/').pop() || 'file';
        const safeName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        return `${this.settings.versionFolder}/${safeName}_${hash}.json`;
    }

    getLegacyVersionFilePath(filePath: string): string {
        const sanitized = this.sanitizeFileName(filePath);
        return `${this.settings.versionFolder}/${sanitized}.json`;
    }

    async handleRename(file: TFile, oldPath: string) {
        await this.withLock(oldPath, async () => {
            const adapter = this.app.vault.adapter;

            let oldVersionPath = this.getVersionFilePath(oldPath);
            if (!await adapter.exists(oldVersionPath)) {
                oldVersionPath = this.getLegacyVersionFilePath(oldPath);
            }

            if (await adapter.exists(oldVersionPath)) {
                const newVersionPath = this.getVersionFilePath(file.path);

                await adapter.rename(oldVersionPath, newVersionPath);

                try {
                    const versionFile = await this.loadVersionFile(file.path);
                    versionFile.filePath = file.path;
                    await this.saveVersionFile(file.path, versionFile);

                    this.versionCache.delete(oldPath);
                    this.lastModifiedTime.delete(oldPath);
                    this.lastModifiedTime.set(file.path, versionFile.lastModified);
                } catch (e) {
                    console.error("Rename: Error updating internal file path", e);
                }
            }
        });

        const pendingOld = this.pendingSaves.get(oldPath);
        if (pendingOld) {
            clearTimeout(pendingOld);
            this.pendingSaves.delete(oldPath);
        }

        const pendingNew = this.pendingSaves.get(file.path);
        if (pendingNew) {
            clearTimeout(pendingNew);
            this.pendingSaves.delete(file.path);
            this.handleFileModify(file);
        }
    }

    async handleDelete(filePath: string) {
        await this.withLock(filePath, async () => {
            const adapter = this.app.vault.adapter;
            let versionPath = this.getVersionFilePath(filePath);

            if (!await adapter.exists(versionPath)) {
                versionPath = this.getLegacyVersionFilePath(filePath);
            }

            if (await adapter.exists(versionPath)) {
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
                    // Update through the public method of the view
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
        if (!this.settings.autoSave) { this.statusBarItem.setText('⏸ 版本控制: 已暂停'); this.statusBarItem.title = '自动保存已暂停'; return; }
        const file = this.app.workspace.getActiveFile();
        if (!this.settings.showLastSaveTimeInStatusBar || !file) { this.statusBarItem.setText('⏱ 版本控制: 已启用'); this.statusBarItem.title = '点击可快速对比当前文件与最新版本'; return; }
        const versions = await this.getAllVersions(file.path);
        if (versions.length > 0) {
            const lastVersion = versions[0];
            const lastSaveTime = lastVersion.timestamp;
            this.lastModifiedTime.set(file.path, lastSaveTime);
            const saveTypeLabel = this.getSaveTypeLabel(lastVersion.message);
            const relativeTime = this.getRelativeTime(lastSaveTime);
            this.statusBarItem.setText(`${saveTypeLabel}: ${relativeTime}`);
            this.statusBarItem.title = `${saveTypeLabel}于 ${new Date(lastSaveTime).toLocaleString('zh-CN')}. 点击可快速对比。`;
        } else {
            this.lastModifiedTime.delete(file.path);
            this.statusBarItem.setText('⏱ 版本控制: 已启用');
            this.statusBarItem.title = '当前文件无历史版本。点击可快速对比。';
        }
    }

    async quickDiffFromStatusBar() {
        if (!this.settings.enableStatusBarDiff) return;
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice('没有打开的文件'); return; }
        const versions = await this.getAllVersions(file.path);
        if (versions.length === 0) { new Notice('没有历史版本可对比'); return; }
        const lastVersion = versions[0];
        new DiffModal(this.app, this, file, lastVersion.id).open();
    }

    async ensureVersionFolder() {
        const adapter = this.app.vault.adapter;
        const folderPath = this.settings.versionFolder;
        try { if (!await adapter.exists(folderPath)) { await adapter.mkdir(folderPath); } }
        catch (error) { console.error('创建版本文件夹失败:', error); new Notice('⚠️ 无法创建版本文件夹,请检查权限'); }
    }

    async activateVersionHistoryView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType('version-history')[0];
        if (!leaf) { const rightLeaf = workspace.getRightLeaf(false); if (!rightLeaf) { new Notice('无法打开版本历史视图'); return; } leaf = rightLeaf; await leaf.setViewState({ type: 'version-history', active: true, }); }
        workspace.revealLeaf(leaf);
    }

    startAutoSave() {
        if (this.autoSaveTimer) { window.clearInterval(this.autoSaveTimer); this.autoSaveTimer = null; }
        if (this.settings.autoSaveOnInterval) { this.autoSaveTimer = window.setInterval(() => { this.autoSaveCurrentFile(); }, this.settings.autoSaveInterval * 60 * 1000); }
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

                await this.createVersionInternal(file, message, false, [], false, content);

            } catch (error) {
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

    async autoSaveCurrentFile() {
        const file = this.app.workspace.getActiveFile();
        if (!file || this.isExcluded(file.path)) return;
        await this.autoSaveFile(file, '[Auto Save - Interval]');
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

            const versionFile = await this.loadVersionFile(file.path);

            if (this.settings.enableDeduplication) {
                const latestVersion = versionFile.versions[0];
                if (latestVersion && latestVersion.hash === hash) {
                    let contentReallyIdentical = false;
                    try {
                        const prevContent = await this.getVersionContent(file.path, latestVersion.id, true);
                        if (prevContent === content) {
                            contentReallyIdentical = true;
                        }
                    } catch (e) {
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
                    const previousContentRaw = await this.getVersionContent(file.path, versionFile.versions[0].id);
                    const previousContent = this.normalizeText(previousContentRaw);
                    const diffResult = Diff.diffLines(previousContent, content);
                    diffResult.forEach(part => {
                        if (part.added) addedLines += part.count || 0;
                        if (part.removed) removedLines += part.count || 0;
                    });
                } catch (e) {
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
                        const prevVersionId = versionFile.versions[0].id;
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
                    } catch (err) {
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
                    size: diffStr.length, hash,
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
        } catch (error) {
            console.error('保存版本失败:', error);
            new Notice('❌ 保存版本失败,请查看控制台');
        }
    }

    createDiff(oldContent: string, newContent: string): string {
        const changes = Diff.createPatch('file', oldContent, newContent, '', ''); return changes;
    }
    applyDiff(baseContent: string, diffStr: string, suppressNotice: boolean = false): string {
        try { const result = Diff.applyPatch(baseContent, diffStr); if (result === false) { console.error('应用差异补丁失败 (applyPatch returned false). 返回基础内容。'); if (!suppressNotice) { new Notice('应用差异补丁失败，版本内容可能不完整。'); } return baseContent; } return result; } catch (error) { console.error('应用差异时捕获到异常:', error); return baseContent; }
    }
    buildVersionIndex(versionFile: VersionFile) {
        const index = new Map<string, number>(); versionFile.versions.forEach((version, idx) => { index.set(version.id, idx); }); versionFile.versionIndex = index;
    }
    hashContent(content: string): string {
        let hash = 0; for (let i = 0; i < content.length; i++) { const char = content.charCodeAt(i); hash = ((hash << 5) - hash) + char; hash = hash & hash; } return hash.toString(36);
    }

    resolveContentFromList(versions: VersionData[], versionId: string, depth: number = 0): string {
        if (depth > 100) throw new Error("版本依赖链过深");
        const version = versions.find(v => v.id === versionId);
        if (!version) throw new Error(`无法在内存中找到基准版本: ${versionId}`);
        if (version.content !== undefined && version.content !== null) { return this.normalizeText(version.content); }
        if (version.diff && version.baseVersionId) { const baseContent = this.resolveContentFromList(versions, version.baseVersionId, depth + 1); const result = Diff.applyPatch(baseContent, version.diff); if (result === false) { throw new Error(`版本 ${versionId} 补丁应用失败`); } return this.normalizeText(result); }
        throw new Error(`版本 ${versionId} 数据不完整`);
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
            const v = proposedList[i];

            if (v.diff && v.baseVersionId) {
                if (!proposedKeepSet.has(v.baseVersionId)) {
                    try {
                        console.log(`[VersionControl] 版本 ${v.id} 的基准将被清理，正在将其转换为完整版本...`);

                        const fullContent = this.resolveContentFromList(versionFile.versions, v.id);

                        v.content = fullContent;
                        v.diff = undefined;
                        v.baseVersionId = undefined;
                        v.size = fullContent.length;

                    } catch (error) {
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

    async loadVersionFile(filePath: string): Promise<VersionFile> {
        if (this.versionCache.has(filePath)) {
            return this.versionCache.get(filePath)!;
        }

        const adapter = this.app.vault.adapter;

        let versionPath = this.getVersionFilePath(filePath);

        if (!await adapter.exists(versionPath)) {
            const legacyPath = this.getLegacyVersionFilePath(filePath);
            if (await adapter.exists(legacyPath)) {
                versionPath = legacyPath;
            }
        }

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
                versionFile.filePath = filePath;

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

    sanitizeFileName(path: string): string {
        return path.replace(/[\/\\:*?"<>|]/g, '_');
    }

    async getAllVersions(filePath: string): Promise<VersionData[]> { try { const versionFile = await this.loadVersionFile(filePath); return versionFile.versions; } catch (error) { console.error('获取版本列表失败:', error); return []; } }

    async getVersionContent(filePath: string, versionId: string, suppressNotice: boolean = false, strictMode: boolean = false): Promise<string> {
        try {
            const versionFile = await this.loadVersionFile(filePath);
            const resolveContent = async (vId: string, depth: number = 0): Promise<string> => {
                if (depth > 100) throw new Error(`版本依赖链过深 (${depth})`);
                const index = versionFile.versionIndex?.get(vId);
                const version = index !== undefined ? versionFile.versions[index] : versionFile.versions.find(v => v.id === vId);
                if (!version) { throw new Error(`版本 ${vId} 不存在`); }
                if (version.content !== undefined && version.content !== null) { return this.normalizeText(version.content); }
                if (version.diff) {
                    let baseContent = "";
                    if (version.baseVersionId) {
                        baseContent = await resolveContent(version.baseVersionId, depth + 1);
                    } else if (versionFile.baseVersion !== undefined && versionFile.baseVersion !== null) {
                        baseContent = this.normalizeText(versionFile.baseVersion);
                    } else {
                        throw new Error(`版本 ${vId} 既无内容也无有效基准引用`);
                    }
                    try {
                        const normalizedBase = this.normalizeText(baseContent);
                        const result = Diff.applyPatch(normalizedBase, version.diff);
                        if (result === false) {
                            if (strictMode) { throw new Error("增量补丁应用失败 (Patch Mismatch)"); }
                            console.warn(`[VersionControl] 版本 ${vId} 增量还原失败: Diff Patch 不匹配。返回基础内容。`);

                            if (!suppressNotice) {
                                new Notice(`⚠️ 版本 ${vId.substring(0,8)} 数据损坏，仅显示基准内容。`);
                            }

                            return normalizedBase;
                        }
                        return this.normalizeText(result);
                    } catch (error) {
                        if (error.message.includes("Patch Mismatch")) throw error;
                        console.error(`应用补丁失败 (Version: ${vId}):`, error);
                        throw new Error(`还原版本 ${vId} 失败: 补丁应用错误`);
                    }
                }
                throw new Error(`无法获取版本 ${vId} 的内容：缺少 content 和 diff`);
            };
            return await resolveContent(versionId);
        } catch (error) {
            console.error('读取版本内容失败:', error);
            if (!suppressNotice || strictMode) { }
            throw new Error(`无法读取版本内容: ${error.message}`);
        }
    }

    async verifyVersionFileIntegrity(filePath: string): Promise<boolean> { const errors = await this.verifyFileVersion(filePath); return errors.length === 0; }

    async verifyFileVersion(filePath: string): Promise<string[]> {
        const errors: string[] = [];
        let versionPath = this.getVersionFilePath(filePath);
        const adapter = this.app.vault.adapter;

        if (!await adapter.exists(versionPath)) {
            versionPath = this.getLegacyVersionFilePath(filePath);
            if (!await adapter.exists(versionPath)) {
                return [];
            }
        }

        let versionFile: VersionFile;
        try {
            let content: string;
            if (this.settings.enableCompression) {
                try {
                    const rawData = await adapter.readBinary(versionPath);
                    content = pako.ungzip(new Uint8Array(rawData), { to: 'string' });
                } catch (e) {
                    try {
                        content = await adapter.read(versionPath);
                        JSON.parse(content);
                    } catch (e2) {
                        throw new Error("文件损坏：无法解压且不是有效的 JSON");
                    }
                }
            } else {
                content = await adapter.read(versionPath);
            }
            versionFile = JSON.parse(content) as VersionFile;
        } catch (error) {
            errors.push(`文件读取失败: ${error.message}`);
            return errors;
        }

        if (!versionFile.versions || !Array.isArray(versionFile.versions)) { errors.push("文件结构错误: versions 字段丢失或无效"); return errors; } const versionMap = new Map<string, VersionData>(); versionFile.versions.forEach(v => versionMap.set(v.id, v)); for (const version of versionFile.versions) { if (!version.id || !version.timestamp) { errors.push(`版本记录损坏: 缺少 ID 或时间戳`); continue; } if (version.diff) { if (!version.baseVersionId && !versionFile.baseVersion) { errors.push(`版本 ${version.id.substring(0,8)}: 是增量版本但缺少 baseVersionId`); } else if (version.baseVersionId && !versionMap.has(version.baseVersionId)) { errors.push(`版本 ${version.id.substring(0,8)}: 依赖的基准版本 (${version.baseVersionId.substring(0,8)}) 丢失 (链条断裂)`); } } else if (version.content === undefined) { errors.push(`版本 ${version.id.substring(0,8)}: 既无 content 也无 diff，数据丢失`); } try { const content = await this.getVersionContent(filePath, version.id, true, true); if (version.hash) { const currentHash = this.hashContent(content); if (currentHash !== version.hash) { errors.push(`版本 ${version.id.substring(0,8)}: 哈希校验失败 (内容不匹配)`); } } } catch (e) { errors.push(`版本 ${version.id.substring(0,8)}: 内容还原失败 - ${e.message}`); } }
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
            const file = jsonFiles[i];
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
                } catch(e) { /* ignore */ }
                if (contentStr) {
                    const vData = JSON.parse(contentStr) as VersionFile;
                    if (vData.filePath) originalFilePath = vData.filePath;
                }
            } catch (e) {
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
                for (const version of versionFile.versions) { if (version.hash) { try { const content = await this.getVersionContent(filePath, version.id, true); const currentHash = this.hashContent(content); if (currentHash !== version.hash) { version.hash = currentHash; fixedCount++; } } catch (e) { console.warn(`Skipping repair for ${version.id}: content unreadable`); } } }
                if (fixedCount > 0) { await this.saveVersionFile(filePath, versionFile); this.versionCache.set(filePath, versionFile); new Notice(`✅ 已修复 ${fixedCount} 个版本记录的哈希值`); resolve(true); } else { new Notice(`ℹ️ 未发现可修复的哈希问题`); resolve(false); }
             });
        });
    }

    async updateVersionTags(filePath: string, versionId: string, tags: string[]) {
        await this.withLock(filePath, async () => {
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
        });
    }

    async updateVersionNote(filePath: string, versionId: string, note: string) {
        await this.withLock(filePath, async () => {
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
        });
    }

    async toggleVersionStar(filePath: string, versionId: string) {
        await this.withLock(filePath, async () => {
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
        });
    }

    async starLastVersion() { const file = this.app.workspace.getActiveFile(); if (!file) { new Notice('没有打开的文件'); return; } const versions = await this.getAllVersions(file.path); if (versions.length === 0) { new Notice('没有可标记的版本'); return; } await this.toggleVersionStar(file.path, versions[0].id); new Notice('⭐ 已标记/取消标记'); }
    async quickPreviewLastVersion() { const file = this.app.workspace.getActiveFile(); if (!file) { new Notice('没有打开的文件'); return; } const versions = await this.getAllVersions(file.path); if (versions.length === 0) { new Notice('没有历史版本可预览'); return; } new QuickPreviewModal(this.app, this, file, versions[0].id).open(); }

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
            } catch (error) {
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
            } catch (error) {
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
        } catch (error) {
            console.error('恢复版本失败:', error);
            new Notice('❌ 恢复版本失败');
        } finally {
            setTimeout(() => {
                this.isRestoring = false;
            }, 500);
        }
    }

    async restoreLastVersion() { const file = this.app.workspace.getActiveFile(); if (!file) { new Notice('没有打开的文件'); return; } const versions = await this.getAllVersions(file.path); if (versions.length === 0) { new Notice('没有可恢复的版本'); return; } const lastVersion = versions[0]; new ConfirmModal(this.app, '恢复到上一版本', `确定要恢复到版本: ${this.formatTime(lastVersion.timestamp)}?\n\n当前未保存的修改将会丢失,插件会在恢复前自动创建备份版本。`, async () => { await this.restoreVersion(file, lastVersion.id); }).open(); }
    async quickCompare() { const file = this.app.workspace.getActiveFile(); if (!file) { new Notice('没有打开的文件'); return; } const versions = await this.getAllVersions(file.path); if (versions.length === 0) { new Notice('没有历史版本可对比'); return; } const lastVersion = versions[0]; new DiffModal(this.app, this, file, lastVersion.id).open(); }
    async createFullSnapshot() { const files = this.app.vault.getMarkdownFiles(); const total = files.length; let count = 0; let skipped = 0; const progressNotice = new Notice(`正在准备全库版本... (0/${total})`, 0); const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)); for (let i = 0; i < total; i++) { const file = files[i]; if (i % 10 === 0) { progressNotice.setMessage(`正在保存全库版本... (${i + 1}/${total})`); await sleep(10); } if (this.isExcluded(file.path)) { skipped++; continue; } try { await this.createVersion(file, '[Full Snapshot]', false, [], true); count++; } catch (error) { console.error(`创建版本失败: ${file.path}`, error); } } progressNotice.hide(); if (this.settings.showNotifications) { setTimeout(() => { new Notice(`✅ 全库版本创建完成\n处理: ${count} 个文件${skipped > 0 ? `\n跳过: ${skipped} 个文件` : ''}`); }, 500); } }
    async optimizeAllVersionFiles() { const progressNotice = new Notice('正在优化存储...', 0); try { const adapter = this.app.vault.adapter; const versionFolder = this.settings.versionFolder; if (!await adapter.exists(versionFolder)) { progressNotice.hide(); new Notice('版本文件夹不存在'); return; } const files = await adapter.list(versionFolder); let optimized = 0; let savedBytes = 0; for (const file of files.files) { if (file.endsWith('.json')) { try { const oldSize = (await adapter.stat(file))?.size || 0; const filePath = file.replace(this.settings.versionFolder + '/', '').replace('.json', ''); const versionFile = await this.loadVersionFile(filePath); this.buildVersionIndex(versionFile); await this.saveVersionFile(versionFile.filePath, versionFile); const newSize = (await adapter.stat(file))?.size || 0; savedBytes += (oldSize - newSize); optimized++; } catch (error) { console.error('优化文件失败:', file, error); } } } progressNotice.hide(); new Notice(`✅ 优化完成\n处理: ${optimized} 个文件\n节省: ${this.formatFileSize(savedBytes)}`); } catch (error) { progressNotice.hide(); console.error('优化失败:', error); new Notice('❌ 优化失败'); } }
    async getStorageStats(): Promise<{ totalSize: number; versionCount: number; fileCount: number; compressionRatio: number; starredCount: number; taggedCount: number }> { const adapter = this.app.vault.adapter; const versionFolder = this.settings.versionFolder; try { if (!await adapter.exists(versionFolder)) { return { totalSize: 0, versionCount: 0, fileCount: 0, compressionRatio: 0, starredCount: 0, taggedCount: 0 }; } const files = await adapter.list(versionFolder); let totalSize = 0; let versionCount = 0; let fileCount = 0; let totalOriginalSize = 0; let starredCount = 0; let taggedCount = 0; for (const file of files.files) { if (file.endsWith('.json')) { try { const stat = await adapter.stat(file); const fileSize = stat?.size || 0; totalSize += fileSize; let versionFile: VersionFile; if (this.settings.enableCompression) { try { const rawData = await adapter.readBinary(file); const decompressed = pako.ungzip(new Uint8Array(rawData), { to: 'string' }); versionFile = JSON.parse(decompressed) as VersionFile; } catch (e) { const content = await adapter.read(file); versionFile = JSON.parse(content) as VersionFile; } } else { const content = await adapter.read(file); versionFile = JSON.parse(content) as VersionFile; } if (versionFile.versions && Array.isArray(versionFile.versions)) { versionCount += versionFile.versions.length; versionFile.versions.forEach(v => { if (v.content) { totalOriginalSize += v.content.length; } else if (v.diff) { totalOriginalSize += v.diff.length; } if (v.starred) starredCount++; if (v.tags && v.tags.length > 0) taggedCount++; }); fileCount++; } } catch (error) { console.error('读取版本文件失败:', file, error); } } } const compressionRatio = totalOriginalSize > 0 ? ((1 - totalSize / totalOriginalSize) * 100) : 0; return { totalSize, versionCount, fileCount, compressionRatio, starredCount, taggedCount }; } catch (error) { console.error('获取存储统计失败:', error); return { totalSize: 0, versionCount: 0, fileCount: 0, compressionRatio: 0, starredCount: 0, taggedCount: 0 }; } }
    async exportVersions(filePath: string): Promise<void> { try { const versionFile = await this.loadVersionFile(filePath); const exportPath = `${this.settings.versionFolder}/export_${this.sanitizeFileName(filePath)}_${Date.now()}.json`; await this.app.vault.adapter.write(exportPath, JSON.stringify(versionFile, null, 2)); new Notice(`✅ 版本已导出到: ${exportPath}`); } catch (error) { console.error('导出版本失败:', error); new Notice('❌ 导出失败'); } }
    async exportVersionAsFile(filePath: string, versionId: string): Promise<void> { try { const content = await this.getVersionContent(filePath, versionId); const fileName = filePath.replace(/\.[^/.]+$/, ''); const exportPath = `${fileName}_v${versionId.substring(0,8)}.md`; await this.app.vault.create(exportPath, content); new Notice(`✅ 版本已导出为: ${exportPath}`); } catch (error) { console.error('导出版本为文件失败:', error); new Notice('❌ 导出失败'); } }

    /**
     * 获取所有已修改但未创建快照的文件
     */
    async getModifiedFiles(): Promise<{ file: TFile, lastVersionTime: number }[]> {
        const files = this.app.vault.getMarkdownFiles();
        const modifiedFiles: { file: TFile, lastVersionTime: number }[] = [];

        for (const file of files) {
            if (this.isExcluded(file.path)) continue;

            const versionPath = this.getVersionFilePath(file.path);
            const legacyPath = this.getLegacyVersionFilePath(file.path);
            const adapter = this.app.vault.adapter;

            let exists = await adapter.exists(versionPath);
            if (!exists) exists = await adapter.exists(legacyPath);

            if (exists) {
                try {
                    const versionFile = await this.loadVersionFile(file.path);
                    if (versionFile.versions && versionFile.versions.length > 0) {
                        const lastVersion = versionFile.versions[0];
                        if (file.stat.mtime > lastVersion.timestamp + 2000) {
                            modifiedFiles.push({ file, lastVersionTime: lastVersion.timestamp });
                        }
                    }
                } catch (e) {
                    console.error(`Error checking modified file ${file.path}`, e);
                }
            } else {
                modifiedFiles.push({ file, lastVersionTime: 0 });
            }
        }

        return modifiedFiles.sort((a, b) => b.file.stat.mtime - a.file.stat.mtime);
    }

    /**
     * 获取全库版本历史（扁平化列表）
     * @param limit 限制返回数量
     */
    async getGlobalHistory(limit: number = 100): Promise<{ version: VersionData, filePath: string, file: TFile | null }[]> {
        const adapter = this.app.vault.adapter;
        const versionFolder = this.settings.versionFolder;

        if (!await adapter.exists(versionFolder)) return [];

        const files = await adapter.list(versionFolder);
        const allVersions: { version: VersionData, filePath: string, file: TFile | null }[] = [];

        for (const vFile of files.files) {
            if (!vFile.endsWith('.json')) continue;

            try {
                let contentStr = "";
                if (this.settings.enableCompression) {
                     try {
                        const bin = await adapter.readBinary(vFile);
                        contentStr = pako.ungzip(new Uint8Array(bin), { to: 'string' });
                     } catch(e) { contentStr = await adapter.read(vFile); }
                } else {
                    contentStr = await adapter.read(vFile);
                }

                const data = JSON.parse(contentStr) as VersionFile;
                if (!data.versions) continue;

                const tFile = this.app.vault.getAbstractFileByPath(data.filePath);

                // 只取每份文件的最近 5 个版本参与全库排序，避免数据量过大
                const relevantVersions = data.versions.slice(0, 5);

                relevantVersions.forEach(v => {
                    allVersions.push({
                        version: v,
                        filePath: data.filePath,
                        file: (tFile instanceof TFile) ? tFile : null
                    });
                });

            } catch (e) {
                // ignore errors
            }
        }

        allVersions.sort((a, b) => b.version.timestamp - a.version.timestamp);
        return allVersions.slice(0, limit);
    }

    formatFileSize(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`; return `${(bytes / (1024 * 1024)).toFixed(2)} MB`; }
    formatTime(timestamp: number): string { if (this.settings.useRelativeTime) { return this.getRelativeTime(timestamp); } return new Date(timestamp).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    getRelativeTime(timestamp: number): string { const diff = Date.now() - timestamp; const seconds = Math.floor(diff / 1000); const minutes = Math.floor(seconds / 60); const hours = Math.floor(minutes / 60); const days = Math.floor(hours / 24); const months = Math.floor(days / 30); const years = Math.floor(days / 365); if (years > 0) return `${years} 年前`; if (months > 0) return `${months} 个月前`; if (days > 0) return `${days} 天前`; if (hours > 0) return `${hours} 小时前`; if (minutes > 0) return `${minutes} 分钟前`; if (seconds < 10) return '刚刚'; return `${seconds} 秒前`; }
    refreshVersionHistoryView() { const leaves = this.app.workspace.getLeavesOfType('version-history'); leaves.forEach(leaf => { if (leaf.view instanceof VersionHistoryView) { leaf.view.refresh(); } }); }
}
