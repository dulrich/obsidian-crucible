/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting, Command, Notice, TFolder, debounce } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { CommandArgSchema, GuardCondition, GuardConditionType, SYNC_GUARD_CONDITION_TYPES, TriggerAction, TriggerDef, TriggerEvent } from "../../types";
import type { JobType } from "../../orchestration/types";
import { FileSuggest, FolderSuggest } from "../../suggesters";
import { SearchWithContainer, sortByNameWithEmptyLast, addWarningIcon } from "../shared";
import { bindText, bindToggle, bindSearch, bindNumber } from "../bind";
import { GUARD_TYPE_LABELS, normalizeGuardConditionForType, renderGuardConditionFields } from "./guardConditionFields";
import { confirmDestructive } from "../destructiveActions";
import { BROAD_MATCH_WARNING, TriggerValidationCtx, estimateScopeMatches, validateTrigger } from "../../triggers/triggerValidation";
import { INTERNAL_PLUGIN_FOLDER } from "../../exclusions";

// Job types sensible to enqueue directly from a trigger. chain_run/command_run are
// omitted: the "chain" action uses chain_run, and command_run needs a command id.
const TRIGGER_WORKFLOW_LABELS: Partial<Record<JobType, string>> = {
	daily_brief_lite: 'Daily brief (lite)',
	youtube_tracker: 'YouTube tracker',
	blogs_tracker: 'Blogs/RSS tracker',
	link_scan: 'Link scan',
	transcript_refine: 'Refine transcript',
	youtube_metadata_fetch: 'Fetch YouTube metadata',
	x_metadata_fetch: 'Fetch X post metadata',
	x_post_discover: 'Discover X post links',
	x_metadata_backfill: 'Backfill X posts from link registry',
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

function newTriggerId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	return `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newTrigger(): TriggerDef {
	return {
		id: newTriggerId(),
		name: '',
		// Minted disabled: an empty chainName/blank scope is exactly the incident
		// trigger's shape, and it fails validateTrigger's chain-selected rule anyway —
		// the Enable toggle would immediately veto a same-tick enable. See the
		// trigger-storm investigation.
		enabled: false,
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

// Vault-derived facts `validateTrigger` needs, built fresh per call so they always
// reflect live settings/registry state (chains and commands can change while the
// Triggers tab is open — e.g. after editing a chain in the Automate tab).
function triggerValidationCtx(tab: CrucibleSettingTab): TriggerValidationCtx {
	return {
		chainNames: tab.plugin.settings.chains.map(c => c.name),
		hasInternalCommand: (id) => tab.plugin.chainManager.hasInternalCommand(id),
		knownJobTypes: tab.plugin.orchestrator.jobTypes(),
		folderExists: (folder) => tab.app.vault.getAbstractFileByPath(folder) instanceof TFolder,
	};
}

// Thin wrapper over `validateTrigger`: joins errors + warnings into the single string
// the warning-icon tooltip expects. Errors are included here too (not just warnings) —
// this function is display-only and pre-dates the enable gate, so a trigger that is
// currently enabled-but-invalid (e.g. its chain was deleted after the trigger was
// created) still needs to show a warning icon even though it can no longer be
// (re-)enabled from scratch.
function getTriggerWarning(tab: CrucibleSettingTab, trigger: TriggerDef): string | null {
	const { errors, warnings } = validateTrigger(trigger, triggerValidationCtx(tab));
	const combined = [...errors, ...warnings];
	return combined.length > 0 ? combined.join(' ') : null;
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

// clsl-WP-4: shared by both trigger-delete entry points (list row + edit-form button) so
// they confirm through the same registry id and behave identically.
async function deleteTrigger(tab: CrucibleSettingTab, index: number) {
	const trigger = tab.plugin.settings.triggers[index];
	if (!trigger) return;
	const label = trigger.name || '(unnamed)';
	if (!(await confirmDestructive(tab.app, tab.plugin.settings, 'trigger-delete', {
		message: `Delete trigger "${label}"? This cannot be undone.`,
	}))) return;
	tab.plugin.settings.triggers.splice(index, 1);
	tab.editingTriggerIndex = -1;
	await tab.plugin.saveSettings();
	tab.plugin.registerTriggers();
	tab.display();
}

export function renderTriggerListSection(tab: CrucibleSettingTab, containerEl: HTMLElement) {
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
					.onChange(async (v) => {
						if (v) {
							const { errors } = validateTrigger(trigger, triggerValidationCtx(tab));
							if (errors.length > 0) {
								t.setValue(false);
								new Notice(errors[0] ?? 'This trigger is not valid.');
								return;
							}
						}
						trigger.enabled = v;
						await tab.plugin.saveSettings();
						tab.plugin.registerTriggers();
					}))
				.addExtraButton(cb => cb.setIcon('copy-plus').setTooltip('Duplicate trigger').onClick(async () => {
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
					await deleteTrigger(tab, index);
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
			.addExtraButton(cb => cb.setIcon('x').setTooltip('Remove condition').onClick(async () => {
				if (!(await confirmDestructive(tab.app, tab.plugin.settings, 'trigger-guard-condition-delete', {
					message: `Delete condition ${i + 1} of trigger "${trigger.name || '(unnamed)'}"?`,
				}))) return;
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

export function renderEditTrigger(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const save = () => tab.plugin.saveSettings();
	const reregister = () => tab.plugin.registerTriggers();
	const trigger = tab.plugin.settings.triggers[tab.editingTriggerIndex];
	if (!trigger) {
		tab.editingTriggerIndex = -1;
		tab.display();
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
		// Enabling is gated on validity (disabling is never gated — see bindToggle's
		// guard semantics in src/settings/bind.ts). Re-render on veto so the toggle's
		// visual state and the error block below both reflect the still-false value.
		guard: () => {
			const { errors } = validateTrigger(trigger, triggerValidationCtx(tab));
			return errors.length > 0 ? (errors[0] ?? 'This trigger is not valid.') : null;
		},
		onGuardRejected: () => tab.refreshDisplay(),
	}, save);
	const editFormErrors = validateTrigger(trigger, triggerValidationCtx(tab)).errors;
	if (editFormErrors.length > 0) {
		group.createDiv({ cls: 'crucible-setting-warning', text: editFormErrors[0] });
	}

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
			after: () => { reregister(); debouncedUpdateScopeEstimate(); },
		}, save);
		scopeGroup.createEl('hr', { cls: 'crucible-row-divider' });
		bindToggle(scopeGroup, {
			name: 'Include subfolders',
			get: () => scope.includeSubfolders !== false,
			set: (v) => { scope.includeSubfolders = v; },
			after: () => { reregister(); debouncedUpdateScopeEstimate(); },
		}, save);
		scopeGroup.createEl('hr', { cls: 'crucible-row-divider' });

		// Match-volume estimate: same exclusion predicate the registry applies
		// (isPluginManagedPath over [orchestrationQueueRoot, INTERNAL_PLUGIN_FOLDER])
		// and the same scope-prefix semantics `triggerAdapter.inScope` applies at fire
		// time (via the shared pathInScope) — see triggerValidation.ts. Upper bound:
		// conditions aren't evaluated here. Recomputed on a 300ms debounce so typing in
		// the folder field doesn't walk the vault's markdown files on every keystroke.
		const estimateEl = scopeGroup.createDiv({ cls: 'crucible-inline-warning is-info' });
		const broadMatchEl = scopeGroup.createDiv({ cls: 'crucible-inline-warning is-hidden' });
		const updateScopeEstimate = () => {
			const excludedRoots = [tab.plugin.settings.orchestrationQueueRoot, INTERNAL_PLUGIN_FOLDER];
			const paths = tab.app.vault.getMarkdownFiles().map(f => f.path);
			const count = estimateScopeMatches(paths, trigger.scope, excludedRoots);
			estimateEl.setText(`~${count} note${count === 1 ? '' : 's'} currently in scope.`);
			const { warnings } = validateTrigger(trigger, triggerValidationCtx(tab));
			if (warnings.includes(BROAD_MATCH_WARNING)) {
				broadMatchEl.setText(BROAD_MATCH_WARNING);
				broadMatchEl.removeClass('is-hidden');
			} else {
				broadMatchEl.setText('');
				broadMatchEl.addClass('is-hidden');
			}
		};
		updateScopeEstimate();
		const debouncedUpdateScopeEstimate = debounce(updateScopeEstimate, 300);

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
			await deleteTrigger(tab, tab.editingTriggerIndex);
		}));
}
