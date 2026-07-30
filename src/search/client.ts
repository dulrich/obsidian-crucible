import { RequestUrlResponse, requestUrl } from 'obsidian';
import {
	SEARCH_REQUIRED_SCHEMA_VERSION,
	SearchChunk,
	SearchFileState,
	SearchHealth,
	SearchQueryOptions,
	SearchResponse,
	SearchScoreAttribution,
	SearchServiceUnavailableError,
} from './types';

export { SearchServiceUnavailableError } from './types';
export { SEARCH_REQUIRED_SCHEMA_VERSION } from './types';

// Health probes and searches are interactive: a companion that has not answered in 5s is
// treated as down so the UI stops waiting on it. Still the default for `search()` when a caller
// (a test, or a future call site) does not pass its own timeout — SearchManager now threads the
// user-configurable `searchQueryTimeoutMs` setting through explicitly (WP-5; see
// SEARCH_QUERY_BUDGET_FRACTION below), so this constant's search-side role is now "the fallback
// when nothing configured one," not "the only interactive search timeout that exists." The
// health-probe role is unchanged — health() keeps this as its own default budget.
const SEARCH_SERVICE_TIMEOUT_MS = 5000;

// WP-5: fraction of the interactive search timeout sent to the companion as its own cooperative
// per-request deadline (`budgetMs` on POST /v1/search). Comfortably under 1 so the companion's
// own budget is always shorter than the client's — the companion should give up on the slow
// legs and answer with whatever it has well before the client's own timeout would abandon the
// request outright and throw the response away entirely. This is the client half of the
// two-timeout law's new third budget (src/search/AGENTS.md): distinct from, and derived from,
// the *interactive* timeout only — never the indexing one.
const SEARCH_QUERY_BUDGET_FRACTION = 0.8;

/**
 * Budget for a health probe issued from the background indexing/availability path
 * (`CompanionAvailabilityGate` via `SearchManager.companionAvailable`), as opposed to an
 * interactive, user-facing health/search call.
 *
 * The companion is single-threaded and `node:sqlite`'s `DatabaseSync` is synchronous, so a
 * ~500-chunk flush blocks it for longer than the interactive 5s budget — measured: 17 such
 * probe timeouts in one indexing run, each immediately before a +500 chunk counter jump. The
 * interactive timeout must stay short (a human is waiting on it); a background probe can
 * afford to wait longer before treating silence as meaningful.
 */
export const SEARCH_BACKGROUND_PROBE_TIMEOUT_MS = 15_000;

/**
 * Indexing-path requests get a far longer budget than interactive ones.
 *
 * An upsert carries hundreds of chunks and is issued from the same main thread that
 * synchronously chunks the batch's files, so this timeout races that local work, not just
 * the server's. Applying the interactive 5s here declared a demonstrably healthy companion
 * unreachable partway through a rebuild (measured server-side cost of a 500-chunk flush:
 * ~53ms), which then latched the whole queue offline and stalled it. Reads on this path
 * (`/v1/files/state`) scale with batch size for the same reason.
 */
const SEARCH_SERVICE_INDEX_TIMEOUT_MS = 60_000;

export class SearchServiceClient {
	constructor(private readonly baseUrl: string, private readonly vaultId: string) {}

	// The schema check lives immediately around the health probe and the search response —
	// the only two payloads that carry a schema version — and nowhere else, so there is one
	// place to reason about "is this index queryable by this build".
	//
	// `timeoutMs` lets a background probe (CompanionAvailabilityGate) request the longer
	// SEARCH_BACKGROUND_PROBE_TIMEOUT_MS budget; interactive callers (a settings "test
	// connection" action, SearchManager.health()'s default) get the 5s interactive one.
	async health(timeoutMs: number = SEARCH_SERVICE_TIMEOUT_MS): Promise<SearchHealth> {
		const response = await this.request('/health', 'GET', undefined, timeoutMs);
		const health = normalizeHealth(response.json);
		const outdated = schemaOutdatedMessage(health.schemaVersion);
		if (!outdated) return health;
		// ok:false routes through CompanionAvailabilityGate, so auto-indexing defers instead
		// of writing into an index this build cannot query correctly. Searching still works
		// (degraded), and carries the same message on the response.
		return { ...health, ok: false, rebuildRequired: true, message: outdated };
	}

