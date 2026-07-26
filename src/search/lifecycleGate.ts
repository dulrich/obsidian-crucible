import { SearchHealth, SearchServiceUnavailableError } from './types';

// Re-exported so tests bundling only this module can construct a matching instance for
// `instanceof` checks inside `probe()` below — mirrors the same re-export in `client.ts`.
export { SearchServiceUnavailableError } from './types';

export const SEARCH_ONLINE_CACHE_MS = 30_000;
export const SEARCH_OFFLINE_CACHE_MS = 5 * 60_000;

/**
 * Backoff for a failure seen *mid-operation* rather than by a health probe.
 *
 * A probe that asked the companion and got no usable answer is strong evidence it is down,
 * and re-probing on every queued job would be wasteful — hence the five-minute
 * SEARCH_OFFLINE_CACHE_MS. A request that threw partway through an operation is much weaker
 * evidence: the companion may be healthy and merely slow, or that one request may have
 * failed on its own merits. Latching those for the full offline window turned a single
 * hiccup into a five-minute stall of every queued job — during a rebuild, each Obsidian
 * reload then drained exactly one more batch. A short backoff instead lets the next job
 * re-probe for real, which either recovers immediately or escalates to the full window.
 */
export const SEARCH_TRANSIENT_OFFLINE_MS = 5_000;

// A single probe timeout is inconclusive (the companion may just be busy with our own bulk
// write), so it only takes the short transient backoff. Only this many CONSECUTIVE timeouts
// — with no intervening success — escalate to the full confirmed-outage latch. A `refused` or
// server-error result skips the streak entirely and latches immediately; it is not "waiting
// for silence to repeat", it is already a confirmed answer.
export const SEARCH_PROBE_TIMEOUT_ESCALATION_THRESHOLD = 3;

export type SearchHealthCheck = () => Promise<SearchHealth | null>;

// The wording a repeated-timeout escalation records as its reason. Deliberately does NOT say
// anything like "start it with home-compose up" — that copy is reserved for a confirmed
// `refused`/server-error outage (see SearchServiceUnavailableErrorKind and
// SearchIndexWorkflow.searchDeferredResult, which falls back to the container-restart text
// only when this reason is null). A repeated timeout is real evidence something is wrong, but
// not evidence the container needs restarting.
function timeoutReason(consecutiveTimeouts: number): string {
	return `Search companion has not answered ${consecutiveTimeouts} consecutive health probes; ` +
		`it may still be busy with a large index write. Retrying periodically rather than treating it as down.`;
}

// Caches companion availability so a flurry of index/search calls makes at most one health
// probe per TTL window, and a known-down companion short-circuits without a probe. Owned by
// SearchManager and shared by every caller (auto-index path and orchestration workflows), so
// there is a single source of truth for "is the companion up".
export class CompanionAvailabilityGate {
	private onlineUntil = 0;
	private offlineUntil = 0;
	private inFlight: Promise<boolean> | null = null;
	private unavailableReason: string | null = null;
	private consecutiveProbeTimeouts = 0;

	constructor(
		private readonly now: () => number = () => Date.now(),
		// Owned by SearchManager, not this gate: while it reports true, `available()` must not
		// probe at all, and any timeout that lands mid-flush is inconclusive by construction (the
		// companion is busy with OUR OWN write, not down). "Smallest seam wins" — the gate takes a
		// read-only callback rather than exposing a settable flag another module could poke.
		private readonly suppressProbing: () => boolean = () => false,
	) {}

	// Why the last probe said "unavailable", when the companion told us. `available()`
	// collapses to a boolean, but not every unavailable state means "not running" — a
	// reachable companion serving an outdated index schema is also `ok: false`, and telling
	// the user to go start a container that is already healthy sends them the wrong way.
	// Null when the companion never answered at all (connection refused) or was never probed;
	// a repeated-timeout escalation is the one "no answer" case that still sets a reason (see
	// timeoutReason above), specifically so it does NOT fall back to the refused-only copy.
	lastUnavailableReason(): string | null {
		return this.unavailableReason;
	}

