import { App, Editor, MarkdownView, Notice, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';
import {
	CrucibleSettings,
	ImageConvertFormat,
	LocalizeMediaType,
} from './types';
import { Linter } from './lint';
import { appendDebugLog, applyAttachmentTemplate, classifyLocalizeMediaType, ensureFolder } from './utils';
import { logError, logWarn } from './log';
import { withMaterializing } from './frontmatter';

export const MD5_NAME_RE = /_MD5\.[A-Za-z0-9]+$/;
const REMOTE_MD_IMAGE_RE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
// Lazy-load placeholder images injected by web clippers: tiny inline `data:image/...`
// embeds (often a 1x1 transparent gif) sit immediately before the real image. They are
// never useful and, when glued onto the same inline run as a real embed, prevent Obsidian
// from rendering that embed. Strip them (plus any trailing inline whitespace) on localize.
const DATA_URI_IMAGE_RE = /!\[[^\]]*\]\(\s*data:image\/[^)]*\)[ \t]*/g;

interface AttachmentMatch {
	original: string;
	link: string;
	syntax: 'wiki' | 'md';
	isRemote: boolean;
}

export interface AttachmentReplacement {
	from: string;
	to: string;
}

const MARKDOWN_ATTACHMENT_REF_RE = /!\[\[[^\]\n]+\]\]|!\[[^\]\n]*\]\([^)\n]+\)/g;
const DEFAULT_IMAGE_QUALITY = 85;
const MAX_MD5_WORDS = 0x3fffffff;

export function clampImageQuality(quality: number | undefined): number {
	const value = typeof quality === 'number' && Number.isFinite(quality) ? quality : DEFAULT_IMAGE_QUALITY;
	return Math.min(100, Math.max(30, value)) / 100;
}

export function rewriteLocalizedAttachmentRefs(content: string, replacements: AttachmentReplacement[]): string {
	if (replacements.length === 0) return content;
	const byOriginal = new Map<string, string>();
	for (const replacement of replacements) {
		if (!byOriginal.has(replacement.from)) byOriginal.set(replacement.from, replacement.to);
	}

	MARKDOWN_ATTACHMENT_REF_RE.lastIndex = 0;
	let updated = '';
	let cursor = 0;
	let match: RegExpExecArray | null;
	while ((match = MARKDOWN_ATTACHMENT_REF_RE.exec(content)) !== null) {
		const original = match[0];
		const replacement = byOriginal.get(original);
		if (!replacement) continue;
		updated += content.slice(cursor, match.index);
		updated += replacement;
		cursor = match.index + original.length;
	}

	if (cursor === 0) return content;
	return updated + content.slice(cursor);
}

export function stripDataUriImagePlaceholders(content: string): { content: string; count: number } {
	DATA_URI_IMAGE_RE.lastIndex = 0;
	let count = 0;
	const stripped = content.replace(DATA_URI_IMAGE_RE, () => {
		count++;
		return '';
	});
	return { content: stripped, count };
}

export function md5HexForBytes(bytes: Uint8Array): string {
	return md5(bytes);
}

