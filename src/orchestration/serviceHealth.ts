// Service health for the unified queue: the concept the queue was missing.
//
// Before this, a dependency outage had no representation anywhere. Each job that
// touched the dead service failed on its own merits, so one companion outage wrote
// 2,022 individual failure files, and the drain kept claiming at ~40 jobs/s because
// nothing above the job level knew the outage existed. This registry is that level:
// a per-service circuit breaker that job execution *reports into* and the drain
// *reads before claiming*.
//
// Three properties are load-bearing and easy to lose in a rewrite.
//
//  * **It is entirely passive.** It never issues a network request of its own — not
//    even a health probe. Beyond cleanliness that is a hard constraint here: the GPU
//    inference services are systemd socket-activated, so any TCP touch starts the
//    container and defeats their idle-exit. The half-open "probe" is nothing more
//    than permission for the drain to claim *one* real job; that job's own outcome is
//    the measurement.
//  * **State is in-memory and never persisted.** A breaker that survives a reload can
//    wedge a service that recovered while Obsidian was closed, and the cost of
//    rebuilding the hysteresis from scratch is bounded at three deferrals with zero
//    failures. A stale-open breaker is strictly worse than a fresh cycle.
//  * **`ServiceId` is an open string set.** The four constants below are today's
//    users; `llm:<providerId>` and friends arrive without touching this file.

import { logWarn } from '../log';

/**
 * How a dependency failed, as observed by the code that talked to it.
 *
 * Deliberately a superset of, and a separate type from, `SearchServiceUnavailableError.kind`
 * in `src/search/types.ts`: that one describes one client's transport outcomes, this
 * one is the queue's vocabulary for every service (`rate-limited` is a YouTube-quota
 * / HTTP 429 shape the search companion has no notion of). Keeping them separate is
 * what lets either move without dragging the other.
 */
export type ServiceFailureKind = 'refused' | 'timeout' | 'server-error' | 'rate-limited';

/** Open string set on purpose — see the module comment. */
export type ServiceId = string;

export const SERVICE_SEARCH_COMPANION = 'search-companion';
export const SERVICE_SEARCH_EMBEDDER = 'search-embedder';
// Shared by both the metadata-enrichment fetch (videos.list/channels.list) and the
// channel tracker (playlistItems.list, since the RSS->Data-API swap) — one upstream
// (googleapis.com/youtube/v3), one breaker.
export const SERVICE_YOUTUBE_API = 'youtube-api';
/**
 * idh-WP-2: the configured image-description vision model's inference endpoint (local router
 * or remote openai-compatible provider). Reported unhealthy by the image-describe infra breaker
 * (`orchestration/utils/imageDescribe.ts`) on a connection-class error or 3 consecutive
 * provider-call timeouts — the same "one dependency outage, many independent job failures" shape
 * this registry exists for (see the module comment's 2,022-failure-file precedent), applied to a
 * second dependency.
 */
export const SERVICE_IMAGE_DESCRIPTION_PROVIDER = 'image-description-provider';

/**
 * `closed` = healthy, claim freely. `open` = do not claim. `half-open` = the open
 * window elapsed; exactly one job may be claimed as the probe, and its outcome
 * decides which way the breaker goes.
 */
export type ServiceHealthState = 'closed' | 'open' | 'half-open';

/** Consecutive-failure weight needed to open the breaker. */
export const SERVICE_OPEN_THRESHOLD = 3;
/**
 * A refused connection counts double. It is the one kind that is *unambiguous* —
 * nothing is listening — where a timeout or a 5xx can be a slow or briefly unhappy
 * service. Two refusals are as much evidence as three of anything else.
 */
export const SERVICE_REFUSED_WEIGHT = 2;
export const SERVICE_OPEN_WINDOW_MS = 30_000;
export const SERVICE_MAX_OPEN_WINDOW_MS = 10 * 60_000;
/**
 * A probe token is released if the job holding it never reports back (it threw
 * somewhere that reports nothing, or the plugin reloaded mid-run). Without this the
 * service would sit half-open with the token held and never drain again — a wedge
 * that looks exactly like the outage it was trying to recover from.
 */
