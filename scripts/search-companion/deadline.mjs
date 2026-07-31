// The cooperative per-request deadline's two pure helpers and the bounds they clamp to.
// Split out of the single-file companion (WP-rem-R3).
//
// The deadline is *checked* between statements inside runSearch and *started* by the search
// endpoint; this module only decides how wide the budget may be and which instant it counts
// from. Keeping that arithmetic dependency-free is what lets the deadline tests import it
// without a database.

// WP-5: companion-side cooperative deadline for /v1/search. The server is single-threaded with
// a synchronous `DatabaseSync`, so it cannot preempt a running SQL statement — the bound is
// checked BETWEEN statements/scans (runSearch's checkpoints below), never inside one. This is
// deliberately a *server-owned* budget, separate from and shorter than the client's own
// interactive timeout (`searchQueryTimeoutMs`, `src/search/client.ts`): the two-timeout law in
// `src/search/AGENTS.md` says the interactive and indexing budgets stay separate, and this adds
// a third, narrower one scoped to a single request rather than collapsing anything.
//
// Ground truth (WP-2, clsl-wp2-search-latency-2026-07-29, 28.7k-chunk index copy): a
// pathological 15-term query totals 674-800ms server-side, ~65% of it the zero-hit loose-OR
// rescue (built.fallback) and the rest the coverage leg's per-term scans — a single request
// cannot reach the old hardcoded 5s client timeout on its own. The real 5s producer is a
// request queuing behind the companion's own upsert flush (~17s/500 chunks at the live index
// size), which this deadline does not fix (see the flush-yield note in the WP-5 report) but
// does bound: a request that lands mid-queue and only gets to run once most of its budget is
// already gone degrades to a well-formed partial response instead of running to completion
// regardless of how late it started.
const SEARCH_DEADLINE_DEFAULT_MS = 3200;
const SEARCH_DEADLINE_MIN_MS = 500;
const SEARCH_DEADLINE_MAX_MS = 20_000;

// Exported so the request handler and tests share one clamp. A client-sent `budgetMs` of 0,
// negative, NaN, or absurdly large is clamped rather than trusted outright — the deadline is a
// server-side safety valve, not something a malformed or hostile request can disable by asking
// for Infinity, nor something that can starve even the cheap primary FTS clause by asking for 0.
export function clampSearchBudgetMs(value) {
	const ms = Number(value);
	if (!Number.isFinite(ms)) return SEARCH_DEADLINE_DEFAULT_MS;
	return Math.max(SEARCH_DEADLINE_MIN_MS, Math.min(ms, SEARCH_DEADLINE_MAX_MS));
}

// WP-3: resolves the instant the cooperative deadline should start counting from.
// `receivedAt` alone (the companion's own clock, stamped once the request handler is finally
// running) is blind to whatever queued the request ahead of it — the whole point of the
// WP-3 investigation: a request queued behind an upsert flush sub-batch can burn most of its
// client-side interactive timeout before the companion's handler ever gets to run, so a
// deadline that only starts at `receivedAt` never sees that cost and the companion answers
// "in budget" long after the client has already given up and thrown the response away. `sentAt`
// is the client's own clock at send time (sent alongside `budgetMs`, src/search/client.ts),
// which does see it.
//
// Guarded against clock skew: `sentAt` must land inside `[receivedAt - K*budgetMs, receivedAt]` —
// a request cannot have been sent after it was received, and a `sentAt` claiming to be more
// than K budgets' worth of clock disagreement into the past is not trustworthy queuing evidence,
// just a skewed or malformed clock. Outside that window, absent, or non-numeric (an older client
// that has never heard of `sentAt`) all fall back to `receivedAt` — the same deadline shape this
// replaces, so a mixed-version fleet degrades cleanly in both directions.
//
// WP-SS2: K was 1 (a queue delay larger than one budget made the guard distrust `sentAt` and
// restart the deadline from `receivedAt`, which grants a full fresh budget to exactly the
// requests that have been queued/abandoned longest — the inversion this constant fixes). The
// one-budget bound was justified by the upsert flush loop's `INTERACTIVE_YIELD_MS` interactive
// yield (search.mjs module comment above); no such yield exists between two queued searches, so
// a superseded/abandoned interactive request can plausibly sit behind several budgets' worth of
// queuing before this server-side supersede/disconnect check (see endpoints/search.mjs) ever
// gets a chance to drop it. Widening to K=5 budgets means that request now correctly resolves
// `sentAt` as trustworthy, reads as already over budget, and degrades in ~ms instead of being
// treated as fresh. A `sentAt` older than K budgets, or in the future, still falls back to
// `receivedAt` — genuine skew/garbage, not queuing evidence, is unaffected by this change.
const SEARCH_DEADLINE_SKEW_TRUST_BUDGETS = 5;

export function resolveSearchDeadlineStart(sentAt, receivedAt, budgetMs) {
	const parsed = Number(sentAt);
	if (!Number.isFinite(parsed)) return receivedAt;
	if (parsed < receivedAt - SEARCH_DEADLINE_SKEW_TRUST_BUDGETS * budgetMs || parsed > receivedAt) return receivedAt;
	return parsed;
}
