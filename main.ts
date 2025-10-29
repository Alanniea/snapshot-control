import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, Modal, TextComponent } from 'obsidian';

interface SnapshotPluginSettings {
    snapshotFolder: string;
    maxSnapshots: number;
    autoSnapshot: boolean;
    autoSnapshotInterval: number;
}

const DEFAULT_SETTINGS: SnapshotPluginSettings = {
    snapshotFolder: '.snapshots',
    maxSnapshots: 50,
    autoSnapshot: false,
    autoSnapshotInterval: 5
}

interface Snapshot {
    id: string;
    filePath: string;
    timestamp: number;
    content: string;
    note: string;
}

export default class SnapshotPlugin extends Plugin {
    settings: SnapshotPluginSettings;
    private autoSaveIntervalId: number | null = null;

    async onload() {
        await this.loadSettings();

        // 添加左侧功能区图标
        this.addRibbonIcon('clock-rotate-left', '快照版本控制', () => {
            new SnapshotListModal(this.app, this).open();
        });

        // 添加命令:创建快照
        this.addCommand({
            id: 'create-snapshot',
            name: '创建当前文件快照',
            callback: () => {
                this.createSnapshot();
            }
        });

        // 添加命令:查看快照列表
        this.addCommand({
            id: 'view-snapshots',
            name: '查看快照列表',
            callback: () => {
                new SnapshotListModal(this.app, this).open();
            }
        });

        // 添加命令:恢复快照
        this.addCommand({
            id: 'restore-snapshot',
            name: '恢复快照',
            callback: () => {
                new SnapshotListModal(this.app, this).open();
            }
        });

        // 添加设置标签
        this.addSettingTab(new SnapshotSettingTab(this.app, this));

        // 启动自动保存
        if (this.settings.autoSnapshot) {
            this.startAutoSave();
        }

        console.log('快照版本控制插件已加载');
    }

    onunload() {
        if (this.autoSaveIntervalId) {
            window.clearInterval(this.autoSaveIntervalId);
        }
        console.log('快照版本控制插件已卸载');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // 创建快照
    async createSnapshot(note: string = '') {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('没有打开的文件');
            return;
        }

        try {
            const content = await this.app.vault.read(activeFile);
            const snapshot: Snapshot = {
                id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                filePath: activeFile.path,
                timestamp: Date.now(),
                content: content,
                note: note
            };

            await this.saveSnapshot(snapshot);
            await this.cleanOldSnapshots(activeFile.path);
            new Notice('快照创建成功');
        } catch (error) {
            console.error('创建快照失败:', error);
            new Notice('快照创建失败');
        }
    }

    // 保存快照到文件
    async saveSnapshot(snapshot: Snapshot) {
        const snapshotFolder = this.settings.snapshotFolder;
        
        // 确保快照文件夹存在
        const folderExists = await this.app.vault.adapter.exists(snapshotFolder);
        if (!folderExists) {
            await this.app.vault.adapter.mkdir(snapshotFolder);
        }

        // 创建文件特定的子文件夹
        const fileFolder = this.getSnapshotFolderForFile(snapshot.filePath);
        const fileFolderExists = await this.app.vault.adapter.exists(fileFolder);
        if (!fileFolderExists) {
            await this.app.vault.adapter.mkdir(fileFolder);
        }

        // 保存快照数据
        const snapshotPath = `${fileFolder}/${snapshot.id}.json`;
        await this.app.vault.adapter.write(snapshotPath, JSON.stringify(snapshot, null, 2));
    }

