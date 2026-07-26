import { TAbstractFile, TFile, TFolder, AbstractInputSuggest, App, SearchResult, prepareFuzzySearch, renderResults, Command, getAllTags } from "obsidian";
import type CruciblePlugin from "./main";
import { Currency, fetchCurrencies } from "./orchestration/utils/fx";
import { GeoResult, geocodeLocation } from "./orchestration/utils/weather";
import { loadConfiguredChannels } from "./orchestration/utils/feedIntake";
import type { ChannelEntry } from "./orchestration/utils/youtube";
import { CurrencyCache, GeocodeCacheEntry, ProviderCatalogModel } from "./types";
import { buildRanges, compileQuery, scoreCompiledText, ScoreResult } from "./rankScore";
import { buildProviderModelSuggestRows, catalogEntrySummaryTokens } from "./settings/modelCapabilities";

/** One scored candidate, held only long enough to build the bounded top-K result. */
interface ScoredCandidate<T> {
    item: T;
    result: ScoreResult;
}

/**
 * Bounded top-K selection via a size-`limit` min-heap keyed on `result.score`
 * (descending — see `SCORE_HIGHER_IS_BETTER` in `rankScore.ts`), so ranking
 * 47,000 candidates down to the 100 shown costs `O(n log limit)` rather than
 * sorting every admitted match. Ties are broken by shortest path, then
 * shallowest depth, mirroring the palette's tiebreak.
 */
function selectTopScored<T>(items: T[], limit: number, score: (item: T) => ScoreResult | null, path: (item: T) => string): ScoredCandidate<T>[] {
    if (limit <= 0) return [];
    const heap: ScoredCandidate<T>[] = [];
    for (const item of items) {
        const result = score(item);
        if (result === null) continue;
        if (heap.length < limit) {
            heap.push({ item, result });
            if (heap.length === limit) heapify(heap);
        } else if (result.score > heap[0]!.result.score) {
            heap[0] = { item, result };
            siftDown(heap, 0, heap.length);
        }
    }
    heap.sort((a, b) => {
        if (a.result.score !== b.result.score) return b.result.score - a.result.score;
        const aPath = path(a.item);
        const bPath = path(b.item);
        if (aPath.length !== bPath.length) return aPath.length - bPath.length;
        return pathDepth(aPath) - pathDepth(bPath);
    });
    return heap;
}

function heapify<T>(heap: ScoredCandidate<T>[]): void {
    for (let i = (heap.length >> 1) - 1; i >= 0; i--) siftDown(heap, i, heap.length);
}

/** Min-heap sift, ordered by `result.score` ascending (the root is the current worst). */
function siftDown<T>(heap: ScoredCandidate<T>[], index: number, size: number): void {
    let i = index;
    for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < size && heap[l]!.result.score < heap[smallest]!.result.score) smallest = l;
        if (r < size && heap[r]!.result.score < heap[smallest]!.result.score) smallest = r;
        if (smallest === i) return;
        const tmp = heap[i]!;
        heap[i] = heap[smallest]!;
        heap[smallest] = tmp;
        i = smallest;
    }
}

function pathDepth(path: string): number {
    return path.split('/').length;
}

export abstract class FileSystemSuggest extends AbstractInputSuggest<TAbstractFile> {
    public inputEl: HTMLInputElement;
    /** Loaded once per suggester instance — the instance is short-lived (one settings-tab input). */
    private itemsCache: TAbstractFile[] | null = null;
    /** Score + highlight ranges computed while ranking, reused by `renderSuggestion`. */
    private matchCache = new Map<string, SearchResult>();

    constructor(app: App, inputEl: HTMLInputElement) {
        super(app, inputEl);
        this.inputEl = inputEl;
    }

    abstract loadItems(): TAbstractFile[];

    private getItems(): TAbstractFile[] {
        if (this.itemsCache === null) this.itemsCache = this.loadItems();
        return this.itemsCache;
    }

    getSuggestions(inputStr: string): TAbstractFile[] {
        const items = this.getItems();
        this.matchCache.clear();

        if (!inputStr) {
            return items
                .slice()
                .sort((a, b) => (a.path.length - b.path.length) || (pathDepth(a.path) - pathDepth(b.path)))
                .slice(0, 100);
        }

        const compiled = compileQuery(inputStr);
        const winners = selectTopScored(items, 100, item => scoreCompiledText(compiled, item.path), item => item.path);
        for (const winner of winners) {
            this.matchCache.set(winner.item.path, {
                score: winner.result.score,
                matches: buildRanges(compiled, winner.item.path),
            });
        }
        return winners.map(w => w.item);
    }

