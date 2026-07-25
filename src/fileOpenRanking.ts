/**
 * fileOpenRanking.ts — the columnar snapshot and the per-keystroke selection core
 * behind the Crucible file-open palette.
 *
 * Three pieces, in the order the palette uses them:
 *
 * 1. `FileOpenSnapshot` — a columnar, typed-array view of the vault built once and
 *    maintained incrementally (`applyFileOpenDeltas`, `recomputeIgnoredFlags`). Every
 *    per-keystroke field the scorer needs is precomputed: lowercased path, basename
 *    offset, depth, interned extension id, char-class masks, mtime. Nothing is
 *    re-derived inside the hot loop and nothing is re-derived inside a comparator.
 * 2. `selectFileOpenItems` — mask prefilter -> filters -> `scoreText` -> top-K min-heap,
 *    over a *narrowing stack* that makes each additional keystroke O(survivors).
 * 3. `buildFileOpenMatch` — highlight ranges, for the <=100 winners only.
 *
 * Scores come from `./rankScore`, which documents the convention: **higher is better**.
 * There is deliberately no scorer injection point on the options — the previous one is
 * what let a lower-is-better test double certify an inverted sort into production.
 *
 * Like `rankScore.ts`, this module must never import from `obsidian`: the unit tests
 * bundle it with esbuild and import it in bare Node. Its only dependency is
 * `./exclusions`, which reaches `./types` and stops there.
 */

import { normalizeExcludedFolder } from './exclusions';
import {
	CompiledQuery,
	MODIFIER_CLAMP,
	buildRanges,
	compileQuery,
	computeMaskRange,
	maskAccepts,
	scoreText,
} from './rankScore';

export type CrucibleFileOpenIgnoredFolderMode = 'include' | 'derank' | 'hide';

export interface FileOpenCandidate {
	path: string;
	extension?: string;
	mtime?: number;
}

export interface FileOpenFileItem {
	kind: 'file';
	path: string;
	extension: string;
	ignored: boolean;
	score: number | null;
}

export interface FileOpenCreateItem {
	kind: 'create';
	path: string;
}

export type FileOpenItem = FileOpenFileItem | FileOpenCreateItem;

/**
 * Structurally compatible with Obsidian's `SearchResult`, declared locally on purpose:
 * `renderResults` only reads `{ score, matches }`, and `SearchResult` is an interface,
 * so satisfying it structurally keeps this module free of an `obsidian` import.
 */
export interface FileOpenMatch {
	score: number;
	matches: [number, number][];
}

/** Row is under a folder excluded for the `search` scope. */
export const FILE_OPEN_FLAG_IGNORED = 1;
/** Row was deleted; skipped by every scan until the next compaction. */
export const FILE_OPEN_FLAG_TOMBSTONE = 2;

/** Default number of rows the palette shows. */
export const FILE_OPEN_LIMIT = 100;

/**
 * Recency bonus ceiling, applied by `selectFileOpenItems` on top of the scorer's output.
 *
 * The bound is the design: `RECENCY_MAX + 2 * MODIFIER_CLAMP` (158) is less than
 * `TIER_SUBSTR - TIER_FUZZY` (200), so a maximally-recent fuzzy match can never be
 * promoted above a never-opened contiguous substring match. Recency reorders results;
 * it does not rewrite the ranking model.
 */
export const RECENCY_MAX = 60;

/**
 * Folded into the heap key (not the reported score) so deranked rows sort as one block
 * below every normal row and can never interleave. Exceeds the entire tier range.
 */
const DERANK_PENALTY_SCORED = 5000;
/** Same idea for the empty-query ordering, whose keys live on a different scale. */
const DERANK_PENALTY_EMPTY = 1e12;

/** Max narrowing frames kept; beyond this the memory is not worth the saved scans. */
const NARROW_MAX_DEPTH = 8;

/** Compact once tombstones exceed this fraction of the used prefix. */
const COMPACT_TOMBSTONE_RATIO = 0.1;

/**
 * The columnar vault snapshot.
 *
 * `size` is the used prefix of every column; the typed arrays are allocated at capacity
 * and grown by doubling. `paths`/`lower` are plain arrays because they hold strings, but
 * they are index-aligned with the typed columns for `[0, size)`.
 */
