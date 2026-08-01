import { Notice } from 'obsidian';
import { CrucibleCommandPaletteModal, buildHintOptions, buildScoreText, computeHint, getPaletteItems } from './commandPalette';
import { CrucibleFileOpenPaletteModal } from './fileOpenPalette';
import { shortestUniqueFuzzyString, shortestTopMatchFuzzyString } from './commandPaletteHints';
import { appendDebugLog, ensureFolder } from './utils';
import { FilePickerModal } from './orchestration/FilePickerModal';
import type CruciblePlugin from './main';
import { VaultSearchModal } from './search/SearchModal';
import { isSearchIndexablePath } from './search/chunker';
import { SEARCH_QUERY_EXPORT_FILENAME, buildQueryExport, serializeQueryExport } from './search/queryLog';
import { AuditImage, computeSearchAudit, formatAuditReport, isCleanAudit, SearchAuditResult } from './search/audit';
import { computeReferencedImagePaths } from './orchestration/utils/imageDescribe';
import { exportSourceEvalTrainingData } from './sourceEval/export';
import { SURROUNDS, setSurround, nextSurround, surroundLabel } from './surround';
import { runServiceOutageRequeueFlow } from './orchestration/failedJobRepair';
import { ConfirmModal } from './confirmModal';
import { confirmDestructive } from './settings/destructiveActions';
import { RetryFailedImageDescriptionsModal } from './retryImageDescriptionsModal';

/**
 * Registers Crucible's static (always-present) commands. Split out of `onload`
 * to keep `main.ts` a thin lifecycle/registration hub. Dynamic command sets
 * (Shortcuts, Captures, Chains, Agents) and the chain-internal command
 * implementations still register from the plugin class itself, since they
 * depend on per-config state. Everything here routes through
 * `plugin.registerCrucibleCommand` so the settings UI's visibility toggles see
 * each command (see the AGENTS.md quirk on command registration).
 */