export const SERVICE_PROBE_STALE_MS = 5 * 60_000;

export interface ServiceHealthSnapshot {
	service: ServiceId;
	state: ServiceHealthState;
	/** Weighted consecutive-failure score; resets to 0 on any success. */
	failureScore: number;
	/** How many times this service has opened without an intervening success. */
	openCount: number;
	/** Last observed failure, kept for the UI even after the breaker closes. */
	lastKind?: ServiceFailureKind;
	lastReason?: string;
	/** Epoch ms the breaker opened, and when its window elapses into half-open. */
	openedAt?: number;
	retryAt?: number;
	/** True while a half-open probe token is outstanding. */
	probeInFlight: boolean;
}

export interface ServiceHealthTransition {
	service: ServiceId;
	from: ServiceHealthState;
	to: ServiceHealthState;
	snapshot: ServiceHealthSnapshot;
}

type TransitionListener = (transition: ServiceHealthTransition) => void;

interface ServiceEntry {
	state: ServiceHealthState;
	failureScore: number;
	openCount: number;
	lastKind?: ServiceFailureKind;
	lastReason?: string;
	openedAt?: number;
	retryAt?: number;
	probeAcquiredAt?: number;
}

function freshEntry(): ServiceEntry {
	return { state: 'closed', failureScore: 0, openCount: 0 };
}

/**
 * In-memory circuit breaker per dependency. Owned by the plugin (`plugin.serviceHealth`),
 * written by job execution, read by the drain.
 */
export class ServiceHealthRegistry {
	private readonly services = new Map<ServiceId, ServiceEntry>();
	private readonly listeners = new Set<TransitionListener>();

	/** `now` is injectable so the hysteresis/backoff is testable without real timers. */
	constructor(private readonly now: () => number = () => Date.now()) {}

	/**
	 * Report that a job's dependency failed.
	 *
	 * `retryAfterMs` is the server's own instruction (an HTTP 429 `Retry-After`, a
	 * YouTube quota reset) and *overrides* the computed backoff when the breaker opens
	 * — guessing 30s against a service that just said "come back in an hour" is how a
	 * quota outage turns into an hour of pointless probing.
	 */
	reportFailure(service: ServiceId, kind: ServiceFailureKind, reason: string, retryAfterMs?: number): void {
		const entry = this.entry(service);
		const from = entry.state;
		entry.lastKind = kind;
		entry.lastReason = reason;

		if (from === 'open') {
			// Already open: record what we learned, but do not extend the window. A
			// failure observed here came from a manual run (which bypasses the breaker by
			// design), and a user's click must not push recovery further away.
			return;
		}

		if (from === 'half-open') {
			// The probe failed: straight back to open with the next (doubled) window. The
			// score is irrelevant here — a failed probe IS the evidence.
			this.releaseProbe(service);
			this.open(entry, service, from, retryAfterMs);
			return;
		}

		entry.failureScore += kind === 'refused' ? SERVICE_REFUSED_WEIGHT : 1;
		if (entry.failureScore >= SERVICE_OPEN_THRESHOLD) this.open(entry, service, from, retryAfterMs);
	}

	/**
	 * Report that a job's dependency answered. Any success closes the breaker outright
	 * and resets the backoff — there is no gradual re-closing, because the only
	 * evidence that matters is that the service just did real work.
	 */
	reportSuccess(service: ServiceId): void {
		const entry = this.services.get(service);
		if (!entry) return;
		const from = entry.state;
		entry.failureScore = 0;
		entry.openCount = 0;
		entry.openedAt = undefined;
		entry.retryAt = undefined;
		entry.probeAcquiredAt = undefined;
		entry.state = 'closed';
		if (from !== 'closed') this.emit(service, from, 'closed');
	}

	/** True only when the breaker is fully closed. Half-open goes through `tryAcquireProbe`. */
	isHealthy(service: ServiceId): boolean {
		return (this.services.get(service)?.state ?? 'closed') === 'closed';
	}

	isHalfOpen(service: ServiceId): boolean {
		return this.services.get(service)?.state === 'half-open';
	}

	stateOf(service: ServiceId): ServiceHealthState {
		return this.services.get(service)?.state ?? 'closed';
	}

