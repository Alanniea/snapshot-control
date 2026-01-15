import { App, Modal, Notice } from 'obsidian';
import VersionControlPlugin from '../main';

export class IntegrityReportModal extends Modal {
    plugin: VersionControlPlugin;
    report: { filePath: string; errors: string[] }[];

    constructor(app: App, plugin: VersionControlPlugin, report: { filePath: string; errors: string[] }[]) {
        super(app);
        this.plugin = plugin;
        this.report = report;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: '🛡️ 版本完整性检查报告' });

        if (this.report.length === 0) {
            const successDiv = contentEl.createEl('div', { cls: 'integrity-success' });
            successDiv.createEl('h3', { text: '✅ 所有检查通过' });
            successDiv.createEl('p', { text: '未发现损坏的版本记录。' });
        } else {
            contentEl.createEl('p', { text: `⚠️ 发现 ${this.report.length} 个文件存在问题:` });

            const listContainer = contentEl.createEl('div', { cls: 'integrity-report-list' });

            this.report.forEach(item => {
                const fileContainer = listContainer.createEl('div', { cls: 'integrity-item' });
                fileContainer.createEl('h4', { text: item.filePath });

                const errorList = fileContainer.createEl('ul');
                item.errors.forEach(err => {
                    errorList.createEl('li', { text: err, attr: { style: 'color: var(--text-error);' } });
                });

                const repairBtn = fileContainer.createEl('button', { text: '尝试修复哈希' });
                repairBtn.addEventListener('click', async () => {
                    const repaired = await this.plugin.repairVersionFile(item.filePath);
                    if (repaired) {
                        repairBtn.setText('修复成功');
                        repairBtn.disabled = true;
                    } else {
                        new Notice('无法自动修复，请手动检查文件。');
                    }
                });
            });
        }

        const btnContainer = contentEl.createEl('div', { cls: 'modal-button-container', attr: { style: 'margin-top: 20px;' } });
        btnContainer.createEl('button', { text: '关闭' }).addEventListener('click', () => this.close());
    }

    onClose() {
        this.contentEl.empty();
    }
}
