import { Notice, TFile } from 'obsidian';
import { computeRowSignature, renderTableSection, shouldRepaint } from '../render/section';
import { renderIconButton } from '../render/cells';
import { formatDateTime } from '../render/format';
import { enqueueSearchRepairs, runSearchAudit, type SearchRepairTargets } from '../../search/auditRun';
import {
	formatReconcileCompletedSummary,
	formatReconcileNothingToDoSummary,
	isReconcileTargetClean,
	type ReconcileEnqueueSummaryInput,
	type SearchAuditResult,
} from '../../search/audit';
import type { DashboardHost, SectionContext } from '../render/types';

/**
 * WP-H4: the Ingestion-dashboard face of the WP-H3 audit/reconcile seam
 * (`src/search/auditRun.ts`, `src/search/audit.ts`) — a forced-trigger-only section (never
 * FAST_SECTIONS/SCAN_SECTIONS; see `ingestionDashboard.ts`'s membership sets) because the scan
 * itself reads/chunks every mtime-suspect and missing-candidate file plus a companion round trip,
 * which is expensive and unbounded on a cold index. The section never calls `runSearchAudit`
 * itself — only the header's Run-audit button does — so mounting/refreshing the dashboard can
 * never trigger a scan.
 *
 * State pattern lifted from the settings Search-health panel
 * (`src/settings/sections/orchestrationSearch.ts`'s `cachedSearchHealth`/renderBody): closure-
 * cached `{result, ranAt, error}`, refreshed only by an explicit button click, with the last
 * successful result surviving a later failed run (see the error branch below).
 *
 * `SearchAuditResult.imageCoverage` renders as a read-only neutral-pill summary row (v2 —
 * v1 omitted it; see `renderImageCoverageRow` for the no-render-time-gate rationale).
 */

type AuditClass = 'missing' | 'orphans' | 'stale' | 'mtimeOnly' | 'unindexable' | 'embeddingGaps';

// Order matches SearchAuditResult's field order (src/search/audit.ts:79-113).
const AUDIT_CLASSES: readonly AuditClass[] = ['missing', 'orphans', 'stale', 'mtimeOnly', 'unindexable', 'embeddingGaps'];
// The three classes reconcile can act on (search-reconcile-index's own scope) — everything else
// (mtimeOnly/unindexable: informational, no repair command; embeddingGaps: a different command
// family) is excluded from both the default combined table view and the "Repair all" bulk action.
const DEFECT_CLASSES: readonly AuditClass[] = ['missing', 'orphans', 'stale'];

const AUDIT_CLASS_LABELS: Record<AuditClass, string> = {
	missing: 'missing',
	orphans: 'orphans',
	stale: 'stale',
	mtimeOnly: 'mtime-only',
	unindexable: 'unindexable',
	embeddingGaps: 'embedding gaps',
};

interface SearchAuditRow {
	path: string;
	cls: AuditClass;
}

export interface SearchAuditSection {
	render(body: HTMLElement, ctx: SectionContext): void;
	renderRunAuditButton(heading: HTMLElement): void;
}

