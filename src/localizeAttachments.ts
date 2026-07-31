import { App, Editor, MarkdownView, Notice, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';
import {
	CrucibleSettings,
	ImageConvertFormat,
	LocalizeMediaType,
} from './types';
import { isPathExcluded } from './exclusions';
import type { ExclusionScope } from './types';
import { appendDebugLog, applyAttachmentTemplate, classifyLocalizeMediaType, ensureFolder } from './utils';
import { logError, logWarn } from './log';
import { withMaterializing } from './frontmatter';
import { NoteLockManager, withOptionalNoteLock } from './orchestration/NoteLockManager';

export const MD5_NAME_RE = /_MD5\.[A-Za-z0-9]+$/;
const REMOTE_MD_IMAGE_RE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
// Lazy-load placeholder images injected by web clippers: tiny inline `data:image/...`
// embeds (often a 1x1 transparent gif) sit immediately before the real image. They are
// never useful and, when glued onto the same inline run as a real embed, prevent Obsidian
// from rendering that embed. Strip them (plus any trailing inline whitespace) on localize.
const DATA_URI_IMAGE_RE = /!\[[^\]]*\]\(\s*data:image\/[^)]*\)[ \t]*/g;

export interface AttachmentMatch {
	original: string;
	link: string;
	syntax: 'wiki' | 'md';
	isRemote: boolean;
	// True for `!`-prefixed embeds; false for plain links (`[[x]]` / `[text](x)`). Repair
	// must preserve this — converting a broken link into an embed (or vice versa) changes
	// how the note renders, not just where the ref points.
	isEmbed: boolean;
	// Only meaningful when !isEmbed: the link's alias/display text, so a repaired link
	// keeps its original visible text instead of collapsing to the raw path.
	displayText?: string;
}

// Reason a broken ref could not be repaired, surfaced to the debug log and (for the
// bulk/remote cases) to callers deciding how to report outcomes. `remote-download-failed`
// covers both "the download itself failed" and "the downloaded type isn't eligible" —
// repairNote's remote branch only ever returns null for those two causes.
export type AttachmentRepairFailureReason = 'missing' | 'ambiguous' | 'remote-download-failed';

export interface AttachmentReplacement {
	from: string;
	to: string;
}

// Alternation order is load-bearing (regex-alternation trap): the two embed forms are
// listed first so an embed is always consumed as an embed, never left for a later
// non-embed alternative to double-match a suffix of it. In practice this never actually
// collides — an embed's leading `!` means only the embed alternatives can match at that
// start index, and a global exec/replace pass never revisits a position already consumed
// by an earlier match — but keeping embeds first documents the invariant instead of
// relying on it silently. Embeds stay unfiltered (unchanged prior behavior, byte-for-byte);
// the two non-embed (link) alternatives are new and MUST be gated by
// isManagedAttachmentLink() before either function acts on them, so an ordinary note link
// (`[[Some Note]]`, `[text](Other Note.md)`) can never be touched.
const MARKDOWN_ATTACHMENT_REF_RE = /!\[\[[^\]\n]+\]\]|!\[[^\]\n]*\]\([^)\n]+\)|\[\[[^\]\n]+\]\]|\[[^\]\n]*\]\([^)\n]+\)/g;
const DEFAULT_IMAGE_QUALITY = 85;
const MAX_MD5_WORDS = 0x3fffffff;

export function clampImageQuality(quality: number | undefined): number {
	const value = typeof quality === 'number' && Number.isFinite(quality) ? quality : DEFAULT_IMAGE_QUALITY;
	return Math.min(100, Math.max(30, value)) / 100;
}

// Pulls the raw link/href token out of a matched ref span — works for embed and link,
// wiki and markdown forms alike. Returns null for anything that doesn't parse as one of
// the four MARKDOWN_ATTACHMENT_REF_RE shapes (shouldn't happen for a real match, but keeps
// this total rather than throwing on a future regex change).
function extractRefLinkTarget(ref: string): string | null {
	const wiki = /^!?\[\[([^\]|]+)/.exec(ref);
	if (wiki) return wiki[1] ?? null;
	const md = /^!?\[[^\]]*\]\(([^)]+)\)$/.exec(ref);
	if (md) return md[1] ?? null;
	return null;
}

