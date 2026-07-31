import { SearchChunk, SearchDocumentMetadata, SearchEntity } from './types';

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * Frontmatter fields that name an entity, and the entity type each one produces.
 *
 * `author` is the whole list this sprint, and adding a second row is the *only* change a second
 * frontmatter-sourced facet needs — no schema bump, no companion change, because everything
 * downstream (the chunk field, the `entities` FTS column, the bm25 weight, the `contentHash`
 * fold) is already type-agnostic. The model-sourced half (GLiNER2 over body text) appends to the
 * same `SearchEntity[]` from a different producer and is likewise not a schema event.
 *
 * Deliberately NOT scanned from the note body: the same rule the derived-ID lint keys follow —
 * these are metadata about what the note *is*, not about URLs or names that happen to appear
 * inside it. Body-text extraction is the model source's job, where it is a deliberate, labelled
 * span rather than an incidental substring.
 */
const FRONTMATTER_ENTITY_FIELDS: readonly { key: string; type: string }[] = [
	{ key: 'author', type: 'person' },
];

// Junk tolerance, not tuning. Frontmatter is user-authored text that a web clipper may have
// written, so a pathological `author:` list must cost a bounded number of bytes in every chunk
// of the note rather than an unbounded one. Neither bound is reachable by a real author field.
const MAX_ENTITIES_PER_CHUNK = 32;
const MAX_ENTITY_TEXT_CHARS = 200;

/**
 * Default indexable extensions — exactly the pre-WP-4 hardcoded set, kept as the default
 * parameter below so upgrade behavior is unchanged for any caller that doesn't yet pass
 * the settings-driven list, and so the existing `isSearchIndexablePath('x.md')`-style
 * tests keep passing unmodified.
 */
const DEFAULT_SEARCH_EXTENSIONS = ['md', 'qmd', 'txt'];

/**
 * The heading prefix every image-description chunk carries, and the *entire* contract between
 * the chunker and the results UI's figure indicator (`SearchModal.renderResults`). Deliberately
 * a heading convention rather than a new `SearchChunk` field or a companion column: the chunk
 * shape, the FTS schema and the ranking are all untouched by this facet, so a description chunk
 * is an ordinary chunk that happens to be named after the figure it describes.
 */
export const IMAGE_CHUNK_HEADING_PREFIX = 'Image: ';

/** True for a heading minted by `buildSearchChunks`'s image pass — see the prefix doc. */
export function isImageChunkHeading(heading: string | undefined | null): boolean {
	return typeof heading === 'string' && heading.startsWith(IMAGE_CHUNK_HEADING_PREFIX);
}

/**
 * One described image reaching the chunker. Plain data on purpose — resolving a note's embeds to
 * `_MD5` attachments and those to store records is `SearchManager`'s job (`prepareFile`), because
 * it needs `metadataCache` and plugin state and this module must stay importable standalone.
 *
 * `narrative` and `extraction` are independently optional in practice: an SVG-derived record
 * carries its text in `extraction` with an empty `narrative`, so a one-chunk image is normal.
 */
export interface ImageDescriptionChunkInput {
	/** Display name of the image — the attachment's basename, not a path. */
	filename: string;
	/** One dense paragraph: what the image is and the point it makes. May be empty. */
	narrative: string;
	/** Structured transcription: titles, axis labels, values, table content. May be empty. */
	extraction: string;
}

/**
 * The heading prefix every linked-post chunk carries. Mirrors `IMAGE_CHUNK_HEADING_PREFIX`'s
 * role: a naming convention, not a new `SearchChunk` field — a linked-post chunk is an ordinary
 * chunk that happens to be titled after the post it summarizes.
 */
export const LINKED_POST_HEADING_PREFIX = 'Linked post: ';

/**
 * A cap on how many `x-metadata`/`yt-metadata` targets a single note can contribute chunks for.
 * Junk-tolerance, like `MAX_ENTITIES_PER_CHUNK`: a note stamped with an unbounded number of
 * linked posts (a thread with dozens of X replies, say) must cost a bounded number of extra
 * chunks, not an unbounded one. Enforced twice on purpose — once here (so a caller that hands
 * `buildSearchChunks` more than 8 entries directly still gets a bounded result) and once at
 * `SearchManager`'s assembly step (so reading past the 9th linked note's bytes never happens at
 * all). Both read this one constant.
 */
