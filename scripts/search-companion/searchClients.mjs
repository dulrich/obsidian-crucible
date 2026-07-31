// WP-SS2: companion-side supersede tracking for interactive /v1/search requests.
//
// SS1 gave the client an abortable transport (AbortController-backed `fetch`) and it aborts the
// previous request on the wire whenever a newer one supersedes it — but the `requestUrl`
// fallback (CORS-shaped `fetch` failure, or an older client) is not abortable, and even an
// aborted `fetch` can leave a request already mid-flight on the companion side (the abort races
// the TCP teardown against however far the companion's single synchronous thread has already
// gotten). This tracker is the companion's own half of the fix: given a per-session `clientId`
// and a monotonic `seq` (src/search/client.ts, attached only when the caller supplied an
// AbortSignal — see the pinned design note there), it lets the pre-flight gate in
// endpoints/search.mjs recognize "a newer request from this same client has already been seen"
// and abandon the older one before it pays for any SQL.
//
// Pure and dependency-free, like every module under this directory — no `http`/`sqlite` import,
// so it's importable and testable without a database or a server.

// Bounds the holder so a long-running session (or many concurrent vault instances sharing one
// companion) can't grow it unboundedly. A search modal mints exactly one clientId per plugin
// session, so realistic concurrency is small; this cap is generous headroom, not a tuned figure.
export const MAX_SEARCH_CLIENTS = 64;

/**
 * Creates a handler-scoped holder, same lifetime and sharing pattern as `state` in handler.mjs
 * (one instance per companion process, shared across every request it serves — a client's
 * requests over the lifetime of one Node process, not per-request state).
 *
 * The Map doubles as a simple LRU: `isSuperseded` re-inserts a client's key on every request
 * that advances its high-water seq, which moves it to the end of Map iteration order. When the
 * holder is over `MAX_SEARCH_CLIENTS`, the oldest (least-recently-advanced) entry is evicted —
 * cheap because Map iteration order is insertion order and `.keys().next()` is O(1).
 */
export function createSearchClientTracker() {
	const highestSeqByClient = new Map();

	return {
		/**
		 * Records `seq` as the newest request seen for `clientId` and reports whether THIS
		 * request is already superseded by one this tracker has already recorded — i.e. a
		 * strictly higher `seq` for the same `clientId` arrived (and was recorded) first.
		 *
		 * Record and check are one atomic step, not two, because `runSearch` is fully
		 * synchronous and this is called immediately before it with no `await` in between —
		 * splitting "record on arrival" from "check at the pre-flight gate" would add a
		 * distinction with no observable difference, since nothing else can run in between.
		 *
		 * Missing/invalid `clientId` or `seq` (an older client, or the background
		 * `SearchIndexWorkflow.sweep()` path, which never attaches either — see the pinned
		 * design note in src/search/client.ts) always returns `false` and never touches the
		 * map at all: backward compatibility is a hard invariant, and "never tracked" is what
		 * makes an identity-less request behave byte-identically to before this change.
		 */
		isSuperseded(clientId, seq) {
			if (typeof clientId !== 'string' || clientId.trim() === '') return false;
			const seqNum = Number(seq);
			if (!Number.isFinite(seqNum)) return false;

			const previous = highestSeqByClient.get(clientId);
			if (previous !== undefined && seqNum <= previous) {
				// A strictly higher seq for this clientId was already recorded — this request
				// is stale. Deliberately NOT re-inserted (left at its current LRU position, or
				// absent if this clientId was evicted): a superseded request should not refresh
				// its client's eviction priority any more than not seeing it at all would.
				return true;
			}

			// New high-water mark for this client. Delete-then-set (rather than a plain `set`
			// on an existing key) is what moves the key to the end of Map iteration order —
			// `set` alone does not reorder an already-present key.
			highestSeqByClient.delete(clientId);
			highestSeqByClient.set(clientId, seqNum);
			if (highestSeqByClient.size > MAX_SEARCH_CLIENTS) {
				const oldest = highestSeqByClient.keys().next().value;
				highestSeqByClient.delete(oldest);
			}
			return false;
		},

		// Test/diagnostic seam only — production code never reads the holder's size.
		size() {
			return highestSeqByClient.size;
		},
	};
}
