import { App, Modal, Notice, TFile, TextComponent, moment } from 'obsidian';
import { CrucibleSettings, Capture } from './types';
import { applyTemplateString, FRONTMATTER_REGEX } from './utils';

export class CaptureManager {
	app: App;
	settings: CrucibleSettings;

	constructor(app: App, settings: CrucibleSettings) {
		this.app = app;
		this.settings = settings;
	}

	async executeCapture(capture: Capture, value: string = '') {
		let targetPath = '';
		const now = moment();

		switch (capture.targetType) {
			case 'daily':
				targetPath = `${this.settings.dailyFolder}/${now.format('YYYY-MM-DD')}.md`;
				break;
			case 'weekly':
				targetPath = `${this.settings.weeklyFolder}/${now.format('GGGG-[W]WW')}.md`;
				break;
			case 'monthly':
				targetPath = `${this.settings.monthlyFolder}/${now.format('YYYY-MM')}.md`;
				break;
			case 'selected':
				targetPath = capture.file;
				break;
		}

		const file = this.app.vault.getAbstractFileByPath(targetPath);
		if (!(file instanceof TFile)) {
			new Notice(`Capture target file not found: ${targetPath}`);
			return;
		}

		const rawContent = await applyTemplateString(capture.content, now, file.basename, value);
		const content = rawContent.trim();
		if (!content) return;

		const existingContent = await this.app.vault.read(file);
		let newContent = '';
		
		try {
			if (capture.targetSection) {
				const sectionHeader = capture.targetSection.trim();
				const lines = existingContent.split('\n');
				const headerIndex = lines.findIndex(line => line.trim() === sectionHeader);

				if (headerIndex !== -1) {
					if (capture.prepend) {
						lines.splice(headerIndex + 1, 0, content);
					} else {
						let endIndex = lines.length;
						for (let i = headerIndex + 1; i < lines.length; i++) {
							const line = lines[i];
							if (line !== undefined && line.trim().startsWith('#')) {
								endIndex = i;
								break;
							}
						}
						lines.splice(endIndex, 0, content);
					}
					newContent = lines.join('\n');
				} else {
					const separator = existingContent.trim() ? "\n\n" : "";
					const header = sectionHeader ? `${sectionHeader}\n` : "";
					newContent = `${existingContent.trimEnd()}${separator}${header}${content}`;
				}
			} else {
				if (capture.prepend) {
					const yamlMatch = existingContent.match(FRONTMATTER_REGEX);
					if (yamlMatch) {
						const yamlBlockWithNewlines = yamlMatch[0];
						const currentNewlines = yamlMatch[2] || "";
						const yamlBlockWithoutNewlines = yamlBlockWithNewlines.slice(0, yamlBlockWithNewlines.length - currentNewlines.length);
						const body = existingContent.slice(yamlBlockWithNewlines.length).trimStart();
						
						newContent = yamlBlockWithoutNewlines.trimEnd() + "\n\n" + content + (body ? "\n\n" + body : "");
					} else {
						const body = existingContent.trimStart();
						newContent = content + (body ? "\n\n" + body : "");
					}
				} else {
					const head = existingContent.trimEnd();
					newContent = (head ? head + "\n\n" : "") + content;
				}
			}

			await this.app.vault.modify(file, newContent);
			new Notice(`Captured to ${capture.name}`);
		} catch (e) {
			new Notice(`Error executing capture: ${(e as Error).message}`);
		}
	}
}

export class TextInputModal extends Modal {
	title: string;
	onSubmit: (result: string) => void;
	onCloseCallback?: () => void;

	constructor(app: App, title: string, onSubmit: (result: string) => void, onClose?: () => void) {
		super(app);
		this.title = title;
		this.onSubmit = onSubmit;
		this.onCloseCallback = onClose;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: this.title });

		const input = new TextComponent(contentEl);
		input.inputEl.classList.add('crucible-modal-input');
		input.inputEl.focus();

		const submit = contentEl.createEl('button', { text: 'Submit', cls: 'mod-cta' });
		submit.addEventListener('click', () => {
			this.onSubmit(input.getValue());
			this.close();
		});
		
		input.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				this.onSubmit(input.getValue());
				this.close();
			}
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		if (this.onCloseCallback) this.onCloseCallback();
	}
}
