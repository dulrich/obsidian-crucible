import { App, Modal } from 'obsidian';

export type RetryImageDescriptionsChoice = 'transient' | 'all';

/**
 * idh-WP-2 "Search: retry failed image descriptions" command modal. `ConfirmModal`
 * (`src/confirmModal.ts`) is deliberately not reused here — its `resolve` is hardcoded
 * `boolean`, and this needs a real 3-way outcome (transient-only / all / cancel-by-closing).
 * Modeled directly on `ConfirmModal`'s shape (title, message, `modal-button-container`,
 * resolve-on-close-if-unresolved) rather than generalizing a 3-way base neither file needs
 * anywhere else yet.
 */
export class RetryFailedImageDescriptionsModal extends Modal {
	private resolved = false;
	private resolve!: (value: RetryImageDescriptionsChoice | null) => void;

	constructor(app: App) {
		super(app);
	}

	openAndAwait(): Promise<RetryImageDescriptionsChoice | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText('Retry failed image descriptions');
		contentEl.createEl('p', {
			text: 'Clears the chosen failed image-description records and queues the description backfill so they '
				+ 're-describe. "Transient only" clears timeouts and connection errors — infra casualties expected to '
				+ 'succeed on retry. "All" also clears permanent failures (e.g. genuinely poison images), which may '
				+ 'fail again the same way.',
		});

		const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.finish(null));

		const transientOnly = buttons.createEl('button', { text: 'Retry transient only' });
		transientOnly.addClass('mod-cta');
		transientOnly.addEventListener('click', () => this.finish('transient'));

		const all = buttons.createEl('button', { text: 'Retry all' });
		all.addEventListener('click', () => this.finish('all'));
	}

	onClose(): void {
		this.contentEl.empty();
		// Dismissed without an explicit choice counts as cancel.
		if (!this.resolved) this.resolve(null);
	}

	private finish(value: RetryImageDescriptionsChoice | null): void {
		this.resolved = true;
		this.resolve(value);
		this.close();
	}
}
