import { Notice } from 'obsidian';
import type CruciblePlugin from '../main';
import type { OrchestrationJob } from './types';
import { logError } from '../log';
import { ConfirmModal } from '../confirmModal';

// Retroactive repair for the cohort a service outage leaves behind, plus the
// forward-looking classification `FileJobBackend.failEntry` stamps on every new
// failure.
//
// Context this exists for: one companion outage wrote 2,022 per-job failure files
// into `failed/` (error text `ERR_CONNECTION_REFUSED`) before `ServiceHealthRegistry`
// (WP-2) existed to recognize a dependency outage as one event instead of N job
// failures. Those files are indistinguishable from a genuine failure except by their
// error text, so this module's whole job is to draw that line conservatively: an
// error text this doesn't recognize is `'genuine'`, never `'service-outage'` — a job
// requeued by mistake costs nothing (it just runs and, if the underlying problem
// persists, fails again and lands right back in `failed/`), but a genuine failure
// swept up by an overbroad pattern loses the diagnostic and silently retries
// something that was never going to succeed.

export type FailedJobClassification = 'service-outage' | 'genuine';

export interface FailurePattern {
	name: string;
	re: RegExp;
	rationale: string;
}

/**
 * Conservative, allowlist-only pattern table. Every pattern here was written against
 * an exact message shape a specific code path produces (cited in `rationale`) — this
 * is deliberately not a broad "sounds like an outage" heuristic, because a broad one
 * is exactly how a genuine failure (a bad API key, a 404, a cancellation) gets swept
 * into a bulk requeue that never tells anyone it happened.
 */
export const SERVICE_OUTAGE_PATTERNS: FailurePattern[] = [
	{
		name: 'connection-refused',
		re: /ERR_CONNECTION_REFUSED|ECONNREFUSED/i,
		rationale: 'Nothing was listening on the port — the unambiguous shape, and the one that wrote the '
			+ '2,022-file cohort this tool exists for (Chromium `net::` and Node `ECONNREFUSED` both land here).',
	},
	{
		name: 'companion-unreachable',
		re: /search (service|companion)[\s\S]{0,200}?(not reachable|unreachable)/i,
		rationale: 'SearchIndexWorkflow\'s "Search companion not reachable at <url>…" fallback and '
			+ 'client.ts\'s "Search service <path> unreachable: …" wrap — both mean the companion never answered.',
	},
	{
		name: 'companion-5xx',
		re: /search service[\s\S]{0,200}?returned 5\d\d/i,
		rationale: 'client.ts\'s "Search service <path> returned <status>: …" with a 5xx status — the companion '
			+ 'answered but was unhealthy. A 4xx here is a real client-side bug and is deliberately NOT matched.',
	},
	{
		name: 'youtube-quota',
		re: /YouTube Data API: quota exceeded/i,
		rationale: 'youtubeApi.ts\'s quota-exceeded throw — the API told us to back off, not a bug in the job.',
	},
	{
		name: 'youtube-5xx',
		re: /YouTube Data API: HTTP 5\d\d/i,
		rationale: 'youtubeApi.ts\'s generic HTTP passthrough on a 5xx. 403 (bad/missing key) and 404 '
			+ '(video/channel not found) are separate, more specific shapes and are deliberately NOT matched.',
	},
	{
		name: 'all-channel-feeds-failed',
		re: /^All \d+ channel feeds failed/,
		rationale: 'feedSources.ts\'s allFeedsFailedError for the YouTube tracker — every configured channel\'s '
			+ 'RSS feed failed in the same run, which reads as a network/DNS-level outage, not a per-video problem.',
	},
];

/**
 * Classifies a failed job's error text against the pattern table above. Unknown text
 * is `'genuine'` — never requeue what can't be matched to a known outage shape.
 *
 * `job` is accepted (rather than classifying on `errorText` alone) so a future,
 * more targeted rule can key on `job.type`; nothing here uses it yet.
 */
export function classifyFailedJob(_job: Pick<OrchestrationJob, 'type'>, errorText: string | undefined): FailedJobClassification {
	if (!errorText) return 'genuine';
	for (const pattern of SERVICE_OUTAGE_PATTERNS) {
		if (pattern.re.test(errorText)) return 'service-outage';
	}
	return 'genuine';
}

export interface RequeueBreakdown {
	/** Every job currently in `failed/`, matched or not. */
	total: number;
	/** Count of service-outage matches, by job type. */
	byType: Record<string, number>;
	/** Count of jobs classified `'service-outage'` (and, on execute, actually moved). */
	requeued: number;
	/** Count of jobs classified `'genuine'` (left untouched in `failed/`). */
	skipped: number;
}