export function createSearchAuditSection(host: DashboardHost): SearchAuditSection {
	let result: SearchAuditResult | null = null;
	let ranAt: number | null = null;
	let error: string | null = null;
	let selectedClass: AuditClass | null = null;
	// Set true by any repair enqueue (single-row or bulk) so the meta line can say the cached
	// result no longer reflects the index — repair never re-runs the scan itself (out of scope;
	// the brief is explicit that this stays a manual, explicit action).
	let resultStale = false;

	function render(body: HTMLElement, ctx: SectionContext): void {
		if (error) {
			body.empty();
			const suffix = ranAt ? ` (last successful run: ${formatDateTime(ranAt)})` : '';
			body.createDiv({ cls: 'crucible-empty-state', text: `Search audit unavailable: ${error}${suffix}` });
			host.setSectionCount('searchAudit', 0);
			host.setSectionMeta('searchAudit', '');
			return;
		}
		if (!result) {
			body.empty();
			body.createDiv({ cls: 'crucible-empty-state', text: 'Not run yet — click Run audit.' });
			host.setSectionCount('searchAudit', 0);
			host.setSectionMeta('searchAudit', '');
			return;
		}

		// Compute before touching the DOM (root AGENTS.md law) — cheap here (array slicing over
		// already-computed result arrays), but the ordering rule holds regardless.
		const currentResult = result;
		const rows = buildRows(currentResult, selectedClass);
		const signature = computeRowSignature(rows, { ranAt, error, selectedClass, resultStale });
		if (!shouldRepaint(ctx, signature)) return;

		body.empty();

		const statsRow = body.createDiv({ cls: 'crucible-queue-stats-row' });
		renderAuditFilterBar(statsRow, currentResult, selectedClass, cls => {
			selectedClass = selectedClass === cls ? null : cls;
			void ctx.refresh();
		});

		renderImageCoverageRow(body, currentResult);

		const bulkRow = body.createDiv({ cls: 'crucible-ingestion-queue-controls' });
		renderBulkRepairButton(host, bulkRow, () => result, () => {
			resultStale = true;
			void ctx.refresh();
		});

		const tableContainer = body.createDiv();
		renderTableSection<SearchAuditRow>({
			body: tableContainer,
			ctx,
			rows,
			emptyText: selectedClass ? `No ${AUDIT_CLASS_LABELS[selectedClass]} paths.` : 'No affected paths.',
			setCount: () => { /* the header count is the stable defect total, set below — not the filtered row count. */ },
			columns: [
				{ key: 'path', label: 'Path', sortable: true, sortKey: r => r.path.toLowerCase(), render: (r, td) => td.setText(r.path) },
				{ key: 'class', label: 'Class', sortable: true, sortKey: r => r.cls, render: (r, td) => td.setText(AUDIT_CLASS_LABELS[r.cls]) },
				{
					key: 'action', label: '', render: (r, td) => {
						td.addClass('crucible-intake-action-cell');
						renderOpenNoteButton(host, td, r);
						renderRowRepairButton(host, td, r, () => {
							resultStale = true;
							void ctx.refresh();
						});
					},
				},
			],
		});

		const totalAffected = DEFECT_CLASSES.reduce((sum, cls) => sum + currentResult[cls].length, 0);
		host.setSectionCount('searchAudit', totalAffected);
		const metaParts = [`as of ${formatDateTime(ranAt ?? Date.now())}`];
		if (resultStale) metaParts.push('stale — re-run audit to refresh');
		host.setSectionMeta('searchAudit', metaParts.join(' · '));
	}

	function renderRunAuditButton(heading: HTMLElement): void {
		const btn = heading.createEl('button', { text: 'Run audit', cls: 'crucible-ingestion-run-audit' });
		btn.addEventListener('click', () => {
			void (async () => {
				btn.disabled = true;
				btn.setText('Running…');
				if (!host.plugin.settings.searchEnabled) {
					error = 'search indexing is disabled (Settings → Orchestrate → Search → Enabled).';
				} else {
					try {
						result = await runSearchAudit(host.plugin);
						ranAt = Date.now();
						resultStale = false;
						error = null;
					} catch (e) {
						// Companion-down (SearchServiceUnavailableError) and any other failure both land
						// here — the last-known `result`/`ranAt` are deliberately left untouched (see the
						// error branch in render() above), only `error` changes.
						error = e instanceof Error ? e.message : String(e);
					}
				}
				btn.disabled = false;
				btn.setText('Run audit');
				void host.refresh('searchAudit');
			})();
		});
	}

	return { render, renderRunAuditButton };
}

function buildRows(result: SearchAuditResult, selectedClass: AuditClass | null): SearchAuditRow[] {
	const classes: readonly AuditClass[] = selectedClass ? [selectedClass] : DEFECT_CLASSES;
	const rows: SearchAuditRow[] = [];
	for (const cls of classes) {
		for (const path of result[cls]) rows.push({ path, cls });
	}
	return rows;
}

