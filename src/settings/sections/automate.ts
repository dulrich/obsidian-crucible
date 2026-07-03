/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting, Command } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { Capture, CaptureTarget, CaptureSource, CaptureTargetSectionMode, CaptureWriteMode, Chain, CommandArgSchema, GuardCondition, GuardConditionType, GuardConditionValueKind, SYNC_GUARD_CONDITION_TYPES, TriggerAction, TriggerDef, TriggerEvent } from "../../types";
import type { JobType } from "../../orchestration/types";
import { agentCommandId } from "../../agents";
import { getPeriodConfigByTarget } from "../../periods";
import { FileSuggest, FolderSuggest, CommandSuggest, TagSuggest, YoutubeChannelSuggest, findCommandSuggestItem, getCommandSuggestDisplayName } from "../../suggesters";
import { SearchWithContainer, sortByNameWithEmptyLast, addWarningIcon } from "../shared";
import { bindText, bindToggle, bindDropdown, bindSearch, bindTextArea, bindNumber } from "../bind";

function getChainCommandExtras(tab: CrucibleSettingTab): Command[] {
	const chainOnlyCommands: Command[] = [
		{ id: 'crucible:source:active-file', name: 'Crucible Source: Active file contents' },
		{ id: 'crucible:source:selection', name: 'Crucible Source: Editor selection' },
		{ id: 'crucible:source:input', name: 'Crucible Source: User input' },
		{ id: 'crucible:copy-active-file', name: 'Crucible: Copy note to clipboard' },
		{ id: 'crucible:copy-note-to-folder', name: 'Crucible: Copy note to folder' },
		{ id: 'crucible:replace-note-body', name: 'Crucible: Replace note body' },
		{ id: 'crucible:capture', name: 'Crucible: Quick Capture' },
		{ id: 'crucible:upsert-property', name: 'Crucible: Add/update property' },
		{ id: 'crucible:upsert-tags', name: 'Crucible: Upsert tags' },
	];
	const agentExtras: Command[] = tab.plugin.settings.agents.map(a => ({
		id: agentCommandId(a.id),
		name: `Crucible Agent: ${a.name || '(unnamed)'}`
	}));

	return [...chainOnlyCommands, ...agentExtras];
}

export function renderAutomateSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	if (tab.editingCaptureIndex !== -1) {
		renderEditCapture(tab, containerEl);
		return;
	}
	if (tab.editingChainIndex !== -1) {
		renderEditChain(tab, containerEl);
		return;
	}
	if (tab.editingTriggerIndex !== -1) {
		renderEditTrigger(tab, containerEl);
		return;
	}

	renderCaptureListSection(tab, containerEl);
	renderChainListSection(tab, containerEl);
	renderTriggerListSection(tab, containerEl);
	renderShortcutSettings(tab, containerEl);
}

function renderCaptureListSection(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	new Setting(containerEl).setName('Captures').setHeading();
	containerEl.createEl('p', { text: 'Define workflows to quickly append, prepend, or replace text in notes.' });

	const group = containerEl.createDiv({ cls: 'crucible-settings-group' });

	if (tab.plugin.settings.captures.length === 0) {
		group.createDiv({ text: 'No captures configured.', cls: 'crucible-empty-state' });
	} else {
		sortByNameWithEmptyLast(tab.plugin.settings.captures, c => c.name).forEach(({ item: capture, index }, displayIdx) => {
			if (displayIdx > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
			const setting = new Setting(group)
				.setName(capture.name || '(unnamed)')
				.setDesc(describeCapture(capture))
				.addExtraButton(cb => cb.setIcon('copy').setTooltip('Duplicate capture').onClick(async () => {
					const copy = JSON.parse(JSON.stringify(capture)) as Capture;
					copy.name = copy.name ? `${copy.name} (copy)` : '(copy)';
					tab.plugin.settings.captures.push(copy);
					await tab.plugin.saveSettings();
					tab.plugin.registerCaptures();
					tab.display();
				}))
				.addExtraButton(cb => cb.setIcon('pencil').setTooltip('Edit capture').onClick(() => {
					tab.editingCaptureIndex = index;
					tab.display();
				}))
				.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete capture').onClick(async () => {
					tab.plugin.settings.captures.splice(index, 1);
					await tab.plugin.saveSettings();
					tab.plugin.registerCaptures();
					tab.display();
				}));
			const warning = getCaptureWarning(tab, capture);
			if (warning) addWarningIcon(setting.nameEl, warning);
		});
	}

	new Setting(containerEl).addButton(bt => bt.setButtonText('Add capture').setCta().onClick(async () => {
		tab.plugin.settings.captures.push({ name: '', targetType: 'daily', source: 'dialog', file: '', targetSectionMode: 'fixed', targetSection: '', content: '', writeMode: 'append' });
		await tab.plugin.saveSettings();
		tab.plugin.registerCaptures();
		tab.editingCaptureIndex = tab.plugin.settings.captures.length - 1;
		tab.display();
	}));
}

function describeCapture(capture: Capture): string {
	const target = captureTargetLabel(capture);
	const source = captureSourceLabel(capture.source || 'dialog');
	const writeMode = captureWriteModeLabel(capture.writeMode || 'append');
	const sectionMode = (capture.targetSectionMode || 'fixed') === 'source' ? 'same section' : 'fixed section';
	return `${target} - ${source} - ${sectionMode} - ${writeMode}`;
}

function getCaptureWarning(tab: CrucibleSettingTab, capture: Capture): string | null {
	const config = getPeriodConfigByTarget(capture.targetType, tab.plugin.settings);
	if (!config || config.enabled) return null;
	return `${config.label} is disabled; this capture will show a warning and not run.`;
}

function captureTargetLabel(capture: Capture): string {
	if (capture.targetType === 'daily') return 'Daily note';
	if (capture.targetType === 'weekly') return 'Weekly note';
	if (capture.targetType === 'monthly') return 'Monthly note';
	if (capture.targetType === 'active') return 'Active note';
	return capture.file || 'Specified note';
}

function captureSourceLabel(source: CaptureSource): string {
	if (source === 'line') return 'Current line';
	if (source === 'line-fallback') return 'Current line or dialog';
	if (source === 'selection') return 'Selection';
	if (source === 'selection-fallback') return 'Selection or dialog';
	return 'Dialog';
}

function captureWriteModeLabel(writeMode: CaptureWriteMode): string {
	if (writeMode === 'prepend') return 'Prepend';
	if (writeMode === 'replace') return 'Replace';
	return 'Append';
}

