import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, Modal, ItemView, WorkspaceLeaf, Menu } from 'obsidian';
import * as Diff from 'diff';

interface VersionControlSettings {
    storageLocation: string;
    autoSaveEnabled: boolean;
    autoSaveInterval: number; // 分钟
    autoCleanEnabled: boolean;
    maxVersionCount: number;
    maxVersionDays: number;
    cleanupStrategy: 'days-first' | 'count-first' | 'both';
}

const DEFAULT_SETTINGS: VersionControlSettings = {
    storageLocation: '.versions',
    autoSaveEnabled: true,
    autoSaveInterval: 5,
    autoCleanEnabled: true,
    maxVersionCount: 50,
    maxVersionDays: 30,
    cleanupStrategy: 'both'
};

interface FileVersion {
    id: string;
    timestamp: number;
    message: string;
    content: string;
    size: number;
    filePath: string;
}

const VIEW_TYPE_VERSION_HISTORY = 'version-history-view';

class VersionHistoryView extends ItemView {
    plugin: VersionControlPlugin;
    currentFile: TFile | null = null;
    versions: FileVersion[] = [];
    selectedVersions: Set<string> = new Set();

    constructor(leaf: WorkspaceLeaf, plugin: VersionControlPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return VIEW_TYPE_VERSION_HISTORY;
    }

    getDisplayText(): string {
        return '版本历史';
    }

