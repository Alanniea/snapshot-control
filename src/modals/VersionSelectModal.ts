import { App, Modal, TFile } from 'obsidian';
import { VersionData } from '../types';
import VersionControlPlugin from '../main';

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
        contentEl.createEl('h2', { text: 'Select version to compare' });
        contentEl.createEl('p', { text: 'Select a version to compare with the currently selected version:' });

        this.versions = await this.plugin.getAllVersions(this.file.path);

        const listContainer = contentEl.createEl('div', { cls: 'version-select-list', attr: { style: 'max-height: 400px; overflow-y: auto;' } });

        // Option: current file
        if (this.currentVersionId !== 'current') {
            this.renderItem(listContainer, {
                id: 'current',
                timestamp: Date.now(),
                message: '📄 Current content in editor',
                size: 0
            } as any, true);
        }

        this.versions.forEach(v => {
            if (v.id !== this.currentVersionId) {
                this.renderItem(listContainer, v);
            }
        });

        const cancelBtn = contentEl.createEl('button', { text: 'Cancel', attr: { style: 'margin-top: 15px;' } });
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