	async available(healthCheck: SearchHealthCheck): Promise<boolean> {
		const now = this.now();
		if (this.onlineUntil > now) return true;
		if (this.offlineUntil > now) return false;
		// A bulk write of our own is in flight: a probe issued right now would race the same
		// single-threaded, synchronous-SQLite companion we're busy writing to, and a timeout it
		// produced would prove nothing. Skip the probe entirely rather than let it manufacture
		// false "unavailable" evidence — see SearchManager's flush-window flag.
		if (this.suppressProbing()) return true;
		if (this.inFlight) return await this.inFlight;

		const probe = this.probe(healthCheck);
		this.inFlight = probe;
		try {
			return await probe;
		} finally {
			if (this.inFlight === probe) this.inFlight = null;
		}
	}

	// A probe answered (or failed to answer) and said the companion is unusable: back off for
	// the full window before asking again.
	markOffline(reason: string | null = null): void {
		this.setOffline(reason, SEARCH_OFFLINE_CACHE_MS);
	}

	// Record a failure observed outside a health probe (e.g. an upsert that threw
	// SearchServiceUnavailableError) so subsequent calls short-circuit — but only briefly,
	// and keeping the reason so the deferral says what actually went wrong instead of the
	// generic "not reachable, go start the container" text. See SEARCH_TRANSIENT_OFFLINE_MS.
	markTransientFailure(reason: string | null = null): void {
		this.setOffline(reason, SEARCH_TRANSIENT_OFFLINE_MS);
	}

	private setOffline(reason: string | null, durationMs: number): void {
		this.offlineUntil = this.now() + durationMs;
		this.onlineUntil = 0;
		this.unavailableReason = reason;
	}

	private async probe(healthCheck: SearchHealthCheck): Promise<boolean> {
		let health: SearchHealth | null = null;
		let kind: SearchServiceUnavailableError['kind'] | null = null;
		try {
			health = await healthCheck();
		} catch (e) {
			health = null;
			// Only a typed SearchServiceUnavailableError carries a kind; anything else (a plain
			// thrown Error) is treated the same as before this change — an unclassified failure
			// earns the immediate confirmed-outage latch rather than the timeout leniency, which
			// is the conservative default (see the constructor's default kind on the error type).
			if (e instanceof SearchServiceUnavailableError) kind = e.kind;
		}
		const ok = health?.ok === true;
		const now = this.now();
		if (ok) {
			this.onlineUntil = now + SEARCH_ONLINE_CACHE_MS;
			this.offlineUntil = 0;
			this.unavailableReason = null;
			this.consecutiveProbeTimeouts = 0;
			return true;
		}
		if (kind === 'timeout') {
			this.consecutiveProbeTimeouts += 1;
			if (this.consecutiveProbeTimeouts >= SEARCH_PROBE_TIMEOUT_ESCALATION_THRESHOLD) {
				const streak = this.consecutiveProbeTimeouts;
				this.consecutiveProbeTimeouts = 0;
				this.markOffline(timeoutReason(streak));
			} else {
				this.markTransientFailure(timeoutReason(this.consecutiveProbeTimeouts));
			}
		} else {
			// A refused connection, a 5xx, or a reachable companion that answered ok:false (which
			// carries its own reason on `health`, e.g. an outdated index schema) — every one of
			// these is a confirmed answer (or confirmed silence of a kind timeouts are not), so
			// it earns the full offline window immediately.
			this.consecutiveProbeTimeouts = 0;
			this.markOffline(health?.message ?? null);
		}
		return false;
	}
}

// Tracks whether Obsidian itself is ready for background auto-indexing (layout drawn and
// metadata cache resolved). Distinct from availability: this is about the app's startup, not
// the companion.
export class SearchReadinessGate {
	private layoutReady = false;
	private metadataResolved = false;

	markLayoutReady(): void {
		this.layoutReady = true;
	}

	markMetadataResolved(): void {
		this.metadataResolved = true;
	}

	isReady(): boolean {
		return this.layoutReady && this.metadataResolved;
	}
}
