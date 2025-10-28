import {
    App,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    Notice,
    Modal,
    ButtonComponent,
} from 'obsidian';

interface SnapshotPluginSettings {
    snapshotFolder: string;
    autoSnapshot: boolean;
    maxSnapshots: number;
    snapshotInterval: number; // 分钟
}

interface Snapshot {
    id: string;
    filePath: string;
    timestamp: number;
    content: string;
    size: number;
    note: string;
}

const DEFAULT_SETTINGS: SnapshotPluginSettings = {
    snapshotFolder: '.snapshots',
    autoSnapshot: true,
    maxSnapshots: 50,
    snapshotInterval: 30,
};

export default class SnapshotPlugin extends Plugin {
    settings: SnapshotPluginSettings;
    lastSaveTime: Map<string, number> = new Map();

    async onload() {
        await this.loadSettings();

        // 创建快照文件夹
        await this.ensureSnapshotFolder();

        // 添加命令：手动创建快照
        this.addCommand({
            id: 'create-snapshot',
            name: '创建当前文件快照',
            callback: () => this.createSnapshot(),
        });

        // 添加命令：查看快照历史
        this.addCommand({
            id: 'view-snapshots',
            name: '查看快照历史',
            callback: () => this.viewSnapshots(),
        });

        // 添加命令：恢复快照
        this.addCommand({
            id: 'restore-snapshot',
            name: '恢复快照',
            callback: () => this.showRestoreModal(),
        });

        // 添加命令：清理旧快照
        this.addCommand({
            id: 'clean-snapshots',
            name: '清理旧快照',
            callback: () => this.cleanOldSnapshots(),
        });

        // 监听文件修改事件（自动快照）
        if (this.settings.autoSnapshot) {
            this.registerEvent(
                this.app.vault.on('modify', (file) => {
                    if (file instanceof TFile) {
                        this.autoCreateSnapshot(file);
                    }
                })
            );
        }

        // 添加设置选项卡
        this.addSettingTab(new SnapshotSettingTab(this.app, this));

        // 添加功能区图标
        this.addRibbonIcon('history', '快照管理', () => {
            this.viewSnapshots();
        });
    }

    async ensureSnapshotFolder() {
        const folder = this.settings.snapshotFolder;
        if (!(await this.app.vault.adapter.exists(folder))) {
            await this.app.vault.createFolder(folder);
        }
    }

    async createSnapshot(file?: TFile, note?: string) {
        const activeFile = file || this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('没有活动文件');
            return;
        }