function renderChainListSection(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	new Setting(containerEl).setName('Chains').setHeading();
	containerEl.createEl('p', { text: 'Define a sequence of commands to run in order. Chains can pass arguments and responses between steps.' });

	const group = containerEl.createDiv({ cls: 'crucible-settings-group crucible-chain-list' });

	if (tab.plugin.settings.chains.length === 0) {
		group.createDiv({ text: 'No chains defined.', cls: 'crucible-empty-state' });
	} else {
		const header = group.createDiv({ cls: 'crucible-chain-flags-header' });
		header.createSpan({ text: 'Mutates?' });
		header.createSpan({ text: 'Debug?' });
		sortByNameWithEmptyLast(tab.plugin.settings.chains, c => c.name).forEach(({ item: chain, index }, displayIdx) => {
			if (displayIdx > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
			const setting = new Setting(group)
				.setName(chain.name || '(unnamed)')
				.setDesc(`${chain.steps.length} steps`);
			const mutates = setting.controlEl.createSpan({ cls: 'crucible-chain-flag', text: chain.mutating !== false ? '✓' : '' });
			mutates.setAttr('aria-label', 'Mutates the note');
			mutates.setAttr('title', 'Mutates the note');
			const debug = setting.controlEl.createSpan({ cls: 'crucible-chain-flag', text: chain.debugMode === true ? '✓' : '' });
			debug.setAttr('aria-label', 'Debug mode');
			debug.setAttr('title', 'Debug mode');
			setting
				.addExtraButton(cb => cb.setIcon('copy').setTooltip('Duplicate chain').onClick(async () => {
					const copy = JSON.parse(JSON.stringify(chain)) as Chain;
					copy.name = copy.name ? `${copy.name} (copy)` : '(copy)';
					tab.plugin.settings.chains.push(copy);
					await tab.plugin.saveSettings();
					tab.plugin.registerChains();
					tab.display();
				}))
				.addExtraButton(cb => cb.setIcon('pencil').setTooltip('Edit chain').onClick(() => {
					tab.editingChainIndex = index;
					tab.display();
				}))
				.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete chain').onClick(async () => {
					tab.plugin.settings.chains.splice(index, 1);
					await tab.plugin.saveSettings();
					tab.plugin.registerChains();
					tab.display();
				}));
		});
	}

	new Setting(containerEl).addButton(bt => bt.setButtonText('Add chain').setCta().onClick(async () => {
		tab.plugin.settings.chains.push({ name: '', steps: [] });
		await tab.plugin.saveSettings();
		tab.editingChainIndex = tab.plugin.settings.chains.length - 1;
		tab.display();
	}));
}

