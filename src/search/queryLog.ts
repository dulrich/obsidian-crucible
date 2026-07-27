/**
 * Passive vault-search query logging.
 *
 * Every executed vault search is recorded locally — the query text, the ranking that was shown
 * (paths + the rank each was shown at), the mode the companion answered in, and, the
 * load-bearing part, *which* result the user opened. Opening result #4 instead of #1 is a
 * judgment-free relevance signal: it is implicit relevance feedback collected from real intent,
 * which is strictly better evidence than a recalled preference. The log exists so a ranking
 * change can be re-validated against real usage later instead of against a hand-authored query
 * set.
 *
 * Four rules this module exists to enforce, none of which are negotiable:
 *
 * 1. **No abandoned-search inference.** A search with no click is NOT a failure — the user may
 *    have read the snippet and been satisfied, or simply changed their mind. `opened: null`
 *    records the *absence* of a click and nothing more. Nothing here (and nothing downstream)
 *    may label it. `buildQueryExport` is where that rule bites hardest: an entry with no click
 *    has no target, and a query file entry with an empty `targetPaths` would score as a miss in
 *    every IR metric — so those entries are *excluded from the export*, not exported with zero
 *    targets. The count is reported instead.
 * 2. **Nothing but the vault leaves the vault.** No network I/O, ever. The log is a single JSON
 *    file in the plugin's own data directory (`.obsidian/plugins/<id>/`), which is outside the
 *    vault's markdown tree entirely — so it can never be picked up by the search index it is
 *    measuring. A query log that gets indexed becomes a note containing every query's terms,
 *    which is measurably corrosive to FTS ranking vault-wide.
 * 3. **Bounded.** The store keeps at most `maxEntries` entries and drops the oldest first. An
 *    unbounded local log of everything a user has ever searched for is a liability, not a
 *    feature.
 * 4. **Minimal.** Only what a ranking measurement actually needs is recorded: query text,
 *    result *paths* and ranks, counts, mode flags, timestamps, and the opened path. Deliberately
 *    NOT recorded: snippets, titles, headings, chunk ids, scores, or any note content — a log
 *    carrying snippets would be a partial copy of the vault sitting in a plain JSON file.
 *
 * This module deliberately imports nothing from `obsidian`: storage is a four-method structural
 * interface that `app.vault.adapter` satisfies, which keeps every helper here directly testable
 * (see `tests/searchQueryLog.test.mjs`) without a live App.
 */

import { logWarn } from '../log';

/** Bumped only if the on-disk entry shape changes incompatibly; a mismatch resets the log. */
export const SEARCH_QUERY_LOG_VERSION = 1;

/** Lives beside `data.json` in the plugin's data dir — never inside the vault's note tree. */
export const SEARCH_QUERY_LOG_FILENAME = 'search-query-log.json';

/** The S2-shaped query file the export command writes, in the same directory. */
export const SEARCH_QUERY_EXPORT_FILENAME = 'search-query-export.json';

/** `source` stamped on every exported query, marking its provenance as real vault usage. */
export const SEARCH_QUERY_EXPORT_SOURCE = 'vault-log';

export const SEARCH_QUERY_LOG_DEFAULT_MAX_ENTRIES = 500;
export const SEARCH_QUERY_LOG_MIN_MAX_ENTRIES = 10;
export const SEARCH_QUERY_LOG_MAX_MAX_ENTRIES = 5000;

/** One row of the ranking as it was shown: the note's path and its 1-based on-screen position. */
export interface SearchQueryLogResultRef {
	path: string;
	rank: number;
}

/**
 * The click. `rank` is the position the opened path occupied in the ranking that was on screen,
 * or `null` when the path is not in the recorded ranking at all (defensive — shouldn't happen).
 */
export interface SearchQueryLogOpen {
	path: string;
	rank: number | null;
	at: string;
}

export interface SearchQueryLogEntry {
	id: string;
	/** ISO timestamp of when the search was executed. */
	at: string;
	query: string;
	/** The companion's answering mode (`fts` / `vector` / `hybrid`), or null if it reported none. */
	mode: string | null;
	/** True once an explicit "Rerank results" click replaced the ranking below. */
	reranked: boolean;
	/** False means the vector leg was unavailable and the answer was keywords-only. */
	semanticAvailable: boolean | null;
	/** Sweep queries are project briefs, not search terms — a different query distribution. */
	sweep: boolean;
	/** How many results were rendered. */
	shown: number;
	/** How many the companion reported matching in total, when it reported one. */
	total: number | null;
	results: SearchQueryLogResultRef[];
	/** `null` = no result was opened. That is an absence, NOT a failure. See rule 1 above. */
	opened: SearchQueryLogOpen | null;
}

