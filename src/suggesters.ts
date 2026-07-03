import { TAbstractFile, TFile, TFolder, AbstractInputSuggest, App, prepareFuzzySearch, renderResults, Command, getAllTags } from "obsidian";
import type CruciblePlugin from "./main";
import { Currency, fetchCurrencies } from "./orchestration/utils/fx";
import { GeoResult, geocodeLocation } from "./orchestration/utils/weather";
import { loadConfiguredChannels } from "./orchestration/utils/feedIntake";
import type { ChannelEntry } from "./orchestration/utils/youtube";
import { CurrencyCache, GeocodeCacheEntry } from "./types";

export abstract class FileSystemSuggest extends AbstractInputSuggest<TAbstractFile> {
    public inputEl: HTMLInputElement;

    constructor(app: App, inputEl: HTMLInputElement) {
        super(app, inputEl);
        this.inputEl = inputEl;
    }

    abstract getItems(): TAbstractFile[];

    getSuggestions(inputStr: string): TAbstractFile[] {
        const items = this.getItems();
        
        if (!inputStr) {
            return items
                .sort((a, b) => (a.path.length - b.path.length) || (a.path.split('/').length - b.path.split('/').length))
                .slice(0, 100);
        }

        const fuzzySearch = prepareFuzzySearch(inputStr);
        const results = items
            .map(item => ({ item, result: fuzzySearch(item.path) }))
            .filter(res => res.result !== null)
            .sort((a, b) => {
                if (a.result!.score !== b.result!.score) {
                    return a.result!.score - b.result!.score;
                }
                if (a.item.path.length !== b.item.path.length) {
                    return a.item.path.length - b.item.path.length;
                }
                const aDepth = a.item.path.split('/').length;
                const bDepth = b.item.path.split('/').length;
                return aDepth - bDepth;
            })
            .map(res => res.item);

        return results.slice(0, 100);
    }

    renderSuggestion(file: TAbstractFile, el: HTMLElement): void {
        const inputStr = this.inputEl ? this.inputEl.value : "";
        
        if (inputStr) {
            const fuzzySearch = prepareFuzzySearch(inputStr);
            const result = fuzzySearch(file.path);
            if (result) {
                renderResults(el, file.path, result);
                return;
            }
        }
        
        el.setText(file.path);
    }

    selectSuggestion(file: TAbstractFile): void {
        this.inputEl.value = file.path;
        this.inputEl.dispatchEvent(new Event("input"));
        this.close();
    }
}

export class FolderSuggest extends FileSystemSuggest {
    constructor(app: App, inputEl: HTMLInputElement) {
        super(app, inputEl);
    }

    getItems(): TAbstractFile[] {
        const files = this.app.vault.getAllLoadedFiles();
        return files.filter(f => {
            if (!(f instanceof TFolder)) return false;
            return !this.app.metadataCache.isUserIgnored(f.path);
        });
    }
}

export class FileSuggest extends FileSystemSuggest {
    constructor(app: App, inputEl: HTMLInputElement) {
        super(app, inputEl);
    }

    getItems(): TAbstractFile[] {
        const files = this.app.vault.getAllLoadedFiles();
        return files.filter(f => {
            if (!(f instanceof TFile) || f.extension !== 'md') return false;
            return !this.app.metadataCache.isUserIgnored(f.path);
        });
    }
}

export class CommandSuggest extends AbstractInputSuggest<Command> {
	public inputEl: HTMLInputElement;
	private extraCommands: Command[];
	private excludeIds: string[];
	private onChoose?: (command: Command) => void;

	constructor(app: App, inputEl: HTMLInputElement, extraCommands: Command[] = [], onChoose?: (command: Command) => void, excludeIds: string[] = []) {
		super(app, inputEl);
		this.inputEl = inputEl;
		this.extraCommands = extraCommands;
		this.excludeIds = excludeIds;
		this.onChoose = onChoose;
	}

	getItems(): Command[] {
		const items = getCommandSuggestItems(this.app, this.extraCommands);
		if (this.excludeIds.length === 0) return items;
		const excluded = new Set(this.excludeIds);
		return items.filter(cmd => !excluded.has(cmd.id));
	}

