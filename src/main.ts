import { App, Modal, Notice, Plugin, TFile, TFolder } from 'obsidian';
import { DEFAULT_SETTINGS, PersonalInternetSettings, PersonalInternetSettingTab } from "./settings";

export default class PersonalInternetPlugin extends Plugin {
	settings: PersonalInternetSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'materialize-day-today',
			name: 'Materialize Day: Today',
			callback: () => this.materializeDay(window.moment()),
		});

		this.addCommand({
			id: 'materialize-day-picker',
			name: 'Materialize Day: Pick Date',
			callback: () => {
				new DatePromptModal(this.app, (date) => {
					this.materializeDay(window.moment(date));
				}).open();
			},
		});

		this.addCommand({
			id: 'materialize-week-today',
			name: 'Materialize Week: Current',
			callback: () => this.materializeWeek(window.moment()),
		});

		this.addCommand({
			id: 'materialize-month-today',
			name: 'Materialize Month: Current',
			callback: () => this.materializeMonth(window.moment()),
		});

		this.addSettingTab(new PersonalInternetSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<PersonalInternetSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async ensureFolder(path: string): Promise<void> {
		const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/, '');
		const parts = normalizedPath.split('/');
		let currentPath = '';

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const folder = this.app.vault.getAbstractFileByPath(currentPath);
			if (!(folder instanceof TFolder)) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	async applyTemplate(templatePath: string, date: moment.Moment): Promise<string> {
		if (!templatePath) return '';

		const file = this.app.vault.getAbstractFileByPath(templatePath);
		if (!(file instanceof TFile)) {
			new Notice(`Template file not found: ${templatePath}`);
			return '';
		}

		let content = await this.app.vault.read(file);

		// Handle {{datetime:FORMAT}}
		content = content.replace(/{{datetime:(.*?)}}/g, (match, format) => {
			return date.format(format);
		});

		// Handle {{date}} shorthand
		content = content.replace(/{{date}}/g, date.format('YYYY-MM-DD'));

		// Handle {{time}} shorthand
		content = content.replace(/{{time}}/g, date.format('HH:mm'));

		return content;
	}

	async materializeDay(date: moment.Moment) {
		const dateStr = date.format('YYYY-MM-DD');
		const dailyFolderBase = this.settings.dailyFolder;
		const folderPath = `${dailyFolderBase}/${dateStr}`;
		const filePath = `${folderPath}/${dateStr}.md`;

		try {
			await this.ensureFolder(folderPath);

			if (!(this.app.vault.getAbstractFileByPath(filePath) instanceof TFile)) {
				const content = await this.applyTemplate(this.settings.dailyTemplate, date);
				await this.app.vault.create(filePath, content);
				new Notice(`Created daily note and folder for ${dateStr}`);
			} else {
				new Notice(`Daily note for ${dateStr} already exists`);
			}

			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				await this.app.workspace.getLeaf().openFile(file);
			}
		} catch (e) {
			new Notice(`Error materializing day: ${e.message}`);
			console.error(e);
		}
	}

	async materializeWeek(date: moment.Moment) {
		const weekStr = date.format('YYYY-[W]WW');
		const folderPath = this.settings.weeklyFolder;
		const filePath = `${folderPath}/${weekStr}.md`;

		try {
			await this.ensureFolder(folderPath);

			if (!(this.app.vault.getAbstractFileByPath(filePath) instanceof TFile)) {
				const content = await this.applyTemplate(this.settings.weeklyTemplate, date);
				await this.app.vault.create(filePath, content);
				new Notice(`Created weekly note for ${weekStr}`);
			} else {
				new Notice(`Weekly note for ${weekStr} already exists`);
			}

			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				await this.app.workspace.getLeaf().openFile(file);
			}
		} catch (e) {
			new Notice(`Error materializing week: ${e.message}`);
		}
	}

	async materializeMonth(date: moment.Moment) {
		const monthStr = date.format('YYYY-MM');
		const folderPath = this.settings.monthlyFolder;
		const filePath = `${folderPath}/${monthStr}.md`;

		try {
			await this.ensureFolder(folderPath);

			if (!(this.app.vault.getAbstractFileByPath(filePath) instanceof TFile)) {
				const content = await this.applyTemplate(this.settings.monthlyTemplate, date);
				await this.app.vault.create(filePath, content);
				new Notice(`Created monthly note for ${monthStr}`);
			} else {
				new Notice(`Monthly note for ${monthStr} already exists`);
			}

			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				await this.app.workspace.getLeaf().openFile(file);
			}
		} catch (e) {
			new Notice(`Error materializing month: ${e.message}`);
		}
	}
}

class DatePromptModal extends Modal {
	onSubmit: (result: string) => void;

	constructor(app: App, onSubmit: (result: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Pick a date' });

		const input = contentEl.createEl('input', { type: 'date' });
		input.style.width = '100%';
		input.style.marginBottom = '10px';
		input.value = window.moment().format('YYYY-MM-DD');

		const submit = contentEl.createEl('button', { text: 'Submit' });
		submit.addEventListener('click', () => {
			this.onSubmit(input.value);
			this.close();
		});
		
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				this.onSubmit(input.value);
				this.close();
			}
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