export interface SearchQueryLogFile {
	version: number;
	entries: SearchQueryLogEntry[];
}

/**
 * The subset of Obsidian's `DataAdapter` this module needs. Declared structurally so the store
 * can be driven by an in-memory fake in tests and by `app.vault.adapter` in the plugin.
 */
export interface QueryLogStorage {
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	remove(path: string): Promise<void>;
}

export interface SearchQueryLogOptions {
	storage: QueryLogStorage;
	filePath: string;
	/** Read live, per call — flipping the setting off must take effect on the next search. */
	isEnabled: () => boolean;
	maxEntries: () => number;
	now?: () => Date;
	newId?: () => string;
}

export interface RecordSearchInput {
	query: string;
	mode?: string | null;
	semanticAvailable?: boolean | null;
	sweep?: boolean;
	shown: number;
	total?: number | null;
	/** The ranking as rendered; only `path` is read, so a `SearchResult[]` passes as-is. */
	results: readonly { path: string }[];
}

export function normalizeMaxEntries(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) return SEARCH_QUERY_LOG_DEFAULT_MAX_ENTRIES;
	const floored = Math.floor(n);
	if (floored < SEARCH_QUERY_LOG_MIN_MAX_ENTRIES) return SEARCH_QUERY_LOG_MIN_MAX_ENTRIES;
	if (floored > SEARCH_QUERY_LOG_MAX_MAX_ENTRIES) return SEARCH_QUERY_LOG_MAX_MAX_ENTRIES;
	return floored;
}

/**
 * Reduces a rendered result list to `(path, rank)` pairs — the whole ranking record, and nothing
 * else from the result. Ranks are the 1-based positions as displayed; when two results collapse
 * to the same path (the companion pools per path, so this is defensive) the first — i.e. the
 * best-ranked — wins and the duplicate is dropped *without* renumbering the rows after it, so a
 * recorded rank always matches the position the user actually saw.
 */
export function summarizeRanking(results: readonly { path: string }[]): SearchQueryLogResultRef[] {
	const seen = new Set<string>();
	const refs: SearchQueryLogResultRef[] = [];
	results.forEach((result, index) => {
		const path = typeof result?.path === 'string' ? result.path : '';
		if (!path || seen.has(path)) return;
		seen.add(path);
		refs.push({ path, rank: index + 1 });
	});
	return refs;
}

/** Appends and enforces the bound by dropping oldest-first. Pure; returns a new array. */
export function appendLogEntry(
	entries: readonly SearchQueryLogEntry[],
	entry: SearchQueryLogEntry,
	maxEntries: number,
): SearchQueryLogEntry[] {
	const cap = normalizeMaxEntries(maxEntries);
	const next = [...entries, entry];
	return next.length <= cap ? next : next.slice(next.length - cap);
}

/**
 * Records the opened result on entry `id`. The rank comes from the entry's own stored ranking —
 * that ranking *is* what was on screen, so it is the only honest source for "which position did
 * they click". The FIRST open wins: the modal closes on open so a second one cannot normally
 * happen, and if it somehow does, the first choice is the cleaner signal. Unknown ids are
 * ignored (the entry may have already aged out of the bound).
 */
export function applyOpen(
	entries: readonly SearchQueryLogEntry[],
	id: string,
	path: string,
	at: string,
): SearchQueryLogEntry[] {
	return entries.map(entry => {
		if (entry.id !== id || entry.opened) return entry;
		const hit = entry.results.find(ref => ref.path === path);
		return { ...entry, opened: { path, rank: hit ? hit.rank : null, at } };
	});
}

/**
 * Replaces the recorded ranking after an explicit rerank click. The reranked order is what the
 * user then chose from, so it — not the pre-rerank order — is the ranking a click must be scored
 * against. `reranked` stays as a flag on the entry so the two populations remain separable.
 */
export function applyRerank(
	entries: readonly SearchQueryLogEntry[],
	id: string,
	results: readonly { path: string }[],
): SearchQueryLogEntry[] {
	return entries.map(entry => (
		entry.id === id ? { ...entry, reranked: true, results: summarizeRanking(results) } : entry
	));
}

function isResultRef(value: unknown): value is SearchQueryLogResultRef {
	const ref = value as SearchQueryLogResultRef | null;
	return !!ref && typeof ref.path === 'string' && typeof ref.rank === 'number';
}

