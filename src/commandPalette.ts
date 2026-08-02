import { App, Command, FuzzyMatch, FuzzySuggestModal, prepareFuzzySearch } from 'obsidian';
import type CruciblePlugin from './main';
import { CrucibleSettings } from './types';
import { getCommandHotkeyLabel } from './utils';
import { HintOptions, shortestUniqueFuzzyString, shortestTopMatchFuzzyString } from './commandPaletteHints';

/** A computed palette hint plus whether it came from the unique or fallback path. */
export interface PaletteHint {
	text: string;
	kind: 'unique' | 'top-match';
}

/** Bounds an empty-query row count, mirroring `FILE_OPEN_LIMIT` (`fileOpenRanking.ts`). */
export const COMMAND_PALETTE_LIMIT = 100;

/** One cache generation: the signature it was built for, plus its memoized hints. */
interface HintCacheState {
	signature: string;
	hints: Map<string, PaletteHint | null>;
}

// Module-level so a hint computed on one palette open survives to the next one. The
// previous cache was a `Map` *field* on `CrucibleCommandPaletteModal`, and Crucible
// constructs a fresh modal instance per open (`commands.ts`), so it started empty every
// time — the whole cost this WP removes. Only the LATEST signature's entries are kept
// (a `null` state resets to a fresh Map) because there is only ever one "current"
// disambiguation problem in a running plugin instance; a changed signature invalidates
// wholesale rather than pruning per-entry, which is the simplest correct policy per the
// governing plan (WP-G5).
let hintCacheState: HintCacheState | null = null;

/**
 * Order-insensitive signature identifying "the same disambiguation problem": the
 * launched command-name set (sorted, so open order never matters) plus every setting
 * `computeHint` actually reads. Folding the hint settings in (not just the name list) is
 * a deliberate widening of the plan's literal "signature of the command-name list": a
 * settings-only change (e.g. flipping the hint charset or fallback) with an unchanged
 * command set must still invalidate the cache, or the palette would silently keep
 * serving hints computed under the old settings until some command was added/removed.
 * `JSON.stringify` on a fixed-shape plain object also sidesteps hand-rolled delimiters
 * (see the NUL-sentinel quirk in the root AGENTS.md) — cheap at ~85 names.
 */
export function computeHintCacheSignature(names: string[], settings: CrucibleSettings): string {
	return JSON.stringify({
		names: [...names].sort(),
		maxLen: settings.crucibleCommandPaletteHintMaxLen,
		charsetMode: settings.crucibleCommandPaletteHintCharsetMode,
		whitelist: settings.crucibleCommandPaletteHintWhitelist,
		prefixPenalty: settings.crucibleCommandPaletteHintPrefixPenalty,
		positionBias: settings.crucibleCommandPaletteHintPositionBias,
		fallbackTopMatch: settings.crucibleCommandPaletteHintFallbackTopMatch,
	});
}

/** The hint cache for `signature`, resetting to empty whenever the signature changes. */
export function getHintCache(signature: string): Map<string, PaletteHint | null> {
	if (hintCacheState === null || hintCacheState.signature !== signature) {
		hintCacheState = { signature, hints: new Map() };
	}
	return hintCacheState.hints;
}