export interface FileOpenSnapshot {
	/** Normalized (slash-collapsed, trimmed) vault paths. */
	paths: string[];
	/** `paths[i].toLowerCase()` — the coordinate system every match index refers to. */
	lower: string[];
	/** Index of the basename inside `lower[i]`. */
	nameStart: Int32Array;
	/** Length of the basename. */
	nameLen: Uint16Array;
	/** Length of the full path. */
	pathLen: Uint16Array;
	/** Number of `/` in the path. */
	depth: Uint8Array;
	/** Interned extension id; resolve through `extNames`. */
	extId: Uint16Array;
	/** Extension string -> id. */
	extIds: Map<string, number>;
	/** id -> extension string. */
	extNames: string[];
	/** Char-class mask of the full lowercased path. */
	maskPath: Uint32Array;
	/** Char-class mask of the basename. */
	maskName: Uint32Array;
	/** `FILE_OPEN_FLAG_*` bits. */
	flags: Uint8Array;
	/** File mtime in ms; 0 when unknown. */
	mtime: Float64Array;
	/** Lowercased path -> row index, for the create-row existence check. */
	byLower: Map<string, number>;
	/** Cheap signature of the exclusion config the `IGNORED` flags were computed from. */
	exclusionSig: string;
	/** Used prefix length. */
	size: number;
	/** Tombstoned rows inside `[0, size)`. */
	tombstones: number;
	/**
	 * Bumped on every *structural* change (append, delete, compaction) and never on a
	 * flags-only recompute. A `NarrowState` holding row ids is valid exactly while this
	 * does not move.
	 */
	version: number;
}

export interface BuildFileOpenSnapshotOptions {
	/** Predicate for the `IGNORED` flag; defaults to "nothing is ignored". */
	isIgnoredPath?: (path: string) => boolean;
	/** Signature of the exclusion config, so `getSnapshot()` can detect drift cheaply. */
	exclusionSig?: string;
	/** Append into this snapshot instead of creating one — the chunked-build path. */
	into?: FileOpenSnapshot;
	/** First candidate index to ingest (inclusive). */
	from?: number;
	/** Last candidate index to ingest (exclusive). */
	to?: number;
}

/** An empty snapshot, ready to be filled by `buildFileOpenSnapshot`. */
export function createFileOpenSnapshot(exclusionSig = ''): FileOpenSnapshot {
	return {
		paths: [],
		lower: [],
		nameStart: new Int32Array(0),
		nameLen: new Uint16Array(0),
		pathLen: new Uint16Array(0),
		depth: new Uint8Array(0),
		extId: new Uint16Array(0),
		extIds: new Map<string, number>(),
		extNames: [],
		maskPath: new Uint32Array(0),
		maskName: new Uint32Array(0),
		flags: new Uint8Array(0),
		mtime: new Float64Array(0),
		byLower: new Map<string, number>(),
		exclusionSig,
		size: 0,
		tombstones: 0,
		version: 0,
	};
}

/**
 * Build (or extend) a snapshot from plain candidate records.
 *
 * Deliberately takes `{ path, extension?, mtime? }[]` plus an `isIgnoredPath` predicate
 * rather than Obsidian `TFile`s, so the module stays obsidian-free and unit-testable.
 * Pass `into` + `from`/`to` to drive the build in chunked slices across animation frames.
 */
export function buildFileOpenSnapshot(
	candidates: FileOpenCandidate[],
	options: BuildFileOpenSnapshotOptions = {},
): FileOpenSnapshot {
	const snapshot = options.into ?? createFileOpenSnapshot(options.exclusionSig ?? '');
	if (options.into !== undefined && options.exclusionSig !== undefined) snapshot.exclusionSig = options.exclusionSig;
	const from = Math.max(0, options.from ?? 0);
	const to = Math.min(candidates.length, options.to ?? candidates.length);
	if (to <= from) return snapshot;

	ensureCapacity(snapshot, snapshot.size + (to - from));
	const isIgnored = options.isIgnoredPath;
	for (let i = from; i < to; i++) {
		const candidate = candidates[i]!;
		appendRow(snapshot, candidate, isIgnored);
	}
	snapshot.version++;
	return snapshot;
}

export type FileOpenDelta =
	| { kind: 'add'; path: string; extension?: string; mtime?: number }
	| { kind: 'del'; path: string };

export interface ApplyFileOpenDeltasOptions {
	isIgnoredPath?: (path: string) => boolean;
}

/**
 * Apply incremental vault events. `add` appends (or refreshes an existing row), `del`
 * sets a tombstone; the snapshot compacts once tombstones pass
 * `COMPACT_TOMBSTONE_RATIO` of the used prefix.
 *
 * A rename is a `del` of the old path plus an `add` of the new one — the same shape the
 * vault emits, and the shape `tests/fileOpenPalette.test.mjs` asserts converges on a
 * fresh full build.
 */