	async resetIndex(): Promise<void> {
		await this.post('/v1/index/reset', { vaultId: this.vaultId }, SEARCH_SERVICE_INDEX_TIMEOUT_MS);
	}

	async upsertChunks(chunks: SearchChunk[]): Promise<void> {
		if (chunks.length === 0) return;
		await this.post('/v1/chunks/upsert', {
			vaultId: this.vaultId,
			chunks,
		}, SEARCH_SERVICE_INDEX_TIMEOUT_MS);
	}

	async deletePath(path: string): Promise<void> {
		await this.post('/v1/chunks/delete', {
			vaultId: this.vaultId,
			paths: [path],
		}, SEARCH_SERVICE_INDEX_TIMEOUT_MS);
	}

	async fileStates(paths: string[]): Promise<Map<string, SearchFileState>> {
		const uniquePaths = Array.from(new Set(paths.filter(path => path.trim().length > 0)));
		if (uniquePaths.length === 0) return new Map();
		const json = await this.post('/v1/files/state', {
			vaultId: this.vaultId,
			paths: uniquePaths,
		}, SEARCH_SERVICE_INDEX_TIMEOUT_MS);
		return normalizeFileStates(json);
	}

	// `timeoutMs` defaults to the interactive constant for any caller that doesn't pass one (a
	// test, or a future call site); SearchManager threads the user-configurable
	// `searchQueryTimeoutMs` setting through explicitly (WP-5). `budgetMs` — the companion's own
	// cooperative deadline (WP-5, scripts/search-companion.mjs) — is always derived from
	// whichever timeout is actually in effect here, at SEARCH_QUERY_BUDGET_FRACTION of it, so the
	// two stay in the documented relationship (companion budget strictly under client timeout)
	// automatically rather than needing to be kept in sync by every caller.
	async search(options: SearchQueryOptions, timeoutMs: number = SEARCH_SERVICE_TIMEOUT_MS): Promise<SearchResponse> {
		const json = await this.post('/v1/search', {
			vaultId: this.vaultId,
			query: options.query,
			limit: options.limit,
			queryEmbedding: options.queryEmbedding,
			// Which space the query vector lives in. Without it the companion cannot tell a
			// mixed index apart from a single-space one, and would score across both.
			embeddingSpace: options.embeddingSpace,
			// Undefined unless a caller deliberately picks a mode, and JSON.stringify drops an
			// undefined value outright — so the default request is byte-for-byte the one the
			// companion has always received, and its ranking is unchanged.
			rankingMode: options.rankingMode,
			filters: options.filters,
			budgetMs: Math.round(timeoutMs * SEARCH_QUERY_BUDGET_FRACTION),
			// WP-3: the client's own clock at send time, so the companion's cooperative deadline
			// can start counting from here instead of only from its own handler-dispatch clock —
			// see resolveSearchDeadlineStart in scripts/search-companion.mjs. Additive and
			// back-compatible both directions, same as budgetMs: an older companion that has
			// never heard of `sentAt` simply ignores the extra field.
			sentAt: Date.now(),
		}, timeoutMs);
		const response = normalizeSearchResponse(json);
		const outdated = schemaOutdatedMessage(response.schemaVersion);
		if (!outdated) return response;
		return { ...response, rebuildRequired: true, message: response.message || outdated };
	}

	private async post(path: string, body: Record<string, unknown>, timeoutMs = SEARCH_SERVICE_TIMEOUT_MS): Promise<unknown> {
		const response = await this.request(path, 'POST', JSON.stringify(body), timeoutMs);
		return response.json;
	}

