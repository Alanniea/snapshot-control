
import { App, Modal, TFile, Notice, MarkdownRenderer, Platform, Menu, Setting, TextComponent } from 'obsidian';
import VersionControlPlugin from './main';
import { VersionData, VersionControlSettings } from './types';
import * as Diff from 'diff';

export class QuickPreviewModal extends Modal {
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

export class TagEditModal extends Modal {
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

export class NoteEditModal extends Modal {
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

export class VersionMessageModal extends Modal {
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

export class ConfirmModal extends Modal {
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
    type: 'context' | 'added' | 'removed' | 'moved-from' | 'moved-to' | 'modified';
    moveId?: number;
} & Diff.Change;

export class DiffModal extends Modal {
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
    enableMoveDetection: boolean = true;
    showWhitespace: boolean = false;
    isFullscreen: boolean = false; // 新增：全屏状态标记
    isFocusMode: boolean = false; // 新增：专注模式状态标记

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

    processDiffForMoves(diffResult: Diff.Change[]): ProcessedDiff[] {
        const processed: ProcessedDiff[] = diffResult.map(part => ({
            ...part,
            type: part.added ? 'added' : part.removed ? 'removed' : 'context'
        }));

        const removedMap = new Map<string, number[]>();
        const addedMap = new Map<string, number[]>();

        processed.forEach((part, index) => {
            if (!part.value.trim()) return;

            if (part.removed) {
                const key = part.value.trim();
                if (!removedMap.has(key)) removedMap.set(key, []);
                removedMap.get(key)!.push(index);
            } else if (part.added) {
                const key = part.value.trim();
                if (!addedMap.has(key)) addedMap.set(key, []);
                addedMap.get(key)!.push(index);
            }
        });

        let moveIdCounter = 0;

        for (const [key, removedIndices] of removedMap.entries()) {
            if (addedMap.has(key)) {
                const addedIndices = addedMap.get(key)!;
                const pairs = Math.min(removedIndices.length, addedIndices.length);

                for (let i = 0; i < pairs; i++) {
                    const rIdx = removedIndices.shift()!;
                    const aIdx = addedIndices.shift()!;
                    this.markAsMoved(processed, rIdx, aIdx, moveIdCounter++);
                }
            }
        }

        const unmatchedRemovedIndices: number[] = [];
        const unmatchedAddedIndices: number[] = [];

        processed.forEach((part, index) => {
            if (part.type === 'removed' && part.moveId === undefined && part.value.trim().length > 10) {
                unmatchedRemovedIndices.push(index);
            } else if (part.type === 'added' && part.moveId === undefined && part.value.trim().length > 10) {
                unmatchedAddedIndices.push(index);
            }
        });

        for (const rIdx of unmatchedRemovedIndices) {
            let bestMatchIdx = -1;
            let bestScore = 0;

            const removedText = processed[rIdx].value;

            for (let i = 0; i < unmatchedAddedIndices.length; i++) {
                const aIdx = unmatchedAddedIndices[i];
                const addedText = processed[aIdx].value;

                if (Math.abs(removedText.length - addedText.length) / removedText.length > 0.4) continue;

                const score = this.calculateSimilarity(removedText, addedText);

                if (score > 65 && score > bestScore) {
                    bestScore = score;
                    bestMatchIdx = i;
                }
            }

            if (bestMatchIdx !== -1) {
                const aIdx = unmatchedAddedIndices[bestMatchIdx];
                this.markAsMoved(processed, rIdx, aIdx, moveIdCounter++);
                unmatchedAddedIndices.splice(bestMatchIdx, 1);
            }
        }

        return processed;
    }

    markAsMoved(processed: ProcessedDiff[], rIdx: number, aIdx: number, id: number) {
        processed[rIdx].type = 'moved-from';
        processed[rIdx].moveId = id;
        processed[aIdx].type = 'moved-to';
        processed[aIdx].moveId = id;
    }

    visualizeWhitespace(text: string): string {
        return text.replace(/\t/g, '→   ').replace(/ /g, '·');
    }

