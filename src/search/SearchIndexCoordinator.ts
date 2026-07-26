import { TAbstractFile, TFile } from 'obsidian';
import type CruciblePlugin from '../main';
import type { JobPriority } from '../orchestration/types';
import { isSearchIndexablePath } from './chunker';
import { searchIndexDebounceMs } from './debounce';
import { SearchReadinessGate } from './lifecycleGate';
import { isPathExcluded } from '../exclusions';

// Owns automatic search indexing: it translates vault events into gated, deduped index/delete
// jobs. "Automatic" work waits for app readiness (layout + metadata); manual reindex (a user
// command) bypasses that via `reindex`. Neither path consults companion availability — the
// durable queue records the work and the service-health breaker decides when it drains (see
// enqueueAutomatic). Keeping this here keeps main.ts a thin event-forwarder and removes the old
// auto/manual `source` flag.
export class SearchIndexCoordinator {
	private readonly readiness = new SearchReadinessGate();
	private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		private readonly plugin: CruciblePlugin,
		private readonly isMaterializing: () => boolean,
	) {}

	markLayoutReady(): void {
		this.readiness.markLayoutReady();
	}

	markMetadataResolved(): void {
		this.readiness.markMetadataResolved();
	}

	handleCreate(file: TAbstractFile): void {
		if (file instanceof TFile) this.enqueueAutomatic('search_upsert_file', file.path);
	}

	// Debounced: collapse a burst of edits to one index job, and back off longer for the note the
	// user is actively typing in.
	handleModify(file: TFile): void {
		if (!isSearchIndexablePath(file.path, this.plugin.settings.searchIndexExtensions)) return;
		const path = file.path;
		const existing = this.debounceTimers.get(path);
		if (existing) clearTimeout(existing);
		const activePath = this.plugin.app.workspace.getActiveFile()?.path;
		const delay = searchIndexDebounceMs(this.plugin.settings, activePath === path);
		this.debounceTimers.set(path, setTimeout(() => {
			this.debounceTimers.delete(path);
			const current = this.plugin.app.vault.getAbstractFileByPath(path);
			if (!(current instanceof TFile) || !isSearchIndexablePath(current.path, this.plugin.settings.searchIndexExtensions)) return;
			// A mutating command/chain owns the note until it releases its lock; don't index underneath it.
			if (this.plugin.noteLocks.isLocked(current.path) || this.isMaterializing()) return;
			this.enqueueAutomatic('search_upsert_file', current.path);
		}, delay));
	}

	handleRename(file: TAbstractFile, oldPath: string): void {
		this.enqueueAutomatic('search_delete_path', oldPath);
		if (file instanceof TFile) this.enqueueAutomatic('search_upsert_file', file.path);
	}

	handleDelete(path: string): void {
		this.enqueueAutomatic('search_delete_path', path);
	}

	// Manual reindex (user command): index now at high priority, skipping the readiness gate so an
	// explicit request runs even early in startup; the workflow still defers if the companion is
	// down, and a manual run bypasses the breaker by design.
	reindex(file: TFile): void {
		if (!this.indexable(file.path)) return;
		void this.plugin.orchestrator.enqueue('search_upsert_file', { path: file.path }, { priority: 'high', lane: 'user', inputPaths: [file.path] });
	}

	dispose(): void {
		for (const timer of this.debounceTimers.values()) clearTimeout(timer);
		this.debounceTimers.clear();
	}

	private indexable(path: string): boolean {
		return this.plugin.settings.searchEnabled && isSearchIndexablePath(path, this.plugin.settings.searchIndexExtensions) && !isPathExcluded(this.plugin.settings, path, 'search');
	}

	/**
	 * ALWAYS enqueues once the readiness/indexable gates pass — availability is
	 * deliberately NOT consulted here.
	 *
	 * It used to be, and that was an inversion of the whole design. The queue is
	 * durable; a service outage is supposed to stop the *drain* (the service-health
	 * breaker), not the recording of work. Checking availability before enqueueing
	 * discarded the event instead, with only a debug-gated warning: during any outage
	 * longer than the online TTL, every create/modify/rename/delete in that window
	 * never became a job at all. An edited note merely stayed stale until its next
	 * edit, but a **delete or rename is never repeated** — the old path's chunks stayed
	 * in the index until a full rebuild, returning ghost results for a note that no
	 * longer exists. The 2,022-job outage cohort was work that at least reached the
	 * queue; this was the work that never did.
	 *
	 * Cost of always enqueueing is bounded by machinery that already exists: the
	 * per-path dedupe keys (`search-file:<path>`) collapse bursts onto one active job,
	 * and the breaker keeps the drain from touching them while the companion is down.
	 */
	private enqueueAutomatic(type: 'search_upsert_file' | 'search_delete_path', path: string, priority: JobPriority = 'low'): void {
		if (!this.indexable(path)) return;
		if (!this.readiness.isReady()) return;
		// Upserts carry the note as an input path (note-lock + queue display); deletes don't bind to a
		// file that may no longer exist.
		const inputPaths = type === 'search_upsert_file' ? [path] : undefined;
		void this.plugin.orchestrator.enqueue(type, { path }, { priority, lane: 'background', inputPaths });
	}
}
