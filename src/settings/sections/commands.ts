/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import type { CrucibleCommandEntry, CrucibleCommandGroup } from "../../main";
import { commandAvailabilityHelp } from "../../commandAvailability";
import { getCommandHotkeyLabel } from "../../utils";
import { CommandSuggest, getCommandSuggestDisplayName } from "../../suggesters";
import { CrucibleCommandPaletteFilterMode, CrucibleCommandPaletteHintCharsetMode, CrucibleFileOpenIgnoredFolderMode } from "../../types";
import { FileTypeGroup, commitSelectedExtensions, deriveFileTypeGroups, resolveSelectedExtensions } from "../../fileTypes";
import { SearchWithContainer } from "../shared";
import { bindToggle, bindDropdown, bindText, bindNumber, Save } from "../bind";

function getChainOnlyCommandList(): { id: string, name: string }[] {
	return [
		{ id: 'crucible:source:active-file', name: 'Source: Active file contents' },
		{ id: 'crucible:source:selection', name: 'Source: Editor selection' },
		{ id: 'crucible:source:input', name: 'Source: User input' },
		{ id: 'crucible:copy-active-file', name: 'Copy note to clipboard' },
		{ id: 'crucible:copy-note-to-folder', name: 'Copy note to folder' },
		{ id: 'crucible:replace-note-body', name: 'Replace note body' },
		{ id: 'crucible:capture', name: 'Quick Capture' },
		{ id: 'crucible:upsert-property', name: 'Add/update property' },
		{ id: 'crucible:upsert-tags', name: 'Upsert tags' },
	];
}

function renderHotkey(tab: CrucibleSettingTab, el: HTMLElement, commandId: string) {
	const fullId = `${tab.plugin.manifest.id}:${commandId}`;
	const label = getCommandHotkeyLabel(tab.app, fullId);
	if (!label) return;

	const hotkeyEl = document.createElement('div');
	hotkeyEl.classList.add('crucible-hotkey-display');
	hotkeyEl.createEl('kbd', { text: label });

	el.prepend(hotkeyEl);
}

type CommandVisibilityItem = Pick<CrucibleCommandEntry, 'id' | 'name' | 'availabilityHelp'>;