function renderEditChain(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const save = () => tab.plugin.saveSettings();
	const chain = tab.plugin.settings.chains[tab.editingChainIndex];
	if (!chain) return;

	new Setting(containerEl).setName('Edit Chain').setHeading();

	const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
	bindText(group, {
		name: 'Chain name',
		placeholder: 'e.g. Refine Transcript',
		get: () => chain.name,
		set: (v) => { chain.name = v; },
		after: () => tab.plugin.registerChains(),
	}, save);

	group.createEl('hr', { cls: 'crucible-row-divider' });
	bindToggle(group, {
		name: 'Mutates the note',
		desc: 'When off, the chain runs read-only and does not lock its target note. Turn off for chains that only open views/dashboards or otherwise never write the note.',
		get: () => chain.mutating !== false,
		set: (v) => { chain.mutating = v; },
		after: () => tab.plugin.registerChains(),
	}, save);

	bindToggle(group, {
		name: 'Debug mode',
		desc: 'Log each step\'s input and output to a debug note in _crucible/debug.md.',
		get: () => chain.debugMode ?? false,
		set: (v) => { chain.debugMode = v; },
	}, save);

	new Setting(containerEl).setName('Variables').setHeading();
	containerEl.createEl('p', { text: 'Define values accessible as {{varName}} in step arguments. The variable {{agent_model}} is set automatically after an agent step.' });

	const varGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	const variables = chain.variables ?? {};

	Object.entries(variables).forEach(([key, val], index) => {
		if (index > 0) varGroup.createEl('hr', { cls: 'crucible-row-divider' });
		const row = new Setting(varGroup);
		row.addText(t => t
			.setPlaceholder('name')
			.setValue(key)
			.onChange(async (newKey) => {
				delete variables[key];
				variables[newKey] = val;
				chain.variables = variables;
				await save();
			}).inputEl.addClass('pi-width-small'));
		row.addText(t => t
			.setPlaceholder('value')
			.setValue(val)
			.onChange(async (newVal) => {
				variables[key] = newVal;
				chain.variables = variables;
				await save();
			}).inputEl.addClass('pi-width-normal'));
		row.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove variable').onClick(async () => {
			delete variables[key];
			chain.variables = variables;
			await save();
			tab.display();
		}));
	});

	new Setting(containerEl).addButton(bt => bt.setButtonText('Add variable').onClick(async () => {
		chain.variables = { ...variables, '': '' };
		await save();
		tab.display();
	}));

	new Setting(containerEl).setName('Steps').setHeading();

	chain.steps.forEach((step, index) => {
		const stepGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
		stepGroup.dataset.stepIndex = String(index);

		new Setting(stepGroup)
			.setName(`Step ${index + 1}`)
			.addExtraButton(cb => cb
				.setIcon('arrow-up')
				.setTooltip('Move step up')
				.setDisabled(index === 0)
				.onClick(async () => {
					if (index === 0) return;
					const [moved] = chain.steps.splice(index, 1);
					if (moved) chain.steps.splice(index - 1, 0, moved);
					await save();
					tab.refreshDisplay();
				}))
			.addExtraButton(cb => cb
				.setIcon('arrow-down')
				.setTooltip('Move step down')
				.setDisabled(index === chain.steps.length - 1)
				.onClick(async () => {
					if (index === chain.steps.length - 1) return;
					const [moved] = chain.steps.splice(index, 1);
					if (moved) chain.steps.splice(index + 1, 0, moved);
					await save();
					tab.refreshDisplay();
				}))
			.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove step').onClick(async () => {
				chain.steps.splice(index, 1);
				await save();
				tab.refreshDisplay();
			}));

		stepGroup.createEl('hr', { cls: 'crucible-row-divider' });

		new Setting(stepGroup)
			.setName('Step type')
			.addDropdown(d => d
				.addOption('command', 'Command')
				.addOption('guard', 'Guard')
				.setValue(step.stepType ?? 'command')
				.onChange(async (v) => {
					step.stepType = v as 'command' | 'guard';
					await save();
					tab.refreshDisplay();
				}));

		stepGroup.createEl('hr', { cls: 'crucible-row-divider' });

		if ((step.stepType ?? 'command') === 'guard') {
			const gc = step.guardCondition ?? { type: 'has-tag' as const };
			if (!step.guardCondition) { step.guardCondition = gc; }

			new Setting(stepGroup)
				.setName('Condition type')
				.addDropdown(d => d
					.addOption('has-tag', 'Note has tag')
					.addOption('not-has-tag', 'Note does not have tag')
					.addOption('has-property', 'Note has property')
					.addOption('not-has-property', 'Note does not have property')
					.addOption('property-equals', 'Property equals value')
					.addOption('property-in-set', 'Property value in set')
					.addOption('property-lt', 'Property < number')
					.addOption('property-gt', 'Property > number')
					.addOption('word-count-lt', 'Word count < number')
					.addOption('word-count-gt', 'Word count > number')
					.setValue(gc.type)
					.onChange(async (v) => {
						gc.type = v as typeof gc.type;
						normalizeGuardConditionForType(gc);
						step.guardCondition = gc;
						await save();
						tab.refreshDisplay();
					}));

			stepGroup.createEl('hr', { cls: 'crucible-row-divider' });

			renderGuardConditionFields(tab, stepGroup, gc, async () => {
				step.guardCondition = gc;
				await save();
			}, { refresh: () => tab.refreshDisplay(), targetLabel: 'active note' });
		} else {
			new Setting(stepGroup)
				.setName('Command')
				.addSearch(cb => {
					const commandExtras = getChainCommandExtras(tab);
					let prevSchema = tab.plugin.chainManager.getCommandSchema(step.commandId);
					const updateCommandId = async (commandId: string) => {
						step.commandId = commandId;
						const newSchema = tab.plugin.chainManager.getCommandSchema(commandId);
						if (newSchema !== prevSchema) {
							// Schema changed - clear args and rebuild to show new schema inputs
							step.args = {};
							prevSchema = newSchema;
							await save();
							tab.refreshDisplay();
						} else {
							await save();
						}
					};
					cb.setPlaceholder('Search for a command...')
						.setValue(getCommandSuggestDisplayName(tab.app, step.commandId, commandExtras))
						.onChange(async (v) => {
							const selectedCommand = findCommandSuggestItem(tab.app, v, commandExtras);
							await updateCommandId(selectedCommand?.id || v);
						});
					const el = (cb as unknown as SearchWithContainer).containerEl;
					if (el) el.addClass('crucible-search-container', 'pi-width-normal');
					new CommandSuggest(tab.app, cb.inputEl, commandExtras, command => {
						void updateCommandId(command.id);
					}, tab.plugin.settings.hiddenFromChainSearch);
				});

			const schema = tab.plugin.chainManager.getCommandSchema(step.commandId);

			if (schema) {
				schema.forEach(arg => {
					stepGroup.createEl('hr', { cls: 'crucible-row-divider' });
					const s = new Setting(stepGroup)
						.setName(arg.name)
						.setDesc(arg.description || '');
					const supportsTemplateVariables = arg.type === 'text' ||
						arg.type === 'textarea' ||
						arg.type === 'file' ||
						arg.type === 'folder';
					const panelKey = `chain-${tab.editingChainIndex}-step-${index}-arg-${arg.id}`;
					const argVariables = tab.chainArgumentVariables(chain);
					if (supportsTemplateVariables) {
						tab.addTemplateVariablesToggle(s, panelKey, argVariables);
					}

					switch (arg.type) {
						case 'text':
							s.addText(t => t
								.setValue(step.args[arg.id] || '')
								.onChange(async (v) => { step.args[arg.id] = v; await save(); })
								.inputEl.addClass('pi-width-normal'));
							break;
						case 'textarea':
							s.addTextArea(t => t
								.setValue(step.args[arg.id] || '')
								.onChange(async (v) => { step.args[arg.id] = v; await save(); })
								.inputEl.addClass('crucible-setting-textarea', 'pi-width-normal'));
							break;
						case 'dropdown':
							s.addDropdown(d => {
								if (arg.options) d.addOptions(arg.options);
								d.setValue(step.args[arg.id] || '')
								 .onChange(async (v) => { step.args[arg.id] = v; await save(); });
								d.selectEl.addClass('pi-width-normal');
							});
							break;
						case 'file':
							s.addSearch(cb => {
								cb.setPlaceholder('Select file...')
									.setValue(step.args[arg.id] || '')
									.onChange(async (v) => { step.args[arg.id] = v; await save(); });
								const el = (cb as unknown as SearchWithContainer).containerEl;
								if (el) el.addClass('crucible-search-container', 'pi-width-normal');
								new FileSuggest(tab.app, cb.inputEl);
							});
							break;
						case 'folder':
							s.addSearch(cb => {
								cb.setPlaceholder('Select folder...')
									.setValue(step.args[arg.id] || '')
									.onChange(async (v) => { step.args[arg.id] = v; await save(); });
								const el = (cb as unknown as SearchWithContainer).containerEl;
								if (el) el.addClass('crucible-search-container', 'pi-width-normal');
								new FolderSuggest(tab.app, cb.inputEl);
							});
							break;
					}
					if (supportsTemplateVariables) {
						tab.renderTemplateVariablesPanel(stepGroup, panelKey, argVariables);
					}
				});
			} else {
				// Fallback for commands without schema (standard Obsidian commands)
				stepGroup.createEl('hr', { cls: 'crucible-row-divider' });
				const argsSetting = new Setting(stepGroup)
					.setName('Arguments')
					.setDesc('Support variables like {{response}} from the previous step.')
					.addText(t => t
						.setPlaceholder('Args...')
						.setValue(step.args._default || '')
						.onChange(async (v) => {
							step.args._default = v;
							await save();
						}).inputEl.addClass('pi-width-normal'));
				const panelKey = `chain-${tab.editingChainIndex}-step-${index}-args`;
				const argVariables = tab.chainArgumentVariables(chain);
				tab.addTemplateVariablesToggle(argsSetting, panelKey, argVariables);
				tab.renderTemplateVariablesPanel(stepGroup, panelKey, argVariables);
			}
		}

		stepGroup.createEl('hr', { cls: 'crucible-row-divider' });

		new Setting(stepGroup)
			.setName('Keep going on failure')
			.addToggle(t => t
				.setValue(step.keepGoing)
				.onChange(async (v) => {
					step.keepGoing = v;
					await save();
				}));

		stepGroup.createEl('hr', { cls: 'crucible-row-divider' });

		new Setting(stepGroup)
			.setName('Capture intermediate output')
			.setDesc('Write this step\'s output to _crucible/step-<name>-output.md for debugging.')
			.addToggle(t => t
				.setValue(step.captureIntermediate ?? false)
				.onChange(async (v) => {
					step.captureIntermediate = v;
					await save();
				}));
	});

	let insertAt = chain.steps.length; // default: end of chain

	const actionRow = new Setting(containerEl);
	actionRow.addDropdown(d => {
		d.addOption(String(chain.steps.length), 'At end');
		chain.steps.forEach((_, i) => { d.addOption(String(i), `Before step ${i + 1}`); });
		d.setValue(String(insertAt));
		d.onChange(v => { insertAt = Number(v); });
		d.selectEl.addClass('pi-width-small');
	});
	actionRow.addButton(bt => bt.setButtonText('Add step').setCta().onClick(() => {
		void (async () => {
			chain.steps.splice(insertAt, 0, { commandId: '', keepGoing: false, args: {} });
			await save();
			const targetIndex = insertAt;
			tab.display();
			requestAnimationFrame(() => {
				const scrollEl = tab.getScrollContainer();
				const newStep = tab.containerEl.querySelector<HTMLElement>(`[data-step-index="${targetIndex}"]`);
				if (newStep && scrollEl) {
					const stepTop = newStep.offsetTop;
					const stepCenter = stepTop + newStep.offsetHeight / 2;
					scrollEl.scrollTop = stepCenter - scrollEl.clientHeight / 2;
				}
			});
		})();
	}));
	actionRow.addButton(bt => bt.setButtonText('Preview chain').onClick(() => {
		tab.plugin.chainManager.previewChain(chain);
	}));
}

