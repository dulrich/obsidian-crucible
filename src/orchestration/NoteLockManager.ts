// Intentional Node builtin: AsyncLocalStorage powers withLock's context-scoped
// reentrancy. esbuild.config.mjs externalizes `node:` builtins and Electron's
// renderer resolves it at runtime. See the note-lock quirk in AGENTS.md.
// eslint-disable-next-line import/no-nodejs-modules
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IngestionEventBus } from './events';
import { logWarn } from '../log';

interface Waiter {
	label: string;
	resolve: (release: () => void) => void;
}

interface LockState {
	// Current path this lock is keyed under. Updated by `handleRename` so a lock
	// held across a note move stays consistent with path-based gates. Release and
	// reentrancy track the LockState object, not the path, so they survive a re-key.
	key: string;
	label: string;
	waiters: Waiter[];
}

/**
 * Builds the lock key for a non-note resource (e.g. a yt-video-id). `:` is
 * illegal in vault filenames, so `kind::id` can never collide with a note path.
 */
export function resourceLockKey(kind: string, id: string): string {
	return `${kind}::${id}`;
}

function isResourceKey(key: string): boolean {
	return key.includes('::');
}

/**
 * Per-note (path-keyed) async mutex, extended to arbitrary resource keys
 * (`kind::id`, see `resourceLockKey`). Commands that mutate the same note acquire
 * its lock and run one at a time, in FIFO order; commands on different notes run
 * concurrently. Acquiring emits `note-lock-changed` so the UI can gray out the
 * active note while it is busy (resource keys do not emit — they have no editor
 * overlay). This is a separate concern from `isMaterializing`, which suppresses
 * the plugin's own writes from re-triggering auto-lint/localize.
 *
 * Ordering rule (deadlock prevention): acquire the note lock BEFORE any resource
 * lock; a holder of a resource lock must never acquire a note lock. See the
 * note-lock quirk in AGENTS.md.
 */
export class NoteLockManager {
	private readonly locks = new Map<string, LockState>();
	/**
	 * Paths already held by the current async execution context. Lets `withLock`
	 * re-enter: a command that runs *inside* another command already holding the
	 * same note's lock (e.g. a chain step that invokes lint/localize/yt-metadata
	 * on the chain's target note) runs inline instead of deadlocking on a lock its
	 * own caller owns. Held locks are tracked by `LockState` object identity (not
	 * path) so reentrancy survives a `handleRename` re-key.
	 */
	private readonly heldByContext = new AsyncLocalStorage<Set<LockState>>();

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
			const state: LockState = { key: path, label, waiters: [] };
			this.locks.set(path, state);
			this.emit(path, true, label);
			return Promise.resolve(this.makeRelease(state));
		}
		return new Promise<() => void>(resolve => {
			existing.waiters.push({ label, resolve });
		});
	}

	/**
	 * Follow a note rename so path-keyed gates (`isLocked`, auto-lint/localize,
	 * `TriggerRegistry`, `onNoteRename`) stay consistent with the held lock. A
	 * mutating chain/command keeps holding its lock while a step moves the target
	 * note; without this the lock strands under the old path and peers see the new
	 * path as unlocked and write concurrently. Reentrancy/release track the
	 * `LockState` object, so re-keying the map entry is safe for the holder.
	 */
	handleRename(oldPath: string, newPath: string): void {
		if (oldPath === newPath) return;
		const state = this.locks.get(oldPath);
		if (!state) return; // nothing held under the old path
		if (this.locks.has(newPath)) {
			// Rare: the target path already has its own lock. The mover checks the
			// target doesn't exist first, so this is unexpected; leave both as-is.
			logWarn('note-lock rename collision; leaving lock under old path', oldPath, newPath);
			return;
		}
		this.locks.delete(oldPath);
		state.key = newPath;
		this.locks.set(newPath, state);
		this.emit(oldPath, false, '');
		this.emit(newPath, true, state.label);
	}

	/**
	 * Run `action` while holding the lock for the resource `kind::id` — e.g.
	 * `withResourceLock('yt-video', videoId, …)` serializes the check-then-create
	 * of a video's metadata note across jobs/commands targeting different notes.
	 * Must be acquired INSIDE any note lock, never the other way around.
	 */
	withResourceLock<T>(kind: string, id: string, label: string, action: () => Promise<T>): Promise<T> {
		return this.withLock(resourceLockKey(kind, id), label, action);
	}

	/** Run `action` while holding the lock for `path`; always releases. */
	async withLock<T>(path: string, label: string, action: () => Promise<T>): Promise<T> {
		const held = this.heldByContext.getStore();
		const current = this.locks.get(path);
		if (current && held?.has(current)) {
			// Re-entrant: this async context already holds the lock for `path`,
			// so acquiring again would wait on ourselves forever. Run inline.
			return action();
		}
		const release = await this.acquire(path, label);
		// We are now the holder; track the LockState by identity so reentrancy and
		// release survive a `handleRename` that re-keys this lock to a new path.
		const state = this.locks.get(path);
		const nextHeld = new Set(held ?? []);
		if (state) nextHeld.add(state);
		try {
			return await this.heldByContext.run(nextHeld, action);
		} finally {
			release();
		}
	}

	private makeRelease(state: LockState): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = state.waiters.shift();
			if (next) {
				state.label = next.label;
				this.emit(state.key, true, next.label);
				next.resolve(this.makeRelease(state));
			} else {
				this.locks.delete(state.key);
				this.emit(state.key, false, '');
			}
		};
	}

	private emit(path: string, locked: boolean, label: string): void {
		// Resource keys (kind::id) drive no editor overlay/dashboard badge; emitting
		// them would only add noise for note-lock listeners keyed by vault path.
		if (isResourceKey(path)) return;
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
