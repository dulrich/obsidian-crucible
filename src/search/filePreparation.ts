import { App, TFile } from 'obsidian';
import { CrucibleSettings } from '../types';
import {
	buildSearchChunks,
	hashSearchContent,
	ImageDescriptionChunkInput,
	LinkedDocumentChunkInput,
	MAX_LINKED_DOCUMENTS_PER_NOTE,
	stripFrontmatterBlock,
} from './chunker';
import type { ImageDescriptionStore } from './imageDescriptionStore';
import { localizedImageInfo } from '../orchestration/utils/imageMetadata';
import { SearchChunk } from './types';

// Each linked post (`x-metadata`/`yt-metadata` target) is read in full and capped to this many
// characters before it reaches the chunker. Bounds the cost of one stamp on a note that links a
// disproportionately long metadata note (an X thread's full quoted-reply chain, say) — sized well
// above a normal post's body so real content is never truncated in practice, while still bounding
// the worst case to a handful of chunks rather than an unbounded one.
const LINKED_DOCUMENT_MAX_CHARS = 4000;

/**
 * Everything the file-preparation subsystem needs from its host, and nothing else.
 *
 * `SearchManager` owns all four and rebuilds this object per call rather than caching it, because
 * `imageDescriptions` is injected after construction (`setImageDescriptionStore`) and `isExcluded`
 * closes over live settings — a context captured once would pin whichever values existed at
 * construction time. Everything here is a read; the subsystem never writes to the vault, the
 * companion, or the store.
 *
 * `isExcluded` stays a *callback* rather than being reimplemented here on purpose:
 * `SearchManager.isExcludedFromIndex` is the single predicate `prepareFile`, `deletePath` and
 * `listIndexableFiles` all share, and duplicating it in this module is exactly the drift that
 * predicate exists to prevent.
 */
export interface SearchFilePreparationContext {
	app: App;
	settings: CrucibleSettings;
	imageDescriptions: ImageDescriptionStore | null;
	isExcluded: (path: string) => boolean;
}

export interface PreparedSearchFile {
	file: TFile;
	content: string;
	contentHash: string;
	/**
	 * Resolved once in `prepareSearchFile` (the async half) and carried to
	 * `buildPreparedSearchFileChunks` (the sync half) rather than re-resolved there — store reads
	 * are async and chunk building is not, and the skip path must be able to compare the folded
	 * hash *without* paying for chunk construction.
	 */
	imageDescriptions?: ImageDescriptionChunkInput[];
	/**
	 * Resolved once in `prepareSearchFile` for the same reason as `imageDescriptions` —
	 * `metadataCache`/`vault.cachedRead` reads are async, chunk building is not.
	 */
	linkedDocuments?: LinkedDocumentChunkInput[];
	/** The facets folded into `contentHash`; threaded on so the chunker's fallback can't drift. */
	hashFacets?: string[];
}

/**
 * Every raw `x-metadata`/`yt-metadata` frontmatter value on a note, in stamp order —
 * `x-metadata` first (a list, appended to in stamp order, but tolerating the legacy scalar shape
 * a hand-authored or pre-list-format note might carry), then `yt-metadata` (normally a scalar,
 * but a defensively-tolerated array reads the same way `firstYtMetadataLink` in `youtubeApi.ts`
 * does). Callers strip wikilink syntax and resolve separately — this only decides *which* raw
 * values exist and in what order, which is what "first listed wins" (the 8-target cap) reads off.
 */
function collectLinkedMetadataLinkpaths(fm: Record<string, unknown>): string[] {
	const raw: string[] = [];
	for (const key of ['x-metadata', 'yt-metadata']) {
		const value = fm[key];
		if (Array.isArray(value)) {
			for (const v of value) if (typeof v === 'string' && v.trim()) raw.push(v);
		} else if (typeof value === 'string' && value.trim()) {
			raw.push(value);
		}
	}
	const linkpaths: string[] = [];
	for (const value of raw) {
		const linkpath = stripWikilink(value);
		if (linkpath) linkpaths.push(linkpath);
	}
	return linkpaths;
}

/**
 * `[[path|alias]]` / `[[path#heading]]` -> `path`; a bare (unbracketed) legacy string passes
 * through unchanged. Copied from `XBackfillWorkflow.stripWikilink` rather than imported — the
 * search module must not depend on `src/orchestration/**`, and this is a two-line regex, not a
 * shared-module-worthy abstraction.
 */
function stripWikilink(raw: string): string {
	const trimmed = raw.trim().replace(/^\[\[/, '').replace(/\]\]$/, '');
	return trimmed.split('|')[0]?.split('#')[0]?.trim() ?? '';
}

