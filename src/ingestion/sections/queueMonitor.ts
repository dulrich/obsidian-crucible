import { App, Modal, Notice, setIcon, TFile } from 'obsidian';
import type { JobStatus, JobType, OrchestrationJob } from '../../orchestration/types';
import type { JobListOrder } from '../../orchestration/db/types';
import type { StopJobOutcome } from '../../orchestration/cancellation';
import type { ServiceHealthSnapshot } from '../../orchestration/serviceHealth';
import { runServiceOutageRequeueFlow } from '../../orchestration/failedJobRepair';
import { ConfirmModal } from '../../confirmModal';
import { confirmDestructive } from '../../settings/destructiveActions';
import { renderSortableTable } from '../render/sortableTable';
import { renderFileLink, renderIconButton } from '../render/cells';
import { formatDateTime } from '../render/format';
import { refreshWithScrollPreserved } from '../render/refresh';
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
	// The store refused the write, so the job is still queued — saying "no longer
	// queued" here would be the same lie in a different costume.
	failed: 'Could not cancel that job; it is still queued.',
	'not-found': 'That job is no longer queued or running.',
};

// One paragraph, deliberately: ConfirmModal renders its message as a single <p>, so a
// blank line here would collapse to a space rather than split it.
//
// The auto-refill sentence is not padding. A cancelled job suppresses its own
// auto-source re-seed only for the type's retention window, so with auto-enqueue on the
// item genuinely comes back — and a user who was not told that reads it as the clear
// having been ignored.
const CLEAR_QUEUED_CONFIRM =
	'Every queued job is marked cancelled. Jobs already running are not affected — stop those with Cancel on '
	+ 'their row. One caveat: while auto-enqueue is on, cleared enrichment jobs can be re-added by their source '
	+ 'about a minute later, so turn the source off as well if you want them to stay gone.';

// Service-health pills: the fleet taxonomy split by breaker state, gated on whether
// the service has any reason to matter right now. `open` and `half-open` are genuine
// status (something is or might be wrong), so they use the status-pill family; a
// `closed` service is only rendered at all once it has failed before (a stale
// `lastKind` is the tell — see ServiceHealthRegistry.reportSuccess, which resets
// state but deliberately leaves lastKind/lastReason in place), and even then it is a
// neutral pill: recovered is not a status to alarm on. A service the registry has
// never heard from has no entry in `snapshot()` at all, so it renders nothing — no
// special-casing needed here.
//
// hide-when-idle (r2f WP-3): a breaker with no queued/running job of a type that
// declares it can never see another probe outcome — cancelling the only job of the
// one type that declared a service leaves the pill stuck open/half-open forever,
// since the registry is in-memory and reload is the only reset. `shouldRenderServicePill`
// hides the pill whenever no such job exists (`hasActiveWork` false), regardless of
// breaker state; breaker state itself is untouched, so the pill reappears on its own
// if work returns while still open. Two triggers keep the row honest as that
// changes: the existing `onTransition` repaint (breaker state changes) and a second
// `'orchestration-queue-updated'` bus subscription below (queue membership changes —
// the last relevant job settling or being cancelled).
function serviceHealthPill(snapshot: ServiceHealthSnapshot): { cls: string; text: string } | null {
	switch (snapshot.state) {
		case 'open': {
			const retry = snapshot.retryAt ? retryCountdownText(snapshot.retryAt) : null;
			return { cls: 'crucible-pill is-error', text: `${snapshot.service} open${retry ? ` · retry in ${retry}` : ''}` };
		}
		case 'half-open':
			return { cls: 'crucible-pill is-warn', text: `${snapshot.service} half-open` };
		case 'closed':
			return snapshot.lastKind ? { cls: 'crucible-pill is-muted', text: `${snapshot.service} closed` } : null;
	}
}

// Pure gate: false whenever there is no active work for the service, regardless of
// breaker state; otherwise defers entirely to `serviceHealthPill`'s existing
// state→pill mapping (including its own `closed`+no-`lastKind` ⇒ null case).
export function shouldRenderServicePill(snapshot: ServiceHealthSnapshot, hasActiveWork: boolean): boolean {
	if (!hasActiveWork) return false;
	return serviceHealthPill(snapshot) !== null;
}