function isLogEntry(value: unknown): value is SearchQueryLogEntry {
	const entry = value as SearchQueryLogEntry | null;
	if (!entry || typeof entry !== 'object') return false;
	if (typeof entry.id !== 'string' || typeof entry.query !== 'string' || typeof entry.at !== 'string') return false;
	if (!Array.isArray(entry.results) || !entry.results.every(isResultRef)) return false;
	if (entry.opened !== null && (typeof entry.opened !== 'object' || typeof entry.opened.path !== 'string')) return false;
	return true;
}

/**
 * Tolerant read: a truncated, hand-edited or version-mismatched file yields an empty log rather
 * than an exception. This is measurement data, not user content — losing it is an annoyance,
 * whereas throwing on load would break the search modal itself, which is not an acceptable
 * failure mode for an observability feature.
 */
export function parseQueryLogFile(raw: string): SearchQueryLogEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const file = parsed as Partial<SearchQueryLogFile> | null;
	if (!file || typeof file !== 'object') return [];
	if (file.version !== SEARCH_QUERY_LOG_VERSION) return [];
	if (!Array.isArray(file.entries)) return [];
	return file.entries.filter(isLogEntry);
}

export function serializeQueryLogFile(entries: readonly SearchQueryLogEntry[]): string {
	const file: SearchQueryLogFile = { version: SEARCH_QUERY_LOG_VERSION, entries: [...entries] };
	return `${JSON.stringify(file)}\n`;
}

/** The S2 query-file row shape the ranking bake-off consumes. */
export interface ExportedQuery {
	id: string;
	text: string;
	source: string;
	targetPaths: string[];
}

export interface QueryExportOptions {
	/** Sweeps are free-text project briefs; they are a different task and are excluded by default. */
	includeSweeps?: boolean;
	source?: string;
}

export interface QueryExportResult {
	queries: ExportedQuery[];
	/** Distinct queries dropped because nothing was ever opened for them. NOT failures. */
	withoutTarget: number;
	/** Entries skipped for being sweep queries. */
	sweepsSkipped: number;
	entriesConsidered: number;
}

/**
 * Builds an S2-shaped query file (`{id, text, source, targetPaths}`) from the log, closing the
 * measurement loop: a ranking bake-off can then re-run on real queries with real targets and no
 * authorship bias.
 *
 * Repeats of the same query (case-insensitive, trimmed) collapse into one row whose
 * `targetPaths` are every distinct path opened for it, most-opened first — repeatedly opening
 * the same note for the same query is a stronger target signal than a single click, and ties
 * break on first-seen so the output is deterministic.
 *
 * **Queries with no click are omitted, and counted instead.** They are not exported with an
 * empty `targetPaths`, because every IR metric would score such a row as a miss — which would
 * silently re-introduce exactly the abandoned-search inference this feature forbids.
 */
export function buildQueryExport(
	entries: readonly SearchQueryLogEntry[],
	options: QueryExportOptions = {},
): QueryExportResult {
	const includeSweeps = options.includeSweeps === true;
	const source = options.source ?? SEARCH_QUERY_EXPORT_SOURCE;

	interface Group {
		text: string;
		order: number;
		counts: Map<string, number>;
		firstSeen: Map<string, number>;
	}
	const groups = new Map<string, Group>();
	let sweepsSkipped = 0;
	let considered = 0;
	let seq = 0;

	for (const entry of entries) {
		if (entry.sweep && !includeSweeps) {
			sweepsSkipped++;
			continue;
		}
		const text = entry.query.trim();
		if (!text) continue;
		considered++;
		const key = text.toLowerCase();
		let group = groups.get(key);
		if (!group) {
			group = { text, order: groups.size, counts: new Map(), firstSeen: new Map() };
			groups.set(key, group);
		}
		if (!entry.opened) continue;
		const path = entry.opened.path;
		group.counts.set(path, (group.counts.get(path) ?? 0) + 1);
		if (!group.firstSeen.has(path)) group.firstSeen.set(path, seq++);
	}

	const queries: ExportedQuery[] = [];
	let withoutTarget = 0;
	let index = 0;
	for (const group of [...groups.values()].sort((a, b) => a.order - b.order)) {
		if (group.counts.size === 0) {
			withoutTarget++;
			continue;
		}
		const targetPaths = [...group.counts.entries()]
			.sort((a, b) => (b[1] - a[1]) || ((group.firstSeen.get(a[0]) ?? 0) - (group.firstSeen.get(b[0]) ?? 0)))
			.map(([path]) => path);
		index++;
		queries.push({
			id: `q-${String(index).padStart(3, '0')}`,
			text: group.text,
			source,
			targetPaths,
		});
	}

	return { queries, withoutTarget, sweepsSkipped, entriesConsidered: considered };
}