/** Charset predicate for hint candidate characters, per settings. */
export function buildAllowedChar(settings: CrucibleSettings): (ch: string) => boolean {
	if (settings.crucibleCommandPaletteHintCharsetMode === 'all-ascii') {
		return (ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e;
	}
	const whitelist = new Set(settings.crucibleCommandPaletteHintWhitelist);
	return (ch) => /[a-z0-9]/.test(ch) || whitelist.has(ch);
}

/** Build the tunable hint options from settings. */
export function buildHintOptions(settings: CrucibleSettings): HintOptions {
	return {
		maxLen: settings.crucibleCommandPaletteHintMaxLen,
		allowedChar: buildAllowedChar(settings),
		prefixPenalty: settings.crucibleCommandPaletteHintPrefixPenalty,
		positionBias: settings.crucibleCommandPaletteHintPositionBias,
	};
}

/** Obsidian's real fuzzy scorer, memoized per query so each candidate scores once. */
export function buildScoreText(): (query: string, text: string) => number | null {
	const cache = new Map<string, (text: string) => { score: number } | null>();
	return (query, text) => {
		let fn = cache.get(query);
		if (fn === undefined) { fn = prepareFuzzySearch(query); cache.set(query, fn); }
		return fn(text)?.score ?? null;
	};
}

/**
 * Compute the displayed hint for a command: the shortest unique fuzzy string,
 * or — when none exists and the fallback is enabled — the shortest string for
 * which the command is the strict top fuzzy match.
 */
export function computeHint(
	target: string,
	competitors: string[],
	settings: CrucibleSettings,
	opts: HintOptions,
	scoreText: (query: string, text: string) => number | null,
): PaletteHint | null {
	const unique = shortestUniqueFuzzyString(target, competitors, opts);
	if (unique !== null) return { text: unique, kind: 'unique' };
	if (!settings.crucibleCommandPaletteHintFallbackTopMatch) return null;
	const top = shortestTopMatchFuzzyString(target, competitors, opts, scoreText);
	return top === null ? null : { text: top, kind: 'top-match' };
}

/** The set of commands the Crucible palette shows, honoring visibility + whitelist/blacklist. */
export function getPaletteItems(app: App, plugin: CruciblePlugin): Command[] {
	const all = Object.values(app.commands.commands);
	const settings = plugin.settings;
	const prefix = plugin.manifest.id;
	const crucibleCommands = new Map(plugin.commandRegistry.map(e => [`${prefix}:${e.id}`, e]));
	const whitelist = new Set(settings.crucibleCommandPaletteWhitelist);
	const blacklist = new Set(settings.crucibleCommandPaletteBlacklist);

	return all.filter(cmd => {
		const entry = crucibleCommands.get(cmd.id);
		if (entry) {
			const unprefixed = cmd.id.startsWith(`${prefix}:`) ? cmd.id.slice(prefix.length + 1) : cmd.id;
			return !settings.hiddenCommands.includes(unprefixed) && isCrucibleCommandAvailable(entry.available);
		}
		if (settings.crucibleCommandPaletteFilterMode === 'whitelist') {
			return whitelist.has(cmd.id) && isObsidianCommandAvailable(cmd);
		}
		return !blacklist.has(cmd.id) && isObsidianCommandAvailable(cmd);
	});
}

function isCrucibleCommandAvailable(available: (() => boolean) | undefined): boolean {
	if (!available) return true;
	try {
		return available();
	} catch {
		return false;
	}
}

function isObsidianCommandAvailable(cmd: Command): boolean {
	if (!cmd.checkCallback) return true;
	try {
		return cmd.checkCallback(true) === true;
	} catch {
		return false;
	}
}

export class CrucibleCommandPaletteModal extends FuzzySuggestModal<Command> {
	private readonly pinnedOrder: Map<string, number>;
	/** Swept once at construction and reused for every `getItems()` call this open. */
	private readonly items: Command[];
	/** Names of every command in the palette at launch — the set the unique string disambiguates against. */
	private readonly launchedNames: string[];
	private readonly hintCache: Map<string, PaletteHint | null>;
	private readonly hintOptions: HintOptions;
	private readonly scoreText = buildScoreText();

	constructor(app: App, private readonly plugin: CruciblePlugin) {
		super(app);
		this.setPlaceholder('Crucible: search commands...');
		this.modalEl.addClass('crucible-command-palette');
		this.limit = COMMAND_PALETTE_LIMIT;
		const pinned = plugin.settings.crucibleCommandPalettePinned;
		this.pinnedOrder = new Map(pinned.map((id, i) => [id, i]));
		// Single sweep of app.commands.commands for this open — getItems() below just
		// returns this snapshot, instead of every keystroke's getSuggestions() (and the
		// old launchedNames computation) each re-sweeping and re-filtering it.
		this.items = getPaletteItems(this.app, this.plugin);
		this.launchedNames = this.items.map(c => c.name);
		this.hintOptions = buildHintOptions(plugin.settings);
		this.hintCache = getHintCache(computeHintCacheSignature(this.launchedNames, plugin.settings));
	}

	getItems(): Command[] {
		return this.items;
	}

	getItemText(cmd: Command): string {
		return cmd.name;
	}

	getSuggestions(query: string): FuzzyMatch<Command>[] {
		const matches = super.getSuggestions(query);
		if (this.pinnedOrder.size === 0) return matches;
		const pinned: FuzzyMatch<Command>[] = [];
		const rest: FuzzyMatch<Command>[] = [];
		for (const m of matches) {
			if (this.pinnedOrder.has(m.item.id)) pinned.push(m);
			else rest.push(m);
		}
		pinned.sort((a, b) => (this.pinnedOrder.get(a.item.id) ?? 0) - (this.pinnedOrder.get(b.item.id) ?? 0));
		return [...pinned, ...rest];
	}

	renderSuggestion(match: FuzzyMatch<Command>, el: HTMLElement): void {
		super.renderSuggestion(match, el);
		if (this.pinnedOrder.has(match.item.id)) {
			el.addClass('crucible-palette-pinned');
		}

		const settings = this.plugin.settings;
		const hotkey = settings.crucibleCommandPaletteShowHotkeys
			? getCommandHotkeyLabel(this.app, match.item.id)
			: null;
		const hint = settings.crucibleCommandPaletteShowUniqueString
			? this.getUniqueHint(match.item)
			: null;

		if (!hotkey && !hint) return;
		const pills = el.createDiv({ cls: 'crucible-palette-pills' });
		if (hotkey) pills.createEl('kbd', { text: hotkey });
		if (hint) {
			const cls = hint.kind === 'top-match'
				? 'crucible-palette-fuzzy-hint crucible-palette-fuzzy-hint-fallback'
				: 'crucible-palette-fuzzy-hint';
			pills.createEl('kbd', { text: hint.text, cls });
		}
	}

	/** Shortest string that surfaces this command among the launched set, or top-match fallback (memoized). */
	private getUniqueHint(cmd: Command): PaletteHint | null {
		const cached = this.hintCache.get(cmd.id);
		if (cached !== undefined) return cached;
		const competitors = removeFirstOccurrence(this.launchedNames, cmd.name);
		const hint = computeHint(cmd.name, competitors, this.plugin.settings, this.hintOptions, this.scoreText);
		this.hintCache.set(cmd.id, hint);
		return hint;
	}

	onChooseItem(cmd: Command): void {
		this.app.commands.executeCommandById(cmd.id);
	}
}

/** Returns a copy of `arr` with the first element equal to `value` removed (the row's own name). */
function removeFirstOccurrence(arr: string[], value: string): string[] {
	const idx = arr.indexOf(value);
	if (idx === -1) return arr.slice();
	return [...arr.slice(0, idx), ...arr.slice(idx + 1)];
}
