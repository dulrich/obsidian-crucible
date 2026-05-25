import { App, Modal } from 'obsidian';

export interface ConfirmModalOptions {
	title: string;
	message: string;
	confirmText?: string;
	cancelText?: string;
	/** When true, the confirm button uses Obsidian's destructive (warning) styling. */
	destructive?: boolean;
}

/**
 * Minimal confirmation dialog. Resolves true when the user confirms, false when
 * they cancel or dismiss the modal.
 */
export class ConfirmModal extends Modal {
	private resolved = false;
	private resolve!: (value: boolean) => void;

	constructor(app: App, private readonly options: ConfirmModalOptions) {
		super(app);
	}

	openAndAwait(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(this.options.title);
		contentEl.createEl('p', { text: this.options.message });

		const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
		const cancel = buttons.createEl('button', { text: this.options.cancelText ?? 'Cancel' });
		cancel.addEventListener('click', () => this.finish(false));

		const confirm = buttons.createEl('button', { text: this.options.confirmText ?? 'Confirm' });
		confirm.addClass('mod-cta');
		if (this.options.destructive) confirm.addClass('mod-warning');
		confirm.addEventListener('click', () => this.finish(true));
	}

	onClose(): void {
		this.contentEl.empty();
		// Dismissed without an explicit choice counts as cancel.
		if (!this.resolved) this.resolve(false);
	}

	private finish(value: boolean): void {
		this.resolved = true;
		this.resolve(value);
		this.close();
	}
}