export function renderCommandSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	new Setting(containerEl).setName('Command visibility').setHeading();
	containerEl.createEl('p', { text: 'Control where commands appear. "Palette" shows the command in the Obsidian Command Palette. "Chains" shows it in the chain step search.' });

	const toggleList = (list: string[], id: string, enabled: boolean): string[] => {
		if (enabled) return list.filter(x => x !== id);
		return list.includes(id) ? list : [...list, id];
	};

	// Palette + Chain Search toggles — for commands registered with this.addCommand()
	const renderGroup = (title: string, commands: CommandVisibilityItem[]) => {
		if (commands.length === 0) return;

		new Setting(containerEl).setName(title).setHeading();
		const group = containerEl.createDiv({ cls: 'crucible-settings-group' });

		const header = new Setting(group).setName('').setDesc('');
		header.controlEl.createSpan({ text: 'Palette', cls: 'crucible-toggle-header' });
		header.controlEl.createSpan({ text: 'Chains', cls: 'crucible-toggle-header' });

		commands.sort((a, b) => a.name.localeCompare(b.name));

		commands.forEach((cmd, index) => {
			if (index > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
			const disabledHelp = commandAvailabilityHelp(cmd);
			const s = new Setting(group)
				.setName(cmd.name);
			if (disabledHelp !== null) {
				s.setDesc(disabledHelp);
				s.settingEl.addClass('is-disabled');
				s.descEl.addClass('crucible-setting-warning');
			}
			s.addToggle(toggle => {
				toggle
					.setTooltip(disabledHelp ?? 'Show in Command Palette')
					.setValue(!tab.plugin.settings.hiddenCommands.includes(cmd.id))
					.setDisabled(disabledHelp !== null)
					.onChange(async (value) => {
						tab.plugin.settings.hiddenCommands = toggleList(tab.plugin.settings.hiddenCommands, cmd.id, value);
						await tab.plugin.saveSettings();
					});
			});
			s.addToggle(toggle => {
				toggle
					.setTooltip(disabledHelp ?? 'Show in Chain Search')
					.setValue(!tab.plugin.settings.hiddenFromChainSearch.includes(cmd.id))
					.setDisabled(disabledHelp !== null)
					.onChange(async (value) => {
						tab.plugin.settings.hiddenFromChainSearch = toggleList(tab.plugin.settings.hiddenFromChainSearch, cmd.id, value);
						await tab.plugin.saveSettings();
					});
			});

			renderHotkey(tab, s.controlEl, cmd.id);
		});
	};

	// Chain Search toggle only — for chain-only internal commands (never in the palette)
	const renderChainOnlyGroup = (title: string, commands: { id: string, name: string }[]) => {
		if (commands.length === 0) return;

		new Setting(containerEl).setName(title).setHeading();
		const group = containerEl.createDiv({ cls: 'crucible-settings-group' });

		const header = new Setting(group).setName('').setDesc('');
		header.controlEl.createSpan({ text: 'Chains', cls: 'crucible-toggle-header' });

		commands.sort((a, b) => a.name.localeCompare(b.name));

		commands.forEach((cmd, index) => {
			if (index > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(group)
				.setName(cmd.name)
				.addToggle(toggle => toggle
					.setTooltip('Show in Chain Search')
					.setValue(!tab.plugin.settings.hiddenFromChainSearch.includes(cmd.id))
					.onChange(async (value) => {
						tab.plugin.settings.hiddenFromChainSearch = toggleList(tab.plugin.settings.hiddenFromChainSearch, cmd.id, value);
						await tab.plugin.saveSettings();
					}));
		});
	};

	const GROUP_ORDER: CrucibleCommandGroup[] = [
		'Appearance',
		'Materialize',
		'Lint',
		'Captures',
		'Shortcuts',
		'Chains',
		'Agents',
		'Files',
		'Orchestrations',
		'Ingestion',
		'Search',
		'Other',
	];

	for (const group of GROUP_ORDER) {
		const commands = tab.plugin.commandRegistry
			.filter(c => c.group === group)
			.map(c => ({ id: c.id, name: c.name, availabilityHelp: c.availabilityHelp }));
		renderGroup(group, commands);
	}
	renderChainOnlyGroup('Chain Commands', getChainOnlyCommandList());

	renderCrucibleCommandPaletteSettings(tab, containerEl);
	renderCrucibleFileOpenPaletteSettings(tab, containerEl);
}

function renderCrucibleFileOpenPaletteSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	new Setting(containerEl).setName('File-open palette').setHeading();
	containerEl.createEl('p', { text: 'A replacement file switcher with full-path fuzzy matching and Crucible excluded-folder handling.' });

	const group = containerEl.createDiv({ cls: 'crucible-settings-group' });

	bindToggle(group, {
		name: 'Enable Crucible file-open palette',
		desc: 'Registers the "Open Crucible file-open palette" command. Bind a hotkey in Obsidian\'s Hotkeys settings to invoke it.',
		get: () => s.crucibleFileOpenPaletteEnabled,
		set: (v) => { s.crucibleFileOpenPaletteEnabled = v; },
		after: () => tab.refreshDisplay(),
	}, save);

	if (!s.crucibleFileOpenPaletteEnabled) return;

	group.createEl('hr', { cls: 'crucible-row-divider' });

	bindDropdown(group, {
		name: 'Excluded search folders',
		desc: 'How files in folders marked "Search" under Lint > Excluded folders appear.',
		options: {
			derank: 'Derank',
			hide: 'Hide',
			include: 'Include',
		},
		get: () => s.crucibleFileOpenPaletteIgnoredFolderMode,
		set: (v) => { s.crucibleFileOpenPaletteIgnoredFolderMode = v as CrucibleFileOpenIgnoredFolderMode; },
	}, save);

	group.createEl('hr', { cls: 'crucible-row-divider' });

	bindToggle(group, {
		name: 'Create missing Markdown notes',
		desc: 'When the typed path does not already exist, show a row that creates a new Markdown note.',
		get: () => s.crucibleFileOpenPaletteCreateMissing,
		set: (v) => { s.crucibleFileOpenPaletteCreateMissing = v; },
	}, save);

	group.createEl('hr', { cls: 'crucible-row-divider' });

	renderExtensionCheckboxGroups(tab, group, {
		groups: deriveFileTypeGroups(tab.app),
		heading: 'Openable file extensions',
		description: 'Every category checked (or every box cleared) means every vault file is openable. Uncheck a category or individual extension to exclude it.',
		get: () => s.crucibleFileOpenPaletteExtensions,
		set: (extensions) => { s.crucibleFileOpenPaletteExtensions = extensions; },
		emptyMeansAll: true,
	}, save);
}