export function applyFileOpenDeltas(
	snapshot: FileOpenSnapshot,
	deltas: FileOpenDelta[],
	options: ApplyFileOpenDeltasOptions = {},
): FileOpenSnapshot {
	if (deltas.length === 0) return snapshot;
	const isIgnored = options.isIgnoredPath;
	let added = 0;
	for (const delta of deltas) if (delta.kind === 'add') added++;
	if (added > 0) ensureCapacity(snapshot, snapshot.size + added);

	// Strictly in order: a queue can legitimately hold del(p), add(p), del(p), add(p)
	// for one path (rename away and back), and batching the deletes ahead of the adds
	// would silently collapse that into the wrong final state.
	for (const delta of deltas) {
		if (delta.kind === 'del') {
			removeRow(snapshot, delta.path);
			continue;
		}
		const normalized = normalizeFileOpenPath(delta.path);
		const key = normalized.toLowerCase();
		const existing = snapshot.byLower.get(key);
		if (existing !== undefined) {
			// Same path re-added (a metadata refresh): update in place rather than
			// growing a duplicate row that the create-row lookup would then disagree with.
			snapshot.mtime[existing] = delta.mtime ?? 0;
			snapshot.extId[existing] = internExtension(snapshot, delta.extension ?? fileExtension(normalized));
			setIgnoredFlag(snapshot, existing, isIgnored);
			continue;
		}
		appendRow(snapshot, delta, isIgnored);
	}
	snapshot.version++;
	if (snapshot.size > 0 && snapshot.tombstones > snapshot.size * COMPACT_TOMBSTONE_RATIO) {
		compactFileOpenSnapshot(snapshot);
	}
	return snapshot;
}

/**
 * Drop tombstoned rows and re-pack every column.
 *
 * Extension ids are re-interned from scratch so a compacted snapshot is byte-identical
 * to a fresh full build over the same surviving paths in the same order — that identity
 * is what the delta-equivalence test checks, and it is the cheapest available guard
 * against incremental-index drift.
 */
export function compactFileOpenSnapshot(snapshot: FileOpenSnapshot): FileOpenSnapshot {
	if (snapshot.tombstones === 0) return snapshot;
	const paths: string[] = [];
	const kept: number[] = [];
	for (let i = 0; i < snapshot.size; i++) {
		if ((snapshot.flags[i]! & FILE_OPEN_FLAG_TOMBSTONE) !== 0) continue;
		kept.push(i);
		paths.push(snapshot.paths[i]!);
	}

	const size = kept.length;
	const capacity = capacityFor(size);
	const nameStart = new Int32Array(capacity);
	const nameLen = new Uint16Array(capacity);
	const pathLen = new Uint16Array(capacity);
	const depth = new Uint8Array(capacity);
	const extId = new Uint16Array(capacity);
	const maskPath = new Uint32Array(capacity);
	const maskName = new Uint32Array(capacity);
	const flags = new Uint8Array(capacity);
	const mtime = new Float64Array(capacity);
	const lower: string[] = [];
	const byLower = new Map<string, number>();

	const previousExtNames = snapshot.extNames;
	snapshot.extIds = new Map<string, number>();
	snapshot.extNames = [];

	for (let i = 0; i < size; i++) {
		const src = kept[i]!;
		nameStart[i] = snapshot.nameStart[src]!;
		nameLen[i] = snapshot.nameLen[src]!;
		pathLen[i] = snapshot.pathLen[src]!;
		depth[i] = snapshot.depth[src]!;
		extId[i] = internExtension(snapshot, previousExtNames[snapshot.extId[src]!] ?? '');
		maskPath[i] = snapshot.maskPath[src]!;
		maskName[i] = snapshot.maskName[src]!;
		flags[i] = snapshot.flags[src]!;
		mtime[i] = snapshot.mtime[src]!;
		const low = snapshot.lower[src]!;
		lower.push(low);
		byLower.set(low, i);
	}

	snapshot.paths = paths;
	snapshot.lower = lower;
	snapshot.nameStart = nameStart;
	snapshot.nameLen = nameLen;
	snapshot.pathLen = pathLen;
	snapshot.depth = depth;
	snapshot.extId = extId;
	snapshot.maskPath = maskPath;
	snapshot.maskName = maskName;
	snapshot.flags = flags;
	snapshot.mtime = mtime;
	snapshot.byLower = byLower;
	snapshot.size = size;
	snapshot.tombstones = 0;
	snapshot.version++;
	return snapshot;
}