    // 获取文件的快照文件夹路径
    getSnapshotFolderForFile(filePath: string): string {
        const sanitizedPath = filePath.replace(/\//g, '_').replace(/\\/g, '_');
        return `${this.settings.snapshotFolder}/${sanitizedPath}`;
    }

    // 获取指定文件的所有快照
    async getSnapshots(filePath: string): Promise<Snapshot[]> {
        const fileFolder = this.getSnapshotFolderForFile(filePath);
        const folderExists = await this.app.vault.adapter.exists(fileFolder);
        
        if (!folderExists) {
            return [];
        }

        try {
            const files = await this.app.vault.adapter.list(fileFolder);
            const snapshots: Snapshot[] = [];

            for (const file of files.files) {
                if (file.endsWith('.json')) {
                    const content = await this.app.vault.adapter.read(file);
                    const snapshot = JSON.parse(content) as Snapshot;
                    snapshots.push(snapshot);
                }
            }

            // 按时间戳降序排序
            snapshots.sort((a, b) => b.timestamp - a.timestamp);
            return snapshots;
        } catch (error) {
            console.error('读取快照失败:', error);
            return [];
        }
    }

    // 清理旧快照
    async cleanOldSnapshots(filePath: string) {
        const snapshots = await this.getSnapshots(filePath);
        if (snapshots.length > this.settings.maxSnapshots) {
            const toDelete = snapshots.slice(this.settings.maxSnapshots);
            const fileFolder = this.getSnapshotFolderForFile(filePath);
            
            for (const snapshot of toDelete) {
                const snapshotPath = `${fileFolder}/${snapshot.id}.json`;
                await this.app.vault.adapter.remove(snapshotPath);
            }
        }
    }

    // 恢复快照
    async restoreSnapshot(snapshot: Snapshot) {
        try {
            const file = this.app.vault.getAbstractFileByPath(snapshot.filePath);
            if (file instanceof TFile) {
                await this.app.vault.modify(file, snapshot.content);
                new Notice('快照恢复成功');
            } else {
                new Notice('文件不存在');
            }
        } catch (error) {
            console.error('恢复快照失败:', error);
            new Notice('恢复快照失败');
        }
    }

    // 删除快照
    async deleteSnapshot(snapshot: Snapshot) {
        try {
            const fileFolder = this.getSnapshotFolderForFile(snapshot.filePath);
            const snapshotPath = `${fileFolder}/${snapshot.id}.json`;
            await this.app.vault.adapter.remove(snapshotPath);
            new Notice('快照已删除');
        } catch (error) {
            console.error('删除快照失败:', error);
            new Notice('删除快照失败');
        }
    }

    // 启动自动保存
    startAutoSave() {
        if (this.autoSaveIntervalId) {
            window.clearInterval(this.autoSaveIntervalId);
        }

        this.autoSaveIntervalId = window.setInterval(() => {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) {
                this.createSnapshot('自动快照');
            }
        }, this.settings.autoSnapshotInterval * 60 * 1000);
    }

    // 停止自动保存
    stopAutoSave() {
        if (this.autoSaveIntervalId) {
            window.clearInterval(this.autoSaveIntervalId);
            this.autoSaveIntervalId = null;
        }
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
        contentEl.addClass('snapshot-modal');

        contentEl.createEl('h2', { text: '快照版本控制' });

        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            contentEl.createEl('p', { text: '没有打开的文件' });
            return;
        }

        contentEl.createEl('p', { text: `当前文件: ${activeFile.name}` });

        // 创建快照按钮
        const buttonContainer = contentEl.createDiv({ cls: 'snapshot-button-container' });
        const createBtn = buttonContainer.createEl('button', { text: '创建新快照' });
        createBtn.addEventListener('click', async () => {
            new CreateSnapshotModal(this.app, this.plugin, () => {
                this.onOpen(); // 刷新列表
            }).open();
        });

        // 加载快照列表
        const snapshots = await this.plugin.getSnapshots(activeFile.path);
        
        if (snapshots.length === 0) {
            contentEl.createEl('p', { text: '暂无快照记录' });
            return;
        }

        const listContainer = contentEl.createDiv({ cls: 'snapshot-list' });
        
