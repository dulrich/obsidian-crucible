import { App, Plugin, TFile, MarkdownView, Notice, debounce, TAbstractFile, Modal } from 'obsidian';
import { PersonalInternetSettingTab } from "./settings";
import { PersonalInternetSettings, DEFAULT_SETTINGS } from "./types";
import { Materializer } from "./materialize";
import { Linter } from "./lint";
import { CaptureManager, TextInputModal } from "./captures";
import { TableOfContentsUI } from "./toc";
import { applyTemplateString } from './utils';

interface AppWithPlugins extends App {
	plugins: {
		disablePlugin(id: string): Promise<void>;
		enablePlugin(id: string): Promise<void>;
	};
}

export default class PersonalInternetPlugin extends Plugin {
	settings: PersonalInternetSettings;
	private isMaterializing = false;
	private materializer: Materializer;
	private linter: Linter;
	private captureManager: CaptureManager;
	private tocComponent: TableOfContentsUI | null = null;

	async onload() {
		await this.loadSettings();

		this.materializer = new Materializer(this.app, this.settings, (state: boolean) => { this.isMaterializing = state; });
		this.linter = new Linter(this.app, this.settings, (state: boolean) => { this.isMaterializing = state; });
		this.captureManager = new CaptureManager(this.app, this.settings);

		// --- Commands ---
		this.addCommand({ id: 'materialize-day-today', name: 'Materialize day: today', callback: () => { void this.materializer.materializeDay(window.moment()); } });
		this.addCommand({ id: 'materialize-day-picker', name: 'Materialize day: pick date', callback: () => { this.openDayPicker(); } });
		this.addCommand({ id: 'materialize-week-today', name: 'Materialize week: current', callback: () => { void this.materializer.materializeWeek(window.moment()); } });
		this.addCommand({ id: 'materialize-week-picker', name: 'Materialize week: pick week', callback: () => { this.openWeekPicker(); } });
		this.addCommand({ id: 'materialize-month-today', name: 'Materialize month: current', callback: () => { void this.materializer.materializeMonth(window.moment()); } });
		this.addCommand({ id: 'materialize-month-picker', name: 'Materialize month: pick month', callback: () => { this.openMonthPicker(); } });

		this.addCommand({ id: 'word-count', name: 'Word count: update frontmatter', callback: () => { void this.linter.lintNote(); } });
		this.addCommand({ id: 'lint-note', name: 'Lint: format frontmatter and properties', callback: () => { void this.linter.lintNote(); } });

		this.addCommand({
			id: 'reload-plugin',
			name: 'Reload plugin',
			callback: async () => {
				const plugins = (this.app as AppWithPlugins).plugins;
				if (plugins) {
					await plugins.disablePlugin(this.manifest.id);
					await plugins.enablePlugin(this.manifest.id);
					new Notice('Plugin reloaded');
				}
			},
		});

		// --- Events ---
		this.registerEvent(this.app.vault.on('create', (file) => { void this.handleFileCreate(file); }));

		const debouncedLint = debounce(async (file: TFile) => {
			if (this.settings.lintOnSave && !this.isMaterializing) {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.file?.path === file.path) {
					await this.linter.lintNote(activeView);
				}
			}
		}, 2000, true);

		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file instanceof TFile && file.extension === 'md') debouncedLint(file);
		}));

		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshToC()));
		this.registerEvent(this.app.metadataCache.on('changed', () => this.refreshToC()));

		this.registerShortcuts();
		this.registerCaptures();
		this.addSettingTab(new PersonalInternetSettingTab(this.app, this));
		
		this.refreshToC();
	}

	onunload() {
		if (this.tocComponent) this.tocComponent.unload();
	}

	async loadSettings() { 
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<PersonalInternetSettings>); 
	}
	
	async saveSettings() { 
		await this.saveData(this.settings); 
	}

	refreshToC() {
		if (this.tocComponent) { this.tocComponent.unload(); this.tocComponent = null; }
		if (!this.settings.showToC) return;
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView) {
			this.tocComponent = new TableOfContentsUI(this.app, activeView, this.settings.tocPosition, this.settings.tocCollapseBehavior);
			this.tocComponent.load();
		}
	}

	registerShortcuts() {
		this.settings.shortcuts.forEach((shortcut, index) => {
			if (!shortcut.name || !shortcut.file) return;
			this.addCommand({
				id: `shortcut-${index}`,
				name: `Shortcut: ${shortcut.name}`,
				callback: async () => {
					const file = this.app.vault.getAbstractFileByPath(shortcut.file);
					if (file instanceof TFile) await this.app.workspace.getLeaf().openFile(file);
				}
			});
		});
	}

	registerCaptures() {
		this.settings.captures.forEach((capture, index) => {
			if (!capture.name) return;
			this.addCommand({
				id: `capture-${index}`,
				name: `Capture: ${capture.name}`,
				callback: async () => {
					if (capture.content.includes('{{value}}')) {
						new TextInputModal(this.app, `Capture: ${capture.name}`, (value) => {
							void this.captureManager.executeCapture(capture, value);
						}).open();
					} else {
						void this.captureManager.executeCapture(capture);
					}
				}
			});
		});
	}

	openDayPicker() {
		new PickerModal(this.app, 'Pick a date', 'date', window.moment().format('YYYY-MM-DD'), (dateStr) => {
			void this.materializer.materializeDay(window.moment(dateStr, 'YYYY-MM-DD'));
		}).open();
	}

	openWeekPicker() {
		new PickerModal(this.app, 'Pick a week', 'week', window.moment().format('GGGG-[W]WW'), (weekStr) => {
			void this.materializer.materializeWeek(window.moment(weekStr, 'GGGG-[W]WW'));
		}).open();
	}

	openMonthPicker() {
		new PickerModal(this.app, 'Pick a month', 'month', window.moment().format('YYYY-MM'), (monthStr) => {
			void this.materializer.materializeMonth(window.moment(monthStr, 'YYYY-MM'));
		}).open();
	}

	async handleFileCreate(file: TAbstractFile) {
		if (this.isMaterializing || !(file instanceof TFile) || file.extension !== 'md') return;

		const parentPath = file.parent?.path || '';
		const fileName = file.basename;

		if (parentPath === this.settings.dailyFolder) {
			const dateMatch = fileName.match(/^(\d{4}-\d{2}-\d{2})$/);
			if (dateMatch) {
				if (file.stat.size === 0) void this.materializer.materializeDay(window.moment(dateMatch[1], 'YYYY-MM-DD'));
			} else {
				await this.app.fileManager.trashFile(file);
				this.openDayPicker();
			}
			return;
		}

		if (parentPath === this.settings.weeklyFolder) {
			const weekMatch = fileName.match(/^(\d{4}-W\d{2})$/);
			if (weekMatch) {
				if (file.stat.size === 0) void this.materializer.materializeWeek(window.moment(weekMatch[1], 'GGGG-[W]WW'));
			} else {
				await this.app.fileManager.trashFile(file);
				this.openWeekPicker();
			}
			return;
		}

		if (parentPath === this.settings.monthlyFolder) {
			const monthMatch = fileName.match(/^(\d{4}-\d{2})$/);
			if (monthMatch) {
				if (file.stat.size === 0) void this.materializer.materializeMonth(window.moment(monthMatch[1], 'YYYY-MM'));
			} else {
				await this.app.fileManager.trashFile(file);
				this.openMonthPicker();
			}
			return;
		}

		const mapping = this.settings.folderTemplates.find(ft => ft.folder === parentPath);
		if (mapping && mapping.template) {
			this.isMaterializing = true;
			try {
				const templateFile = this.app.vault.getAbstractFileByPath(mapping.template);
				if (templateFile instanceof TFile) {
					const templateContent = await this.app.vault.read(templateFile);
					const content = await applyTemplateString(templateContent, window.moment(), fileName);
					await this.app.vault.modify(file, content);
				}
			} catch (e) {
				new Notice(`Error applying folder template: ${(e as Error).message}`);
			} finally {
				this.isMaterializing = false;
			}
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
		input.classList.add('personal-internet-picker-input');
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
