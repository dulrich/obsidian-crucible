import { App, Modal, Notice, TFile, TextComponent, moment } from 'obsidian';
import { PersonalInternetSettings, Capture } from './types';
import { applyTemplateString } from './utils';

export class CaptureManager {
	app: App;
	settings: PersonalInternetSettings;

	constructor(app: App, settings: PersonalInternetSettings) {
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

		const content = await applyTemplateString(capture.content, now, file.basename, value);
		const existingContent = await this.app.vault.read(file);
		
		let newContent = '';
		
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
				newContent = `${existingContent}\n\n${sectionHeader}\n${content}`;
			}
		} else {
			if (capture.prepend) {
				const yamlMatch = existingContent.match(/^---\s*\n([\s\S]*?)\n---(\n*)/);
				if (yamlMatch) {
					const yamlBlock = yamlMatch[0];
					const body = existingContent.slice(yamlBlock.length);
					newContent = `${yamlBlock}${content}\n${body}`;
				} else {
					newContent = `${content}\n${existingContent}`;
				}
			} else {
				newContent = `${existingContent}\n${content}`;
			}
		}

		await this.app.vault.modify(file, newContent);
		new Notice(`Captured to ${capture.name}`);
	}
}

export class TextInputModal extends Modal {
	title: string;
	onSubmit: (result: string) => void;

	constructor(app: App, title: string, onSubmit: (result: string) => void) {
		super(app);
		this.title = title;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: this.title });

		const input = new TextComponent(contentEl);
		input.inputEl.classList.add('personal-internet-modal-input');
		input.inputEl.focus();

		const submit = contentEl.createEl('button', { text: 'Submit', cls: 'mod-cta' });
		submit.addEventListener('click', () => {
			this.onSubmit(input.getValue());
			this.close();
		});
		
		input.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				this.onSubmit(input.getValue());
				this.close();
			}
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