	getSuggestions(inputStr: string): Command[] {
		const items = this.getItems();
		if (!inputStr) return items.slice(0, 100);

		const fuzzySearch = prepareFuzzySearch(inputStr);
		return items
			.map(item => ({ item, result: fuzzySearch(item.name) }))
			.filter(res => res.result !== null)
			.sort((a, b) => b.result!.score - a.result!.score)
			.map(res => res.item)
			.slice(0, 100);
	}

	renderSuggestion(command: Command, el: HTMLElement): void {
		el.setText(command.name);
	}

	selectSuggestion(command: Command): void {
		if (this.onChoose) {
			this.inputEl.value = command.name;
			this.onChoose(command);
		} else {
			this.inputEl.value = command.id;
			this.inputEl.dispatchEvent(new Event("input"));
		}
		this.close();
	}
}

export class TagSuggest extends AbstractInputSuggest<string> {
	public inputEl: HTMLInputElement;

	constructor(app: App, inputEl: HTMLInputElement) {
		super(app, inputEl);
		this.inputEl = inputEl;
	}

	private getItems(): string[] {
		const tags = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			for (const tag of getAllTags(cache) ?? []) {
				tags.add(tag.startsWith('#') ? tag : `#${tag}`);
			}
		}
		return Array.from(tags).sort((a, b) => a.localeCompare(b));
	}

	getSuggestions(inputStr: string): string[] {
		const items = this.getItems();
		if (!inputStr) return items.slice(0, 100);

		const fuzzySearch = prepareFuzzySearch(inputStr.replace(/^#/, ''));
		return items
			.map(item => ({ item, result: fuzzySearch(item.replace(/^#/, '')) }))
			.filter(res => res.result !== null)
			.sort((a, b) => b.result!.score - a.result!.score)
			.map(res => res.item)
			.slice(0, 100);
	}

	renderSuggestion(tag: string, el: HTMLElement): void {
		el.setText(tag);
	}

	selectSuggestion(tag: string): void {
		this.inputEl.value = tag;
		this.inputEl.dispatchEvent(new Event("input"));
		this.close();
	}
}

export interface YoutubeChannelSuggestItem {
	name: string;
	channelId: string;
}

export function youtubeChannelSuggestLabel(item: YoutubeChannelSuggestItem): string {
	return `${item.name || '(unnamed)'} (${item.channelId})`;
}

export class YoutubeChannelSuggest extends AbstractInputSuggest<YoutubeChannelSuggestItem> {
	public inputEl: HTMLInputElement;
	private plugin: CruciblePlugin;

	constructor(app: App, inputEl: HTMLInputElement, plugin: CruciblePlugin) {
		super(app, inputEl);
		this.inputEl = inputEl;
		this.plugin = plugin;
	}

	private async getItems(): Promise<YoutubeChannelSuggestItem[]> {
		const configured = await loadConfiguredChannels(this.app, this.plugin);
		return Array.from(configured.values(), value => toYoutubeChannelSuggestItem(value.channel))
			.sort((a, b) => a.name.localeCompare(b.name) || a.channelId.localeCompare(b.channelId));
	}

	async getSuggestions(inputStr: string): Promise<YoutubeChannelSuggestItem[]> {
		const items = await this.getItems();
		if (!inputStr) return items.slice(0, 100);

		const fuzzySearch = prepareFuzzySearch(inputStr);
		return items
			.map(item => ({ item, result: fuzzySearch(youtubeChannelSuggestLabel(item)) }))
			.filter(res => res.result !== null)
			.sort((a, b) => b.result!.score - a.result!.score)
			.map(res => res.item)
			.slice(0, 100);
	}

	renderSuggestion(item: YoutubeChannelSuggestItem, el: HTMLElement): void {
		el.createDiv({ text: item.name || '(unnamed)' });
		el.createDiv({ text: item.channelId, cls: "suggestion-aux" });
	}

	selectSuggestion(item: YoutubeChannelSuggestItem): void {
		this.inputEl.value = item.channelId;
		this.inputEl.dispatchEvent(new Event("input"));
		this.close();
	}
}

function toYoutubeChannelSuggestItem(channel: ChannelEntry): YoutubeChannelSuggestItem {
	return {
		name: channel.name,
		channelId: channel.channelId,
	};
}

export class CurrencySuggest extends AbstractInputSuggest<Currency> {
	public inputEl: HTMLInputElement;
	private loadCache: () => CurrencyCache | undefined;
	private saveCache: (cache: CurrencyCache) => Promise<void>;
	private onChoose: (currency: Currency) => void | Promise<void>;

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		loadCache: () => CurrencyCache | undefined,
		saveCache: (cache: CurrencyCache) => Promise<void>,
		onChoose: (currency: Currency) => void | Promise<void>,
	) {
		super(app, inputEl);
		this.inputEl = inputEl;
		this.loadCache = loadCache;
		this.saveCache = saveCache;
		this.onChoose = onChoose;
	}

	private async getCurrencies(): Promise<Currency[]> {
		const cached = this.loadCache();
		if (cached) return cached.currencies;
		const currencies = await fetchCurrencies();
		await this.saveCache({ fetchedAt: new Date().toISOString(), currencies });
		return currencies;
	}

	async getSuggestions(inputStr: string): Promise<Currency[]> {
		const items = await this.getCurrencies();
		if (!inputStr) return items.slice(0, 100);

		const fuzzySearch = prepareFuzzySearch(inputStr);
		return items
			.map(item => ({ item, result: fuzzySearch(`${item.code} ${item.name}`) }))
			.filter(res => res.result !== null)
			.sort((a, b) => b.result!.score - a.result!.score)
			.map(res => res.item)
			.slice(0, 100);
	}

	renderSuggestion(currency: Currency, el: HTMLElement): void {
		el.setText(`${currency.code} — ${currency.name}`);
	}

	selectSuggestion(currency: Currency): void {
		this.inputEl.value = currency.code;
		void this.onChoose(currency);
		this.close();
	}
}

export class LocationSuggest extends AbstractInputSuggest<GeoResult> {
	public inputEl: HTMLInputElement;
	private loadCache: (query: string) => GeocodeCacheEntry | undefined;
	private saveCache: (query: string, entry: GeocodeCacheEntry) => Promise<void>;
	private onChoose: (result: GeoResult) => void | Promise<void>;
	private lastQuery = "";

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		loadCache: (query: string) => GeocodeCacheEntry | undefined,
		saveCache: (query: string, entry: GeocodeCacheEntry) => Promise<void>,
		onChoose: (result: GeoResult) => void | Promise<void>,
	) {
		super(app, inputEl);
		this.inputEl = inputEl;
		this.loadCache = loadCache;
		this.saveCache = saveCache;
		this.onChoose = onChoose;
	}

	async getSuggestions(inputStr: string): Promise<GeoResult[]> {
		const query = inputStr.trim().toLowerCase();
		if (query.length < 2) return [];

		const cached = this.loadCache(query);
		if (cached) return cached.results;

		// Debounce: only fire the network request if this is still the latest query.
		this.lastQuery = query;
		await new Promise(resolve => setTimeout(resolve, 250));
		if (this.lastQuery !== query) return [];

		const results = await geocodeLocation(query);
		await this.saveCache(query, { fetchedAt: new Date().toISOString(), results });
		return results;
	}

	renderSuggestion(result: GeoResult, el: HTMLElement): void {
		el.createDiv({ text: result.label });
		if (result.admin1) {
			el.createDiv({ text: result.admin1, cls: "suggestion-aux" });
		}
	}

	selectSuggestion(result: GeoResult): void {
		this.inputEl.value = result.label;
		void this.onChoose(result);
		this.close();
	}
}

export function getCommandSuggestItems(app: App, extraCommands: Command[] = []): Command[] {
	const registry = (app as unknown as { commands: { commands: Record<string, Command> } }).commands.commands;
	const commands = Object.values(registry);
	return [...extraCommands, ...commands];
}

export function findCommandSuggestItem(app: App, value: string, extraCommands: Command[] = []): Command | undefined {
	const normalizedValue = value.trim();
	return getCommandSuggestItems(app, extraCommands)
		.find(command => command.id === normalizedValue || command.name === normalizedValue);
}

export function getCommandSuggestDisplayName(app: App, commandId: string, extraCommands: Command[] = []): string {
	return getCommandSuggestItems(app, extraCommands)
		.find(command => command.id === commandId)?.name || commandId;
}
