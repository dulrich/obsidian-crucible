import { Notice, TFile } from 'obsidian';
import type { JobType, OrchestrationJob } from '../../orchestration/types';
import type { StopJobOutcome } from '../../orchestration/cancellation';
import { ConfirmModal } from '../../confirmModal';
import { renderSortableTable } from '../render/sortableTable';
import { renderFileLink } from '../render/cells';
import { formatDateTime } from '../render/format';
import type { DashboardHost, SectionContext } from '../render/types';

const QUEUE_MONITOR_RENDER_LIMIT = 100;

// How each outcome of the single Cancel action reads. The row itself is gone by the
// time the answer arrives (the table refreshes), so the answer has to travel as a
// Notice rather than as button text.
//
// `completed` is the row this table exists to get right. Cancellation is cooperative
// — a workflow stops at its next checkpoint and never mid-request — so a job with no
// reachable checkpoint, or one that simply finished during the round trip, really did
// run to completion. Reporting that as "Stopped" would tell the user the queue obeyed
// an instruction it did not, and would hide the one behaviour they most need to
// understand about Cancel.
const STOP_OUTCOME_NOTICE: Record<StopJobOutcome, string> = {
	cancelled: 'Stopped.',
	completed: 'Finished before it could be stopped.',
	removed: 'Removed from the queue before it ran.',
	// The store rolled the move back, so the job is still queued — saying "no longer
	// queued" here would be the same lie in a different costume.
	failed: 'Could not cancel that job; it is still queued.',
	'not-found': 'That job is no longer queued or running.',
};

// One paragraph, deliberately: ConfirmModal renders its message as a single <p>, so a
// blank line here would collapse to a space rather than split it.
//
// The auto-refill sentence is not padding. Clearing an in-memory entry stops it from
// suppressing its own auto-source seed once the cancelled entry is forgotten, so with
// auto-enqueue on the item genuinely comes back — and a user who was not told that
// reads it as the clear having been ignored.
const CLEAR_QUEUED_CONFIRM =
	'Every queued job is removed: file-backed jobs move to the queue\'s cancelled folder, in-memory entries are '
	+ 'marked cancelled. Jobs already running are not affected — stop those with Cancel on their row. '
	+ 'One caveat: while auto-enqueue is on, cleared in-memory entries can be re-added by their source about a '
	+ 'minute later, so turn the source off as well if you want them to stay gone.';

function fileJobTargetPath(job: OrchestrationJob): string | undefined {
	const path = job.params?.targetPath ?? job.params?.path;
	return typeof path === 'string' ? path : undefined;
}

function fileJobTitle(job: OrchestrationJob): string {
	switch (job.type) {
		case 'image_metadata_extract': return typeof job.params?.imagePath === 'string' ? `Image metadata: ${job.params.imagePath.split('/').pop()}` : 'Image metadata extraction';
		case 'search_rebuild': return 'Vault search index';
		case 'search_embed_missing': return 'Vault embedding backfill';
		case 'search_upsert_batch': return searchBatchTitle(job);
		case 'search_sweep': return typeof job.params?.description === 'string' ? job.params.description : 'Search sweep';
		default: return job.id;
	}
}

function searchBatchTitle(job: OrchestrationJob): string {
	const batchIndex = typeof job.params?.batchIndex === 'number' ? job.params.batchIndex : -1;
	const batchCount = typeof job.params?.batchCount === 'number' ? job.params.batchCount : -1;
	// Same job type either way; the flag is the only thing separating a rebuild batch from an
	// embedding-backfill batch, and a multi-hour backfill is worth naming in the queue.
	const kind = job.params?.requireEmbeddings === true ? 'Embed batch' : 'Search batch';
	if (batchIndex >= 0 && batchCount > 0) return `${kind} ${batchIndex + 1} / ${batchCount}`;
	return kind;
}

