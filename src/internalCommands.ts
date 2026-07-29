import { Notice, TFile, Editor, MarkdownView } from 'obsidian';
import type CruciblePlugin from './main';
import { ChainCommandOptions } from './chains';
import { TextInputModal } from './captures';
import { FRONTMATTER_REGEX } from './utils';
import {
	normalizeFrontmatterPropertyName,
	parseTagList,
	updateFrontmatter,
	upsertFrontmatterProperty,
	upsertFrontmatterTags,
	withMaterializing,
} from './frontmatter';
import { refreshDataviewViews } from './lint';
import { coerceVideoId, ingestYoutubeVideoMetadata } from './orchestration/utils/youtubeApi';
import { addIgnoredVideoId } from './orchestration/utils/ignoredIds';
import { youtubeVideoIdFromArgsOrFrontmatter, youtubeWatchUrlFromArgsOrFrontmatter } from './orchestration/utils/youtubeActions';
import { resolveCaptureContext, resolveCaptureValue } from './captureCommands';

// Built-in chain-internal commands (lint, materialize, sources, YouTube actions,
// frontmatter upserts, capture-by-name) — registered under both the manifest
// prefix and the fixed `crucible:` prefix so chains authored against either id
// keep working. Split out of the plugin class to keep main.ts a thin lifecycle
// hub. These are chain-internal registrations only; the corresponding
// palette-facing commands (which route through `plugin.registerCrucibleCommand`,
// per the AGENTS.md quirk) are registered in commands.ts.
export function registerInternalCommands(plugin: CruciblePlugin): void {
	const prefix = plugin.manifest.id;

	// Built-in commands
	const register = (
		id: string,
		fn: (args: Record<string, string>, prev: unknown, editor?: Editor, targetFile?: TFile) => Promise<unknown>,
		options?: ChainCommandOptions,
	) => {
		plugin.chainManager.registerInternalCommand(`${prefix}:${id}`, fn, options);
		plugin.chainManager.registerInternalCommand(`crucible:${id}`, fn, options);
	};

	register('lint-note', async (_a, _p, _e, tf) => await plugin.linter.lintNote(tf));
	register('lint-vault', async () => await plugin.linter.lintVault(), { lockTarget: 'none' });
	register('word-count', async (_a, _p, _e, tf) => await plugin.linter.lintNote(tf));
	register('lint-cleanup-transcript', async (_a, _p, _e, tf) => await plugin.linter.cleanupTranscriptInFile(tf));
	register('lint-localize-attachments', async (_a, _p, _e, tf) => {
		const file = tf ?? plugin.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') {
			new Notice('Open a Markdown note to localize attachments');
			return false;
		}
		return await plugin.attachmentLocalizer.localizeNote(file);
	});
	register('lint-localize-attachments-vault', async () => await plugin.attachmentLocalizer.localizeVault(), { lockTarget: 'none' });
	register('lint-repair-attachments', async (_a, _p, _e, tf) => {
		const file = tf ?? plugin.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') {
			new Notice('Open a Markdown note to repair attachment links');
			return false;
		}
		return (await plugin.attachmentLocalizer.repairNote(file)) !== null;
	});
	register('lint-repair-attachments-vault', async () => await plugin.attachmentLocalizer.repairVault(), { lockTarget: 'none' });
	register('lint-rename-property', async (args) => await plugin.linter.renamePropertyInVault(
		typeof args['oldKey'] === 'string' ? args['oldKey'] : '',
		typeof args['newKey'] === 'string' ? args['newKey'] : '',
	), { lockTarget: 'none' });
	register('lint-remove-property', async (args) => await plugin.linter.removePropertyFromVault(
		typeof args['key'] === 'string' ? args['key'] : '',
	), { lockTarget: 'none' });
	register('dataview-refresh', async () => {
		refreshDataviewViews(plugin.app);
		return true;
	}, { mutating: false, lockTarget: 'none' });
	register('youtube-fetch-video-metadata', async (_a, _p, _e, tf) => await fetchYoutubeMetadataForActiveNote(plugin, tf));
	register('youtube-ignore-video', async (args, _p, _e, tf) => await ignoreYoutubeVideoCommand(plugin, args, tf), {
		lockTarget: 'none',
		schema: [
			{ id: 'videoId', name: 'Video ID', type: 'text', description: 'Optional override. Leave blank to use videoId from the target metadata note.' },
		],
	});
	register('youtube-watch-video', async (args, _p, _e, tf) => await watchYoutubeVideoCommand(args, tf, plugin), {
		mutating: false,
		lockTarget: 'none',
		schema: [
			{ id: 'url', name: 'URL', type: 'text', description: 'Optional override. Leave blank to use url from the target metadata note.' },
		],
	});

	register('materialize-day-today', async () => await plugin.materializer.materializeDay(window.moment()), { lockTarget: 'none' });
	register('materialize-week-today', async () => await plugin.materializer.materializeWeek(window.moment()), { lockTarget: 'none' });
	register('materialize-month-today', async () => await plugin.materializer.materializeMonth(window.moment()), { lockTarget: 'none' });

	// --- Sources: produce content for chain steps via {{response}} ---
	register('source:active-file', async (_a, _p, _e, tf) => {
		const file = tf ?? plugin.app.workspace.getActiveFile();
		if (!file) throw new Error('No active file');
		const content = await plugin.app.vault.read(file);
		return content.replace(FRONTMATTER_REGEX, '').trim();
	}, { mutating: false });

	register('copy-active-file', async (_a, _p, _e, tf) => {
		const file = tf ?? plugin.app.workspace.getActiveFile();
		if (!file) throw new Error('No active file');
		const content = await plugin.app.vault.read(file);
		await navigator.clipboard.writeText(content);
		new Notice('Note copied to clipboard');
		return true;
	}, { mutating: false });

	register('source:selection', async (_args, _prev, editor) => {
		if (editor) return editor.getSelection();
		const dom = window.getSelection()?.toString() ?? '';
		if (!dom) throw new Error('No text selected. Select text in the note first.');
		return dom;
	}, { mutating: false, lockTarget: 'none' });

	register('source:input', async (args) => {
		const title = args.title || 'Input';
		return await new Promise<string | false>((resolve) => {
			let submitted = false;
			new TextInputModal(
				plugin.app,
				title,
				(value) => { submitted = true; resolve(value); },
				() => { if (!submitted) resolve(false); }
			).open();
		});
	}, {
		mutating: false,
		lockTarget: 'none',
		schema: [{ id: 'title', name: 'Title', type: 'text', description: 'Heading shown above the input box.' }],
	});

	register('mark-as-forwarded', async (_args, _prev, editor) => {
		if (!editor) throw new Error('mark-as-forwarded requires edit mode');
		const cursor = editor.getCursor();
		const lineNum = cursor.line;
		const line = editor.getLine(lineNum);
		const checkboxRegex = /^(\s*[-*+]\s+\[) (\]\s+.*)$/;
		if (checkboxRegex.test(line)) {
			const newLine = line.replace(checkboxRegex, '$1>$2');
			editor.setLine(lineNum, newLine);
			editor.setCursor(cursor);
			return true;
		}
		return false;
	});

	register('upsert-tags', async (args, _p, _e, tf) => {
		return await upsertActiveFileTags(plugin, args.tags || '', tf);
	}, {
		schema: [
			{ id: 'tags', name: 'Tags', type: 'textarea', description: 'Tags to add to the active note frontmatter. Use commas, spaces, or one per line. Leading # is optional.' }
		],
	});

	register('upsert-property', async (args, _p, _e, tf) => {
		return await upsertActiveFileProperty(plugin, args.property || '', args.value || '', tf);
	}, {
		schema: [
			{ id: 'property', name: 'Property', type: 'text', description: 'Frontmatter property name to create or update on the active note.' },
			{ id: 'value', name: 'Value', type: 'textarea', description: 'Value to write to the property. Supports {{response}} from the previous chain step.' }
		],
	});

	register('copy-note-to-folder', async (args, _p, _e, tf) => {
		const file = tf ?? plugin.app.workspace.getActiveFile();
		if (!file) throw new Error('No active file');
		const folder = args.folder?.trim();
		if (!folder) throw new Error('No destination folder specified');
		if (!plugin.app.vault.getFolderByPath(folder)) await plugin.app.vault.createFolder(folder);
		const destPath = `${folder}/${file.name}`;
		const exists = plugin.app.vault.getFileByPath(destPath);
		if (exists) { new Notice(`Copy already exists: ${destPath}`); return destPath; }
		const content = await plugin.app.vault.read(file);
		await plugin.app.vault.create(destPath, content);
		new Notice(`Copied to ${destPath}`);
		return destPath;
	}, {
		schema: [
			{ id: 'folder', name: 'Destination folder', type: 'folder', description: 'Vault folder to copy the current note into.' }
		],
	});

	register('replace-note-body', async (args, prev, _e, tf) => {
		const file = tf ?? plugin.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') throw new Error('No active Markdown file');
		const replacement = args.content || (typeof prev === 'string' ? prev : '');
		if (!replacement) throw new Error('No replacement content provided');
		const existing = await plugin.app.vault.read(file);
		const fmMatch = existing.match(/^---\n[\s\S]*?\n---\n/);
		const frontmatter = fmMatch ? fmMatch[0] : '';
		await withMaterializing(state => { plugin.isMaterializing = state; }, async () => {
			await plugin.app.vault.modify(file, frontmatter + replacement);
		});
		new Notice('Note body replaced');
		return true;
	}, {
		schema: [
			{ id: 'content', name: 'Content', type: 'textarea', description: 'New body for the note. If empty, uses {{response}} from the previous step.' }
		],
	});

	register('capture', async (args, _prev, editor, tf) => {
		const name = args.name;
		const manualValue = args.value;
		const capture = plugin.settings.captures.find(c => c.name === name);
		if (capture) {
			const resolvedValue = manualValue || await resolveCaptureValue(plugin, capture, editor);
			if (resolvedValue === null) return false;
			return await plugin.captureManager.executeCapture(
				capture,
				resolvedValue,
				tf,
				resolveCaptureContext(plugin, editor, capture, tf),
			);
		}
		new Notice(`Capture not found: ${name}`);
		return false;
	}, {
		schema: [
			{ id: 'name', name: 'Capture name', type: 'text', description: 'Name of the capture workflow to trigger.' },
			{ id: 'value', name: 'Content', type: 'textarea', description: 'Optional content. If omitted, will prompt or use source.' }
		],
	});
}