// The gate that lets rewriteLocalizedAttachmentRefs/repointAttachmentFolderPrefix safely
// widen from embeds-only to embeds+links: true only when a matched (non-embed) ref's
// target decodes (strip #fragment/|alias, %-decode, strip <angle-bracket> wrapping) to a
// managed (`..._MD5.ext`) attachment basename. An ordinary note link's target never has
// that shape, so it always evaluates false and is left untouched.
function isManagedAttachmentLink(ref: string): boolean {
	const target = extractRefLinkTarget(ref);
	if (!target) return false;
	let decoded = target.replace(/^<|>$/g, '');
	try { decoded = decodeURIComponent(decoded); } catch { /* leave as-is on malformed escapes */ }
	const base = decoded.split('#')[0]?.split('/').pop() ?? '';
	return MD5_NAME_RE.test(base);
}

export interface RewriteAttachmentRefsResult {
	content: string;
	// The `from` values whose replacement actually landed in `content` — a subset of the
	// requested replacements. A `from` that never appears verbatim in the scanned content
	// (concurrent edit, or a non-embed link the old embeds-only regex used to silently
	// ignore) is planned but not applied, and is therefore absent here. Callers must derive
	// any "N repaired/localized" count from this list, not from how many replacements were
	// merely requested.
	appliedFrom: string[];
}

export function rewriteLocalizedAttachmentRefs(content: string, replacements: AttachmentReplacement[]): RewriteAttachmentRefsResult {
	if (replacements.length === 0) return { content, appliedFrom: [] };
	const byOriginal = new Map<string, string>();
	for (const replacement of replacements) {
		if (!byOriginal.has(replacement.from)) byOriginal.set(replacement.from, replacement.to);
	}

	MARKDOWN_ATTACHMENT_REF_RE.lastIndex = 0;
	let updated = '';
	let cursor = 0;
	const appliedFrom: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = MARKDOWN_ATTACHMENT_REF_RE.exec(content)) !== null) {
		const original = match[0];
		const isEmbed = original.startsWith('!');
		if (!isEmbed && !isManagedAttachmentLink(original)) continue;
		const replacement = byOriginal.get(original);
		if (!replacement) continue;
		updated += content.slice(cursor, match.index);
		updated += replacement;
		cursor = match.index + original.length;
		appliedFrom.push(original);
	}

	if (cursor === 0) return { content, appliedFrom: [] };
	return { content: updated + content.slice(cursor), appliedFrom };
}

// Swap an attachment folder's path prefix inside embed refs, and non-embed links that
// target a managed attachment (gated via isManagedAttachmentLink — never ordinary note
// links/prose that happens to mention the path). Used when a note moves and its attachment
// folder moves with it: Obsidian's automatic link rewrite on the folder rename misses the
// moving note (its cache entry hasn't reindexed at the new path yet), so we repoint its
// refs deterministically. Handles both raw (wiki) and %20-encoded (markdown) forms of the
// prefix; idempotent on already-updated refs.
export function repointAttachmentFolderPrefix(content: string, oldFolder: string, newFolder: string): string {
	if (!oldFolder || oldFolder === newFolder) return content;
	const rawOld = `${oldFolder}/`;
	const rawNew = `${newFolder}/`;
	const encOld = rawOld.replace(/ /g, '%20');
	const encNew = rawNew.replace(/ /g, '%20');
	MARKDOWN_ATTACHMENT_REF_RE.lastIndex = 0;
	return content.replace(MARKDOWN_ATTACHMENT_REF_RE, (ref) => {
		const isEmbed = ref.startsWith('!');
		if (!isEmbed && !isManagedAttachmentLink(ref)) return ref;
		let out = ref;
		if (out.includes(rawOld)) out = out.split(rawOld).join(rawNew);
		if (encOld !== rawOld && out.includes(encOld)) out = out.split(encOld).join(encNew);
		return out;
	});
}

// Minimum length of the portion of a broken basename BEFORE its `_MD5.<ext>` marker
// ("the stem") required before prefix-recovery will even attempt a match. Default managed
// names are `{{md5}}_MD5.{{ext}}` — a 32-hex-char content hash — so a splice that truncates
// the ref (observed: half-copied names like `abc_MD5.web`) can still leave a recognizable
// fragment of that hash. 8 hex characters is 32 bits of the hash (1-in-4-billion odds of
// two unrelated attachments colliding on an 8-char prefix in any realistic vault), which is
// enough to trust a *unique* prefix hit as the real file; below that, a broken ref carries
// too little of the hash to distinguish "the truncated original" from "some other file that
// happens to start the same way" — so it is left unrepairable (`missing`) rather than risk a
// wrong match. This guard applies to the BROKEN ref's own stem, not the candidate's.
export const PREFIX_REPAIR_MIN_STEM_LENGTH = 8;