function retryCountdownText(retryAt: number): string {
	const remainingMs = retryAt - Date.now();
	if (remainingMs <= 0) return 'now';
	const seconds = Math.ceil(remainingMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const restSeconds = seconds % 60;
	return restSeconds > 0 ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
}

function renderServiceHealthPills(host: DashboardHost, container: HTMLElement): void {
	container.empty();
	const registry = host.plugin.serviceHealth;
	if (!registry) return;
	const orch = host.plugin.orchestrator;
	for (const snapshot of registry.snapshot()) {
		const hasActiveWork = orch
			? orch.typesDependingOn(snapshot.service).some(t => orch.hasPending(t))
			: false;
		if (!shouldRenderServicePill(snapshot, hasActiveWork)) continue;
		const pill = serviceHealthPill(snapshot);
		if (!pill) continue;
		container.createSpan({ cls: pill.cls, text: pill.text });
	}
}

// WP-DP3: null selects the default combined view (queued+running, today's
// behavior); any other value filters the table to that one bucket via
// `Orchestrator.listJobs`. Kept as a plain view-state value — never persisted,
// same "per-mount" treatment as section collapse — so it lives on the section's
// own `SectionContext` (the optional `queueStatusFilter` field) rather than a
// module-level variable that would bleed across multiple dashboard mounts.
export type QueueStatusFilter = JobStatus | null;

const QUEUE_STATUS_BUCKETS: readonly JobStatus[] = ['queued', 'running', 'done', 'failed', 'cancelled'];

// Buckets whose rows are pruned by age (`orchestrationJobRetentionDays`, default 30
// — src/orchestration/AGENTS.md's "terminal rows are pruned by age" quirk). Drives
// the empty-state wording below: an empty settled bucket may just mean "nothing
// happened to settle there yet", but it may also mean retention already swept it,
// and the generic "no jobs" phrasing reads as a bug report either way.
const SETTLED_STATUSES: readonly JobStatus[] = ['done', 'failed', 'cancelled'];

// Pure: which `listJobs` call(s) a given filter selection requires. The default
// view (`null`) is the combined queued+running list (today's behavior, unchanged —
// claim order, since queued/running dispatch order is dispatch truth); any other
// selection fetches that one bucket alone. A discriminated union rather than a bare
// status array so the caller never has to index into (and TS narrow) a length-1
// array to recover the single status. Exported for direct unit testing — no
// Orchestrator/DOM needed.
//
// WP-G3: a single-bucket fetch also carries its `order` mode. Settled buckets
// (`SETTLED_STATUSES` — done/failed/cancelled) order by settlement recency: claim
// order (`lane_rank, priority_rank, created, id`) is dispatch truth for queued/
// running, but for a *settled* bucket it just replays old retained rows first and
// buries recent settlements behind them — a 28-job reconcile burst was invisible
// behind older rows this way. Queued/running singles keep claim order.
export type QueueFetchPlan =
	| { kind: 'single'; status: JobStatus; order: JobListOrder }
	| { kind: 'combined' };

export function queueFetchPlan(filter: QueueStatusFilter): QueueFetchPlan {
	if (!filter) return { kind: 'combined' };
	return { kind: 'single', status: filter, order: SETTLED_STATUSES.includes(filter) ? 'recency' : 'claim' };
}

// Pure: the honest empty-state line for a given filter selection. A settled bucket
// (done/failed/cancelled) coming back empty is ambiguous — "nothing has settled
// there" and "retention already pruned it" look identical from the row count alone
// — so that branch names the mechanism instead of implying the former. Exported for
// direct unit testing.
export function queueEmptyStateText(filter: QueueStatusFilter): string {
	if (!filter) return 'Queue is empty.';
	if (SETTLED_STATUSES.includes(filter)) {
		return `No ${filter} jobs retained. Settled jobs are pruned after the retention window `
			+ '(Queue Configuration → Job retention (days), default 30).';
	}
	return `No ${filter} jobs.`;
}

// Whole-DB bucket counts (all five statuses, every type) — the in-dashboard answer
// to "what's in the job queue database" that used to require the Scan-queue notice
// or the sqlite3 CLI. WP-DP3: the row this renders into moved below the enable/
// run/clear control bar and the pills became the job table's filter control —
// clicking one filters the table to that bucket (`onSelect` toggles it back to the
// default view when the already-active pill is clicked again). Counts-at-rest are
// neutral pills per the fleet taxonomy; `failed` alone borrows the error status hue
// while non-zero, but only in its unselected state — the active pill's selected
// treatment (`is-contrast`, the existing neutral-pill "selected" variant) takes over
// once it's the filter, so a real ok/warn/error fact never doubles as a selection
// indicator.
// Exported for direct unit testing (tests/queueMonitorStatusFilter.test.mjs) — same
// rationale as `formatJobDetail`: a DOM-bearing but Orchestrator/host-light function
// is easier to pin behaviorally than driving the full `renderQueueMonitor` fetch path.
//
// `statsOverride` (WP-G3): `renderQueueMonitor` already fetches `queueStats()` once
// per pass (to derive the honest "showing K of N" meta-line total) and passes that
// same result here, so the filter bar doesn't run a second identical whole-DB count
// query. Omitted (the section's own initial-mount call site, before any row fetch
// has happened) falls back to fetching it here, same as before this WP.
export function renderQueueFilterBar(
	host: DashboardHost,
	container: HTMLElement,
	active: QueueStatusFilter,
	onSelect: (status: JobStatus) => void,
	statsOverride?: Record<JobStatus, number> | null,
): void {
	container.empty();
	const stats = statsOverride !== undefined ? statsOverride : host.plugin.orchestrator?.queueStats();
	if (!stats) return;
	for (const bucket of QUEUE_STATUS_BUCKETS) {
		const n = stats[bucket];
		const isActive = active === bucket;
		let cls = 'crucible-pill';
		if (isActive) cls += ' is-contrast';
		else if (bucket === 'failed' && n > 0) cls += ' is-error';
		else cls += ' is-muted';
		const btn = container.createEl('button', { cls, text: `${bucket} ${n}` });
		btn.setAttr('aria-pressed', String(isActive));
		btn.setAttr('aria-label', `Filter to ${bucket} jobs`);
		btn.title = isActive
			? `Showing ${bucket} jobs only — click again to go back to the default queued+running view.`
			: `Show only ${bucket} jobs.`;
		btn.addEventListener('click', () => onSelect(bucket));
	}
}

function jobTargetPath(job: OrchestrationJob): string | undefined {
	const path = job.params?.targetPath ?? job.params?.path;
	return typeof path === 'string' ? path : undefined;
}

export function jobTitle(job: OrchestrationJob): string {
	switch (job.type) {
		// The enrichment types name themselves by their subject rather than by their id —
		// the memory queue used to carry `display` fields for exactly this, and the row
		// would otherwise read as a bare job id where it used to read as a video title.
		case 'youtube_metadata_fetch': return youtubeMetadataTitle(job);
		case 'x_metadata_fetch': return xMetadataTitle(job);
		case 'x_post_discover': return typeof job.params?.targetPath === 'string' ? `X link discovery: ${job.params.targetPath.split('/').pop()}` : 'X link discovery';
		case 'x_metadata_backfill': return 'X metadata backfill';
		case 'image_describe_note': return typeof job.params?.targetPath === 'string' ? `Image descriptions: ${job.params.targetPath.split('/').pop()}` : 'Image descriptions';
		case 'image_describe_backfill': return 'Image description backfill';
		case 'image_describe_batch': return imageDescribeBatchTitle(job);
		case 'search_rebuild': return 'Vault search index';
		case 'search_embed_missing': return 'Vault embedding backfill';
		case 'search_upsert_batch': return searchBatchTitle(job);
		case 'search_sweep': return typeof job.params?.description === 'string' ? job.params.description : 'Search sweep';
		// WP-F3: these two carry only `{path}` (SearchIndexCoordinator.enqueueAutomatic /
		// search-reconcile-index's payload shape — see the `/v1/paths` quirk in
		// src/search/AGENTS.md), no `targetPath`, so they fell to the `default: job.id` branch
		// and the queue monitor row read as a bare job id instead of naming the file.
		case 'search_upsert_file': return typeof job.params?.path === 'string' ? `Index: ${job.params.path.split('/').pop()}` : 'Index update';
		case 'search_delete_path': return typeof job.params?.path === 'string' ? `De-index: ${job.params.path.split('/').pop()}` : 'Index delete';
		default: return job.id;
	}
}

function youtubeMetadataTitle(job: OrchestrationJob): string {
	const title = typeof job.params?.title === 'string' ? job.params.title : '';
	if (title) return title;
	const videoId = typeof job.params?.videoId === 'string' ? job.params.videoId : '';
	return videoId || job.id;
}

function xMetadataTitle(job: OrchestrationJob): string {
	const statusId = typeof job.params?.statusId === 'string' ? job.params.statusId : '';
	return statusId ? `X post ${statusId}` : job.id;
}

function imageDescribeBatchTitle(job: OrchestrationJob): string {
	const batchIndex = typeof job.params?.batchIndex === 'number' ? job.params.batchIndex : -1;
	const batchCount = typeof job.params?.batchCount === 'number' ? job.params.batchCount : -1;
	if (batchIndex >= 0 && batchCount > 0) return `Image description batch ${batchIndex + 1} / ${batchCount}`;
	return 'Image description batch';
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

// One row shape for one queue. thq WP-8 removed the `source: 'file' | 'memory'`
// discriminant along with the in-memory queue that needed it: every row now comes from
// `Orchestrator.listJobs`, so `key` is always a job id, `title` is always derived from
// params, and the Details modal (which used to be hidden for memory rows because they
// carried no params/notes/failureKind) applies to every row. WP-DP3: `status` widened
// from `'queued' | 'running'` to the full `JobStatus` — the status filter bar can now
// fetch a settled bucket (done/failed/cancelled), so a row's own status is no longer
// guaranteed to be one of the original two.
type QueueRow = {
	status: JobStatus;
	type: string;
	/** Job id — what Run/Cancel/Details address. */
	key: string;
	/** Target note link when the job names one. */
	targetPath?: string;
	/** Human-readable subject; falls back to the id. */
	title?: string;
	created: string;
	error?: string;
	progress?: string;
	// No dedicated column — shown in the per-row Details modal instead: how `error` was
	// classified, the free-text run narration, and the raw params payload.
	failureKind?: 'service' | 'job';
	notes?: string;
	params?: Record<string, unknown>;
};

function toQueueRow(job: OrchestrationJob, status: JobStatus): QueueRow {
	return {
		status,
		type: job.type,
		key: job.id,
		targetPath: jobTargetPath(job),
		title: jobTitle(job),
		created: job.created ?? '',
		error: job.error,
		progress: job.progress,
		failureKind: job.failureKind,
		notes: job.notes,
		params: job.params,
	};
}

/**
 * WP-7's job-detail affordance: post-cutover, a db-backed job has no note file to
 * open, so this is the replacement surface — params (pretty-printed), error/
 * failureKind, progress, and notes (when the backend carries them; see
 * `OrchestrationJob.notes`), plus a copy-to-clipboard button. Works identically for
 * file rows: same `QueueRow` fields, this WP's seam is what makes both sources land
 * in the same shape by the time a row reaches this modal.
 */
class JobDetailModal extends Modal {
	constructor(app: App, private readonly row: QueueRow) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(`Job detail: ${this.row.type}`);

		const text = formatJobDetail(this.row);
		// Reuses ChainInspectorModal's raw-text-in-a-modal class (src/chains.ts) rather
		// than inventing a new one — same shape (monospace, wrapped, scroll-capped).
		contentEl.createEl('pre', { text, cls: 'crucible-inspector-pre' });

		const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
		// WP-G3: standard icon+label control (exemplar: sourceEvalDashboard.ts's
		// "Export JSONL" button) — the bare-text button was a UI-standards miss.
		// `copy` is reserved fleet-wide for copy-to-clipboard/copy-path
		// (tests/iconLanguageConsistencyGuard.test.mjs), which this is exactly.
		const copy = buttons.createEl('button', { cls: 'crucible-icon-label-btn' });
		setIcon(copy, 'copy');
		copy.createSpan({ text: 'Copy' });
		copy.addEventListener('click', () => {
			void navigator.clipboard.writeText(text);
			new Notice('Job detail copied to clipboard.');
		});
		const close = buttons.createEl('button', { text: 'Close', cls: 'mod-cta' });
		close.addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// Exported for direct unit testing (tests/queueMonitorJobDetail.test.mjs) — a pure
// function is easier to pin than driving the DOM-heavy modal/table machinery this
// section otherwise needs a full Obsidian stub for.
export function formatJobDetail(row: QueueRow): string {
	const lines = [
		`Type: ${row.type}`,
		`ID: ${row.key}`,
		`Status: ${row.status}`,
		`Created: ${row.created}`,
	];
	if (row.targetPath) lines.push(`Target: ${row.targetPath}`);
	if (row.progress) lines.push(`Progress: ${row.progress}`);
	if (row.error) lines.push(`Error: ${row.error}`);
	if (row.failureKind) lines.push(`Failure kind: ${row.failureKind}`);
	lines.push('', 'Params:', JSON.stringify(row.params ?? {}, null, 2));
	if (row.notes) lines.push('', 'Notes:', row.notes);
	return lines.join('\n');
}

export function buildQueueMonitorSection(host: DashboardHost): void {
	const card = host.container.createDiv({ cls: 'crucible-settings-group crucible-ingestion-section' });
	const { countEl, metaEl } = host.createSectionHeader(
		card,
		'Queue monitor',
		'All queued and running jobs, across every job type.',
		false,
	);

	// Service-health pills, near the top so a dependency outage reads before any one
	// row that's deferred because of it. Live, on two triggers: every breaker
	// transition, and every queue-membership change (a pill's `hasActiveWork` gate can
	// flip when the last relevant job settles or is cancelled, with no breaker
	// transition involved). Both subscriptions are released on dashboard teardown
	// since this section is built once in mount() rather than per-refresh.
	const healthRow = card.createDiv({ cls: 'crucible-service-health-row' });
	renderServiceHealthPills(host, healthRow);
	const unsubscribeHealth = host.plugin.serviceHealth?.onTransition(() => renderServiceHealthPills(host, healthRow));
	if (unsubscribeHealth) host.registerDisposer(unsubscribeHealth);
	const unsubscribeHealthQueue = host.plugin.ingestionEvents?.on('orchestration-queue-updated', () => renderServiceHealthPills(host, healthRow));
	if (unsubscribeHealthQueue) host.registerDisposer(unsubscribeHealthQueue);

	// Deliberately just a panic switch here: one motion stops ALL auto-draining
	// while preserving the Autorun/Auto-enrich/per-type configuration underneath,
	// so re-enabling restores exactly the prior behavior. Manual Run/enqueue
	// still executes. The detailed controls live in the Queue controls section.
	const controls = card.createDiv({ cls: 'crucible-ingestion-queue-controls' });
	const panicLabel = controls.createEl('label', { cls: 'crucible-ingestion-queue-toggle' });
	const panicToggle = panicLabel.createEl('input', { type: 'checkbox' });
	panicToggle.checked = host.plugin.settings.orchestrationQueueEnabled !== false;
	panicLabel.appendText(' Queue enabled');

	// Manual "Run next": runs one queued job regardless of the gate.
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

	// Retroactive repair for a service-outage cohort in failed/ (failedJobRepair.ts).
	// Not destructive — a requeued job just runs again — so no mod-warning; it still
	// sits in this row's gapped flex layout, which is what the spacing rule actually
	// requires next to Clear queued's destructive button.
	const requeueBtn = controls.createEl('button', { text: 'Requeue service-outage failures' });
	requeueBtn.title = 'Scan failed/ for jobs that failed because a dependency was down (not the job itself) and '
		+ 'move them back to queued/, after a dry-run confirmation.';
	requeueBtn.addEventListener('click', () => {
		void (async () => {
			requeueBtn.disabled = true;
			try {
				await runServiceOutageRequeueFlow(host.plugin);
			} finally {
				requeueBtn.disabled = false;
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

	// WP-DP3: the stats-pill row moved below the control bar above and doubles as
	// the job table's filter control. The container is created in its new DOM
	// position here but populated after `ctx` exists below — its buttons need
	// `ctx.queueStatusFilter`/`host.refresh` to wire their click handlers, and every
	// later repaint goes through `renderQueueMonitor`'s own call to
	// `renderQueueFilterBar` (same "built once, re-rendered by every refresh pass"
	// shape the row already had).
	const statsRow = card.createDiv({ cls: 'crucible-queue-stats-row' });

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
		// Per-mount view state (like section collapse elsewhere) — never persisted.
		// null = the default combined queued+running view.
		queueStatusFilter: null,
		// SectionContext.refresh is itself the scroll-preserving wrapped function
		// (see AGENTS.md #5 / render/refresh.ts) so every call site — the header
		// Refresh button, sort-header clicks, and this section's own Cancel/Run/
		// Clear/panic-toggle handlers below — gets scroll preservation for free.
		refresh: () => refreshWithScrollPreserved(body, () => renderQueueMonitor(host, body, ctx, statsRow)),
	};

	renderQueueFilterBar(host, statsRow, ctx.queueStatusFilter ?? null, status => {
		ctx.queueStatusFilter = ctx.queueStatusFilter === status ? null : status;
		void host.refresh('queueMonitor');
	});

	host.registerSection(ctx);
}

export async function renderQueueMonitor(host: DashboardHost, body: HTMLElement, ctx: SectionContext, statsEl?: HTMLElement): Promise<void> {
	const filter: QueueStatusFilter = ctx.queueStatusFilter ?? null;
	const orchestrator = host.plugin.orchestrator;
	// WP-G3: fetched once per render pass and reused both for the filter bar's pill
	// counts and the meta line's honest "showing K of N" total below — see
	// `renderQueueFilterBar`'s `statsOverride` doc comment for why this isn't a
	// second whole-DB count query.
	const stats = orchestrator?.queueStats() ?? null;
	// Stats/filter-bar first: synchronous store counts, so the bucket row (and its
	// active-pill state) is current even while the row queries below are still in
	// flight (and even when they fail). Re-wiring the click handler here on every
	// pass (rather than once at build time) is cheap and keeps it reading the same
	// `ctx`/`host` this render call closed over.
	if (statsEl) {
		renderQueueFilterBar(host, statsEl, filter, status => {
			ctx.queueStatusFilter = ctx.queueStatusFilter === status ? null : status;
			void host.refresh('queueMonitor');
		}, stats);
	}
	// Body is intentionally NOT emptied here: `orchestrator.listJobs` below awaits two
	// full queries, and clearing the body first left it visibly blank for that whole
	// window on every queue event. Every branch below empties body itself, immediately
	// before it writes — the error message, the empty state, and (via
	// renderSortableTable's own `parent.empty()`) the table.
	// WP-DP3: the default view (no filter) stays the combined queued+running list;
	// selecting a bucket fetches that one status alone via the same `listJobs` seam.
	// `queueFetchPlan` is the pure routing decision — the branch below just executes
	// whichever plan it names, including (WP-G3) its `order` mode for a single-status
	// fetch.
	const plan = queueFetchPlan(filter);
	let rows: QueueRow[] = [];
	if (orchestrator) {
		try {
			if (plan.kind === 'single') {
				const jobs = await orchestrator.listJobs(plan.status, { limit: QUEUE_MONITOR_RENDER_LIMIT, order: plan.order });
				rows = jobs.map(job => toQueueRow(job, plan.status));
			} else {
				const [running, queued] = await Promise.all([orchestrator.listJobs('running', { limit: QUEUE_MONITOR_RENDER_LIMIT }), orchestrator.listJobs('queued', { limit: QUEUE_MONITOR_RENDER_LIMIT })]);
				rows = [
					...running.map(job => toQueueRow(job, 'running')),
					...queued.map(job => toQueueRow(job, 'queued')),
				];
			}
		} catch (e) {
			body.empty();
			body.createDiv({ cls: 'crucible-empty-state', text: `Failed to read the job queue: ${e instanceof Error ? e.message : String(e)}` });
			host.setSectionCount('queueMonitor', 0);
			return;
		}
	}

	// Per-type pending counts for section meta line
	const typeCounts = new Map<string, number>();
	for (const r of rows) typeCounts.set(r.type, (typeCounts.get(r.type) ?? 0) + 1);
	const metaParts = Array.from(typeCounts.entries()).map(([t, n]) => `${t} ${n}`);
	// WP-G3: replaces the dead `rows.length > QUEUE_MONITOR_RENDER_LIMIT` check — rows
	// arrive pre-limited by `listJobs`'s own SQL `LIMIT`, so for a single-status fetch
	// that comparison could never fire. `stats` (the same whole-DB bucket-count row
	// the filter bar renders, fetched once above) gives an honest total: a
	// single-status fetch's total is that bucket's whole-DB count; the combined
	// default view's is queued+running (the two buckets it actually fetches).
	const bucketTotal = stats ? (plan.kind === 'single' ? stats[plan.status] : stats.queued + stats.running) : null;
	if (bucketTotal !== null && bucketTotal > rows.length) metaParts.push(`showing ${rows.length} of ${bucketTotal}`);
	const metaText = metaParts.join(' · ');
	host.setSectionMeta('queueMonitor', metaText);
	host.setSectionCount('queueMonitor', rows.length);

	if (rows.length === 0) {
		body.empty();
		body.createDiv({ cls: 'crucible-empty-state', text: queueEmptyStateText(filter) });
		return;
	}

	if (!ctx.sort) ctx.sort = { column: 'status', direction: 'asc' };

	renderSortableTable<QueueRow>(body, [
		{
			key: 'status',
			label: 'Status',
			sortable: true,
			// Running rows sort before queued rows; any other status (a filtered
			// settled bucket) sorts after both — moot in practice, since a filtered
			// fetch returns one status only, but keeps the comparator total.
			sortKey: r => (r.status === 'running' ? 0 : r.status === 'queued' ? 1 : 2),
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
				// The wrap sink for the row: long paths break here so the action
				// buttons keep a single line (see .crucible-queue-target-cell).
				td.addClass('crucible-queue-target-cell');
				if (r.targetPath) {
					// Resolve the note TFile and render a clickable vault link.
					const file = host.app.vault.getAbstractFileByPath(r.targetPath);
					if (file instanceof TFile) {
						renderFileLink(host.app, td, file);
						return;
					}
					// WP-F3: `search_delete_path` targets a path that, by definition, no
					// longer resolves to a TFile (that's what makes it an orphan) — and a
					// `search_upsert_file` target can transiently vanish the same way. The
					// row previously fell through to `r.title`/job id here; render the raw
					// vault path instead — more useful than "De-index: <basename>", which
					// only repeats what the Type column already conveys, and scoped to these
					// two types so no other job type's Target cell behavior changes.
					if (r.type === 'search_upsert_file' || r.type === 'search_delete_path') {
						td.setText(r.targetPath);
						return;
					}
				}
				td.setText(r.title ?? r.key);
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
			// `r.created` is raw ISO for both sources (see the row-mapping comments above);
			// format for humans here, at render time, so the sort itself compares one format.
			sortKey: r => r.created,
			render: (r, td) => td.setText(r.created ? formatDateTime(Date.parse(r.created)) : ''),
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
				// untidy — it invites the wrong click. WP-DP3: row scope goes icon-only
				// (CC-11) — Run = play, Cancel = danger x, Details = info — and each
				// action renders only when it's valid for the row's status: a settled
				// (done/failed/cancelled) row is never re-run from here and can't be
				// cancelled; Details is unconditional, the one action every row supports.
				td.addClass('crucible-queue-action-cell');
				// Per-job Run: execute this one queued job now, ignoring the auto-run
				// gate (for "auto off / deep queue, run this one"). Running rows have no
				// Run — they're already in flight. Settled rows have no Run either — a
				// done/cancelled job re-running is not a queue operation.
				if (r.status === 'queued') {
					renderIconButton(td, 'play', {
						ariaLabel: 'Run',
						title: 'Run this job now, ignoring the auto-run gate.',
						onClick: btn => {
							void (async () => {
								btn.disabled = true;
								const outcome = await host.plugin.orchestrationAutoRunner?.runJob(r.type as JobType, r.key);
								// 'ran' ⇒ the row is gone, 'blocked' ⇒ it ran and came back deferred
								// because a dependency is down; both change the row, so refresh.
								// Otherwise (already claimed by a drain / no runner) leave the
								// button usable.
								if (outcome === 'ran' || outcome === 'blocked') await host.refresh('queueMonitor');
								else btn.disabled = false;
							})();
						},
					});
				}
				// Unconditional since thq WP-8: the one row source that used to be excluded
				// (in-memory enrichment entries, which carried no params/notes/failureKind)
				// is now an ordinary job with all three.
				renderIconButton(td, 'info', {
					ariaLabel: 'Details',
					title: 'Show this job\'s params, error, progress and notes.',
					onClick: () => new JobDetailModal(host.app, r).open(),
				});
				// Cancel only makes sense on a job still in the queue or in flight — a
				// settled row (done/failed/cancelled) has nothing left to stop.
				if (r.status === 'queued' || r.status === 'running') {
					renderCancelAction(host, td, r.type as JobType, r.key, r.status);
				}
			},
		},
	], rows, ctx, {
		limit: QUEUE_MONITOR_RENDER_LIMIT,
		// rsp-wp6: the job id is the natural stable key — one row per job. (It used to
		// be prefixed with the row's source to keep the file-queue and memory-queue id
		// spaces visually distinct; there is one id space now.)
		rowKey: r => r.key,
	});
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
		renderIconButton(td, 'x', {
			ariaLabel: 'Stopping',
			title: 'Stop requested. Cancellation is cooperative: the job stops at its next checkpoint, and any '
				+ 'request already in flight has to finish first.',
			cls: 'crucible-queue-cancel-btn',
			disabled: true,
		});
		return;
	}

	// mod-warning: Cancel destroys queued work or stops work in progress, and it sits
	// immediately beside Run. It carries the danger semantic for the same reason the
	// queue-wide Clear does — the two destructive controls in this view should read as
	// destructive at a glance, not only once the tooltip is open. WP-DP3: goes
	// icon-only (the `x` glyph) but keeps `mod-warning` — this is the one row action
	// that IS destructive-family styling, unlike intake's reversible Skip. `cls` adds
	// a queue-scoped hook (`crucible-queue-cancel-btn`, styles.css) rather than
	// relying on cascade order between .crucible-intake-icon-btn's transparent
	// background and Obsidian's own `button.mod-warning` fill — `renderIconButton`'s
	// `cls` option is a single class (DOM `addClass` rejects a space-separated
	// string), so `mod-warning` itself is applied separately on the returned button.
	const cancel = renderIconButton(td, 'x', {
		ariaLabel: 'Cancel',
		title: status === 'running'
			? 'Stop this job. It stops at its next checkpoint — a request already in flight finishes first — so a long job '
				+ 'can take a while to acknowledge.'
			: 'Drop this job from the queue before it runs.',
		cls: 'crucible-queue-cancel-btn',
		onClick: btn => {
			void (async () => {
				// clsl-WP-4: job-cancel is registered default-suppressed (preserves the documented
				// single-row-cancel policy above) — with default settings this resolves true without
				// showing a modal, and only prompts once a user has explicitly turned it on.
				if (!(await confirmDestructive(host.app, host.plugin.settings, 'job-cancel', {
					message: status === 'running'
						? 'Stop this running job? It stops at its next checkpoint.'
						: 'Remove this job from the queue before it runs?',
				}))) return;
				btn.disabled = true;
				btn.setAttr('aria-label', status === 'running' ? 'Stopping' : 'Cancelling');
				btn.title = status === 'running' ? 'Stopping…' : 'Cancelling…';
				const outcome = (await host.plugin.orchestrationAutoRunner?.stopJob(type, key)) ?? 'not-found';
				new Notice(STOP_OUTCOME_NOTICE[outcome]);
				await host.refresh('queueMonitor');
			})();
		},
	});
	cancel.addClass('mod-warning');
}