export interface ExtensionCheckboxGroupsSpec {
	groups: FileTypeGroup[];
	heading: string;
	description: string;
	get: () => string[];
	set: (extensions: string[]) => void;
	/**
	 * When true (the file-open palette's Set A semantics), an empty stored array renders
	 * every box checked, and checking every box collapses the stored value back to `[]`
	 * so future extensions stay included automatically. When false (the search
	 * indexer's Set B semantics — see settings/sections/orchestration.ts), empty means
	 * "nothing selected" and there is no collapse-to-empty shortcut.
	 */
	emptyMeansAll: boolean;
	warning?: string;
}

/**
 * Shared renderer for a grouped file-extension checkbox grid: one row per category with
 * a "select all in category" toggle, followed by a row holding the extension
 * checkboxes (reusing the existing `.crucible-checkbox-grid` / `.crucible-checkbox-grid-item`
 * classes already used by src/settings/sections/localize.ts and triggers.ts).
 *
 * Exported so settings/sections/orchestration.ts's Set B (search-indexable types) reuses
 * the same rendering logic over a different, independent settings key and category
 * subset — the two extension sets share this presentation helper but never share state.
 */
export function renderExtensionCheckboxGroups(
	tab: CrucibleSettingTab,
	containerEl: HTMLElement,
	spec: ExtensionCheckboxGroupsSpec,
	save: Save,
): void {
	const allExtensions = spec.groups.flatMap(g => g.extensions);

	const currentSelection = (): Set<string> => resolveSelectedExtensions(spec.get(), allExtensions, spec.emptyMeansAll);

	const commit = (selected: Set<string>): void => {
		spec.set(commitSelectedExtensions(selected, allExtensions, spec.emptyMeansAll));
	};

	new Setting(containerEl).setName(spec.heading).setDesc(spec.description);
	if (spec.warning) {
		containerEl.createEl('p', { text: spec.warning, cls: 'crucible-setting-warning' });
	}

	spec.groups.forEach((group) => {
		containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		const selected = currentSelection();
		const allChecked = group.extensions.length > 0 && group.extensions.every(ext => selected.has(ext));

		const categoryHeading = new Setting(containerEl)
			.setName(group.category)
			.setDesc(`${group.extensions.length} extension${group.extensions.length === 1 ? '' : 's'}`);
		categoryHeading.addToggle(toggle => {
			toggle
				.setTooltip(allChecked ? `Uncheck all ${group.category}` : `Check all ${group.category}`)
				.setValue(allChecked)
				.onChange(async (checked) => {
					const next = currentSelection();
					for (const ext of group.extensions) {
						if (checked) next.add(ext); else next.delete(ext);
					}
					commit(next);
					await save();
					tab.refreshDisplay();
				});
		});

		const gridRow = new Setting(containerEl).setName('').setDesc('');
		const grid = gridRow.controlEl.createDiv({ cls: 'crucible-checkbox-grid' });
		for (const ext of group.extensions) {
			const itemLabel = grid.createEl('label', { cls: 'crucible-checkbox-grid-item' });
			const cb = itemLabel.createEl('input', { type: 'checkbox' });
			cb.checked = selected.has(ext);
			itemLabel.createSpan({ text: ext });
			cb.addEventListener('change', () => {
				void (async () => {
					const next = currentSelection();
					if (cb.checked) next.add(ext); else next.delete(ext);
					commit(next);
					await save();
					tab.refreshDisplay();
				})();
			});
		}
	});
}

function renderCrucibleCommandPaletteSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	new Setting(containerEl).setName('Command palette').setHeading();
	containerEl.createEl('p', { text: 'A replacement command palette with pinned commands and whitelist/blacklist filtering of non-Crucible commands. Crucible commands always honor the visibility toggles above.' });

	const group = containerEl.createDiv({ cls: 'crucible-settings-group' });

	bindToggle(group, {
		name: 'Enable Crucible command palette',
		desc: 'Registers the "Open Crucible command palette" command. Bind a hotkey in Obsidian\'s Hotkeys settings to invoke it.',
		get: () => s.crucibleCommandPaletteEnabled,
		set: (v) => { s.crucibleCommandPaletteEnabled = v; },
		after: () => tab.refreshDisplay(),
	}, save);

	if (!s.crucibleCommandPaletteEnabled) return;

	group.createEl('hr', { cls: 'crucible-row-divider' });

	bindToggle(group, {
		name: 'Show configured hotkeys',
		desc: 'Display each command\'s bound hotkey as a pill in the palette.',
		get: () => s.crucibleCommandPaletteShowHotkeys,
		set: (v) => { s.crucibleCommandPaletteShowHotkeys = v; },
	}, save);

	bindToggle(group, {
		name: 'Show shortest unique fuzzy string',
		desc: 'Display the shortest text you could type to surface each command on its own, as a pill.',
		get: () => s.crucibleCommandPaletteShowUniqueString,
		set: (v) => { s.crucibleCommandPaletteShowUniqueString = v; },
		after: () => tab.refreshDisplay(),
	}, save);

	if (s.crucibleCommandPaletteShowUniqueString) renderHintTuningSettings(tab, group);

	group.createEl('hr', { cls: 'crucible-row-divider' });
	renderPinnedCommandList(tab, group);

	group.createEl('hr', { cls: 'crucible-row-divider' });
	renderPaletteFilterSection(tab, group);
}

function renderHintTuningSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	const parseNum = (raw: string, fallback: number, min: number): number => {
		const n = Number(raw);
		return Number.isFinite(n) && n >= min ? n : fallback;
	};

	bindDropdown(containerEl, {
		name: 'Hint character set',
		desc: 'Which characters a hint may use. "Alphanumeric plus whitelist" avoids spaces and odd punctuation.',
		options: { 'alphanumeric-whitelist': 'Alphanumeric plus whitelist', 'all-ascii': 'All ASCII' },
		get: () => s.crucibleCommandPaletteHintCharsetMode,
		set: (v) => { s.crucibleCommandPaletteHintCharsetMode = v as CrucibleCommandPaletteHintCharsetMode; },
		after: () => tab.refreshDisplay(),
	}, save);

	if (s.crucibleCommandPaletteHintCharsetMode === 'alphanumeric-whitelist') {
		bindText(containerEl, {
			name: 'Whitelisted extra characters',
			desc: 'Non-alphanumeric characters allowed in hints, in addition to a-z and 0-9.',
			placeholder: '.',
			get: () => s.crucibleCommandPaletteHintWhitelist,
			set: (v) => { s.crucibleCommandPaletteHintWhitelist = v; },
		}, save);
	}

	bindToggle(containerEl, {
		name: 'Fall back to shortest top match',
		desc: 'When no unique string exists within the length cap, show the shortest string that ranks this command first. These hints appear in a distinct color.',
		get: () => s.crucibleCommandPaletteHintFallbackTopMatch,
		set: (v) => { s.crucibleCommandPaletteHintFallbackTopMatch = v; },
	}, save);

	bindNumber(containerEl, {
		name: 'Maximum hint length',
		desc: 'Longest hint to search for, in characters.',
		min: 1,
		get: () => String(s.crucibleCommandPaletteHintMaxLen),
		set: (raw) => { s.crucibleCommandPaletteHintMaxLen = parseNum(raw, 6, 1); },
	}, save);

	bindNumber(containerEl, {
		name: 'Prefix penalty',
		desc: 'Tie weight per character drawn from a prefix segment ("Crucible:", "Chain:"). Higher favors the leaf of the command name.',
		min: 0,
		step: 0.1,
		get: () => String(s.crucibleCommandPaletteHintPrefixPenalty),
		set: (raw) => { s.crucibleCommandPaletteHintPrefixPenalty = parseNum(raw, 1, 0); },
	}, save);

	bindNumber(containerEl, {
		name: 'Position bias',
		desc: 'Tie weight per character, scaled by its offset from the start of its word. Higher favors letters at word starts.',
		min: 0,
		step: 0.1,
		get: () => String(s.crucibleCommandPaletteHintPositionBias),
		set: (raw) => { s.crucibleCommandPaletteHintPositionBias = parseNum(raw, 0, 0); },
	}, save);
}