async function upsertActiveFileTags(plugin: CruciblePlugin, tagsInput: string, targetFile?: TFile): Promise<boolean> {
	const file = targetFile ?? plugin.app.workspace.getActiveFile();
	if (!file || file.extension !== 'md') throw new Error('No active Markdown file');

	const newTags = parseTagList(tagsInput);
	if (newTags.length === 0) throw new Error('No tags provided');

	await withMaterializing(state => { plugin.isMaterializing = state; }, async () => {
		await updateFrontmatter(plugin.app, file, (fm) => {
			upsertFrontmatterTags(fm, tagsInput);
		});
	});

	return true;
}

async function upsertActiveFileProperty(plugin: CruciblePlugin, property: string, value: string, targetFile?: TFile): Promise<boolean> {
	const file = targetFile ?? plugin.app.workspace.getActiveFile();
	if (!file || file.extension !== 'md') throw new Error('No active Markdown file');

	const propertyName = normalizeFrontmatterPropertyName(property);
	if (!propertyName) throw new Error('Property name is required');

	await withMaterializing(state => { plugin.isMaterializing = state; }, async () => {
		await updateFrontmatter(plugin.app, file, (fm) => {
			upsertFrontmatterProperty(fm, propertyName, value);
		});
	});

	return true;
}

function targetFrontmatter(plugin: CruciblePlugin, targetFile?: TFile): Record<string, unknown> | undefined {
	const file = targetFile ?? plugin.app.workspace.getActiveFile() ?? undefined;
	return file ? plugin.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined : undefined;
}

