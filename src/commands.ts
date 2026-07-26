import { Notice } from 'obsidian';
import { CrucibleCommandPaletteModal, buildHintOptions, buildScoreText, computeHint, getPaletteItems } from './commandPalette';
import { CrucibleFileOpenPaletteModal } from './fileOpenPalette';
import { shortestUniqueFuzzyString, shortestTopMatchFuzzyString } from './commandPaletteHints';
import { appendDebugLog } from './utils';
import { FilePickerModal } from './orchestration/FilePickerModal';
import type CruciblePlugin from './main';
import { VaultSearchModal } from './search/SearchModal';
import { isSearchIndexablePath } from './search/chunker';
import { exportSourceEvalTrainingData } from './sourceEval/export';
import { SURROUNDS, setSurround, nextSurround, surroundLabel } from './surround';
import { runServiceOutageRequeueFlow } from './orchestration/failedJobRepair';
import { ConfirmModal } from './confirmModal';

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
			new Notice(`Search service: ${health.ok ? 'ok' : 'not ok'}${health.version ? ` (${health.version})` : ''}`);
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
