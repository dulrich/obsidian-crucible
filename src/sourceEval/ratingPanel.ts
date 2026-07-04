import { App, Component, MarkdownRenderer, Notice, TFile, setIcon } from 'obsidian';
import { updateFrontmatter, getFrontmatterTags } from '../frontmatter';
import { formatDate } from '../ingestion/render/format';
import type { CaptureRecord } from './types';

const QUICK_TAGS = ['gold', 'goldmine', 'revisit', 'reference'] as const;
type QuickTag = typeof QUICK_TAGS[number];

export interface RatingPanelOptions {
	app: App;
	component: Component;
	container: HTMLElement;
	capture: CaptureRecord | null;
	sourceName: string;
	enabled: boolean;
	onSaved: (file: TFile) => void | Promise<void>;
	onNext: (file: TFile) => void | Promise<void>;
	onPersistentSkip: (file: TFile) => void | Promise<void>;
}

export class SourceEvalRatingPanel {
	private importance: number | null;
	private urgent: boolean;
	private read: boolean;
	private readonly quickTags: Set<QuickTag>;
	private readonly saveButtons: HTMLButtonElement[] = [];

	constructor(private readonly options: RatingPanelOptions) {
		this.importance = options.capture?.label?.importance ?? null;
		this.urgent = options.capture?.label?.urgent === true;
		this.read = options.capture?.read === true;
		const tags = new Set([
			...(options.capture?.tags ?? []),
			...(options.capture?.label?.tags ?? []),
		].map(normalizeTag));
		this.quickTags = new Set(QUICK_TAGS.filter(tag => tags.has(tag)));
	}

	render(): void {
		const { container, capture, enabled } = this.options;
		container.empty();
		container.addClass('crucible-source-eval-rating-panel');

		if (!enabled) {
			container.createDiv({ cls: 'crucible-empty-state', text: 'Source eval dashboard is disabled in settings.' });
			return;
		}
		if (!capture) {
			container.createDiv({ cls: 'crucible-empty-state', text: 'No notes in this queue.' });
			return;
		}

		this.renderHeader(capture);
		this.renderPreview(capture.file);
		this.renderControls(capture);
	}

	private renderHeader(capture: CaptureRecord): void {
		const header = this.options.container.createDiv({ cls: 'crucible-source-eval-rating-header' });
		const title = header.createEl('a', {
			text: capture.file.basename,
			href: '#',
			cls: 'crucible-source-eval-note-link',
		});
		title.addEventListener('click', evt => {
			evt.preventDefault();
			void this.options.app.workspace.openLinkText(capture.file.path, '', false);
		});

		const metaParts = [
			this.options.sourceName,
			formatDate(capture.published ?? capture.created),
			capture.wordCount !== null ? `${formatInteger(capture.wordCount)} words` : '',
		].filter(Boolean);
		header.createDiv({ cls: 'crucible-source-eval-rating-meta', text: metaParts.join(' · ') });
	}

	private renderPreview(file: TFile): void {
		const preview = this.options.container.createDiv({ cls: 'crucible-source-eval-preview' });
		void (async () => {
			try {
				const raw = await this.options.app.vault.read(file);
				const md = stripFrontmatter(raw);
				await MarkdownRenderer.render(this.options.app, md, preview, file.path, this.options.component);
			} catch (e) {
				preview.empty();
				preview.createDiv({
					cls: 'crucible-empty-state',
					text: `Preview failed: ${e instanceof Error ? e.message : String(e)}`,
				});
			}
		})();
	}

