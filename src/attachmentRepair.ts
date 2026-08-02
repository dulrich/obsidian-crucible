// Pure attachment reference/repair domain, extracted from src/localizeAttachments.ts.
//
// Everything here is side-effect-free and dependency-free — no `obsidian` import, no `App`,
// no `Notice`, no vault I/O. It owns the shapes and decisions that both the localizer
// (src/localizeAttachments.ts, the vault/download/write coordinator) and the Ingestion
// scans (src/ingestion/data/missingAttachments.ts, .../orphanedAttachments.ts) share:
// ref parsing/formatting, the managed-attachment (`..._MD5.ext`) predicate, the per-scan
// AttachmentPathIndex, and the three-tier local repair resolution. Keep it pure — the
// scans drive it directly in tests without an Obsidian stub, and the ref-rewrite
// chokepoint's invariants are only checkable because nothing here touches the vault.

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

// Per-scan lookup structure built once from a vault path snapshot (`buildAttachmentPathIndex`)
// and consumed by `resolveLocalAttachmentRepair` in place of the naive per-row full-vault
// `Array.includes`/`filter` passes. Three fields, one per repair tier:
//   - `byPath`: exact-path membership (tier 1, the note's expected folder) — was `.includes`.
//   - `byBasename`: exact-basename -> candidate paths (tier 2) — was `.filter` + `.split('/')`.
//   - `managedByStem`: every managed (`..._MD5.ext`) path's hash "stem" (the portion before
//     `_MD5.ext`), SORTED ascending by stem, for tier 3's prefix-recovery scan. Lexicographic
//     sort makes every string sharing a given prefix occupy one contiguous run, so
//     `stemPrefixMatches` below finds it with a binary-search lower bound + linear walk over
//     just the matches, instead of a regex-per-path scan across the entire vault.
// Building the index is itself O(n) in the path count — the win is amortizing that single pass
// across every broken row in a scan, instead of re-scanning per row (O(rows) lookups afterward
// instead of O(rows * n)).
export interface AttachmentPathIndex {
	byPath: Set<string>;
	byBasename: Map<string, string[]>;
	managedByStem: { stem: string; path: string }[];
}

const MANAGED_STEM_RE = /^(.*)_MD5\.[A-Za-z0-9]+$/;

export function buildAttachmentPathIndex(vaultPaths: string[]): AttachmentPathIndex {
	const byPath = new Set<string>(vaultPaths);
	const byBasename = new Map<string, string[]>();
	const managedByStem: { stem: string; path: string }[] = [];
	for (const p of vaultPaths) {
		const base = p.split('/').pop() ?? p;
		const existing = byBasename.get(base);
		if (existing) existing.push(p);
		else byBasename.set(base, [p]);
		const stemMatch = MANAGED_STEM_RE.exec(base);
		if (stemMatch) managedByStem.push({ stem: stemMatch[1] ?? '', path: p });
	}
	managedByStem.sort((a, b) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0));
	return { byPath, byBasename, managedByStem };
}

// Binary-search lower bound (first index whose stem is >= `prefix`), then walk forward while
// the stem still starts with `prefix` — safe because sorted order groups every string sharing
// a prefix into one contiguous run (see the comment on AttachmentPathIndex above).
function stemPrefixMatches(index: AttachmentPathIndex, prefix: string): string[] {
	const arr = index.managedByStem;
	let lo = 0, hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((arr[mid]?.stem ?? '') < prefix) lo = mid + 1;
		else hi = mid;
	}
	const out: string[] = [];
	for (let i = lo; i < arr.length; i++) {
		const entry = arr[i];
		if (!entry || !entry.stem.startsWith(prefix)) break;
		out.push(entry.path);
	}
	return out;
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
// `index`, when supplied (`buildAttachmentPathIndex(vaultPaths)`, built ONCE per scan/repair
// pass by the caller), replaces each tier's full-vault `Array.includes`/`filter` pass with a
// Set/Map/binary-search lookup — same decisions, cheaper per row. Omitting it preserves the
// original O(n)-per-row naive behavior byte-for-byte (existing callers that pass only 3 args
// are unaffected); see tests/localizeAttachments.edge.test.mjs's index-vs-naive equivalence
// coverage for the "byte-identical decisions" guarantee.
export function resolveLocalAttachmentRepair(brokenLink: string, expectedFolder: string, vaultPaths: string[], index?: AttachmentPathIndex): LocalAttachmentRepairResolution {
	// Decode mirrors normalizeRefTargetForResolve (src/ingestion/data/missingAttachments.ts):
	// strip a #fragment/|alias suffix FIRST, then the <...> wrapper, then %-decode. The scan
	// probe and this resolver must normalize identically — a `#`-suffixed target that the
	// probe strips but the resolver keeps fails the end-anchored MD5_NAME_RE/MANAGED_STEM_RE
	// and falls through to a spurious `missing`.
	let decoded = brokenLink.split('#')[0]?.split('|')[0] ?? '';
	decoded = decoded.replace(/^<|>$/g, '');
	try { decoded = decodeURIComponent(decoded); } catch { /* leave as-is on malformed escapes */ }
	const base = decoded.split('/').pop() ?? '';
	if (!base) return { target: null, reason: 'missing' };

	const expected = expectedFolder ? `${expectedFolder}/${base}` : base;
	const hasExpected = index ? index.byPath.has(expected) : vaultPaths.includes(expected);
	if (hasExpected) return { target: expected, reason: null };

	const exactMatches = index
		? (index.byBasename.get(base) ?? [])
		: vaultPaths.filter(p => (p.split('/').pop() ?? p) === base);
	if (exactMatches.length === 1) return { target: exactMatches[0] ?? null, reason: null };
	if (exactMatches.length > 1) {
		if (MD5_NAME_RE.test(base)) return { target: pickAmongIdenticalContent(exactMatches, expectedFolder), reason: null };
		return { target: null, reason: 'ambiguous' };
	}

	const stemMatch = MANAGED_STEM_RE.exec(base);
	const stem = stemMatch ? (stemMatch[1] ?? '') : null;
	if (stem !== null && stem.length >= PREFIX_REPAIR_MIN_STEM_LENGTH) {
		const prefixMatches = index
			? stemPrefixMatches(index, stem)
			: vaultPaths.filter(p => {
				const name = p.split('/').pop() ?? p;
				const nameStemMatch = MANAGED_STEM_RE.exec(name);
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
export function planLocalAttachmentRepair(brokenLink: string, expectedFolder: string, vaultPaths: string[], index?: AttachmentPathIndex): string | null {
	return resolveLocalAttachmentRepair(brokenLink, expectedFolder, vaultPaths, index).target;
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
