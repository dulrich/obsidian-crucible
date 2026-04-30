import { App, Modal, Notice, TFile, TextComponent, moment } from 'obsidian';
import { CrucibleSettings, Capture } from './types';
import { applyTemplateString, FRONTMATTER_REGEX } from './utils';

export class CaptureManager {
	app: App;
	settings: CrucibleSettings;
	setMaterializing: (state: boolean) => void;

	constructor(app: App, settings: CrucibleSettings, setMaterializing: (state: boolean) => void) {
		this.app = app;
		this.settings = settings;
		this.setMaterializing = setMaterializing;
	}

	async executeCapture(capture: Capture, value: string = '', targetFile?: TFile): Promise<boolean> {
		this.setMaterializing(true);
		try {
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
				case 'active': {
					const activeFile = targetFile ?? this.app.workspace.getActiveFile();
					if (!activeFile) {
						new Notice('Capture target requires an active note.');
						return false;
					}
					targetPath = activeFile.path;
					break;
				}
			}

			const file = this.app.vault.getAbstractFileByPath(targetPath);
			if (!(file instanceof TFile)) {
				new Notice(`Capture target file not found: ${targetPath}`);
				return false;
			}

			const rawContent = await applyTemplateString(capture.content, now, file.basename, value);
			const contentRaw = rawContent.trim();
			if (!contentRaw) return true;

			// Strip front matter from the incoming content if we are going to preserve the existing one
			// or if we are inserting into a section (where FM is invalid anyway).
			const content = contentRaw.replace(FRONTMATTER_REGEX, '').trim();

			const existingContent = await this.app.vault.read(file);
			const writeMode = capture.writeMode;
			let newContent = '';

			if (capture.targetSection) {
				const sectionHeader = capture.targetSection.trim();
				const lines = existingContent.split('\n');
				const headerIndex = lines.findIndex(line => line.trim() === sectionHeader);

				if (headerIndex !== -1) {
					// Find the end of this section (next header / horizontal rule, or EOF)
					let endIndex = lines.length;
					for (let i = headerIndex + 1; i < lines.length; i++) {
						const line = lines[i];
						if (line !== undefined && (line.trim().startsWith('#') || line.trim() === '---')) {
							endIndex = i;
							break;
						}
					}

					if (writeMode === 'replace') {
						lines.splice(headerIndex + 1, endIndex - (headerIndex + 1), content);
					} else if (writeMode === 'prepend') {
						lines.splice(headerIndex + 1, 0, content);
					} else {
						let insertIndex = endIndex;
						for (let i = endIndex - 1; i > headerIndex; i--) {
							const line = lines[i];
							if (line !== undefined && line.trim() !== '') {
								insertIndex = i + 1;
								break;
							}
						}
						if (insertIndex === endIndex && insertIndex > headerIndex + 1) {
							// If we didn't find any non-empty lines, insert right after header
							// or at the top of the blank space.
							insertIndex = headerIndex + 1;
						}

						lines.splice(insertIndex, 0, content);
					}
					newContent = lines.join('\n');
				} else {
					const separator = existingContent.trim() ? "\n\n" : "";
					const header = sectionHeader ? `${sectionHeader}\n` : "";
					newContent = `${existingContent.trimEnd()}${separator}${header}${content}`;
				}
			} else {
				const yamlMatch = existingContent.match(FRONTMATTER_REGEX);
				if (writeMode === 'replace') {
					if (yamlMatch) {
						const yamlBlockWithNewlines = yamlMatch[0];
						const currentNewlines = yamlMatch[2] || "";
						const yamlBlockWithoutNewlines = yamlBlockWithNewlines.slice(0, yamlBlockWithNewlines.length - currentNewlines.length);
						newContent = yamlBlockWithoutNewlines.trimEnd() + "\n\n" + content;
					} else {
						// No existing FM, so we can use the raw content (including its FM if it had any)
						newContent = contentRaw;
					}
				} else if (writeMode === 'prepend') {
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
			return true;
		} catch (e) {
			new Notice(`Error executing capture: ${(e as Error).message}`);
			return false;
		} finally {
			this.setMaterializing(false);
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