/**
 * Flags-only pass. Exclusion config changed, so the `IGNORED` bit is stale — but no row
 * moved, so `version` deliberately does not move either and any live `NarrowState`
 * stays valid.
 */
export function recomputeIgnoredFlags(
	snapshot: FileOpenSnapshot,
	isIgnoredPath: (path: string) => boolean,
	exclusionSig: string,
): FileOpenSnapshot {
	for (let i = 0; i < snapshot.size; i++) {
		if ((snapshot.flags[i]! & FILE_OPEN_FLAG_TOMBSTONE) !== 0) continue;
		setIgnoredFlag(snapshot, i, isIgnoredPath);
	}
	snapshot.exclusionSig = exclusionSig;
	return snapshot;
}

/** One level of the narrowing stack: the rows that survived `query`. */
export interface NarrowFrame {
	query: string;
	ids: Int32Array;
	count: number;
}

/**
 * Per-modal-session narrowing cache.
 *
 * Sound because admission ("every term is a subsequence of the lowercased path") is
 * monotone under query extension, and because a change to anything else that can
 * exclude a row — the extension filter, the ignored-folder mode — bumps `filterSig` and
 * resets the stack. Structural snapshot changes bump `version` and do the same. The root
 * frame is implicit: `[0, size)` is never materialized.
 */
export interface NarrowState {
	frames: NarrowFrame[];
	version: number;
	filterSig: string;
}

export function createNarrowState(): NarrowState {
	return { frames: [], version: -1, filterSig: ' ' };
}

export interface SelectFileOpenOptions {
	/** Allowed extensions; empty means every extension. */
	extensions?: string[];
	ignoredFolderMode?: CrucibleFileOpenIgnoredFolderMode;
	createMissing?: boolean;
	limit?: number;
	/** Path -> recency rank (0 = most recently opened). Supplied by the palette. */
	recency?: Map<string, number>;
	/** Denominator for the recency ramp; defaults to `recency.size`. */
	recencyCount?: number;
}

interface Winner {
	row: number;
	score: number;
	key: number;
}

/**
 * The per-keystroke selection. Returns at most `limit` file rows (best first) plus an
 * optional create row.
 *
 * Prefilter order is cheapest-first: char-class mask AND -> extension id -> hide-mode
 * flag -> `scoreText` (which itself tries basename `indexOf` before any subsequence
 * walk). Survivors feed a bounded top-K min-heap, so once 100 rows are in, `key <= worst`
 * rejects the remaining >99% of the corpus with a single float compare and no sort ever
 * runs over N.
 */
export function selectFileOpenItems(
	snapshot: FileOpenSnapshot,
	query: string,
	state: NarrowState | null,
	options: SelectFileOpenOptions = {},
): FileOpenItem[] {
	const limit = options.limit ?? FILE_OPEN_LIMIT;
	const mode = options.ignoredFolderMode ?? 'include';
	const compiled = compileQuery(query);
	const allowedExtensions = normalizeExtensionFilter(options.extensions ?? []);
	const extActive = allowedExtensions.size > 0;
	const allowedIds = extActive ? resolveExtensionIds(snapshot, allowedExtensions) : null;
	const hideIgnored = mode === 'hide';
	const derank = mode === 'derank';
	const recency = options.recency;
	const recencyCount = options.recencyCount ?? (recency ? recency.size : 0);

	const heap = new TopKHeap(Math.max(1, limit));
	const filterSig = buildFilterSig(allowedExtensions, mode);

	if (compiled.isEmpty) {
		selectEmptyQuery(snapshot, heap, allowedIds, hideIgnored, derank, recency, recencyCount);
	} else {
		selectScored(snapshot, compiled, heap, allowedIds, hideIgnored, derank, recency, recencyCount, state, filterSig);
	}

	const winners = heap.drain();
	winners.sort((a, b) => compareWinners(a, b, snapshot, derank));

	const items: FileOpenItem[] = [];
	for (const winner of winners) {
		items.push({
			kind: 'file',
			path: snapshot.paths[winner.row]!,
			extension: snapshot.extNames[snapshot.extId[winner.row]!] ?? '',
			ignored: (snapshot.flags[winner.row]! & FILE_OPEN_FLAG_IGNORED) !== 0,
			score: compiled.isEmpty ? null : winner.score,
		});
	}

	const createItem = buildCreateItem(snapshot, query, options.createMissing === true, allowedExtensions);
	if (createItem !== null) items.push(createItem);
	return items;
}

