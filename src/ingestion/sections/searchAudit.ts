import { Notice, setIcon, TFile } from 'obsidian';
import { computeRowSignature, renderTableSection, shouldRepaint } from '../render/section';
import { renderIconButton } from '../render/cells';
import { formatDateTime } from '../render/format';
import {
	confirmAndQueueImageDescribeBackfill,
	enqueueEmbedMissing,
	enqueueSearchRepairs,
	retryFailedImageDescriptions,
	runSearchAudit,
	type SearchRepairTargets,
} from '../../search/auditRun';
import { type ReconcileEnqueueSummaryInput, type SearchAuditResult } from '../../search/audit';
import type { DashboardHost, SectionContext } from '../render/types';

/**
 * WP-I2: the Ingestion-dashboard face of the WP-H3/I1 audit/reconcile seam (`src/search/
 * auditRun.ts`, `src/search/audit.ts`) — a forced-trigger-only section (never FAST_SECTIONS/
 * SCAN_SECTIONS; see `ingestionDashboard.ts`'s membership sets) because the scan itself reads/
 * chunks every mtime-suspect and missing-candidate file plus a companion round trip, which is
 * expensive and unbounded on a cold index. The section never calls `runSearchAudit` itself —
 * only the header's Run-audit button does — so mounting/refreshing the dashboard can never
 * trigger a scan.
 *
 * Layout (WP-I2 redesign, replacing WP-H4's pill filter bar + image-coverage pill row + "Repair
 * all" button): ONE merged Summary/Repair statistics table mirroring the report's Summary
 * section (`formatAuditReport`, `src/search/audit.ts`) — nine fixed rows (the six path classes,
 * images pending, images failed, and an informational images-described row), each with a count
 * and a per-class wrench action (hidden entirely when its count is 0 — a user-locked deviation
 * from the fleet's muted-never-absent law, scoped to this summary table only; the paths table
 * below keeps the ordinary muted-wrench treatment). Clicking a non-zero row (anywhere but its
 * action button) filters the paths table to that class, including the two image classes;
 * clicking the active row again restores the default missing+orphans+stale view.
 *
 * State pattern lifted from the settings Search-health panel
 * (`src/settings/sections/orchestrationSearch.ts`'s `cachedSearchHealth`/renderBody): closure-
 * cached `{result, ranAt, error}`, refreshed only by an explicit button click, with the last
 * successful result surviving a later failed run (see the error branch below).
 */

type NoteClass = 'missing' | 'orphans' | 'stale' | 'mtimeOnly' | 'unindexable' | 'embeddingGaps';
type ImageClass = 'imagePending' | 'imageFailed';
type AuditClass = NoteClass | ImageClass;
type SummaryKey = AuditClass | 'imagesDescribed';

// The three classes reconcile can act on (search-reconcile-index's own scope) — drives the
// default (no filter) paths-table view and the header's honest total count. Everything else
// (mtimeOnly/unindexable: informational, embeddingGaps/images: their own command families) is
// excluded from the default combined view, same as WP-H4.
const DEFECT_CLASSES: readonly NoteClass[] = ['missing', 'orphans', 'stale'];

// Fixed row order for the merged Summary/Repair table — mirrors formatAuditReport's Summary
// section (src/search/audit.ts:296-304) so the dashboard and the report note never disagree
// about what the nine lines are or what order they read in.
const SUMMARY_ORDER: readonly SummaryKey[] = [
	'missing', 'orphans', 'stale', 'mtimeOnly', 'unindexable', 'embeddingGaps', 'imagePending', 'imageFailed', 'imagesDescribed',
];

const SUMMARY_LABELS: Record<SummaryKey, string> = {
	missing: 'Missing (in vault, not indexed)',
	orphans: 'Orphans (indexed, not in vault)',
	stale: 'Stale (vault newer, content changed)',
	mtimeOnly: 'Mtime-only (unchanged content — index is current)',
	unindexable: 'Unindexable (no indexable content)',
	embeddingGaps: 'Embedding gaps (embedded < chunks)',
	imagePending: 'Images pending',
	imageFailed: 'Images failed',
	imagesDescribed: 'Images described (informational)',
};

