import { App, TFile, Notice, moment } from 'obsidian';
import { CrucibleSettings } from './types';
import { ensureFolder, applyTemplateString } from './utils';
import { PeriodId, getPeriodConfig, periodDisabledMessage } from './periods';

export class Materializer {
	app: App;
	settings: CrucibleSettings;
	setMaterializing: (state: boolean) => void;

	constructor(app: App, settings: CrucibleSettings, setMaterializing: (state: boolean) => void) {
		this.app = app;
		this.settings = settings;
		this.setMaterializing = setMaterializing;
	}

	async materializeDay(date: moment.Moment): Promise<boolean> {
		return await this.materializePeriod('daily', date);
	}

	async materializeWeek(date: moment.Moment): Promise<boolean> {
		return await this.materializePeriod('weekly', date);
	}

	async materializeMonth(date: moment.Moment): Promise<boolean> {
		return await this.materializePeriod('monthly', date);
	}

	private async materializePeriod(period: PeriodId, date: moment.Moment): Promise<boolean> {
		const config = getPeriodConfig(this.settings, period);
		if (!config.enabled) {
			new Notice(periodDisabledMessage(period));
			return false;
		}

		this.setMaterializing(true);
		const periodStr = date.format(config.dateFormat);
		const filePath = `${config.folder}/${periodStr}.md`;

		try {
			await ensureFolder(this.app, config.createAssetFolder ? `${config.folder}/${periodStr}` : config.folder);

			const existingFile = this.app.vault.getAbstractFileByPath(filePath);
			if (!(existingFile instanceof TFile)) {
				const content = await this.applyTemplate(config.template, date, periodStr);
				await this.app.vault.create(filePath, content);
				const assetSuffix = config.createAssetFolder ? ' and asset folder' : '';
				new Notice(`Created ${config.lowerLabel} note${assetSuffix} for ${periodStr}`);
			} else if (existingFile.stat.size === 0) {
				const content = await this.applyTemplate(config.template, date, periodStr);
				await this.app.vault.modify(existingFile, content);
				new Notice(`Materialized empty ${config.lowerLabel} note for ${periodStr}`);
			}

			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				await this.app.workspace.getLeaf().openFile(file);
			}
			return true;
		} catch (e) {
			new Notice(`Error materializing ${config.lowerLabel}: ${(e as Error).message}`);
			return false;
		} finally {
			this.setMaterializing(false);
		}
	}

	private async applyTemplate(templatePath: string, date: moment.Moment, fileName: string): Promise<string> {
		if (!templatePath) return '';
		const file = this.app.vault.getAbstractFileByPath(templatePath);
		if (!(file instanceof TFile)) return '';

		let content = await this.app.vault.read(file);
		return await applyTemplateString(content, date, fileName);
	}
}
