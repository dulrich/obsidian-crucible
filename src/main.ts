import { App, Modal, Notice, Plugin, TFile, TFolder, TAbstractFile, MarkdownView, parseFrontMatterEntry, debounce } from 'obsidian';
import { DEFAULT_SETTINGS, PersonalInternetSettings, PersonalInternetSettingTab } from "./settings";

export default class PersonalInternetPlugin extends Plugin {
	settings: PersonalInternetSettings;
	private isMaterializing = false;

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
			callback: () => this.openDayPicker(),
		});

		this.addCommand({
			id: 'materialize-week-today',
			name: 'Materialize Week: Current',
			callback: () => this.materializeWeek(window.moment()),
		});

		this.addCommand({
			id: 'materialize-week-picker',
			name: 'Materialize Week: Pick Week',
			callback: () => this.openWeekPicker(),
		});

		this.addCommand({
			id: 'materialize-month-today',
			name: 'Materialize Month: Current',
			callback: () => this.materializeMonth(window.moment()),
		});

		this.addCommand({
			id: 'materialize-month-picker',
			name: 'Materialize Month: Pick Month',
			callback: () => this.openMonthPicker(),
		});

		this.addCommand({
			id: 'word-count',
			name: 'Word Count: Update Frontmatter',
			callback: () => this.updateWordCount(),
		});

		this.addCommand({
			id: 'lint-note',
			name: 'Lint: Format Frontmatter and Properties',
			callback: () => this.lintNote(),
		});

		this.addCommand({
			id: 'reload-plugin',
			name: 'Reload Plugin',
			callback: async () => {
				const id = this.manifest.id;
				// @ts-ignore
				await this.app.plugins.disablePlugin(id);
				// @ts-ignore
				await this.app.plugins.enablePlugin(id);
				new Notice('Plugin reloaded');
			},
		});

		this.registerEvent(
			this.app.vault.on('create', (file) => this.handleFileCreate(file))
		);

		const debouncedLint = debounce(async (file: TFile) => {
			if (this.settings.lintOnSave && !this.isMaterializing) {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.file?.path === file.path) {
					await this.lintNote(activeView);
				}
			}
		}, 2000, true);

		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					debouncedLint(file);
				}
			})
		);

		this.addSettingTab(new PersonalInternetSettingTab(this.app, this));
	}

	isPathIgnored(path: string): boolean {
		return this.settings.lintIgnoredFolders.some(ignored => {
			if (!ignored) return false;
			return path.startsWith(ignored);
		});
	}

	async updateWordCount(view?: MarkdownView) {
		const targetView = view || this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!targetView || !targetView.file) return;

		if (this.isPathIgnored(targetView.file.path)) {
			return;
		}

		const content = targetView.getViewData();
		// Remove frontmatter for count
		const body = content.replace(/^---\s*\n([\s\S]*?)\n---/, '');
		
		const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
		const segments = segmenter.segment(body);
		let count = 0;
		for (const segment of segments) {
			if (segment.isWordLike) count++;
		}

		this.isMaterializing = true;
		try {
			await this.app.fileManager.processFrontMatter(targetView.file, (fm) => {
				fm['word-count'] = count;
			});
		} finally {
			this.isMaterializing = false;
		}
	}

	async lintNote(view?: MarkdownView) {
		const targetView = view || this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!targetView || !targetView.file) return;

		const file = targetView.file;

		if (this.isPathIgnored(file.path)) {
			return;
		}

		// 1. Update Word Count
		await this.updateWordCount(targetView);

		// 2. Format and Sort Frontmatter
		this.isMaterializing = true;
		try {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				// Handle Date Created
				if (this.settings.lintCreatedKey) {
					const createdValue = fm[this.settings.lintCreatedKey];
					if (!createdValue) {
						fm[this.settings.lintCreatedKey] = window.moment(file.stat.ctime).format('YYYY-MM-DD');
					}
				}

				// Handle Date Modified (Always update on lint)
				if (this.settings.lintModifiedKey) {
					fm[this.settings.lintModifiedKey] = window.moment().format('YYYY-MM-DD');
				}

				// Sort keys based on priority
				const priority = this.settings.lintYamlKeyPriority;
				const sortedFm: any = {};
				
				for (const key of priority) {
					if (key in fm) {
						sortedFm[key] = fm[key];
						delete fm[key];
					}
				}
				
				for (const key of Object.keys(fm)) {
					sortedFm[key] = fm[key];
					delete fm[key];
				}
				
				for (const key of Object.keys(sortedFm)) {
					fm[key] = sortedFm[key];
				}
			});

			// 3. Handle Blank Line After YAML
			if (this.settings.lintBlankLineAfterYaml) {
				const content = await this.app.vault.read(file);
				const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---(\n*)/);
				if (yamlMatch) {
					const currentNewlines = yamlMatch[2];
					if (currentNewlines.length < 2) {
						const updatedContent = content.replace(/^---\s*\n([\s\S]*?)\n---(\n*)/, `---\n$1\n---\n\n`);
						await this.app.vault.modify(file, updatedContent);
					}
				}
			}
		} finally {
			this.isMaterializing = false;
		}

		// 4. Trigger Dataview Rebuild (if plugin exists)
		// @ts-ignore
		if (this.app.plugins.enabledPlugins.has('dataview')) {
			// @ts-ignore
			this.app.commands.executeCommandById('dataview:dataview-rebuild-current-view');
		}
	}

	openDayPicker() {
		new PickerModal(this.app, 'Pick a date', 'date', window.moment().format('YYYY-MM-DD'), (dateStr) => {
			this.materializeDay(window.moment(dateStr, 'YYYY-MM-DD'));
		}).open();
	}

	openWeekPicker() {
		new PickerModal(this.app, 'Pick a week', 'week', window.moment().format('GGGG-[W]WW'), (weekStr) => {
			this.materializeWeek(window.moment(weekStr, 'GGGG-[W]WW'));
		}).open();
	}

	openMonthPicker() {
		new PickerModal(this.app, 'Pick a month', 'month', window.moment().format('YYYY-MM'), (monthStr) => {
			this.materializeMonth(window.moment(monthStr, 'YYYY-MM'));
		}).open();
	}

	async handleFileCreate(file: TAbstractFile) {
		if (this.isMaterializing || !(file instanceof TFile) || file.extension !== 'md') return;

		const parentPath = file.parent?.path || '';
		const fileName = file.basename;

		// 1. Core Folders (Materialize logic)
		if (parentPath === this.settings.dailyFolder) {
			const dateMatch = fileName.match(/^(\d{4}-\d{2}-\d{2})$/);
			if (dateMatch) {
				if (file.stat.size === 0) {
					await this.materializeDay(window.moment(dateMatch[1], 'YYYY-MM-DD'));
				}
			} else {
				await this.app.vault.trash(file, true);
				this.openDayPicker();
			}
			return;
		}

		if (parentPath === this.settings.weeklyFolder) {
			const weekMatch = fileName.match(/^(\d{4}-W\d{2})$/);
			if (weekMatch) {
				if (file.stat.size === 0) {
					this.materializeWeek(window.moment(weekMatch[1], 'GGGG-[W]WW'));
				}
			} else {
				await this.app.vault.trash(file, true);
				this.openWeekPicker();
			}
			return;
		}

		if (parentPath === this.settings.monthlyFolder) {
			const monthMatch = fileName.match(/^(\d{4}-\d{2})$/);
			if (monthMatch) {
				if (file.stat.size === 0) {
					this.materializeMonth(window.moment(monthMatch[1], 'YYYY-MM'));
				}
			} else {
				await this.app.vault.trash(file, true);
				this.openMonthPicker();
			}
			return;
		}

		// 2. Arbitrary Folder Templates
		const mapping = this.settings.folderTemplates.find(ft => ft.folder === parentPath);
		if (mapping && mapping.template) {
			this.isMaterializing = true;
			try {
				const content = await this.applyTemplate(mapping.template, window.moment(), fileName);
				await this.app.vault.modify(file, content);
			} catch (e) {
				new Notice(`Error applying folder template: ${e.message}`);
			} finally {
				this.isMaterializing = false;
			}
		}
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

	async applyTemplate(templatePath: string, date: moment.Moment, fileName: string): Promise<string> {
		if (!templatePath) return '';

		const file = this.app.vault.getAbstractFileByPath(templatePath);
		if (!(file instanceof TFile)) {
			new Notice(`Template file not found: ${templatePath}`);
			return '';
		}

		let content = await this.app.vault.read(file);
		const now = window.moment();

		const replaceTokens = (text: string) => {
			let result = text;
			result = result.replace(/{{datetime:(.*?)}}/g, (match, format) => date.format(format));
			result = result.replace(/{{date}}/g, date.format('YYYY-MM-DD'));
			result = result.replace(/{{time}}/g, date.format('HH:mm'));
			result = result.replace(/{{today}}/g, now.format('YYYY-MM-DD'));
			result = result.replace(/{{now}}/g, now.format('YYYY-MM-DDTHH:mm:ss'));
			return result;
		};

		// 1. Resolve basic tokens (including in YAML)
		content = replaceTokens(content);

		// 2. Handle {{title}} logic
		let title = fileName;
		const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
		if (yamlMatch) {
			const yamlLines = yamlMatch[1].split('\n');
			const titleLine = yamlLines.find(line => line.trim().startsWith('title:'));
			if (titleLine) {
				const titleValue = titleLine.split(':')[1].trim();
				// Remove potential quotes
				title = titleValue.replace(/^["'](.*)["']$/, '$1');
			}
		}

		content = content.replace(/{{title}}/g, title);

		return content;
	}

	async materializeDay(date: moment.Moment) {
		this.isMaterializing = true;
		const dateStr = date.format('YYYY-MM-DD');
		const dailyFolderBase = this.settings.dailyFolder;
		const folderPath = `${dailyFolderBase}/${dateStr}`;
		const filePath = `${dailyFolderBase}/${dateStr}.md`;

		try {
			await this.ensureFolder(folderPath);

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
			new Notice(`Error materializing day: ${e.message}`);
			console.error(e);
		} finally {
			this.isMaterializing = false;
		}
	}

	async materializeWeek(date: moment.Moment) {
		this.isMaterializing = true;
		const weekStr = date.format('GGGG-[W]WW');
		const folderPath = this.settings.weeklyFolder;
		const filePath = `${folderPath}/${weekStr}.md`;

		try {
			await this.ensureFolder(folderPath);

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
			new Notice(`Error materializing week: ${e.message}`);
		} finally {
			this.isMaterializing = false;
		}
	}

	async materializeMonth(date: moment.Moment) {
		this.isMaterializing = true;
		const monthStr = date.format('YYYY-MM');
		const folderPath = this.settings.monthlyFolder;
		const filePath = `${folderPath}/${monthStr}.md`;

		try {
			await this.ensureFolder(folderPath);

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
			new Notice(`Error materializing month: ${e.message}`);
		} finally {
			this.isMaterializing = false;
		}
	}
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
		input.style.width = '100%';
		input.style.marginBottom = '10px';
		input.value = this.initialValue;

		const submit = contentEl.createEl('button', { text: 'Submit' });
		submit.addEventListener('click', () => {
			if (input.value) {
				this.onSubmit(input.value);
				this.close();
			}
		});
		
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				if (input.value) {
					this.onSubmit(input.value);
					this.close();
				}
			}
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
