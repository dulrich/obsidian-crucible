import { Notice } from 'obsidian';
import type CruciblePlugin from '../main';
import type { OrchestrationJob } from './types';
import { ConfirmModal } from '../confirmModal';

// Retroactive repair for the cohort a service outage leaves behind, plus the
// forward-looking classification `DbJobBackend.failEntry` stamps on every new
// failure.
//
// Context this exists for: one companion outage wrote 2,022 per-job failure files
// into the failed bucket (error text `ERR_CONNECTION_REFUSED`) before `ServiceHealthRegistry`
// (WP-2) existed to recognize a dependency outage as one event instead of N job
// failures. Those files are indistinguishable from a genuine failure except by their
// error text, so this module's whole job is to draw that line conservatively: an
// error text this doesn't recognize is `'genuine'`, never `'service-outage'` — a job
// requeued by mistake costs nothing (it just runs and, if the underlying problem
// persists, fails again and lands right back in failed), but a genuine failure
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
		rationale: 'youtubeApi.ts\'s generic HTTP passthrough on a 5xx. 403 (bad/missing key) is a separate, '
			+ 'more specific shape and is deliberately NOT matched. A video not-found (the 200 items:[] shape, or '
			+ 'the dead 404 branch) no longer reaches failed jobs at all as of WP-K1 — `ensureMetadataNote` catches '
			+ 'the typed `YoutubeVideoUnavailableError` and tombstones instead, settling the job `done`; only a '
			+ 'channel/playlist 404 (channel/uploads not found) can still land here as a genuine failure.',
	},
	{
		name: 'all-channel-feeds-failed',
		re: /^All \d+ channel feeds failed/,
		rationale: 'feedSources.ts\'s allFeedsFailedError for the YouTube tracker — every configured channel\'s '
			+ 'Data API playlistItems.list fetch failed in the same run, which reads as an upstream outage, not a '
			+ 'per-video problem. (A missing/unconfigured API key is excluded from this shape entirely — it fails '
			+ 'the job plainly, without the shared \'youtube-api\' breaker or this pattern\'s all-failed text.)',
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
	/** Every job currently failed, matched or not. */
	total: number;
	/** Count of service-outage matches, by job type. */
	byType: Record<string, number>;
	/** Count of jobs classified `'service-outage'` (and, on execute, actually moved). */
	requeued: number;
	/** Count of jobs classified `'genuine'` (left untouched in the failed bucket). */
	skipped: number;
}

/**
 * Scans the queue's failed bucket for service-outage failures and (unless `dryRun`)
 * requeues the matches. One `UPDATE … WHERE failure_kind = 'service'` on the column
 * `DbJobBackend.failEntry` already stamped at settle time — no re-classification pass,
 * where the markdown queue needed a per-file classify/clearError/move loop with an
 * event-loop yield every 20 entries to stay responsive over the 2,022-file cohort.
 * `classifyFailedJob` is still the single source of truth: it is what stamps
 * `failure_kind` in the first place.
 *
 * `dryRun: true` mutates nothing: no store writes, no emit. It exists so the command
 * and the queue-monitor button can show the breakdown in a `ConfirmModal` before
 * anything happens.
 *
 * Emits `orchestration-queue-updated` exactly once for the whole run (never per job —
 * see the bulk-emit invariant on `Orchestrator.clearQueued`), and kicks the autorunner
 * once afterward so the requeued jobs start draining immediately.
 */
export async function requeueServiceFailures(
	plugin: CruciblePlugin,
	{ dryRun }: { dryRun: boolean },
): Promise<RequeueBreakdown> {
	const result = plugin.orchestrator.requeueServiceOutageFailures(dryRun);
	const breakdown: RequeueBreakdown = {
		total: result.total,
		byType: result.byType,
		requeued: result.requeued,
		skipped: result.total - result.requeued,
	};

	if (!dryRun && breakdown.requeued > 0) {
		await plugin.orchestrator.emitQueueChangedNow();
		plugin.orchestrationAutoRunner?.kickAll();
	}

	return breakdown;
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
		+ `as a service outage (${formatByType(breakdown.byType)}) and will move back to queued with their recorded `
		+ `error cleared. ${breakdown.skipped} classified as genuine failure${breakdown.skipped === 1 ? '' : 's'} and `
		+ 'will stay failed, untouched. Unclassifiable text is always treated as genuine.';
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
		+ `${result.skipped} genuine failure${result.skipped === 1 ? '' : 's'} left failed.`);
	return result;
}