export function buildQueueMonitorSection(host: DashboardHost): void {
	const card = host.container.createDiv({ cls: 'crucible-settings-group crucible-ingestion-section' });
	const { countEl, metaEl } = host.createSectionHeader(
		card,
		'Queue monitor',
		'All queued and running jobs across the file-backed and in-memory queues.',
		false,
	);

	// Deliberately just a panic switch here: one motion stops ALL auto-draining
	// while preserving the Autorun/Auto-enrich/per-type configuration underneath,
	// so re-enabling restores exactly the prior behavior. Manual Run/enqueue
	// still executes. The detailed controls live in the Queue controls section.
	const controls = card.createDiv({ cls: 'crucible-ingestion-queue-controls' });
	const panicLabel = controls.createEl('label', { cls: 'crucible-ingestion-queue-toggle' });
	const panicToggle = panicLabel.createEl('input', { type: 'checkbox' });
	panicToggle.checked = host.plugin.settings.orchestrationQueueEnabled !== false;
	panicLabel.appendText(' Queue enabled');

	// Manual "Run next": runs one queued file-backed job regardless of the gate.
	const runNextBtn = controls.createEl('button', { text: 'Run next', cls: 'crucible-ingestion-run-next' });
	runNextBtn.addEventListener('click', () => {
		void host.plugin.orchestrationAutoRunner?.runOnce();
	});

	// Queue-wide clear. Reads the queue from the store rather than from the table (the
	// table caps at 100 rows while a search rebuild enqueues hundreds), and confirms
	// first — the established precedent is that bulk destructive actions confirm and
	// single-row ones don't.
	const clearBtn = controls.createEl('button', { text: 'Clear queued', cls: 'mod-warning' });
	clearBtn.title = 'Remove every queued job across all types. Running jobs keep running.';
	clearBtn.addEventListener('click', () => {
		void (async () => {
			const confirmed = await new ConfirmModal(host.app, {
				title: 'Clear all queued jobs?',
				message: CLEAR_QUEUED_CONFIRM,
				confirmText: 'Clear queued',
				destructive: true,
			}).openAndAwait();
			if (!confirmed) return;
			clearBtn.disabled = true;
			try {
				const cleared = (await host.plugin.orchestrationAutoRunner?.clearQueued()) ?? 0;
				new Notice(cleared > 0
					? `Cleared ${cleared} queued job${cleared === 1 ? '' : 's'}.`
					: 'Nothing was queued.');
			} finally {
				clearBtn.disabled = false;
			}
			await host.refresh('queueMonitor');
		})();
	});

	controls.createSpan({
		cls: 'crucible-ingestion-queue-panic-hint',
		text: 'Off stops all auto-draining (manual Run still works). Per-type settings live under Queue Configuration above.',
	});
	panicToggle.addEventListener('change', () => {
		void (async () => {
			host.plugin.settings.orchestrationQueueEnabled = panicToggle.checked;
			await host.plugin.saveSettings();
			if (panicToggle.checked) host.plugin.orchestrationAutoRunner?.kickAll();
			// The panic veto feeds every chip in the Queue Configuration strip.
			await host.refresh('queueControls');
		})();
	});

	const body = card.createDiv({ cls: 'crucible-ingestion-section-body' });
	body.createDiv({ cls: 'crucible-empty-state', text: 'Queue is empty.' });

	const ctx: SectionContext = {
		id: 'queueMonitor',
		title: 'Queue monitor',
		description: '',
		body,
		countEl,
		metaEl,
		sort: null,
		refresh: () => renderQueueMonitor(host, body, ctx),
	};
	host.registerSection(ctx);
}