        try {
            const content = await this.app.vault.read(activeFile);
            const snapshot: Snapshot = {
                id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                filePath: activeFile.path,
                timestamp: Date.now(),
                content: content,
                size: content.length,
                note: note || '',
            };

            const snapshotPath = `${this.settings.snapshotFolder}/${this.sanitizeFileName(activeFile.path)}_${snapshot.id}.json`;
            await this.app.vault.create(snapshotPath, JSON.stringify(snapshot, null, 2));

            new Notice(`快照已创建: ${activeFile.name}`);
            
            // 清理超出限制的旧快照
            await this.cleanOldSnapshots(activeFile.path);
        } catch (error) {
            new Notice(`创建快照失败: ${error.message}`);
            console.error(error);
        }
    }

    async autoCreateSnapshot(file: TFile) {
        const lastSave = this.lastSaveTime.get(file.path) || 0;
        const now = Date.now();
        const intervalMs = this.settings.snapshotInterval * 60 * 1000;

        if (now - lastSave >= intervalMs) {
            await this.createSnapshot(file);
            this.lastSaveTime.set(file.path, now);
        }
    }

    async getSnapshots(filePath?: string): Promise<Snapshot[]> {
        const snapshotFiles = this.app.vault.getFiles().filter(f => 
            f.path.startsWith(this.settings.snapshotFolder) && f.extension === 'json'
        );

        const snapshots: Snapshot[] = [];
        for (const file of snapshotFiles) {
            try {
                const content = await this.app.vault.read(file);
                const snapshot: Snapshot = JSON.parse(content);
                if (!filePath || snapshot.filePath === filePath) {
                    snapshots.push(snapshot);
                }
            } catch (error) {
                console.error(`读取快照失败: ${file.path}`, error);
            }
        }

        return snapshots.sort((a, b) => b.timestamp - a.timestamp);
    }

    async restoreSnapshot(snapshot: Snapshot) {
        try {
            const file = this.app.vault.getAbstractFileByPath(snapshot.filePath);
            if (file instanceof TFile) {
                // 在恢复前创建当前版本的快照
                await this.createSnapshot(file, '恢复前自动保存');
                
                // 恢复内容
                await this.app.vault.modify(file, snapshot.content);
                new Notice(`已恢复快照: ${new Date(snapshot.timestamp).toLocaleString()}`);
            } else {
                new Notice('原文件不存在，无法恢复');
            }
        } catch (error) {
            new Notice(`恢复快照失败: ${error.message}`);
            console.error(error);
        }
    }

    async cleanOldSnapshots(filePath?: string) {
        const snapshots = await this.getSnapshots(filePath);
        const maxSnapshots = this.settings.maxSnapshots;

        if (snapshots.length > maxSnapshots) {
            const toDelete = snapshots.slice(maxSnapshots);
            for (const snapshot of toDelete) {
                const snapshotPath = `${this.settings.snapshotFolder}/${this.sanitizeFileName(snapshot.filePath)}_${snapshot.id}.json`;
                const file = this.app.vault.getAbstractFileByPath(snapshotPath);
                if (file instanceof TFile) {
                    await this.app.vault.delete(file);
                }
            }
            new Notice(`已清理 ${toDelete.length} 个旧快照`);
        }
    }

    viewSnapshots() {
        new SnapshotListModal(this.app, this).open();
    }

    showRestoreModal() {
        new RestoreSnapshotModal(this.app, this).open();
    }

    sanitizeFileName(path: string): string {
        return path.replace(/[/\\:*?"<>|]/g, '_');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// 快照列表模态框
class SnapshotListModal extends Modal {
    plugin: SnapshotPlugin;

    constructor(app: App, plugin: SnapshotPlugin) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: '快照历史' });

        const activeFile = this.app.workspace.getActiveFile();
        const snapshots = await this.plugin.getSnapshots(activeFile?.path);

        if (snapshots.length === 0) {
            contentEl.createEl('p', { text: '暂无快照' });
            return;
        }

        const listEl = contentEl.createDiv({ cls: 'snapshot-list' });
        for (const snapshot of snapshots) {
            const itemEl = listEl.createDiv({ cls: 'snapshot-item' });
            
            const infoEl = itemEl.createDiv({ cls: 'snapshot-info' });
            infoEl.createEl('div', { 
                text: new Date(snapshot.timestamp).toLocaleString(),
                cls: 'snapshot-time'
            });
            infoEl.createEl('div', { 
                text: `${snapshot.filePath} (${(snapshot.size / 1024).toFixed(2)} KB)`,
                cls: 'snapshot-path'
            });
            if (snapshot.note) {
                infoEl.createEl('div', { 
                    text: snapshot.note,
                    cls: 'snapshot-note'
                });
            }

            const actionsEl = itemEl.createDiv({ cls: 'snapshot-actions' });
            
            new ButtonComponent(actionsEl)
                .setButtonText('恢复')
                .onClick(async () => {
                    await this.plugin.restoreSnapshot(snapshot);
                    this.close();
                });

            new ButtonComponent(actionsEl)
                .setButtonText('查看')
                .onClick(() => {
                    new SnapshotContentModal(this.app, snapshot).open();
                });
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// 快照内容查看模态框
class SnapshotContentModal extends Modal {
    snapshot: Snapshot;

    constructor(app: App, snapshot: Snapshot) {
        super(app);
        this.snapshot = snapshot;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: '快照内容' });
        
        contentEl.createEl('p', { 
            text: `时间: ${new Date(this.snapshot.timestamp).toLocaleString()}`
        });
        contentEl.createEl('p', { 
            text: `文件: ${this.snapshot.filePath}`
        });

        const contentBox = contentEl.createEl('pre', { 
            cls: 'snapshot-content',
        });
        contentBox.createEl('code', { text: this.snapshot.content });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// 恢复快照模态框
class RestoreSnapshotModal extends Modal {
    plugin: SnapshotPlugin;

    constructor(app: App, plugin: SnapshotPlugin) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: '恢复快照' });

        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            contentEl.createEl('p', { text: '请先打开要恢复的文件' });
            return;
        }

        const snapshots = await this.plugin.getSnapshots(activeFile.path);
        if (snapshots.length === 0) {
            contentEl.createEl('p', { text: '该文件没有快照' });
            return;
        }

        for (const snapshot of snapshots) {
            const itemEl = contentEl.createDiv({ cls: 'snapshot-restore-item' });
            itemEl.createEl('span', { 
                text: new Date(snapshot.timestamp).toLocaleString()
            });
            
            new ButtonComponent(itemEl)
                .setButtonText('恢复此版本')
                .onClick(async () => {
                    await this.plugin.restoreSnapshot(snapshot);
                    this.close();
                });
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// 设置选项卡
class SnapshotSettingTab extends PluginSettingTab {
    plugin: SnapshotPlugin;

    constructor(app: App, plugin: SnapshotPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: '快照版本控制设置' });

        new Setting(containerEl)
            .setName('快照存储文件夹')
            .setDesc('快照文件的存储位置')
            .addText(text => text
                .setPlaceholder('.snapshots')
                .setValue(this.plugin.settings.snapshotFolder)
                .onChange(async (value) => {
                    this.plugin.settings.snapshotFolder = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('自动快照')
            .setDesc('在文件修改时自动创建快照')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSnapshot)
                .onChange(async (value) => {
                    this.plugin.settings.autoSnapshot = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('快照间隔（分钟）')
            .setDesc('自动快照的时间间隔')
            .addText(text => text
                .setPlaceholder('30')
                .setValue(String(this.plugin.settings.snapshotInterval))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.snapshotInterval = num;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('最大快照数量')
            .setDesc('每个文件保留的最大快照数量')
            .addText(text => text
                .setPlaceholder('50')
                .setValue(String(this.plugin.settings.maxSnapshots))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.maxSnapshots = num;
                        await this.plugin.saveSettings();
                    }
                }));
    }
}