export function registerStaticCommands(plugin: CruciblePlugin): void {
	const prefix = plugin.manifest.id;

	// Appearance: N1 Console surround switch. Read-only (chrome, not notes), so
	// mutating:false — it never takes the note lock.
	for (const s of SURROUNDS) {
		plugin.registerCrucibleCommand({
			id: `set-surround-${s}`,
			name: `Set surround: ${surroundLabel(s)}`,
			group: 'Appearance',
			mutating: false,
			run: () => setSurround(plugin, s),
		});
	}
	plugin.registerCrucibleCommand({
		id: 'cycle-surround',
		name: 'Cycle surround (dark → med → light)',
		group: 'Appearance',
		mutating: false,
		run: () => setSurround(plugin, nextSurround(plugin.settings.surround)),
	});

	plugin.registerCrucibleCommand({
		id: 'materialize-day-today',
		name: 'Materialize day: today',
		group: 'Materialize',
		run: () => plugin.chainManager.executeInternalCommand(`${prefix}:materialize-day-today`, {}),
	});
	plugin.registerCrucibleCommand({
		id: 'materialize-day-picker',
		name: 'Materialize day: pick date',
		group: 'Materialize',
		run: () => plugin.openDayPicker(),
	});
	plugin.registerCrucibleCommand({
		id: 'materialize-week-today',
		name: 'Materialize week: current',
		group: 'Materialize',
		run: () => plugin.chainManager.executeInternalCommand(`${prefix}:materialize-week-today`, {}),
	});
	plugin.registerCrucibleCommand({
		id: 'materialize-week-picker',
		name: 'Materialize week: pick week',
		group: 'Materialize',
		run: () => plugin.openWeekPicker(),
	});
	plugin.registerCrucibleCommand({
		id: 'materialize-month-today',
		name: 'Materialize month: current',
		group: 'Materialize',
		run: () => plugin.chainManager.executeInternalCommand(`${prefix}:materialize-month-today`, {}),
	});
	plugin.registerCrucibleCommand({
		id: 'materialize-month-picker',
		name: 'Materialize month: pick month',
		group: 'Materialize',
		run: () => plugin.openMonthPicker(),
	});

	plugin.registerCrucibleCommand({
		id: 'word-count',
		name: 'Lint: word count',
		group: 'Lint',
		run: () => plugin.chainManager.executeInternalCommand(`${prefix}:word-count`, {}),
	});
	plugin.registerCrucibleCommand({
		id: 'lint-note',
		name: 'Lint: all',
		group: 'Lint',
		run: () => plugin.chainManager.executeInternalCommand(`${prefix}:lint-note`, {}),
	});
	plugin.registerCrucibleCommand({
		id: 'lint-vault',
		name: 'Lint: vault',
		group: 'Lint',
		run: () => plugin.chainManager.executeInternalCommand(`${prefix}:lint-vault`, {}),
	});
	plugin.registerCrucibleCommand({
		id: 'lint-cleanup-transcript',
		name: 'Lint: cleanup transcript',
		group: 'Lint',
		run: () => plugin.chainManager.executeInternalCommand(`${prefix}:lint-cleanup-transcript`, {}),
	});
	plugin.registerCrucibleCommand({
		id: 'lint-localize-attachments',
		name: 'Lint: localize attachments',
		group: 'Lint',
		run: () => plugin.chainManager.executeInternalCommand(`${prefix}:lint-localize-attachments`, {}),
	});
	plugin.registerCrucibleCommand({
		id: 'lint-localize-attachments-vault',
		name: 'Lint: localize attachments (vault)',
		group: 'Lint',
		run: () => plugin.chainManager.executeInternalCommand(`${prefix}:lint-localize-attachments-vault`, {}),
	});
	plugin.registerCrucibleCommand({
		id: 'lint-repair-attachments',
		name: 'Lint: repair attachment links',
		group: 'Lint',
		run: () => plugin.chainManager.executeInternalCommand(`${prefix}:lint-repair-attachments`, {}),
	});
	plugin.registerCrucibleCommand({
		id: 'lint-repair-attachments-vault',
		name: 'Lint: repair attachment links (vault)',
		group: 'Lint',
		run: () => plugin.chainManager.executeInternalCommand(`${prefix}:lint-repair-attachments-vault`, {}),
	});
	plugin.registerCrucibleCommand({
		id: 'lint-rename-property',
		name: 'Lint: update property in vault',
		group: 'Lint',
		run: async () => {
			const oldKey = await plugin.promptForText('Old property name');
			if (oldKey === null || oldKey.trim() === '') return;
			const newKey = await plugin.promptForText('New property name');
			if (newKey === null || newKey.trim() === '') return;
			await plugin.chainManager.executeInternalCommand(`${prefix}:lint-rename-property`, {
				oldKey: oldKey.trim(),
				newKey: newKey.trim(),
			});
		},
	});
	plugin.registerCrucibleCommand({
		id: 'lint-remove-property',
		name: 'Lint: remove property from vault',
		group: 'Lint',
		run: async () => {
			const key = await plugin.promptForText('Property name to remove');
			if (key === null || key.trim() === '') return;
			await plugin.chainManager.executeInternalCommand(`${prefix}:lint-remove-property`, {
				key: key.trim(),
			});
		},
	});

	plugin.registerCrucibleCommand({
		id: 'dataview-refresh',
		name: 'Lint: refresh dataview views',
		group: 'Lint',
		mutating: false,
		run: () => plugin.chainManager.executeInternalCommand(`${prefix}:dataview-refresh`, {}),
	});

	plugin.registerCrucibleCommand({
		id: 'mark-as-forwarded',
		name: 'Mark as forwarded',
		group: 'Other',
		available: () => plugin.activeEditor() !== undefined,
		run: async () => {
			const editor = plugin.activeEditor();
			if (!editor) {
				new Notice('Switch to edit mode to use this command');
				return;
			}
			await plugin.chainManager.executeInternalCommand(`${prefix}:mark-as-forwarded`, {}, null, editor);
		},
	});

	plugin.registerCrucibleCommand({
		id: 'reload-plugin',
		name: 'Reload plugin',
		group: 'Other',
		mutating: false,
		run: async () => {
			if (plugin.app.plugins) {
				await plugin.app.plugins.disablePlugin(plugin.manifest.id);
				await plugin.app.plugins.enablePlugin(plugin.manifest.id);
				new Notice('Plugin reloaded');
			}
		},
	});

	plugin.registerCrucibleCommand({
		id: 'open-settings-tab',
		name: 'Open settings in a tab',
		group: 'Other',
		mutating: false,
		run: () => plugin.activateSettingsView(),
	});

	plugin.registerCrucibleCommand({
		id: 'open-ingestion-dashboard',
		name: 'Open ingestion dashboard',
		group: 'Ingestion',
		mutating: false,
		run: () => plugin.activateIngestionDashboardView(),
	});

	plugin.registerCrucibleCommand({
		id: 'open-source-eval-dashboard',
		name: 'Crucible: Open Source Eval Dashboard',
		group: 'Ingestion',
		mutating: false,
		queueable: false,
		run: () => plugin.activateSourceEvalDashboardView(),
	});

	plugin.registerCrucibleCommand({
		id: 'export-source-eval-training-data',
		name: 'Crucible: Export source eval training data',
		group: 'Ingestion',
		mutating: false,
		queueable: false,
		run: async () => {
			const result = await exportSourceEvalTrainingData(plugin.app, plugin);
			new Notice(`Exported ${result.count} source eval row${result.count === 1 ? '' : 's'} to ${result.path}`);
		},
	});

	plugin.registerCrucibleCommand({
		id: 'youtube-ignore-video',
		name: 'YouTube: ignore video',
		group: 'Ingestion',
		run: () => plugin.chainManager.executeInternalCommand(
			`${prefix}:youtube-ignore-video`,
			{},
			null,
			undefined,
			plugin.app.workspace.getActiveFile() ?? undefined,
		),
	});
	plugin.registerCrucibleCommand({
		id: 'youtube-watch-video',
		name: 'YouTube: watch video',
		group: 'Ingestion',
		mutating: false,
		run: () => plugin.chainManager.executeInternalCommand(
			`${prefix}:youtube-watch-video`,
			{},
			null,
			undefined,
			plugin.app.workspace.getActiveFile() ?? undefined,
		),
	});

	plugin.registerCrucibleCommand({
		id: 'open-crucible-command-palette',
		name: 'Open Crucible command palette',
		group: 'Other',
		mutating: false,
		available: () => plugin.settings.crucibleCommandPaletteEnabled,
		availabilityHelp: () => plugin.settings.crucibleCommandPaletteEnabled
			? null
			: 'Enable Commands > Command palette > Enable Crucible command palette.',
		run: () => new CrucibleCommandPaletteModal(plugin.app, plugin).open(),
	});

	plugin.registerCrucibleCommand({
		id: 'open-crucible-file-palette',
		name: 'Open Crucible file-open palette',
		group: 'Other',
		mutating: false,
		available: () => plugin.settings.crucibleFileOpenPaletteEnabled,
		availabilityHelp: () => plugin.settings.crucibleFileOpenPaletteEnabled
			? null
			: 'Enable Commands > File-open palette > Enable Crucible file-open palette.',
		run: () => new CrucibleFileOpenPaletteModal(plugin.app, plugin).open(),
	});

	plugin.registerCrucibleCommand({
		id: 'command-palette-hint-debug',
		name: 'Debug command palette hints',
		group: 'Other',
		mutating: false,
		available: () => plugin.settings.crucibleCommandPaletteEnabled,
		availabilityHelp: () => plugin.settings.crucibleCommandPaletteEnabled
			? null
			: 'Enable Commands > Command palette > Enable Crucible command palette.',
		run: () => void writeHintDebugReport(plugin),
	});

	plugin.registerMoveFileCommands(prefix);

	plugin.registerCrucibleCommand({
		id: 'orchestrator-scan',
		name: 'Orchestrate: scan queue',
		group: 'Orchestrations',
		mutating: false,
		run: () => plugin.orchestrator.scan(),
	});

	plugin.registerCrucibleCommand({
		id: 'orchestrator-run-next',
		name: 'Orchestrate: run next',
		group: 'Orchestrations',
		mutating: false,
		run: () => plugin.orchestrator.runNext(),
	});

	plugin.registerCrucibleCommand({
		id: 'orchestrator-enqueue-daily-brief-lite',
		name: 'Orchestrate: enqueue daily brief lite',
		group: 'Orchestrations',
		mutating: false,
		run: () => plugin.orchestrator.enqueue('daily_brief_lite', {}, { priority: 'high', lane: 'user' }),
	});

	plugin.registerCrucibleCommand({
		id: 'orchestrator-enqueue-transcript-refine',
		name: 'Orchestrate: enqueue transcript refine',
		group: 'Orchestrations',
		mutating: false,
		run: () => {
			new FilePickerModal(plugin.app, 'Pick a transcript note', (file) => {
					void plugin.orchestrator.enqueue('transcript_refine', { targetPath: file.path }, { priority: 'high', lane: 'user', inputPaths: [file.path] });
			}).open();
		},
	});

	plugin.registerCrucibleCommand({
		id: 'orchestrator-enqueue-youtube-tracker',
		name: 'Orchestrate: enqueue YouTube tracker',
		group: 'Orchestrations',
		mutating: false,
		run: () => plugin.orchestrator.enqueue('youtube_tracker', {}, { priority: 'high', lane: 'user' }),
	});

	plugin.registerCrucibleCommand({
		id: 'orchestrator-enqueue-youtube-tracker-consolidation',
		name: 'Orchestrate: enqueue YouTube tracker consolidation',
		group: 'Orchestrations',
		mutating: false,
		run: () => plugin.orchestrator.enqueue('youtube_tracker_consolidate', {}, { priority: 'high', lane: 'user' }),
	});

	plugin.registerCrucibleCommand({
		id: 'youtube-fetch-video-metadata',
		name: 'YouTube: fetch video metadata for active note',
		group: 'Orchestrations',
		run: () => plugin.chainManager.executeInternalCommand(`${prefix}:youtube-fetch-video-metadata`, {}),
	});

	plugin.registerCrucibleCommand({
		id: 'orchestrator-enqueue-blogs-tracker',
		name: 'Orchestrate: enqueue Blogs tracker',
		group: 'Orchestrations',
		mutating: false,
		run: () => plugin.orchestrator.enqueue('blogs_tracker', {}, { priority: 'high', lane: 'user' }),
	});

	plugin.registerCrucibleCommand({
		id: 'orchestrator-enqueue-blogs-tracker-consolidation',
		name: 'Orchestrate: enqueue Blogs tracker consolidation',
		group: 'Orchestrations',
		mutating: false,
		run: () => plugin.orchestrator.enqueue('blogs_tracker_consolidate', {}, { priority: 'high', lane: 'user' }),
	});

	plugin.registerCrucibleCommand({
		id: 'orchestrator-enqueue-link-scan',
		name: 'Orchestrate: enqueue link scan',
		group: 'Orchestrations',
		mutating: false,
		run: () => plugin.orchestrator.enqueue('link_scan', {}, { priority: 'high', lane: 'user' }),
	});

	// Registry-only fan-out (see XBackfillWorkflow's doc comment): scans
	// orchestrationLinkRegistryRoot for X statuses not yet materialized and
	// enqueues one x_metadata_fetch per undiscovered status. Not mutating — it
	// only reads the registry and enqueues.
	plugin.registerCrucibleCommand({
		id: 'orchestrator-enqueue-x-backfill',
		name: 'Orchestrate: enqueue X post backfill from link registry',
		group: 'Orchestrations',
		mutating: false,
		run: () => plugin.orchestrator.enqueue('x_metadata_backfill', {}, { priority: 'high', lane: 'user' }),
	});

	// Also registered as a chain-internal command (internalCommands.ts) so a
	// note-related chain step routes through the awaited internal registry rather
	// than fire-and-forget executeCommandById (root AGENTS.md's chain-step quirk).
	// Enqueueing doesn't mutate the note itself, so mutating:false is correct.
	plugin.registerCrucibleCommand({
		id: 'x-discover-post-links',
		name: 'X: discover post links in active note',
		group: 'Orchestrations',
		mutating: false,
		run: () => plugin.chainManager.executeInternalCommand(`${prefix}:x-discover-post-links`, {}),
	});

	// Retroactive repair for a service-outage cohort in failed/ (see
	// failedJobRepair.ts). Not `mutating`: it moves queue job files, not the active
	// note — same reasoning as every other Orchestrate command in this group.
	plugin.registerCrucibleCommand({
		id: 'orchestrator-requeue-service-outage-failures',
		name: 'Orchestrate: Requeue service-outage failures',
		group: 'Orchestrations',
		mutating: false,
		run: () => runServiceOutageRequeueFlow(plugin),
	});

	// Fan-out, not immediate: this enqueues the image_describe_backfill job, which itself
	// enqueues ~48 image_describe_batch jobs (~100 images each) rather than running inline —
	// see the file-queue-hygiene invariant in orchestration/AGENTS.md. Confirm first and name
	// the scale, same pattern as search-rebuild-index: a multi-hour vision-model run started by
	// accident is expensive to notice and expensive to undo.
	plugin.registerCrucibleCommand({
		id: 'search-describe-vault-images',
		name: 'Search: describe vault images',
		group: 'Orchestrations',
		mutating: false,
		run: async () => {
			const confirmed = await new ConfirmModal(plugin.app, {
				title: 'Describe every image referenced in the vault?',
				message: 'This queues a vision-model description pass (a narrative pass and a structured-extraction pass) over '
					+ 'every uniquely-referenced localized image not already described — roughly 4,700 images at this vault\'s '
					+ 'current size, around 12.6 hours of local model time. It runs in the background in ~100-image batches and '
					+ 'is safely interruptible and resumable: already-described images are skipped on any re-run. Images that '
					+ 'previously failed with a genuine (permanent) error are skipped too, not retried automatically — infra '
					+ 'casualties (timeouts, connection errors) are pruned and re-attempted automatically at the start of every '
					+ 'backfill run, or on demand via "Search: retry failed image descriptions".',
				confirmText: 'Queue backfill',
			}).openAndAwait();
			if (!confirmed) return;
			await plugin.orchestrator.enqueue('image_describe_backfill', {}, { priority: 'low', lane: 'background' });
		},
	});

	// idh-WP-2: clears the chosen failed image-description records from the store (transient-only
	// or all, per the modal choice) and re-queues the backfill so they re-enter pending and
	// re-describe. Manual complement to the automatic transient-failed prune at the start of every
	// backfill run (`ImageDescribeBackfillWorkflow`) — this command exists for "all" (permanent
	// failures included) and for forcing a retry sooner than the next backfill.
	plugin.registerCrucibleCommand({
		id: 'search-retry-failed-image-descriptions',
		name: 'Search: retry failed image descriptions',
		group: 'Orchestrations',
		mutating: false,
		run: async () => {
			const choice = await new RetryFailedImageDescriptionsModal(plugin.app).openAndAwait();
			if (!choice) return;
			const clearedMd5s = await plugin.imageDescriptions.pruneFailed(choice);
			new Notice(`Cleared ${clearedMd5s.length} failed image description${clearedMd5s.length === 1 ? '' : 's'} `
				+ `(${choice}); queuing re-describe backfill.`);
			await plugin.orchestrator.enqueue('image_describe_backfill', {}, { priority: 'low', lane: 'background' });
		},
	});

	plugin.registerCrucibleCommand({
		id: 'search-vault',
		name: 'Search: vault',
		group: 'Search',
		mutating: false,
		run: () => new VaultSearchModal(plugin.app, plugin).open(),
	});

	plugin.registerCrucibleCommand({
		id: 'search-sweep-vault',
		name: 'Search: sweep vault',
		group: 'Search',
		mutating: false,
		run: () => new VaultSearchModal(plugin.app, plugin, true).open(),
	});

	plugin.registerCrucibleCommand({
		id: 'search-health',
		name: 'Search: check service health',
		group: 'Search',
		mutating: false,
		run: async () => {
			const health = await plugin.searchManager.health();
			// WP-SA2: widened past ok/version to report the rest of `/health`'s now-typed payload
			// — schema, embedded-chunk count, and the active embedding model — and to flag a mixed
			// `embeddingSpaces` index the same way the Orchestrate → Search status block does.
			// Every field is read defensively (the health object may come from an older companion
			// that never sent them), so an omitted field simply drops its segment rather than
			// printing "undefined".
			const parts = [`Search service: ${health.ok ? 'ok' : 'not ok'}`];
			if (health.version) parts.push(`v${health.version}`);
			if (health.schemaVersion !== undefined) parts.push(`schema ${health.schemaVersion}`);
			if (health.embeddedChunks !== undefined) parts.push(`${health.embeddedChunks} embedded chunks`);
			if (health.embeddingModel) parts.push(health.embeddingModel);
			const spaces = health.embeddingSpaces ?? [];
			if (spaces.length > 1) parts.push(`MIXED embedding spaces (${spaces.length}): ${spaces.join(', ')}`);
			new Notice(parts.join(' · '));
		},
	});

	// Destructive: the workflow this enqueues calls resetIndex(), dropping the entire FTS +
	// vector index before re-embedding everything from scratch (~tens of minutes on a real
	// vault). Confirm first, and name the non-destructive alternative — a user reaching for
	// "verify/repair the index" should land on `search-embed-missing`, not a full reset.
	plugin.registerCrucibleCommand({
		id: 'search-rebuild-index',
		name: 'Search: reset and rebuild index',
		group: 'Search',
		mutating: false,
		run: async () => {
			const confirmed = await new ConfirmModal(plugin.app, {
				title: 'Reset and rebuild the search index?',
				message: 'This drops the entire search index and re-embeds everything from scratch, which can take a '
					+ 'long time on a large vault. If you\'re only trying to fill in missing embeddings (e.g. after '
					+ 'turning on semantic search or switching models), use "Search: embed missing vectors" instead — '
					+ 'it never resets the index.',
				confirmText: 'Reset and rebuild',
				destructive: true,
			}).openAndAwait();
			if (!confirmed) return;
			await plugin.orchestrator.enqueue('search_rebuild', {}, { priority: 'high', lane: 'user' });
		},
	});

	// Repairs "semantic search was turned on after the vault was indexed" and "the embedding
	// model changed" without resetIndex(): the FTS index — the thing that makes search work at
	// all — stays up for the hours the backfill runs. Resumable and interruptible; re-running it
	// after a stop picks up where it left off, because covered files are skipped.
	plugin.registerCrucibleCommand({
		id: 'search-embed-missing',
		name: 'Search: embed missing vectors',
		group: 'Search',
		mutating: false,
		run: () => plugin.orchestrator.enqueue('search_embed_missing', {}, { priority: 'high', lane: 'user' }),
	});

	plugin.registerCrucibleCommand({
		id: 'search-reindex-active-note',
		name: 'Search: reindex active note',
		group: 'Search',
		mutating: false,
		available: () => {
			const file = plugin.app.workspace.getActiveFile();
			return file !== null && isSearchIndexablePath(file.path, plugin.settings.searchIndexExtensions);
		},
		run: () => {
			const file = plugin.app.workspace.getActiveFile();
			if (!file) return;
			plugin.searchIndexCoordinator.reindex(file);
		},
	});

	// Turns the passive query log into an S2-shaped query file ({id, text, source, targetPaths})
	// so a ranking change can be measured against real searches with real targets instead of
	// hand-authored ones. Written next to the log in the plugin's data dir — deliberately not
	// into the vault, where it would be a note containing every query's terms.
	plugin.registerCrucibleCommand({
		id: 'search-export-query-log',
		name: 'Search: export query log',
		group: 'Search',
		mutating: false,
		run: async () => {
			const entries = await plugin.searchQueryLog.snapshot();
			if (entries.length === 0) {
				new Notice('Query log is empty — nothing to export.');
				return;
			}
			const result = buildQueryExport(entries);
			if (result.queries.length === 0) {
				// Not a failure, and said as such: a query nobody clicked through carries no
				// target, and exporting it with an empty targetPaths would score as a miss.
				new Notice(`No exportable queries yet: ${result.withoutTarget} logged ${result.withoutTarget === 1 ? 'query has' : 'queries have'} no opened result to use as a target.`);
				return;
			}
			const path = plugin.pluginDataPath(SEARCH_QUERY_EXPORT_FILENAME);
			await plugin.app.vault.adapter.write(path, serializeQueryExport(result.queries));
			new Notice(`Exported ${result.queries.length} queries to ${path} (${result.withoutTarget} skipped: no result opened).`);
		},
	});

	// Destructive, and on user data rather than a rebuildable index — hence the confirm.
	plugin.registerCrucibleCommand({
		id: 'search-clear-query-log',
		name: 'Search: clear query log',
		group: 'Search',
		mutating: false,
		run: async () => {
			const confirmed = await new ConfirmModal(plugin.app, {
				title: 'Clear the search query log?',
				message: 'Deletes every recorded search and the log file itself. This cannot be undone, and any '
					+ 'previously exported query file is left untouched.',
				confirmText: 'Clear log',
				destructive: true,
			}).openAndAwait();
			if (!confirmed) return;
			const discarded = await plugin.searchQueryLog.clear();
			new Notice(`Cleared ${discarded} logged ${discarded === 1 ? 'search' : 'searches'}.`);
		},
	});

	// WP-SA2: read-only. Compares the vault's file list and image-reference set against what the
	// companion actually holds and writes a report note — never enqueues, deletes, or touches the
	// index itself. `search-reconcile-index` below runs the identical compute and acts on it.
	plugin.registerCrucibleCommand({
		id: 'search-audit-index',
		name: 'Search: audit index',
		group: 'Search',
		mutating: false,
		run: async () => {
			const result = await runSearchAudit(plugin);
			const path = await writeSearchAuditReportNote(plugin, formatAuditReport(result, new Date().toISOString()));
			if (isCleanAudit(result)) {
				new Notice(`Search: audit index — all clean. Report: ${path}.`);
				return;
			}
			new Notice(
				`Search: audit index — missing ${result.missing.length}, orphans ${result.orphans.length}, `
				+ `stale ${result.stale.length}, embedding gaps ${result.embeddingGaps.length}, images `
				+ `${result.imageCoverage.pending} pending / ${result.imageCoverage.failed} failed. Report: ${path}.`,
			);
		},
	});

	// WP-SA2: the only mutating half of the audit/reconcile pair, and it mutates ONLY by
	// enqueueing existing job types (search_upsert_file, search_delete_path) — never a direct
	// index write, never a new job type. The orphan-deletion half is destructive (it removes rows
	// for paths the companion holds that the vault no longer has) and routes through
	// `confirmDestructive('search-reconcile-orphans', …)`; missing/stale upserts are additive and
	// need no confirmation, matching `search_upsert_file`'s own non-destructive nature elsewhere
	// in this file.
	plugin.registerCrucibleCommand({
		id: 'search-reconcile-index',
		name: 'Search: reconcile index',
		group: 'Search',
		mutating: false,
		run: async () => {
			const result = await runSearchAudit(plugin);
			if (isCleanAudit(result)) {
				new Notice('Search: reconcile index — already matches the vault. Nothing to do.');
				return;
			}

			let upserted = 0;
			for (const path of [...result.missing, ...result.stale]) {
				const job = await plugin.orchestrator.enqueue('search_upsert_file', { path }, { priority: 'low', lane: 'user', inputPaths: [path] });
				if (job) upserted++;
			}

			let deleted = 0;
			if (result.orphans.length > 0) {
				const preview = result.orphans.slice(0, 10).map(p => `- ${p}`);
				if (result.orphans.length > preview.length) preview.push(`- …and ${result.orphans.length - preview.length} more`);
				const confirmed = await confirmDestructive(plugin.app, plugin.settings, 'search-reconcile-orphans', {
					message: `Delete ${result.orphans.length} orphaned path${result.orphans.length === 1 ? '' : 's'} from the search index? `
						+ 'These paths are indexed but no longer exist in the vault (deleted, moved, or now excluded).',
					impact: preview,
				});
				if (confirmed) {
					for (const path of result.orphans) {
						const job = await plugin.orchestrator.enqueue('search_delete_path', { path }, { priority: 'low', lane: 'user' });
						if (job) deleted++;
					}
				}
			}

			new Notice(`Search: reconcile index — enqueued ${upserted} upsert${upserted === 1 ? '' : 's'} and ${deleted} delete${deleted === 1 ? '' : 's'}.`);
		},
	});
}

