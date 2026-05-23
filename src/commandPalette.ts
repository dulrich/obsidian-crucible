import { App, Command, FuzzyMatch, FuzzySuggestModal } from 'obsidian';
import CruciblePlugin from './main';

export class CrucibleCommandPaletteModal extends FuzzySuggestModal<Command> {
	private readonly crucibleCommandIds: Set<string>;
	private readonly pinnedOrder: Map<string, number>;

	constructor(app: App, private readonly plugin: CruciblePlugin) {
		super(app);
		this.setPlaceholder('Crucible: search commands...');
		const prefix = plugin.manifest.id;
		this.crucibleCommandIds = new Set(plugin.commandRegistry.map(e => `${prefix}:${e.id}`));
		const pinned = plugin.settings.crucibleCommandPalettePinned;
		this.pinnedOrder = new Map(pinned.map((id, i) => [id, i]));
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
	}

	onChooseItem(cmd: Command): void {
		this.app.commands.executeCommandById(cmd.id);
	}
}