export async function renderQueueMonitor(host: DashboardHost, body: HTMLElement, ctx: SectionContext): Promise<void> {
	body.empty();

	// --- File-backed jobs (orchestrator job store) ---
	type QueueRow = {
		// 'file' rows come from jobStore; 'memory' rows come from enrichmentQueue
		source: 'file' | 'memory';
		status: 'queued' | 'running';
		type: string;
		// file rows: job id; memory rows: key used for Cancel
		key: string;
		// memory rows: videoId for dequeue calls
		videoId?: string;
		// memory rows: targetPath note link when available
		targetPath?: string;
		// memory rows: display title / channel fallback
		title?: string;
		created: string;
		error?: string;
		progress?: string;
	};

	const store = host.plugin.jobStore;
	let fileRows: QueueRow[] = [];
	if (store) {
		try {
			const [running, queued] = await Promise.all([store.listFolder('running'), store.listFolder('queued')]);
			fileRows = [
				...running.map(e => ({ source: 'file' as const, status: 'running' as const, type: e.job.type, key: e.job.id, targetPath: fileJobTargetPath(e.job), title: fileJobTitle(e.job), created: e.job.created ?? '', error: e.job.error, progress: e.job.progress })),
				...queued.map(e => ({ source: 'file' as const, status: 'queued' as const, type: e.job.type, key: e.job.id, targetPath: fileJobTargetPath(e.job), title: fileJobTitle(e.job), created: e.job.created ?? '', error: e.job.error, progress: e.job.progress })),
			];
		} catch (e) {
			body.createDiv({ cls: 'crucible-empty-state', text: `Failed to read file queue: ${e instanceof Error ? e.message : String(e)}` });
			host.setSectionCount('queueMonitor', 0);
			return;
		}
	}

	// --- In-memory jobs (enrichment queue snapshot) ---
	const memoryRows: QueueRow[] = (host.plugin.enrichmentQueue?.getSnapshot() ?? [])
		.filter(e => e.status === 'pending' || e.status === 'running')
		.map(e => ({
			source: 'memory' as const,
			// Map enrichment queue status to display status: pending → queued
			status: e.status === 'pending' ? ('queued' as const) : ('running' as const),
			type: 'youtube_metadata_fetch',
			key: e.key,
			videoId: e.videoId,
			targetPath: e.targetPath,
			title: e.title || e.videoId,
			created: e.addedAt ? formatDateTime(e.addedAt) : '',
			error: e.error,
		}));

	const rows: QueueRow[] = [...fileRows, ...memoryRows];

	// Per-type pending counts for section meta line
	const typeCounts = new Map<string, number>();
	for (const r of rows) typeCounts.set(r.type, (typeCounts.get(r.type) ?? 0) + 1);
	const metaParts = Array.from(typeCounts.entries()).map(([t, n]) => `${t} ${n}`);
	if (rows.length > QUEUE_MONITOR_RENDER_LIMIT) metaParts.push(`showing ${QUEUE_MONITOR_RENDER_LIMIT} of ${rows.length}`);
	const metaText = metaParts.join(' · ');
	host.setSectionMeta('queueMonitor', metaText);
	host.setSectionCount('queueMonitor', rows.length);

	if (rows.length === 0) {
		body.createDiv({ cls: 'crucible-empty-state', text: 'Queue is empty.' });
		return;
	}

	if (!ctx.sort) ctx.sort = { column: 'status', direction: 'asc' };

	renderSortableTable<QueueRow>(body, [
		{
			key: 'status',
			label: 'Status',
			sortable: true,
			// Running rows sort before queued rows
			sortKey: r => (r.status === 'running' ? 0 : 1),
			render: (r, td) => td.setText(r.status),
		},
		{
			key: 'type',
			label: 'Type',
			sortable: true,
			sortKey: r => r.type,
			render: (r, td) => td.setText(r.type),
		},
		{
			key: 'target',
			label: 'Target',
			sortable: true,
			sortKey: r => r.targetPath ?? r.title ?? r.key,
			render: (r, td) => {
				if (r.source === 'memory') {
					if (r.targetPath) {
						// Resolve note TFile and render a clickable vault link
						const file = host.app.vault.getAbstractFileByPath(r.targetPath);
						if (file instanceof TFile) {
							renderFileLink(host.app, td, file);
							return;
						}
					}
					// Fallback: title or videoId
					td.setText(r.title ?? r.videoId ?? r.key);
				} else {
					if (r.targetPath) {
						const file = host.app.vault.getAbstractFileByPath(r.targetPath);
						if (file instanceof TFile) {
							renderFileLink(host.app, td, file);
							return;
						}
					}
					td.setText(r.title ?? r.key);
				}
			},
		},
		{
			key: 'progress',
			label: 'Progress',
			render: (r, td) => td.setText(r.progress ?? ''),
		},
		{
			key: 'created',
			label: 'Created',
			sortable: true,
			sortKey: r => r.created,
			render: (r, td) => td.setText(r.created),
		},
		{
			key: 'error',
			label: 'Error',
			render: (r, td) => td.setText(r.error ?? ''),
		},
		{
			key: 'action',
			label: 'Action',
			render: (r, td) => {
				// The cell lays its buttons out itself. Appended bare they sit flush against
				// each other, which on a destructive action next to a Run button is not just
				// untidy — it invites the wrong click.
				td.addClass('crucible-queue-action-cell');
				// Per-job Run: execute this one queued job now, ignoring the auto-run
				// gate (for "auto off / deep queue, run this one"). Running rows have no
				// Run — they're already in flight.
				if (r.status === 'queued') {
					const run = td.createEl('button', { text: 'Run' });
					run.title = 'Run this job now, ignoring the auto-run gate.';
					run.addEventListener('click', () => {
						void (async () => {
							run.disabled = true;
							const outcome = await host.plugin.orchestrationAutoRunner?.runJob(r.type as JobType, r.key);
							// 'ran' ⇒ the row is gone, 'blocked' ⇒ it ran and came back deferred
							// because a dependency is down; both change the row, so refresh.
							// Otherwise (already claimed by a drain / no runner) leave the
							// button usable.
							if (outcome === 'ran' || outcome === 'blocked') await host.refresh('queueMonitor');
							else run.disabled = false;
						})();
					});
				}
				renderCancelAction(host, td, r.type as JobType, r.key, r.status);
			},
		},
	], rows, ctx, { limit: QUEUE_MONITOR_RENDER_LIMIT });
}

