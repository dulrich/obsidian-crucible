import type { SearchHealth } from './types';

export const SEARCH_ONLINE_CACHE_MS = 30_000;
export const SEARCH_OFFLINE_CACHE_MS = 5 * 60_000;

export type SearchHealthCheck = () => Promise<SearchHealth | null>;

// Caches companion availability so a flurry of index/search calls makes at most one health
// probe per TTL window, and a known-down companion short-circuits without a probe. Owned by
// SearchManager and shared by every caller (auto-index path and orchestration workflows), so
// there is a single source of truth for "is the companion up".
export class CompanionAvailabilityGate {
	private onlineUntil = 0;
	private offlineUntil = 0;
	private inFlight: Promise<boolean> | null = null;
	private unavailableReason: string | null = null;

	constructor(private readonly now: () => number = () => Date.now()) {}

	// Why the last probe said "unavailable", when the companion told us. `available()`
	// collapses to a boolean, but not every unavailable state means "not running" — a
	// reachable companion serving an outdated index schema is also `ok: false`, and telling
	// the user to go start a container that is already healthy sends them the wrong way.
	// Null when the companion never answered at all (connection refused, timeout).
	lastUnavailableReason(): string | null {
		return this.unavailableReason;
	}

	async available(healthCheck: SearchHealthCheck): Promise<boolean> {
		const now = this.now();
		if (this.onlineUntil > now) return true;
		if (this.offlineUntil > now) return false;
		if (this.inFlight) return await this.inFlight;

		const probe = this.probe(healthCheck);
		this.inFlight = probe;
		try {
			return await probe;
		} finally {
			if (this.inFlight === probe) this.inFlight = null;
		}
	}

	// Record a failure observed outside a health probe (e.g. an upsert that threw
	// SearchServiceUnavailableError) so subsequent calls short-circuit to offline.
	markOffline(reason: string | null = null): void {
		this.offlineUntil = this.now() + SEARCH_OFFLINE_CACHE_MS;
		this.onlineUntil = 0;
		this.unavailableReason = reason;
	}

	private async probe(healthCheck: SearchHealthCheck): Promise<boolean> {
		const health = await healthCheck().catch(() => null);
		const ok = health?.ok === true;
		const now = this.now();
		if (ok) {
			this.onlineUntil = now + SEARCH_ONLINE_CACHE_MS;
			this.offlineUntil = 0;
			this.unavailableReason = null;
		} else {
			// A health payload that came back but reported not-ok carries its own reason
			// (today: an outdated index schema). No payload means nothing answered.
			this.markOffline(health?.message ?? null);
		}
		return ok;
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
