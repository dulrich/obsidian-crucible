// A generic in-memory job queue for "memory" persistence job types. It holds the
// three behaviors that distinguished the old EnrichmentQueueService — idempotent
// keying, auto-source refill, and terminal-entry cleanup — while the unified
// runner (OrchestrationAutoRunner) owns the actual draining/pacing. Entries are
// passive: the runner claims pending entries, executes the workflow, and reports
// the result back here.
import type { JobLane } from './types';
import { laneRank } from './lanes';

// `cancelled` mirrors the file backend's terminal bucket: a stopped entry must not
// render or count as a failure.
export type MemoryJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

function isTerminal(status: MemoryJobStatus): boolean {
	return status === 'done' || status === 'failed' || status === 'cancelled';
}

export interface MemoryJobEntry {
	key: string;
	params: Record<string, unknown>;
	display: Record<string, unknown>;
	status: MemoryJobStatus;
	lane: JobLane;
	error?: string;
	/** Human-readable detail for a non-failure terminal state (today: cancelled). */
	note?: string;
	addedAt: number;
	finishedAt?: number;
}

export interface MemoryJobSeed {
	key: string;
	params: Record<string, unknown>;
	display?: Record<string, unknown>;
	lane?: JobLane;
}

export class MemoryJobQueue {
	private readonly entries = new Map<string, MemoryJobEntry>();
	private autoSource: (() => MemoryJobSeed[]) | null = null;
	// Whether the auto-source is allowed to feed the queue (auto-ENQUEUE / source).
	// Orthogonal to draining: the runner's auto-run gate decides execution.
	private autoSourceEnabled = false;

	constructor(
		private readonly retentionMs: number,
		private readonly onChange: (size: number) => void,
	) {}

	dispose(): void {
		this.entries.clear();
		this.autoSource = null;
	}

	setAutoSource(fn: (() => MemoryJobSeed[]) | null): void {
		this.autoSource = fn;
		this.refill();
	}

	setAutoSourceEnabled(enabled: boolean): void {
		this.autoSourceEnabled = enabled;
		this.refill();
	}

	isAutoSourceEnabled(): boolean {
		return this.autoSourceEnabled;
	}

	// Idempotent enqueue: rejects if a job with the same key is already pending or
	// running. A pending background entry is promoted by a user enqueue; running
	// entries are never interrupted. A terminal (done/failed) entry is replaced.
	enqueue(key: string, params: Record<string, unknown>, display: Record<string, unknown> = {}, lane: JobLane = 'background'): boolean {
		if (!key) return false;
		const existing = this.entries.get(key);
		if (existing && existing.status === 'pending') {
			if (existing.lane === 'background' && lane === 'user') {
				existing.lane = 'user';
				existing.params = params;
				existing.display = display;
				this.onChange(this.entries.size);
				return true;
			}
			return false;
		}
		if (existing && existing.status === 'running') return false;
		this.entries.set(key, { key, params, display, lane, status: 'pending', addedAt: Date.now() });
		this.onChange(this.entries.size);
		return true;
	}

	// Forgets a pending entry outright. Distinct from `cancelIfPending`, which is what
	// a user's Cancel uses: deleting hands the key straight back to the auto-source,
	// whereas a terminal entry suppresses its own re-seed until the retention window
	// expires. Use this one only when the entry should be re-offerable immediately.
	dequeueIfPending(key: string): boolean {
		const entry = this.entries.get(key);
		if (!entry || entry.status !== 'pending') return false;
		this.entries.delete(key);
		this.onChange(this.entries.size);
		return true;
	}

	getEntry(key: string): MemoryJobEntry | null {
		const e = this.entries.get(key);
		return e ? { ...e } : null;
	}

	snapshot(): MemoryJobEntry[] {
		return Array.from(this.entries.values())
			.map(e => ({ ...e }))
			.sort((a, b) => statusRank(a.status) - statusRank(b.status) || laneRank(a.lane) - laneRank(b.lane) || a.addedAt - b.addedAt);
	}

	getPendingCount(): number {
		let n = 0;
		for (const e of this.entries.values()) {
			if (e.status === 'pending' || e.status === 'running') n++;
		}
		return n;
	}

	hasPending(): boolean {
		for (const e of this.entries.values()) {
			if (e.status === 'pending') return true;
		}
		return false;
	}

