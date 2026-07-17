import { TFile } from 'obsidian';
import type { OrchestrationJob } from '../../orchestration/types';
import { renderSortableTable } from '../render/sortableTable';
import { renderFileLink } from '../render/cells';
import { formatDateTime } from '../render/format';
import type { DashboardHost, SectionContext } from '../render/types';

const QUEUE_MONITOR_RENDER_LIMIT = 100;

function fileJobTargetPath(job: OrchestrationJob): string | undefined {
	const path = job.params?.targetPath ?? job.params?.path;
	return typeof path === 'string' ? path : undefined;
}

function fileJobTitle(job: OrchestrationJob): string {
	switch (job.type) {
		case 'image_metadata_extract': return typeof job.params?.imagePath === 'string' ? `Image metadata: ${job.params.imagePath.split('/').pop()}` : 'Image metadata extraction';
		case 'search_rebuild': return 'Vault search index';
		case 'search_upsert_batch': return searchBatchTitle(job);
		case 'search_sweep': return typeof job.params?.description === 'string' ? job.params.description : 'Search sweep';
		default: return job.id;
	}
}

function searchBatchTitle(job: OrchestrationJob): string {
	const batchIndex = typeof job.params?.batchIndex === 'number' ? job.params.batchIndex : -1;
	const batchCount = typeof job.params?.batchCount === 'number' ? job.params.batchCount : -1;
	if (batchIndex >= 0 && batchCount > 0) return `Search batch ${batchIndex + 1} / ${batchCount}`;
	return 'Search batch';
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
	controls.createSpan({
		cls: 'crucible-ingestion-queue-panic-hint',
		text: 'Off stops all auto-draining (manual Run still works). Per-type settings live under Queue controls above.',
	});
	panicToggle.addEventListener('change', () => {
		void (async () => {
			host.plugin.settings.orchestrationQueueEnabled = panicToggle.checked;
			await host.plugin.saveSettings();
			if (panicToggle.checked) host.plugin.orchestrationAutoRunner?.kickAll();
			// The panic veto feeds every chip in the Queue controls strip.
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
				// Only memory-queue pending entries have a Cancel action
				if (r.source === 'memory' && r.status === 'queued') {
					const cancel = td.createEl('button', { text: 'Cancel' });
					cancel.addEventListener('click', () => {
						host.plugin.enrichmentQueue?.dequeueIfPending(r.key);
					});
				}
			},
		},
	], rows, ctx, { limit: QUEUE_MONITOR_RENDER_LIMIT });
}