// ONE Cancel button for both mechanisms — aborting a running job and dropping a
// queued one — because from the user's side they are one intention. The transitional
// copy is what makes that honest: a queued job goes immediately, a running one stops
// at its next checkpoint, and the button says which is happening.
//
// Nothing here gates the rest of the table on the cancel promise. With the autorun
// timeout disabled and a checkpoint-poor workflow, that promise resolves only when
// the work naturally finishes — unbounded, not hung. So the awaiting lives entirely
// inside one row's button, and a row that sits at "Stopping…" for a long job is
// correct behaviour that should read as such.
function renderCancelAction(
	host: DashboardHost,
	td: HTMLElement,
	type: JobType,
	key: string,
	status: 'queued' | 'running',
): void {
	// Re-derived at render time rather than held in a closure, so the state survives
	// the table's own live refreshes (queue events refresh this section continuously,
	// which would otherwise reset a "Stopping…" button to "Cancel" every few seconds).
	if (host.plugin.orchestrator.isCancelling(type, key)) {
		const pending = td.createEl('button', { text: 'Stopping…' });
		pending.disabled = true;
		pending.title = 'Stop requested. Cancellation is cooperative: the job stops at its next checkpoint, and any '
			+ 'request already in flight has to finish first.';
		return;
	}

	// mod-warning: Cancel destroys queued work or stops work in progress, and it sits
	// immediately beside Run. It carries the danger semantic for the same reason the
	// queue-wide Clear does — the two destructive controls in this view should read as
	// destructive at a glance, not only once the tooltip is open.
	const cancel = td.createEl('button', { text: 'Cancel', cls: 'mod-warning' });
	cancel.title = status === 'running'
		? 'Stop this job. It stops at its next checkpoint — a request already in flight finishes first — so a long job '
			+ 'can take a while to acknowledge.'
		: 'Drop this job from the queue before it runs.';
	cancel.addEventListener('click', () => {
		void (async () => {
			cancel.disabled = true;
			cancel.setText(status === 'running' ? 'Stopping…' : 'Cancelling…');
			const outcome = (await host.plugin.orchestrationAutoRunner?.stopJob(type, key)) ?? 'not-found';
			new Notice(STOP_OUTCOME_NOTICE[outcome]);
			await host.refresh('queueMonitor');
		})();
	});
}
