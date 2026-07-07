import { App, Notice, SearchResult, SuggestModal, TFile, normalizePath, prepareFuzzySearch, renderResults } from 'obsidian';
import { isPathExcluded } from './exclusions';
import {
	FileOpenCreateItem,
	FileOpenFileItem,
	FileOpenItem,
	rankFileOpenItems,
} from './fileOpenRanking';
import type CruciblePlugin from './main';

type FileOpenUiItem =
	| (FileOpenFileItem & { match?: SearchResult })
	| FileOpenCreateItem;

const FILE_OPEN_LIMIT = 100;

export class CrucibleFileOpenPaletteModal extends SuggestModal<FileOpenUiItem> {
	constructor(app: App, private readonly plugin: CruciblePlugin) {
		super(app);
		this.setPlaceholder('Crucible: open file...');
		this.setInstructions([
			{ command: 'Enter', purpose: 'open file' },
			{ command: 'Esc', purpose: 'cancel' },
		]);
		this.modalEl.addClass('crucible-file-open-palette');
	}

	getSuggestions(query: string): FileOpenUiItem[] {
		const matchByPath = new Map<string, SearchResult>();
		const needle = query.trim();
		const fuzzySearch = needle ? prepareFuzzySearch(needle) : null;
		const ranked = rankFileOpenItems({
			files: this.app.vault.getFiles().map(file => ({ path: file.path, extension: file.extension })),
			query,
			extensions: this.plugin.settings.crucibleFileOpenPaletteExtensions,
			ignoredFolderMode: this.plugin.settings.crucibleFileOpenPaletteIgnoredFolderMode,
			createMissing: this.plugin.settings.crucibleFileOpenPaletteCreateMissing,
			isIgnoredPath: path => isPathExcluded(this.plugin.settings, path, 'search'),
			scorePath: (_q, path) => {
				const match = fuzzySearch?.(path) ?? null;
				if (match) matchByPath.set(path, match);
				return match?.score ?? null;
			},
			limit: FILE_OPEN_LIMIT,
		});

		return ranked.map(item => item.kind === 'file'
			? { ...item, match: matchByPath.get(item.path) }
			: item);
	}

	renderSuggestion(item: FileOpenUiItem, el: HTMLElement): void {
		if (item.kind === 'create') {
			el.createDiv({ text: `Create ${item.path}` });
			el.createEl('small', { text: 'New Markdown note' });
			return;
		}

		const title = el.createDiv();
		if (item.match) {
			renderResults(title, item.path, item.match);
		} else {
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
