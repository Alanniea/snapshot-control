import { App, Modal, TFile, Notice } from 'obsidian';
import * as Diff from 'diff';
import VersionControlPlugin from '../main';

export class DiffModal extends Modal {
    plugin: VersionControlPlugin;
    file: TFile;
    versionId: string;
    secondVersionId?: string;

    constructor(app: App, plugin: VersionControlPlugin, file: TFile, versionId: string, secondVersionId?: string) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.versionId = versionId;
        this.secondVersionId = secondVersionId;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'File differences' });
        const diffContainer = contentEl.createEl('pre', {
            attr: {
                style: 'white-space: pre-wrap; word-break: break-all;'
            }
        });

        try {
            const version1Content = await this.plugin.getVersionContent(this.file.path, this.versionId);
            let version2Content: string;

            let version1Label = `version ${this.versionId.substring(0, 8)}`;
            let version2Label: string;

            if (this.secondVersionId) {
                if (this.secondVersionId === 'current') {
                    version2Content = await this.app.vault.read(this.file);
                    version2Label = 'current file';
                } else {
                    version2Content = await this.plugin.getVersionContent(this.file.path, this.secondVersionId);
                    version2Label = `version ${this.secondVersionId.substring(0, 8)}`;
                }
            } else {
                version2Content = await this.app.vault.read(this.file);
                version2Label = 'current file';
            }

            const diff = Diff.createPatch(
                this.file.path,
                version2Content, // old
                version1Content, // new
                version2Label,
                version1Label
            );

            diffContainer.setText(diff);
        } catch (error) {
            console.error("Error generating diff:", error);
            new Notice("Error generating diff. See console for details.");
            diffContainer.setText("Could not generate diff.");
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
