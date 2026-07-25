import { App, Notice, SuggestModal, TFile, normalizePath, renderResults } from 'obsidian';
import { buildRecencyMap } from './fileOpenIndex';
import {
	FILE_OPEN_LIMIT,
	FileOpenCreateItem,
	FileOpenFileItem,
	FileOpenItem,
	FileOpenMatch,
	NarrowState,
	buildFileOpenMatch,
	createNarrowState,
	selectFileOpenItems,
} from './fileOpenRanking';
import { logWarn } from './log';
import type CruciblePlugin from './main';

/** A keystroke over this budget is worth a debug-gated warning, not a UI hitch. */
const SLOW_SELECTION_MS = 16;

type FileOpenUiItem =
	| (FileOpenFileItem & { match?: FileOpenMatch })
	| FileOpenCreateItem;

export class CrucibleFileOpenPaletteModal extends SuggestModal<FileOpenUiItem> {
	private narrowState: NarrowState = createNarrowState();
	private recency: Map<string, number> = new Map();

	constructor(app: App, private readonly plugin: CruciblePlugin) {
		super(app);
		this.setPlaceholder('Crucible: open file...');
		this.setInstructions([
			{ command: 'Enter', purpose: 'open file' },
			{ command: 'Esc', purpose: 'cancel' },
		]);
		this.modalEl.addClass('crucible-file-open-palette');
		this.limit = FILE_OPEN_LIMIT;
	}

	onOpen(): void {
		// Grab the snapshot once (finishing any pending chunked build/rebuild inline if
		// needed) and a fresh narrowing stack + recency map for this session — cheap, and
		// avoids stale recency data across repeated opens.
		this.narrowState = createNarrowState();
		this.recency = buildRecencyMap(this.app.workspace.getLastOpenFiles(), this.app.workspace.getActiveFile()?.path);
	}

	getSuggestions(query: string): FileOpenUiItem[] {
		const snapshot = this.plugin.fileOpenIndex.getSnapshot();
		const start = performance.now();
		const items = selectFileOpenItems(snapshot, query, this.narrowState, {
			extensions: this.plugin.settings.crucibleFileOpenPaletteExtensions,
			ignoredFolderMode: this.plugin.settings.crucibleFileOpenPaletteIgnoredFolderMode,
			createMissing: this.plugin.settings.crucibleFileOpenPaletteCreateMissing,
			limit: FILE_OPEN_LIMIT,
			recency: this.recency,
		});
		const elapsed = performance.now() - start;
		if (elapsed > SLOW_SELECTION_MS) {
			logWarn('fileOpenPalette', `selection took ${elapsed.toFixed(1)}ms for query "${query}" (budget ${SLOW_SELECTION_MS}ms)`);
		}

		// Match ranges are only ever built for the <=100 winners actually about to render.
		return items.map(item => item.kind === 'file' && item.score !== null
			? { ...item, match: buildFileOpenMatch(query, item.path, item.score) }
			: item);
	}

	renderSuggestion(item: FileOpenUiItem, el: HTMLElement): void {
		if (item.kind === 'create') {
			el.createDiv({ text: `Create ${item.path}` });
			el.createEl('small', { text: 'New Markdown note' });
			return;
		}

		const title = el.createDiv();
		try {
			if (item.match) {
				renderResults(title, item.path, item.match);
			} else {
				title.setText(item.path);
			}
		} catch (error) {
			// `matches` invariants (ascending, non-overlapping, in-bounds) are undocumented
			// in obsidian.d.ts. A missing highlight is cosmetic; a modal that throws
			// mid-render is not.
			logWarn('fileOpenPalette', 'renderResults failed; falling back to plain text', error);
			title.empty();
			title.setText(item.path);
		}

		if (item.ignored) {
			el.addClass('crucible-file-open-ignored');
			el.createEl('small', { text: 'Excluded from search' });
		}
	}

	onChooseSuggestion(item: FileOpenUiItem): void {
		void this.openItem(item);
	}

	private async openItem(item: FileOpenItem): Promise<void> {
		try {
			const file = item.kind === 'create'
				? await this.createMarkdownNote(item.path)
				: this.app.vault.getAbstractFileByPath(item.path);
			if (!(file instanceof TFile)) {
				new Notice(`File not found: ${item.path}`);
				return;
			}
			await this.app.workspace.getLeaf(false).openFile(file);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Open file failed: ${message}`);
		}
	}

	private async createMarkdownNote(path: string): Promise<TFile> {
		const normalized = normalizePath(path);
		await this.ensureParentFolders(normalized);
		return await this.app.vault.create(normalized, '');
	}

	private async ensureParentFolders(path: string): Promise<void> {
		const parts = path.split('/').slice(0, -1);
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (this.app.vault.getAbstractFileByPath(current)) continue;
			await this.app.vault.createFolder(current);
		}
	}
}
