import { App, Modal, Notice, TFile, TextComponent, moment } from 'obsidian';
import { CrucibleSettings, Capture } from './types';
import { applyTemplateString, FRONTMATTER_REGEX } from './utils';
import { findSectionRange, insertIntoSection } from './sections';
import { getPeriodConfigByTarget, periodDisabledMessage } from './periods';

export interface CaptureExecutionContext {
	sourceSectionHeader?: string | null;
	sourceFile?: TFile | null;
}

export class CaptureManager {
	app: App;
	settings: CrucibleSettings;
	setMaterializing: (state: boolean) => void;

	constructor(app: App, settings: CrucibleSettings, setMaterializing: (state: boolean) => void) {
		this.app = app;
		this.settings = settings;
		this.setMaterializing = setMaterializing;
	}

	async executeCapture(
		capture: Capture,
		value: string = '',
		targetFile?: TFile,
		context?: CaptureExecutionContext,
	): Promise<boolean> {
		this.setMaterializing(true);
		try {
			let targetPath = '';
			const now = moment();
			const periodConfig = getPeriodConfigByTarget(capture.targetType, this.settings);
			if (periodConfig && !periodConfig.enabled) {
				new Notice(periodDisabledMessage(periodConfig.id));
				return false;
			}

			switch (capture.targetType) {
				case 'daily':
					targetPath = `${periodConfig!.folder}/${now.format(periodConfig!.dateFormat)}.md`;
					break;
				case 'weekly':
					targetPath = `${periodConfig!.folder}/${now.format(periodConfig!.dateFormat)}.md`;
					break;
				case 'monthly':
					targetPath = `${periodConfig!.folder}/${now.format(periodConfig!.dateFormat)}.md`;
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

			const rawContent = await applyTemplateString(
				capture.content,
				now,
				file.basename,
				value,
				getCaptureTemplateTokens(context),
			);
			const contentRaw = rawContent.trim();
			if (!contentRaw) return true;

			// Strip front matter from the incoming content if we are going to preserve the existing one
			// or if we are inserting into a section (where FM is invalid anyway).
			const content = contentRaw.replace(FRONTMATTER_REGEX, '').trim();

			// A capture whose resolved content is YAML-only (e.g. a template that only sets
			// frontmatter properties) passes the guard above — contentRaw is non-empty — but
			// strips to an empty body here. For writeMode 'replace' that would otherwise
			// blank the note/section body: the whole-note branch below would write just the
			// retained frontmatter, and insertIntoSection's 'replace' mode splices an empty
			// payload into the section. Treat that as a no-op success, the same shape as the
			// guard above. Other write modes (prepend/append) keep existing behavior — they
			// can't destroy content that's already there.
			if (!content && capture.writeMode === 'replace') return true;

			const existingContent = await this.app.vault.read(file);
			const writeMode = capture.writeMode;
			const targetSection = resolveTargetSection(capture, existingContent, context);
			let newContent = '';

			if (targetSection) {
				newContent = insertIntoSection(existingContent, targetSection, content, writeMode);
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

function getCaptureTemplateTokens(context?: CaptureExecutionContext): Record<string, string> {
	const sourceFile = context?.sourceFile;
	if (!sourceFile) {
		return {
			source_link: '',
			source_path: '',
			source_title: '',
		};
	}

	const sourcePath = sourceFile.path.replace(/\.md$/i, '');
	const sourceTitle = sourceFile.basename;
	return {
		source_link: `[[${sourcePath}|${sourceTitle}]]`,
		source_path: sourcePath,
		source_title: sourceTitle,
	};
}

function resolveTargetSection(
	capture: Capture,
	targetContent: string,
	context?: CaptureExecutionContext,
): string {
	const fallbackSection = (capture.targetSection ?? '').trim();
	if ((capture.targetSectionMode ?? 'fixed') !== 'source') return fallbackSection;

	const sourceSection = (context?.sourceSectionHeader ?? '').trim();
	if (sourceSection && findSectionRange(targetContent, sourceSection)) return sourceSection;

	return fallbackSection;
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