/**
 * Highlight ranges for one winner. Only ever called for the rows that are about to be
 * rendered — never in the hot loop. See `buildRanges` for the `renderResults` contract.
 */
export function buildFileOpenMatch(query: string, path: string, score = 0): FileOpenMatch {
	const compiled = compileQuery(query);
	return { score, matches: buildRanges(compiled, path) };
}

/**
 * Legacy adapter kept only so `src/fileOpenPalette.ts` keeps compiling until WP-2
 * replaces it with the snapshot lifecycle. It rebuilds a snapshot on every call, which
 * is exactly the O(N)-per-keystroke cost this rewrite exists to remove.
 *
 * NOT deprecated via a `@deprecated` tag on purpose — `fileOpenPalette.ts` is the sole
 * caller and the repo's `no-deprecated` lint rule would fail the gate on a file WP-2
 * owns. Treat this as deprecated anyway: use `buildFileOpenSnapshot` +
 * `selectFileOpenItems`, and delete this adapter together with `RankFileOpenOptions`.
 */
export function rankFileOpenItems(options: RankFileOpenOptions): FileOpenItem[] {
	const snapshot = buildFileOpenSnapshot(options.files, { isIgnoredPath: options.isIgnoredPath });
	return selectFileOpenItems(snapshot, options.query, null, {
		extensions: options.extensions,
		ignoredFolderMode: options.ignoredFolderMode,
		createMissing: options.createMissing,
		limit: options.limit,
	});
}

export interface RankFileOpenOptions {
	files: FileOpenCandidate[];
	query: string;
	extensions: string[];
	ignoredFolderMode: CrucibleFileOpenIgnoredFolderMode;
	createMissing: boolean;
	isIgnoredPath: (path: string) => boolean;
	limit?: number;
	/**
	 * Accepted and **ignored** — this is no longer an injection point. An
	 * injected lower-is-better double is precisely what certified the inverted sort that
	 * shipped, so the scorer now lives in `./rankScore` and cannot be replaced. The
	 * parameter survives only so the pre-WP-2 `fileOpenPalette.ts` call site still
	 * type-checks; the `unknown` return type is the tell that nothing reads it. Delete
	 * this field together with `rankFileOpenItems`.
	 */
	scorePath?: (query: string, path: string) => unknown;
}

export function normalizeExtensionFilter(extensions: string[]): Set<string> {
	const normalized = extensions
		.map(normalizeExtension)
		.filter(ext => ext.length > 0);
	return new Set(normalized);
}

export function parseExtensionFilter(raw: string): string[] {
	const seen = new Set<string>();
	for (const part of raw.split(/[\s,]+/)) {
		const ext = normalizeExtension(part);
		if (ext) seen.add(ext);
	}
	return Array.from(seen);
}

export function formatExtensionFilter(extensions: string[]): string {
	return Array.from(normalizeExtensionFilter(extensions)).sort().join(', ');
}

export function normalizeCreatePath(query: string): string | null {
	if (query.trim().replace(/\\/g, '/').endsWith('/')) return null;
	const normalized = normalizeFileOpenPath(query);
	if (!normalized) return null;
	const extension = fileExtension(normalized);
	if (extension && extension !== 'md') return null;
	return extension ? normalized : `${normalized}.md`;
}

/* -------------------------------------------------------------------------- */
/* selection internals                                                         */
/* -------------------------------------------------------------------------- */

