import { App, Modal, Notice } from 'obsidian';

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
        contentEl.createEl('h2', { text: 'Set Context Lines' });
        contentEl.createEl('p', { text: 'Enter the number of unchanged lines to show around diffs (0 for none, 9999 for all).' });

        const inputContainer = contentEl.createEl('div', { attr: { style: 'margin: 20px 0;' } });
        const input = inputContainer.createEl('input', { type: 'number' });
        input.value = String(this.currentValue);
        input.focus();

        const btnContainer = contentEl.createEl('div', { cls: 'modal-button-container' });

        btnContainer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());

        const saveBtn = btnContainer.createEl('button', { text: 'Save', cls: 'mod-cta' });
        saveBtn.addEventListener('click', () => {
            const val = parseInt(input.value);
            if (!isNaN(val) && val >= 0) {
                this.onSubmit(val);
                this.close();
            } else {
                new Notice('Please enter a valid positive number');
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
