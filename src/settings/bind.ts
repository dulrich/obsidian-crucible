import { Setting } from "obsidian";
import { SearchWithContainer, autoSize } from "./shared";

/**
 * Data-driven field helpers. Each encapsulates the
 * `new Setting(...).addX(...).setValue(...).onChange(async v => { set(v); await save(); })`
 * chain that otherwise repeats once per setting. Pass a `get`/`set` pair bound to the
 * backing field and the tab's `save` callback; the helper owns the wiring.
 */

export type Save = () => void | Promise<void>;

export type FieldWidth = 'pi-width-small' | 'pi-width-half' | 'pi-width-normal' | 'pi-width-wide';

interface FieldSpecBase {
	name?: string;
	desc?: string;
	/** Tooltip on the control (toggles use the toggle tooltip). */
	tooltip?: string;
	/** Width class applied to the input/select element. */
	width?: FieldWidth;
	/** Optional side effect run after the value is set and saved (e.g. re-render, re-register). */
	after?: () => void | Promise<void>;
}

function startSetting(container: HTMLElement, spec: FieldSpecBase): Setting {
	const setting = new Setting(container);
	if (spec.name !== undefined) setting.setName(spec.name);
	if (spec.desc !== undefined) setting.setDesc(spec.desc);
	return setting;
}

export interface TextFieldSpec extends FieldSpecBase {
	placeholder?: string;
	get: () => string;
	set: (value: string) => void;
}

export function bindText(container: HTMLElement, spec: TextFieldSpec, save: Save): Setting {
	const setting = startSetting(container, spec);
	setting.addText(t => {
		if (spec.placeholder !== undefined) t.setPlaceholder(spec.placeholder);
		t.setValue(spec.get());
		t.onChange(async (v) => { spec.set(v); await save(); if (spec.after) await spec.after(); });
		t.inputEl.addClass(spec.width ?? 'pi-width-normal');
		if (spec.tooltip !== undefined) t.inputEl.title = spec.tooltip;
	});
	return setting;
}

export interface ToggleFieldSpec extends FieldSpecBase {
	get: () => boolean;
	set: (value: boolean) => void;
}

export function bindToggle(container: HTMLElement, spec: ToggleFieldSpec, save: Save): Setting {
	const setting = startSetting(container, spec);
	setting.addToggle(t => {
		if (spec.tooltip !== undefined) t.setTooltip(spec.tooltip);
		t.setValue(spec.get());
		t.onChange(async (v) => { spec.set(v); await save(); if (spec.after) await spec.after(); });
	});
	return setting;
}

export interface NumberFieldSpec extends FieldSpecBase {
	placeholder?: string;
	get: () => string;
	/** Receives the raw input string; the caller parses/clamps as needed. */
	set: (raw: string) => void;
	min?: number;
	max?: number;
	step?: number;
}

export function bindNumber(container: HTMLElement, spec: NumberFieldSpec, save: Save): Setting {
	const setting = startSetting(container, spec);
	setting.addText(t => {
		if (spec.placeholder !== undefined) t.setPlaceholder(spec.placeholder);
		t.setValue(spec.get());
		t.onChange(async (v) => { spec.set(v); await save(); if (spec.after) await spec.after(); });
		t.inputEl.type = 'number';
		if (spec.min !== undefined) t.inputEl.min = String(spec.min);
		if (spec.max !== undefined) t.inputEl.max = String(spec.max);
		if (spec.step !== undefined) t.inputEl.step = String(spec.step);
		t.inputEl.addClass(spec.width ?? 'pi-width-small');
	});
	return setting;
}

export interface DropdownFieldSpec extends FieldSpecBase {
	options: Record<string, string>;
	get: () => string;
	set: (value: string) => void;
}

export function bindDropdown(container: HTMLElement, spec: DropdownFieldSpec, save: Save): Setting {
	const setting = startSetting(container, spec);
	setting.addDropdown(d => {
		d.addOptions(spec.options);
		d.setValue(spec.get());
		d.onChange(async (v) => { spec.set(v); await save(); if (spec.after) await spec.after(); });
		d.selectEl.addClass(spec.width ?? 'pi-width-half');
	});
	return setting;
}

export interface TextAreaFieldSpec extends FieldSpecBase {
	placeholder?: string;
	get: () => string;
	set: (value: string) => void;
}

export function bindTextArea(container: HTMLElement, spec: TextAreaFieldSpec, save: Save): Setting {
	const setting = startSetting(container, spec);
	setting.addTextArea(t => {
		if (spec.placeholder !== undefined) t.setPlaceholder(spec.placeholder);
		t.setValue(spec.get());
		t.onChange(async (v) => { spec.set(v); await save(); autoSize(t.inputEl); if (spec.after) await spec.after(); });
		t.inputEl.addClass('crucible-setting-textarea', spec.width ?? 'pi-width-normal');
		requestAnimationFrame(() => autoSize(t.inputEl));
	});
	return setting;
}

export interface SearchFieldSpec extends FieldSpecBase {
	placeholder?: string;
	get: () => string;
	set: (value: string) => void;
	/** Attach a suggester (e.g. `el => new FileSuggest(tab.app, el)`). */
	suggest?: (inputEl: HTMLInputElement) => void;
}

export function bindSearch(container: HTMLElement, spec: SearchFieldSpec, save: Save): Setting {
	const setting = startSetting(container, spec);
	setting.addSearch(cb => {
		if (spec.placeholder !== undefined) cb.setPlaceholder(spec.placeholder);
		cb.setValue(spec.get());
		cb.onChange(async (v) => { spec.set(v); await save(); if (spec.after) await spec.after(); });
		const el = (cb as unknown as SearchWithContainer).containerEl;
		if (el) el.addClass('crucible-search-container', spec.width ?? 'pi-width-normal');
		if (spec.suggest) spec.suggest(cb.inputEl);
	});
	return setting;
}