// Job types sensible to enqueue directly from a trigger. chain_run/command_run are
// omitted: the "chain" action uses chain_run, and command_run needs a command id.
const TRIGGER_WORKFLOW_LABELS: Partial<Record<JobType, string>> = {
	daily_brief_lite: 'Daily brief (lite)',
	youtube_tracker: 'YouTube tracker',
	blogs_tracker: 'Blogs/RSS tracker',
	link_scan: 'Link scan',
	transcript_refine: 'Refine transcript',
	youtube_metadata_fetch: 'Fetch YouTube metadata',
};

const TRIGGER_EVENT_LABELS: Record<TriggerEvent, string> = {
	create: 'Note created',
	modify: 'Note modified',
	'metadata-changed': 'Frontmatter/metadata changed',
	'youtube-metadata-enriched': 'YouTube metadata enriched',
	rename: 'Note renamed',
};

const TRIGGER_EVENT_ORDER: TriggerEvent[] = [
	'create',
	'modify',
	'metadata-changed',
	'youtube-metadata-enriched',
	'rename',
];

const GUARD_TYPE_LABELS: Record<GuardConditionType, string> = {
	'has-tag': 'Note has tag',
	'not-has-tag': 'Note does not have tag',
	'has-property': 'Note has property',
	'not-has-property': 'Note does not have property',
	'property-equals': 'Property equals value',
	'property-in-set': 'Property value in set',
	'property-lt': 'Property < number',
	'property-gt': 'Property > number',
	'word-count-lt': 'Word count < number',
	'word-count-gt': 'Word count > number',
};

const GUARD_VALUE_KIND_LABELS: Record<GuardConditionValueKind, string> = {
	text: 'Text',
	tag: 'Tag',
	file: 'File',
	folder: 'Folder',
	'youtube-channel': 'YouTube channel',
};

function isPropertyValueCondition(type: GuardConditionType): boolean {
	return type === 'property-equals' || type === 'property-in-set';
}

function guardValueKind(condition: GuardCondition): GuardConditionValueKind {
	return condition.valueKind ?? (condition.property?.trim() === 'channelId' ? 'youtube-channel' : 'text');
}

function defaultGuardValueKind(condition: GuardCondition): void {
	if (!condition.valueKind && condition.property?.trim() === 'channelId') {
		condition.valueKind = 'youtube-channel';
	}
}

function normalizeGuardConditionForType(condition: GuardCondition): void {
	if (isPropertyValueCondition(condition.type)) defaultGuardValueKind(condition);
	if (condition.type === 'property-in-set' && condition.values === undefined) {
		condition.values = condition.value ? [condition.value] : [''];
	}
}

function renderGuardConditionFields(
	tab: CrucibleSettingTab,
	containerEl: HTMLElement,
	condition: GuardCondition,
	save: () => void | Promise<void>,
	opts: { after?: () => void | Promise<void>; refresh?: () => void; targetLabel?: string } = {},
): void {
	const commit = async (refresh = false) => {
		await save();
		if (opts.after) await opts.after();
		if (refresh && opts.refresh) opts.refresh();
	};

	if (condition.type === 'has-tag' || condition.type === 'not-has-tag') {
		const positive = condition.type === 'has-tag';
		renderGuardValueSetting(tab, containerEl, {
			name: 'Tag',
			desc: positive ? `Guard passes if the ${opts.targetLabel ?? 'note'} has this tag.` : `Guard passes if the ${opts.targetLabel ?? 'note'} does not have this tag.`,
			placeholder: '#refined',
			valueKind: 'tag',
			get: () => condition.tag ?? '',
			set: (v) => { condition.tag = v; },
			commit,
		});
		return;
	}

	if (condition.type === 'has-property' || condition.type === 'not-has-property') {
		const positive = condition.type === 'has-property';
		bindText(containerEl, {
			name: 'Property',
			desc: positive ? `Guard passes if the ${opts.targetLabel ?? 'note'} has this frontmatter property.` : `Guard passes if the ${opts.targetLabel ?? 'note'} does not have this frontmatter property.`,
			placeholder: 'model',
			get: () => condition.property ?? '',
			set: (v) => { condition.property = v; },
			after: opts.after,
		}, save);
		return;
	}

	if (condition.type === 'property-equals' || condition.type === 'property-in-set') {
		renderPropertyNameSetting(containerEl, condition, save, opts);
		containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		renderValueKindSetting(containerEl, condition, save, opts);
		containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		if (condition.type === 'property-equals') {
			renderGuardValueSetting(tab, containerEl, {
				name: 'Value',
				desc: 'Guard passes if the property equals this value.',
				placeholder: guardValuePlaceholder(condition),
				valueKind: guardValueKind(condition),
				get: () => condition.value ?? '',
				set: (v) => { condition.value = v; },
				commit,
			});
		} else {
			renderGuardValueSet(tab, containerEl, condition, commit);
		}
		return;
	}

	if (condition.type === 'property-lt' || condition.type === 'property-gt') {
		const op = condition.type === 'property-lt' ? '<' : '>';
		bindText(containerEl, {
			name: 'Property',
			placeholder: 'word-count',
			get: () => condition.property ?? '',
			set: (v) => { condition.property = v; },
			after: opts.after,
		}, save);
		containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		bindNumber(containerEl, {
			name: 'Number',
			desc: `Guard passes if the property value is ${op} this number.`,
			placeholder: '6000',
			get: () => condition.value ?? '',
			set: (v) => { condition.value = v; },
			after: opts.after,
		}, save);
		return;
	}

	if (condition.type === 'word-count-lt' || condition.type === 'word-count-gt') {
		const op = condition.type === 'word-count-lt' ? '<' : '>';
		bindNumber(containerEl, {
			name: 'Word count',
			desc: `Guard passes if the note body word count is ${op} this number.`,
			placeholder: '6000',
			get: () => condition.value ?? '',
			set: (v) => { condition.value = v; },
			after: opts.after,
		}, save);
	}
}