export const MAX_LINKED_DOCUMENTS_PER_NOTE = 8;

/**
 * One linked post reaching the chunker: a note this note stamp-links via `x-metadata`/
 * `yt-metadata` frontmatter. Plain data, like `ImageDescriptionChunkInput` — resolving the
 * stamps to vault files and reading their bytes is `SearchManager`'s job (it needs
 * `metadataCache`/`vault`), because this module must stay importable standalone.
 */
export interface LinkedDocumentChunkInput {
	/** The linked note's vault path. Not used as the emitted chunk's `path` — a linked-post
	 * chunk carries the *citing* note's identity, exactly like an image-description chunk
	 * carries the embedding note's identity, because a hit is the note a user can act on. */
	path: string;
	/** The linked note's basename — what the `Linked post: ` heading is titled after. */
	title: string;
	/** The linked note's body, frontmatter already sliced off by the caller, trimmed and
	 * length-capped. Empty for a tombstoned metadata note (frontmatter-only, no body) — the
	 * caller drops those before they reach here, but an empty string is tolerated as a no-op
	 * defensively rather than assumed impossible. */
	text: string;
}

export interface BuildChunksInput {
	vaultId: string;
	path: string;
	basename: string;
	extension: string;
	mtime: number;
	content: string;
	contentHash?: string;
	maxChars: number;
	overlapChars: number;
	/**
	 * Described images embedded by this note, already resolved and ordered by the caller. Each
	 * entry appends up to two chunks after the prose sections, through the same monotonic
	 * ordinal counter — see `buildSearchChunks`.
	 */
	imageDescriptions?: ImageDescriptionChunkInput[];
	/**
	 * Linked posts this note stamp-links (`x-metadata`/`yt-metadata`), already resolved, read and
	 * length-capped by the caller. Each entry appends one chunk after the note's own sections and
	 * its image chunks, through the same monotonic ordinal counter — see `buildSearchChunks`.
	 * Default empty so every existing call site and test is unaffected.
	 */
	linkedDocuments?: LinkedDocumentChunkInput[];
	/**
	 * Extra facets for the `contentHash` fallback recompute below. Threaded rather than derived
	 * so the fallback cannot drift from `SearchManager.prepareFile`'s compute: both must fold the
	 * same facets or the stored hash never equals the compared hash and every file re-indexes on
	 * every sweep, forever. Real callers pass `contentHash` too and never reach the fallback;
	 * this exists so the one that doesn't still agrees.
	 */
	extraHashFacets?: string[];
}

/**
 * `chunker.ts` is a pure, settings-free module (unit-tested by bundling it standalone —
 * see `tests/searchChunker.test.mjs`), so the indexable-extensions list is threaded in
 * rather than imported from plugin state. Every real caller passes
 * `plugin.settings.searchIndexExtensions`; the default here only covers call sites (and
 * tests) that don't have settings in scope.
 */
export function isSearchIndexablePath(path: string, extensions: string[] = DEFAULT_SEARCH_EXTENSIONS): boolean {
	const filename = path.split('/').pop() ?? '';
	const dot = filename.lastIndexOf('.');
	if (!(dot > 0 && dot < filename.length - 1)) return false;
	const ext = filename.slice(dot + 1).toLowerCase();
	// Unlike the palette's extension filter, an empty list here means "index nothing" —
	// a user can legitimately uncheck every indexable type. Only an *omitted* argument
	// (call sites with no settings in scope, and legacy tests) falls back to the default.
	return extensions.some(candidate => candidate.toLowerCase() === ext);
}

