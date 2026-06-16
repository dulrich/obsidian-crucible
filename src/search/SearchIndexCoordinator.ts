import { TAbstractFile, TFile } from 'obsidian';
import type CruciblePlugin from '../main';
import type { JobPriority } from '../orchestration/types';
import { isSearchIndexablePath } from './chunker';
import { searchIndexDebounceMs } from './debounce';
import { SearchReadinessGate } from './lifecycleGate';
import { isPathExcluded } from '../exclusions';
import { logWarn } from '../log';

// Owns automatic search indexing: it translates vault events into gated, deduped index/delete
// jobs. "Automatic" work waits for app readiness (layout + metadata) and a reachable companion;
// manual reindex (a user command) bypasses both via `reindex`. Keeping this here keeps main.ts a
// thin event-forwarder and removes the old auto/manual `source` flag.
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
		if (file instanceof TFile) void this.enqueueAutomatic('search_upsert_file', file.path);
	}

	// Debounced: collapse a burst of edits to one index job, and back off longer for the note the
	// user is actively typing in.
	handleModify(file: TFile): void {
		if (!isSearchIndexablePath(file.path)) return;
		const path = file.path;
		const existing = this.debounceTimers.get(path);
		if (existing) clearTimeout(existing);
		const activePath = this.plugin.app.workspace.getActiveFile()?.path;
		const delay = searchIndexDebounceMs(this.plugin.settings, activePath === path);
		this.debounceTimers.set(path, setTimeout(() => {
			this.debounceTimers.delete(path);
			const current = this.plugin.app.vault.getAbstractFileByPath(path);
			if (!(current instanceof TFile) || !isSearchIndexablePath(current.path)) return;
			// A mutating command/chain owns the note until it releases its lock; don't index underneath it.
			if (this.plugin.noteLocks.isLocked(current.path) || this.isMaterializing()) return;
			void this.enqueueAutomatic('search_upsert_file', current.path);
		}, delay));
	}

	handleRename(file: TAbstractFile, oldPath: string): void {
		void this.enqueueAutomatic('search_delete_path', oldPath);
		if (file instanceof TFile) void this.enqueueAutomatic('search_upsert_file', file.path);
	}

	handleDelete(path: string): void {
		void this.enqueueAutomatic('search_delete_path', path);
	}

	// Manual reindex (user command): index now at high priority, skipping the readiness/availability
	// gate so an explicit request runs even early in startup; the workflow still defers if the
	// companion is down.
	reindex(file: TFile): void {
		if (!this.indexable(file.path)) return;
		void this.plugin.orchestrator.enqueue('search_upsert_file', { path: file.path }, { priority: 'high', inputPaths: [file.path] });
	}

	dispose(): void {
		for (const timer of this.debounceTimers.values()) clearTimeout(timer);
		this.debounceTimers.clear();
	}

	private indexable(path: string): boolean {
		return this.plugin.settings.searchEnabled && isSearchIndexablePath(path) && !isPathExcluded(this.plugin.settings, path, 'search');
	}

	private async enqueueAutomatic(type: 'search_upsert_file' | 'search_delete_path', path: string, priority: JobPriority = 'low'): Promise<void> {
		if (!this.indexable(path)) return;
		if (!this.readiness.isReady()) return;
		if (!(await this.plugin.searchManager.companionAvailable())) {
			logWarn('search', `Skipped automatic ${type}; search companion unavailable`, path);
			return;
		}
		// Upserts carry the note as an input path (note-lock + queue display); deletes don't bind to a
		// file that may no longer exist.
		const inputPaths = type === 'search_upsert_file' ? [path] : undefined;
		void this.plugin.orchestrator.enqueue(type, { path }, { priority, inputPaths });
	}
}