function selectScored(
	snapshot: FileOpenSnapshot,
	compiled: CompiledQuery,
	heap: TopKHeap,
	allowedIds: Set<number> | null,
	hideIgnored: boolean,
	derank: boolean,
	recency: Map<string, number> | undefined,
	recencyCount: number,
	state: NarrowState | null,
	filterSig: string,
): void {
	const narrowKey = compiled.lower;
	const frames = resolveFrames(snapshot, state, filterSig, narrowKey);
	const top = frames !== null && frames.length > 0 ? frames[frames.length - 1]! : null;
	const source = top !== null ? top.ids : null;
	const sourceCount = top !== null ? top.count : snapshot.size;
	const queryMask = compiled.mask;

	const collect = frames !== null && frames.length < NARROW_MAX_DEPTH
		&& (top === null || narrowKey.length > top.query.length);
	const survivors: number[] | null = collect ? [] : null;

	for (let s = 0; s < sourceCount; s++) {
		const row = source === null ? s : source[s]!;
		const flags = snapshot.flags[row]!;
		if ((flags & FILE_OPEN_FLAG_TOMBSTONE) !== 0) continue;
		if (!maskAccepts(snapshot.maskPath[row]!, queryMask)) continue;
		if (allowedIds !== null && !allowedIds.has(snapshot.extId[row]!)) continue;
		const ignored = (flags & FILE_OPEN_FLAG_IGNORED) !== 0;
		if (hideIgnored && ignored) continue;

		const result = scoreText(compiled, snapshot.lower[row]!, snapshot.nameStart[row]!, snapshot.nameLen[row]!, {
			depth: snapshot.depth[row]!,
			pathLen: snapshot.pathLen[row]!,
			raw: snapshot.paths[row]!,
			nameMask: snapshot.maskName[row]!,
			pathMask: snapshot.maskPath[row]!,
		});
		if (result === null) continue;
		if (survivors !== null) survivors.push(row);

		let score = result.score;
		if (recency !== undefined) score += recencyBonus(recency, recencyCount, snapshot.paths[row]!);
		heap.push(row, score, derank && ignored ? score - DERANK_PENALTY_SCORED : score);
	}

	if (survivors !== null && frames !== null && survivors.length * 2 < snapshot.size) {
		frames.push({ query: narrowKey, ids: Int32Array.from(survivors), count: survivors.length });
	}
}

function selectEmptyQuery(
	snapshot: FileOpenSnapshot,
	heap: TopKHeap,
	allowedIds: Set<number> | null,
	hideIgnored: boolean,
	derank: boolean,
	recency: Map<string, number> | undefined,
	recencyCount: number,
): void {
	// Recency first, then mtime desc, then (via the comparator) depth. The pre-rewrite
	// behavior — the alphabetically shortest paths in the vault — was not useful.
	for (let row = 0; row < snapshot.size; row++) {
		const flags = snapshot.flags[row]!;
		if ((flags & FILE_OPEN_FLAG_TOMBSTONE) !== 0) continue;
		if (allowedIds !== null && !allowedIds.has(snapshot.extId[row]!)) continue;
		const ignored = (flags & FILE_OPEN_FLAG_IGNORED) !== 0;
		if (hideIgnored && ignored) continue;

		const rank = recency !== undefined ? recency.get(snapshot.paths[row]!) : undefined;
		const key = rank !== undefined
			? EMPTY_RECENCY_BASE - rank
			: snapshot.mtime[row]! / 1e9;
		heap.push(row, key, derank && ignored ? key - DERANK_PENALTY_EMPTY : key);
	}
}

/** Recency keys sit above every mtime-derived key (mtime ms / 1e9 is ~1.8e3 today). */
const EMPTY_RECENCY_BASE = 1e9;

function resolveFrames(
	snapshot: FileOpenSnapshot,
	state: NarrowState | null,
	filterSig: string,
	narrowKey: string,
): NarrowFrame[] | null {
	if (state === null) return null;
	if (state.version !== snapshot.version || state.filterSig !== filterSig) {
		state.frames = [];
		state.version = snapshot.version;
		state.filterSig = filterSig;
	}
	const frames = state.frames;
	// A non-prefix edit (backspace past every frame, paste, mid-string edit) simply pops
	// back to the implicit root and pays one mask-prefiltered full scan.
	while (frames.length > 0 && !narrowKey.startsWith(frames[frames.length - 1]!.query)) frames.pop();
	return frames;
}

function recencyBonus(recency: Map<string, number>, count: number, path: string): number {
	const rank = recency.get(path);
	if (rank === undefined || count <= 0) return 0;
	const bonus = RECENCY_MAX * (1 - rank / count);
	return bonus > 0 ? bonus : 0;
}

function compareWinners(a: Winner, b: Winner, snapshot: FileOpenSnapshot, derank: boolean): number {
	if (derank) {
		const aIgnored = (snapshot.flags[a.row]! & FILE_OPEN_FLAG_IGNORED) !== 0;
		const bIgnored = (snapshot.flags[b.row]! & FILE_OPEN_FLAG_IGNORED) !== 0;
		if (aIgnored !== bIgnored) return aIgnored ? 1 : -1;
	}
	// Descending. This is the fix: the pre-rewrite comparator subtracted the other way
	// and the palette showed the hundred worst matches.
	if (a.key !== b.key) return b.key - a.key;
	const aPathLen = snapshot.pathLen[a.row]!;
	const bPathLen = snapshot.pathLen[b.row]!;
	if (aPathLen !== bPathLen) return aPathLen - bPathLen;
	const aDepth = snapshot.depth[a.row]!;
	const bDepth = snapshot.depth[b.row]!;
	if (aDepth !== bDepth) return aDepth - bDepth;
	return snapshot.paths[a.row]!.localeCompare(snapshot.paths[b.row]!);
}

