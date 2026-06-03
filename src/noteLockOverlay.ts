import { MarkdownView } from 'obsidian';
import type CruciblePlugin from './main';

const LABEL_TEXT: Record<string, string> = {
	localize: 'Localizing attachments…',
	lint: 'Linting…',
	'yt-metadata': 'Fetching metadata…',
};

function labelToText(label: string): string {
	if (label.startsWith('chain:')) return `Running chain: ${label.slice('chain:'.length)}`;
	return LABEL_TEXT[label] ?? 'Working…';
}

/**
 * Grays out and blocks the active note while it holds a note-lock. Driven by the
 * `note-lock-changed` event plus active-leaf changes, so the overlay only ever
 * appears on the note the user is currently looking at.
 */
export class NoteLockOverlay {
	private overlayEl: HTMLElement | null = null;
	private labelEl: HTMLElement | null = null;
	private hostView: MarkdownView | null = null;
	private readonly disposers: Array<() => void> = [];

	constructor(private readonly plugin: CruciblePlugin) {
		const bus = plugin.ingestionEvents;
		if (bus) {
			this.disposers.push(bus.on('note-lock-changed', () => this.sync()));
		}
		plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', () => this.sync()));
		this.sync();
	}

	dispose(): void {
		for (const d of this.disposers) d();
		this.disposers.length = 0;
		this.remove();
	}

	private sync(): void {
		const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		const path = view?.file?.path;
		if (view && path && this.plugin.noteLocks.isLocked(path)) {
			this.show(view, labelToText(this.plugin.noteLocks.currentLabel(path) ?? ''));
		} else {
			this.remove();
		}
	}

	private show(view: MarkdownView, text: string): void {
		if (this.hostView && this.hostView !== view) this.remove();
		if (!this.overlayEl) {
			const host = view.contentEl;
			host.addClass('crucible-note-locked-host');
			this.overlayEl = host.createDiv({ cls: 'crucible-note-locked' });
			const box = this.overlayEl.createDiv({ cls: 'crucible-note-locked-box' });
			box.createSpan({ cls: 'crucible-spinner' });
			this.labelEl = box.createSpan({ cls: 'crucible-note-locked-label' });
			this.hostView = view;
		}
		this.labelEl?.setText(text);
	}

	private remove(): void {
		this.overlayEl?.remove();
		this.hostView?.contentEl.removeClass('crucible-note-locked-host');
		this.overlayEl = null;
		this.labelEl = null;
		this.hostView = null;
	}
}