export function serializeQueryExport(queries: readonly ExportedQuery[]): string {
	return `${JSON.stringify({ queries: [...queries] }, null, 2)}\n`;
}

/**
 * The persisted store. Every mutator is fire-and-forget by design: these are called from the
 * search modal's render and click paths, and a measurement side-channel must never add latency
 * to — or be able to throw into — an interactive surface. Work is serialized through a single
 * promise chain (`tail`) so two whole-file writes can never interleave, and `whenIdle()` exposes
 * that chain for tests and for shutdown.
 */
export class SearchQueryLog {
	private entries: SearchQueryLogEntry[] = [];
	private loaded = false;
	private tail: Promise<void> = Promise.resolve();
	private counter = 0;

	constructor(private readonly options: SearchQueryLogOptions) {}

	/**
	 * Mints and returns the entry id synchronously so the caller can attach a later click to
	 * this exact search without awaiting anything; the append itself happens on the chain.
	 * Returns `null` when logging is off — the caller then has nothing to attach and skips.
	 */
	recordSearch(input: RecordSearchInput): string | null {
		if (!this.options.isEnabled()) return null;
		const query = input.query.trim();
		if (!query) return null;
		const id = this.mintId();
		const entry: SearchQueryLogEntry = {
			id,
			at: this.nowIso(),
			query,
			mode: input.mode ?? null,
			reranked: false,
			semanticAvailable: input.semanticAvailable ?? null,
			sweep: input.sweep === true,
			shown: input.shown,
			total: input.total ?? null,
			results: summarizeRanking(input.results),
			opened: null,
		};
		this.enqueue(() => {
			this.entries = appendLogEntry(this.entries, entry, this.options.maxEntries());
		});
		return id;
	}

	recordRerank(id: string, results: readonly { path: string }[]): void {
		if (!this.options.isEnabled()) return;
		this.enqueue(() => {
			this.entries = applyRerank(this.entries, id, results);
		});
	}

	recordOpen(id: string, path: string): void {
		if (!this.options.isEnabled()) return;
		const at = this.nowIso();
		this.enqueue(() => {
			this.entries = applyOpen(this.entries, id, path, at);
		});
	}

	/** Reads through the chain, so a snapshot never races an in-flight append. */
	async snapshot(): Promise<SearchQueryLogEntry[]> {
		await this.whenIdle();
		await this.ensureLoaded();
		return [...this.entries];
	}

	/** Deletes every entry and the file itself. Returns how many entries were discarded. */
	async clear(): Promise<number> {
		await this.whenIdle();
		await this.ensureLoaded();
		const discarded = this.entries.length;
		this.entries = [];
		try {
			if (await this.options.storage.exists(this.options.filePath)) {
				await this.options.storage.remove(this.options.filePath);
			}
		} catch (e) {
			logWarn('search query log: failed to delete', this.options.filePath, e);
		}
		return discarded;
	}

	/** Resolves once every queued mutation has been applied and persisted. */
	whenIdle(): Promise<void> {
		return this.tail;
	}

	private enqueue(mutate: () => void): void {
		this.tail = this.tail.then(async () => {
			await this.ensureLoaded();
			mutate();
			await this.persist();
		}).catch(e => {
			// A logging side-channel must never surface as a failed search. Swallow, note it
			// under the debug gate, and keep the chain alive for the next call.
			logWarn('search query log: update failed', e);
		});
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			if (!(await this.options.storage.exists(this.options.filePath))) return;
			this.entries = parseQueryLogFile(await this.options.storage.read(this.options.filePath));
		} catch (e) {
			logWarn('search query log: failed to read', this.options.filePath, e);
			this.entries = [];
		}
	}

	private async persist(): Promise<void> {
		await this.options.storage.write(this.options.filePath, serializeQueryLogFile(this.entries));
	}

	private nowIso(): string {
		return (this.options.now ? this.options.now() : new Date()).toISOString();
	}

	private mintId(): string {
		if (this.options.newId) return this.options.newId();
		this.counter += 1;
		return `${Date.now().toString(36)}-${this.counter.toString(36)}`;
	}
}