export function buildSearchChunks(input: BuildChunksInput): SearchChunk[] {
	const maxChars = Math.max(400, input.maxChars || 1800);
	const overlapChars = Math.max(0, Math.min(input.overlapChars || 0, Math.floor(maxChars / 3)));
	const { body, metadata } = parseSearchDocument(input.content, input.basename);
	const contentHash = input.contentHash ?? hashSearchContent(input.content, input.extraHashFacets);
	const sections = splitSections(body);
	const chunks: SearchChunk[] = [];
	// Computed once per note and shared by reference across its chunks: the extraction reads the
	// note's frontmatter, which is a property of the note and not of any one chunk. See the
	// `SearchChunk.entities` doc for why every chunk carries it rather than only chunk 0.
	const entities = extractFrontmatterEntities(metadata.frontmatter);
	let ordinal = 0;

	for (const section of sections) {
		for (const text of chunkText(section.text, maxChars, overlapChars)) {
			const trimmed = text.trim();
			if (!trimmed) continue;
			chunks.push({
				id: stableChunkId(input.vaultId, input.path, ordinal, section.heading),
				vaultId: input.vaultId,
				path: input.path,
				contentHash,
				title: metadata.title,
				heading: section.heading,
				text: trimmed,
				mtime: input.mtime,
				ordinal,
				metadata,
				// Omitted, not `[]`, when the note names no entity — a vault with no `author:`
				// frontmatter therefore sends exactly the payload it sent before this facet.
				...(entities.length > 0 ? { entities } : {}),
			});
			ordinal++;
		}
	}

	// Image descriptions come *after* every prose section and share the same monotonic `ordinal`,
	// which is what keeps `stableChunkId` deterministic: the companion's per-path upsert is a full
	// replace, so a re-chunk of unchanged input must regenerate exactly the ids it deletes.
	// Appending here (rather than interleaving at the embed's position in the body) means adding a
	// description never renumbers a prose chunk.
	//
	// The chunks carry the *note's* path and title like every other chunk — a hit is the note that
	// embeds the figure, never the image file. That is the whole point of describing images into
	// the note's index identity rather than indexing sidecars as documents of their own.
	for (const image of input.imageDescriptions ?? []) {
		const filename = typeof image?.filename === 'string' ? image.filename.trim() : '';
		if (!filename) continue;
		const parts: { heading: string; text: unknown }[] = [
			{ heading: `${IMAGE_CHUNK_HEADING_PREFIX}${filename}`, text: image.narrative },
			{ heading: `${IMAGE_CHUNK_HEADING_PREFIX}${filename} (text)`, text: image.extraction },
		];
		for (const part of parts) {
			const source = typeof part.text === 'string' ? part.text.trim() : '';
			// Emitted only when non-empty: an SVG-derived record has no narrative, and an empty
			// chunk would cost an index row and a vector for nothing.
			if (!source) continue;
			// The same packing prose sections get — an 875-token extracted table must not become
			// one oversized chunk. Multiple slices share the heading and differ by ordinal, which
			// `stableChunkId` folds, so their ids stay distinct.
			for (const text of chunkText(source, maxChars, overlapChars)) {
				const trimmed = text.trim();
				if (!trimmed) continue;
				chunks.push({
					id: stableChunkId(input.vaultId, input.path, ordinal, part.heading),
					vaultId: input.vaultId,
					path: input.path,
					contentHash,
					title: metadata.title,
					heading: part.heading,
					text: trimmed,
					mtime: input.mtime,
					ordinal,
					metadata,
					...(entities.length > 0 ? { entities } : {}),
				});
				ordinal++;
			}
		}
	}

	// Linked-post chunks come last, after prose and image chunks, sharing the same monotonic
	// ordinal — the same full-replace-upsert argument as image descriptions: adding, removing or
	// reordering a stamp must never renumber a chunk that isn't the linked-post one that moved.
	//
	// Truncated defensively to `MAX_LINKED_DOCUMENTS_PER_NOTE` even though `SearchManager` already
	// caps the array it assembles — see that constant's doc.
	//
	// The chunk carries the *citing* note's path/title, never the linked note's — a hit is the
	// thread a user can open, exactly like an image-description chunk names the note that embeds
	// the figure rather than the image file.
	for (const doc of (input.linkedDocuments ?? []).slice(0, MAX_LINKED_DOCUMENTS_PER_NOTE)) {
		const linkedText = typeof doc?.text === 'string' ? doc.text.trim() : '';
		if (!linkedText) continue;
		const linkedTitle = typeof doc?.title === 'string' && doc.title.trim() ? doc.title.trim() : doc.path;
		const heading = `${LINKED_POST_HEADING_PREFIX}${linkedTitle}`;
		for (const text of chunkText(linkedText, maxChars, overlapChars)) {
			const trimmed = text.trim();
			if (!trimmed) continue;
			chunks.push({
				id: stableChunkId(input.vaultId, input.path, ordinal, heading),
				vaultId: input.vaultId,
				path: input.path,
				contentHash,
				title: metadata.title,
				heading,
				text: trimmed,
				mtime: input.mtime,
				ordinal,
				metadata,
				...(entities.length > 0 ? { entities } : {}),
			});
			ordinal++;
		}
	}

	return chunks;
}