function md5(bytes: Uint8Array): string {
	const n = bytes.length;
	const fullLen = (((n + 8) >> 6) + 1) * 16;
	if (fullLen > MAX_MD5_WORDS) {
		throw new Error(`Input too large to hash safely (${n} bytes)`);
	}
	const words = new Int32Array(fullLen);
	for (let i = 0; i < n; i++) {
		const wordIndex = i >> 2;
		if (wordIndex >= words.length) throw new Error(`MD5 word index out of bounds (${wordIndex})`);
		words[wordIndex] = (words[wordIndex] ?? 0) | ((bytes[i] ?? 0) << ((i % 4) * 8));
	}
	const terminatorIndex = n >> 2;
	if (terminatorIndex >= words.length) throw new Error(`MD5 terminator index out of bounds (${terminatorIndex})`);
	words[terminatorIndex] = (words[terminatorIndex] ?? 0) | (0x80 << ((n % 4) * 8));
	const bitLen = n * 8;
	words[fullLen - 2] = bitLen | 0;
	words[fullLen - 1] = Math.floor(bitLen / 0x100000000);

	const add = (x: number, y: number) => {
		const lsw = (x & 0xffff) + (y & 0xffff);
		const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
		return (msw << 16) | (lsw & 0xffff);
	};
	const rol = (num: number, cnt: number) => (num << cnt) | (num >>> (32 - cnt));
	const cmn = (q: number, a: number, b: number, x: number, s: number, t: number) => add(rol(add(add(a, q), add(x, t)), s), b);
	const ff = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => cmn((b & c) | ((~b) & d), a, b, x, s, t);
	const gg = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => cmn((b & d) | (c & (~d)), a, b, x, s, t);
	const hh = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => cmn(b ^ c ^ d, a, b, x, s, t);
	const ii = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) => cmn(c ^ (b | (~d)), a, b, x, s, t);

	let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
	for (let i = 0; i < words.length; i += 16) {
		const w = (k: number) => words[i + k] ?? 0;
		const oa = a, ob = b, oc = c, od = d;
		a = ff(a, b, c, d, w(0), 7, -680876936);
		d = ff(d, a, b, c, w(1), 12, -389564586);
		c = ff(c, d, a, b, w(2), 17, 606105819);
		b = ff(b, c, d, a, w(3), 22, -1044525330);
		a = ff(a, b, c, d, w(4), 7, -176418897);
		d = ff(d, a, b, c, w(5), 12, 1200080426);
		c = ff(c, d, a, b, w(6), 17, -1473231341);
		b = ff(b, c, d, a, w(7), 22, -45705983);
		a = ff(a, b, c, d, w(8), 7, 1770035416);
		d = ff(d, a, b, c, w(9), 12, -1958414417);
		c = ff(c, d, a, b, w(10), 17, -42063);
		b = ff(b, c, d, a, w(11), 22, -1990404162);
		a = ff(a, b, c, d, w(12), 7, 1804603682);
		d = ff(d, a, b, c, w(13), 12, -40341101);
		c = ff(c, d, a, b, w(14), 17, -1502002290);
		b = ff(b, c, d, a, w(15), 22, 1236535329);

		a = gg(a, b, c, d, w(1), 5, -165796510);
		d = gg(d, a, b, c, w(6), 9, -1069501632);
		c = gg(c, d, a, b, w(11), 14, 643717713);
		b = gg(b, c, d, a, w(0), 20, -373897302);
		a = gg(a, b, c, d, w(5), 5, -701558691);
		d = gg(d, a, b, c, w(10), 9, 38016083);
		c = gg(c, d, a, b, w(15), 14, -660478335);
		b = gg(b, c, d, a, w(4), 20, -405537848);
		a = gg(a, b, c, d, w(9), 5, 568446438);
		d = gg(d, a, b, c, w(14), 9, -1019803690);
		c = gg(c, d, a, b, w(3), 14, -187363961);
		b = gg(b, c, d, a, w(8), 20, 1163531501);
		a = gg(a, b, c, d, w(13), 5, -1444681467);
		d = gg(d, a, b, c, w(2), 9, -51403784);
		c = gg(c, d, a, b, w(7), 14, 1735328473);
		b = gg(b, c, d, a, w(12), 20, -1926607734);

		a = hh(a, b, c, d, w(5), 4, -378558);
		d = hh(d, a, b, c, w(8), 11, -2022574463);
		c = hh(c, d, a, b, w(11), 16, 1839030562);
		b = hh(b, c, d, a, w(14), 23, -35309556);
		a = hh(a, b, c, d, w(1), 4, -1530992060);
		d = hh(d, a, b, c, w(4), 11, 1272893353);
		c = hh(c, d, a, b, w(7), 16, -155497632);
		b = hh(b, c, d, a, w(10), 23, -1094730640);
		a = hh(a, b, c, d, w(13), 4, 681279174);
		d = hh(d, a, b, c, w(0), 11, -358537222);
		c = hh(c, d, a, b, w(3), 16, -722521979);
		b = hh(b, c, d, a, w(6), 23, 76029189);
		a = hh(a, b, c, d, w(9), 4, -640364487);
		d = hh(d, a, b, c, w(12), 11, -421815835);
		c = hh(c, d, a, b, w(15), 16, 530742520);
		b = hh(b, c, d, a, w(2), 23, -995338651);

		a = ii(a, b, c, d, w(0), 6, -198630844);
		d = ii(d, a, b, c, w(7), 10, 1126891415);
		c = ii(c, d, a, b, w(14), 15, -1416354905);
		b = ii(b, c, d, a, w(5), 21, -57434055);
		a = ii(a, b, c, d, w(12), 6, 1700485571);
		d = ii(d, a, b, c, w(3), 10, -1894986606);
		c = ii(c, d, a, b, w(10), 15, -1051523);
		b = ii(b, c, d, a, w(1), 21, -2054922799);
		a = ii(a, b, c, d, w(8), 6, 1873313359);
		d = ii(d, a, b, c, w(15), 10, -30611744);
		c = ii(c, d, a, b, w(6), 15, -1560198380);
		b = ii(b, c, d, a, w(13), 21, 1309151649);
		a = ii(a, b, c, d, w(4), 6, -145523070);
		d = ii(d, a, b, c, w(11), 10, -1120210379);
		c = ii(c, d, a, b, w(2), 15, 718787259);
		b = ii(b, c, d, a, w(9), 21, -343485551);

		a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
	}
	const toHex = (num: number) => {
		let s = '';
		for (let j = 0; j < 4; j++) {
			const byte = (num >> (j * 8)) & 0xff;
			s += byte.toString(16).padStart(2, '0');
		}
		return s;
	};
	return toHex(a) + toHex(b) + toHex(c) + toHex(d);
}

