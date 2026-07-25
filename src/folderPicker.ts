import { App, SearchResult, SuggestModal, TFolder, normalizePath, renderResults } from 'obsidian';
import { CrucibleSettings } from './types';
import { PERIOD_IDS, getCurrentPeriodAssetFolder, getPeriodConfig } from './periods';
import { buildRanges, compileQuery, scoreCompiledText } from './rankScore';

interface FolderPickerItem {
	path: string;
	pinLabel?: string;
	pinOrder: number;
	/** Precomputed once when the item is built — never recomputed inside a comparator. */
	depth: number;
	/** Score comes from the composite (label + path); ranges are built over `path` alone. */
	match?: SearchResult;
}

interface FolderPin {
	path: string;
	label: string;
}

export class MoveFileFolderPickerModal extends SuggestModal<FolderPickerItem> {
	private picked = false;

	constructor(
		app: App,
		private settings: CrucibleSettings,
		private onPick: (folderPath: string) => void | Promise<void>,
		private onCancel?: () => void,
	) {
		super(app);
		this.setPlaceholder('Move current file to folder...');
		this.setInstructions([
			{ command: 'Enter', purpose: 'move to folder' },
			{ command: 'Esc', purpose: 'cancel' },
		]);
	}

	getSuggestions(query: string): FolderPickerItem[] {
		const items = this.getItems();
		const needle = query.trim();
		if (!needle) return items.slice(0, this.limit);

		const compiled = compileQuery(needle);
		const scored: { item: FolderPickerItem; score: number }[] = [];
		for (const item of items) {
			// One score covers both halves — the pin label and the path — rather than
			// fuzzy-searching each separately, so typing a pin's label still ranks its folder.
			const composite = item.pinLabel ? `${item.pinLabel} ${item.path}` : item.path;
			const result = scoreCompiledText(compiled, composite);
			if (result === null) continue;
			scored.push({ item, score: result.score });
		}

		scored.sort((a, b) => {
			if (a.item.pinOrder !== b.item.pinOrder) return a.item.pinOrder - b.item.pinOrder;
			if (a.score !== b.score) return b.score - a.score;
			return compareByDepthThenPath(a.item, b.item);
		});

		// Ranges are rebuilt over `path` alone rather than reused from the composite. A match
		// landing in the label half has no position in `path`, and shifting composite ranges
		// back by an offset would hand `renderResults` negative indices for exactly those
		// matches. Rebuilding is O(path length) on <=limit rows and needs no offset, so it
		// also drops a dependency on `renderResults`' undocumented 4th parameter.
		return scored.slice(0, this.limit).map(({ item, score }) => ({
			...item,
			match: { score, matches: buildRanges(compiled, item.path) },
		}));
	}

	renderSuggestion(item: FolderPickerItem, el: HTMLElement): void {
		const title = el.createDiv();
		if (item.match) {
			renderResults(title, item.path, item.match);
		} else {
			title.setText(item.path);
		}
		if (item.pinLabel) {
			el.createEl('small', { text: item.pinLabel });
		}
	}

	onChooseSuggestion(item: FolderPickerItem): void {
		this.picked = true;
		void this.onPick(item.path);
	}

	onClose(): void {
		super.onClose();
		if (!this.picked && this.onCancel) this.onCancel();
	}

	private getItems(): FolderPickerItem[] {
		const pinned = this.getPinnedFolders();
		const items: FolderPickerItem[] = [];
		const seen = new Set<string>();

		pinned.forEach((pin, index) => {
			if (seen.has(pin.path)) return;
			seen.add(pin.path);
			items.push({ path: pin.path, pinLabel: pin.label, pinOrder: index, depth: pathDepth(pin.path) });
		});

		const normalOrder = Number.MAX_SAFE_INTEGER;
		// Depth is computed once per folder here, not inside the sort comparator, which
		// would otherwise re-split() every path on every comparison.
		this.app.vault.getAllLoadedFiles()
			.filter((file): file is TFolder => file instanceof TFolder)
			.map(folder => normalizeFolderPath(folder.path))
			.filter((path): path is string => path !== null)
			.filter(path => !this.app.metadataCache.isUserIgnored(path))
			.map(path => ({ path, depth: pathDepth(path) }))
			.sort(compareByDepthThenPath)
			.forEach(({ path, depth }) => {
				if (seen.has(path)) return;
				seen.add(path);
				items.push({ path, pinOrder: normalOrder, depth });
			});

		return items;
	}

	private getPinnedFolders(): FolderPin[] {
		const pins: FolderPin[] = [];
		for (const period of PERIOD_IDS) {
			const config = getPeriodConfig(this.settings, period);
			if (config.enabled && config.pinInMovePicker) {
				addPin(pins, getCurrentPeriodAssetFolder(this.settings, period), `${config.label} asset folder`);
			}
		}
		for (const folder of this.settings.moveFilePinnedFolders) {
			addPin(pins, folder, 'Pinned folder');
		}
		return pins;
	}
}

export function normalizeFolderPath(path: string): string | null {
	const normalized = normalizePath(path.trim()).replace(/^\/+/, '').replace(/\/+$/, '');
	return normalized || null;
}

function addPin(pins: FolderPin[], path: string, label: string): void {
	const normalized = normalizeFolderPath(path);
	if (!normalized) return;
	pins.push({ path: normalized, label });
}

function pathDepth(path: string): number {
	return path.split('/').length;
}

/** Depth must already be precomputed on both items — never split()s inside the compare. */
function compareByDepthThenPath(a: { path: string; depth: number }, b: { path: string; depth: number }): number {
	if (a.depth !== b.depth) return a.depth - b.depth;
	return a.path.localeCompare(b.path);
}