	// Single choke point for companion I/O. Timeouts, connection failures, and 5xx all mean
	// "the companion isn't answering" → SearchServiceUnavailableError (retryable). A 4xx is a
	// genuine request bug and stays a plain Error so it surfaces instead of retrying forever.
	//
	// `throw: false` is load-bearing, not cosmetic: Obsidian's `requestUrl` throws on any status
	// >= 400 by default, which would make every branch below dead code and every companion 4xx
	// (including the deliberate width/space-conflict 400s) land in the catch block below and get
	// wrapped as SearchServiceUnavailableError — "companion not reachable" — turning a client bug
	// into an infinite 30s defer loop instead of a surfaced, non-retryable error.
	//
	// The `kind` on each throw is what lets a caller (CompanionAvailabilityGate.probe) tell a
	// confirmed outage (refused, server-error) apart from a timeout, which confirms nothing —
	// see SearchServiceUnavailableErrorKind.
	private async request(path: string, method: string, body?: string, timeoutMs = SEARCH_SERVICE_TIMEOUT_MS): Promise<RequestUrlResponse> {
		let response: RequestUrlResponse;
		try {
			response = await withTimeout(requestUrl({
				url: `${this.root()}${path}`,
				method,
				headers: body ? { 'Content-Type': 'application/json' } : undefined,
				body,
				throw: false,
			}), timeoutMs, `Search service ${path} timed out after ${timeoutMs}ms`);
		} catch (e) {
			if (e instanceof SearchServiceUnavailableError) throw e;
			throw new SearchServiceUnavailableError(`Search service ${path} unreachable: ${e instanceof Error ? e.message : String(e)}`, 'refused');
		}
		if (response.status >= 500) {
			throw new SearchServiceUnavailableError(`Search service ${path} returned ${response.status}: ${response.text}`, 'server-error');
		}
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Search service ${path} returned ${response.status}: ${response.text}`);
		}
		return response;
	}

	private root(): string {
		return (this.baseUrl || 'http://127.0.0.1:4801').replace(/\/$/, '');
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new SearchServiceUnavailableError(message, 'timeout')), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function normalizeHealth(value: unknown): SearchHealth {
	if (!value || typeof value !== 'object') return { ok: true };
	const raw = value as Record<string, unknown>;
	return {
		ok: raw.ok !== false,
		version: typeof raw.version === 'string' ? raw.version : undefined,
		schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : undefined,
		vectorAvailable: typeof raw.vectorAvailable === 'boolean' ? raw.vectorAvailable : undefined,
		message: typeof raw.message === 'string' ? raw.message : undefined,
	};
}

// Returns the user-facing reason when the companion's index predates this build, or null
// when it is current. An absent schemaVersion means "can't tell" — that is not evidence of
// a stale index, so it is deliberately not treated as one.
function schemaOutdatedMessage(schemaVersion: number | undefined): string | null {
	if (typeof schemaVersion !== 'number' || !Number.isFinite(schemaVersion)) return null;
	if (schemaVersion >= SEARCH_REQUIRED_SCHEMA_VERSION) return null;
	return `Search index rebuild required: companion schema v${schemaVersion}, this build needs v${SEARCH_REQUIRED_SCHEMA_VERSION}`;
}

function numberField(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeAttribution(value: unknown): SearchScoreAttribution | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const raw = value as Record<string, unknown>;
	const boosts: Record<string, number> = {};
	if (raw.boosts && typeof raw.boosts === 'object') {
		for (const [key, entry] of Object.entries(raw.boosts as Record<string, unknown>)) {
			const boost = numberField(entry);
			if (boost !== undefined) boosts[key] = boost;
		}
	}
	const attribution: SearchScoreAttribution = {
		base: numberField(raw.base),
		textRank: numberField(raw.textRank),
		titleRank: numberField(raw.titleRank),
		titleBoost: numberField(raw.titleBoost),
		vectorRank: numberField(raw.vectorRank),
		rrf: numberField(raw.rrf),
		pooledChunks: numberField(raw.pooledChunks),
		boosts: Object.keys(boosts).length > 0 ? boosts : undefined,
	};
	return Object.values(attribution).some(entry => entry !== undefined) ? attribution : undefined;
}

function normalizeSearchResponse(value: unknown): SearchResponse {
	if (!value || typeof value !== 'object') return { results: [] };
	const raw = value as Record<string, unknown>;
	const results = Array.isArray(raw.results) ? raw.results : [];
	return {
		results: results.map((item) => {
			const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
			const path = stringField(row.path);
			return {
				chunkId: stringField(row.chunkId) || stringField(row.id),
				path,
				title: stringField(row.title) || path,
				heading: typeof row.heading === 'string' ? row.heading : undefined,
				snippet: stringField(row.snippet) || stringField(row.text),
				score: Number(row.score ?? 0),
				scoreText: typeof row.scoreText === 'number' ? row.scoreText : undefined,
				scoreVector: typeof row.scoreVector === 'number' ? row.scoreVector : undefined,
				scoreRrf: typeof row.scoreRrf === 'number' ? row.scoreRrf : undefined,
				metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : undefined,
				attribution: normalizeAttribution(row.attribution),
			};
		}).filter(row => row.path && row.snippet),
		total: typeof raw.total === 'number' && Number.isFinite(raw.total) ? raw.total : undefined,
		hasMore: typeof raw.hasMore === 'boolean' ? raw.hasMore : undefined,
		mode: raw.mode === 'vector' || raw.mode === 'hybrid' || raw.mode === 'fts' ? raw.mode : undefined,
		semanticAvailable: typeof raw.semanticAvailable === 'boolean' ? raw.semanticAvailable : undefined,
		message: typeof raw.message === 'string' ? raw.message : undefined,
		schemaVersion: numberField(raw.schemaVersion),
		// WP-5: additive-only field. A companion that predates the cooperative deadline (or an
		// in-budget response from a current one) simply omits it, which must normalize to
		// `undefined`, not a coerced `false` — `degraded === true` is the only meaningful state.
		degraded: raw.degraded === true ? true : undefined,
	};
}

function normalizeFileStates(value: unknown): Map<string, SearchFileState> {
	const out = new Map<string, SearchFileState>();
	if (!value || typeof value !== 'object') return out;
	const raw = value as Record<string, unknown>;
	const files = Array.isArray(raw.files) ? raw.files : [];
	for (const item of files) {
		const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
		const path = stringField(row.path);
		if (!path) continue;
		// Every embedding-coverage field is read defensively and independently: a companion
		// predating the coverage response simply omits them, which must degrade to "unknown"
		// (undefined) rather than throw or coerce into a confident false/true.
		out.set(path, {
			path,
			contentHash: typeof row.contentHash === 'string' && row.contentHash ? row.contentHash : undefined,
			mtime: typeof row.mtime === 'number' && Number.isFinite(row.mtime) ? row.mtime : undefined,
			chunkCount: typeof row.chunkCount === 'number' && Number.isFinite(row.chunkCount) ? row.chunkCount : undefined,
			hasEmbeddings: typeof row.hasEmbeddings === 'boolean' ? row.hasEmbeddings : undefined,
			embeddedChunkCount: typeof row.embeddedChunkCount === 'number' && Number.isFinite(row.embeddedChunkCount) ? row.embeddedChunkCount : undefined,
			embeddingModel: typeof row.embeddingModel === 'string' && row.embeddingModel ? row.embeddingModel : undefined,
			embeddingSpace: typeof row.embeddingSpace === 'string' && row.embeddingSpace ? row.embeddingSpace : undefined,
		});
	}
	return out;
}

function stringField(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}