export class AttachmentLocalizer {
	private app: App;
	private settings: CrucibleSettings;
	private linter: Linter;
	private setMaterializing: (state: boolean) => void;

	constructor(app: App, settings: CrucibleSettings, linter: Linter, setMaterializing: (state: boolean) => void) {
		this.app = app;
		this.settings = settings;
		this.linter = linter;
		this.setMaterializing = setMaterializing;
	}

	classifyExtension(extRaw: string): LocalizeMediaType | null {
		return classifyLocalizeMediaType(extRaw);
	}

	isTypeEnabledForAttached(type: LocalizeMediaType): boolean {
		switch (type) {
			case 'images': return this.settings.localizeAttachmentsImagesProcessAttached;
			case 'audio': return this.settings.localizeAttachmentsAudioProcessAttached;
			case 'video': return this.settings.localizeAttachmentsVideoProcessAttached;
			case 'pdf': return this.settings.localizeAttachmentsPdfProcessAttached;
		}
	}

	isTypeEnabledForPasted(type: LocalizeMediaType): boolean {
		switch (type) {
			case 'images': return this.settings.localizeAttachmentsImagesProcessPasted;
			case 'audio': return this.settings.localizeAttachmentsAudioProcessPasted;
			case 'video': return this.settings.localizeAttachmentsVideoProcessPasted;
			case 'pdf': return this.settings.localizeAttachmentsPdfProcessPasted;
		}
	}

	getWhitelist(type: LocalizeMediaType): string[] {
		switch (type) {
			case 'images': return this.settings.localizeAttachmentsImagesWhitelist;
			case 'audio': return this.settings.localizeAttachmentsAudioWhitelist;
			case 'video': return this.settings.localizeAttachmentsVideoWhitelist;
			case 'pdf': return this.settings.localizeAttachmentsPdfWhitelist;
		}
	}

	private isEligibleAttached(ext: string): boolean {
		const type = this.classifyExtension(ext);
		if (!type) return false;
		if (!this.isTypeEnabledForAttached(type)) return false;
		return this.getWhitelist(type).includes(ext.toLowerCase());
	}

	private isEligiblePasted(ext: string): boolean {
		const type = this.classifyExtension(ext);
		if (!type) return false;
		if (!this.isTypeEnabledForPasted(type)) return false;
		return this.getWhitelist(type).includes(ext.toLowerCase());
	}

	private async debug(note: TFile, entry: string): Promise<void> {
		if (!this.settings.localizeAttachmentsDebugMode) return;
		try {
			await appendDebugLog(this.app, `Localize: ${note.path}`, entry);
		} catch (e) {
			logWarn('localize debug log failed', e);
		}
	}

