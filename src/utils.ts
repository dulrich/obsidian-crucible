import { App, Platform, TFolder, moment } from 'obsidian';
import { LocalizeMediaType, OBSIDIAN_NATIVE_EMBED_FORMATS } from './types';

/**
 * Returns a display label for the first hotkey bound to a command, e.g. "Cmd + B",
 * or null when the command (identified by its FULL, already-prefixed id) has no hotkey.
 */
export function getCommandHotkeyLabel(app: App, fullCommandId: string): string | null {
	const hotkeys = app.hotkeyManager.getHotkeys(fullCommandId);
	if (!hotkeys || hotkeys.length === 0) return null;

	const hotkey = hotkeys[0];
	if (!hotkey) return null;

	const parts: string[] = hotkey.modifiers.map(mod => {
		if (mod === 'Mod') return Platform.isMacOS ? 'Cmd' : 'Ctrl';
		return mod;
	});

	let key = hotkey.key;
	if (key.length === 1) key = key.toUpperCase();
	if (key === ' ') key = 'Space';
	parts.push(key);

	return parts.join(' + ');
}

export const FRONTMATTER_REGEX = new RegExp('^[\\uFEFF]?---\\s*[^\\S\\r\\n]*[\\r\\n]+([\\s\\S]*?)[\\r\\n]+---[^\\S\\r\\n]*([\\r\\n]*)');

// In-flight folder creations, shared per path so N concurrent ensureFolder callers
// collapse onto one createFolder instead of racing check-then-create. The map is
// cleaned in a finally, so a completed (or failed) create never pins a stale promise.
const inFlightFolderCreates = new Map<string, Promise<void>>();

export async function ensureFolder(app: App, path: string): Promise<void> {
	const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/, '');
	const parts = normalizedPath.split('/');
	let currentPath = '';

	for (const part of parts) {
		currentPath = currentPath ? `${currentPath}/${part}` : part;
		const folder = app.vault.getAbstractFileByPath(currentPath);
		if (folder instanceof TFolder) continue;
		// The pre-check above and the create below are not atomic: at first startup
		// after the queue tree was deleted on disk, every void'ed startup chain
		// (orchestrator scan, trigger enqueues, auto-localize) saw `null` here at
		// once, and all but the winner rejected with core's "Folder already exists."
		// as an uncaught promise rejection. Two layers make the create idempotent:
		// share one in-flight create per path, and treat a rejection as success iff
		// the post-condition holds (the folder exists) — rethrow otherwise.
		let pending = inFlightFolderCreates.get(currentPath);
		if (!pending) {
			const target = currentPath;
			pending = (async () => {
				try {
					await app.vault.createFolder(target);
				} catch (err) {
					if (!(app.vault.getAbstractFileByPath(target) instanceof TFolder)) throw err;
				}
			})().finally(() => { inFlightFolderCreates.delete(target); });
			inFlightFolderCreates.set(target, pending);
		}
		await pending;
	}
}

/**
 * Append a timestamped entry to a shared debug note (default `_crucible/debug.md`).
 * Used by both Crucible:Chain debug mode and Localize debug mode so all debug output
 * lands in the same file. Creates the file/folder on first write.
 */
export async function appendDebugLog(
	app: App,
	source: string,
	entry: string,
	path: string = '_crucible/debug.md',
): Promise<void> {
	const timestamp = new Date().toISOString();
	const line = `\n## ${timestamp} — ${source}\n${entry}\n---\n`;
	const existing = app.vault.getFileByPath(path);
	if (existing) {
		const content = await app.vault.read(existing);
		await app.vault.modify(existing, content + line);
	} else {
		const folderPath = path.substring(0, path.lastIndexOf('/'));
		if (folderPath) await ensureFolder(app, folderPath);
		await app.vault.create(path, line);
	}
}

export async function applyTemplateString(
	template: string,
	date: moment.Moment,
	fileName: string,
	value: string = '',
	extraTokens: Record<string, string> = {},
): Promise<string> {
	const now = window.moment();
	let content = template;

	const replaceTokens = (text: string) => {
		let result = text;
		result = result.replace(/{{datetime:(.*?)}}/g, (_match, format: string) => date.format(format));
		result = result.replace(/{{date}}/g, date.format('YYYY-MM-DD'));
		result = result.replace(/{{time}}/g, date.format('HH:mm'));
		result = result.replace(/{{today}}/g, now.format('YYYY-MM-DD'));
		result = result.replace(/{{now}}/g, now.format('YYYY-MM-DDTHH:mm:ss'));
		result = result.replace(/{{value:oneline}}/g, collapseWhitespace(value));
		result = result.replace(/{{value}}/g, value);
		return result;
	};

	content = replaceTokens(content);
	content = content.replace(/{{title}}/g, fileName);
	for (const [token, tokenValue] of Object.entries(extraTokens)) {
		content = content.replace(new RegExp(`{{${escapeRegExp(token)}}}`, 'g'), tokenValue);
	}
	return content;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

export function slugify(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

const LOCALIZE_PROCESSABLE_TYPES: LocalizeMediaType[] = ['images', 'audio', 'video', 'pdf'];

/**
 * Classify a file extension into the Localize media type it belongs to, or null
 * if it is not a localizable media type. Mirrors the convention used by
 * AttachmentLocalizer.classifyExtension (webm prefers video).
 */
export function classifyLocalizeMediaType(extRaw: string): LocalizeMediaType | null {
	const ext = extRaw.toLowerCase().replace(/^\./, '');
	if (ext === 'webm') return 'video';
	for (const type of LOCALIZE_PROCESSABLE_TYPES) {
		if (OBSIDIAN_NATIVE_EMBED_FORMATS[type].includes(ext)) return type;
	}
	return null;
}

export interface AttachmentTemplateContext {
	noteBasename: string;
	noteFolderPath: string;
	originalName: string;
	ext: string;
	md5?: string;
}

export function applyAttachmentTemplate(template: string, ctx: AttachmentTemplateContext): string {
	const now = window.moment();
	const tokens: Record<string, string> = {
		folder: ctx.noteFolderPath,
		slug: slugify(ctx.noteBasename),
		name: ctx.noteBasename,
		title: ctx.noteBasename,
		ext: ctx.ext,
		original: ctx.originalName,
		md5: ctx.md5 ?? '',
		date: now.format('YYYY-MM-DD'),
		time: now.format('HH:mm'),
		today: now.format('YYYY-MM-DD'),
		now: now.format('YYYY-MM-DDTHH:mm:ss'),
	};
	let result = template.replace(/{{datetime:(.*?)}}/g, (_m, fmt: string) => now.format(fmt));
	for (const [token, value] of Object.entries(tokens)) {
		result = result.replace(new RegExp(`{{${escapeRegExp(token)}}}`, 'g'), value);
	}
	return result;
}
