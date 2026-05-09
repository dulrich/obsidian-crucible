import { App, SearchResult, SuggestModal, TFolder, normalizePath, prepareFuzzySearch, renderResults } from 'obsidian';
import { CrucibleSettings } from './types';
import { PERIOD_IDS, getCurrentPeriodAssetFolder, getPeriodConfig } from './periods';

interface FolderPickerItem {
	path: string;
	pinLabel?: string;
	pinOrder: number;
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

		const fuzzySearch = prepareFuzzySearch(needle);
		return items
			.map(item => ({
				...item,
				match: fuzzySearch(`${item.pinLabel ?? ''} ${item.path}`),
				pathMatch: fuzzySearch(item.path),
			}))
			.filter((item): item is FolderPickerItem & { pathMatch: SearchResult | null; match: SearchResult } => item.match !== null)
			.sort((a, b) => {
				if (a.pinOrder !== b.pinOrder) return a.pinOrder - b.pinOrder;
				if (a.match.score !== b.match.score) return a.match.score - b.match.score;
				return compareFolderPaths(a.path, b.path);
			})
			.map(item => ({ ...item, match: item.pathMatch ?? undefined }))
			.slice(0, this.limit);
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
			items.push({ path: pin.path, pinLabel: pin.label, pinOrder: index });
		});

		const normalOrder = Number.MAX_SAFE_INTEGER;
		this.app.vault.getAllLoadedFiles()
			.filter((file): file is TFolder => file instanceof TFolder)
			.map(folder => normalizeFolderPath(folder.path))
			.filter((path): path is string => path !== null)
			.filter(path => !this.app.metadataCache.isUserIgnored(path))
			.sort(compareFolderPaths)
			.forEach(path => {
				if (seen.has(path)) return;
				seen.add(path);
				items.push({ path, pinOrder: normalOrder });
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

function compareFolderPaths(a: string, b: string): number {
	const depthA = a.split('/').length;
	const depthB = b.split('/').length;
	if (depthA !== depthB) return depthA - depthB;
	return a.localeCompare(b);
}