	async localizeNote(file: TFile, silent: boolean = false): Promise<boolean> {
		if (this.linter.isPathIgnored(file.path)) return true;
		if (file.extension !== 'md') return true;

		const spinner = silent ? null : new Notice(`Localizing attachments in "${file.basename}"...`, 0);

		try {
			return await withMaterializing(this.setMaterializing, async () => {
				const original = await this.app.vault.read(file);
				const matches = this.parseAttachmentRefs(original, file);
				// Placeholder stripping is part of image localization; only when that's enabled.
				const placeholderCount = this.settings.localizeAttachmentsImagesProcessAttached
					? stripDataUriImagePlaceholders(original).count
					: 0;
				await this.debug(file, `matched ${matches.length} ref(s), ${placeholderCount} data-uri placeholder(s)${matches.length ? '\n' + matches.map(m => `- ${m.syntax}${m.isRemote ? '/remote' : '/local'}: ${m.original} -> link=${m.link}`).join('\n') : ''}`);
				if (matches.length === 0 && placeholderCount === 0) {
					spinner?.hide();
					if (!silent) new Notice('No attachments to localize');
					return true;
				}

				const replacements: AttachmentReplacement[] = [];
				let i = 0;
				for (const match of matches) {
					spinner?.setMessage(`Localizing attachment ${++i}/${matches.length} in "${file.basename}"...`);
					const newRef = await this.processMatch(match, file);
					if (newRef && newRef !== match.original) {
						replacements.push({ from: match.original, to: newRef });
					}
				}

				if (replacements.length > 0 || placeholderCount > 0) {
					const fresh = await this.app.vault.read(file);
					let updated = rewriteLocalizedAttachmentRefs(fresh, replacements);
					if (placeholderCount > 0) updated = stripDataUriImagePlaceholders(updated).content;
					if (updated !== fresh) {
						await this.app.vault.modify(file, updated);
					}
				}

				await this.debug(file, `replacements: ${replacements.length} of ${matches.length}, stripped ${placeholderCount} placeholder(s)${replacements.length ? '\n' + replacements.map(r => `- ${r.from} -> ${r.to}`).join('\n') : ''}`);
				spinner?.hide();
				if (!silent) new Notice(`Localized ${replacements.length} of ${matches.length} attachments${placeholderCount ? `, stripped ${placeholderCount} placeholder${placeholderCount > 1 ? 's' : ''}` : ''}`);
				return true;
			});
		} catch (e) {
			spinner?.hide();
			logError(`localize attachments failed (${file.path})`, e);
			await this.debug(file, `ERROR: ${(e as Error).message}`);
			if (!silent) new Notice(`Localize failed: ${(e as Error).message}`);
			return false;
		}
	}

	async localizeVault(): Promise<boolean> {
		return await this.localizeFolder(this.app.vault.getRoot());
	}

	async localizeFolder(folder: TFolder): Promise<boolean> {
		const files: TFile[] = [];
		const collect = (current: TFolder) => {
			if (this.linter.isPathIgnored(current.path)) return;
			for (const child of current.children) {
				if (child instanceof TFile && child.extension === 'md') {
					if (!this.linter.isPathIgnored(child.path)) files.push(child);
				} else if (child instanceof TFolder) {
					collect(child);
				}
			}
		};
		collect(folder);

		if (files.length === 0) {
			new Notice('No Markdown files to scan for attachments');
			return true;
		}

		const notice = new Notice(`Localizing attachments in ${files.length} notes...`, 0);
		let allOk = true;
		let i = 0;
		for (const file of files) {
			const ok = await this.localizeNote(file, true);
			if (!ok) allOk = false;
			i++;
			if (i % 5 === 0) notice.setMessage(`Localizing... (${i}/${files.length})`);
		}
		notice.hide();
		new Notice(`Localize attachments: scanned ${files.length} notes`);
		return allOk;
	}