export interface LocalAttachmentRepairResolution {
	target: string | null;
	// null exactly when target is non-null ("ok" needs no explanation).
	reason: 'missing' | 'ambiguous' | null;
}

// Among two or more candidate paths already established as byte-identical (same content
// MD5), pick one deterministically rather than bailing to `ambiguous`: prefer a candidate
// already sitting in the note's expected attachment folder, else the shortest path, else
// the lexicographically first (stable, not "arbitrary array order").
function pickAmongIdenticalContent(candidates: string[], expectedFolder: string): string {
	if (expectedFolder) {
		const atExpected = candidates.find(p => p.startsWith(`${expectedFolder}/`));
		if (atExpected) return atExpected;
	}
	const sorted = [...candidates].sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
	// candidates is always non-empty when this is called.
	return sorted[0] as string;
}

// Decide where a broken local attachment ref should now point. `brokenLink` is the ref's
// (possibly %20-encoded) target that no longer resolves; we recover the file by basename —
// the `<contenthash>_MD5.ext` name is content-derived. Resolution proceeds in three tiers,
// each accepting only an unambiguous result: (1) the note's expected attachment folder (the
// exact inverse of the move-without-rewrite bug), (2) a unique exact-basename match anywhere
// in the vault, (3) a unique PREFIX match against other managed (`..._MD5.ext`) basenames,
// recovering refs truncated by a splice bug (see PREFIX_REPAIR_MIN_STEM_LENGTH). Pure and
// side-effect-free; ambiguity at any tier falls through to the next, and exhausting all three
// reports `missing` or `ambiguous` rather than guessing — EXCEPT: when every candidate at
// tier 2 or tier 3 is itself a managed (`_MD5`) name, the content-MD5 naming convention
// guarantees they are byte-identical, so "ambiguous" would be reporting a distinction that
// doesn't exist — pickAmongIdenticalContent resolves deterministically instead. A
// non-managed duplicate basename (tier 2) or a same-prefix-but-different-basename set
// (tier 3) still bails to `ambiguous`, because there identity is NOT guaranteed.
export function resolveLocalAttachmentRepair(brokenLink: string, expectedFolder: string, vaultPaths: string[]): LocalAttachmentRepairResolution {
	let decoded = brokenLink.replace(/^<|>$/g, '');
	try { decoded = decodeURIComponent(decoded); } catch { /* leave as-is on malformed escapes */ }
	const base = decoded.split('/').pop() ?? '';
	if (!base) return { target: null, reason: 'missing' };

	const expected = expectedFolder ? `${expectedFolder}/${base}` : base;
	if (vaultPaths.includes(expected)) return { target: expected, reason: null };

	const exactMatches = vaultPaths.filter(p => (p.split('/').pop() ?? p) === base);
	if (exactMatches.length === 1) return { target: exactMatches[0] ?? null, reason: null };
	if (exactMatches.length > 1) {
		if (MD5_NAME_RE.test(base)) return { target: pickAmongIdenticalContent(exactMatches, expectedFolder), reason: null };
		return { target: null, reason: 'ambiguous' };
	}

	const stemMatch = /^(.*)_MD5\.[A-Za-z0-9]+$/.exec(base);
	const stem = stemMatch ? (stemMatch[1] ?? '') : null;
	if (stem !== null && stem.length >= PREFIX_REPAIR_MIN_STEM_LENGTH) {
		const prefixMatches = vaultPaths.filter(p => {
			const name = p.split('/').pop() ?? p;
			const nameStemMatch = /^(.*)_MD5\.[A-Za-z0-9]+$/.exec(name);
			const nameStem = nameStemMatch ? (nameStemMatch[1] ?? '') : null;
			return nameStem !== null && nameStem.startsWith(stem);
		});
		if (prefixMatches.length === 1) return { target: prefixMatches[0] ?? null, reason: null };
		if (prefixMatches.length > 1) {
			const basenames = new Set(prefixMatches.map(p => p.split('/').pop() ?? p));
			if (basenames.size === 1) return { target: pickAmongIdenticalContent(prefixMatches, expectedFolder), reason: null };
			return { target: null, reason: 'ambiguous' };
		}
	}

	return { target: null, reason: 'missing' };
}

