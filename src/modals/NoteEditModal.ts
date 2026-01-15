import { App, Modal, Notice } from 'obsidian';
import VersionControlPlugin from '../main';

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
