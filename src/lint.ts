import { App, MarkdownView, Notice, moment, TFile, TFolder } from 'obsidian';
import { CrucibleSettings } from './types';
import { applyTemplateString, FRONTMATTER_REGEX } from './utils';
import { sortFrontmatterProperties, updateFrontmatter, upsertFrontmatterProperty, upsertFrontmatterPropertyIfEmpty, withMaterializing } from './frontmatter';
import { extractVideoIdFromUrl } from './orchestration/utils/youtube';
import { postIdFromUrl } from './orchestration/utils/blogs';
import { logError, logWarn } from './log';
import { NoteLockManager, withOptionalNoteLock } from './orchestration/NoteLockManager';
import { isPathExcluded } from './exclusions';

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

function deriveSourceIdProperties(fm: Record<string, unknown>): void {
	const raw = fm['source'];
	if (typeof raw !== 'string') return;
	const source = raw.trim();
	if (!source) return;

	const videoId = extractVideoIdFromUrl(source);
	if (videoId) {
		upsertFrontmatterPropertyIfEmpty(fm, 'yt-video-id', videoId);
		return;
	}

	if (!/^https?:\/\//i.test(source)) return;
	try {
		new URL(source);
	} catch {
		return;
	}
	upsertFrontmatterPropertyIfEmpty(fm, 'post-id', postIdFromUrl(source));
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

const FENCED_CODE_RE = /(`{3,}|~{3,})[\s\S]*?\1/g;
const INLINE_CODE_RE = /`[^`]*`/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const HTML_BLOCK_RE = /<(svg|script|style)\b[\s\S]*?<\/\1>/gi;
const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const WIKI_EMBED_RE = /!\[\[[^\]]*\]\]/g;
const MD_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const WIKILINK_RE = /\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g;
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

// Reduce note body markup to readable prose so word counts reflect what a reader sees.
// Embedded charts (inline <svg>), code, and embed/link plumbing would otherwise spam the
// segmenter with tokens. Order matters: outer/greedy constructs are removed before the
// inner markup they contain. See the word-count quirk in AGENTS.md before changing.
export function stripNonProseContent(body: string): string {
	return body
		.replace(FENCED_CODE_RE, ' ')
		.replace(INLINE_CODE_RE, ' ')
		.replace(HTML_COMMENT_RE, ' ')
		.replace(HTML_BLOCK_RE, ' ')
		.replace(MD_IMAGE_RE, ' ')
		.replace(WIKI_EMBED_RE, ' ')
		.replace(MD_LINK_RE, '$1')
		.replace(WIKILINK_RE, (_m, target: string, alias?: string) => alias ?? target)
		.replace(HTML_TAG_RE, ' ');
}

export function calculateWordCount(content: string): number {
	const body = stripNonProseContent(content.replace(FRONTMATTER_REGEX, ''));

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

export class Linter {
	app: App;
	settings: CrucibleSettings;
	setMaterializing: (state: boolean) => void;
	private noteLocks?: NoteLockManager;

	constructor(app: App, settings: CrucibleSettings, setMaterializing: (state: boolean) => void, noteLocks?: NoteLockManager) {
		this.app = app;
		this.settings = settings;
		this.setMaterializing = setMaterializing;
		this.noteLocks = noteLocks;
	}

	isPathIgnored(path: string): boolean {
		return isPathExcluded(this.settings, path, 'lint');
	}

	calculateWordCount(content: string): number {
		return calculateWordCount(content);
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
		if (this.isPathIgnored(file.path)) {
			logWarn('lint', 'skipped — path is lint-excluded:', file.path);
			return true;
		}

		// Whether this pass actually changed the file on disk — derived below, inside the
		// locked section, by re-reading after every write and comparing against the content
		// this pass started from. This is the cheapest honest check available here: lintFile
		// already reads the file once for calculateWordCount, so one extra vault.read() after
		// the writes costs little, and a raw content comparison can't be fooled the way an
		// mtime comparison could — Obsidian's mtime granularity/update timing isn't guaranteed
		// fine enough to distinguish two lint passes seconds apart. Threading a "did we write"
		// boolean back out of updateFrontmatter/vault.process instead would mean changing
		// updateFrontmatter's contract, which is a cross-cutting chokepoint owned outside this
		// change — so the signal is derived locally, from the bytes, instead.
		let modified = false;
		try {
			await withOptionalNoteLock(this.noteLocks, file.path, 'lint', () => withMaterializing(this.setMaterializing, async () => {
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
				await updateFrontmatter(this.app, file, (fm) => {
					for (const [key, value] of Object.entries(insertYaml)) {
						upsertFrontmatterPropertyIfEmpty(fm, key, value);
					}
					upsertFrontmatterPropertyIfEmpty(fm, this.settings.lintCreatedKey, createdStr);
					upsertFrontmatterPropertyIfEmpty(fm, 'title', file.basename);
					if (this.settings.lintModifiedKey) upsertFrontmatterProperty(fm, this.settings.lintModifiedKey, todayStr);
					upsertFrontmatterProperty(fm, 'word-count', wordCount);
					deriveSourceIdProperties(fm);
					sortFrontmatterProperties(fm, this.settings.lintYamlKeyPriority);
				});

				if (this.settings.lintBlankLineAfterYaml) {
					await this.app.vault.process(file, (contentAfterFM) => {
						const yamlMatch = contentAfterFM.match(FRONTMATTER_REGEX);
						if (!yamlMatch) return contentAfterFM;
						const yamlBlockWithNewlines = yamlMatch[0];
						const currentNewlines = yamlMatch[2] || "";
						if (currentNewlines === "\n\n") return contentAfterFM;
						const yamlBlockWithoutNewlines = yamlBlockWithNewlines.slice(0, yamlBlockWithNewlines.length - currentNewlines.length);
						const body = contentAfterFM.slice(yamlBlockWithNewlines.length);
						return yamlBlockWithoutNewlines.trimEnd() + "\n\n" + body.trimStart();
					});
				}

				const finalContent = await this.app.vault.read(file);
				modified = finalContent !== content;
			}));
		} catch (e) {
			if (!silent) new Notice(`Error during lint (${file.path}): ${(e as Error).message}`);
			logError(`lint failed (${file.path})`, e);
			return false;
		}

		if (!silent) {
			const plugins = this.app.plugins;
			// Only yank the current dataview view when this pass actually wrote something —
			// firing it unconditionally re-rendered dataview on every manual/chain lint even
			// when nothing changed.
			if (modified && plugins && plugins.enabledPlugins.has('dataview')) {
				const commands = this.app.commands;
				if (commands) {
					commands.executeCommandById('dataview:dataview-rebuild-current-view');
				}
			}
			new Notice('Note linted');
		}
		return true;
	}

	async renamePropertyInVault(oldKey: string, newKey: string): Promise<boolean> {
		const oldK = oldKey.trim();
		const newK = newKey.trim();
		if (!oldK || !newK) {
			new Notice('Property rename: both old and new key names are required');
			return false;
		}
		if (oldK === newK) {
			new Notice('Property rename: old and new keys are identical');
			return false;
		}

		const files = this.app.vault.getMarkdownFiles().filter(f => !this.isPathIgnored(f.path));
		if (files.length === 0) {
			new Notice('No Markdown files to scan');
			return true;
		}

		const notice = new Notice(`Renaming property in ${files.length} notes...`, 0);
		let scanned = 0;
		let renamed = 0;
		let failed = 0;

		try {
			await withMaterializing(this.setMaterializing, async () => {
				for (const file of files) {
					try {
						let didRename = false;
						await updateFrontmatter(this.app, file, (fm) => {
							if (!(oldK in fm)) return;
							const value = fm[oldK];
							delete fm[oldK];
							if (!(newK in fm) || fm[newK] === undefined || fm[newK] === null || fm[newK] === '') {
								fm[newK] = value;
							}
							didRename = true;
						});
						if (didRename) renamed++;
					} catch (e) {
						failed++;
						logError(`property rename failed (${file.path})`, e);
					}
					scanned++;
					if (scanned % 25 === 0) {
						notice.setMessage(`Renaming property... (${scanned}/${files.length}, renamed ${renamed})`);
					}
				}
			});
		} finally {
			notice.hide();
		}

		const summary = failed > 0
			? `Renamed ${renamed} of ${files.length} notes (${failed} failed)`
			: `Renamed ${renamed} of ${files.length} notes`;
		new Notice(summary);
		return failed === 0;
	}

	async removePropertyFromVault(key: string): Promise<boolean> {
		const k = key.trim();
		if (!k) {
			new Notice('Property remove: a property name is required');
			return false;
		}

		const files = this.app.vault.getMarkdownFiles().filter(f => !this.isPathIgnored(f.path));
		if (files.length === 0) {
			new Notice('No Markdown files to scan');
			return true;
		}

		const notice = new Notice(`Removing property from ${files.length} notes...`, 0);
		let scanned = 0;
		let removed = 0;
		let failed = 0;

		try {
			await withMaterializing(this.setMaterializing, async () => {
				for (const file of files) {
					try {
						let didRemove = false;
						await updateFrontmatter(this.app, file, (fm) => {
							if (!(k in fm)) return;
							delete fm[k];
							didRemove = true;
						});
						if (didRemove) removed++;
					} catch (e) {
						failed++;
						logError(`property remove failed (${file.path})`, e);
					}
					scanned++;
					if (scanned % 25 === 0) {
						notice.setMessage(`Removing property... (${scanned}/${files.length}, removed ${removed})`);
					}
				}
			});
		} finally {
			notice.hide();
		}

		const summary = failed > 0
			? `Removed ${removed} of ${files.length} notes (${failed} failed)`
			: `Removed ${removed} of ${files.length} notes`;
		new Notice(summary);
		return failed === 0;
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
			await withOptionalNoteLock(this.noteLocks, file.path, 'lint', () => withMaterializing(this.setMaterializing, async () => {
				await this.app.vault.modify(file, cleaned);
			}));
			if (!silent) new Notice('Transcript cleaned');
			return true;
		} catch (e) {
			if (!silent) new Notice(`Transcript cleanup failed (${file.path}): ${(e as Error).message}`);
			logError(`transcript cleanup failed (${file.path})`, e);
			return false;
		}
	}
}