    async onOpen() {
        const { contentEl, modalEl } = this; // 获取 modalEl 以便控制全屏类
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

                /* 全屏模式样式 */
                .modal-container.mod-diff-fullscreen .modal {
                    width: 100vw !important;
                    height: 100vh !important;
                    max-width: 100vw !important;
                    max-height: 100vh !important;
                    margin: 0 !important;
                    border-radius: 0 !important;
                    top: 0 !important;
                    left: 0 !important;
                    padding: 15px !important;
                    display: flex;
                    flex-direction: column;
                }
                .modal-container.mod-diff-fullscreen .modal-content {
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                    padding: 0;
                    margin: 0;
                }
                .modal-container.mod-diff-fullscreen .diff-main-container {
                    flex-grow: 1;
                    overflow: hidden; /* 让内部滚动 */
                }
                .modal-container.mod-diff-fullscreen .diff-container {
                    height: 100%;
                    max-height: none !important;
                }

                /* 专注模式：隐藏头部元素 */
                .diff-modal.focus-mode .diff-version-selector-container,
                .diff-modal.focus-mode .diff-info-banner-compact {
                    display: none !important;
                }

                /* 基础 Diff 行布局调整 (原有样式) */
                .diff-line {
                    display: flex !important;
                    align-items: stretch !important; /* 让高度拉伸以适应内容 */
                    flex-direction: row !important;
                    padding-left: 0 !important; /* 移除原有 padding，交给 gutter */
                }

                /* 新的侧边栏容器 (Gutter) */
                .diff-gutter-column {
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    align-items: center;
                    min-width: 48px; /* 调整宽度以容纳两排 */
                    padding: 2px 4px;
                    background-color: var(--background-secondary);
                    border-right: 1px solid var(--background-modifier-border);
                    margin-right: 8px;
                    flex-shrink: 0;
                    user-select: none;
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

                /* 按钮样式微调 */
                .diff-line-action-btn, .diff-line-history-btn {
                    cursor: pointer;
                    display: inline-block;
                }
                .diff-line-action-btn:hover, .diff-line-history-btn:hover {
                    color: var(--text-accent);
                    transform: scale(1.1);
                }

                /* 内容区域微调，使其垂直居中或顶部对齐 */
                .diff-line .line-content {
                    padding-top: 4px;
                    padding-bottom: 4px;
                    flex-grow: 1;
                    word-break: break-all;
                }

                /* 标记符号 (+/-) 的位置 */
                .diff-line .diff-marker {
                    margin-right: 6px;
                    opacity: 0.5;
                    font-family: var(--font-monospace);
                    align-self: center;
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
                    .is-mobile .diff-line.actions-visible .diff-line-action-btn {
                        position: static !important;
                        display: inline-flex !important;
                        margin: 0 2px !important;
                    }
                `;
                contentEl.appendChild(style);
            }
        }

        window.addEventListener('resize', this.resizeHandler);

        // --------------------------------------------------------
        // 新增：构建自定义标题栏 (包含全屏按钮和文件路径)
        // --------------------------------------------------------
        const headerContainer = contentEl.createEl('div', { cls: 'diff-modal-header' });

        const titleGroup = headerContainer.createEl('div', { cls: 'diff-modal-title-group' });
        titleGroup.createEl('h2', { text: '📊 版本差异对比', cls: 'diff-modal-title' });
        // 添加文件路径显示
        titleGroup.createEl('div', { text: this.file.path, cls: 'diff-file-path', attr: { title: this.file.path } });

        const headerActions = headerContainer.createEl('div', { cls: 'diff-header-actions' });

        // 添加全屏按钮
        const fullscreenBtn = headerActions.createEl('button', {
            cls: 'diff-fullscreen-btn',
            attr: { 'aria-label': '切换全屏', 'title': '切换全屏' }
        });
        fullscreenBtn.innerHTML = '⛶'; // 使用 Unicode 图标或 Obsidian Icon
        fullscreenBtn.addEventListener('click', () => {
            this.toggleFullscreen();
            fullscreenBtn.innerHTML = this.isFullscreen ? '↙' : '⛶'; // 切换图标
        });

        // --------------------------------------------------------

        const controlsContainer = contentEl.createEl('div');
        const mainContainer = contentEl.createEl('div', { cls: 'diff-main-container' });
        this.textDiffContainer = mainContainer.createEl('div', { cls: 'diff-container' });

        this.loadingOverlay = mainContainer.createEl('div', { cls: 'diff-loading-overlay', attr: { style: 'display: none;' } });
        this.loadingOverlay.createEl('div', { text: '正在加载新版本...', cls: 'diff-loading-message' });

        try {
            this.allVersions = await this.plugin.getAllVersions(this.file.path);
        } catch (error) {
            new Notice('❌ 加载版本列表失败');
            this.close();
            return;
        }

        this.renderVersionSelectors(controlsContainer);

        this.infoBannerContainer = controlsContainer.createEl('div', { cls: 'diff-info-banner-compact' });

        const toolbar = controlsContainer.createEl('div', { cls: 'diff-toolbar-redesigned' });

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

            // Removed Smart Word Mode menu item

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

            // 新增：专注模式开关
            menu.addItem(item => item.setTitle('专注模式 (隐藏头部)')
                .setChecked(this.isFocusMode)
                .setIcon('eye-off')
                .onClick(() => {
                    this.toggleFocusMode();
                }));

            menu.addSeparator();

            const isLineBased = this.currentGranularity === 'line';
            const isWordCharBased = this.currentGranularity === 'char' || this.currentGranularity === 'word';

            const lineNumAndMoveEnabled = isLineBased;

            const lineNumTitle = '显示行号' + (!lineNumAndMoveEnabled ? ' (仅行模式可用)' : '');
            const moveDetectTitle = '检测移动' + (!lineNumAndMoveEnabled ? ' (仅行模式可用)' : '');

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
                .setDisabled(!lineNumAndMoveEnabled)
                .onClick(() => {
                    if (lineNumAndMoveEnabled) {
                        this.showLineNumbers = !this.showLineNumbers;
                        this.renderTextDiff();
                    }
                }));

            menu.addItem(item => item.setTitle('忽略空白').setChecked(this.ignoreWhitespace).onClick(() => { this.ignoreWhitespace = !this.ignoreWhitespace; this.renderTextDiff(); }));
            menu.addItem(item => item.setTitle('显示空白').setChecked(this.showWhitespace).onClick(() => { this.showWhitespace = !this.showWhitespace; this.renderTextDiff(); }));

            menu.addItem(item => item
                .setTitle(moveDetectTitle)
                .setChecked(this.enableMoveDetection)
                .setDisabled(!lineNumAndMoveEnabled)
                .onClick(() => {
                    if (lineNumAndMoveEnabled) {
                        this.enableMoveDetection = !this.enableMoveDetection;
                        this.renderTextDiff();
                    }
                }));

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

            menu.addSeparator();
            menu.addItem(item => item.setTitle('展开所有').setIcon('chevrons-down-up').onClick(() => { this.collapsedSections.clear(); this.renderTextDiff(); }));
            menu.addItem(item => item.setTitle('折叠所有').setIcon('chevrons-up-down').onClick(() => {
                const collapseBtns = this.textDiffContainer.querySelectorAll('.diff-collapse-btn');
                collapseBtns.forEach((btn, idx) => this.collapsedSections.add(idx as number));
                this.renderTextDiff();
            }));

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

    // 新增：切换全屏状态的方法
    toggleFullscreen() {
        this.isFullscreen = !this.isFullscreen;
        // 获取 Modal 的最外层容器（通常是 .modal-container 或 .modal-bg 的父级，或者直接控制 .modal-container）
        // 在 Obsidian 中，Modal 通常被包裹在 .modal-container 中
        const container = this.modalEl.parentElement;
        if (container) {
            if (this.isFullscreen) {
                container.addClass('mod-diff-fullscreen');
            } else {
                container.removeClass('mod-diff-fullscreen');
            }
        }
        // 触发 resize 以重新计算分栏对齐
        this.resizeHandler();
    }

    // 新增：切换专注模式的方法
    toggleFocusMode() {
        this.isFocusMode = !this.isFocusMode;
        if (this.isFocusMode) {
            this.contentEl.addClass('focus-mode');
            new Notice("进入专注模式：头部已隐藏");
        } else {
            this.contentEl.removeClass('focus-mode');
        }
        this.resizeHandler();
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
            if (lineNumber < 1) {
                 new Notice('❌ 无效的行号');
                 return;
            }

            const currentContent = await this.app.vault.read(this.file);
            const lines = currentContent.split('\n');

            const insertIndex = lineNumber - 1;

            if (insertIndex > lines.length) {
                lines.push(content);
            } else {
                lines.splice(insertIndex, 0, content);
            }

            await this.app.vault.modify(this.file, lines.join('\n'));
            new Notice('✅ 已应用更改');
            await this.updateDiffView();
        } catch (error) {
            new Notice('❌ 应用更改失败');
            console.error(error);
        }
    }

    async revertChanges(newContent: string, lineNumber: number, oldContent: string | null = null) {
        if (this.secondVersionId !== 'current') return;

        try {
            const currentContent = await this.app.vault.read(this.file);
            let lines = currentContent.split('\n');

            const targetIndex = lineNumber - 1;

            if (targetIndex < 0 || targetIndex >= lines.length) {
                new Notice("❌ 无法撤销：行号超出范围，请刷新视图。");
                return;
            }

            if (lines[targetIndex] !== newContent) {
                console.warn(`撤销内容不匹配: 期望 "${newContent}", 实际 "${lines[targetIndex]}"`);
            }

            if (oldContent !== null) {
                lines[targetIndex] = oldContent;
            } else {
                lines.splice(targetIndex, 1);
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

        } catch (error) {
            console.error("加载差异失败:", error);
            new Notice('❌ 加载版本内容失败');
        } finally {
            this.loadingOverlay.style.display = 'none';
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
            const leftLabelEl = this.containerEl.querySelector('#diff-left-version-btn') as HTMLElement;
            const rightLabelEl = this.containerEl.querySelector('#diff-right-version-btn') as HTMLElement;
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

        const diffResult = Diff.diffLines(leftProcessed, rightProcessed, { ignoreWhitespace: this.ignoreWhitespace });
        let addedLines = 0;
        let removedLines = 0;
        let modifiedLines = 0;

        const useCompact = this.plugin.settings.compactUnifiedDiff;

        for (let i = 0; i < diffResult.length; i++) {
            const part = diffResult[i];
            const nextPart = diffResult[i + 1];

            if (useCompact && part.removed && nextPart && nextPart.added) {
                 const remCount = part.count || 0;
                 const addCount = nextPart.count || 0;

                 const overlap = Math.min(remCount, addCount);

                 modifiedLines += overlap;
                 removedLines += (remCount - overlap);
                 addedLines += (addCount - overlap);

                 i++;
            } else {
                if (part.added) {
                    addedLines += part.count || 0;
                } else if (part.removed) {
                    removedLines += part.count || 0;
                }
            }
        }

        const totalLines = this.leftContent.split('\n').length;
        const totalChangesCount = addedLines + removedLines + modifiedLines;
        const changePercent = totalLines > 0 ? ((totalChangesCount / totalLines) * 100).toFixed(1) : '0';

        container.createEl('span', { text: `📊 总行数: ${totalLines}`, cls: 'diff-info-item' });

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
        const diffResult = Diff.diffLines(this.leftContent, this.rightContent, { ignoreWhitespace: this.ignoreWhitespace });
        let addedLines = 0;
        let removedLines = 0;
        let modifiedLines = 0;
        let addedChars = 0;
        let removedChars = 0;

        const useCompact = this.plugin.settings.compactUnifiedDiff;

        for (let i = 0; i < diffResult.length; i++) {
            const part = diffResult[i];
            const nextPart = diffResult[i + 1];

             if (useCompact && part.removed && nextPart && nextPart.added) {
                const remCount = (part.value.match(/\n/g) || []).length;
                const addCount = (nextPart.value.match(/\n/g) || []).length;

                const overlap = Math.min(remCount, addCount);
                modifiedLines += overlap;
                removedLines += (remCount - overlap);
                addedLines += (addCount - overlap);

                removedChars += part.value.length;
                addedChars += nextPart.value.length;

                i++;
            } else {
                if (part.added) {
                    addedLines += (part.value.match(/\n/g) || []).length;
                    addedChars += part.value.length;
                } else if (part.removed) {
                    removedLines += (part.value.match(/\n/g) || []).length;
                    removedChars += part.value.length;
                }
            }
        }

        const leftLines = this.leftContent.split('\n').length;
        const rightLines = this.rightContent.split('\n').length;
        const similarity = this.calculateSimilarity(this.leftContent, this.rightContent);

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

    calculateSimilarity(text1: string, text2: string): number {
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

    exportDiffReport() {
        try {
            const diffResult = Diff.diffLines(this.leftContent, this.rightContent, { ignoreWhitespace: this.ignoreWhitespace });
            let report = `# 版本差异报告\n\n`;
            report += `**文件**: ${this.file.path}\n`;
            report += `**生成时间**: ${new Date().toLocaleString('zh-CN')}\n\n`;

            const versions = this.allVersions; // Access cached versions
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
            this.app.vault.create(fileName, report);
            new Notice(`✅ 差异报告已导出: ${fileName}`);
        } catch (error) {
            console.error('导出差异报告失败:', error);
            new Notice('❌ 导出失败');
        }
    }

    renderUnifiedDiff(container: HTMLElement, left: string, right: string) {
        if (this.currentGranularity === 'char' || this.currentGranularity === 'word') {
            const diffFn = this.currentGranularity === 'char'
                ? Diff.diffChars
                : Diff.diffWordsWithSpace;

            const diffResult = diffFn(left, right);

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

        const diffResult = Diff.diffLines(left, right, { ignoreWhitespace: this.ignoreWhitespace });
        const processedDiff: ProcessedDiff[] = this.enableMoveDetection
            ? this.processDiffForMoves(diffResult)
            : diffResult.map(part => ({ ...part, type: (part.added ? 'added' : part.removed ? 'removed' : 'context') as any }));

        let leftLineNum = 1;
        let rightLineNum = 1;
        let diffIdx = 0;

        const useCompactView = this.plugin.settings.compactUnifiedDiff;

        // 修改 secondaryDiffFn 的获取逻辑，添加类型转换和默认处理
        const secondaryDiffFn = (text1: string, text2: string): Diff.Change[] => {
             if (this.plugin.settings.inlineDiffAlgorithm === 'line') {
                 return Diff.diffLines(text1, text2);
             } else if (this.plugin.settings.inlineDiffAlgorithm === 'char') {
                 // @ts-ignore: Fix TS2554 expecting options/callback
                 return Diff.diffChars(text1, text2);
             } else {
                 // @ts-ignore: Fix TS2554
                 return Diff.diffWordsWithSpace(text1, text2);
             }
        };

        const createHighlightedFragment = (diffParts: Diff.Change[], includeRemoved: boolean = true): DocumentFragment => {
            const fragment = document.createDocumentFragment();
            // 确保 diffParts 是数组
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

        const renderLine = (content: string | DocumentFragment, type: ProcessedDiff['type'], lineNumLeft: number | null, lineNumRight: number | null, moveId?: number, oldContentForRevert: string | null = null) => {
            const lineEl = container.createEl('div', { cls: `diff-line diff-${type}` });

            if (type === 'added') lineEl.addClass('diff-line-bg-added');
            else if (type === 'removed') lineEl.addClass('diff-line-bg-removed');
            else if (type === 'modified') lineEl.addClass('diff-line-bg-modified');

            if (type !== 'context') {
                lineEl.dataset.diffIndex = String(diffIdx++);
                this.diffElements.push(lineEl);
            }
            if (moveId !== undefined) lineEl.dataset.moveId = String(moveId);
            if (lineNumLeft) lineEl.dataset.lineNumberLeft = String(lineNumLeft);
            if (lineNumRight) lineEl.dataset.lineNumberRight = String(lineNumRight);

            const gutterCol = lineEl.createEl('div', { cls: 'diff-gutter-column' });

            const numsRow = gutterCol.createEl('div', { cls: 'diff-gutter-nums' });
            if (this.showLineNumbers) {
                if (lineNumLeft) numsRow.createEl('span', { text: String(lineNumLeft) });
                if (lineNumLeft && lineNumRight) numsRow.createEl('span', { text: '|', attr: {style: 'opacity:0.3'} });
                if (lineNumRight) numsRow.createEl('span', { text: String(lineNumRight) });
            }

            const opsRow = gutterCol.createEl('div', { cls: 'diff-gutter-ops' });
            const historyBtn = opsRow.createEl('span', { text: '📜', cls: 'diff-line-history-btn', attr: { 'aria-label': '查看行历史', 'title': '查看行历史' } });
            historyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showLineHistory(typeof content === 'string' ? content : content.textContent || '');
            });

            if (this.secondVersionId === 'current') {
                if (type === 'added' || (type === 'modified' && lineNumRight)) {
                    const revertBtn = opsRow.createEl('span', { text: '↩️', cls: 'diff-line-action-btn', attr: { 'aria-label': '撤销此更改', 'title': '撤销更改' } });
                    const newContent = typeof content === 'string' ? content : (content.textContent || '');
                    revertBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.revertChanges(newContent, lineNumRight!, oldContentForRevert);
                    });
                }
                if (type === 'removed' && !lineNumRight) {
                    const applyBtn = opsRow.createEl('span', { text: '📥', cls: 'diff-line-action-btn', attr: { 'aria-label': '恢复此行', 'title': '恢复内容' } });
                    applyBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.applyChanges(typeof content === 'string' ? content : content.textContent || '', lineNumRight || rightLineNum);
                    });
                }
            }

