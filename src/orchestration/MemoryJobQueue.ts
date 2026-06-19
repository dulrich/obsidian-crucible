// A generic in-memory job queue for "memory" persistence job types. It holds the
// three behaviors that distinguished the old EnrichmentQueueService — idempotent
// keying, auto-source refill, and terminal-entry cleanup — while the unified
// runner (OrchestrationAutoRunner) owns the actual draining/pacing. Entries are
// passive: the runner claims pending entries, executes the workflow, and reports
// the result back here.
import type { JobLane } from './types';

export type MemoryJobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface MemoryJobEntry {
	key: string;
	params: Record<string, unknown>;
	display: Record<string, unknown>;
	status: MemoryJobStatus;
	lane: JobLane;
	error?: string;
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
	private autoEnabled = false;

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

	setAutoEnabled(enabled: boolean): void {
		this.autoEnabled = enabled;
		this.refill();
	}

	isAutoEnabled(): boolean {
		return this.autoEnabled;
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
		if (!this.autoEnabled || !this.autoSource) return;
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

	sweepTerminal(): void {
		const cutoff = Date.now() - this.retentionMs;
		let changed = false;
		for (const [key, entry] of this.entries) {
			if (entry.status !== 'done' && entry.status !== 'failed') continue;
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
		case 'done': return 3;
	}
}

function laneRank(lane: JobLane): number {
	switch (lane) {
		case 'user': return 0;
		case 'background': return 1;
	}
}