// Thin wrapper preserving the original pure, null-on-ambiguity contract for existing callers
// that only need the target path (the scan's `repairable` computation, sourced from
// data/missingAttachments.ts). `repairNote` calls resolveLocalAttachmentRepair directly so it
// can report WHY a repair failed.
export function planLocalAttachmentRepair(brokenLink: string, expectedFolder: string, vaultPaths: string[]): string | null {
	return resolveLocalAttachmentRepair(brokenLink, expectedFolder, vaultPaths).target;
}

// True when any note other than `excludeNotePath` still links to `attachmentPath`.
// Content-MD5 naming plus repair-by-basename makes shared references normal (the same
// article clipped as both a blog-metadata note and a daily ingest note yields
// byte-identical attachments under one basename), so a re-localize that re-homes a file
// into the current note's expected folder must COPY, not steal: trashing a source another
// note still references breaks that note's ref, and the missing-attachments list just
// trades one broken row for another. Known gap (shared with the Orphaned Attachments
// scan): `resolvedLinks` covers embeds and body links but not frontmatter property links,
// so a frontmatter-only referrer is not seen.
export function hasOtherAttachmentReferrer(
	resolvedLinks: Record<string, Record<string, number>>,
	attachmentPath: string,
	excludeNotePath: string,
): boolean {
	for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
		if (sourcePath === excludeNotePath) continue;
		if ((targets[attachmentPath] ?? 0) > 0) return true;
	}
	return false;
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

// Format a newly-localized/repaired embed. Empty alt is deliberate: Obsidian interprets a
// markdown image's alt text as a display size when it parses as a number (e.g. `![1](img.png)`
// renders at 1px wide, effectively invisible). The localize "alt" is only a guessed filename
// anyway, so dropping it avoids accidentally collapsing the image. Wiki embeds never carried alt.
export function formatEmbed(syntax: 'wiki' | 'md', targetPath: string): string {
	if (syntax === 'wiki') return `![[${targetPath}]]`;
	return `![](${targetPath.replace(/ /g, '%20')})`;
}

// Format a non-embed link so a repair keeps it a link (not an embed) and keeps its original
// visible text, unlike an embed's alt: a plain link's display text is user-authored prose
// (e.g. "the source PDF"), not a guessed filename, so unlike formatEmbed it must be preserved.
export function formatLink(syntax: 'wiki' | 'md', targetPath: string, displayText?: string): string {
	if (syntax === 'wiki') return displayText ? `[[${targetPath}|${displayText}]]` : `[[${targetPath}]]`;
	const text = displayText ?? (targetPath.split('/').pop() ?? targetPath);
	return `[${text}](${targetPath.replace(/ /g, '%20')})`;
}

// Dispatch on the match's original ref kind so a repair/localize write never converts a link
// into an embed or vice versa — only the target path (and, for links, nothing else) changes.
export function formatRef(match: Pick<AttachmentMatch, 'syntax' | 'isEmbed' | 'displayText'>, targetPath: string): string {
	return match.isEmbed ? formatEmbed(match.syntax, targetPath) : formatLink(match.syntax, targetPath, match.displayText);
}

// Duck-typed subset of Obsidian's CachedMetadata.embeds/links entries (Reference: link,
// original, displayText?) — kept minimal so this can be driven directly in tests without an
// 'obsidian' import.
export interface AttachmentRefCacheEntry {
	link?: string;
	original?: string;
	displayText?: string;
}

export interface AttachmentRefCache {
	embeds?: AttachmentRefCacheEntry[];
	links?: AttachmentRefCacheEntry[];
}