/**
 * The note's entity facet, from frontmatter. Tolerant by construction — frontmatter is
 * user-authored and clipper-authored text, so every non-string, blank, over-long or duplicate
 * value is dropped rather than allowed to become a junk index term.
 *
 * Accepts both YAML forms `parseSimpleFrontmatter` can produce for one key: a scalar
 * (`author: Matt Pocock`) and a list (`author:` + `- Matt Pocock` items, or the inline
 * `[a, b]` form). Duplicates are collapsed case-insensitively while the first-seen casing is
 * kept, because the stored text is what a debug view shows a human.
 */
export function extractFrontmatterEntities(frontmatter: Record<string, unknown> | undefined): SearchEntity[] {
	const entities: SearchEntity[] = [];
	const seen = new Set<string>();
	if (!frontmatter || typeof frontmatter !== 'object') return entities;
	for (const field of FRONTMATTER_ENTITY_FIELDS) {
		const raw = frontmatter[field.key];
		const values = Array.isArray(raw) ? raw : [raw];
		for (const value of values) {
			const text = normalizeEntityText(value);
			if (!text) continue;
			// Keyed by type *and* text: the same name legitimately appears under two facets (an
			// author who is also the subject) and those are two entities, not one.
			const key = `${field.type}\n${text.toLowerCase()}`;
			if (seen.has(key)) continue;
			seen.add(key);
			entities.push({ text, type: field.type, source: 'frontmatter' });
			if (entities.length >= MAX_ENTITIES_PER_CHUNK) return entities;
		}
	}
	return entities;
}

/**
 * The flat text the entity facet contributes to the index, and the only part of an entity that
 * reaches FTS this sprint.
 *
 * Deduplicated by text alone — not by `(type, text)` like `extractFrontmatterEntities` — because
 * the index column is untyped: indexing one name twice would double its term frequency and
 * over-rank the note for no reason. The companion's `normalizeChunkEntities` reproduces exactly
 * this rule on the server side, which is what lets the hash computed here and the text stored
 * there stay in agreement (there is no shared module across that boundary: the companion is
 * dependency-free `.mjs`).
 *
 * The `\n` separator matches this file's existing separator convention (`stableChunkId`), and is
 * deliberately not a control byte — see the NUL quirk in the root `AGENTS.md`.
 */
export function entityIndexText(entities: SearchEntity[]): string {
	const texts: string[] = [];
	const seen = new Set<string>();
	for (const entity of entities) {
		const text = normalizeEntityText(entity?.text);
		if (!text) continue;
		const key = text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		texts.push(text);
		if (texts.length >= MAX_ENTITIES_PER_CHUNK) break;
	}
	return texts.join('\n');
}

function normalizeEntityText(value: unknown): string {
	if (typeof value !== 'string' && typeof value !== 'number') return '';
	// Whitespace runs collapse so a multi-line YAML scalar cannot smuggle the `\n` separator
	// `entityIndexText` joins on into a single entity's text.
	return String(value).replace(/\s+/g, ' ').trim().slice(0, MAX_ENTITY_TEXT_CHARS);
}

