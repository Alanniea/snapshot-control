import { 
  App, 
  Plugin, 
  PluginSettingTab, 
  Setting, 
  TFile, 
  Notice, 
  Modal,
  ItemView,
  WorkspaceLeaf,
  Menu
} from 'obsidian';
import * as Diff from 'diff';

// 插件设置接口
interface VersionControlSettings {
  storageLocation: 'vault' | 'custom';
  customStoragePath: string;
  autoSaveInterval: number; // 分钟
  maxVersionCount: number;
  retentionDays: number;
  cleanupStrategy: 'days-first' | 'count-first' | 'both';
}

// 默认设置
const DEFAULT_SETTINGS: VersionControlSettings = {
  storageLocation: 'vault',
  customStoragePath: '',
  autoSaveInterval: 5,
  maxVersionCount: 50,
  retentionDays: 30,
  cleanupStrategy: 'both'
};

// 版本数据接口
interface Version {
  id: string;
  timestamp: number;
  content: string;
  message: string;
  size: number;
  isManual: boolean;
}

// 文件版本历史接口
interface FileVersionHistory {
  filePath: string;
  versions: Version[];
}

const VERSION_VIEW_TYPE = 'version-history-view';

// 版本历史视图
class VersionHistoryView extends ItemView {
  plugin: VersionControlPlugin;
  currentFile: TFile | null = null;
  selectedVersions: Set<string> = new Set();

  constructor(leaf: WorkspaceLeaf, plugin: VersionControlPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VERSION_VIEW_TYPE;
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

    // 监听活动文件变化
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.updateView();
      })
    );

    this.updateView();
  }

  async updateView() {
    const container = this.containerEl.children[1];
    container.empty();

    const activeFile = this.app.workspace.getActiveFile();
    this.currentFile = activeFile;

    if (!activeFile) {
      container.createEl('div', { 
        text: '请打开一个文件以查看版本历史',
        cls: 'version-empty-state'
      });
      return;
    }

    // 标题和操作按钮
    const header = container.createEl('div', { cls: 'version-header' });
    header.createEl('h4', { text: `${activeFile.name} 的版本历史` });

    const buttonGroup = header.createEl('div', { cls: 'version-button-group' });
    
    const createBtn = buttonGroup.createEl('button', { 
      text: '创建版本',
      cls: 'mod-cta'
    });
    createBtn.addEventListener('click', () => {
      new CreateVersionModal(this.app, this.plugin, activeFile).open();
    });

    const deleteBtn = buttonGroup.createEl('button', { 
      text: '批量删除',
      cls: 'mod-warning'
    });
    deleteBtn.addEventListener('click', () => {
      this.batchDelete();
    });

    // 版本列表
    const history = await this.plugin.getFileHistory(activeFile.path);
    
    if (!history || history.versions.length === 0) {
      container.createEl('div', { 
        text: '暂无版本历史',
        cls: 'version-empty-state'
      });
      return;
    }

    const versionList = container.createEl('div', { cls: 'version-list' });

    // 按时间倒序显示
    const sortedVersions = [...history.versions].sort((a, b) => b.timestamp - a.timestamp);

    sortedVersions.forEach((version, index) => {
      const versionItem = versionList.createEl('div', { cls: 'version-item' });

      // 选择框
      const checkbox = versionItem.createEl('input', { type: 'checkbox' });
      checkbox.addEventListener('change', (e) => {
        if ((e.target as HTMLInputElement).checked) {
          this.selectedVersions.add(version.id);
        } else {
          this.selectedVersions.delete(version.id);
        }
      });

      // 版本信息
      const versionInfo = versionItem.createEl('div', { cls: 'version-info' });
      
      const timeEl = versionInfo.createEl('div', { cls: 'version-time' });
      timeEl.createEl('strong', { text: new Date(version.timestamp).toLocaleString('zh-CN') });
      
      if (index === 0) {
        timeEl.createEl('span', { text: ' (最新)', cls: 'version-badge' });
      }

      const messageEl = versionInfo.createEl('div', { cls: 'version-message' });
      messageEl.setText(version.message || (version.isManual ? '手动保存' : '[Auto Save]'));

      const metaEl = versionInfo.createEl('div', { cls: 'version-meta' });
      metaEl.setText(`大小: ${this.formatSize(version.size)} | ID: ${version.id.substring(0, 8)}`);

      // 操作按钮
      const actions = versionItem.createEl('div', { cls: 'version-actions' });

      const restoreBtn = actions.createEl('button', { text: '恢复', cls: 'mod-cta' });
      restoreBtn.addEventListener('click', () => {
        new RestoreConfirmModal(this.app, this.plugin, activeFile, version).open();
      });

      const compareBtn = actions.createEl('button', { text: '与当前比较' });
      compareBtn.addEventListener('click', async () => {
        await this.plugin.showDiff(activeFile, 'current', version.id);
      });

      const moreBtn = actions.createEl('button', { text: '•••' });
      moreBtn.addEventListener('click', (e) => {
        const menu = new Menu();
        
        menu.addItem((item) => {
          item.setTitle('与其他版本比较')
            .setIcon('git-compare')
            .onClick(() => {
              new CompareVersionModal(this.app, this.plugin, activeFile, version).open();
            });
        });

        menu.addItem((item) => {
          item.setTitle('删除此版本')
            .setIcon('trash')
            .onClick(async () => {
              await this.plugin.deleteVersion(activeFile.path, version.id);
              this.updateView();
            });
        });

        menu.showAtMouseEvent(e);
      });
    });
  }

  async batchDelete() {
    if (this.selectedVersions.size === 0) {
      new Notice('请先选择要删除的版本');
      return;
    }

    if (!this.currentFile) return;

    const confirmed = await new Promise((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.setText('确认批量删除');
      modal.contentEl.setText(`确定要删除选中的 ${this.selectedVersions.size} 个版本吗？此操作不可恢复。`);
      
      const buttonGroup = modal.contentEl.createEl('div', { cls: 'modal-button-group' });
      
      const cancelBtn = buttonGroup.createEl('button', { text: '取消' });
      cancelBtn.addEventListener('click', () => {
        modal.close();
        resolve(false);
      });

      const confirmBtn = buttonGroup.createEl('button', { text: '确认删除', cls: 'mod-warning' });
      confirmBtn.addEventListener('click', () => {
        modal.close();
        resolve(true);
      });

      modal.open();
    });

    if (!confirmed) return;

    for (const versionId of this.selectedVersions) {
      await this.plugin.deleteVersion(this.currentFile.path, versionId);
    }

    this.selectedVersions.clear();
    new Notice(`已删除 ${this.selectedVersions.size} 个版本`);
    this.updateView();
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  async onClose() {
    // 清理
  }
}