/** Escape a cell for a Markdown table. */
function mdCell(s: string): string {
	return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Compute the unique and top-match hint for every palette command and append a
 * Markdown table to the shared debug note (`_crucible/debug.md`). A tuning aid
 * for the charset/weighting knobs — uses the same options the live palette does.
 */
async function writeHintDebugReport(plugin: CruciblePlugin): Promise<void> {
	const settings = plugin.settings;
	const opts = buildHintOptions(settings);
	const scoreText = buildScoreText();
	const items = getPaletteItems(plugin.app, plugin);
	const names = items.map(c => c.name);

	const rows = items.map(cmd => {
		const competitors = names.filter(n => n !== cmd.name);
		const unique = shortestUniqueFuzzyString(cmd.name, competitors, opts);
		const top = shortestTopMatchFuzzyString(cmd.name, competitors, opts, scoreText);
		const used = computeHint(cmd.name, competitors, settings, opts, scoreText);
		const fmt = (h: string | null) => h === null ? '—' : `\`${mdCell(h)}\` (${h.length})`;
		const usedLabel = used === null ? 'none' : used.kind;
		return `| ${mdCell(cmd.name)} | ${fmt(unique)} | ${fmt(top)} | ${usedLabel} |`;
	});

	const header = [
		`Charset: ${settings.crucibleCommandPaletteHintCharsetMode}, maxLen: ${opts.maxLen}, ` +
			`prefixPenalty: ${opts.prefixPenalty}, positionBias: ${opts.positionBias}, ` +
			`fallback: ${settings.crucibleCommandPaletteHintFallbackTopMatch}`,
		'',
		'| Command | Unique (len) | Top match (len) | Used |',
		'| --- | --- | --- | --- |',
	];
	const table = [...header, ...rows].join('\n');
	await appendDebugLog(plugin.app, 'Command palette hints', table);
	new Notice(`Command palette hint debug written for ${items.length} commands (_crucible/debug.md).`);
}

/**
 * WP-SA2: gathers every input `computeSearchAudit` (`src/search/audit.ts`) needs and runs it.
 * Shared by `search-audit-index` (read-only) and `search-reconcile-index` (acts on the result) so
 * the two commands can never disagree about what "clean" means.
 */
async function runSearchAudit(plugin: CruciblePlugin): Promise<SearchAuditResult> {
	const vaultFiles = plugin.searchManager.listIndexableFiles().map(file => ({ path: file.path, mtime: file.stat.mtime }));
	const { paths: indexedPaths } = await plugin.searchManager.client().listPaths();
	const images = await gatherSearchAuditImages(plugin);
	return computeSearchAudit({
		vaultFiles,
		indexedPaths,
		images,
		semanticEnabled: plugin.settings.searchSemanticEnabled,
	});
}

/**
 * Crosses `computeReferencedImagePaths` (every image a resolved link in the vault points at)
 * against the image-description store's status for each — without launching a vision run.
 * `has()` alone can't distinguish a described image from a poisoned `kind: 'failed'` one (both
 * are present in the store's index), so a referenced+present image needs one `get()` to read its
 * `kind`; a referenced+absent image is `'pending'` at no extra read.
 */
async function gatherSearchAuditImages(plugin: CruciblePlugin): Promise<AuditImage[]> {
	const referenced = computeReferencedImagePaths(plugin);
	await plugin.imageDescriptions.ensureLoaded();
	const images: AuditImage[] = [];
	for (const image of referenced) {
		if (!plugin.imageDescriptions.has(image.md5)) {
			images.push({ md5: image.md5, status: 'pending' });
			continue;
		}
		const record = await plugin.imageDescriptions.get(image.md5);
		images.push({ md5: image.md5, status: record?.kind === 'failed' ? 'failed' : 'described' });
	}
	return images;
}

/**
 * Overwrite-per-run report note at `_crucible/search-audit.md` (`_crucible` is search-excluded by
 * default, and is the same folder the Localize/Chain debug flow's shared debug note lives in —
 * see `appendDebugLog`). Deliberately NOT that shared append-only log: an audit report is a
 * point-in-time snapshot a user re-runs and re-reads, not a growing history, so overwriting keeps
 * it from accreting into an ever-longer file the way a per-run append would.
 */
async function writeSearchAuditReportNote(plugin: CruciblePlugin, content: string): Promise<string> {
	const path = '_crucible/search-audit.md';
	const existing = plugin.app.vault.getFileByPath(path);
	if (existing) {
		await plugin.app.vault.modify(existing, content);
	} else {
		const folderPath = path.substring(0, path.lastIndexOf('/'));
		if (folderPath) await ensureFolder(plugin.app, folderPath);
		await plugin.app.vault.create(path, content);
	}
	return path;
}