/**
 * The note's index identity: change it and the note re-indexes, leave it and the coverage-aware
 * skip in `SearchManager.indexFiles` leaves the note exactly as the companion already holds it.
 *
 * **The entity text is folded in on purpose, and it is not redundant with hashing the content.**
 * Hashing the raw content happens to cover an `author:` edit today only because frontmatter is
 * part of `content`; that is an accident of where the hash is taken, not a guarantee, and any
 * future narrowing of the hash to the note *body* would silently strand every author-only edit.
 * Folding the emitted text states the invariant directly: the hash covers everything that gets
 * indexed. It also covers what content alone cannot — a change to the *extraction rule*
 * (a new field in `FRONTMATTER_ENTITY_FIELDS`, a normalization fix, a model source producing
 * different spans) produces different entity text from byte-identical content, and must
 * re-index. Without the fold that change would be invisible to every already-indexed note and
 * the new facet would only ever populate for notes the user happened to edit afterwards.
 *
 * Consequence to expect, once, at landing: this changes the hash of every note in the vault, so
 * the first indexing sweep after the upgrade re-upserts the whole vault. That is not a side
 * effect to be minimized — it is the mechanism that populates the new `entities` column for
 * notes that already exist. (With semantic search on, that sweep re-embeds too; the alternative
 * is a facet that stays empty until each note is next touched.)
 *
 * **`extraFacets` generalizes that argument to facets this module cannot see.** Image
 * descriptions live in a store outside the vault (`imageDescriptionStore.ts`), so a description
 * arriving for an already-indexed note changes what the note contributes to the index while its
 * bytes on disk are untouched — the coverage-aware skip would leave it permanently un-described
 * without this. The caller passes `['image-desc:<combinedDescriptionHash>']`.
 *
 * **An absent or empty `extraFacets` must hash exactly as this function did before the parameter
 * existed**, or landing the image facet would re-index every note in every vault that has no
 * described images at all — the entity fold's one-time vault-wide re-upsert was the population
 * mechanism for a facet every note could carry; this one is not. Hence the `facets.length > 0`
 * guard rather than an unconditional `\nfacets:` suffix. Facets are deduplicated and sorted so
 * the value is a property of the *set*, not of the caller's argument order.
 */
export function hashSearchContent(content: string, extraFacets?: string[]): string {
	const frontmatterText = content.match(FRONTMATTER_RE)?.[1] ?? '';
	// Only the frontmatter block is parsed here, not the whole document: this runs once per file
	// per indexing sweep (`SearchManager.prepareFile`) and the body scan `parseSearchDocument`
	// does for its title fallback would be pure waste on that path.
	const entities = extractFrontmatterEntities(parseSimpleFrontmatter(frontmatterText));
	const base = `${content}\nentities:${entityIndexText(entities)}`;
	const facets = [...new Set((extraFacets ?? [])
		.map(facet => (typeof facet === 'string' ? facet.trim() : ''))
		.filter(Boolean))].sort();
	if (facets.length === 0) return hashString(base);
	return hashString(`${base}\nfacets:${facets.join('\n')}`);
}

/**
 * Slices the leading `---`-delimited frontmatter block off a document, returning only the body.
 * The same detection `parseSearchDocument` uses for its own body/metadata split, factored out so
 * a caller assembling `linkedDocuments` input (`SearchManager`, resolving `x-metadata`/
 * `yt-metadata` targets) can produce plain body text without re-implementing frontmatter
 * detection or reaching into `parseSearchDocument`'s return shape just for the `body` field.
 * `parseSearchDocument` itself is left as-is rather than rewritten in terms of this helper, so
 * the byte-identical-output regression pin on its existing behavior carries zero risk from this
 * change.
 */
export function stripFrontmatterBlock(content: string): string {
	const match = content.match(FRONTMATTER_RE);
	return match ? content.slice(match[0].length) : content;
}

export function parseSearchDocument(content: string, fallbackTitle: string): { body: string; metadata: SearchDocumentMetadata } {
	const fmMatch = content.match(FRONTMATTER_RE);
	const frontmatterText = fmMatch?.[1] ?? '';
	const body = fmMatch ? content.slice(fmMatch[0].length) : content;
	const frontmatter = parseSimpleFrontmatter(frontmatterText);
	const firstHeading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
	const title = stringValue(frontmatter.title) || firstHeading || fallbackTitle;
	const tags = normalizeTags(frontmatter.tags);
	return {
		body,
		metadata: {
			title,
			created: stringValue(frontmatter.created),
			modified: stringValue(frontmatter.modified),
			source: stringValue(frontmatter.source),
			tags,
			frontmatter,
		},
	};
}