// Modeled on renderQueueFilterBar (queueMonitor.ts:190-215): clickable .crucible-pill buttons,
// is-contrast when active, aria-pressed + title, click-again-to-clear toggle. Hues restricted to
// the three genuine defect classes (missing/orphans/stale) per root AGENTS.md's pill-taxonomy
// law — mtimeOnly/unindexable/embeddingGaps are informational or not reconcile-actionable from
// here, so they stay neutral even when non-zero (spending a status hue on a non-actionable fact
// spends the reader's alarm budget on nothing).
function renderAuditFilterBar(
	container: HTMLElement,
	result: SearchAuditResult,
	active: AuditClass | null,
	onSelect: (cls: AuditClass) => void,
): void {
	container.empty();
	for (const cls of AUDIT_CLASSES) {
		const n = result[cls].length;
		const isActive = active === cls;
		const label = AUDIT_CLASS_LABELS[cls];
		let pillCls = 'crucible-pill';
		if (isActive) pillCls += ' is-contrast';
		else if (DEFECT_CLASSES.includes(cls) && n > 0) pillCls += cls === 'stale' ? ' is-warn' : ' is-error';
		else pillCls += ' is-muted';
		const btn = container.createEl('button', { cls: pillCls, text: `${label} ${n}` });
		btn.setAttr('aria-pressed', String(isActive));
		btn.setAttr('aria-label', `Filter to ${label} paths`);
		btn.title = isActive
			? `Showing ${label} paths only — click again to go back to the default view.`
			: `Show only ${label} paths.`;
		btn.addEventListener('click', () => onSelect(cls));
	}
}

// Image-coverage summary (v2 follow-up to the WP-H4 v1 omission): the four counts
// `runSearchAudit` already computed at scan time (`gatherSearchAuditImages` reads
// `metadataCache.resolvedLinks` when the audit runs, so there is nothing to gate at render
// time — the numbers are frozen into the cached result, same as the report note's "Image
// coverage" line). Read-only span pills, all neutral: none of the four is actionable from this
// section (pending belongs to the image-describe backfill, failed is a deliberate durable
// skip), so per the pill-taxonomy law they never spend a status hue.
function renderImageCoverageRow(body: HTMLElement, result: SearchAuditResult): void {
	const row = body.createDiv({ cls: 'crucible-queue-stats-row' });
	const c = result.imageCoverage;
	const pills: Array<{ text: string; title: string }> = [
		{ text: `images referenced ${c.referenced}`, title: 'Images referenced by a resolved link anywhere in the vault, as of this audit run.' },
		{ text: `described ${c.described}`, title: 'Referenced images with a description record.' },
		{ text: `failed ${c.failed}`, title: 'Durable failed records — the image-describe backfill will not retry these.' },
		{ text: `pending ${c.pending}`, title: 'Referenced but neither described nor failed — the image-describe backfill’s work queue.' },
	];
	for (const p of pills) {
		const span = row.createSpan({ cls: 'crucible-pill is-muted', text: p.text });
		span.title = p.title;
	}
}

// arrow-right = open note (row scope, per root AGENTS.md's icon table). Orphan rows are
// muted/disabled unconditionally — the path is, by definition, no longer in the vault — and any
// other class whose path fails to resolve (a race between the scan and a later delete/move)
// degrades the same way rather than throwing.
function renderOpenNoteButton(host: DashboardHost, td: HTMLElement, row: SearchAuditRow): void {
	if (row.cls === 'orphans') {
		renderIconButton(td, 'arrow-right', { ariaLabel: 'Open note', title: 'Orphaned — this path no longer exists in the vault.', disabled: true });
		return;
	}
	const file = host.app.vault.getAbstractFileByPath(row.path);
	if (!(file instanceof TFile)) {
		renderIconButton(td, 'arrow-right', { ariaLabel: 'Open note', title: 'Note not found in the vault.', disabled: true });
		return;
	}
	renderIconButton(td, 'arrow-right', {
		ariaLabel: 'Open note',
		title: 'Open note',
		onClick: () => { void host.app.workspace.openLinkText(file.path, '', false); },
	});
}