	/**
	 * Single-flight permission to claim ONE job as the half-open probe. Returns false
	 * for a closed breaker too: a caller must check `isHealthy` first, so a `true` here
	 * always means "you now hold the probe token and must report its outcome".
	 */
	tryAcquireProbe(service: ServiceId): boolean {
		const entry = this.services.get(service);
		if (!entry || entry.state !== 'half-open') return false;
		if (entry.probeAcquiredAt !== undefined) return false;
		entry.probeAcquiredAt = this.now();
		return true;
	}

	/**
	 * Hand a probe token back without a verdict. Used when a caller acquired probes for
	 * several services and then could not acquire them all — a type that needs two
	 * services must not run on one, and the token it did take must not strand the other
	 * service half-open.
	 */
	releaseProbe(service: ServiceId): void {
		const entry = this.services.get(service);
		if (entry) entry.probeAcquiredAt = undefined;
	}

	/**
	 * Advance time-based state: open windows that have elapsed become half-open, and a
	 * probe token nobody reported on is reclaimed. Called by the autorunner's 60s
	 * backstop interval — the guaranteed wake that replaced the single replaceable
	 * retry timer.
	 */
	tick(now = this.now()): void {
		for (const [service, entry] of this.services) {
			if (entry.probeAcquiredAt !== undefined && now - entry.probeAcquiredAt > SERVICE_PROBE_STALE_MS) {
				logWarn('serviceHealth', `probe token for "${service}" was never reported on; reclaiming`);
				entry.probeAcquiredAt = undefined;
			}
			if (entry.state !== 'open') continue;
			if ((entry.retryAt ?? 0) > now) continue;
			entry.state = 'half-open';
			entry.probeAcquiredAt = undefined;
			this.emit(service, 'open', 'half-open');
		}
	}

	onTransition(listener: TransitionListener): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** Every service the registry has heard about, for the queue monitor's pills. */
	snapshot(): ServiceHealthSnapshot[] {
		return Array.from(this.services.keys())
			.sort()
			.map(service => this.snapshotFor(service));
	}

	snapshotFor(service: ServiceId): ServiceHealthSnapshot {
		const entry = this.services.get(service) ?? freshEntry();
		return {
			service,
			state: entry.state,
			failureScore: entry.failureScore,
			openCount: entry.openCount,
			lastKind: entry.lastKind,
			lastReason: entry.lastReason,
			openedAt: entry.openedAt,
			retryAt: entry.retryAt,
			probeInFlight: entry.probeAcquiredAt !== undefined,
		};
	}

	/** Drops all state and listeners (plugin unload / tests). */
	dispose(): void {
		this.services.clear();
		this.listeners.clear();
	}

	private entry(service: ServiceId): ServiceEntry {
		let entry = this.services.get(service);
		if (!entry) {
			entry = freshEntry();
			this.services.set(service, entry);
		}
		return entry;
	}

	private open(entry: ServiceEntry, service: ServiceId, from: ServiceHealthState, retryAfterMs?: number): void {
		const now = this.now();
		// Backoff is computed from the *pre-increment* open count so the first open is
		// the base window: 30s, 60s, 120s … capped at 10 minutes.
		const computed = Math.min(SERVICE_OPEN_WINDOW_MS * Math.pow(2, entry.openCount), SERVICE_MAX_OPEN_WINDOW_MS);
		const windowMs = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
			? Math.max(1000, retryAfterMs)
			: computed;
		entry.openCount += 1;
		entry.failureScore = 0;
		entry.state = 'open';
		entry.openedAt = now;
		entry.retryAt = now + windowMs;
		entry.probeAcquiredAt = undefined;
		this.emit(service, from, 'open');
	}

	private emit(service: ServiceId, from: ServiceHealthState, to: ServiceHealthState): void {
		const transition: ServiceHealthTransition = { service, from, to, snapshot: this.snapshotFor(service) };
		for (const listener of Array.from(this.listeners)) {
			try {
				listener(transition);
			} catch (err) {
				logWarn('serviceHealth', 'transition listener threw', err);
			}
		}
	}
}