function splitSections(body: string): { heading: string; text: string }[] {
	const sections: { heading: string; lines: string[] }[] = [{ heading: '', lines: [] }];
	for (const line of body.split(/\r?\n/)) {
		const heading = line.match(HEADING_RE);
		if (heading) {
			sections.push({ heading: (heading[2] ?? '').trim(), lines: [line] });
		} else {
			const current = sections[sections.length - 1];
			if (current) current.lines.push(line);
		}
	}
	return sections
		.map(section => ({ heading: section.heading, text: section.lines.join('\n').trim() }))
		.filter(section => section.text.length > 0);
}

function chunkText(text: string, maxChars: number, overlapChars: number): string[] {
	if (text.length <= maxChars) return [text];
	const paragraphs = text.split(/\n{2,}/);
	const chunks: string[] = [];
	let current = '';

	for (const paragraph of paragraphs) {
		const next = current ? `${current}\n\n${paragraph}` : paragraph;
		if (next.length <= maxChars) {
			current = next;
			continue;
		}
		if (current) chunks.push(current);
		if (paragraph.length <= maxChars) {
			current = tailOverlap(current, overlapChars);
			current = current ? `${current}\n\n${paragraph}` : paragraph;
		} else {
			for (const slice of sliceLongText(paragraph, maxChars, overlapChars)) chunks.push(slice);
			current = '';
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

function sliceLongText(text: string, maxChars: number, overlapChars: number): string[] {
	const chunks: string[] = [];
	let start = 0;
	while (start < text.length) {
		const end = Math.min(text.length, start + maxChars);
		chunks.push(text.slice(start, end));
		if (end === text.length) break;
		start = Math.max(end - overlapChars, start + 1);
	}
	return chunks;
}

function tailOverlap(text: string, overlapChars: number): string {
	if (!text || overlapChars <= 0) return '';
	return text.slice(Math.max(0, text.length - overlapChars));
}

// The vault id is folded into the hash, not the readable prefix: the id stays
// `path#ordinal:hash` (which is what a `chunkId` in a search result or a debug log shows) while
// two vaults holding the same note at the same path no longer mint the same id. Before this,
// they did — and the companion's upsert conflicted on `id` alone, so indexing vault B silently
// re-labelled vault A's row as B's and a later reset of B took A's data with it. The companion's
// `PRIMARY KEY (vault_id, id)` (schema 5) is the half that makes collisions harmless; this half
// makes them not happen. It needs no migration and no re-index: existing rows keep their old ids,
// stay unique, remain reachable (every lookup that matters is by `(vault_id, path)`), and are
// replaced on the next per-path upsert, which is already a full replace.
function stableChunkId(vaultId: string, path: string, ordinal: number, heading: string): string {
	return `${path}#${ordinal}:${hashString(`${vaultId}\n${path}\n${heading}\n${ordinal}`)}`;
}

function hashString(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

function parseSimpleFrontmatter(text: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!text) return out;
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		const key = match[1] ?? '';
		const raw = (match[2] ?? '').trim();
		if (!key) continue;
		if (raw === '') {
			const values: string[] = [];
			while (i + 1 < lines.length) {
				const nextLine = lines[i + 1];
				if (nextLine === undefined) break;
				const item = nextLine.match(/^\s*-\s+(.+)$/);
				if (!item) break;
				values.push(unquote((item[1] ?? '').trim()));
				i++;
			}
			out[key] = values.length > 0 ? values : '';
		} else if (raw.startsWith('[') && raw.endsWith(']')) {
			out[key] = raw.slice(1, -1).split(',').map(v => unquote(v.trim())).filter(Boolean);
		} else {
			out[key] = unquote(raw);
		}
	}
	return out;
}

function normalizeTags(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(v => String(v).replace(/^#/, '').trim()).filter(Boolean);
	if (typeof value === 'string') {
		return value.split(/[,\s]+/).map(v => v.replace(/^#/, '').trim()).filter(Boolean);
	}
	return [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function unquote(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}
