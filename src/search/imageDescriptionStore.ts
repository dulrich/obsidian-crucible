/**
 * The MD5-keyed image description store (`docs/multimodal-image-search.md`, Decision 2).
 *
 * One JSON record per described image, keyed by the image's content MD5 (the same hash the
 * `_MD5` attachment naming convention already computes — see the deterministic-content-hash
 * quirk in the root `AGENTS.md`). Records live outside the vault's note tree entirely (WP-1's
 * caller, `main.ts`, points `baseDir` at `pluginDataPath('image-descriptions')`), which is what
 * lets the chunker (WP-2) attribute description chunks to the *note* embedding the image without
 * a second file ever landing in the vault, and what keeps the store invisible to the search index
 * it feeds.
 *
 * Storage is a five-method structural interface — the same seam `SearchQueryLog` uses over
 * `QueryLogStorage` (`src/search/queryLog.ts:104-109`) — so the store is directly unit-testable
 * against an in-memory fake without a live `App`/vault.
 *
 * `descriptionHash` is deterministic from `(narrative, extraction)` alone. Provider/model
 * identity rides along as provenance only: upgrading the vision model must not invalidate a
 * description that reads the same, because `descriptionHash` is exactly the value WP-2 folds
 * into a note's index-time `contentHash` — churning it on every model upgrade would re-upsert
 * (and, with semantic search on, re-embed) the whole vault for no content change.
 */

import { logWarn } from '../log';

/** Bumped only if the on-disk record shape changes incompatibly. */
export const IMAGE_DESCRIPTION_SCHEMA_VERSION = 1;

export interface ImageDescriptionRecord {
	md5: string;
	/** One dense paragraph: what the image is, its subject, the point it makes. */
	narrative: string;
	/** Structured transcription: titles, axis labels, series names, values, table content. */
	extraction: string;
	kind: 'vision' | 'svg-text' | 'imported';
	providerId?: string;
	modelId?: string;
	/** ISO timestamp of when this record was written. */
	describedAt: string;
	schemaVersion: number;
	/** Deterministic hash of `narrative + '\n' + extraction` — see the module doc. */
	descriptionHash: string;
}

/**
 * The subset of Obsidian's `DataAdapter` this module needs, declared structurally so the store
 * can be driven by an in-memory fake in tests and by a `vault.adapter`-backed wrapper in the
 * plugin (see `main.ts`, which also owns creating `baseDir` — this module never calls `mkdir`).
 * `read` returns `null` for a missing path rather than throwing, unlike `DataAdapter.read`.
 */