        for (const snapshot of snapshots) {
            const item = listContainer.createDiv({ cls: 'snapshot-item' });
            
            const info = item.createDiv({ cls: 'snapshot-info' });
            const date = new Date(snapshot.timestamp);
            info.createEl('div', { 
                text: `时间: ${date.toLocaleString('zh-CN')}`,
                cls: 'snapshot-timestamp'
            });
            
            if (snapshot.note) {
                info.createEl('div', { 
                    text: `备注: ${snapshot.note}`,
                    cls: 'snapshot-note'
                });
            }

            const actions = item.createDiv({ cls: 'snapshot-actions' });
            
            const restoreBtn = actions.createEl('button', { text: '恢复' });
            restoreBtn.addEventListener('click', async () => {
                await this.plugin.restoreSnapshot(snapshot);
                this.close();
            });

            const deleteBtn = actions.createEl('button', { text: '删除' });
            deleteBtn.addEventListener('click', async () => {
                await this.plugin.deleteSnapshot(snapshot);
                this.onOpen(); // 刷新列表
            });
        }

        // 添加样式
        const style = contentEl.createEl('style');
        style.textContent = `
            .snapshot-modal {
                padding: 20px;
            }
            .snapshot-button-container {
                margin: 15px 0;
            }
            .snapshot-list {
                margin-top: 20px;
                max-height: 400px;
                overflow-y: auto;
            }
            .snapshot-item {
                border: 1px solid var(--background-modifier-border);
                border-radius: 5px;
                padding: 10px;
                margin-bottom: 10px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .snapshot-info {
                flex: 1;
            }
            .snapshot-timestamp {
                font-weight: bold;
                margin-bottom: 5px;
            }
            .snapshot-note {
                color: var(--text-muted);
                font-size: 0.9em;
            }
            .snapshot-actions {
                display: flex;
                gap: 5px;
            }
            .snapshot-actions button {
                padding: 5px 10px;
                cursor: pointer;
            }
        `;
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// 创建快照模态框
class CreateSnapshotModal extends Modal {
    plugin: SnapshotPlugin;
    onSubmit: () => void;

    constructor(app: App, plugin: SnapshotPlugin, onSubmit: () => void) {
        super(app);
        this.plugin = plugin;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: '创建快照' });

        new Setting(contentEl)
            .setName('备注')
            .setDesc('为这个快照添加备注(可选)')
            .addText(text => {
                text.inputEl.style.width = '100%';
                text.onChange(() => {});
                
                // 创建按钮
                const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
                buttonContainer.style.marginTop = '20px';
                buttonContainer.style.display = 'flex';
                buttonContainer.style.gap = '10px';
                
                const submitBtn = buttonContainer.createEl('button', { text: '创建' });
                submitBtn.addEventListener('click', async () => {
                    await this.plugin.createSnapshot(text.getValue());
                    this.close();
                    this.onSubmit();
                });

                const cancelBtn = buttonContainer.createEl('button', { text: '取消' });
                cancelBtn.addEventListener('click', () => {
                    this.close();
                });
            });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

// 设置标签
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

        new Setting(containerEl)
            .setName('自动快照')
            .setDesc('定期自动创建快照')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSnapshot)
                .onChange(async (value) => {
                    this.plugin.settings.autoSnapshot = value;
                    await this.plugin.saveSettings();
                    
                    if (value) {
                        this.plugin.startAutoSave();
                    } else {
                        this.plugin.stopAutoSave();
                    }
                }));

        new Setting(containerEl)
            .setName('自动快照间隔')
            .setDesc('自动创建快照的时间间隔(分钟)')
            .addText(text => text
                .setPlaceholder('5')
                .setValue(String(this.plugin.settings.autoSnapshotInterval))
                .onChange(async (value) => {
                    const num = parseInt(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.autoSnapshotInterval = num;
                        await this.plugin.saveSettings();
                        
                        if (this.plugin.settings.autoSnapshot) {
                            this.plugin.startAutoSave();
                        }
                    }
                }));
    }
}