function renderPinnedCommandList(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const pinned = tab.plugin.settings.crucibleCommandPalettePinned;

	new Setting(containerEl)
		.setName('Pinned commands')
		.setDesc('Pinned commands appear at the top of the palette in this order.')
		.addSearch(cb => {
			cb.setPlaceholder('Search for a command to pin...');
			const el = (cb as unknown as SearchWithContainer).containerEl;
			if (el) el.addClass('crucible-search-container', 'pi-width-normal');
			new CommandSuggest(tab.app, cb.inputEl, [], (command) => {
				if (pinned.includes(command.id)) return;
				pinned.push(command.id);
				cb.setValue('');
				void tab.plugin.saveSettings();
				tab.refreshDisplay();
			}, pinned);
		});

	if (pinned.length === 0) {
		containerEl.createDiv({ text: 'No pinned commands.', cls: 'crucible-empty-state' });
		return;
	}

	const list = containerEl.createDiv({ cls: 'crucible-settings-group' });
	pinned.forEach((id, index) => {
		if (index > 0) list.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(list)
			.setName(getCommandSuggestDisplayName(tab.app, id))
			.setDesc(id)
			.addExtraButton(cb => cb
				.setIcon('arrow-up')
				.setTooltip('Move up')
				.setDisabled(index === 0)
				.onClick(async () => {
					if (index === 0) return;
					const tmp = pinned[index - 1]!;
					pinned[index - 1] = pinned[index]!;
					pinned[index] = tmp;
					await tab.plugin.saveSettings();
					tab.refreshDisplay();
				}))
			.addExtraButton(cb => cb
				.setIcon('arrow-down')
				.setTooltip('Move down')
				.setDisabled(index === pinned.length - 1)
				.onClick(async () => {
					if (index === pinned.length - 1) return;
					const tmp = pinned[index + 1]!;
					pinned[index + 1] = pinned[index]!;
					pinned[index] = tmp;
					await tab.plugin.saveSettings();
					tab.refreshDisplay();
				}))
			.addExtraButton(cb => cb
				.setIcon('trash')
				.setTooltip('Remove from pinned')
				.onClick(async () => {
					pinned.splice(index, 1);
					await tab.plugin.saveSettings();
					tab.refreshDisplay();
				}));
	});
}

function renderPaletteFilterSection(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const settings = tab.plugin.settings;

	new Setting(containerEl)
		.setName('Filter non-Crucible commands')
		.setDesc('Whitelist: only the listed non-Crucible commands appear. Blacklist: all non-Crucible commands appear except the listed ones.')
		.addDropdown(d => d
			.addOption('blacklist', 'Blacklist')
			.addOption('whitelist', 'Whitelist')
			.setValue(settings.crucibleCommandPaletteFilterMode)
			.onChange(async (v) => {
				settings.crucibleCommandPaletteFilterMode = v as CrucibleCommandPaletteFilterMode;
				await tab.plugin.saveSettings();
				tab.refreshDisplay();
			}));

	const mode = settings.crucibleCommandPaletteFilterMode;
	const list = mode === 'whitelist' ? settings.crucibleCommandPaletteWhitelist : settings.crucibleCommandPaletteBlacklist;
	const label = mode === 'whitelist' ? 'Whitelisted commands' : 'Blacklisted commands';
	const placeholder = mode === 'whitelist' ? 'Search for a command to whitelist...' : 'Search for a command to blacklist...';

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	new Setting(containerEl)
		.setName(label)
		.addSearch(cb => {
			cb.setPlaceholder(placeholder);
			const el = (cb as unknown as SearchWithContainer).containerEl;
			if (el) el.addClass('crucible-search-container', 'pi-width-normal');
			new CommandSuggest(tab.app, cb.inputEl, [], (command) => {
				if (list.includes(command.id)) return;
				list.push(command.id);
				cb.setValue('');
				void tab.plugin.saveSettings();
				tab.refreshDisplay();
			}, list);
		});

	if (list.length === 0) {
		containerEl.createDiv({ text: mode === 'whitelist' ? 'No commands whitelisted.' : 'No commands blacklisted.', cls: 'crucible-empty-state' });
		return;
	}

	const entries = containerEl.createDiv({ cls: 'crucible-settings-group' });
	list.slice().sort((a, b) => getCommandSuggestDisplayName(tab.app, a).localeCompare(getCommandSuggestDisplayName(tab.app, b))).forEach((id, displayIdx) => {
		if (displayIdx > 0) entries.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(entries)
			.setName(getCommandSuggestDisplayName(tab.app, id))
			.setDesc(id)
			.addExtraButton(cb => cb
				.setIcon('trash')
				.setTooltip('Remove')
				.onClick(async () => {
					const idx = list.indexOf(id);
					if (idx !== -1) list.splice(idx, 1);
					await tab.plugin.saveSettings();
					tab.refreshDisplay();
				}));
	});
}