// Short filter-noun used in the paths table's Class column and the summary row's clickable
// title — the "images pending"/"images failed" wording WP-I2 adds for the two new classes.
const AUDIT_CLASS_LABELS: Record<AuditClass, string> = {
	missing: 'missing',
	orphans: 'orphans',
	stale: 'stale',
	mtimeOnly: 'mtime-only',
	unindexable: 'unindexable',
	embeddingGaps: 'embedding gaps',
	imagePending: 'images pending',
	imageFailed: 'images failed',
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
	// Set true by any repair enqueue (a single summary-row action) so the meta line can say the
	// cached result no longer reflects the index — repair never re-runs the scan itself (out of
	// scope; the brief is explicit that this stays a manual, explicit action).
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

		const summaryContainer = body.createDiv();
		renderAuditSummaryTable(summaryContainer, host, currentResult, selectedClass, cls => {
			selectedClass = selectedClass === cls ? null : cls;
			void ctx.refresh();
		}, () => {
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
		// WP-I2: icon-label chrome (matches buildSection's Refresh button, ingestionDashboard.ts)
		// so "Run audit" sits inline with Refresh instead of reading as a differently-styled
		// outlier — the header's flex-wrap can now keep both on one line once the section
		// description is short (see ingestionDashboard.ts's searchAudit registration).
		const btn = heading.createEl('button', { cls: 'crucible-ingestion-run-audit crucible-icon-label-btn' });
		paintRunAuditButton(btn, false);
		btn.addEventListener('click', () => {
			void (async () => {
				btn.disabled = true;
				paintRunAuditButton(btn, true);
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
				paintRunAuditButton(btn, false);
				void host.refresh('searchAudit');
			})();
		});
	}

	return { render, renderRunAuditButton };
}

function paintRunAuditButton(btn: HTMLButtonElement, running: boolean): void {
	btn.empty();
	setIcon(btn, 'play');
	btn.createSpan({ text: running ? 'Running…' : 'Run audit' });
}

function buildRows(result: SearchAuditResult, selectedClass: AuditClass | null): SearchAuditRow[] {
	if (selectedClass === null) {
		const rows: SearchAuditRow[] = [];
		for (const cls of DEFECT_CLASSES) for (const path of result[cls]) rows.push({ path, cls });
		return rows;
	}
	if (selectedClass === 'imagePending') return result.imageCoverage.pendingPaths.map(path => ({ path, cls: selectedClass }));
	if (selectedClass === 'imageFailed') return result.imageCoverage.failedPaths.map(path => ({ path, cls: selectedClass }));
	return result[selectedClass].map(path => ({ path, cls: selectedClass }));
}

function summaryCount(result: SearchAuditResult, key: SummaryKey): number {
	if (key === 'imagePending') return result.imageCoverage.pending;
	if (key === 'imageFailed') return result.imageCoverage.failed;
	if (key === 'imagesDescribed') return result.imageCoverage.described;
	return result[key].length;
}

function formatSummaryCount(result: SearchAuditResult, key: SummaryKey): string {
	if (key === 'imagesDescribed') return `${result.imageCoverage.described} / ${result.imageCoverage.referenced}`;
	return String(summaryCount(result, key));
}

// WP-I2: the merged Summary/Repair statistics table replacing WP-H4's pill bar + image-coverage
// pill row + "Repair all" button. Nine fixed rows in SUMMARY_ORDER, each with a count and one
// action cell. Every non-informational row (all eight AuditClass keys, including mtimeOnly/
// unindexable — clickable for their filtering value even though they carry no repair action) is
// clickable when its count is > 0; only the informational "images described" row is never
// clickable, at any count. The condition label renders as a real <button> only when the row is
// clickable, so keyboard focus/Enter/Space work natively without an ARIA role hack on the <tr> —
// the click handler itself lives on the <tr> (real-DOM click bubbling carries a button click up
// to it), guarded so a click landing in the action cell never also toggles the filter.
function renderAuditSummaryTable(
	container: HTMLElement,
	host: DashboardHost,
	result: SearchAuditResult,
	selectedClass: AuditClass | null,
	onSelect: (cls: AuditClass) => void,
	onRepaired: () => void,
): void {
	container.empty();
	const table = container.createEl('table', { cls: 'crucible-ingestion-table crucible-audit-summary-table' });
	const thead = table.createEl('thead');
	const headerRow = thead.createEl('tr');
	headerRow.createEl('th', { text: 'Condition' });
	headerRow.createEl('th', { text: 'Count', cls: 'crucible-audit-summary-count' });
	headerRow.createEl('th', { text: '' });
	const tbody = table.createEl('tbody');

	for (const key of SUMMARY_ORDER) {
		const count = summaryCount(result, key);
		const clickable = key !== 'imagesDescribed' && count > 0;
		const isActive = clickable && selectedClass === key;

		const tr = tbody.createEl('tr');
		if (clickable) tr.addClass('crucible-audit-row-clickable');
		if (isActive) tr.addClass('crucible-audit-row-active');

		const labelTd = tr.createEl('td');
		if (clickable) {
			const label = AUDIT_CLASS_LABELS[key];
			const btn = labelTd.createEl('button', { cls: 'crucible-audit-condition-btn', text: SUMMARY_LABELS[key] });
			btn.setAttr('aria-pressed', String(isActive));
			btn.title = isActive
				? `Showing ${label} paths only — click again to return to the default view.`
				: `Filter the table below to ${label} paths.`;
		} else {
			labelTd.setText(SUMMARY_LABELS[key]);
		}

		const countTd = tr.createEl('td', { cls: 'crucible-audit-summary-count' });
		countTd.setText(formatSummaryCount(result, key));

		const actionTd = tr.createEl('td');
		actionTd.addClass('crucible-intake-action-cell');
		renderSummaryAction(actionTd, host, key, result, count, onRepaired);

		if (clickable) {
			tr.addEventListener('click', evt => {
				const target = evt.target as HTMLElement;
				if (target.closest('.crucible-intake-action-cell')) return;
				onSelect(key);
			});
		}
	}
}

// Per-row action for the summary table. mtimeOnly/unindexable always read "no action needed"
// (their permanent informational state, regardless of count); the images-described row always
// reads "—" (a ratio, not a state — see wp-i2-report.md for why this reads differently from "no
// action needed"). Every other row's wrench is HIDDEN ENTIRELY when its count is 0 — the
// user-locked deviation from "muted, never absent" that's scoped to this table only (root
// AGENTS.md); the paths table below keeps the ordinary muted-wrench law.
function renderSummaryAction(
	td: HTMLElement,
	host: DashboardHost,
	key: SummaryKey,
	result: SearchAuditResult,
	count: number,
	onRepaired: () => void,
): void {
	if (key === 'mtimeOnly' || key === 'unindexable') {
		td.setText('No action needed');
		return;
	}
	if (key === 'imagesDescribed') {
		td.setText('—');
		return;
	}
	if (count === 0) return;

	const plural = count === 1 ? '' : 's';

	if (key === 'missing' || key === 'stale') {
		const paths = key === 'missing' ? result.missing : result.stale;
		renderIconButton(td, 'wrench', {
			ariaLabel: 'Repair',
			title: `Enqueue re-index jobs for ${count} ${AUDIT_CLASS_LABELS[key]} path${plural}.`,
			onClick: btn => void runReconcileAction(btn, host, { upsertPaths: paths, orphanPaths: [] }, onRepaired),
		});
		return;
	}
	if (key === 'orphans') {
		renderIconButton(td, 'wrench', {
			ariaLabel: 'Repair',
			title: `Delete ${count} orphaned path${plural} from the search index (confirm required).`,
			onClick: btn => void runReconcileAction(btn, host, { upsertPaths: [], orphanPaths: result.orphans }, onRepaired),
		});
		return;
	}
	if (key === 'embeddingGaps') {
		renderIconButton(td, 'wrench', {
			ariaLabel: 'Repair',
			title: `Run "Search: embed missing vectors" for ${count} embedding gap${plural}.`,
			onClick: btn => {
				void (async () => {
					btn.disabled = true;
					try {
						await enqueueEmbedMissing(host.plugin);
						new Notice('Search: embed missing vectors — enqueued.');
						onRepaired();
					} catch (e) {
						new Notice(`Repair failed: ${e instanceof Error ? e.message : String(e)}`);
					} finally {
						btn.disabled = false;
					}
				})();
			},
		});
		return;
	}
	if (key === 'imagePending') {
		renderIconButton(td, 'wrench', {
			ariaLabel: 'Repair',
			title: `Queue the image-describe backfill for ${count} pending image${plural} (confirm dialog follows).`,
			onClick: btn => {
				void (async () => {
					btn.disabled = true;
					try {
						// confirmAndQueueImageDescribeBackfill shows its own scale-warning confirm modal
						// and, on confirm, its own enqueue — no separate Notice here on top of it (brief:
						// "the image helpers show their own modal/Notice — for those just mark stale on
						// true"). Declined (false) leaves resultStale untouched, matching the brief.
						const queued = await confirmAndQueueImageDescribeBackfill(host.plugin);
						if (queued) onRepaired();
					} catch (e) {
						new Notice(`Repair failed: ${e instanceof Error ? e.message : String(e)}`);
					} finally {
						btn.disabled = false;
					}
				})();
			},
		});
		return;
	}
	if (key === 'imageFailed') {
		renderIconButton(td, 'wrench', {
			ariaLabel: 'Repair',
			title: `Retry ${count} failed image description${plural} (choice dialog follows).`,
			onClick: btn => {
				void (async () => {
					btn.disabled = true;
					try {
						// retryFailedImageDescriptions shows its own choice modal and its own Notice on a
						// made choice — same "no extra Notice here" rule as imagePending above.
						const queued = await retryFailedImageDescriptions(host.plugin);
						if (queued) onRepaired();
					} catch (e) {
						new Notice(`Repair failed: ${e instanceof Error ? e.message : String(e)}`);
					} finally {
						btn.disabled = false;
					}
				})();
			},
		});
	}
}

// Shared by the summary table's missing/stale/orphans wrenches (the reconcile trio) — the
// confirm gate for orphan deletion lives inside enqueueSearchRepairs (src/search/auditRun.ts),
// so it fires here exactly as it does from the paths table's per-row wrench and the
// search-reconcile-index command.
async function runReconcileAction(
	btn: HTMLButtonElement,
	host: DashboardHost,
	targets: SearchRepairTargets,
	onRepaired: () => void,
): Promise<void> {
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
}

// arrow-right = open note (row scope, per root AGENTS.md's icon table). Orphan rows are
// muted/disabled unconditionally — the path is, by definition, no longer in the vault — and any
// other class whose path fails to resolve (a race between the scan and a later delete/move, or —
// WP-I2 — an image class) degrades the same way rather than throwing.
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

// wrench = Repair (root AGENTS.md's icon table). missing/stale enqueue a search_upsert_file job
// for the one path; orphans enqueue a search_delete_path job (the confirm-gate for orphan
// deletion lives inside enqueueSearchRepairs — see src/search/auditRun.ts — so it fires here
// exactly as it does from the summary table and the reconcile command). mtimeOnly/unindexable
// render muted per their permanent informational state; embeddingGaps and the two image classes
// render muted pointing at the summary table's bulk (vault-wide) action — "muted, never absent"
// (root AGENTS.md) governs THIS table, unlike the summary table's hidden-at-zero rows.
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
			title: 'Use the Embedding gaps row\'s repair action — runs "Search: embed missing vectors" for the whole vault.',
			disabled: true,
		});
		return;
	}
	if (row.cls === 'imagePending') {
		renderIconButton(td, 'wrench', {
			ariaLabel: 'Repair',
			title: 'Use the Images pending row\'s repair action — describe runs as a vault-wide backfill.',
			disabled: true,
		});
		return;
	}
	if (row.cls === 'imageFailed') {
		renderIconButton(td, 'wrench', {
			ariaLabel: 'Repair',
			title: 'Use the Images failed row\'s repair action — retry runs as a vault-wide backfill.',
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
		onClick: btn => void runReconcileAction(btn, host, targets, onRepaired),
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
