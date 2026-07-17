import { App, Modal, Notice, TFile } from 'obsidian';
import type CruciblePlugin from './main';
import { PeriodId, getPeriodConfig, periodDisabledMessage } from './periods';

export function openDayPicker(plugin: CruciblePlugin): void {
	if (!plugin.settings.dailyEnabled) {
		new Notice(periodDisabledMessage('daily'));
		return;
	}
	new PickerModal(plugin.app, 'Pick a date', 'date', window.moment().format('YYYY-MM-DD'), (dateStr) => {
		void plugin.materializer.materializeDay(window.moment(dateStr, 'YYYY-MM-DD'));
	}).open();
}

export function openWeekPicker(plugin: CruciblePlugin): void {
	if (!plugin.settings.weeklyEnabled) {
		new Notice(periodDisabledMessage('weekly'));
		return;
	}
	new PickerModal(plugin.app, 'Pick a week', 'week', window.moment().format('GGGG-[W]WW'), (weekStr) => {
		void plugin.materializer.materializeWeek(window.moment(weekStr, 'GGGG-[W]WW'));
	}).open();
}

export function openMonthPicker(plugin: CruciblePlugin): void {
	if (!plugin.settings.monthlyEnabled) {
		new Notice(periodDisabledMessage('monthly'));
		return;
	}
	new PickerModal(plugin.app, 'Pick a month', 'month', window.moment().format('YYYY-MM'), (monthStr) => {
		void plugin.materializer.materializeMonth(window.moment(monthStr, 'YYYY-MM'));
	}).open();
}

export async function handlePeriodFileCreate(
	plugin: CruciblePlugin,
	file: TFile,
	parentPath: string,
	fileName: string,
	period: PeriodId,
): Promise<boolean> {
	const config = getPeriodConfig(plugin.settings, period);
	if (parentPath !== config.folder) return false;

	if (!config.enabled) {
		new Notice(periodDisabledMessage(period));
		return true;
	}

	const dateMatch = fileName.match(periodFileNameRegex(period));
	if (dateMatch) {
		void materializePeriodFromString(plugin, period, dateMatch[1]!);
	} else {
		await plugin.app.fileManager.trashFile(file);
		openPeriodPicker(plugin, period);
	}
	return true;
}

async function materializePeriodFromString(plugin: CruciblePlugin, period: PeriodId, value: string): Promise<boolean> {
	if (period === 'daily') return await plugin.materializer.materializeDay(window.moment(value, 'YYYY-MM-DD'));
	if (period === 'weekly') return await plugin.materializer.materializeWeek(window.moment(value, 'GGGG-[W]WW'));
	return await plugin.materializer.materializeMonth(window.moment(value, 'YYYY-MM'));
}

function openPeriodPicker(plugin: CruciblePlugin, period: PeriodId): void {
	if (period === 'daily') openDayPicker(plugin);
	else if (period === 'weekly') openWeekPicker(plugin);
	else openMonthPicker(plugin);
}

function periodFileNameRegex(period: PeriodId): RegExp {
	if (period === 'daily') return /^(\d{4}-\d{2}-\d{2})$/;
	if (period === 'weekly') return /^(\d{4}-W\d{2})$/;
	return /^(\d{4}-\d{2})$/;
}

class PickerModal extends Modal {
	title: string;
	type: string;
	initialValue: string;
	onSubmit: (result: string) => void;

	constructor(app: App, title: string, type: string, initialValue: string, onSubmit: (result: string) => void) {
		super(app);
		this.title = title;
		this.type = type;
		this.initialValue = initialValue;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: this.title });
		const input = contentEl.createEl('input', { type: this.type });
		input.classList.add('crucible-picker-input');
		input.value = this.initialValue;
		const submit = contentEl.createEl('button', { text: 'Submit' });
		const triggerSubmit = () => { if (input.value) { this.onSubmit(input.value); this.close(); } };
		submit.onclick = triggerSubmit;
		input.addEventListener('keydown', (e) => { if (e.key === 'Enter') triggerSubmit(); });
	}

	onClose() {
		this.contentEl.empty();
	}
}