/**
 * A note's described images, resolved from its embeds through the `_MD5` naming convention
 * into store records.
 *
 * Three properties this must have, in order of how expensive getting them wrong is:
 *
 * 1. **The facet describes exactly what is emitted.** Only records that actually produce a
 *    chunk (some narrative or some extraction) contribute to the combined hash — a record that
 *    emits nothing must not move the hash, or the note re-indexes to write the same chunks.
 * 2. **Deterministic.** Images are deduplicated by md5 and sorted by it, so the same note in
 *    the same state always yields the same chunk order, hence the same `stableChunkId`s, hence
 *    a full-replace upsert that regenerates exactly what it deletes.
 * 3. **Undescribed images are invisible.** `store.has` gates the lookup, so a note full of
 *    never-described figures hashes and chunks exactly as it does today (`combinedDescriptionHash`
 *    would skip them anyway — this just avoids the reads).
 */
async function resolveImageDescriptions(
	ctx: SearchFilePreparationContext,
	file: TFile,
): Promise<{ descriptions: ImageDescriptionChunkInput[]; facets: string[] }> {
	const empty = { descriptions: [], facets: [] };
	const store = ctx.imageDescriptions;
	if (!store) return empty;
	const embeds = ctx.app.metadataCache.getFileCache(file)?.embeds;
	if (!embeds || embeds.length === 0) return empty;
	await store.ensureLoaded();

	// Same embed-walking shape as `AttachmentLocalizer.parseAttachmentRefs`: the metadata cache
	// is the source of truth for what a note embeds, and a remote (still-unlocalized) ref has no
	// content md5 to key a description on.
	const md5s = new Map<string, string>();
	for (const embed of embeds) {
		const link = embed?.link ?? '';
		if (!link || /^https?:\/\//i.test(link)) continue;
		const dest = ctx.app.metadataCache.getFirstLinkpathDest(link, file.path);
		const info = localizedImageInfo(dest?.path ?? link);
		if (!info || md5s.has(info.md5)) continue;
		if (!store.has(info.md5)) continue;
		md5s.set(info.md5, info.path.split('/').pop() ?? info.path);
	}
	if (md5s.size === 0) return empty;

	const descriptions: ImageDescriptionChunkInput[] = [];
	const emitted: string[] = [];
	for (const md5 of [...md5s.keys()].sort()) {
		const record = await store.get(md5);
		if (!record) continue;
		// idh-WP-1: a failure record must emit no chunks and no facet — its arrival must not
		// move any note's contentHash. Explicit kind check rather than relying on the
		// (also-true) empty-narrative/-extraction fields below, since the facet contract this
		// guards is load-bearing enough to not depend on an incidental coincidence.
		if (record.kind === 'failed') continue;
		const narrative = record.narrative.trim();
		const extraction = record.extraction.trim();
		if (!narrative && !extraction) continue;
		descriptions.push({ filename: md5s.get(md5) ?? md5, narrative, extraction });
		emitted.push(md5);
	}
	if (descriptions.length === 0) return empty;
	return { descriptions, facets: [`image-desc:${store.combinedDescriptionHash(emitted)}`] };
}

/**
 * A note's linked posts — the `x-metadata`/`yt-metadata` stamps `XMetadataFetchWorkflow` /
 * `linkMetadataToNote` write, resolved to vault files and read.
 *
 * This is the WP-PF3 facet: a source note's only matching text for a query about the *content*
 * of a post it links is otherwise the `_x_metadata`/`_yt_metadata` note itself — which has zero
 * relationship to the source note in any ranking leg beyond the client-side link-boost reorder
 * (`linkGraph.ts`), and that boost can't add a candidate that never matched anything. Emitting
 * the linked note's own body as an ordinary chunk on the *citing* note puts it in the FTS,
 * coverage and vector candidate sets for free — no companion change, no schema bump.
 *
 * Three properties mirrored from `resolveImageDescriptions`, in the same order of how
 * expensive getting them wrong is:
 *
 * 1. **The facet describes exactly what is emitted.** A tombstoned metadata note (X: frontmatter
 *    -only, `state: unavailable`, empty body) resolves to empty text after the frontmatter
 *    slice — it contributes neither a chunk nor a facet, so it can never move the source note's
 *    hash for nothing.
 * 2. **Deterministic.** The cap is applied to the *raw stamp list*, before resolution — "first
 *    listed wins" reads directly off `x-metadata`'s (then `yt-metadata`'s) frontmatter order,
 *    not off which targets happen to resolve.
 * 3. **Unresolved targets are silently dropped**, same as `XBackfillWorkflow`'s source-path
 *    resolution — a stamp can outlive the note it points at.
 */
async function resolveLinkedDocuments(
	ctx: SearchFilePreparationContext,
	file: TFile,
): Promise<{ documents: LinkedDocumentChunkInput[]; facets: string[] }> {
	const empty = { documents: [], facets: [] };
	// Optional-called (not `ctx.app.metadataCache.getFileCache(file)`): existing test doubles
	// for `SearchManager` (e.g. `tests/searchManagerHash.test.mjs`) stub `metadataCache` with
	// only `isUserIgnored`, since `resolveImageDescriptions` never reaches `getFileCache` when
	// no image-description store is wired. A real Obsidian `MetadataCache` always has the
	// method; this only changes behavior for a stub that omits it, where "no frontmatter seen"
	// (empty linked-post facet) is exactly the right degrade.
	const fm = ctx.app.metadataCache.getFileCache?.(file)?.frontmatter;
	if (!fm) return empty;
	const linkpaths = collectLinkedMetadataLinkpaths(fm).slice(0, MAX_LINKED_DOCUMENTS_PER_NOTE);
	if (linkpaths.length === 0) return empty;

	const documents: LinkedDocumentChunkInput[] = [];
	const facets: string[] = [];
	for (const linkpath of linkpaths) {
		const dest = ctx.app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
		if (!dest) continue;
		const raw = await ctx.app.vault.cachedRead(dest);
		const text = stripFrontmatterBlock(raw).trim().slice(0, LINKED_DOCUMENT_MAX_CHARS);
		if (!text) continue;
		documents.push({ path: dest.path, title: dest.basename, text });
		// Reusing `hashSearchContent` on the linked note's own (already frontmatter-stripped)
		// text is deliberate rather than a second hash function: it's the same "identity of a
		// document" primitive this module already imports, applied to a smaller document. The
		// path is folded in alongside the hash so two different linked notes whose bodies happen
		// to collide byte-for-byte still each move the citing note's hash independently.
		facets.push(`linked:${dest.path}:${hashSearchContent(text)}`);
	}
	if (documents.length === 0) return empty;
	return { documents, facets };
}

/**
 * Read one file and resolve everything the chunker needs from it, without touching the companion.
 * `null` for a path excluded from the index.
 *
 * The two facet resolutions are **independent reads of different sources** — the image-description
 * store plus the note's embeds on one side, the metadata cache plus the linked targets'
 * `cachedRead`s on the other — and neither observes the other's result, so they are awaited
 * together. That is a concurrency change only: the merge below composes them in a fixed
 * images-then-linked order regardless of which settles first, so the folded facet array (and
 * therefore `contentHash`, and therefore every `stableChunkId`) is byte-identical to the previous
 * sequential shape. `hashSearchContent` is a second, independent net under that — it trims,
 * de-duplicates and sorts the facets before folding — but the fixed merge order is what this
 * module is responsible for, and `tests/searchFilePreparation.test.mjs` pins both layers rather
 * than leaning on the chunker's sort. If a third facet source is ever added, it joins this
 * `Promise.all` and takes a fixed position in the merge — never an arrival-ordered one.
 *
 * What concurrency genuinely could perturb, and therefore must not: each resolver's *own* internal
 * ordering — image descriptions sorted by md5, linked documents walked in raw-stamp order so
 * "first listed wins" decides the eight-target cap. Both stay sequential inside their own loops on
 * purpose; parallelizing either one would make chunk order (hence every `stableChunkId`) depend on
 * read latency.
 */
export async function prepareSearchFile(
	ctx: SearchFilePreparationContext,
	file: TFile,
): Promise<PreparedSearchFile | null> {
	if (ctx.isExcluded(file.path)) return null;
	const content = await ctx.app.vault.read(file);
	const [images, linked] = await Promise.all([
		resolveImageDescriptions(ctx, file),
		resolveLinkedDocuments(ctx, file),
	]);
	const hashFacets = [...images.facets, ...linked.facets];
	return {
		file,
		content,
		// `hashSearchContent(content, [])` is `hashSearchContent(content)` by construction, so a
		// note with no described images and no linked posts keeps the exact hash it had before
		// either facet existed, and the coverage-aware skip is preserved untouched. Either facet
		// arriving moves the combined array, moves the hash, and re-indexes the note once — that
		// is the mechanism, and without it the note would be skipped forever with its
		// figures/linked posts never indexed.
		contentHash: hashSearchContent(content, hashFacets),
		imageDescriptions: images.descriptions,
		linkedDocuments: linked.documents,
		hashFacets,
	};
}

/**
 * The sync half: turn a prepared file into the chunks the index actually stores. Kept separate
 * from `prepareSearchFile` because the coverage-aware skip in `SearchManager.indexFiles` compares
 * the prepared `contentHash` and must be able to bail *before* paying for chunk construction.
 */
export function buildPreparedSearchFileChunks(
	ctx: SearchFilePreparationContext,
	prepared: PreparedSearchFile,
): SearchChunk[] {
	const { file, content, contentHash } = prepared;
	return buildSearchChunks({
		vaultId: ctx.settings.searchVaultId,
		path: file.path,
		basename: file.basename,
		extension: file.extension,
		mtime: file.stat.mtime,
		content,
		contentHash,
		maxChars: ctx.settings.searchChunkMaxChars,
		overlapChars: ctx.settings.searchChunkOverlapChars,
		...(prepared.imageDescriptions?.length ? { imageDescriptions: prepared.imageDescriptions } : {}),
		...(prepared.linkedDocuments?.length ? { linkedDocuments: prepared.linkedDocuments } : {}),
		...(prepared.hashFacets?.length ? { extraHashFacets: prepared.hashFacets } : {}),
	});
}
