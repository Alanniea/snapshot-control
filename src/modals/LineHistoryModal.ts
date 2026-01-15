import { App, Modal, TFile } from 'obsidian';
import { VersionData } from '../types';
import VersionControlPlugin from '../main';
import { DiffModal } from './DiffModal';

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
        contentEl.createEl('h2', { text: '📜 Line History' });

        const textPreview = contentEl.createEl('div', {
            cls: 'line-text-preview',
            text: this.lineText.length > 100 ? this.lineText.substring(0, 100) + '...' : this.lineText,
            attr: { style: 'padding: 10px; background: var(--background-secondary); font-family: var(--font-monospace); margin-bottom: 15px; border-radius: 4px;' }
        });

        contentEl.createEl('p', { text: `Found this line in ${this.matchingVersions.length} versions:` });

        const listContainer = contentEl.createEl('div', { cls: 'line-history-list', attr: { style: 'max-height: 400px; overflow-y: auto;' } });

        this.matchingVersions.forEach(v => {
            const item = listContainer.createEl('div', { cls: 'version-item', attr: { style: 'padding: 10px; border-bottom: 1px solid var(--background-modifier-border); display: flex; justify-content: space-between; align-items: center;' } });

            const info = item.createEl('div');
            const timeRow = info.createEl('div', { attr: { style: 'font-weight: bold;' } });
            timeRow.createEl('span', { text: this.plugin.formatTime(v.timestamp) });
            if (v.starred) timeRow.createEl('span', { text: ' ⭐' });

            info.createEl('div', { text: v.message, attr: { style: 'color: var(--text-muted); font-size: 0.9em;' } });

            const btn = item.createEl('button', { text: 'View' });
            btn.addEventListener('click', () => {
                this.close();
                new DiffModal(this.app, this.plugin, this.file, v.id).open();
            });
        });

        const closeBtn = contentEl.createEl('div', { cls: 'modal-button-container', attr: { style: 'margin-top: 15px;' } });
        closeBtn.createEl('button', { text: 'Close' }).addEventListener('click', () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }
}