function renderPropertyNameSetting(
	containerEl: HTMLElement,
	condition: GuardCondition,
	save: () => void | Promise<void>,
	opts: { after?: () => void | Promise<void>; refresh?: () => void },
): void {
	new Setting(containerEl)
		.setName('Property')
		.addText(t => t
			.setPlaceholder('channelId')
			.setValue(condition.property ?? '')
			.onChange(async (v) => {
				const hadKind = Boolean(condition.valueKind);
				condition.property = v;
				defaultGuardValueKind(condition);
				await save();
				if (opts.after) await opts.after();
				if (!hadKind && condition.valueKind && opts.refresh) opts.refresh();
			})
			.inputEl.addClass('pi-width-normal'));
}

function renderValueKindSetting(
	containerEl: HTMLElement,
	condition: GuardCondition,
	save: () => void | Promise<void>,
	opts: { after?: () => void | Promise<void>; refresh?: () => void },
): void {
	new Setting(containerEl)
		.setName('Value type')
		.addDropdown(d => {
			for (const [kind, label] of Object.entries(GUARD_VALUE_KIND_LABELS)) d.addOption(kind, label);
			d.setValue(guardValueKind(condition));
			d.onChange(async (v) => {
				condition.valueKind = v as GuardConditionValueKind;
				await save();
				if (opts.after) await opts.after();
				if (opts.refresh) opts.refresh();
			});
			d.selectEl.addClass('pi-width-half');
		});
}

function renderGuardValueSet(
	tab: CrucibleSettingTab,
	containerEl: HTMLElement,
	condition: GuardCondition,
	commit: (refresh?: boolean) => Promise<void>,
): void {
	const values = condition.values ?? (condition.values = []);
	if (values.length === 0) values.push('');
	values.forEach((_value, index) => {
		if (index > 0) containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		renderGuardValueSetting(tab, containerEl, {
			name: `Value ${index + 1}`,
			desc: index === 0 ? 'Guard passes if the property equals any listed value.' : undefined,
			placeholder: guardValuePlaceholder(condition),
			valueKind: guardValueKind(condition),
			get: () => values[index] ?? '',
			set: (v) => { values[index] = v; },
			commit,
			remove: values.length > 1 ? async () => {
				values.splice(index, 1);
				await commit(true);
			} : undefined,
		});
	});
	new Setting(containerEl).addButton(bt => bt.setButtonText('Add value').setCta().onClick(() => {
		void (async () => {
			values.push('');
			await commit(true);
		})();
	}));
}

function guardValuePlaceholder(condition: GuardCondition): string {
	switch (guardValueKind(condition)) {
		case 'tag': return '#refined';
		case 'file': return 'Folder/Note.md';
		case 'folder': return 'Clippings';
		case 'youtube-channel': return 'UC...';
		default: return 'done';
	}
}

function renderGuardValueSetting(
	tab: CrucibleSettingTab,
	containerEl: HTMLElement,
	opts: {
		name: string;
		desc?: string;
		placeholder?: string;
		valueKind: GuardConditionValueKind;
		get: () => string;
		set: (value: string) => void;
		commit: (refresh?: boolean) => Promise<void>;
		remove?: () => Promise<void>;
	},
): void {
	const setting = new Setting(containerEl).setName(opts.name);
	if (opts.desc) setting.setDesc(opts.desc);
	const onValueChange = async (v: string) => {
		opts.set(v);
		await opts.commit();
	};
	if (opts.valueKind === 'text') {
		setting.addText(t => t
			.setPlaceholder(opts.placeholder ?? '')
			.setValue(opts.get())
			.onChange(onValueChange)
			.inputEl.addClass('pi-width-normal'));
	} else {
		setting.addSearch(cb => {
			cb.setPlaceholder(opts.placeholder ?? '')
				.setValue(opts.get())
				.onChange(onValueChange);
			const el = (cb as unknown as SearchWithContainer).containerEl;
			if (el) el.addClass('crucible-search-container', 'pi-width-normal');
			if (opts.valueKind === 'tag') new TagSuggest(tab.app, cb.inputEl);
			else if (opts.valueKind === 'file') new FileSuggest(tab.app, cb.inputEl);
			else if (opts.valueKind === 'folder') new FolderSuggest(tab.app, cb.inputEl);
			else if (opts.valueKind === 'youtube-channel') new YoutubeChannelSuggest(tab.app, cb.inputEl, tab.plugin);
		});
	}
	if (opts.remove) {
		setting.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove value').onClick(() => {
			void opts.remove?.();
		}));
	}
}

function newTriggerId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newTrigger(): TriggerDef {
	return {
		id: newTriggerId(),
		name: '',
		enabled: true,
		on: { events: ['create'] },
		scope: { folder: '', includeSubfolders: true },
		conditions: [],
		conditionMode: 'all',
		action: { kind: 'chain', chainName: '' },
	};
}

function triggerEventList(trigger: TriggerDef): TriggerEvent[] {
	if ('everyMinutes' in trigger.on) return [];
	if ('events' in trigger.on) return trigger.on.events.length > 0 ? trigger.on.events : ['create'];
	return [trigger.on.event];
}

function setTriggerEventList(trigger: TriggerDef, events: TriggerEvent[]): void {
	const selected = TRIGGER_EVENT_ORDER.filter(event => events.includes(event));
	trigger.on = { events: selected.length > 0 ? selected : ['create'] };
}

function describeTrigger(trigger: TriggerDef): string {
	const when = 'everyMinutes' in trigger.on
		? `every ${trigger.on.everyMinutes} min`
		: `on ${triggerEventList(trigger).map(event => TRIGGER_EVENT_LABELS[event].toLowerCase()).join(', ')}`;
	const scope = !('everyMinutes' in trigger.on) && trigger.scope?.folder ? ` in ${trigger.scope.folder}` : '';
	const conds = trigger.conditions.length ? `, ${trigger.conditions.length} condition${trigger.conditions.length > 1 ? 's' : ''}` : '';
	const action = describeTriggerAction(trigger.action);
	return `${when}${scope}${conds} → ${action}`;
}

function getTriggerWarning(tab: CrucibleSettingTab, trigger: TriggerDef): string | null {
	if (trigger.action.kind === 'chain') {
		const chainName = trigger.action.chainName;
		if (!chainName) return 'No chain selected; this trigger will not run.';
		if (!tab.plugin.settings.chains.some(c => c.name === chainName)) {
			return `Chain "${chainName}" does not exist.`;
		}
	}
	if (trigger.action.kind === 'command') {
		const commandId = trigger.action.commandId;
		if (!commandId) return 'No command selected; this trigger will not run.';
		if (!tab.plugin.chainManager.hasInternalCommand(commandId)) {
			return `Command "${commandId}" is not queueable.`;
		}
	}
	if ('everyMinutes' in trigger.on && (trigger.scope?.folder || trigger.conditions.length)) {
		return 'Schedule triggers have no note context; scope and conditions are ignored.';
	}
	return null;
}