function buildCreateItem(
	snapshot: FileOpenSnapshot,
	query: string,
	createMissing: boolean,
	allowedExtensions: Set<string>,
): FileOpenCreateItem | null {
	if (!createMissing) return null;
	const path = normalizeCreatePath(query);
	if (path === null) return null;
	// One `Map` lookup. The pre-rewrite code built a `Set` over all 47k paths on every
	// keystroke to answer this, whether or not `createMissing` was even on.
	if (snapshot.byLower.has(path.toLowerCase())) return null;
	if (allowedExtensions.size > 0 && !allowedExtensions.has(fileExtension(path))) return null;
	return { kind: 'create', path };
}

function buildFilterSig(allowedExtensions: Set<string>, mode: CrucibleFileOpenIgnoredFolderMode): string {
	return `${mode}|${Array.from(allowedExtensions).sort().join(',')}`;
}

function resolveExtensionIds(snapshot: FileOpenSnapshot, allowedExtensions: Set<string>): Set<number> {
	const ids = new Set<number>();
	for (const ext of allowedExtensions) {
		const id = snapshot.extIds.get(ext);
		if (id !== undefined) ids.add(id);
	}
	return ids;
}

/**
 * Bounded top-K min-heap over parallel typed arrays. `push` on a full heap is one float
 * compare for the >99% of candidates that lose.
 */
class TopKHeap {
	private readonly rows: Int32Array;
	private readonly scores: Float64Array;
	private readonly keys: Float64Array;
	private count = 0;

	constructor(private readonly capacity: number) {
		this.rows = new Int32Array(capacity);
		this.scores = new Float64Array(capacity);
		this.keys = new Float64Array(capacity);
	}

	push(row: number, score: number, key: number): void {
		if (this.count < this.capacity) {
			let i = this.count++;
			this.rows[i] = row;
			this.scores[i] = score;
			this.keys[i] = key;
			while (i > 0) {
				const parent = (i - 1) >> 1;
				if (this.keys[parent]! <= this.keys[i]!) break;
				this.swap(parent, i);
				i = parent;
			}
			return;
		}
		if (key <= this.keys[0]!) return;
		this.rows[0] = row;
		this.scores[0] = score;
		this.keys[0] = key;
		this.siftDown();
	}

	drain(): Winner[] {
		const out: Winner[] = [];
		for (let i = 0; i < this.count; i++) {
			out.push({ row: this.rows[i]!, score: this.scores[i]!, key: this.keys[i]! });
		}
		return out;
	}

	private siftDown(): void {
		let i = 0;
		for (;;) {
			const left = i * 2 + 1;
			const right = left + 1;
			let smallest = i;
			if (left < this.count && this.keys[left]! < this.keys[smallest]!) smallest = left;
			if (right < this.count && this.keys[right]! < this.keys[smallest]!) smallest = right;
			if (smallest === i) return;
			this.swap(smallest, i);
			i = smallest;
		}
	}

	private swap(a: number, b: number): void {
		const row = this.rows[a]!;
		this.rows[a] = this.rows[b]!;
		this.rows[b] = row;
		const score = this.scores[a]!;
		this.scores[a] = this.scores[b]!;
		this.scores[b] = score;
		const key = this.keys[a]!;
		this.keys[a] = this.keys[b]!;
		this.keys[b] = key;
	}
}

/* -------------------------------------------------------------------------- */
/* snapshot internals                                                          */
/* -------------------------------------------------------------------------- */

