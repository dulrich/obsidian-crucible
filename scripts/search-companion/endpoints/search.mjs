import { clampSearchBudgetMs, resolveSearchDeadlineStart } from '../deadline.mjs';
import { json, readJson, requireString } from '../http.mjs';
import { DEFAULT_RANKING_MODE, parseRankingMode } from '../ranking.mjs';
import { SCHEMA_VERSION } from '../schema.mjs';
import { runSearch } from '../search.mjs';

// A fast, well-formed response for a request abandoned before any SQL ran — same shape as the
// deadline's own already-over-budget response (WP-5), plus `superseded: true` so a caller (or a
// test) can tell the two apart. Both flags are additive/optional on the wire: an old client's
// `normalizeSearchResponse` already tolerates an unrecognized key, and `degraded` alone still
// reads as "well-formed, just partial" for anything that only checks that field.
function supersededResponse() {
	return {
		mode: 'fts',
		semanticAvailable: false,
		schemaVersion: SCHEMA_VERSION,
		match: null,
		fallbackUsed: false,
		total: 0,
		hasMore: false,
		results: [],
		degraded: true,
		superseded: true,
	};
}

// POST /v1/search — the interactive route, and the only one that owns a deadline.
//
// Injected dependencies: the raw `db` (runSearch takes it, though every statement it runs is
// passed in prepared), the two prepared statements plus the hydrator, the vector backend, the
// clock, and the handler-scoped `state` holder it stamps `lastInteractiveSearchAt` on and reads
// the WP-SS2 `searchClients` supersede tracker from.
//
// **Deadline ownership stays on this route.** `receivedAt` is captured by the top-level
// handler as its literal first statement — before the URL parse and before this route's own
// `await readJson`, both of which are yield points a queued upsert flush can preempt — and is
// handed in as `request.receivedAt`. This route turns it into `deadlineAt` and passes that to
// runSearch, which is where every `overBudget()` checkpoint lives. Do not move the
// `receivedAt` stamp into this module: doing so would restore exactly the blindness WP-3
// removed, because by the time a route handler is selected the queue wait has already happened.
export function createSearchEndpoint({ db, statements, vectors, now, state }) {
	const { coverageStatement, hydrateChunk, searchStatement } = statements;
	return async (req, res, request) => {
		// WP-SS2: registered before `readJson` below (which yields to the event loop at least
		// once, and potentially many times for a slow-arriving body), so an abort that lands
		// mid-transmission is caught too, not only one after the body already finished. `res`
		// (not `req`) 'close' is the standard Node signal for "the underlying connection was
		// terminated before the response was ever sent" — exactly "can this request still be
		// answered," independent of whether the request body itself finished streaming.
		//
		// Deliberately NOT `req.destroyed`: an ordinary `IncomingMessage` has `autoDestroy`
		// semantics too — once its body finishes streaming ('end'), Node schedules the stream's
		// own destroy shortly after, which flips `req.destroyed` to `true` for every request,
		// disconnected or not. Checking it here would silently drop every real search behind a
		// timing race (confirmed live: a plain POST /v1/search hung forever, no response ever
		// sent, `fetch` waiting on a request this endpoint had silently abandoned). `res`'s own
		// 'close' has no such false-positive: before `res.end()` has been called, it fires only
		// when the underlying connection was actually torn down.
		let clientDisconnected = false;
		res.on('close', () => { clientDisconnected = true; });

		const body = await readJson(req);
		// WP-SS2: the fast-abandon checks, both before paying for the primary FTS scan.
		//
		// (1) Disconnect: SS1's client aborts a superseded/timed-out interactive search on the
		// wire (AbortController); that reaches the companion as the request socket closing.
		// Never write to a closed socket — there is nothing left to answer, and attempting the
		// write would throw.
		if (clientDisconnected) return;
		const vaultId = requireString(body.vaultId, 'vaultId');
		const query = requireString(body.query, 'query');
		// (2) Supersede: same-`clientId`, newer-`seq` requests (src/search/client.ts — attached
		// only when the caller supplied an AbortSignal, i.e. the interactive search modal, never
		// the background SearchIndexWorkflow.sweep()). Missing/invalid clientId or seq (an older
		// client, or a sweep) is inert here by construction — see
		// `state.searchClients.isSuperseded` — so this never changes behavior for a request that
		// never opted in.
		if (state.searchClients.isSuperseded(body.clientId, body.seq)) {
			return json(res, 200, supersededResponse());
		}
		// WP-5: the client's own cooperative-deadline hint (~80% of its own interactive
		// timeout, per src/search/client.ts), clamped server-side so it stays a safety
		// valve rather than something a malformed request can widen or disable. Absent
		// from an older client, which is exactly why clampSearchBudgetMs falls back to
		// SEARCH_DEADLINE_DEFAULT_MS instead of requiring the field.
		const budgetMs = clampSearchBudgetMs(body.budgetMs);
		// WP-3: `body.sentAt` (src/search/client.ts) lets the deadline start counting
		// from the client's own send time instead of only from `receivedAt` — see
		// resolveSearchDeadlineStart for the skew guard. `receivedAt` was captured as the
		// very first statement of the request handler, so it already reflects the queue
		// wait ahead of `readJson`; `sentAt` reaches further back, past the wait for that
		// handler to start running at all.
		const deadlineAt = resolveSearchDeadlineStart(body.sentAt, request.receivedAt, budgetMs) + budgetMs;
		const outcome = runSearch(db, {
			vaultId,
			query,
			limit: body.limit,
			statement: searchStatement,
			vectors,
			// Read at last: the client has been sending this field since the search
			// modal shipped and the companion has been dropping it on the floor.
			queryEmbedding: body.queryEmbedding,
			// Which vector space the query embedding was produced in. Absent from an
			// older client, which is why "no space named" still scans a single-space
			// vault rather than refusing.
			embeddingSpace: body.embeddingSpace,
			// Absent means 'current', i.e. every existing client keeps exactly the
			// ranking it has today. A *present but unrecognized* value is a 400 (see
			// parseRankingMode), never a silent degrade to the default.
			rankingMode: parseRankingMode(body.rankingMode),
			hydrate: hydrateChunk,
			coverageStatement,
			deadlineAt,
			// Same injected clock as receivedAt above, so every overBudget() checkpoint
			// inside runSearch reads the same (real, or test-controlled) time source.
			now,
		});
		const response = {
			// Computed from state, not hardcoded: 'hybrid' means a query embedding
			// arrived *and* the vault has vectors the scan actually used;
			// `semanticAvailable` means the vault could answer semantically at all.
			mode: outcome.vectorUsed ? 'hybrid' : 'fts',
			semanticAvailable: outcome.semanticAvailable,
			schemaVersion: SCHEMA_VERSION,
			match: outcome.match,
			fallbackUsed: outcome.fallbackUsed,
			total: outcome.total,
			hasMore: outcome.total > outcome.results.length,
			results: outcome.results,
		};
		// Only when a caller opted out of the default: a 'current' response stays the
		// exact payload it has always been, key for key.
		if (outcome.rankingMode !== DEFAULT_RANKING_MODE) {
			response.rankingMode = outcome.rankingMode;
			response.coverageUsed = outcome.coverageUsed;
			if (outcome.matchFallback) response.matchFallback = outcome.matchFallback;
		}
		if (outcome.note) response.message = outcome.note;
		// WP-5: additive-only. A request that finished inside budget carries no
		// `degraded` field at all, so it stays byte-identical to the pre-deadline
		// response shape — the client tolerates its absence unconditionally
		// (normalizeSearchResponse), which is what makes this safe against both an old
		// client talking to this companion and this companion answering an old client.
		if (outcome.degraded) response.degraded = true;
		// WP-4: mark this instant (per the injected clock, same as everything else above)
		// as the most recent interactive search served. A concurrently in-flight upsert
		// flush reads this at its next sub-batch boundary to decide whether to open an
		// interactive-priority gap — see INTERACTIVE_YIELD_MS. `state` is handler-scoped
		// rather than request-scoped precisely because the flush that reads it is always a
		// *different* request than the search that writes it.
		state.lastInteractiveSearchAt = now();
		return json(res, 200, response);
	};
}
