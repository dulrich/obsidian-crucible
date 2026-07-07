/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting, Command } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { Capture, CaptureTarget, CaptureSource, CaptureTargetSectionMode, CaptureWriteMode, Chain } from "../../types";
import { agentCommandId } from "../../agents";
import { featureDisabledCommandExcludeIds, mergeCommandExcludeIds } from "../../commandAvailability";
import { getPeriodConfigByTarget } from "../../periods";
import { FileSuggest, FolderSuggest, CommandSuggest, findCommandSuggestItem, getCommandSuggestDisplayName } from "../../suggesters";
import { SearchWithContainer, sortByNameWithEmptyLast, addWarningIcon } from "../shared";
import { renderGuardConditionFields, normalizeGuardConditionForType } from "./guardConditionFields";
import { renderEditTrigger, renderTriggerListSection } from "./triggers";
import { bindText, bindToggle, bindDropdown, bindSearch, bindTextArea } from "../bind";

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
					const excludedCommands = mergeCommandExcludeIds(
						tab.plugin.settings.hiddenFromChainSearch,
						featureDisabledCommandExcludeIds(tab.plugin.commandRegistry, tab.plugin.manifest.id),
					);
					new CommandSuggest(tab.app, cb.inputEl, commandExtras, command => {
						void updateCommandId(command.id);
					}, excludedCommands);
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
