import { App, MarkdownView, Notice, moment, TFile, TFolder } from 'obsidian';
import { CrucibleSettings } from './types';
import { applyTemplateString, FRONTMATTER_REGEX } from './utils';
import { sortFrontmatterProperties, updateFrontmatter, upsertFrontmatterProperty, upsertFrontmatterPropertyIfEmpty, withMaterializing } from './frontmatter';
import { extractVideoIdFromUrl } from './orchestration/utils/youtube';

const YT_EMBED_RE = /^([ \t]*\r?\n)*[ \t]*!\[\]\(([^)\s]+)\)[ \t]*\r?\n/;
const TRANSCRIPT_HEADER_RE = /^([ \t]*\r?\n)*[ \t]*##[ \t]+Transcript[ \t]*\r?\n/;
const TIMESTAMP_PARA_RE = /^\*\*\d+:\d+\*\*/;
const TIMESTAMP_PREFIX_RE = /^\*\*\d+:\d+\*\*[ \t·•|–—-]*/;
const BRACKET_ANNOTATION_RE = /\\?\[[A-Za-z][A-Za-z ]*\\?\](?!\()/g;
const PARAGRAPH_SPLIT_RE = /\r?\n[ \t]*\r?\n\s*/;

function cleanTranscriptParagraph(para: string): string {
	let out = para.replace(TIMESTAMP_PREFIX_RE, '');
	out = out.replace(BRACKET_ANNOTATION_RE, '');
	return out.replace(/\s+/g, ' ').trim();
}

export function cleanupYoutubeTranscript(content: string): string {
	const fmMatch = content.match(FRONTMATTER_REGEX);
	const fmText = fmMatch ? fmMatch[0] : '';
	const body = fmMatch ? content.slice(fmMatch[0].length) : content;

	const embedMatch = body.match(YT_EMBED_RE);
	if (!embedMatch) return content;
	const embedUrl = embedMatch[2];
	if (!embedUrl || !extractVideoIdFromUrl(embedUrl)) return content;

	const afterEmbed = body.slice(embedMatch[0].length);
	const headerMatch = afterEmbed.match(TRANSCRIPT_HEADER_RE);
	if (!headerMatch) return content;

	const afterHeader = afterEmbed.slice(headerMatch[0].length).replace(/^([ \t]*\r?\n)+/, '');
	if (!TIMESTAMP_PARA_RE.test(afterHeader.trimStart())) return content;

	const paragraphs = afterHeader.split(PARAGRAPH_SPLIT_RE);
	let firstNonTranscript = paragraphs.length;
	for (let i = 0; i < paragraphs.length; i++) {
		const p = paragraphs[i] ?? '';
		if (!TIMESTAMP_PARA_RE.test(p.trimStart())) {
			firstNonTranscript = i;
			break;
		}
	}
	if (firstNonTranscript === 0) return content;

	const cleanedTranscript = paragraphs
		.slice(0, firstNonTranscript)
		.map(cleanTranscriptParagraph)
		.filter(p => p.length > 0)
		.join('\n\n');

	const trailing = paragraphs.slice(firstNonTranscript).join('\n\n').trimEnd();

	let result = cleanedTranscript;
	if (trailing.length > 0) result += '\n\n' + trailing;
	return fmText + result + '\n';
}

interface Segmenter {
	segment(text: string): Iterable<{ isWordLike: boolean }>;
}

interface IntlWithSegmenter {
	Segmenter: new (locale?: string, options?: { granularity: string }) => Segmenter;
}

export class Linter {
	app: App;
	settings: CrucibleSettings;
	setMaterializing: (state: boolean) => void;

	constructor(app: App, settings: CrucibleSettings, setMaterializing: (state: boolean) => void) {
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

	calculateWordCount(content: string): number {
		const body = content.replace(FRONTMATTER_REGEX, '');
		
		const intl = Intl as unknown as IntlWithSegmenter;
		if (typeof intl.Segmenter === 'function') {
			const segmenter = new intl.Segmenter(undefined, { granularity: 'word' });
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

	async lintNote(viewOrFile?: MarkdownView | TFile): Promise<boolean> {
		if (viewOrFile instanceof TFile) {
			return await this.lintFile(viewOrFile);
		}
		const targetView = viewOrFile || this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!targetView || !targetView.file) return false;

		return await this.lintFile(targetView.file);
	}

	async lintVault(): Promise<boolean> {
		return await this.lintFolder(this.app.vault.getRoot());
	}

	async lintFolder(folder: TFolder): Promise<boolean> {
		const files: TFile[] = [];
		const recursiveGetFiles = (currentFolder: TFolder) => {
			if (this.isPathIgnored(currentFolder.path)) return;
			for (const child of currentFolder.children) {
				if (child instanceof TFile && child.extension === 'md') {
					if (!this.isPathIgnored(child.path)) {
						files.push(child);
					}
				} else if (child instanceof TFolder) {
					recursiveGetFiles(child);
				}
			}
		};

		recursiveGetFiles(folder);

		if (files.length === 0) {
			new Notice('No Markdown files found to lint in this folder');
			return true;
		}

		const notice = new Notice(`Linting ${files.length} notes...`, 0);
		let count = 0;
		let allSuccess = true;

		for (const file of files) {
			const success = await this.lintFile(file, true);
			if (!success) allSuccess = false;
			count++;
			if (count % 10 === 0) {
				notice.setMessage(`Linting ${files.length} notes... (${count}/${files.length})`);
			}
		}

		notice.hide();
		new Notice(`Finished linting ${count} notes`);
		return allSuccess;
	}

	async lintFile(file: TFile, silent: boolean = false): Promise<boolean> {
		if (this.isPathIgnored(file.path)) return true;

		const content = await this.app.vault.read(file);
		const wordCount = this.calculateWordCount(content);
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

		try {
			await withMaterializing(this.setMaterializing, async () => {
				await updateFrontmatter(this.app, file, (fm) => {
					for (const [key, value] of Object.entries(insertYaml)) {
						upsertFrontmatterPropertyIfEmpty(fm, key, value);
					}
					upsertFrontmatterPropertyIfEmpty(fm, this.settings.lintCreatedKey, createdStr);
					upsertFrontmatterPropertyIfEmpty(fm, 'title', file.basename);
					if (this.settings.lintModifiedKey) upsertFrontmatterProperty(fm, this.settings.lintModifiedKey, todayStr);
					upsertFrontmatterProperty(fm, 'word-count', wordCount);
					sortFrontmatterProperties(fm, this.settings.lintYamlKeyPriority);
				});

				if (this.settings.lintBlankLineAfterYaml) {
					const contentAfterFM = await this.app.vault.read(file);
					const yamlMatch = contentAfterFM.match(FRONTMATTER_REGEX);
					if (yamlMatch) {
						const yamlBlockWithNewlines = yamlMatch[0];
						const currentNewlines = yamlMatch[2] || "";
						
						if (currentNewlines.length !== 2 || currentNewlines !== "\n\n") {
							const yamlBlockWithoutNewlines = yamlBlockWithNewlines.slice(0, yamlBlockWithNewlines.length - currentNewlines.length);
							const body = contentAfterFM.slice(yamlBlockWithNewlines.length);
							const updatedContent = yamlBlockWithoutNewlines.trimEnd() + "\n\n" + body.trimStart();
							
							if (updatedContent !== contentAfterFM) {
								await this.app.vault.modify(file, updatedContent);
							}
						}
					}
				}
			});
		} catch (e) {
			if (!silent) new Notice(`Error during lint (${file.path}): ${(e as Error).message}`);
			console.error(`Error during lint (${file.path}):`, e);
			return false;
		}

		if (!silent) {
			const plugins = this.app.plugins;
			if (plugins && plugins.enabledPlugins.has('dataview')) {
				const commands = this.app.commands;
				if (commands) {
					commands.executeCommandById('dataview:dataview-rebuild-current-view');
				}
			}
			new Notice('Note linted');
		}
		return true;
	}

	async cleanupTranscriptInFile(viewOrFile?: MarkdownView | TFile, silent: boolean = false): Promise<boolean> {
		let resolved: TFile | undefined;
		if (viewOrFile instanceof TFile) {
			resolved = viewOrFile;
		} else {
			const targetView = viewOrFile || this.app.workspace.getActiveViewOfType(MarkdownView);
			if (targetView && targetView.file) resolved = targetView.file;
		}
		if (!resolved) return false;
		const file: TFile = resolved;
		if (this.isPathIgnored(file.path)) return true;

		try {
			const content = await this.app.vault.read(file);
			const cleaned = cleanupYoutubeTranscript(content);
			if (cleaned === content) {
				if (!silent) new Notice('Transcript cleanup: no changes');
				return true;
			}
			await withMaterializing(this.setMaterializing, async () => {
				await this.app.vault.modify(file, cleaned);
			});
			if (!silent) new Notice('Transcript cleaned');
			return true;
		} catch (e) {
			if (!silent) new Notice(`Transcript cleanup failed (${file.path}): ${(e as Error).message}`);
			console.error(`Transcript cleanup failed (${file.path}):`, e);
			return false;
		}
	}
}