function appendRow(
	snapshot: FileOpenSnapshot,
	candidate: FileOpenCandidate,
	isIgnoredPath: ((path: string) => boolean) | undefined,
): void {
	const path = normalizeFileOpenPath(candidate.path);
	if (!path) return;
	const lower = path.toLowerCase();
	if (snapshot.byLower.has(lower)) return;

	const row = snapshot.size;
	ensureCapacity(snapshot, row + 1);
	const nameStart = lower.lastIndexOf('/') + 1;
	const nameLen = lower.length - nameStart;

	snapshot.paths[row] = path;
	snapshot.lower[row] = lower;
	snapshot.nameStart[row] = nameStart;
	snapshot.nameLen[row] = Math.min(nameLen, 65535);
	snapshot.pathLen[row] = Math.min(lower.length, 65535);
	snapshot.depth[row] = Math.min(countSlashes(lower), 255);
	snapshot.extId[row] = internExtension(snapshot, candidate.extension ?? fileExtension(path));
	snapshot.maskPath[row] = computeMaskRange(lower, 0, lower.length);
	snapshot.maskName[row] = computeMaskRange(lower, nameStart, lower.length);
	snapshot.flags[row] = 0;
	snapshot.mtime[row] = candidate.mtime ?? 0;
	snapshot.byLower.set(lower, row);
	snapshot.size = row + 1;
	setIgnoredFlag(snapshot, row, isIgnoredPath);
}

function removeRow(snapshot: FileOpenSnapshot, path: string): void {
	const lower = normalizeFileOpenPath(path).toLowerCase();
	const row = snapshot.byLower.get(lower);
	if (row === undefined) return;
	snapshot.flags[row] = snapshot.flags[row]! | FILE_OPEN_FLAG_TOMBSTONE;
	snapshot.byLower.delete(lower);
	snapshot.tombstones++;
}

function setIgnoredFlag(
	snapshot: FileOpenSnapshot,
	row: number,
	isIgnoredPath: ((path: string) => boolean) | undefined,
): void {
	const ignored = isIgnoredPath !== undefined && isIgnoredPath(snapshot.paths[row]!);
	const flags = snapshot.flags[row]!;
	snapshot.flags[row] = ignored ? flags | FILE_OPEN_FLAG_IGNORED : flags & ~FILE_OPEN_FLAG_IGNORED;
}

function internExtension(snapshot: FileOpenSnapshot, extension: string): number {
	const normalized = normalizeExtension(extension);
	const existing = snapshot.extIds.get(normalized);
	if (existing !== undefined) return existing;
	const id = snapshot.extNames.length;
	snapshot.extNames.push(normalized);
	snapshot.extIds.set(normalized, id);
	return id;
}

function capacityFor(needed: number): number {
	let capacity = 64;
	while (capacity < needed) capacity *= 2;
	return capacity;
}

function ensureCapacity(snapshot: FileOpenSnapshot, needed: number): void {
	if (snapshot.nameStart.length >= needed) return;
	const capacity = capacityFor(needed);
	snapshot.nameStart = growInt32(snapshot.nameStart, capacity);
	snapshot.nameLen = growUint16(snapshot.nameLen, capacity);
	snapshot.pathLen = growUint16(snapshot.pathLen, capacity);
	snapshot.depth = growUint8(snapshot.depth, capacity);
	snapshot.extId = growUint16(snapshot.extId, capacity);
	snapshot.maskPath = growUint32(snapshot.maskPath, capacity);
	snapshot.maskName = growUint32(snapshot.maskName, capacity);
	snapshot.flags = growUint8(snapshot.flags, capacity);
	snapshot.mtime = growFloat64(snapshot.mtime, capacity);
}

function growInt32(source: Int32Array, capacity: number): Int32Array {
	const next = new Int32Array(capacity);
	next.set(source);
	return next;
}

function growUint16(source: Uint16Array, capacity: number): Uint16Array {
	const next = new Uint16Array(capacity);
	next.set(source);
	return next;
}

function growUint8(source: Uint8Array, capacity: number): Uint8Array {
	const next = new Uint8Array(capacity);
	next.set(source);
	return next;
}

function growUint32(source: Uint32Array, capacity: number): Uint32Array {
	const next = new Uint32Array(capacity);
	next.set(source);
	return next;
}

function growFloat64(source: Float64Array, capacity: number): Float64Array {
	const next = new Float64Array(capacity);
	next.set(source);
	return next;
}

function countSlashes(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 47) count++;
	return count;
}

function normalizeExtension(extension: string): string {
	return extension.trim().replace(/^\.+/, '').toLowerCase();
}

function fileExtension(path: string): string {
	const filename = path.split('/').pop() ?? '';
	const dot = filename.lastIndexOf('.');
	return dot > 0 && dot < filename.length - 1 ? normalizeExtension(filename.slice(dot + 1)) : '';
}

function normalizeFileOpenPath(path: string): string {
	return normalizeExcludedFolder(path).replace(/\/+/g, '/');
}

/** Re-exported so the tier-gap invariant can be asserted against the selection layer. */
export { MODIFIER_CLAMP };
