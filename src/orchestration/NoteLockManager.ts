import type { IngestionEventBus } from './events';

interface Waiter {
	label: string;
	resolve: (release: () => void) => void;
}

interface LockState {
	label: string;
	waiters: Waiter[];
}

/**
 * Per-note (path-keyed) async mutex. Commands that mutate the same note acquire
 * its lock and run one at a time, in FIFO order; commands on different notes run
 * concurrently. Acquiring emits `note-lock-changed` so the UI can gray out the
 * active note while it is busy. This is a separate concern from `isMaterializing`,
 * which suppresses the plugin's own writes from re-triggering auto-lint/localize.
 */
export class NoteLockManager {
	private readonly locks = new Map<string, LockState>();

	constructor(private readonly bus?: IngestionEventBus) {}

	isLocked(path: string): boolean {
		return this.locks.has(path);
	}

	lockedPaths(): string[] {
		return Array.from(this.locks.keys());
	}

	/** Label of the command currently holding the lock, or null if free. */
	currentLabel(path: string): string | null {
		return this.locks.get(path)?.label ?? null;
	}

	/** Acquire the lock for `path`, resolving with a release fn once it is free. */
	acquire(path: string, label: string): Promise<() => void> {
		const existing = this.locks.get(path);
		if (!existing) {
			this.locks.set(path, { label, waiters: [] });
			this.emit(path, true, label);
			return Promise.resolve(this.makeRelease(path));
		}
		return new Promise<() => void>(resolve => {
			existing.waiters.push({ label, resolve });
		});
	}

	/** Run `action` while holding the lock for `path`; always releases. */
	async withLock<T>(path: string, label: string, action: () => Promise<T>): Promise<T> {
		const release = await this.acquire(path, label);
		try {
			return await action();
		} finally {
			release();
		}
	}

	private makeRelease(path: string): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const state = this.locks.get(path);
			if (!state) return;
			const next = state.waiters.shift();
			if (next) {
				state.label = next.label;
				this.emit(path, true, next.label);
				next.resolve(this.makeRelease(path));
			} else {
				this.locks.delete(path);
				this.emit(path, false, '');
			}
		};
	}

	private emit(path: string, locked: boolean, label: string): void {
		this.bus?.emit('note-lock-changed', { path, locked, label });
	}
}

/**
 * Runs `action` under the note-lock when a manager is available, otherwise runs
 * it directly. Lets managers stay constructable without a lock (e.g. in tests)
 * while serializing peers in the live plugin.
 */
export function withOptionalNoteLock<T>(
	locks: NoteLockManager | undefined,
	path: string,
	label: string,
	action: () => Promise<T>,
): Promise<T> {
	return locks ? locks.withLock(path, label, action) : action();
}