	// Pulls auto-source candidates into the queue. Skips any key already tracked in
	// any state (pending/running keep their slot; done/failed are intentionally not
	// re-enqueued so a one-shot result is not retried on every refill).
	refill(): void {
		if (!this.autoSourceEnabled || !this.autoSource) return;
		let changed = false;
		for (const seed of this.autoSource()) {
			if (!seed.key || this.entries.has(seed.key)) continue;
			this.entries.set(seed.key, {
				key: seed.key,
				params: seed.params,
				display: seed.display ?? {},
				lane: seed.lane ?? 'background',
				status: 'pending',
				addedAt: Date.now(),
			});
			changed = true;
		}
		if (changed) this.onChange(this.entries.size);
	}

	// Atomically claims the next pending entry (no await before the status flip, so
	// concurrent workers never claim the same entry). Returns a live reference.
	claimNext(): MemoryJobEntry | null {
		const pending = Array.from(this.entries.values())
			.filter(entry => entry.status === 'pending')
			.sort((a, b) => laneRank(a.lane) - laneRank(b.lane) || a.addedAt - b.addedAt);
		for (const entry of pending) {
			if (entry.status === 'pending') {
				entry.status = 'running';
				this.onChange(this.entries.size);
				return entry;
			}
		}
		return null;
	}

	// Atomically claims one specific pending entry by key for a manual per-job Run.
	// Same no-await-before-flip guarantee as claimNext, so it can't race a drain that
	// already took it. Returns null if the key is absent or not pending.
	claimEntry(key: string): MemoryJobEntry | null {
		const entry = this.entries.get(key);
		if (!entry || entry.status !== 'pending') return null;
		entry.status = 'running';
		this.onChange(this.entries.size);
		return entry;
	}

	markDone(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		entry.status = 'done';
		entry.finishedAt = Date.now();
		this.onChange(this.entries.size);
	}

	markFailed(key: string, error: string): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		entry.status = 'failed';
		entry.error = error;
		entry.finishedAt = Date.now();
		this.onChange(this.entries.size);
	}

	// Terminal, and distinct from markFailed on purpose: `error` is left unset so a
	// cancelled entry never renders as a diagnostic, and the auto-source latch that
	// markFailed can trip (no-api-key) has no counterpart here.
	markCancelled(key: string, note?: string): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		entry.status = 'cancelled';
		entry.note = note;
		entry.finishedAt = Date.now();
		this.onChange(this.entries.size);
	}

	// Cancels a *pending* entry — the queued half of the single Cancel verb. Marks it
	// terminal rather than deleting it (which is what `dequeueIfPending` does), for one
	// reason that matters: `refill` skips any key already tracked in any state, so a
	// terminal entry keeps suppressing its own auto-source seed. Deleting it hands the
	// key straight back to an enabled auto-source, which re-adds the item on the very
	// next refill and makes the user's Cancel look ignored. The suppression is not
	// permanent — `sweepTerminal` reaps the entry after `retentionMs`, after which the
	// source may legitimately offer it again. The UI copy says so.
	cancelIfPending(key: string, note?: string): boolean {
		const entry = this.entries.get(key);
		if (!entry || entry.status !== 'pending') return false;
		this.markCancelled(key, note);
		return true;
	}

	// Cancels every pending entry, with a SINGLE onChange for the whole batch: each
	// onChange emits `enrichment-queue-updated` and kicks a drain, so a per-entry call
	// would fan one user action into N of both.
	clearPending(note?: string): number {
		let cancelled = 0;
		for (const entry of this.entries.values()) {
			if (entry.status !== 'pending') continue;
			entry.status = 'cancelled';
			entry.note = note;
			entry.finishedAt = Date.now();
			cancelled++;
		}
		if (cancelled > 0) this.onChange(this.entries.size);
		return cancelled;
	}

	sweepTerminal(): void {
		const cutoff = Date.now() - this.retentionMs;
		let changed = false;
		for (const [key, entry] of this.entries) {
			if (!isTerminal(entry.status)) continue;
			if ((entry.finishedAt ?? 0) > cutoff) continue;
			this.entries.delete(key);
			changed = true;
		}
		if (changed) this.onChange(this.entries.size);
	}
}

function statusRank(status: MemoryJobStatus): number {
	switch (status) {
		case 'running': return 0;
		case 'pending': return 1;
		case 'failed': return 2;
		case 'cancelled': return 3;
		case 'done': return 4;
	}
}