    getIcon(): string {
        return 'history';
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('version-history-container');

        this.renderView();
        
        // 监听活动文件变化
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.updateCurrentFile();
            })
        );
    }

    async updateCurrentFile() {
        const file = this.app.workspace.getActiveFile();
        if (file && file !== this.currentFile) {
            this.currentFile = file;
            await this.loadVersions();
            this.renderView();
        }
    }

    async loadVersions() {
        if (!this.currentFile) return;
        
        this.versions = await this.plugin.getVersions(this.currentFile.path);
        this.versions.sort((a, b) => b.timestamp - a.timestamp);
    }

    renderView() {
        const container = this.containerEl.children[1];
        container.empty();

        if (!this.currentFile) {
            container.createEl('div', { 
                text: '请打开一个文件以查看其版本历史', 
                cls: 'version-empty-state' 
            });
            return;
        }

        // 标题栏
        const header = container.createEl('div', { cls: 'version-header' });
        header.createEl('h4', { text: '版本历史' });
        header.createEl('div', { 
            text: this.currentFile.basename, 
            cls: 'version-filename' 
        });

        // 操作按钮
        const toolbar = container.createEl('div', { cls: 'version-toolbar' });
        
        const createBtn = toolbar.createEl('button', { 
            text: '创建版本',
            cls: 'mod-cta'
        });
        createBtn.onclick = () => this.createManualVersion();

        if (this.selectedVersions.size > 0) {
            const deleteBtn = toolbar.createEl('button', { 
                text: `删除选中 (${this.selectedVersions.size})`,
                cls: 'mod-warning'
            });
            deleteBtn.onclick = () => this.deleteSelectedVersions();
        }

        // 版本列表
        const listContainer = container.createEl('div', { cls: 'version-list' });

        if (this.versions.length === 0) {
            listContainer.createEl('div', { 
                text: '暂无版本历史', 
                cls: 'version-empty' 
            });
            return;
        }

        this.versions.forEach(version => {
            const item = listContainer.createEl('div', { cls: 'version-item' });
            
            // 复选框
            const checkbox = item.createEl('input', { 
                type: 'checkbox',
                cls: 'version-checkbox'
            });
            checkbox.checked = this.selectedVersions.has(version.id);
            checkbox.onchange = () => {
                if (checkbox.checked) {
                    this.selectedVersions.add(version.id);
                } else {
                    this.selectedVersions.delete(version.id);
                }
                this.renderView();
            };

            const info = item.createEl('div', { cls: 'version-info' });
            
            // 时间戳
            const date = new Date(version.timestamp);
            const timeStr = date.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            info.createEl('div', { 
                text: timeStr, 
                cls: 'version-timestamp' 
            });

            // 提交信息
            info.createEl('div', { 
                text: version.message, 
                cls: 'version-message' 
            });

            // 文件大小
            const sizeKB = (version.size / 1024).toFixed(2);
            info.createEl('div', { 
                text: `${sizeKB} KB`, 
                cls: 'version-size' 
            });

            // 操作按钮
            const actions = item.createEl('div', { cls: 'version-actions' });
            
            const restoreBtn = actions.createEl('button', { 
                text: '恢复',
                cls: 'mod-cta'
            });
            restoreBtn.onclick = () => this.restoreVersion(version);

            const diffBtn = actions.createEl('button', { text: '对比当前' });
            diffBtn.onclick = () => this.showDiff(version, null);

            // 右键菜单
            item.oncontextmenu = (e) => {
                e.preventDefault();
                const menu = new Menu();
                
                menu.addItem((item) => {
                    item.setTitle('恢复此版本')
                        .setIcon('reset')
                        .onClick(() => this.restoreVersion(version));
                });

                menu.addItem((item) => {
                    item.setTitle('对比当前版本')
                        .setIcon('diff')
                        .onClick(() => this.showDiff(version, null));
                });

                menu.addItem((item) => {
                    item.setTitle('与其他版本对比')
                        .setIcon('diff')
                        .onClick(() => this.selectVersionForComparison(version));
                });

                menu.addItem((item) => {
                    item.setTitle('删除此版本')
                        .setIcon('trash')
                        .onClick(() => this.deleteVersion(version));
                });

                menu.showAtMouseEvent(e);
            };
        });
    }

    async createManualVersion() {
        if (!this.currentFile) return;

        const modal = new VersionMessageModal(this.app, async (message) => {
            await this.plugin.createVersion(this.currentFile!, message);
            new Notice('版本创建成功');
            await this.loadVersions();
            this.renderView();
        });
        modal.open();
    }

    async restoreVersion(version: FileVersion) {
        if (!this.currentFile) return;

        const confirmed = await this.showRestoreWarning();
        if (!confirmed) return;

        // 先保存当前版本
        await this.plugin.createVersion(this.currentFile, '[恢复前自动保存]');

        // 恢复版本
        await this.app.vault.modify(this.currentFile, version.content);
        new Notice('版本已恢复');
        
        await this.loadVersions();
        this.renderView();
    }

    async showRestoreWarning(): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new ConfirmModal(
                this.app,
                '确认恢复版本',
                '恢复此版本将替换当前文件内容。当前内容会自动保存为新版本。是否继续?',
                () => resolve(true),
                () => resolve(false)
            );
            modal.open();
        });
    }

    showDiff(version1: FileVersion, version2: FileVersion | null) {
        new DiffModal(this.app, this.currentFile!, version1, version2).open();
    }

    selectVersionForComparison(version1: FileVersion) {
        const modal = new VersionSelectModal(
            this.app,
            this.versions.filter(v => v.id !== version1.id),
            (version2) => {
                this.showDiff(version1, version2);
            }
        );
        modal.open();
    }

    async deleteVersion(version: FileVersion) {
        await this.plugin.deleteVersion(version.id);
        new Notice('版本已删除');
        await this.loadVersions();
        this.renderView();
    }

    async deleteSelectedVersions() {
        const count = this.selectedVersions.size;
        const confirmed = await new Promise<boolean>((resolve) => {
            const modal = new ConfirmModal(
                this.app,
                '确认删除',
                `确定要删除选中的 ${count} 个版本吗?`,
                () => resolve(true),
                () => resolve(false)
            );
            modal.open();
        });

        if (!confirmed) return;

        for (const id of this.selectedVersions) {
            await this.plugin.deleteVersion(id);
        }

        this.selectedVersions.clear();
        new Notice(`已删除 ${count} 个版本`);
        await this.loadVersions();
        this.renderView();
    }
}

class VersionMessageModal extends Modal {
    onSubmit: (message: string) => void;
    message: string = '';