// wrench = Repair (new row in root AGENTS.md's icon table, this WP). missing/stale enqueue a
// search_upsert_file job for the one path; orphans enqueue a search_delete_path job (the
// confirm-gate for orphan deletion lives inside enqueueSearchRepairs — see src/search/auditRun.ts
// — so it fires here exactly as it does from the bulk button and the reconcile command).
// mtimeOnly/unindexable/embeddingGaps render muted per the brief's per-class titles — "muted,
// never absent" (root AGENTS.md).
function renderRowRepairButton(host: DashboardHost, td: HTMLElement, row: SearchAuditRow, onRepaired: () => void): void {
	if (row.cls === 'mtimeOnly') {
		renderIconButton(td, 'wrench', { ariaLabel: 'Repair', title: 'Nothing to repair — index is current (mtime-only drift).', disabled: true });
		return;
	}
	if (row.cls === 'unindexable') {
		renderIconButton(td, 'wrench', { ariaLabel: 'Repair', title: 'No indexable content (frontmatter-only note).', disabled: true });
		return;
	}
	if (row.cls === 'embeddingGaps') {
		renderIconButton(td, 'wrench', {
			ariaLabel: 'Repair',
			title: 'Run "Search: embed missing vectors" to fix embedding gaps — a different command family, not enqueued from here.',
			disabled: true,
		});
		return;
	}
	const targets: SearchRepairTargets = row.cls === 'orphans'
		? { upsertPaths: [], orphanPaths: [row.path] }
		: { upsertPaths: [row.path], orphanPaths: [] };
	renderIconButton(td, 'wrench', {
		ariaLabel: 'Repair',
		title: row.cls === 'orphans'
			? 'Delete this orphaned path from the search index (confirm required).'
			: 'Enqueue a re-index job for this path.',
		onClick: btn => {
			void (async () => {
				btn.disabled = true;
				try {
					const outcome = await enqueueSearchRepairs(host.plugin, targets);
					new Notice(singleRepairNotice(outcome));
					if (!outcome.orphansDeclined) onRepaired();
				} catch (e) {
					new Notice(`Repair failed: ${e instanceof Error ? e.message : String(e)}`);
				} finally {
					btn.disabled = false;
				}
			})();
		},
	});
}

function singleRepairNotice(outcome: ReconcileEnqueueSummaryInput): string {
	if (outcome.orphansDeclined) return 'Repair: orphan deletion declined.';
	const parts: string[] = [];
	if (outcome.upserts.newCount + outcome.upserts.dedupedCount > 0) {
		parts.push(`upsert ${outcome.upserts.newCount} new${outcome.upserts.dedupedCount > 0 ? ` (+${outcome.upserts.dedupedCount} already queued)` : ''}`);
	}
	if (outcome.deletes.newCount + outcome.deletes.dedupedCount > 0) {
		parts.push(`delete ${outcome.deletes.newCount} new${outcome.deletes.dedupedCount > 0 ? ` (+${outcome.deletes.dedupedCount} already queued)` : ''}`);
	}
	if (parts.length === 0) return 'Repair: nothing enqueued.';
	return `Repair: ${parts.join('; ')}. Re-run the search audit to refresh — this result is now stale.`;
}

// Per-class bulk repair (brief: "reading the cached full result, never the rendered table" — the
// 200-row `DEFAULT_TABLE_ROW_LIMIT` cap the table itself may be showing). Reuses
// `enqueueSearchRepairs`/`isReconcileTargetClean`/`formatReconcile*Summary` verbatim — the exact
// shape `search-reconcile-index` already uses, so a bulk repair from here can never disagree with
// what the command would enqueue for the same result.
function renderBulkRepairButton(
	host: DashboardHost,
	container: HTMLElement,
	getResult: () => SearchAuditResult | null,
	onRepaired: () => void,
): void {
	const btn = container.createEl('button', { text: 'Repair all' });
	btn.addEventListener('click', () => {
		void (async () => {
			const result = getResult();
			if (!result) {
				new Notice('Run the search audit first.');
				return;
			}
			if (isReconcileTargetClean(result)) {
				new Notice(formatReconcileNothingToDoSummary(result));
				return;
			}
			btn.disabled = true;
			try {
				const outcome = await enqueueSearchRepairs(host.plugin, {
					upsertPaths: [...result.missing, ...result.stale],
					orphanPaths: result.orphans,
				});
				new Notice(formatReconcileCompletedSummary(result, outcome));
				onRepaired();
			} catch (e) {
				new Notice(`Repair failed: ${e instanceof Error ? e.message : String(e)}`);
			} finally {
				btn.disabled = false;
			}
		})();
	});
}
