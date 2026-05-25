import { App, Command, FuzzyMatch, FuzzySuggestModal } from 'obsidian';
import CruciblePlugin from './main';
import { getCommandHotkeyLabel } from './utils';
import { shortestUniqueFuzzyString } from './commandPaletteHints';

export class CrucibleCommandPaletteModal extends FuzzySuggestModal<Command> {
	private readonly crucibleCommandIds: Set<string>;
	private readonly pinnedOrder: Map<string, number>;
	/** Names of every command in the palette at launch — the set the unique string disambiguates against. */
	private readonly launchedNames: string[];
	private readonly hintCache = new Map<string, string | null>();

	constructor(app: App, private readonly plugin: CruciblePlugin) {
		super(app);
		this.setPlaceholder('Crucible: search commands...');
		this.modalEl.addClass('crucible-command-palette');
		const prefix = plugin.manifest.id;
		this.crucibleCommandIds = new Set(plugin.commandRegistry.map(e => `${prefix}:${e.id}`));
		const pinned = plugin.settings.crucibleCommandPalettePinned;
		this.pinnedOrder = new Map(pinned.map((id, i) => [id, i]));
		this.launchedNames = this.getItems().map(c => c.name);
	}

	getItems(): Command[] {
		const all = Object.values(this.app.commands.commands);
		const settings = this.plugin.settings;
		const prefix = this.plugin.manifest.id;
		const whitelist = new Set(settings.crucibleCommandPaletteWhitelist);
		const blacklist = new Set(settings.crucibleCommandPaletteBlacklist);

		return all.filter(cmd => {
			if (this.crucibleCommandIds.has(cmd.id)) {
				const unprefixed = cmd.id.startsWith(`${prefix}:`) ? cmd.id.slice(prefix.length + 1) : cmd.id;
				return !settings.hiddenCommands.includes(unprefixed);
			}
			if (settings.crucibleCommandPaletteFilterMode === 'whitelist') {
				return whitelist.has(cmd.id);
			}
			return !blacklist.has(cmd.id);
		});
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
		if (hint) pills.createEl('kbd', { text: hint, cls: 'crucible-palette-fuzzy-hint' });
	}

	/** Shortest string that surfaces only this command among the launched set (memoized). */
	private getUniqueHint(cmd: Command): string | null {
		const cached = this.hintCache.get(cmd.id);
		if (cached !== undefined) return cached;
		const competitors = removeFirstOccurrence(this.launchedNames, cmd.name);
		const hint = shortestUniqueFuzzyString(cmd.name, competitors);
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
