/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { GuardCondition, GuardConditionType, GuardConditionValueKind } from "../../types";
import { FileSuggest, FolderSuggest, TagSuggest, YoutubeChannelSuggest } from "../../suggesters";
import { SearchWithContainer } from "../shared";
import { bindText, bindNumber } from "../bind";
import { confirmDestructive } from "../destructiveActions";

export const GUARD_TYPE_LABELS: Record<GuardConditionType, string> = {
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

function guardValueKind(condition: GuardCondition): GuardConditionValueKind {
	return condition.valueKind ?? 'text';
}

function defaultGuardValueKind(condition: GuardCondition): void {
	if (!condition.valueKind && condition.property?.trim() === 'channelId') {
		condition.valueKind = 'youtube-channel';
	}
}

export function normalizeGuardConditionForType(condition: GuardCondition): void {
	if (condition.type === 'property-in-set' && condition.values === undefined) {
		condition.values = condition.value ? [condition.value] : [''];
	}
}

export function renderGuardConditionFields(
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
		setting.addExtraButton(cb => cb.setIcon('x').setTooltip('Remove value').onClick(() => {
			void (async () => {
				if (!(await confirmDestructive(tab.app, tab.plugin.settings, 'guard-condition-value-delete', {
					message: `Delete guard condition value "${opts.get() || '(empty)'}"?`,
				}))) return;
				await opts.remove?.();
			})();
		}));
	}
}