// Pure core of AttachmentLocalizer.parseAttachmentRefs: collects every embed AND every
// managed-attachment link from a note's metadata cache. Embeds are always collected (an
// attachment displayed inline is always something localize/repair should track). Links are
// collected only when their decoded basename already looks like a managed (`..._MD5.ext`)
// attachment — a broken NON-embed link to a managed attachment is exactly bug 1 (the
// embeds/links repair asymmetry): the missing-attachments scan already counts these
// (data/missingAttachments.ts), so repair must be able to see and fix them too. Links to
// ordinary (not-yet-localized) files are deliberately left alone here, same as before this
// fix — that's a different, unrelated localize decision this function has no opinion on.
export function parseAttachmentRefsFromCache(cache: AttachmentRefCache | null | undefined, content: string): AttachmentMatch[] {
	const results: AttachmentMatch[] = [];
	const seen = new Set<string>();

	if (cache?.embeds) {
		for (const e of cache.embeds) {
			if (!e.original || seen.has(e.original)) continue;
			const link = e.link ?? '';
			const isRemote = /^https?:\/\//i.test(link);
			const syntax: 'wiki' | 'md' = e.original.startsWith('![[') ? 'wiki' : 'md';
			results.push({ original: e.original, link, syntax, isRemote, isEmbed: true, displayText: e.displayText });
			seen.add(e.original);
		}
	}

	if (cache?.links) {
		for (const l of cache.links) {
			if (!l.original || seen.has(l.original)) continue;
			const link = l.link ?? '';
			const base = link.split('#')[0]?.split('|')[0] ?? '';
			let decodedBase = base;
			try { decodedBase = decodeURIComponent(base); } catch { /* leave as-is on malformed escapes */ }
			const basename = decodedBase.split('/').pop() ?? '';
			if (!basename || !MD5_NAME_RE.test(basename)) continue;
			const isRemote = /^https?:\/\//i.test(link);
			const syntax: 'wiki' | 'md' = l.original.startsWith('[[') ? 'wiki' : 'md';
			results.push({ original: l.original, link, syntax, isRemote, isEmbed: false, displayText: l.displayText });
			seen.add(l.original);
		}
	}

	REMOTE_MD_IMAGE_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = REMOTE_MD_IMAGE_RE.exec(content)) !== null) {
		const original = m[0];
		const url = m[2];
		if (!url || seen.has(original)) continue;
		results.push({ original, link: url, syntax: 'md', isRemote: true, isEmbed: true });
		seen.add(original);
	}

	return results;
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
	private setMaterializing: (state: boolean) => void;
	private noteLocks?: NoteLockManager;
	private enqueueImageMetadata?: (imagePath: string, sourceNotePath: string) => void;

	constructor(
		app: App,
		settings: CrucibleSettings,
		setMaterializing: (state: boolean) => void,
		noteLocks?: NoteLockManager,
		enqueueImageMetadata?: (imagePath: string, sourceNotePath: string) => void,
	) {
		this.app = app;
		this.settings = settings;
		this.setMaterializing = setMaterializing;
		this.noteLocks = noteLocks;
		this.enqueueImageMetadata = enqueueImageMetadata;
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
		if (isPathExcluded(this.settings, file.path, 'localize')) return true;
		if (file.extension !== 'md') return true;

		const spinner = silent ? null : new Notice(`Localizing attachments in "${file.basename}"...`, 0);

		try {
			return await withOptionalNoteLock(this.noteLocks, file.path, 'localize', () => withMaterializing(this.setMaterializing, async () => {
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
					let updated = replacements.length > 0
						? rewriteLocalizedAttachmentRefs(fresh, replacements).content
						: fresh;
					if (placeholderCount > 0) updated = stripDataUriImagePlaceholders(updated).content;
					if (updated !== fresh) {
						await this.app.vault.modify(file, updated);
					}
				}

				await this.debug(file, `replacements: ${replacements.length} of ${matches.length}, stripped ${placeholderCount} placeholder(s)${replacements.length ? '\n' + replacements.map(r => `- ${r.from} -> ${r.to}`).join('\n') : ''}`);
				spinner?.hide();
				if (!silent) new Notice(`Localized ${replacements.length} of ${matches.length} attachments${placeholderCount ? `, stripped ${placeholderCount} placeholder${placeholderCount > 1 ? 's' : ''}` : ''}`);
				return true;
			}));
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

	private collectMarkdownFiles(folder: TFolder, scope: ExclusionScope): TFile[] {
		const files: TFile[] = [];
		const collect = (current: TFolder) => {
			if (isPathExcluded(this.settings, current.path, scope)) return;
			for (const child of current.children) {
				if (child instanceof TFile && child.extension === 'md') {
					if (!isPathExcluded(this.settings, child.path, scope)) files.push(child);
				} else if (child instanceof TFolder) {
					collect(child);
				}
			}
		};
		collect(folder);
		return files;
	}

	async localizeFolder(folder: TFolder): Promise<boolean> {
		const files = this.collectMarkdownFiles(folder, 'localize');

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

	// Make every attachment embed in `file` resolve again. For each broken ref: re-download if it
	// still points at a remote URL, otherwise recover the already-localized file by basename
	// (preferring the note's expected attachment folder — the inverse of the move-without-rewrite
	// bug). Refs that already resolve are left untouched; unrecoverable ones are reported.
	async repairNote(file: TFile, silent: boolean = false): Promise<{ repaired: number; unrepairable: number } | null> {
		// Repair honors the 'lint' scope, matching repairFolder: fixing broken local
		// links is unrelated to the localization opt-out. This used to return silently —
		// a Repair click on an excluded note looked identical to "nothing was broken".
		// Bulk callers (repairFolder, Repair all) pass silent so this stays quiet at scale.
		if (isPathExcluded(this.settings, file.path, 'lint')) {
			if (!silent) new Notice(`"${file.basename}" is excluded from localize — repair skipped.`);
			return { repaired: 0, unrepairable: 0 };
		}
		if (file.extension !== 'md') return { repaired: 0, unrepairable: 0 };

		const spinner = silent ? null : new Notice(`Repairing attachment links in "${file.basename}"...`, 0);
		try {
			return await withOptionalNoteLock(this.noteLocks, file.path, 'localize', () => withMaterializing(this.setMaterializing, async () => {
				const original = await this.app.vault.read(file);
				const matches = this.parseAttachmentRefs(original, file);
				const expectedFolder = this.attachmentFolderForNote(file);
				const vaultPaths = this.app.vault.getFiles().map(f => f.path);

				const replacements: AttachmentReplacement[] = [];
				// `resolvedCount` is how many broken refs got a repair TARGET computed —
				// not yet how many actually landed on disk. `repaired` (below) is derived
				// from the rewrite pass's own applied set, because a planned replacement
				// whose `from` text doesn't verbatim-match anything in the freshly re-read
				// content is not a success (this is exactly the "Repaired 1" no-op bug: the
				// old embeds-only rewrite regex never found a non-embed link's `from` text,
				// so the write silently did nothing while `repaired` still incremented).
				let resolvedCount = 0;
				let unrepairable = 0;
				for (const match of matches) {
					if (this.app.metadataCache.getFirstLinkpathDest(match.link, file.path) instanceof TFile) continue;
					let newRef: string | null = null;
					let reason: AttachmentRepairFailureReason = 'missing';
					if (match.isRemote) {
						newRef = await this.processRemote(match, file);
						if (!newRef) reason = 'remote-download-failed';
					} else {
						const resolution = resolveLocalAttachmentRepair(match.link, expectedFolder, vaultPaths);
						if (resolution.target) newRef = formatRef(match, resolution.target);
						else reason = resolution.reason ?? 'missing';
					}
					if (newRef) {
						resolvedCount++;
						if (newRef !== match.original) replacements.push({ from: match.original, to: newRef });
					} else {
						unrepairable++;
						await this.debug(file, `repair: ${match.original} -> UNREPAIRABLE (${reason})`);
					}
				}

				let appliedFrom: string[] = [];
				if (replacements.length > 0) {
					const fresh = await this.app.vault.read(file);
					const result = rewriteLocalizedAttachmentRefs(fresh, replacements);
					if (result.content !== fresh) await this.app.vault.modify(file, result.content);
					appliedFrom = result.appliedFrom;
				}

				// A replacement that was planned but did not land is surfaced (debug line)
				// and folded into `unrepairable` rather than silently vanishing from both
				// totals — the note is still broken from the user's point of view.
				const appliedSet = new Set(appliedFrom);
				for (const r of replacements) {
					if (appliedSet.has(r.from)) continue;
					unrepairable++;
					await this.debug(file, `repair: ${r.from} -> UNREPAIRABLE (planned-not-landed)`);
				}
				const repaired = resolvedCount - (replacements.length - appliedFrom.length);

				spinner?.hide();
				if (!silent) new Notice(`Repaired ${repaired} attachment link${repaired === 1 ? '' : 's'}${unrepairable ? `, ${unrepairable} unrepairable` : ''}`);
				return { repaired, unrepairable };
			}));
		} catch (e) {
			spinner?.hide();
			logError(`repair attachments failed (${file.path})`, e);
			if (!silent) new Notice(`Repair failed: ${(e as Error).message}`);
			return null;
		}
	}

	async repairVault(): Promise<boolean> {
		return await this.repairFolder(this.app.vault.getRoot());
	}

	async repairFolder(folder: TFolder): Promise<boolean> {
		// Repair (fixing broken local links) is unrelated to localization opt-out, so
		// it keeps honoring the `lint` scope rather than the new `localize` one.
		const files = this.collectMarkdownFiles(folder, 'lint');
		if (files.length === 0) {
			new Notice('No Markdown files to scan for attachments');
			return true;
		}

		const notice = new Notice(`Repairing attachment links in ${files.length} notes...`, 0);
		let allOk = true;
		let totalRepaired = 0;
		let totalUnrepairable = 0;
		let i = 0;
		for (const file of files) {
			const result = await this.repairNote(file, true);
			if (!result) allOk = false;
			else { totalRepaired += result.repaired; totalUnrepairable += result.unrepairable; }
			i++;
			if (i % 5 === 0) notice.setMessage(`Repairing... (${i}/${files.length})`);
		}
		notice.hide();
		new Notice(`Repair attachments: ${totalRepaired} fixed across ${files.length} notes${totalUnrepairable ? `, ${totalUnrepairable} unrepairable` : ''}`);
		return allOk;
	}

	// Embeds AND managed-attachment links (see parseAttachmentRefsFromCache) — both
	// localizeNote and repairNote consume the same match list, so a broken non-embed
	// link to a managed attachment is visible to repair, not just to the missing-
	// attachments scan.
	parseAttachmentRefs(content: string, file: TFile): AttachmentMatch[] {
		const cache = this.app.metadataCache.getFileCache(file);
		return parseAttachmentRefsFromCache(cache, content);
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
			if (isImage) this.enqueueImageMetadata?.(targetPath, note.path);
			await this.debug(note, `remote ${match.link}: downloaded .${download.ext} -> ${targetPath}`);
			return formatRef(match, targetPath);
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
			if (this.classifyExtension(ext) === 'images') this.enqueueImageMetadata?.(resolved.path, note.path);
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
		// Delete the old file if it moved to a different path — unless another note still
		// references it (copy semantics for shared attachments; see hasOtherAttachmentReferrer).
		if (resolved.path !== newPath) {
			if (hasOtherAttachmentReferrer(this.app.metadataCache.resolvedLinks, resolved.path, note.path)) {
				await this.debug(note, `local ${match.link}: kept ${resolved.path} (still referenced by another note)`);
			} else {
				try { await this.app.fileManager.trashFile(resolved); } catch (e) { logWarn('localize: could not delete old', resolved.path, e); }
			}
		}
		if (isImage) this.enqueueImageMetadata?.(newPath, note.path);
		await this.debug(note, `local ${match.link}: resolved=${resolved.path} -> ${newPath}`);
		return formatRef(match, newPath);
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
		if (isPathExcluded(this.settings, view.file.path, 'localize')) return false;
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
			if (isImage) this.enqueueImageMetadata?.(targetPath, noteFile.path);
			inserts.push(formatEmbed('wiki', targetPath));
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
			// Use vault.rename for the attachment folder so Obsidian does not launch a
			// second, cache-position-based link rewrite while Localize/chain writes are
			// in flight. The moving note's embeds are repointed deterministically below.
			await this.app.vault.rename(existing, newFolder);
			// Obsidian's automatic folder-link rewrite is deliberately bypassed here.
			// The moving note's metadata cache lags during the rename tick, and a
			// concurrent Localize pass may also shorten remote image URLs to local refs;
			// position-based rewrites in that window can splice embeds into prose.
			await withOptionalNoteLock(this.noteLocks, file.path, 'localize', () => withMaterializing(this.setMaterializing, async () => {
				const content = await this.app.vault.read(file);
				const updated = repointAttachmentFolderPrefix(content, oldFolder, newFolder);
				if (updated !== content) await this.app.vault.modify(file, updated);
			}));
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