            let marker = ' ';
            if (type === 'added') marker = '+';
            else if (type === 'removed') marker = '-';
            else if (type === 'moved-from') marker = '⮫';
            else if (type === 'moved-to') marker = '⮪';
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
            const part = processedDiff[i];
            const nextPart = processedDiff[i + 1];

            if (part.removed && nextPart && nextPart.added) {
                const leftLines = part.value.replace(/\n$/, '').split('\n');
                const rightLines = nextPart.value.replace(/\n$/, '').split('\n');

                if (useCompactView) {
                    let lIndex = 0;
                    let rIndex = 0;

                    while (lIndex < leftLines.length || rIndex < rightLines.length) {
                        const lLine = leftLines[lIndex];
                        const rLine = rightLines[rIndex];

                        if (lLine === undefined) {
                            renderLine(rLine, 'added', null, rightLineNum++, undefined, null);
                            rIndex++;
                            continue;
                        }

                        if (rLine === undefined) {
                            renderLine(lLine, 'removed', leftLineNum++, null);
                            lIndex++;
                            continue;
                        }

                        const currentSim = this.calculateSimilarity(lLine, rLine);

                        const nextRightLine = rightLines[rIndex + 1];
                        const insertionSim = nextRightLine ? this.calculateSimilarity(lLine, nextRightLine) : 0;

                        const nextLeftLine = leftLines[lIndex + 1];
                        const deletionSim = nextLeftLine ? this.calculateSimilarity(nextLeftLine, rLine) : 0;

                        const threshold = 30;

                        if (insertionSim > currentSim + threshold) {
                            renderLine(rLine, 'added', null, rightLineNum++, undefined, null);
                            rIndex++;
                        } else if (deletionSim > currentSim + threshold) {
                            renderLine(lLine, 'removed', leftLineNum++, null);
                            lIndex++;
                        } else {
                            const lineDiff = secondaryDiffFn(lLine, rLine);

                            const combinedFrag = createHighlightedFragment(lineDiff, true);

                            renderLine(combinedFrag, 'modified', leftLineNum++, rightLineNum++, undefined, lLine);
                            lIndex++;
                            rIndex++;
                        }
                    }
                }
                else if (leftLines.length === rightLines.length) {
                    const minLen = Math.min(leftLines.length, rightLines.length);
                    for (let j = 0; j < minLen; j++) {
                        const oldLine = leftLines[j];
                        const newLine = rightLines[j];
                        const lineDiff = secondaryDiffFn(oldLine, newLine);

                        // 显式类型处理，避免隐式 any 和 undefined 错误
                        const leftFrag = createHighlightedFragment((lineDiff || []).filter((p: Diff.Change) => !p.added), true);
                        renderLine(leftFrag, 'removed', leftLineNum++, null);

                        const rightFrag = createHighlightedFragment((lineDiff || []).filter((p: Diff.Change) => !p.removed), false);
                        renderLine(rightFrag, 'added', null, rightLineNum++, undefined, oldLine);
                    }
                } else {
                    leftLines.forEach(line => renderLine(line, 'removed', leftLineNum++, null));
                    rightLines.forEach(line => renderLine(line, 'added', null, rightLineNum++, undefined, null));
                }
                i++;
            } else {
                const lines = part.value.replace(/\n$/, '').split('\n');

                if (part.type === 'context') {
                   const prevPartIsChange = i > 0 && processedDiff[i - 1].type !== 'context';
                   const nextPartIsChange = i < processedDiff.length - 1 && processedDiff[i + 1].type !== 'context';

                   let lastLineShown = -1;
                   for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                        const line = lines[lineIdx];
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
                        if (part.type === 'moved-from') renderLine(line, 'moved-from', leftLineNum++, null, part.moveId);
                        else if (part.type === 'moved-to') renderLine(line, 'moved-to', null, rightLineNum++, part.moveId);
                        else if (part.added) renderLine(line, 'added', null, rightLineNum++, undefined, null);
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
            const diffFn = this.currentGranularity === 'char'
                ? Diff.diffChars
                : Diff.diffWordsWithSpace;

            const diffResult = diffFn(leftText, rightText);
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

        const rawDiff = Diff.diffLines(leftText, rightText, { ignoreWhitespace: this.ignoreWhitespace });
        const diff: ProcessedDiff[] = this.enableMoveDetection
            ? this.processDiffForMoves(rawDiff)
            : rawDiff.map(p => ({ ...p, type: p.added ? 'added' : p.removed ? 'removed' : 'context' }));

        let leftLineNum = 1;
        let rightLineNum = 1;
        let diffIdx = 0;

        // 修改 secondaryDiffFn 的获取逻辑，添加类型转换和默认处理
        const secondaryDiffFn = (text1: string, text2: string): Diff.Change[] => {
            if (this.plugin.settings.inlineDiffAlgorithm === 'line') {
                return Diff.diffLines(text1, text2);
            } else if (this.plugin.settings.inlineDiffAlgorithm === 'char') {
                // @ts-ignore: Fix TS2554 expecting options/callback
                return Diff.diffChars(text1, text2);
            } else {
                // @ts-ignore: Fix TS2554
                return Diff.diffWordsWithSpace(text1, text2);
            }
        };

        const createHighlightedFragment = (diffParts: Diff.Change[]): DocumentFragment => {
            const fragment = document.createDocumentFragment();
            // 确保 diffParts 是数组
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

        const renderLine = (panel: HTMLElement, content: string | DocumentFragment, type: string, lineNum: number | null, moveId?: number, oldContentForRevert: string | null = null) => {
            const lineEl = panel.createEl('div', { cls: `diff-line diff-${type}` });

            if (type === 'added') lineEl.addClass('diff-line-bg-added');
            else if (type === 'removed') lineEl.addClass('diff-line-bg-removed');
            else if (type === 'modified') lineEl.addClass('diff-line-bg-modified');

            if (type !== 'context' && type !== 'placeholder') {
                lineEl.dataset.diffIndex = String(diffIdx++);
                this.diffElements.push(lineEl);
            }
            if (lineNum) lineEl.dataset.lineNumber = String(lineNum);
            if (moveId !== undefined) lineEl.dataset.moveId = String(moveId);

            const gutterCol = lineEl.createEl('div', { cls: 'diff-gutter-column' });

            const numsRow = gutterCol.createEl('div', { cls: 'diff-gutter-nums' });
            if (this.showLineNumbers) {
                numsRow.createEl('span', { text: lineNum ? String(lineNum) : '' });
            }

            const opsRow = gutterCol.createEl('div', { cls: 'diff-gutter-ops' });

            if (type !== 'placeholder') {
                const historyBtn = opsRow.createEl('span', { text: '📜', cls: 'diff-line-history-btn', attr: { 'aria-label': '查看行历史', 'title': '查看行历史' } });
                historyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.showLineHistory(typeof content === 'string' ? content : content.textContent || '');
                });

                if (this.secondVersionId === 'current') {
                    const isRightPanel = panel === rightPanel;
                    if (isRightPanel && (type === 'added' || type === 'modified')) {
                        const revertBtn = opsRow.createEl('span', { text: '↩️', cls: 'diff-line-action-btn', attr: { 'aria-label': '撤销此更改', 'title': '撤销更改' } });
                        const newContent = typeof content === 'string' ? content : (content.textContent || '');
                        revertBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            this.revertChanges(newContent, lineNum!, oldContentForRevert);
                        });
                    }
                    if (!isRightPanel && (type === 'removed' || type === 'modified')) {
                        const applyBtn = opsRow.createEl('span', { text: '📥', cls: 'diff-line-action-btn', attr: { 'aria-label': '应用此更改', 'title': '恢复内容' } });
                        applyBtn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            this.applyChanges(typeof content === 'string' ? content : content.textContent || '', rightLineNum);
                        });
                    }
                }
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
                        const lineDiff = secondaryDiffFn(leftLine, rightLine);
                        // 显式类型处理
                        const leftFrag = createHighlightedFragment((lineDiff || []).filter((p: Diff.Change) => !p.added));
                        const rightFrag = createHighlightedFragment((lineDiff || []).filter((p: Diff.Change) => !p.removed));
                        renderLine(leftPanel, leftFrag, 'modified', leftLineNum++);
                        renderLine(rightPanel, rightFrag, 'modified', rightLineNum++, undefined, leftLine);
                    } else if (leftLine !== undefined) {
                        renderLine(leftPanel, leftLine, 'removed', leftLineNum++);
                        renderLine(rightPanel, '', 'placeholder', null);
                    } else if (rightLine !== undefined) {
                        renderLine(leftPanel, '', 'placeholder', null);
                        renderLine(rightPanel, rightLine, 'added', rightLineNum++, undefined, null); // Fix: oldLine -> null
                    }
                }
                i++;
            } else if (part.type === 'moved-from') {
                const lines = part.value.replace(/\n$/, '').split('\n');
                for (const line of lines) {
                    renderLine(leftPanel, line, 'moved-from', leftLineNum++, part.moveId);
                    renderLine(rightPanel, '', 'placeholder', null);
                }
            } else if (part.type === 'moved-to') {
                const lines = part.value.replace(/\n$/, '').split('\n');
                for (const line of lines) {
                    renderLine(leftPanel, '', 'placeholder', null);
                    renderLine(rightPanel, line, 'moved-to', rightLineNum++, part.moveId);
                }
            } else if (part.added) {
                const lines = part.value.replace(/\n$/, '').split('\n');
                for (const line of lines) {
                    renderLine(leftPanel, '', 'placeholder', null);
                    renderLine(rightPanel, line, 'added', rightLineNum++, part.moveId, null);
                }
            } else if (part.removed) {
                const lines = part.value.replace(/\n$/, '').split('\n');
                for (const line of lines) {
                    renderLine(leftPanel, line, 'removed', leftLineNum++, part.moveId);
                    renderLine(rightPanel, '', 'placeholder', null);
                }
            } else {
                const lines = part.value.replace(/\n$/, '').split('\n');
                const prevPartIsChange = i > 0 && diff[i - 1].type !== 'context';
                const nextPartIsChange = i < diff.length - 1 && diff[i + 1].type !== 'context';

                let lastLineShown = -1;
                for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                    const line = lines[lineIdx];
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

    onClose() {
        window.removeEventListener('resize', this.resizeHandler);
        const { contentEl } = this;
        contentEl.empty();
    }
}

