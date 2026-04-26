import { App, TFile, Notice, moment } from 'obsidian';
import { CrucibleSettings } from './types';
import { ensureFolder, applyTemplateString } from './utils';

export class Materializer {
	app: App;
	settings: CrucibleSettings;
	setMaterializing: (state: boolean) => void;

	constructor(app: App, settings: CrucibleSettings, setMaterializing: (state: boolean) => void) {
		this.app = app;
		this.settings = settings;
		this.setMaterializing = setMaterializing;
	}

	async materializeDay(date: moment.Moment) {
		this.setMaterializing(true);
		const dateStr = date.format('YYYY-MM-DD');
		const dailyFolderBase = this.settings.dailyFolder;
		const folderPath = `${dailyFolderBase}/${dateStr}`;
		const filePath = `${dailyFolderBase}/${dateStr}.md`;

		try {
			await ensureFolder(this.app, folderPath);

			const existingFile = this.app.vault.getAbstractFileByPath(filePath);
			if (!(existingFile instanceof TFile)) {
				const content = await this.applyTemplate(this.settings.dailyTemplate, date, dateStr);
				await this.app.vault.create(filePath, content);
				new Notice(`Created daily note and folder for ${dateStr}`);
			} else if (existingFile.stat.size === 0) {
				const content = await this.applyTemplate(this.settings.dailyTemplate, date, dateStr);
				await this.app.vault.modify(existingFile, content);
				new Notice(`Materialized empty daily note for ${dateStr}`);
			}

			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				await this.app.workspace.getLeaf().openFile(file);
			}
		} catch (e) {
			new Notice(`Error materializing day: ${(e as Error).message}`);
			console.error(e);
		} finally {
			this.setMaterializing(false);
		}
	}

	async materializeWeek(date: moment.Moment) {
		this.setMaterializing(true);
		const weekStr = date.format('GGGG-[W]WW');
		const folderPath = this.settings.weeklyFolder;
		const filePath = `${folderPath}/${weekStr}.md`;

		try {
			await ensureFolder(this.app, folderPath);

			const existingFile = this.app.vault.getAbstractFileByPath(filePath);
			if (!(existingFile instanceof TFile)) {
				const content = await this.applyTemplate(this.settings.weeklyTemplate, date, weekStr);
				await this.app.vault.create(filePath, content);
				new Notice(`Created weekly note for ${weekStr}`);
			} else if (existingFile.stat.size === 0) {
				const content = await this.applyTemplate(this.settings.weeklyTemplate, date, weekStr);
				await this.app.vault.modify(existingFile, content);
				new Notice(`Materialized empty weekly note for ${weekStr}`);
			}

			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				await this.app.workspace.getLeaf().openFile(file);
			}
		} catch (e) {
			new Notice(`Error materializing week: ${(e as Error).message}`);
		} finally {
			this.setMaterializing(false);
		}
	}

	async materializeMonth(date: moment.Moment) {
		this.setMaterializing(true);
		const monthStr = date.format('YYYY-MM');
		const folderPath = this.settings.monthlyFolder;
		const filePath = `${folderPath}/${monthStr}.md`;

		try {
			await ensureFolder(this.app, folderPath);

			const existingFile = this.app.vault.getAbstractFileByPath(filePath);
			if (!(existingFile instanceof TFile)) {
				const content = await this.applyTemplate(this.settings.monthlyTemplate, date, monthStr);
				await this.app.vault.create(filePath, content);
				new Notice(`Created monthly note for ${monthStr}`);
			} else if (existingFile.stat.size === 0) {
				const content = await this.applyTemplate(this.settings.monthlyTemplate, date, monthStr);
				await this.app.vault.modify(existingFile, content);
				new Notice(`Materialized empty monthly note for ${monthStr}`);
			}

			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				await this.app.workspace.getLeaf().openFile(file);
			}
		} catch (e) {
			new Notice(`Error materializing month: ${(e as Error).message}`);
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