// 创建版本对话框
class CreateVersionModal extends Modal {
  plugin: VersionControlPlugin;
  file: TFile;
  message: string = '';

  constructor(app: App, plugin: VersionControlPlugin, file: TFile) {
    super(app);
    this.plugin = plugin;
    this.file = file;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: '创建新版本' });

    const inputContainer = contentEl.createEl('div', { cls: 'version-input-container' });
    inputContainer.createEl('label', { text: '提交信息:' });
    
    const textarea = inputContainer.createEl('textarea', { 
      placeholder: '描述此版本的变更内容...',
      cls: 'version-message-input'
    });
    textarea.addEventListener('input', (e) => {
      this.message = (e.target as HTMLTextAreaElement).value;
    });

    const buttonGroup = contentEl.createEl('div', { cls: 'modal-button-group' });
    
    const cancelBtn = buttonGroup.createEl('button', { text: '取消' });
    cancelBtn.addEventListener('click', () => this.close());

    const createBtn = buttonGroup.createEl('button', { text: '创建', cls: 'mod-cta' });
    createBtn.addEventListener('click', async () => {
      await this.plugin.createManualVersion(this.file, this.message);
      new Notice('版本创建成功');
      this.close();
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// 恢复确认对话框
class RestoreConfirmModal extends Modal {
  plugin: VersionControlPlugin;
  file: TFile;
  version: Version;

  constructor(app: App, plugin: VersionControlPlugin, file: TFile, version: Version) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.version = version;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: '⚠️ 确认恢复版本', cls: 'version-warning-title' });

    const warning = contentEl.createEl('div', { cls: 'version-warning-box' });
    warning.createEl('p', { 
      text: '警告：恢复到此版本将会覆盖当前文件内容！',
      cls: 'version-warning-text'
    });
    warning.createEl('p', { 
      text: '当前未保存的所有修改将会丢失，此操作不可撤销。',
      cls: 'version-warning-text'
    });

    const info = contentEl.createEl('div', { cls: 'version-restore-info' });
    info.createEl('p', { text: `目标版本: ${new Date(this.version.timestamp).toLocaleString('zh-CN')}` });
    info.createEl('p', { text: `提交信息: ${this.version.message}` });

    const buttonGroup = contentEl.createEl('div', { cls: 'modal-button-group' });
    
    const cancelBtn = buttonGroup.createEl('button', { text: '取消' });
    cancelBtn.addEventListener('click', () => this.close());

    const confirmBtn = buttonGroup.createEl('button', { text: '确认恢复', cls: 'mod-warning' });
    confirmBtn.addEventListener('click', async () => {
      await this.plugin.restoreVersion(this.file, this.version.id);
      new Notice('版本恢复成功');
      this.close();
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// 版本比较选择对话框
class CompareVersionModal extends Modal {
  plugin: VersionControlPlugin;
  file: TFile;
  baseVersion: Version;

  constructor(app: App, plugin: VersionControlPlugin, file: TFile, baseVersion: Version) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.baseVersion = baseVersion;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: '选择比较版本' });

    const info = contentEl.createEl('p', { 
      text: `基础版本: ${new Date(this.baseVersion.timestamp).toLocaleString('zh-CN')}`
    });

    const history = await this.plugin.getFileHistory(this.file.path);
    if (!history) return;

    const select = contentEl.createEl('select', { cls: 'version-select' });
    
    history.versions
      .filter(v => v.id !== this.baseVersion.id)
      .sort((a, b) => b.timestamp - a.timestamp)
      .forEach(version => {
        const option = select.createEl('option');
        option.value = version.id;
        option.text = `${new Date(version.timestamp).toLocaleString('zh-CN')} - ${version.message}`;
      });

    const buttonGroup = contentEl.createEl('div', { cls: 'modal-button-group' });
    
    const cancelBtn = buttonGroup.createEl('button', { text: '取消' });
    cancelBtn.addEventListener('click', () => this.close());

    const compareBtn = buttonGroup.createEl('button', { text: '比较', cls: 'mod-cta' });
    compareBtn.addEventListener('click', async () => {
      const targetVersionId = select.value;
      await this.plugin.showDiff(this.file, this.baseVersion.id, targetVersionId);
      this.close();
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// 差异查看视图
class DiffView extends Modal {
  plugin: VersionControlPlugin;
  file: TFile;
  leftVersion: Version | 'current';
  rightVersion: Version;
  currentDiffIndex: number = 0;
  totalDiffs: number = 0;

  constructor(
    app: App, 
    plugin: VersionControlPlugin, 
    file: TFile, 
    leftVersion: Version | 'current', 
    rightVersion: Version
  ) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.leftVersion = leftVersion;
    this.rightVersion = rightVersion;
    this.modalEl.addClass('version-diff-modal');
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    // 标题栏
    const header = contentEl.createEl('div', { cls: 'diff-header' });
    
    const leftTitle = this.leftVersion === 'current' 
      ? '当前版本' 
      : new Date(this.leftVersion.timestamp).toLocaleString('zh-CN');
    const rightTitle = new Date(this.rightVersion.timestamp).toLocaleString('zh-CN');
    
    header.createEl('h3', { text: `比较: ${leftTitle} ⟷ ${rightTitle}` });

    // 工具栏
    const toolbar = contentEl.createEl('div', { cls: 'diff-toolbar' });
    
    const prevBtn = toolbar.createEl('button', { text: '← 上一个差异' });
    const diffCounter = toolbar.createEl('span', { cls: 'diff-counter' });
    const nextBtn = toolbar.createEl('button', { text: '下一个差异 →' });
    
    const searchInput = toolbar.createEl('input', { 
      type: 'text',
      placeholder: '搜索...',
      cls: 'diff-search'
    });

    // 差异容器
    const diffContainer = contentEl.createEl('div', { cls: 'diff-container' });

    // 获取内容
    const leftContent = this.leftVersion === 'current' 
      ? await this.app.vault.read(this.file)
      : this.leftVersion.content;
    const rightContent = this.rightVersion.content;

    // 计算差异
    const diffs = Diff.diffLines(leftContent, rightContent);
    
    // 创建左右分栏
    const leftPane = diffContainer.createEl('div', { cls: 'diff-pane diff-left' });
    const rightPane = diffContainer.createEl('div', { cls: 'diff-pane diff-right' });

    leftPane.createEl('h4', { text: leftTitle });
    rightPane.createEl('h4', { text: rightTitle });

    let leftLineNum = 1;
    let rightLineNum = 1;
    let diffBlocks: HTMLElement[] = [];

    diffs.forEach((part) => {
      const lines = part.value.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();

      if (!part.added && !part.removed) {
        // 未更改的行
        lines.forEach(line => {
          const leftLine = leftPane.createEl('div', { cls: 'diff-line' });
          leftLine.createEl('span', { text: String(leftLineNum++), cls: 'line-num' });
          leftLine.createEl('span', { text: line || ' ', cls: 'line-content' });

          const rightLine = rightPane.createEl('div', { cls: 'diff-line' });
          rightLine.createEl('span', { text: String(rightLineNum++), cls: 'line-num' });
          rightLine.createEl('span', { text: line || ' ', cls: 'line-content' });
        });
      } else if (part.removed) {
        // 删除的行
        lines.forEach(line => {
          const leftLine = leftPane.createEl('div', { cls: 'diff-line diff-removed' });
          leftLine.createEl('span', { text: String(leftLineNum++), cls: 'line-num' });
          leftLine.createEl('span', { text: line || ' ', cls: 'line-content' });
          diffBlocks.push(leftLine);

          const rightLine = rightPane.createEl('div', { cls: 'diff-line diff-empty' });
          rightLine.createEl('span', { text: '', cls: 'line-num' });
          rightLine.createEl('span', { text: '', cls: 'line-content' });
        });
      } else if (part.added) {
        // 添加的行
        lines.forEach(line => {
          const leftLine = leftPane.createEl('div', { cls: 'diff-line diff-empty' });
          leftLine.createEl('span', { text: '', cls: 'line-num' });
          leftLine.createEl('span', { text: '', cls: 'line-content' });

          const rightLine = rightPane.createEl('div', { cls: 'diff-line diff-added' });
          rightLine.createEl('span', { text: String(rightLineNum++), cls: 'line-num' });
          rightLine.createEl('span', { text: line || ' ', cls: 'line-content' });
          diffBlocks.push(rightLine);
        });
      }
    });

    this.totalDiffs = diffBlocks.length;
    diffCounter.setText(`(${this.currentDiffIndex + 1} / ${this.totalDiffs})`);

    // 导航功能
    const scrollToDiff = (index: number) => {
      if (diffBlocks.length === 0) return;
      
      this.currentDiffIndex = ((index % diffBlocks.length) + diffBlocks.length) % diffBlocks.length;
      diffBlocks[this.currentDiffIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
      diffCounter.setText(`(${this.currentDiffIndex + 1} / ${this.totalDiffs})`);
    };

    prevBtn.addEventListener('click', () => scrollToDiff(this.currentDiffIndex - 1));
    nextBtn.addEventListener('click', () => scrollToDiff(this.currentDiffIndex + 1));

    // 搜索功能
    searchInput.addEventListener('input', (e) => {
      const searchTerm = (e.target as HTMLInputElement).value.toLowerCase();
      const allLines = diffContainer.querySelectorAll('.line-content');
      
      allLines.forEach(line => {
        const lineEl = line as HTMLElement;
        if (lineEl.textContent?.toLowerCase().includes(searchTerm)) {
          lineEl.addClass('search-highlight');
        } else {
          lineEl.removeClass('search-highlight');
        }
      });
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// 主插件类
export default class VersionControlPlugin extends Plugin {
  settings: VersionControlSettings;
  autoSaveInterval: number;
  versionStorage: Map<string, FileVersionHistory> = new Map();

  async onload() {
    await this.loadSettings();
    await this.loadVersionData();

    // 注册版本历史视图
    this.registerView(
      VERSION_VIEW_TYPE,
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
      editorCallback: (editor, view) => {
        if (view.file) {
          new CreateVersionModal(this.app, this, view.file).open();
        }
      }
    });

    this.addCommand({
      id: 'show-version-history',
      name: '显示版本历史',
      callback: () => {
        this.activateView();
      }
    });

    // 添加设置选项卡
    this.addSettingTab(new VersionControlSettingTab(this.app, this));

    // 自动保存设置
    this.setupAutoSave();

    // 监听文件修改
    this.registerEvent(
      this.app.vault.on('modify', async (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          // 文件修改标记，由自动保存处理
        }
      })
    );

    // 监听文件关闭（Obsidian 后台化）
    this.registerEvent(
      this.app.workspace.on('quit', async () => {
        await this.saveAllModified();
      })
    );
  }

  async activateView() {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(VERSION_VIEW_TYPE)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({ type: VERSION_VIEW_TYPE });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  setupAutoSave() {
    // 清除旧的间隔
    if (this.autoSaveInterval) {
      window.clearInterval(this.autoSaveInterval);
    }

    // 设置新的自动保存间隔
    this.autoSaveInterval = window.setInterval(async () => {
      await this.autoSaveAllFiles();
    }, this.settings.autoSaveInterval * 60 * 1000);

    this.registerInterval(this.autoSaveInterval);
  }

  async autoSaveAllFiles() {
    const files = this.app.vault.getMarkdownFiles();
    
    for (const file of files) {
      await this.createAutoVersion(file);
    }

    await this.cleanupOldVersions();
  }

  async createAutoVersion(file: TFile) {
    const content = await this.app.vault.read(file);
    
    // 检查是否有变化
    const history = this.versionStorage.get(file.path);
    if (history && history.versions.length > 0) {
      const lastVersion = history.versions[history.versions.length - 1];
      if (lastVersion.content === content) {
        return; // 内容无变化，跳过
      }
    }

    await this.createVersion(file, content, '[Auto Save]', false);
  }

  async createManualVersion(file: TFile, message: string) {
    const content = await this.app.vault.read(file);
    await this.createVersion(file, content, message, true);
  }

  async createVersion(file: TFile, content: string, message: string, isManual: boolean) {
    const version: Version = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      content: content,
      message: message,
      size: new Blob([content]).size,
      isManual: isManual
    };

    let history = this.versionStorage.get(file.path);
    if (!history) {
      history = {
        filePath: file.path,
        versions: []
      };
      this.versionStorage.set(file.path, history);
    }

    history.versions.push(version);
    await this.saveVersionData();

    // 触发视图更新
    const leaves = this.app.workspace.getLeavesOfType(VERSION_VIEW_TYPE);
    leaves.forEach(leaf => {
      if (leaf.view instanceof VersionHistoryView) {
        leaf.view.updateView();
      }
    });
  }

  async restoreVersion(file: TFile, versionId: string) {
    const history = this.versionStorage.get(file.path);
    if (!history) return;

    const version = history.versions.find(v => v.id === versionId);
    if (!version) return;

    await this.app.vault.modify(file, version.content);
  }

  async deleteVersion(filePath: string, versionId: string) {
    const history = this.versionStorage.get(filePath);
    if (!history) return;

    history.versions = history.versions.filter(v => v.id !== versionId);
    await this.saveVersionData();
  }

  async cleanupOldVersions() {
    const now = Date.now();
    const retentionMs = this.settings.retentionDays * 24 * 60 * 60 * 1000;

    for (const [filePath, history] of this.versionStorage.entries()) {
      let versions = [...history.versions];

      // 按策略清理
      if (this.settings.cleanupStrategy === 'days-first' || this.settings.cleanupStrategy === 'both') {
        versions = versions.filter(v => (now - v.timestamp) < retentionMs || v.isManual);
      }

      if (this.settings.cleanupStrategy === 'count-first' || this.settings.cleanupStrategy === 'both') {
        // 保留手动版本和最新的版本
        const manualVersions = versions.filter(v => v.isManual);
        const autoVersions = versions.filter(v => !v.isManual).slice(-this.settings.maxVersionCount);
        versions = [...manualVersions, ...autoVersions].sort((a, b) => a.timestamp - b.timestamp);
      }

      history.versions = versions;
    }

    await this.saveVersionData();
  }

  async showDiff(file: TFile, leftVersionId: string | 'current', rightVersionId: string) {
    const history = this.versionStorage.get(file.path);
    if (!history) return;

    const leftVersion = leftVersionId === 'current' 
      ? 'current' 
      : history.versions.find(v => v.id === leftVersionId);
    
    const rightVersion = history.versions.find(v => v.id === rightVersionId);

    if (!rightVersion || (leftVersionId !== 'current' && !leftVersion)) {
      new Notice('版本不存在');
      return;
    }

    new DiffView(
      this.app, 
      this, 
      file, 
      leftVersion as Version | 'current', 
      rightVersion
    ).open();
  }

  getFileHistory(filePath: string): FileVersionHistory | undefined {
    return this.versionStorage.get(filePath);
  }

  async saveAllModified() {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      await this.createAutoVersion(activeFile);
    }
  }

  async loadVersionData() {
    const dataFile = `${this.getStoragePath()}/version-data.json`;
    
    try {
      const data = await this.app.vault.adapter.read(dataFile);
      const parsed = JSON.parse(data);
      this.versionStorage = new Map(Object.entries(parsed));
    } catch (error) {
      // 文件不存在或解析失败，使用空数据
      this.versionStorage = new Map();
    }
  }

  async saveVersionData() {
    const dataFile = `${this.getStoragePath()}/version-data.json`;
    const data = JSON.stringify(Object.fromEntries(this.versionStorage), null, 2);
    
    try {
      await this.app.vault.adapter.write(dataFile, data);
    } catch (error) {
      console.error('Failed to save version data:', error);
    }
  }

  getStoragePath(): string {
    if (this.settings.storageLocation === 'custom' && this.settings.customStoragePath) {
      return this.settings.customStoragePath;
    }
    return '.obsidian/versions';
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.setupAutoSave(); // 重新设置自动保存间隔
  }

  onunload() {
    // 保存所有修改的文件
    this.saveAllModified();
  }
}

// 设置选项卡
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
      .setDesc('选择版本数据的存储位置')
      .addDropdown(dropdown => dropdown
        .addOption('vault', 'Vault 内（.obsidian/versions）')
        .addOption('custom', '自定义路径')
        .setValue(this.plugin.settings.storageLocation)
        .onChange(async (value) => {
          this.plugin.settings.storageLocation = value as 'vault' | 'custom';
          await this.plugin.saveSettings();
          this.display(); // 刷新显示
        }));

    // 自定义路径（仅在选择自定义时显示）
    if (this.plugin.settings.storageLocation === 'custom') {
      new Setting(containerEl)
        .setName('自定义存储路径')
        .setDesc('指定版本数据的存储路径（相对于 vault 根目录）')
        .addText(text => text
          .setPlaceholder('例如: ../version-backup')
          .setValue(this.plugin.settings.customStoragePath)
          .onChange(async (value) => {
            this.plugin.settings.customStoragePath = value;
            await this.plugin.saveSettings();
          }));
    }

    containerEl.createEl('h3', { text: '自动保存设置' });

    // 自动保存间隔
    new Setting(containerEl)
      .setName('自动保存间隔（分钟）')
      .setDesc('文件修改后自动创建版本的时间间隔')
      .addText(text => text
        .setPlaceholder('5')
        .setValue(String(this.plugin.settings.autoSaveInterval))
        .onChange(async (value) => {
          const num = parseInt(value);
          if (!isNaN(num) && num > 0) {
            this.plugin.settings.autoSaveInterval = num;
            await this.plugin.saveSettings();
          }
        }));

    containerEl.createEl('h3', { text: '版本清理设置' });

    // 保留版本数量
    new Setting(containerEl)
      .setName('保留版本数量上限')
      .setDesc('每个文件最多保留的版本数量（手动版本不受此限制）')
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
      .setDesc('自动删除超过此天数的旧版本（手动版本不受此限制）')
      .addText(text => text
        .setPlaceholder('30')
        .setValue(String(this.plugin.settings.retentionDays))
        .onChange(async (value) => {
          const num = parseInt(value);
          if (!isNaN(num) && num > 0) {
            this.plugin.settings.retentionDays = num;
            await this.plugin.saveSettings();
          }
        }));

    // 清理策略
    new Setting(containerEl)
      .setName('清理策略')
      .setDesc('选择版本清理的优先级策略')
      .addDropdown(dropdown => dropdown
        .addOption('days-first', '优先按天数清理')
        .addOption('count-first', '优先按数量清理')
        .addOption('both', '同时满足两个条件')
        .setValue(this.plugin.settings.cleanupStrategy)
        .onChange(async (value) => {
          this.plugin.settings.cleanupStrategy = value as any;
          await this.plugin.saveSettings();
        }));

    // 立即清理按钮
    new Setting(containerEl)
      .setName('立即清理旧版本')
      .setDesc('根据当前设置立即清理所有文件的旧版本')
      .addButton(button => button
        .setButtonText('执行清理')
        .setCta()
        .onClick(async () => {
          await this.plugin.cleanupOldVersions();
          new Notice('旧版本清理完成');
        }));

    // 统计信息
    containerEl.createEl('h3', { text: '统计信息' });

    const totalFiles = this.plugin.versionStorage.size;
    let totalVersions = 0;
    this.plugin.versionStorage.forEach(history => {
      totalVersions += history.versions.length;
    });

    containerEl.createEl('p', { text: `已跟踪文件数: ${totalFiles}` });
    containerEl.createEl('p', { text: `总版本数: ${totalVersions}` });
  }
}