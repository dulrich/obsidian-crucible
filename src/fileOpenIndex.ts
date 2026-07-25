/**
 * fileOpenIndex.ts — the file-open palette's snapshot lifecycle: chunked build, delta
 * queue, and exclusion invalidation.
 *
 * Modeled on `src/search/SearchIndexCoordinator.ts`'s house pattern (a class instantiated
 * once in `main.ts`, fed by vault events, disposed via `this.register(...)`), but with one
 * deliberate difference: this module carries **zero obsidian value import**. The
 * `CruciblePlugin` reference is `import type` only (fully erased — esbuild never resolves
 * `./main`, let alone `obsidian`, to build this module), and every vault-event input
 * arrives pre-narrowed from `main.ts` as a `FileOpenCandidate` (see `./fileOpenRanking`)
 * instead of a raw `TAbstractFile`. That is what lets this file be unit-tested directly —
 * bundled and run in bare Node the same way `fileOpenRanking.ts`/`rankScore.ts` are —
 * instead of only through pure sub-pieces the way `SearchIndexCoordinator` is (via
 * `lifecycleGate.ts` / `debounce.ts`).
 *
 * Three responsibilities, matched to the WP-2 plan:
 *
 * 1. **Chunked build** — `FILE_OPEN_BUILD_CHUNK_SIZE` rows per `setTimeout(…, 0)` slice,
 *    so the initial ~47k-row scan (56.9 ms measured in `tests/fileOpenPaletteBench.mjs`)
 *    never blocks a frame. `getSnapshot()` finishes any remaining slices synchronously if
 *    the palette opens mid-build — bounded worst case one full build, once.
 * 2. **Delta queue** — vault `create`/`delete`/`rename` events queue lazily and apply only
 *    at `getSnapshot()` time (modal open), not eagerly. Deltas are ignored entirely until
 *    `markLayoutReady()` fires, because Obsidian replays a `create` event for every file
 *    during initial vault load and a queue listening that early just thrashes. A queue
 *    that has grown past `shouldDiscardDeltaQueue` (a bulk sync/import) is discarded and
 *    replaced with a fresh chunked rebuild rather than applied delta-by-delta.
 * 3. **Exclusion invalidation** — `getSnapshot()` compares a cheap signature (the
 *    compiled, normalized `search`-scope excluded-folder prefix list) against the
 *    snapshot's own, and on mismatch reruns only `recomputeIgnoredFlags` (~2 ms flags-only
 *    pass), never a full rebuild.
 */

import type CruciblePlugin from './main';
import { compileExclusions, isPathExcludedCompiled } from './exclusions';
import {
	FileOpenCandidate,
	FileOpenDelta,
	FileOpenSnapshot,
	applyFileOpenDeltas,
	buildFileOpenSnapshot,
	createFileOpenSnapshot,
	recomputeIgnoredFlags,
} from './fileOpenRanking';
import { logWarn } from './log';

/** Rows built per `setTimeout(…, 0)` slice during the initial chunked build. */
export const FILE_OPEN_BUILD_CHUNK_SIZE = 4000;

export interface FileOpenIndexOptions {
	/** Test-only override; production always uses `FILE_OPEN_BUILD_CHUNK_SIZE`. */
	chunkSize?: number;
}

/**
 * A delta queue longer than this looks like a bulk sync/import rather than incremental
 * editing: applying it entry-by-entry would cost more than just rebuilding, so
 * `FileOpenIndex` discards it and schedules a fresh chunked build instead. Exported so the
 * threshold itself is asserted in a test without needing a `FileOpenIndex` instance.
 */
export function shouldDiscardDeltaQueue(queueLength: number, snapshotSize: number): boolean {
	return queueLength > Math.max(2000, snapshotSize * 0.05);
}