export interface ImageDescriptionStorage {
	read(path: string): Promise<string | null>;
	write(path: string, data: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	remove(path: string): Promise<void>;
	/** Non-recursive listing of `dir` — file paths only (a real adapter wrapper drops folders). */
	list(dir: string): Promise<string[]>;
}

export interface PutImageDescriptionInput {
	md5: string;
	narrative: string;
	extraction: string;
	kind: ImageDescriptionRecord['kind'];
	providerId?: string;
	modelId?: string;
}

/**
 * A local FNV-1a (32-bit, hex-encoded) — intentionally re-implemented rather than imported.
 * `src/search/chunker.ts`'s `hashString` is module-private (and that module must stay free of
 * dependents outside the chunk-building path per its own purity constraint), so this is a
 * separate copy of the same well-known algorithm, not a shared export.
 */
function fnv1a(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

function basenameMd5(entryPath: string): string | null {
	const name = entryPath.split('/').pop() ?? '';
	const match = name.match(/^(.+)\.json$/);
	return match ? (match[1] ?? null) : null;
}

function isValidRecord(value: unknown): value is ImageDescriptionRecord {
	const record = value as Partial<ImageDescriptionRecord> | null;
	if (!record || typeof record !== 'object') return false;
	if (typeof record.md5 !== 'string' || !record.md5) return false;
	if (typeof record.narrative !== 'string' || typeof record.extraction !== 'string') return false;
	if (record.kind !== 'vision' && record.kind !== 'svg-text' && record.kind !== 'imported') return false;
	if (typeof record.describedAt !== 'string') return false;
	if (typeof record.schemaVersion !== 'number') return false;
	if (typeof record.descriptionHash !== 'string') return false;
	return true;
}

/**
 * The store. `ensureLoaded()` builds an in-memory `md5 -> descriptionHash` index by listing
 * `baseDir` once (lazy: nothing touches disk until the first call that needs it; idempotent:
 * concurrent callers share one in-flight listing, and a second call after loading is a no-op).
 * The index intentionally holds only the hash, not the full record — chunk-prep call sites
 * (`has`/`combinedDescriptionHash`) only ever need the hash, and keeping full records resident
 * would mean holding every narrative+extraction pair in memory for the life of the plugin.
 */
export class ImageDescriptionStore {
	private readonly index = new Map<string, string>();
	private loaded = false;
	private loading: Promise<void> | null = null;

	constructor(
		private readonly storage: ImageDescriptionStorage,
		private readonly baseDir: string,
	) {}

	async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		if (!this.loading) this.loading = this.load();
		await this.loading;
	}

	/** Sync, from the in-memory index — callers that only need presence should prefer this over `get`. */
	has(md5: string): boolean {
		return this.index.has(md5);
	}

	async get(md5: string): Promise<ImageDescriptionRecord | null> {
		await this.ensureLoaded();
		if (!this.index.has(md5)) return null;
		return await this.readRecord(this.pathFor(md5));
	}

	async put(input: PutImageDescriptionInput): Promise<ImageDescriptionRecord> {
		await this.ensureLoaded();
		const descriptionHash = fnv1a(`${input.narrative}\n${input.extraction}`);
		const record: ImageDescriptionRecord = {
			md5: input.md5,
			narrative: input.narrative,
			extraction: input.extraction,
			kind: input.kind,
			providerId: input.providerId,
			modelId: input.modelId,
			describedAt: new Date().toISOString(),
			schemaVersion: IMAGE_DESCRIPTION_SCHEMA_VERSION,
			descriptionHash,
		};
		await this.storage.write(this.pathFor(input.md5), `${JSON.stringify(record)}\n`);
		this.index.set(input.md5, descriptionHash);
		return record;
	}

	listMd5s(): string[] {
		return [...this.index.keys()];
	}

	/**
	 * Order-independent (sorts unique md5s first) and stable across sessions (a pure function of
	 * the index's current contents). Unknown md5s are skipped rather than erroring — a note whose
	 * embed resolves to an md5 that hasn't been described yet (or ever will be) must not poison
	 * the hash for every other, already-described image on the same note. Empty input, or input
	 * that resolves to no known md5s, hashes to `''` rather than `fnv1a('')` — an explicit "no
	 * description contribution" value distinct from a real (if degenerate) hash.
	 */
	combinedDescriptionHash(md5s: string[]): string {
		const unique = [...new Set(md5s)].sort();
		const lines: string[] = [];
		for (const md5 of unique) {
			const hash = this.index.get(md5);
			if (hash === undefined) continue;
			lines.push(`${md5}:${hash}`);
		}
		if (lines.length === 0) return '';
		return fnv1a(lines.join('\n'));
	}

	private pathFor(md5: string): string {
		return `${this.baseDir}/${md5}.json`;
	}

	private async load(): Promise<void> {
		let entries: string[] = [];
		try {
			entries = await this.storage.list(this.baseDir);
		} catch (e) {
			logWarn('image description store: failed to list', this.baseDir, e);
			entries = [];
		}
		for (const entry of entries) {
			const md5 = basenameMd5(entry);
			if (!md5) continue;
			// Read via the entry's own listed path (not `pathFor(md5)`) — a real adapter's `list`
			// returns full paths already, and reconstructing from `baseDir` would only diverge if
			// the two disagreed, which would itself be a bug worth surfacing via a missed index entry
			// rather than papering over with two different path-building rules.
			const record = await this.readRecord(entry);
			if (!record) continue;
			this.index.set(md5, record.descriptionHash);
		}
		this.loaded = true;
	}

	/** Corrupt/unparseable/missing record -> `null`, `logWarn`, never throws into callers. */
	private async readRecord(path: string): Promise<ImageDescriptionRecord | null> {
		let raw: string | null;
		try {
			raw = await this.storage.read(path);
		} catch (e) {
			logWarn('image description store: failed to read record', path, e);
			return null;
		}
		if (raw === null) return null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (e) {
			logWarn('image description store: corrupt (unparseable) record', path, e);
			return null;
		}
		if (!isValidRecord(parsed)) {
			logWarn('image description store: corrupt (malformed) record', path);
			return null;
		}
		return parsed;
	}
}