export class VersionSelectModal extends Modal {
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

        // 选项：当前文件
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

export class ContextLineInputModal extends Modal {
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

export class LineHistoryModal extends Modal {
    plugin: VersionControlPlugin;
    file: TFile;
    lineText: string;
    matchingVersions: VersionData[];

    constructor(app: App, plugin: VersionControlPlugin, file: TFile, lineText: string, matchingVersions: VersionData[]) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.lineText = lineText;
        this.matchingVersions = matchingVersions;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('line-history-modal');
        contentEl.createEl('h2', { text: '📜 行历史记录' });

        const textPreview = contentEl.createEl('div', {
            cls: 'line-text-preview',
            text: this.lineText.length > 100 ? this.lineText.substring(0, 100) + '...' : this.lineText,
            attr: { style: 'padding: 10px; background: var(--background-secondary); font-family: var(--font-monospace); margin-bottom: 15px; border-radius: 4px;' }
        });

        contentEl.createEl('p', { text: `共在 ${this.matchingVersions.length} 个版本中找到此行内容:` });

        const listContainer = contentEl.createEl('div', { cls: 'line-history-list', attr: { style: 'max-height: 400px; overflow-y: auto;' } });

        this.matchingVersions.forEach(v => {
            const item = listContainer.createEl('div', { cls: 'version-item', attr: { style: 'padding: 10px; border-bottom: 1px solid var(--background-modifier-border); display: flex; justify-content: space-between; align-items: center;' } });

            const info = item.createEl('div');
            const timeRow = info.createEl('div', { attr: { style: 'font-weight: bold;' } });
            timeRow.createEl('span', { text: this.plugin.formatTime(v.timestamp) });
            if (v.starred) timeRow.createEl('span', { text: ' ⭐' });

            info.createEl('div', { text: v.message, attr: { style: 'color: var(--text-muted); font-size: 0.9em;' } });

            const btn = item.createEl('button', { text: '查看' });
            btn.addEventListener('click', () => {
                this.close();
                new DiffModal(this.app, this.plugin, this.file, v.id).open();
            });
        });

        const closeBtn = contentEl.createEl('div', { cls: 'modal-button-container', attr: { style: 'margin-top: 15px;' } });
        closeBtn.createEl('button', { text: '关闭' }).addEventListener('click', () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }
}