    renderSuggestion(file: TAbstractFile, el: HTMLElement): void {
        const cached = this.matchCache.get(file.path);
        if (cached) {
            renderResults(el, file.path, cached);
            return;
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

    loadItems(): TAbstractFile[] {
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

    loadItems(): TAbstractFile[] {
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

/**
 * WP-D — the model id field's probe-first-with-manual-fallback control. Mirrors `CurrencySuggest`
 * exactly in one respect (a synchronous cache lookup rendered as suggestions) and departs from it
 * in another: the currency/geocode suggesters fetch-and-cache lazily from inside `getSuggestions`,
 * but here `listModels()` fires only from the settings pane's explicit "Fetch models" button (D2
 * rule 1) — this class only ever reads the already-persisted `Provider.modelCatalog` via
 * `getCatalog`, synchronously, so it never issues a network request per keystroke.
 *
 * Critically, this class does NOT own the input's value — it only decorates it with a dropdown.
 * `AbstractInputSuggest` never intercepts typing itself; the underlying `TextComponent`'s own
 * `onChange` (wired by the caller, exactly as before this class existed) keeps firing on every
 * keystroke regardless of whether anything here matches. That is what makes "free text survives"
 * true by construction: an id absent from the catalog — or a catalog that's empty because the
 * probe was never run, came back empty, or the server is unreachable — simply produces no
 * suggestions, and the text field behaves exactly as it always did.
 *
 * WP-1: when a query matches more than the 100-row cap, the dropdown gains a trailing,
 * non-selectable "+N more — use the catalog browser below" row rather than silently dropping the
 * rest with no indication anything was cut — that's what the inline catalog browser panel
 * (`settings/modelCatalogBrowser.ts`) exists to reach. `ProviderModelSuggestMoreRow` is a distinct
 * shape (never a real `ProviderCatalogModel`) so `renderSuggestion`/`selectSuggestion` can tell the
 * tail row apart from an actual entry without a sentinel id that could theoretically collide.
 */
interface ProviderModelSuggestMoreRow {
	moreCount: number;
}

function isProviderModelSuggestMoreRow(row: ProviderCatalogModel | ProviderModelSuggestMoreRow): row is ProviderModelSuggestMoreRow {
	return "moreCount" in row;
}

export class ProviderModelSuggest extends AbstractInputSuggest<ProviderCatalogModel | ProviderModelSuggestMoreRow> {
	public inputEl: HTMLInputElement;
	private getCatalog: () => ProviderCatalogModel[];
	private onChoose?: (entry: ProviderCatalogModel) => void;

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		getCatalog: () => ProviderCatalogModel[],
		onChoose?: (entry: ProviderCatalogModel) => void,
	) {
		super(app, inputEl);
		this.inputEl = inputEl;
		this.getCatalog = getCatalog;
		this.onChoose = onChoose;
		// This class already enforces its own 100-row cap (via `buildProviderModelSuggestRows`,
		// deliberately, so the cap is unit-testable without bundling Obsidian's fuzzy matcher) and,
		// with WP-1, may append one further synthetic "+N more" row on top of that cap — 101 items
		// total. `AbstractInputSuggest`'s own built-in `limit` (default 100) would silently drop
		// that 101st row before it ever renders, so it's disabled here in favour of the cap this
		// class already manages itself.
		this.limit = 0;
	}

	getSuggestions(inputStr: string): (ProviderCatalogModel | ProviderModelSuggestMoreRow)[] {
		// Substring filter (`filterCatalogModelsForQuery`, via `buildProviderModelSuggestRows`), not
		// `prepareFuzzySearch` like the other suggesters here — deliberately, so the "an id absent
		// from the catalog is never forced to match" guarantee is unit-testable without bundling
		// Obsidian's fuzzy matcher. Model ids are short and typically typed near-verbatim (often via
		// copy-paste from a server's own listing), so substring matching costs little in practice.
		const { rows, overflowCount } = buildProviderModelSuggestRows(this.getCatalog(), inputStr);
		return overflowCount > 0 ? [...rows, { moreCount: overflowCount }] : rows;
	}

	renderSuggestion(entry: ProviderCatalogModel | ProviderModelSuggestMoreRow, el: HTMLElement): void {
		if (isProviderModelSuggestMoreRow(entry)) {
			el.createDiv({ text: `+${entry.moreCount} more — use the catalog browser below`, cls: "suggestion-aux mod-muted" });
			return;
		}
		el.createDiv({ text: entry.id });
		// WP-8: richer suggestions — every summary token the catalog carries (type, quantization,
		// arch, context size, embedding width, server capability tags, input modalities, param
		// count), not just the first two. Shares `catalogEntrySummaryTokens` with the "<Provider>
		// reports: ..." provenance line in ai.ts rather than maintaining a second, narrower list.
		const aux = catalogEntrySummaryTokens(entry).join(' · ');
		if (aux) el.createDiv({ text: aux, cls: "suggestion-aux" });
	}

	selectSuggestion(entry: ProviderCatalogModel | ProviderModelSuggestMoreRow): void {
		// Non-selectable per the brief: the tail row carries no real model id to pick, so picking
		// it is a no-op rather than writing "+N more — use the catalog browser below" into the field.
		if (isProviderModelSuggestMoreRow(entry)) return;
		this.inputEl.value = entry.id;
		this.inputEl.dispatchEvent(new Event("input"));
		if (this.onChoose) this.onChoose(entry);
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