function describeTriggerAction(action: TriggerAction): string {
	if (action.kind === 'chain') return `chain "${action.chainName || '(none)'}"`;
	if (action.kind === 'command') return `command "${action.commandId || '(none)'}"`;
	return `workflow ${TRIGGER_WORKFLOW_LABELS[action.jobType] ?? action.jobType}`;
}

function queueableTriggerCommands(tab: CrucibleSettingTab): Command[] {
	return tab.plugin.commandRegistry
		.filter(entry => entry.queueable)
		.map(entry => ({
			id: `${tab.plugin.manifest.id}:${entry.id}`,
			name: entry.name,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function renderTriggerListSection(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	new Setting(containerEl).setName('Triggers').setHeading();
	containerEl.createEl('p', { text: 'Run a chain, queueable command, or workflow automatically when an event or schedule fires. Triggered work runs through the queue (dedupe, pacing, timeouts, note locks).' });

	const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
	if (tab.plugin.settings.triggers.length === 0) {
		group.createDiv({ text: 'No triggers defined.', cls: 'crucible-empty-state' });
	} else {
		sortByNameWithEmptyLast(tab.plugin.settings.triggers, t => t.name).forEach(({ item: trigger, index }, displayIdx) => {
			if (displayIdx > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
			const setting = new Setting(group)
				.setName(trigger.name || '(unnamed)')
				.setDesc(describeTrigger(trigger))
				.addToggle(t => t
					.setTooltip('Enabled')
					.setValue(trigger.enabled)
					.onChange(async (v) => { trigger.enabled = v; await tab.plugin.saveSettings(); tab.plugin.registerTriggers(); }))
				.addExtraButton(cb => cb.setIcon('copy').setTooltip('Duplicate trigger').onClick(async () => {
					const copy = JSON.parse(JSON.stringify(trigger)) as TriggerDef;
					copy.id = newTriggerId();
					copy.name = copy.name ? `${copy.name} (copy)` : '(copy)';
					tab.plugin.settings.triggers.push(copy);
					await tab.plugin.saveSettings();
					tab.plugin.registerTriggers();
					tab.display();
				}))
				.addExtraButton(cb => cb.setIcon('pencil').setTooltip('Edit trigger').onClick(() => {
					tab.editingTriggerIndex = index;
					tab.display();
				}))
				.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete trigger').onClick(async () => {
					tab.plugin.settings.triggers.splice(index, 1);
					await tab.plugin.saveSettings();
					tab.plugin.registerTriggers();
					tab.display();
				}));
			const warning = getTriggerWarning(tab, trigger);
			if (warning) addWarningIcon(setting.nameEl, warning);
		});
	}

	new Setting(containerEl).addButton(bt => bt.setButtonText('Add trigger').setCta().onClick(async () => {
		tab.plugin.settings.triggers.push(newTrigger());
		await tab.plugin.saveSettings();
		tab.editingTriggerIndex = tab.plugin.settings.triggers.length - 1;
		tab.display();
	}));
}

function renderTriggerConditions(tab: CrucibleSettingTab, containerEl: HTMLElement, trigger: TriggerDef, save: () => void | Promise<void>, reregister: () => void) {
	new Setting(containerEl).setName('Conditions').setHeading();
	containerEl.createEl('p', { text: 'All/any of these must hold (evaluated against the note\'s frontmatter and tags) for the action to run.' });

	const group = containerEl.createDiv({ cls: 'crucible-settings-group' });

	if (trigger.conditions.length > 1) {
		new Setting(group)
			.setName('Match')
			.addDropdown(d => d
				.addOption('all', 'All conditions (AND)')
				.addOption('any', 'Any condition (OR)')
				.setValue(trigger.conditionMode ?? 'all')
				.onChange(async (v) => { trigger.conditionMode = v as 'all' | 'any'; await save(); reregister(); }));
		group.createEl('hr', { cls: 'crucible-row-divider' });
	}

	if (trigger.conditions.length === 0) {
		group.createDiv({ text: 'No conditions — the action runs on every matching event.', cls: 'crucible-empty-state' });
	}

	trigger.conditions.forEach((cond, i) => {
		if (i > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(group)
			.setName(`Condition ${i + 1}`)
			.addDropdown(d => {
				// word-count-* needs an async content read; not available to the sync trigger guard.
				SYNC_GUARD_CONDITION_TYPES.forEach(t => { d.addOption(t, GUARD_TYPE_LABELS[t]); });
				d.setValue(cond.type);
				d.onChange(async (v) => {
					cond.type = v as GuardConditionType;
					normalizeGuardConditionForType(cond);
					await save();
					reregister();
					tab.refreshDisplay();
				});
			})
			.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove condition').onClick(async () => {
				trigger.conditions.splice(i, 1);
				await save();
				reregister();
				tab.refreshDisplay();
			}));

		renderGuardConditionFields(tab, group, cond, save, {
			after: reregister,
			refresh: () => tab.refreshDisplay(),
			targetLabel: 'note',
		});
	});

	new Setting(containerEl).addButton(bt => bt.setButtonText('Add condition').onClick(async () => {
		const next: GuardCondition = { type: 'has-property' };
		trigger.conditions.push(next);
		await save();
		reregister();
		tab.display();
	}));
}

function renderTriggerCommandArgs(
	tab: CrucibleSettingTab,
	containerEl: HTMLElement,
	action: Extract<TriggerAction, { kind: 'command' }>,
	save: () => void | Promise<void>,
) {
	const schema = tab.plugin.chainManager.getCommandSchema(action.commandId);
	if (!schema || schema.length === 0) return;
	const args = action.args ?? (action.args = {});
	for (const arg of schema) {
		containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		renderCommandArgSetting(tab, containerEl, arg, args, save);
	}
}

function renderCommandArgSetting(
	tab: CrucibleSettingTab,
	containerEl: HTMLElement,
	arg: CommandArgSchema,
	args: Record<string, string>,
	save: () => void | Promise<void>,
) {
	const setting = new Setting(containerEl)
		.setName(arg.name)
		.setDesc(arg.description || '');
	switch (arg.type) {
		case 'text':
			setting.addText(t => t
				.setValue(args[arg.id] || '')
				.onChange(async (v) => { args[arg.id] = v; await save(); })
				.inputEl.addClass('pi-width-normal'));
			break;
		case 'textarea':
			setting.addTextArea(t => t
				.setValue(args[arg.id] || '')
				.onChange(async (v) => { args[arg.id] = v; await save(); })
				.inputEl.addClass('crucible-setting-textarea', 'pi-width-normal'));
			break;
		case 'dropdown':
			setting.addDropdown(d => {
				if (arg.options) d.addOptions(arg.options);
				d.setValue(args[arg.id] || '')
					.onChange(async (v) => { args[arg.id] = v; await save(); });
				d.selectEl.addClass('pi-width-normal');
			});
			break;
		case 'file':
			setting.addSearch(cb => {
				cb.setPlaceholder('Select file...')
					.setValue(args[arg.id] || '')
					.onChange(async (v) => { args[arg.id] = v; await save(); });
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FileSuggest(tab.app, cb.inputEl);
			});
			break;
		case 'folder':
			setting.addSearch(cb => {
				cb.setPlaceholder('Select folder...')
					.setValue(args[arg.id] || '')
					.onChange(async (v) => { args[arg.id] = v; await save(); });
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FolderSuggest(tab.app, cb.inputEl);
			});
			break;
	}
}