async function ignoreYoutubeVideoCommand(plugin: CruciblePlugin, args: Record<string, string>, targetFile?: TFile): Promise<boolean> {
	const videoId = youtubeVideoIdFromArgsOrFrontmatter(args, targetFrontmatter(plugin, targetFile));
	if (!videoId) throw new Error('No YouTube video id found on the target metadata note.');
	await plugin.noteLocks.withResourceLock('ignored-ids', 'videos', 'ignore-video', () =>
		addIgnoredVideoId(plugin.app, videoId),
	);
	return true;
}

async function watchYoutubeVideoCommand(args: Record<string, string>, targetFile: TFile | undefined, plugin: CruciblePlugin): Promise<boolean> {
	const url = youtubeWatchUrlFromArgsOrFrontmatter(args, targetFrontmatter(plugin, targetFile));
	if (!url) throw new Error('No YouTube URL found on the target metadata note.');
	window.open(url, '_blank', 'noopener');
	return true;
}

// Fetches + links YouTube metadata for `targetFile` (defaults to the active
// note). Returns whether the link was set. Used both by the standalone command
// and as an awaited chain step — passing the chain's target file is what makes
// it run on the right note, in order, and inside the chain's note-lock context
// (reentrant), instead of fire-and-forget on the active note via executeCommandById.
export async function fetchYoutubeMetadataForActiveNote(plugin: CruciblePlugin, targetFile?: TFile): Promise<boolean> {
	const file = targetFile ?? plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file;
	if (!file) {
		new Notice('No active note');
		return false;
	}
	const fm: Record<string, unknown> | undefined = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
	const raw: unknown = fm ? fm['yt-video-id'] : undefined;
	const videoId = coerceVideoId(raw);
	if (!videoId) {
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		new Notice('Active note has no yt-video-id in frontmatter');
		return false;
	}

	try {
		const result = await withMaterializing(state => { plugin.isMaterializing = state; }, () =>
			ingestYoutubeVideoMetadata(plugin, file, videoId),
		);
		switch (result.status) {
			case 'created':
				new Notice(`YouTube metadata saved: ${result.metadataPath}`);
				emitMetadataEnriched(plugin, videoId, result.metadataPath, file);
				return true;
			case 'exists':
				new Notice('YouTube metadata already exists; linked.');
				emitMetadataEnriched(plugin, videoId, result.metadataPath, file);
				return true;
			case 'no-video-id':
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				new Notice('Active note has no yt-video-id in frontmatter');
				return false;
			case 'no-api-key':
				new Notice('YouTube data API key not set — configure it in settings → orchestrator → YouTube tracker');
				return false;
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		new Notice(`YouTube fetch failed: ${message}`);
		return false;
	}
}

function emitMetadataEnriched(plugin: CruciblePlugin, videoId: string, metadataPath: string, sourceFile?: TFile): void {
	const bus = plugin.ingestionEvents;
	if (!bus) return;
	const file = plugin.app.vault.getAbstractFileByPath(metadataPath);
	if (!(file instanceof TFile)) return;
	bus.emit('metadata-enriched', { videoId, metadataFile: file, sourceFile });
}