function yieldToEventLoop(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * The FILE arm: scans `failed/`, classifies every entry, and (unless `dryRun`) moves
 * the service-outage matches back to `queued/` — clearing their recorded error first
 * so a requeued job doesn't carry the prior run's diagnostic. Per-file loop, exactly
 * as before WP-7 — file types are deleted in WP-8, not here, so this isn't rewritten
 * onto anything new. No emit of its own: `requeueServiceFailures` below emits once for
 * the combined file+db result.
 */
async function requeueServiceFailuresFile(
	plugin: CruciblePlugin,
	dryRun: boolean,
): Promise<RequeueBreakdown> {
	const store = plugin.jobStore;
	await store.ensureFolders();
	const failed = await store.listFolder('failed');

	const byType: Record<string, number> = {};
	let requeued = 0;
	let skipped = 0;
	let processed = 0;

	for (const entry of failed) {
		const classification = classifyFailedJob(entry.job, entry.job.error);
		if (classification !== 'service-outage') {
			skipped++;
			processed++;
			if (processed % 20 === 0) await yieldToEventLoop();
			continue;
		}

		byType[entry.job.type] = (byType[entry.job.type] ?? 0) + 1;
		requeued++;

		if (!dryRun) {
			try {
				await store.clearError(entry.file);
				await store.move(entry.file, entry.job, 'queued');
			} catch (err) {
				// One job the store refused to move must not abort the run for the
				// thousands behind it — leave it in failed/ (JobStore.move rolls its own
				// rename back on failure) and count it honestly rather than as requeued.
				logError(`failedJobRepair: could not requeue ${entry.job.id}; leaving it in failed/`, err);
				requeued--;
				skipped++;
				const remaining = (byType[entry.job.type] ?? 1) - 1;
				if (remaining <= 0) delete byType[entry.job.type];
				else byType[entry.job.type] = remaining;
			}
		}

		processed++;
		if (processed % 20 === 0) await yieldToEventLoop();
	}

	return { total: failed.length, byType, requeued, skipped };
}

function mergeByTypeCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
	const out: Record<string, number> = { ...a };
	for (const [type, count] of Object.entries(b)) out[type] = (out[type] ?? 0) + count;
	return out;
}

/**
 * Scans BOTH the file queue's `failed/` and (once a `db` type exists) the jobs DB for
 * service-outage failures, and (unless `dryRun`) requeues the matches back to
 * `queued`. Backend-dispatched (WP-7): the file arm is the per-file loop above,
 * unchanged since before this WP; the db arm is `Orchestrator.requeueServiceOutageDbFailures`
 * — one `UPDATE … WHERE failure_kind = 'service'` selecting on the column
 * `DbJobBackend.failEntry` already stamped at settle time, no re-classification
 * needed. `classifyFailedJob` stays the single source of truth either way: it is what
 * stamps `failure_kind` in the first place, and it's still what the file arm runs
 * fresh against `error` text (file jobs have no `failure_kind` column).
 *
 * `dryRun: true` mutates nothing: no store writes, no emit. It exists so the command
 * and the queue-monitor button can show the breakdown in a `ConfirmModal` before
 * anything happens.
 *
 * Emits `orchestration-queue-updated` exactly once for the whole run, through the
 * combined file+db counts provider (never per job, never file-only once a db type
 * exists — see the bulk-emit invariant on `Orchestrator.clearQueued`), and kicks the
 * autorunner once afterward so the requeued jobs start draining immediately.
 */
export async function requeueServiceFailures(
	plugin: CruciblePlugin,
	{ dryRun }: { dryRun: boolean },
): Promise<RequeueBreakdown> {
	const fileResult = await requeueServiceFailuresFile(plugin, dryRun);
	const dbResult = plugin.orchestrator.requeueServiceOutageDbFailures(dryRun);

	const merged: RequeueBreakdown = {
		total: fileResult.total + dbResult.total,
		byType: mergeByTypeCounts(fileResult.byType, dbResult.byType),
		requeued: fileResult.requeued + dbResult.requeued,
		skipped: fileResult.skipped + (dbResult.total - dbResult.requeued),
	};

	if (!dryRun && merged.requeued > 0) {
		await plugin.orchestrator.emitQueueChangedNow();
		plugin.orchestrationAutoRunner?.kickAll();
	}

	return merged;
}

function formatByType(byType: Record<string, number>): string {
	const parts = Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([type, count]) => `${type} ${count}`);
	return parts.length > 0 ? parts.join(', ') : 'none';
}

function requeueConfirmMessage(breakdown: RequeueBreakdown): string {
	if (breakdown.requeued === 0) {
		return `${breakdown.total} failed job${breakdown.total === 1 ? '' : 's'} scanned; none matched a known `
			+ 'service-outage pattern, so there is nothing to requeue.';
	}
	return `${breakdown.total} failed job${breakdown.total === 1 ? '' : 's'} scanned: ${breakdown.requeued} classified `
		+ `as a service outage (${formatByType(breakdown.byType)}) and will move back to queued/ with their recorded `
		+ `error cleared. ${breakdown.skipped} classified as genuine failure${breakdown.skipped === 1 ? '' : 's'} and `
		+ 'will stay in failed/ untouched. Unclassifiable text is always treated as genuine.';
}

/**
 * The one confirm-and-requeue flow, shared by the `Orchestrate: Requeue
 * service-outage failures` command and the queue-monitor button so the two surfaces
 * can never drift: dry-run, show the breakdown in a `ConfirmModal`, execute on
 * confirm, Notice the result. Not destructive (a requeued job just runs again — see
 * `RequeueBreakdown`'s doc), so the modal uses the plain confirm styling, not the
 * warning one.
 *
 * Returns the executed breakdown, the dry-run breakdown when there was nothing to
 * requeue (no modal shown), or `null` if the user cancelled.
 */
export async function runServiceOutageRequeueFlow(plugin: CruciblePlugin): Promise<RequeueBreakdown | null> {
	const preview = await requeueServiceFailures(plugin, { dryRun: true });
	if (preview.requeued === 0) {
		new Notice(`Orchestrate: ${preview.total} failed job${preview.total === 1 ? '' : 's'} scanned; none matched `
			+ 'a known service-outage pattern.');
		return preview;
	}

	const confirmed = await new ConfirmModal(plugin.app, {
		title: 'Requeue service-outage failures?',
		message: requeueConfirmMessage(preview),
		confirmText: 'Requeue',
	}).openAndAwait();
	if (!confirmed) return null;

	const result = await requeueServiceFailures(plugin, { dryRun: false });
	new Notice(`Orchestrate: requeued ${result.requeued} job${result.requeued === 1 ? '' : 's'}; `
		+ `${result.skipped} genuine failure${result.skipped === 1 ? '' : 's'} left in failed/.`);
	return result;
}