/**
 * Builds the palette's per-open-session recency map from `workspace.getLastOpenFiles()`.
 * Only the very first entry is ever skipped, and only when it equals the active file's
 * path — the note you're already looking at is the one you're least likely to be
 * reopening via the palette. A miss (a since-deleted file still in the recent list) is
 * simply never added, so it yields no bonus. Ranks are contiguous starting at 0 among
 * whatever survives, which is also the map's `size` — the default recency denominator
 * `selectFileOpenItems` uses.
 */
export function buildRecencyMap(recentPaths: string[], activePath: string | undefined): Map<string, number> {
	const map = new Map<string, number>();
	let rank = 0;
	for (let i = 0; i < recentPaths.length; i++) {
		const path = recentPaths[i];
		if (path === undefined || path.length === 0) continue;
		if (i === 0 && path === activePath) continue;
		if (map.has(path)) continue;
		map.set(path, rank);
		rank++;
	}
	return map;
}

export class FileOpenIndex {
	private readonly chunkSize: number;
	private snapshot: FileOpenSnapshot | null = null;
	private buildCandidates: FileOpenCandidate[] = [];
	private buildCursor = 0;
	private buildTimer: ReturnType<typeof setTimeout> | null = null;
	private excludedPrefixes: string[] = [];
	private layoutReady = false;
	private deltaQueue: FileOpenDelta[] = [];
	private disposed = false;

	constructor(private readonly plugin: CruciblePlugin, options: FileOpenIndexOptions = {}) {
		this.chunkSize = options.chunkSize ?? FILE_OPEN_BUILD_CHUNK_SIZE;
	}

	/**
	 * Called once from the plugin's `onLayoutReady` block: starts the background chunked
	 * build and opens the gate for delta events. Idempotent, and a no-op if `getSnapshot()`
	 * already forced an on-demand build earlier (e.g. the palette opened unusually early).
	 */
	markLayoutReady(): void {
		if (this.layoutReady) return;
		this.layoutReady = true;
		if (this.snapshot === null) this.startBuild();
	}

	handleCreate(candidate: FileOpenCandidate): void {
		if (!this.layoutReady) return;
		this.deltaQueue.push({ kind: 'add', ...candidate });
	}

	handleDelete(path: string): void {
		if (!this.layoutReady) return;
		this.deltaQueue.push({ kind: 'del', path });
	}

	/** A rename is `del(oldPath)` + `add(newPath)` — the shape the vault itself emits. */
	handleRename(next: FileOpenCandidate, oldPath: string): void {
		if (!this.layoutReady) return;
		this.deltaQueue.push({ kind: 'del', path: oldPath });
		this.deltaQueue.push({ kind: 'add', ...next });
	}

	/**
	 * Returns a snapshot that is fully built, has every queued delta applied, and has
	 * exclusion flags current with live settings. Never returns a partial snapshot — if the
	 * chunked build or a delta-queue rebuild is mid-flight, this finishes it inline first.
	 */
	getSnapshot(): FileOpenSnapshot {
		if (this.snapshot === null) this.startBuild();
		this.finishBuildSync();
		this.drainDeltas();
		this.syncExclusions();
		return this.snapshot!;
	}

	dispose(): void {
		this.disposed = true;
		if (this.buildTimer !== null) {
			clearTimeout(this.buildTimer);
			this.buildTimer = null;
		}
	}

	private startBuild(): void {
		this.refreshExcludedPrefixes();
		this.buildCandidates = this.collectCandidates();
		this.buildCursor = 0;
		this.snapshot = createFileOpenSnapshot(this.exclusionSig());
		this.scheduleSlice();
	}

	private collectCandidates(): FileOpenCandidate[] {
		return this.plugin.app.vault.getFiles().map(file => ({
			path: file.path,
			extension: file.extension,
			mtime: file.stat.mtime,
		}));
	}

	private scheduleSlice(): void {
		if (this.disposed) return;
		this.buildTimer = setTimeout(() => this.runSlice(), 0);
	}

	private runSlice(): void {
		this.buildTimer = null;
		this.buildOneChunk();
		if (this.buildCursor < this.buildCandidates.length) this.scheduleSlice();
		else this.buildCandidates = [];
	}