function renderEditTrigger(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const save = () => tab.plugin.saveSettings();
	const reregister = () => tab.plugin.registerTriggers();
	const trigger = tab.plugin.settings.triggers[tab.editingTriggerIndex];
	if (!trigger) {
		tab.editingTriggerIndex = -1;
		renderAutomateSettings(tab, containerEl);
		return;
	}

	const heading = new Setting(containerEl).setName('Edit Trigger').setHeading();
	const warning = getTriggerWarning(tab, trigger);
	if (warning) addWarningIcon(heading.nameEl, warning);

	const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
	bindText(group, {
		name: 'Trigger name',
		placeholder: 'e.g. Ingest YouTube clippings',
		get: () => trigger.name,
		set: (v) => { trigger.name = v; },
		after: reregister,
	}, save);
	group.createEl('hr', { cls: 'crucible-row-divider' });
	bindToggle(group, {
		name: 'Enabled',
		get: () => trigger.enabled,
		set: (v) => { trigger.enabled = v; },
		after: reregister,
	}, save);

	// --- When ---
	new Setting(containerEl).setName('When').setHeading();
	const whenGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	new Setting(whenGroup)
		.setName('Trigger on')
		.addDropdown(d => d
			.addOption('event', 'Note event')
			.addOption('schedule', 'Schedule')
			.setValue('everyMinutes' in trigger.on ? 'schedule' : 'event')
			.onChange(async (v) => {
				trigger.on = v === 'schedule' ? { everyMinutes: 60 } : { events: ['create'] };
				await save();
				reregister();
				tab.display();
			}));
	whenGroup.createEl('hr', { cls: 'crucible-row-divider' });
	if ('everyMinutes' in trigger.on) {
		bindNumber(whenGroup, {
			name: 'Every (minutes)',
			desc: '0 disables the schedule.',
			placeholder: '60',
			min: 0,
			get: () => String('everyMinutes' in trigger.on ? trigger.on.everyMinutes : 0),
			set: (raw) => { if ('everyMinutes' in trigger.on) trigger.on.everyMinutes = Math.max(0, Number(raw) || 0); },
			after: reregister,
		}, save);
	} else {
		const eventSetting = new Setting(whenGroup)
			.setName('Events')
			.setDesc('Runs when any selected event fires.');
		const grid = eventSetting.controlEl.createDiv({ cls: 'crucible-checkbox-grid' });
		const selected = new Set(triggerEventList(trigger));
		for (const event of TRIGGER_EVENT_ORDER) {
			const itemLabel = grid.createEl('label', { cls: 'crucible-checkbox-grid-item' });
			const cb = itemLabel.createEl('input', { type: 'checkbox' });
			cb.checked = selected.has(event);
			itemLabel.createSpan({ text: TRIGGER_EVENT_LABELS[event] });
			cb.addEventListener('change', () => {
				void (async () => {
					const next = new Set(triggerEventList(trigger));
					if (cb.checked) next.add(event);
					else next.delete(event);
					setTriggerEventList(trigger, Array.from(next));
					await save();
					reregister();
					if (next.size === 0) tab.refreshDisplay();
				})();
			});
		}
	}

	// --- Scope + Conditions (event triggers only) ---
	if (!('everyMinutes' in trigger.on)) {
		new Setting(containerEl).setName('Scope').setHeading();
		const scopeGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
		const scope = trigger.scope ?? (trigger.scope = { folder: '', includeSubfolders: true });
		bindSearch(scopeGroup, {
			name: 'Folder',
			desc: 'Only notes under this folder qualify. Empty = whole vault.',
			placeholder: 'Clippings',
			get: () => scope.folder ?? '',
			set: (v) => { scope.folder = v; },
			suggest: (el) => { new FolderSuggest(tab.app, el); },
			after: reregister,
		}, save);
		scopeGroup.createEl('hr', { cls: 'crucible-row-divider' });
		bindToggle(scopeGroup, {
			name: 'Include subfolders',
			get: () => scope.includeSubfolders !== false,
			set: (v) => { scope.includeSubfolders = v; },
			after: reregister,
		}, save);

		renderTriggerConditions(tab, containerEl, trigger, save, reregister);
	}

	// --- Then (action) ---
	new Setting(containerEl).setName('Then').setHeading();
	const actionGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	new Setting(actionGroup)
		.setName('Action')
		.addDropdown(d => d
			.addOption('chain', 'Run a chain')
			.addOption('command', 'Run a command')
			.addOption('workflow', 'Enqueue a workflow')
			.setValue(trigger.action.kind)
			.onChange(async (v) => {
				trigger.action = v === 'workflow'
					? { kind: 'workflow', jobType: 'daily_brief_lite' }
					: v === 'command'
						? { kind: 'command', commandId: '', args: {} }
						: { kind: 'chain', chainName: '' };
				await save();
				reregister();
				tab.display();
			}));
	actionGroup.createEl('hr', { cls: 'crucible-row-divider' });
	const action = trigger.action;
	if (action.kind === 'chain') {
		new Setting(actionGroup)
			.setName('Chain')
			.setDesc('The chain to run on the triggering note.')
			.addDropdown(d => {
				d.addOption('', '(select chain)');
				tab.plugin.settings.chains.filter(c => c.name).forEach(c => { d.addOption(c.name, c.name); });
				d.setValue(action.chainName);
				d.onChange(async (v) => { action.chainName = v; await save(); reregister(); tab.refreshDisplay(); });
			});
	} else if (action.kind === 'command') {
		new Setting(actionGroup)
			.setName('Command')
			.setDesc('The queueable Crucible command to run on the triggering note.')
			.addDropdown(d => {
				d.addOption('', '(select command)');
				queueableTriggerCommands(tab).forEach(command => { d.addOption(command.id, command.name); });
				d.setValue(action.commandId);
				d.onChange(async (v) => {
					action.commandId = v;
					action.args = {};
					await save();
					reregister();
					tab.refreshDisplay();
				});
			});
		renderTriggerCommandArgs(tab, actionGroup, action, save);
	} else {
		new Setting(actionGroup)
			.setName('Workflow')
			.setDesc('The orchestration workflow to enqueue.')
			.addDropdown(d => {
				Object.entries(TRIGGER_WORKFLOW_LABELS).forEach(([jt, label]) => { d.addOption(jt, label); });
				d.setValue(action.jobType);
				d.onChange(async (v) => { action.jobType = v as JobType; await save(); reregister(); });
			});
	}

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });
	new Setting(containerEl)
		.addButton(bt => bt.setButtonText('Done').setCta().onClick(() => {
			tab.editingTriggerIndex = -1;
			tab.display();
		}))
		.addButton(bt => bt.setButtonText('Delete trigger').setWarning().onClick(async () => {
			tab.plugin.settings.triggers.splice(tab.editingTriggerIndex, 1);
			tab.editingTriggerIndex = -1;
			await save();
			reregister();
			tab.display();
		}));
}

function renderShortcutSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const save = () => tab.plugin.saveSettings();
	new Setting(containerEl).setName('Shortcuts').setHeading();
	containerEl.createEl('p', { text: 'Create custom commands to open specific files directly from the Command Palette.' });
	const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
	sortByNameWithEmptyLast(tab.plugin.settings.shortcuts, s => s.name).forEach(({ item: shortcut, index }, displayIdx) => {
		if (displayIdx > 0) group.createEl('hr', { cls: 'crucible-mini-hr' });
		const row = group.createDiv({ cls: 'crucible-folder-template-row' });
		const s = new Setting(row).addText(t => t.setPlaceholder('Shortcut name').setValue(shortcut.name).onChange(async (v) => { shortcut.name = v; await save(); tab.plugin.registerShortcuts(); }).inputEl.addClass('pi-width-normal'))
			.addSearch(cb => {
				cb.setPlaceholder('File to open').setValue(shortcut.file).onChange(async (v) => { shortcut.file = v; await save(); tab.plugin.registerShortcuts(); });
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FileSuggest(tab.app, cb.inputEl);
			})
			.addExtraButton(cb => { cb.setIcon('trash').onClick(async () => { tab.plugin.settings.shortcuts.splice(index, 1); await save(); tab.plugin.registerShortcuts(); tab.display(); }); });
		s.infoEl.remove();
	});
	new Setting(group).addButton(bt => bt.setButtonText('Add shortcut').setCta().onClick(async () => { tab.plugin.settings.shortcuts.push({ name: '', file: '' }); await save(); tab.display(); }));
}

function renderEditCapture(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const save = () => tab.plugin.saveSettings();
	const capture = tab.plugin.settings.captures[tab.editingCaptureIndex];
	if (!capture) {
		tab.editingCaptureIndex = -1;
		renderAutomateSettings(tab, containerEl);
		return;
	}

	const heading = new Setting(containerEl).setName('Edit Capture').setHeading();
	const captureWarning = getCaptureWarning(tab, capture);
	if (captureWarning) addWarningIcon(heading.nameEl, captureWarning);

	const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
	if (captureWarning) {
		group.createDiv({ cls: 'crucible-setting-warning', text: captureWarning });
	}
	bindText(group, {
		name: 'Capture name',
		placeholder: 'e.g. quick note',
		get: () => capture.name,
		set: (v) => { capture.name = v; },
		after: () => tab.plugin.registerCaptures(),
	}, save);

	group.createEl('hr', { cls: 'crucible-row-divider' });
	bindDropdown(group, {
		name: 'Target note',
		options: { daily: 'Daily note', weekly: 'Weekly note', monthly: 'Monthly note', active: 'Active note', selected: 'Specify note' },
		get: () => capture.targetType,
		set: (v) => { capture.targetType = v as CaptureTarget; },
		after: () => tab.display(),
	}, save);

	if (capture.targetType === 'selected') {
		group.createEl('hr', { cls: 'crucible-row-divider' });
		bindSearch(group, {
			name: 'Select note',
			placeholder: 'e.g. inbox.md',
			get: () => capture.file,
			set: (v) => { capture.file = v; },
			suggest: (el) => { new FileSuggest(tab.app, el); },
		}, save);
	}

	group.createEl('hr', { cls: 'crucible-row-divider' });
	bindDropdown(group, {
		name: 'Capture source',
		options: { dialog: 'Dialog', line: 'Current line', 'line-fallback': 'Current line -> Dialog', selection: 'Selection', 'selection-fallback': 'Selection -> Dialog' },
		get: () => capture.source || 'dialog',
		set: (v) => { capture.source = v as CaptureSource; },
	}, save);

	group.createEl('hr', { cls: 'crucible-row-divider' });
	bindDropdown(group, {
		name: 'Target section mode',
		desc: 'Choose whether captures use a fixed section or the matching source-note section.',
		options: { fixed: 'Fixed section', source: 'Same source section' },
		get: () => capture.targetSectionMode || 'fixed',
		set: (v) => { capture.targetSectionMode = v as CaptureTargetSectionMode; },
		after: () => tab.display(),
	}, save);

	group.createEl('hr', { cls: 'crucible-row-divider' });
	const targetSectionMode = capture.targetSectionMode || 'fixed';
	bindText(group, {
		name: targetSectionMode === 'source' ? 'Fallback section' : 'Target section',
		desc: targetSectionMode === 'source'
			? 'Header used when the matching source section is not present in the target note.'
			: 'Header to target (e.g. # Captures). If empty, targets top/bottom of file.',
		placeholder: '# header',
		get: () => capture.targetSection,
		set: (v) => { capture.targetSection = v; },
	}, save);

	group.createEl('hr', { cls: 'crucible-row-divider' });
	bindDropdown(group, {
		name: 'Write mode',
		desc: 'How captured content is added to the target section or file.',
		options: { append: 'Append', prepend: 'Prepend', replace: 'Replace' },
		get: () => capture.writeMode || 'append',
		set: (v) => { capture.writeMode = v as CaptureWriteMode; },
	}, save);

	group.createEl('hr', { cls: 'crucible-row-divider' });
	const contentSetting = bindTextArea(group, {
		name: 'Content template',
		desc: 'Text to capture (supports variables like {{now}}, {{value}}, {{source_link}}).',
		placeholder: '- {{now}}: {{value}}',
		width: 'pi-width-wide',
		get: () => capture.content,
		set: (v) => { capture.content = v; },
	}, save);
	tab.addTemplateVariablesToggle(contentSetting, 'capture-content', tab.captureTemplateVariables());
	tab.renderTemplateVariablesPanel(group, 'capture-content', tab.captureTemplateVariables());

	group.createEl('hr', { cls: 'crucible-row-divider' });
	new Setting(group).addButton(bt => bt.setButtonText('Delete capture').setWarning().onClick(async () => {
		tab.plugin.settings.captures.splice(tab.editingCaptureIndex, 1);
		tab.editingCaptureIndex = -1;
		await save();
		tab.plugin.registerCaptures();
		tab.display();
	}));
}