    constructor(app: App, onSubmit: (message: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: '创建版本' });

        const inputContainer = contentEl.createDiv();
        const input = inputContainer.createEl('input', {
            type: 'text',
            placeholder: '输入提交信息 (可选)',
            cls: 'version-message-input'
        });
        input.style.width = '100%';
        input.style.marginBottom = '1em';
        input.oninput = () => {
            this.message = input.value;
        };

        const btnContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        
        const submitBtn = btnContainer.createEl('button', { 
            text: '创建',
            cls: 'mod-cta'
        });
        submitBtn.onclick = () => {
            this.onSubmit(this.message || '[手动保存]');
            this.close();
        };

        const cancelBtn = btnContainer.createEl('button', { text: '取消' });
        cancelBtn.onclick = () => this.close();
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
    onCancel: () => void;

    constructor(app: App, title: string, message: string, onConfirm: () => void, onCancel: () => void) {
        super(app);
        this.title = title;
        this.message = message;
        this.onConfirm = onConfirm;
        this.onCancel = onCancel;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: this.title });
        contentEl.createEl('p', { text: this.message });

        const btnContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        
        const confirmBtn = btnContainer.createEl('button', { 
            text: '确认',
            cls: 'mod-warning'
        });
        confirmBtn.onclick = () => {
            this.onConfirm();
            this.close();
        };

        const cancelBtn = btnContainer.createEl('button', { text: '取消' });
        cancelBtn.onclick = () => {
            this.onCancel();
            this.close();
        };
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class VersionSelectModal extends Modal {
    versions: FileVersion[];
    onSelect: (version: FileVersion) => void;

    constructor(app: App, versions: FileVersion[], onSelect: (version: FileVersion) => void) {
        super(app);
        this.versions = versions;
        this.onSelect = onSelect;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: '选择对比版本' });

        const list = contentEl.createDiv({ cls: 'version-select-list' });
        
        this.versions.forEach(version => {
            const item = list.createEl('div', { cls: 'version-select-item' });
            
            const date = new Date(version.timestamp);
            const timeStr = date.toLocaleString('zh-CN');
            
            item.createEl('div', { text: timeStr, cls: 'version-timestamp' });
            item.createEl('div', { text: version.message, cls: 'version-message' });
            
            item.onclick = () => {
                this.onSelect(version);
                this.close();
            };
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class DiffModal extends Modal {
    file: TFile;
    version1: FileVersion;
    version2: FileVersion | null;
    diffMode: 'unified' | 'split' = 'unified';
    diffLevel: 'char' | 'word' | 'line' = 'char';
    diffs: any[] = [];
    currentDiffIndex: number = 0;

    constructor(app: App, file: TFile, version1: FileVersion, version2: FileVersion | null) {
        super(app);
        this.file = file;
        this.version1 = version1;
        this.version2 = version2;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.addClass('diff-modal');
        
        // 获取内容
        const oldContent = this.version1.content;
        const newContent = this.version2 ? this.version2.content : await this.app.vault.read(this.file);

        // 工具栏
        const toolbar = contentEl.createDiv({ cls: 'diff-toolbar' });
        
        // 版本信息
        const versionInfo = toolbar.createDiv({ cls: 'diff-version-info' });
        const v1Date = new Date(this.version1.timestamp).toLocaleString('zh-CN');
        const v2Label = this.version2 
            ? new Date(this.version2.timestamp).toLocaleString('zh-CN')
            : '当前版本';
        versionInfo.createEl('span', { text: `对比: ${v1Date} ↔ ${v2Label}` });

        // 视图切换
        const viewToggle = toolbar.createDiv({ cls: 'diff-view-toggle' });
        const unifiedBtn = viewToggle.createEl('button', { 
            text: '统一视图',
            cls: this.diffMode === 'unified' ? 'is-active' : ''
        });
        unifiedBtn.onclick = () => {
            this.diffMode = 'unified';
            this.renderDiff(oldContent, newContent);
        };

        const splitBtn = viewToggle.createEl('button', { 
            text: '分栏视图',
            cls: this.diffMode === 'split' ? 'is-active' : ''
        });
        splitBtn.onclick = () => {
            this.diffMode = 'split';
            this.renderDiff(oldContent, newContent);
        };

        // 差异级别
        const levelToggle = toolbar.createDiv({ cls: 'diff-level-toggle' });
        ['字符级', '单词级', '行级'].forEach((label, idx) => {
            const levels: ('char' | 'word' | 'line')[] = ['char', 'word', 'line'];
            const level = levels[idx];
            const btn = levelToggle.createEl('button', {
                text: label,
                cls: this.diffLevel === level ? 'is-active' : ''
            });
            btn.onclick = () => {
                this.diffLevel = level;
                this.renderDiff(oldContent, newContent);
            };
        });

        // 导航
        const navigation = toolbar.createDiv({ cls: 'diff-navigation' });
        const prevBtn = navigation.createEl('button', { text: '上一个' });
        const countSpan = navigation.createEl('span', { cls: 'diff-count' });
        const nextBtn = navigation.createEl('button', { text: '下一个' });

        prevBtn.onclick = () => this.navigateDiff(-1);
        nextBtn.onclick = () => this.navigateDiff(1);

        // 差异容器
        const diffContainer = contentEl.createDiv({ cls: 'diff-container' });

        this.renderDiff(oldContent, newContent);
    }

    renderDiff(oldContent: string, newContent: string) {
        const diffContainer = this.contentEl.querySelector('.diff-container') as HTMLElement;
        const countSpan = this.contentEl.querySelector('.diff-count') as HTMLElement;
        
        if (!diffContainer) return;
        
        diffContainer.empty();

        // 计算差异
        let diffs;
        if (this.diffLevel === 'char') {
            diffs = Diff.diffChars(oldContent, newContent);
        } else if (this.diffLevel === 'word') {
            diffs = Diff.diffWords(oldContent, newContent);
        } else {
            diffs = Diff.diffLines(oldContent, newContent);
        }

        this.diffs = diffs.filter(d => d.added || d.removed);
        this.currentDiffIndex = 0;

        // 更新计数
        if (countSpan) {
            countSpan.setText(this.diffs.length > 0 
                ? `(${this.currentDiffIndex + 1} / ${this.diffs.length})`
                : '(0 / 0)'
            );
        }

        if (this.diffMode === 'unified') {
            this.renderUnifiedDiff(diffContainer, diffs);
        } else {
            this.renderSplitDiff(diffContainer, oldContent, newContent);
        }
    }

    renderUnifiedDiff(container: HTMLElement, diffs: any[]) {
        const pre = container.createEl('pre', { cls: 'diff-unified' });
        
        diffs.forEach((part, idx) => {
            const span = pre.createEl('span', {
                cls: part.added ? 'diff-added' : part.removed ? 'diff-removed' : 'diff-unchanged',
                attr: { 'data-diff-index': idx }
            });
            span.textContent = part.value;
        });
    }

    renderSplitDiff(container: HTMLElement, oldContent: string, newContent: string) {
        const splitContainer = container.createDiv({ cls: 'diff-split' });
        
        const oldPane = splitContainer.createDiv({ cls: 'diff-pane' });
        oldPane.createEl('h4', { text: '原版本' });
        const oldPre = oldPane.createEl('pre');
        oldPre.textContent = oldContent;

        const newPane = splitContainer.createDiv({ cls: 'diff-pane' });
        newPane.createEl('h4', { text: '新版本' });
        const newPre = newPane.createEl('pre');
        newPre.textContent = newContent;
    }

    navigateDiff(direction: number) {
        if (this.diffs.length === 0) return;

        this.currentDiffIndex += direction;
        if (this.currentDiffIndex < 0) this.currentDiffIndex = this.diffs.length - 1;
        if (this.currentDiffIndex >= this.diffs.length) this.currentDiffIndex = 0;

        // 更新计数
        const countSpan = this.contentEl.querySelector('.diff-count') as HTMLElement;
        if (countSpan) {
            countSpan.setText(`(${this.currentDiffIndex + 1} / ${this.diffs.length})`);
        }

        // 滚动到当前差异
        const diffElements = this.contentEl.querySelectorAll('[data-diff-index]');
        if (diffElements[this.currentDiffIndex]) {
            diffElements[this.currentDiffIndex].scrollIntoView({ 
                behavior: 'smooth', 
                block: 'center' 
            });
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export default class VersionControlPlugin extends Plugin {
    settings: VersionControlSettings;
    autoSaveInterval: number | null = null;
    fileChangeTracking: Map<string, string> = new Map();

    async onload() {
        await this.loadSettings();

        // 注册视图
        this.registerView(
            VIEW_TYPE_VERSION_HISTORY,
            (leaf) => new VersionHistoryView(leaf, this)
        );

        // 添加侧边栏按钮
        this.addRibbonIcon('history', '版本历史', () => {
            this.activateView();
        });

        // 添加命令
        this.addCommand({
            id: 'create-version',
            name: '创建版本快照',
            callback: () => this.createVersionCommand()
        });

        this.addCommand({
            id: 'open-version-history',
            name: '打开版本历史',
            callback: () => this.activateView()
        });

        // 设置
        this.addSettingTab(new VersionControlSettingTab(this.app, this));

        // 启动自动保存
        if (this.settings.autoSaveEnabled) {
            this.startAutoSave();
        }

        // 启动自动清理
        if (this.settings.autoCleanEnabled) {
            this.scheduleAutoClean();
        }

        console.log('版本控制插件已加载');
    }

    async activateView() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_VERSION_HISTORY);

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getRightLeaf(false);
            await leaf!.setViewState({
                type: VIEW_TYPE_VERSION_HISTORY,
                active: true
            });
        }

        workspace.revealLeaf(leaf!);
    }

    startAutoSave() {
        if (this.autoSaveInterval) {
            window.clearInterval(this.autoSaveInterval);
        }

        const intervalMs = this.settings.autoSaveInterval * 60 * 1000;
        this.autoSaveInterval = window.setInterval(() => {
            this.autoSaveCheck();
        }, intervalMs);

        this.registerInterval(this.autoSaveInterval);
    }

    async autoSaveCheck() {
        const files = this.app.vault.getMarkdownFiles();
        
        for (const file of files) {
            const content = await this.app.vault.read(file);
            const lastContent = this.fileChangeTracking.get(file.path);

            if (lastContent !== content) {
                await this.createVersion(file, '[自动保存]');
                this.fileChangeTracking.set(file.path, content);
            }
        }
    }

    scheduleAutoClean() {
        // 每小时检查一次
        const intervalMs = 60 * 60 * 1000;
        const interval = window.setInterval(() => {
            this.autoCleanVersions();
        }, intervalMs);

        this.registerInterval(interval);
    }

    async autoCleanVersions() {
        const allVersions = await this.getAllVersions();
        const now = Date.now();
        const maxAge = this.settings.maxVersionDays * 24 * 60 * 60 * 1000;

        // 按文件分组
        const versionsByFile = new Map<string, FileVersion[]>();
        for (const version of allVersions) {
            if (!versionsByFile.has(version.filePath)) {
                versionsByFile.set(version.filePath, []);
            }
            versionsByFile.get(version.filePath)!.push(version);
        }

        // 对每个文件进行清理
        for (const [filePath, versions] of versionsByFile) {
            versions.sort((a, b) => b.timestamp - a.timestamp);

            const toDelete: string[] = [];

            if (this.settings.cleanupStrategy === 'days-first') {
                // 先按天数删除
                versions.forEach(v => {
                    if (now - v.timestamp > maxAge) {
                        toDelete.push(v.id);
                    }
                });

                // 再按数量删除
                const remaining = versions.filter(v => !toDelete.includes(v.id));
                if (remaining.length > this.settings.maxVersionCount) {
                    const excess = remaining.slice(this.settings.maxVersionCount);
                    excess.forEach(v => toDelete.push(v.id));
                }
            } else if (this.settings.cleanupStrategy === 'count-first') {
                // 先按数量删除
                if (versions.length > this.settings.maxVersionCount) {
                    const excess = versions.slice(this.settings.maxVersionCount);
                    excess.forEach(v => toDelete.push(v.id));
                }

                // 再按天数删除
                versions.forEach(v => {
                    if (now - v.timestamp > maxAge && !toDelete.includes(v.id)) {
                        toDelete.push(v.id);
                    }
                });
            } else {
                // 同时满足两个条件
                versions.forEach((v, idx) => {
                    if (now - v.timestamp > maxAge || idx >= this.settings.maxVersionCount) {
                        toDelete.push(v.id);
                    }
                });
            }

            // 删除版本
            for (const id of toDelete) {
                await this.deleteVersion(id);
            }
        }
    }

    async createVersionCommand() {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
            new Notice('请先打开一个文件');
            return;
        }

        const modal = new VersionMessageModal(this.app, async (message) => {
            await this.createVersion(file, message);
            new Notice('版本创建成功');
        });
        modal.open();
    }

    async createVersion(file: TFile, message: string): Promise<void> {
        const content = await this.app.vault.read(file);
        const version: FileVersion = {
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: Date.now(),
            message: message,
            content: content,
            size: new Blob([content]).size,
            filePath: file.path
        };

        await this.saveVersion(version);
        this.fileChangeTracking.set(file.path, content);
    }

    async saveVersion(version: FileVersion): Promise<void> {
        const versionPath = `${this.settings.storageLocation}/${version.id}.json`;
        await this.app.vault.adapter.write(versionPath, JSON.stringify(version));
    }

    async getVersions(filePath: string): Promise<FileVersion[]> {
        const versions: FileVersion[] = [];
        
        try {
            const files = await this.app.vault.adapter.list(this.settings.storageLocation);
            
            for (const file of files.files) {
                if (file.endsWith('.json')) {
                    const content = await this.app.vault.adapter.read(file);
                    const version: FileVersion = JSON.parse(content);
                    
                    if (version.filePath === filePath) {
                        versions.push(version);
                    }
                }
            }
        } catch (e) {
            console.error('读取版本失败:', e);
        }

        return versions;
    }

    async getAllVersions(): Promise<FileVersion[]> {
        const versions: FileVersion[] = [];
        
        try {
            const files = await this.app.vault.adapter.list(this.settings.storageLocation);
            
            for (const file of files.files) {
                if (file.endsWith('.json')) {
                    const content = await this.app.vault.adapter.read(file);
                    const version: FileVersion = JSON.parse(content);
                    versions.push(version);
                }
            }
        } catch (e) {
            console.error('读取版本失败:', e);
        }

        return versions;
    }

    async deleteVersion(versionId: string): Promise<void> {
        const versionPath = `${this.settings.storageLocation}/${versionId}.json`;
        
        try {
            await this.app.vault.adapter.remove(versionPath);
        } catch (e) {
            console.error('删除版本失败:', e);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    onunload() {
        if (this.autoSaveInterval) {
            window.clearInterval(this.autoSaveInterval);
        }
        console.log('版本控制插件已卸载');
    }
}

class VersionControlSettingTab extends PluginSettingTab {
    plugin: VersionControlPlugin;

    constructor(app: App, plugin: VersionControlPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: '版本控制设置' });

        // 存储位置
        new Setting(containerEl)
            .setName('存储位置')
            .setDesc('版本数据的存储路径 (相对于库根目录)')
            .addText(text => text
                .setPlaceholder('.versions')
                .setValue(this.plugin.settings.storageLocation)
                .onChange(async (value) => {
                    this.plugin.settings.storageLocation = value || '.versions';
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: '自动保存' });

        // 自动保存开关
        new Setting(containerEl)
            .setName('启用自动保存')
            .setDesc('定期自动为修改的文件创建版本')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSaveEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.autoSaveEnabled = value;
                    await this.plugin.saveSettings();
                    
                    if (value) {
                        this.plugin.startAutoSave();
                        new Notice('自动保存已启用');
                    } else {
                        if (this.plugin.autoSaveInterval) {
                            window.clearInterval(this.plugin.autoSaveInterval);
                            this.plugin.autoSaveInterval = null;
                        }
                        new Notice('自动保存已禁用');
                    }
                }));

        // 自动保存间隔
        new Setting(containerEl)
            .setName('自动保存间隔 (分钟)')
            .setDesc('每隔多少分钟检查并保存修改的文件')
            .addText(text => text
                .setPlaceholder('5')
                .setValue(String(this.plugin.settings.autoSaveInterval))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.autoSaveInterval = num;
                        await this.plugin.saveSettings();
                        
                        if (this.plugin.settings.autoSaveEnabled) {
                            this.plugin.startAutoSave();
                            new Notice(`自动保存间隔已更新为 ${num} 分钟`);
                        }
                    }
                }));

        containerEl.createEl('h3', { text: '自动清理' });

        // 自动清理开关
        new Setting(containerEl)
            .setName('启用自动清理')
            .setDesc('自动删除超过限制的旧版本以节省空间')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoCleanEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.autoCleanEnabled = value;
                    await this.plugin.saveSettings();
                    new Notice(value ? '自动清理已启用' : '自动清理已禁用');
                }));

        // 保留数量上限
        new Setting(containerEl)
            .setName('保留数量上限')
            .setDesc('每个文件最多保留多少个版本')
            .addText(text => text
                .setPlaceholder('50')
                .setValue(String(this.plugin.settings.maxVersionCount))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.maxVersionCount = num;
                        await this.plugin.saveSettings();
                    }
                }));

        // 保留天数
        new Setting(containerEl)
            .setName('保留天数')
            .setDesc('版本最多保留多少天')
            .addText(text => text
                .setPlaceholder('30')
                .setValue(String(this.plugin.settings.maxVersionDays))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.maxVersionDays = num;
                        await this.plugin.saveSettings();
                    }
                }));

        // 清理策略
        new Setting(containerEl)
            .setName('清理策略')
            .setDesc('如何决定删除哪些版本')
            .addDropdown(dropdown => dropdown
                .addOption('days-first', '先按天数,再按数量')
                .addOption('count-first', '先按数量,再按天数')
                .addOption('both', '同时满足两个条件')
                .setValue(this.plugin.settings.cleanupStrategy)
                .onChange(async (value: any) => {
                    this.plugin.settings.cleanupStrategy = value;
                    await this.plugin.saveSettings();
                }));

        // 手动清理按钮
        new Setting(containerEl)
            .setName('立即清理')
            .setDesc('立即执行一次版本清理')
            .addButton(button => button
                .setButtonText('清理旧版本')
                .setCta()
                .onClick(async () => {
                    await this.plugin.autoCleanVersions();
                    new Notice('版本清理完成');
                }));

        // 统计信息
        containerEl.createEl('h3', { text: '统计信息' });
        
        const statsDiv = containerEl.createDiv({ cls: 'version-stats' });
        this.updateStats(statsDiv);
    }

    async updateStats(container: HTMLElement) {
        container.empty();
        
        try {
            const allVersions = await this.plugin.getAllVersions();
            const totalSize = allVersions.reduce((sum, v) => sum + v.size, 0);
            const fileCount = new Set(allVersions.map(v => v.filePath)).size;

            container.createEl('p', { 
                text: `总版本数: ${allVersions.length}` 
            });
            container.createEl('p', { 
                text: `涉及文件: ${fileCount}` 
            });
            container.createEl('p', { 
                text: `总大小: ${(totalSize / 1024 / 1024).toFixed(2)} MB` 
            });
        } catch (e) {
            container.createEl('p', { 
                text: '无法读取统计信息',
                cls: 'mod-warning'
            });
        }
    }
}