	private buildOneChunk(): void {
		if (this.snapshot === null || this.buildCursor >= this.buildCandidates.length) return;
		const from = this.buildCursor;
		const to = Math.min(this.buildCandidates.length, from + this.chunkSize);
		buildFileOpenSnapshot(this.buildCandidates, {
			into: this.snapshot,
			from,
			to,
			isIgnoredPath: path => this.isIgnoredPath(path),
		});
		this.buildCursor = to;
	}

	private finishBuildSync(): void {
		if (this.buildTimer !== null) {
			clearTimeout(this.buildTimer);
			this.buildTimer = null;
		}
		while (this.buildCursor < this.buildCandidates.length) this.buildOneChunk();
		this.buildCandidates = [];
	}

	private drainDeltas(): void {
		if (this.deltaQueue.length === 0) return;
		const snapshot = this.snapshot!;
		if (shouldDiscardDeltaQueue(this.deltaQueue.length, snapshot.size)) {
			logWarn('fileOpenIndex', `delta queue (${this.deltaQueue.length}) exceeded threshold at ${snapshot.size} rows; rebuilding`);
			this.deltaQueue = [];
			// A bulk sync/import: cheaper to rebuild than to apply. `getSnapshot()` must
			// still return an accurate snapshot right now, so finish this inline too —
			// the same bounded "one full build, once" contract as the mid-build case.
			this.startBuild();
			this.finishBuildSync();
			return;
		}
		const deltas = this.deltaQueue;
		this.deltaQueue = [];
		applyFileOpenDeltas(snapshot, deltas, { isIgnoredPath: path => this.isIgnoredPath(path) });
	}

	private syncExclusions(): void {
		const snapshot = this.snapshot;
		if (snapshot === null) return;
		this.refreshExcludedPrefixes();
		const sig = this.exclusionSig();
		if (sig === snapshot.exclusionSig) return;
		recomputeIgnoredFlags(snapshot, path => this.isIgnoredPath(path), sig);
	}

	private refreshExcludedPrefixes(): void {
		this.excludedPrefixes = compileExclusions(this.plugin.settings, 'search');
	}

	private exclusionSig(): string {
		// JSON-encoded rather than delimiter-joined: folder names can legally contain
		// spaces or other "safe-looking" separators. This only needs to be a cheap,
		// unambiguous fingerprint of the compiled prefix list, not human-readable.
		//
		// Obsidian's own excluded-files list is part of the fingerprint because it is part of
		// the flag (see isIgnoredPath). Without it, editing that list in Obsidian's settings
		// would leave every IGNORED flag stale until something else invalidated the snapshot.
		// The raw list is read through the undocumented `vault.getConfig`, presence-guarded the
		// way `src/surround.ts` guards it; on an Obsidian build that lacks it the signature
		// simply omits that component, degrading to the previous behaviour rather than throwing.
		return JSON.stringify([this.excludedPrefixes, this.plugin.app.vault.getConfig?.('userIgnoreFilters') ?? null]);
	}

	/**
	 * Ignored means *deranked*, not hidden — `rankScore` subtracts a flat penalty larger than
	 * any tier gap, so these sort below every ordinary match but stay reachable by typing an
	 * exact name.
	 *
	 * Two independent sources feed one flag: Crucible's own search-scope exclusions, and
	 * Obsidian's Settings -> Files & links -> "Excluded files". The latter is what
	 * `FileSuggest`/`FolderSuggest`/`folderPicker` already filter on, so before this the
	 * palette was the one file-picking surface in the plugin that ignored it. Deranking rather
	 * than filtering is the deliberate difference from `SearchManager.isExcludedFromIndex`,
	 * which hides user-ignored files outright: a palette exists to reach a file you can name.
	 */
	private isIgnoredPath(path: string): boolean {
		return isPathExcludedCompiled(this.excludedPrefixes, path)
			|| this.plugin.app.metadataCache.isUserIgnored(path);
	}
}
