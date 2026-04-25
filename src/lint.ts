import { App, MarkdownView, Notice, TFile, moment } from 'obsidian';
import { PersonalInternetSettings } from './types';
import { applyTemplateString } from './utils';

export class Linter {
	app: App;
	settings: PersonalInternetSettings;
	setMaterializing: (state: boolean) => void;

	constructor(app: App, settings: PersonalInternetSettings, setMaterializing: (state: boolean) => void) {
		this.app = app;
		this.settings = settings;
		this.setMaterializing = setMaterializing;
	}

	isPathIgnored(path: string): boolean {
		return this.settings.lintIgnoredFolders.some(ignored => {
			if (!ignored) return false;
			return path.startsWith(ignored);
		});
	}

	async calculateWordCount(view: MarkdownView): Promise<number> {
		const content = view.getViewData();
		const body = content.replace(/^---\s*\n([\s\S]*?)\n---/, '');
		
		// @ts-ignore - Segmenter is available in Obsidian's environment
		if (typeof Intl.Segmenter === 'function') {
			// @ts-ignore
			const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
			const segments = segmenter.segment(body);
			let count = 0;
			for (const segment of segments) {
				if (segment.isWordLike) count++;
			}
			return count;
		} else {
			return body.split(/\s+/).filter(word => word.length > 0).length;
		}
	}

	async lintNote(view?: MarkdownView) {
		const targetView = view || this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!targetView || !targetView.file) return;

		const file = targetView.file;
		if (this.isPathIgnored(file.path)) return;

		const wordCount = await this.calculateWordCount(targetView);
		const insertYaml: Record<string, string> = {};
		
		if (this.settings.lintFrontmatterInsert) {
			const processedInsert = await applyTemplateString(this.settings.lintFrontmatterInsert, moment(), file.basename);
			const lines = processedInsert.split('\n');
			for (const line of lines) {
				const parts = line.split(':');
				if (parts.length >= 2) {
					const key = parts[0]?.trim();
					const value = parts.slice(1).join(':').trim();
					if (key) insertYaml[key] = value;
				}
			}
		}

		const todayStr = moment().format('YYYY-MM-DD');
		const createdStr = moment(file.stat.ctime).format('YYYY-MM-DD');

		this.setMaterializing(true);
		try {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				for (const [key, value] of Object.entries(insertYaml)) {
					if (!fm[key]) fm[key] = value;
				}
				if (this.settings.lintCreatedKey && !fm[this.settings.lintCreatedKey]) {
					fm[this.settings.lintCreatedKey] = createdStr;
				}
				if (this.settings.lintModifiedKey) fm[this.settings.lintModifiedKey] = todayStr;
				fm['word-count'] = wordCount;

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

			if (this.settings.lintBlankLineAfterYaml) {
				const content = await this.app.vault.read(file);
				const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---(\n*)/);
				if (yamlMatch) {
					const currentNewlines = yamlMatch[2] || "";
					if (currentNewlines.length < 2) {
						const updatedContent = content.replace(/^---\s*\n([\s\S]*?)\n---(\n*)/, `---\n$1\n---\n\n`);
						await this.app.vault.modify(file, updatedContent);
					}
				}
			}
		} catch (e) {
			new Notice(`Error during lint: ${(e as Error).message}`);
		} finally {
			this.setMaterializing(false);
		}

		// @ts-ignore
		if (this.app.plugins.enabledPlugins.has('dataview')) {
			// @ts-ignore
			this.app.commands.executeCommandById('dataview:dataview-rebuild-current-view');
		}

		new Notice('Note linted');
	}
}