	private renderControls(capture: CaptureRecord): void {
		const controls = this.options.container.createDiv({ cls: 'crucible-source-eval-rating-controls' });

		const importanceRow = controls.createDiv({ cls: 'crucible-source-eval-control-row' });
		importanceRow.createSpan({ cls: 'crucible-source-eval-control-label', text: 'Importance' });
		const importanceGroup = importanceRow.createDiv({ cls: 'crucible-source-eval-button-group' });
		for (let value = 0; value <= 5; value++) {
			const btn = importanceGroup.createEl('button', {
				text: String(value),
				cls: 'crucible-source-eval-pill-button',
			});
			btn.setAttr('aria-pressed', String(this.importance === value));
			if (this.importance === value) btn.addClass('is-active');
			btn.addEventListener('click', () => {
				this.importance = value;
				for (const el of Array.from(importanceGroup.querySelectorAll('button'))) {
					el.removeClass('is-active');
					el.setAttr('aria-pressed', 'false');
				}
				btn.addClass('is-active');
				btn.setAttr('aria-pressed', 'true');
				this.syncSaveButtons();
				});
		}

		const urgentRow = controls.createDiv({ cls: 'crucible-source-eval-control-row' });
		urgentRow.createSpan({ cls: 'crucible-source-eval-control-label', text: 'Urgent?' });
		const urgentLabel = urgentRow.createEl('label', { cls: 'crucible-source-eval-checkbox-label' });
		const urgent = urgentLabel.createEl('input', { type: 'checkbox' });
		urgent.checked = this.urgent;
		urgentLabel.appendText(' urgent');
		urgent.addEventListener('change', () => {
			this.urgent = urgent.checked;
		});

		const readRow = controls.createDiv({ cls: 'crucible-source-eval-control-row' });
		readRow.createSpan({ cls: 'crucible-source-eval-control-label', text: 'Read?' });
		const readGroup = readRow.createDiv({ cls: 'crucible-source-eval-button-group' });
		const readYes = readGroup.createEl('button', { text: '✅', cls: 'crucible-source-eval-pill-button' });
		const readNo = readGroup.createEl('button', { text: '❌', cls: 'crucible-source-eval-pill-button' });
		readYes.setAttr('aria-label', 'Mark read');
		readNo.setAttr('aria-label', 'Mark unread');
		const syncReadButtons = () => {
			readYes.toggleClass('is-active', this.read);
			readNo.toggleClass('is-active', !this.read);
			readYes.setAttr('aria-pressed', String(this.read));
			readNo.setAttr('aria-pressed', String(!this.read));
		};
		readYes.addEventListener('click', () => {
			this.read = true;
			syncReadButtons();
		});
		readNo.addEventListener('click', () => {
			this.read = false;
			syncReadButtons();
		});
		syncReadButtons();

		const tagRow = controls.createDiv({ cls: 'crucible-source-eval-control-row' });
		tagRow.createSpan({ cls: 'crucible-source-eval-control-label', text: 'Tags' });
		const tagGroup = tagRow.createDiv({ cls: 'crucible-source-eval-button-group' });
		for (const tag of QUICK_TAGS) {
			const btn = tagGroup.createEl('button', {
				text: tag,
				cls: 'crucible-source-eval-pill-button',
			});
			const active = this.quickTags.has(tag);
			if (active) btn.addClass('is-active');
			btn.setAttr('aria-pressed', String(active));
			btn.addEventListener('click', () => {
				const next = !this.quickTags.has(tag);
				if (next) this.quickTags.add(tag);
				else this.quickTags.delete(tag);
				btn.toggleClass('is-active', next);
				btn.setAttr('aria-pressed', String(next));
			});
		}

		const actions = controls.createDiv({ cls: 'crucible-source-eval-rating-actions' });
		const save = actions.createEl('button', { cls: 'mod-cta crucible-source-eval-save' });
		save.appendText('Save & next');
		this.saveButtons.push(save);
		save.addEventListener('click', () => {
			if (save.disabled) return;
			void this.save(capture);
		});

		const next = actions.createEl('button', { cls: 'crucible-source-eval-next' });
		setIcon(next, 'skip-forward');
		next.createSpan({ text: ' Next' });
		next.addEventListener('click', () => void this.options.onNext(capture.file));

		const persistentSkip = actions.createEl('button', { cls: 'crucible-source-eval-persistent-skip' });
		persistentSkip.setText('Skip labeling');
		persistentSkip.addEventListener('click', () => void this.persistentSkip(capture));

		this.syncSaveButtons();
	}

	private syncSaveButtons(): void {
		const disabled = this.importance === null;
		for (const btn of this.saveButtons) btn.disabled = disabled;
	}

	private async save(capture: CaptureRecord): Promise<void> {
		if (this.importance === null) return;
		try {
			const importance = this.importance;
			const urgent = this.urgent;
			const selectedQuickTags = new Set(this.quickTags);
				await updateFrontmatter(this.options.app, capture.file, fm => {
					fm['eval-importance'] = importance;
					fm['eval-rated'] = todayLocal();
					fm.read = this.read;
					delete fm['eval-skip'];
					if (urgent) fm['eval-urgent'] = true;
					else delete fm['eval-urgent'];
					fm.tags = mergeQuickTags(fm.tags, selectedQuickTags);
			});
			await this.options.onSaved(capture.file);
		} catch (e) {
			new Notice(`Failed to save rating: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async persistentSkip(capture: CaptureRecord): Promise<void> {
		try {
			await updateFrontmatter(this.options.app, capture.file, fm => {
				fm['eval-skip'] = true;
			});
			await this.options.onPersistentSkip(capture.file);
		} catch (e) {
			new Notice(`Failed to skip labeling: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

function stripFrontmatter(markdown: string): string {
	return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function mergeQuickTags(value: unknown, selected: Set<QuickTag>): string[] {
	const existing = getFrontmatterTags(value)
		.map(tag => tag.trim().replace(/^#+/, ''))
		.filter(Boolean);
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const tag of existing) {
		const normalized = normalizeTag(tag);
		if (QUICK_TAGS.includes(normalized as QuickTag) && !selected.has(normalized as QuickTag)) continue;
		if (!seen.has(normalized)) {
			seen.add(normalized);
			merged.push(tag);
		}
	}
	for (const tag of selected) {
		if (!seen.has(tag)) {
			seen.add(tag);
			merged.push(tag);
		}
	}
	return merged;
}

function normalizeTag(tag: string): string {
	return tag.trim().replace(/^#+/, '').toLowerCase();
}

function todayLocal(): string {
	return formatDate(Date.now());
}

function formatInteger(n: number): string {
	return Math.round(n).toLocaleString();
}