	parseAttachmentRefs(content: string, file: TFile): AttachmentMatch[] {
		const results: AttachmentMatch[] = [];
		const seen = new Set<string>();

		const cache = this.app.metadataCache.getFileCache(file);
		if (cache?.embeds) {
			for (const e of cache.embeds) {
				if (!e.original || seen.has(e.original)) continue;
				const link = e.link ?? '';
				const isRemote = /^https?:\/\//i.test(link);
				const syntax: 'wiki' | 'md' = e.original.startsWith('![[') ? 'wiki' : 'md';
				results.push({ original: e.original, link, syntax, isRemote });
				seen.add(e.original);
			}
		}

		REMOTE_MD_IMAGE_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = REMOTE_MD_IMAGE_RE.exec(content)) !== null) {
			const original = m[0];
			const url = m[2];
			if (!url || seen.has(original)) continue;
			results.push({ original, link: url, syntax: 'md', isRemote: true });
			seen.add(original);
		}

		return results;
	}

	private async processMatch(match: AttachmentMatch, note: TFile): Promise<string | null> {
		if (match.isRemote) {
			return await this.processRemote(match, note);
		}
		return await this.processLocal(match, note);
	}

	private async processRemote(match: AttachmentMatch, note: TFile): Promise<string | null> {
		try {
			const download = await this.downloadRemote(match.link);
			if (!download) {
				await this.debug(note, `remote ${match.link}: download failed (left as-is)`);
				return null;
			}
			if (!this.isEligibleAttached(download.ext)) {
				await this.debug(note, `remote ${match.link}: ext .${download.ext} not eligible (left as-is)`);
				return null;
			}

			const isImage = this.classifyExtension(download.ext) === 'images';
			let bytes = download.bytes;
			let ext = download.ext;
			if (isImage && this.settings.localizeAttachmentsConvertAttachedImages) {
				const converted = await this.convertImage(
					bytes,
					ext,
					this.settings.localizeAttachmentsAttachedImageFormat,
					this.settings.localizeAttachmentsAttachedImageQuality,
				);
				bytes = converted.bytes;
				ext = converted.ext;
			}

			const originalName = this.guessRemoteOriginalName(match.link);
			const targetPath = await this.writeAttachment(note, bytes, ext, originalName);
			await this.debug(note, `remote ${match.link}: downloaded .${download.ext} -> ${targetPath}`);
			return this.formatEmbed(match.syntax, targetPath);
		} catch (e) {
			logWarn(`localize remote failed: ${match.link}`, e);
			await this.debug(note, `remote ${match.link}: ERROR ${(e as Error).message} (left as-is)`);
			return null;
		}
	}

	private async processLocal(match: AttachmentMatch, note: TFile): Promise<string | null> {
		const resolved = this.app.metadataCache.getFirstLinkpathDest(match.link, note.path);
		if (!(resolved instanceof TFile)) {
			await this.debug(note, `local ${match.link}: UNRESOLVED (left as-is)`);
			return null;
		}
		const ext = resolved.extension.toLowerCase();
		if (!this.isEligibleAttached(ext)) {
			await this.debug(note, `local ${match.link}: resolved=${resolved.path} but ext .${ext} not eligible (left as-is)`);
			return null;
		}

		// Idempotence: if already in target folder + already _MD5-named, skip
		const expectedFolder = normalizePath(applyAttachmentTemplate(this.settings.localizeAttachmentsFolderTemplate, {
			noteBasename: note.basename,
			noteFolderPath: note.parent?.path ?? '',
			originalName: resolved.basename,
			ext,
		}));
		if (MD5_NAME_RE.test(resolved.name) && resolved.parent?.path === expectedFolder) {
			await this.debug(note, `local ${match.link}: resolved=${resolved.path} already localized in ${expectedFolder} (skip)`);
			return null;
		}

		const arrayBuffer = await this.app.vault.readBinary(resolved);
		let bytes = arrayBuffer;
		let outExt = ext;

		const isImage = this.classifyExtension(ext) === 'images';
		if (isImage && this.settings.localizeAttachmentsConvertAttachedImages) {
			const converted = await this.convertImage(
				bytes,
				ext,
				this.settings.localizeAttachmentsAttachedImageFormat,
				this.settings.localizeAttachmentsAttachedImageQuality,
			);
			bytes = converted.bytes;
			outExt = converted.ext;
		}

		const newPath = await this.writeAttachment(note, bytes, outExt, resolved.basename);
		// Delete the old file if it moved to a different path
		if (resolved.path !== newPath) {
			try { await this.app.fileManager.trashFile(resolved); } catch (e) { logWarn('localize: could not delete old', resolved.path, e); }
		}
		await this.debug(note, `local ${match.link}: resolved=${resolved.path} -> ${newPath}`);
		return this.formatEmbed(match.syntax, newPath);
	}

	private async writeAttachment(note: TFile, bytes: ArrayBuffer, ext: string, originalName: string): Promise<string> {
		const md5 = this.md5Hex(bytes);
		const folder = normalizePath(applyAttachmentTemplate(this.settings.localizeAttachmentsFolderTemplate, {
			noteBasename: note.basename,
			noteFolderPath: note.parent?.path ?? '',
			originalName,
			ext,
		}));
		const fileName = applyAttachmentTemplate(this.settings.localizeAttachmentsNameTemplate, {
			noteBasename: note.basename,
			noteFolderPath: note.parent?.path ?? '',
			originalName,
			ext,
			md5,
		});
		await ensureFolder(this.app, folder);
		const targetPath = normalizePath(`${folder}/${fileName}`);

		const existing = this.app.vault.getAbstractFileByPath(targetPath);
		await withMaterializing(this.setMaterializing, async () => {
			if (existing instanceof TFile) {
				await this.app.vault.modifyBinary(existing, bytes);
			} else {
				await this.app.vault.createBinary(targetPath, bytes);
			}
		});
		return targetPath;
	}

	private formatEmbed(syntax: 'wiki' | 'md', targetPath: string): string {
		if (syntax === 'wiki') return `![[${targetPath}]]`;
		// Empty alt is deliberate: Obsidian interprets a markdown image's alt text as a
		// display size when it parses as a number (e.g. `![1](img.png)` renders at 1px wide,
		// effectively invisible). The localize "alt" is only a guessed filename anyway, so
		// dropping it avoids accidentally collapsing the image.
		return `![](${targetPath.replace(/ /g, '%20')})`;
	}

	private guessRemoteOriginalName(url: string): string {
		try {
			const u = new URL(url);
			const last = u.pathname.split('/').filter(Boolean).pop() ?? 'remote';
			return last.replace(/\.[^.]+$/, '');
		} catch {
			return 'remote';
		}
	}

	async downloadRemote(url: string): Promise<{ bytes: ArrayBuffer; ext: string } | null> {
		try {
			const res = await requestUrl({ url, method: 'GET' });
			const contentType = (res.headers?.['content-type'] ?? res.headers?.['Content-Type'] ?? '').toString().toLowerCase();
			const ext = this.extFromMime(contentType) ?? this.extFromUrl(url) ?? 'bin';
			return { bytes: res.arrayBuffer, ext };
		} catch (e) {
			logWarn(`download failed: ${url}`, e);
			return null;
		}
	}

	private extFromUrl(url: string): string | null {
		try {
			const u = new URL(url);
			const m = /\.([A-Za-z0-9]+)$/.exec(u.pathname);
			return m && m[1] ? m[1].toLowerCase() : null;
		} catch {
			return null;
		}
	}

	private extFromMime(mime: string): string | null {
		const map: Record<string, string> = {
			'image/png': 'png',
			'image/jpeg': 'jpg',
			'image/gif': 'gif',
			'image/webp': 'webp',
			'image/avif': 'avif',
			'image/svg+xml': 'svg',
			'image/bmp': 'bmp',
			'audio/mpeg': 'mp3',
			'audio/flac': 'flac',
			'audio/wav': 'wav',
			'audio/ogg': 'ogg',
			'audio/webm': 'webm',
			'audio/mp4': 'm4a',
			'video/mp4': 'mp4',
			'video/quicktime': 'mov',
			'video/x-matroska': 'mkv',
			'video/webm': 'webm',
			'video/ogg': 'ogv',
			'application/pdf': 'pdf',
		};
		const head = (mime.split(';')[0] ?? '').trim();
		return map[head] ?? null;
	}

	private md5Hex(bytes: ArrayBuffer): string {
		return md5(new Uint8Array(bytes));
	}

	async convertImage(bytes: ArrayBuffer, srcExt: string, target: ImageConvertFormat, quality: number): Promise<{ bytes: ArrayBuffer; ext: string }> {
		const targetMime = target === 'webp' ? 'image/webp' : 'image/jpeg';
		const targetExt = target === 'webp' ? 'webp' : 'jpg';
		const q = clampImageQuality(quality);
		try {
			const sourceMime = this.extFromMime(`image/${srcExt}`) ? `image/${srcExt === 'jpg' ? 'jpeg' : srcExt}` : 'application/octet-stream';
			const blob = new Blob([bytes], { type: sourceMime });
			const url = URL.createObjectURL(blob);
			try {
				const img = await this.loadImage(url);
				const canvas = document.createElement('canvas');
				canvas.width = img.naturalWidth;
				canvas.height = img.naturalHeight;
				const ctx = canvas.getContext('2d');
				if (!ctx) return { bytes, ext: srcExt };
				ctx.drawImage(img, 0, 0);
				const outBlob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, targetMime, q));
				if (!outBlob) return { bytes, ext: srcExt };
				const outBuf = await outBlob.arrayBuffer();
				if (outBuf.byteLength >= bytes.byteLength) return { bytes, ext: srcExt };
				return { bytes: outBuf, ext: targetExt };
			} finally {
				URL.revokeObjectURL(url);
			}
		} catch (e) {
			logWarn('image conversion failed; keeping source', e);
			return { bytes, ext: srcExt };
		}
	}

	private loadImage(url: string): Promise<HTMLImageElement> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error('Image load failed'));
			img.src = url;
		});
	}

	async handlePaste(evt: ClipboardEvent, editor: Editor, view: MarkdownView): Promise<boolean> {
		if (!view.file) return false;
		if (this.linter.isPathIgnored(view.file.path)) return false;
		const items = evt.clipboardData?.items;
		if (!items || items.length === 0) return false;

		// Synchronously collect eligible files and File handles BEFORE any await.
		// preventDefault must run in the same tick as the event, otherwise Obsidian's
		// default paste handler inserts its own embed (and any sibling text/URL items
		// like Firefox screenshot links) and we end up with a duplicate next to ours.
		const eligible: { file: File; ext: string }[] = [];
		for (const item of Array.from(items)) {
			if (item.kind !== 'file') continue;
			const mime = item.type || '';
			const ext = this.extFromMime(mime);
			if (!ext) continue;
			if (!this.isEligiblePasted(ext)) continue;
			const file = item.getAsFile();
			if (!file) continue;
			eligible.push({ file, ext });
		}
		if (eligible.length === 0) return false;
		evt.preventDefault();
		evt.stopPropagation();

		const noteFile = view.file;
		const inserts: string[] = [];
		for (const { file, ext } of eligible) {
			let bytes = await file.arrayBuffer();
			let outExt = ext;
			const isImage = this.classifyExtension(ext) === 'images';
			if (isImage && this.settings.localizeAttachmentsConvertPastedImages) {
				const converted = await this.convertImage(
					bytes,
					ext,
					this.settings.localizeAttachmentsPastedImageFormat,
					this.settings.localizeAttachmentsPastedImageQuality,
				);
				bytes = converted.bytes;
				outExt = converted.ext;
			}
			const originalName = file.name.replace(/\.[^.]+$/, '') || 'pasted';
			const targetPath = await this.writeAttachment(noteFile, bytes, outExt, originalName);
			inserts.push(this.formatEmbed('wiki', targetPath));
		}

		editor.replaceSelection(inserts.join('\n'));
		return true;
	}

	attachmentFolderForNote(note: TFile): string {
		return normalizePath(applyAttachmentTemplate(this.settings.localizeAttachmentsFolderTemplate, {
			noteBasename: note.basename,
			noteFolderPath: note.parent?.path ?? '',
			originalName: '',
			ext: '',
		}));
	}

	attachmentFolderForPath(notePath: string): string {
		const basename = notePath.replace(/^.*\//, '').replace(/\.md$/i, '');
		const folder = notePath.includes('/') ? notePath.replace(/\/[^/]+$/, '') : '';
		return normalizePath(applyAttachmentTemplate(this.settings.localizeAttachmentsFolderTemplate, {
			noteBasename: basename,
			noteFolderPath: folder,
			originalName: '',
			ext: '',
		}));
	}

	async onNoteRename(file: TFile, oldPath: string): Promise<void> {
		if (!this.settings.localizeAttachmentsFollowNoteLifecycle) return;
		if (file.extension !== 'md') return;
		const oldFolder = this.attachmentFolderForPath(oldPath);
		const newFolder = this.attachmentFolderForNote(file);
		if (oldFolder === newFolder) return;
		const existing = this.app.vault.getAbstractFileByPath(oldFolder);
		if (!(existing instanceof TFolder)) return;
		try {
			await ensureFolder(this.app, newFolder.replace(/\/[^/]+$/, ''));
			await this.app.fileManager.renameFile(existing, newFolder);
		} catch (e) {
			logWarn('localize: rename attachment folder failed', e);
		}
	}

	async onNoteDelete(oldPath: string): Promise<void> {
		if (!this.settings.localizeAttachmentsFollowNoteLifecycle) return;
		if (!/\.md$/i.test(oldPath)) return;
		const folder = this.attachmentFolderForPath(oldPath);
		const existing = this.app.vault.getAbstractFileByPath(folder);
		if (!(existing instanceof TFolder)) return;
		try {
			await this.app.fileManager.trashFile(existing);
		} catch (e) {
			logWarn('localize: delete attachment folder failed', e);
		}
	}
}
