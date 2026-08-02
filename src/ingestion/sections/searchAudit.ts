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
} from '../../search/auditRun';
import { type ReconcileEnqueueSummaryInput, type SearchAuditResult } from '../../search/audit';
import {
	AUDIT_CONDITIONS,
	conditionFor,
	DEFAULT_VIEW_CONDITIONS,
	type AuditConditionDescriptor,
	type AuditConditionKey,
	type AuditSummaryKey,
} from '../../search/auditConditions';
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
 * WP-R3: the eight real conditions (everything but `imagesDescribed`) — their keys, canonical
 * order, count/path projections, and repair-command routing — now come from ONE shared
 * descriptor set (`src/search/auditConditions.ts`), also consumed by `formatAuditReport`
 * (`src/search/audit.ts`). Before this WP the two files hand-duplicated that classification,
 * synced only by a comment cross-reference. See `auditConditions.ts`'s module doc for why the
 * report's single combined image-coverage bullet and this section's three image rows
 * (`imagePending`/`imageFailed`/`imagesDescribed`) are a deliberate, preserved divergence in
 * PROSE, not a gap in the shared model.
 *
 * State pattern lifted from the settings Search-health panel
 * (`src/settings/sections/orchestrationSearch.ts`'s `cachedSearchHealth`/renderBody): closure-
 * cached `{result, ranAt, error}`, refreshed only by an explicit button click, with the last
 * successful result surviving a later failed run (see the error branch below).
 */

type AuditClass = AuditConditionKey;
type SummaryKey = AuditSummaryKey;

// Fixed row order for the merged Summary/Repair table — mirrors formatAuditReport's Summary
// section (AUDIT_CONDITIONS' declared order, shared with src/search/audit.ts) plus the one
// virtual, non-condition row (see the module doc above) — so the dashboard and the report note
// never disagree about what the nine lines are or what order they read in.
const SUMMARY_ORDER: readonly SummaryKey[] = [...AUDIT_CONDITIONS.map(d => d.key), 'imagesDescribed'];

const SUMMARY_LABELS: Readonly<Record<SummaryKey, string>> = (() => {
	const labels = {} as Record<SummaryKey, string>;
	for (const d of AUDIT_CONDITIONS) labels[d.key] = d.dashboardLabel;
	labels.imagesDescribed = 'Images described (informational)';
	return labels;
})();

// Short filter-noun used in the paths table's Class column and the summary row's clickable
// title — the "images pending"/"images failed" wording WP-I2 adds for the two image classes.
const AUDIT_CLASS_LABELS: Readonly<Record<AuditClass, string>> = AUDIT_CONDITIONS.reduce((acc, d) => {
	acc[d.key] = d.classLabel;
	return acc;
}, {} as Record<AuditClass, string>);

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

		const totalAffected = DEFAULT_VIEW_CONDITIONS.reduce((sum, d) => sum + d.paths(currentResult).length, 0);
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
		for (const d of DEFAULT_VIEW_CONDITIONS) for (const path of d.paths(result)) rows.push({ path, cls: d.key });
		return rows;
	}
	return conditionFor(selectedClass).paths(result).map(path => ({ path, cls: selectedClass }));
}

function summaryCount(result: SearchAuditResult, key: SummaryKey): number {
	if (key === 'imagesDescribed') return result.imageCoverage.described;
	return conditionFor(key).paths(result).length;
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

// Per-row action for the summary table. mtimeOnly/unindexable (repairPolicy 'informational')
// always read "no action needed" (their permanent informational state, regardless of count); the
// images-described virtual row always reads "—" (a ratio, not a state). Every other row's wrench
// is HIDDEN ENTIRELY when its count is 0 — the user-locked deviation from "muted, never absent"
// that's scoped to this table only (root AGENTS.md); the paths table below keeps the ordinary
// muted-wrench law.
function renderSummaryAction(
	td: HTMLElement,
	host: DashboardHost,
	key: SummaryKey,
	result: SearchAuditResult,
	count: number,
	onRepaired: () => void,
): void {
	if (key === 'imagesDescribed') {
		td.setText('—');
		return;
	}
	const descriptor = conditionFor(key);
	if (descriptor.repairPolicy === 'informational') {
		td.setText('No action needed');
		return;
	}
	if (count === 0) return;

	const plural = count === 1 ? '' : 's';
	renderIconButton(td, 'wrench', {
		ariaLabel: 'Repair',
		title: summaryRepairTitle(descriptor, count, plural),
		onClick: btn => void runConditionRepair(btn, host, descriptor, descriptor.paths(result), onRepaired),
	});
}

// WP-R3: the summary wrench's title text, one template per repair policy — replaces what used to
// be five separate `renderIconButton` call sites (one per key) each hardcoding its own title.
function summaryRepairTitle(descriptor: AuditConditionDescriptor, count: number, plural: string): string {
	switch (descriptor.repairPolicy) {
		case 'reconcile-upsert':
			return `Enqueue re-index jobs for ${count} ${descriptor.classLabel} path${plural}.`;
		case 'reconcile-orphan':
			return `Delete ${count} orphaned path${plural} from the search index (confirm required).`;
		case 'embed-missing':
			return `Run "Search: embed missing vectors" for ${count} embedding gap${plural}.`;
		case 'image-backfill':
			return `Queue the image-describe backfill for ${count} pending image${plural} (confirm dialog follows).`;
		case 'image-retry':
			return `Retry ${count} failed image description${plural} (choice dialog follows).`;
		case 'informational':
		default:
			return '';
	}
}

// WP-R3: the ONE dispatcher over `AuditRepairPolicy`, replacing the six near-identical
// wrench-click handlers previously duplicated across the summary table (`renderSummaryAction`)
// and the paths table (`renderRowRepairButton`) — both now call this with their own `paths`
// (the full class for a summary-row bulk action, a single-element array for a paths-table row).
// The confirm gate for orphan deletion lives inside `enqueueSearchRepairs`
// (src/search/auditRun.ts), so it fires here exactly as it always did from either table and from
// the `search-reconcile-index` command. `image-backfill`/`image-retry` show their own
// modal/Notice — no extra Notice here on top of them, matching their original extraction comments.
async function runConditionRepair(
	btn: HTMLButtonElement,
	host: DashboardHost,
	descriptor: AuditConditionDescriptor,
	paths: string[],
	onRepaired: () => void,
): Promise<void> {
	btn.disabled = true;
	try {
		switch (descriptor.repairPolicy) {
			case 'reconcile-upsert': {
				const outcome = await enqueueSearchRepairs(host.plugin, { upsertPaths: paths, orphanPaths: [] });
				new Notice(singleRepairNotice(outcome));
				if (!outcome.orphansDeclined) onRepaired();
				break;
			}
			case 'reconcile-orphan': {
				const outcome = await enqueueSearchRepairs(host.plugin, { upsertPaths: [], orphanPaths: paths });
				new Notice(singleRepairNotice(outcome));
				if (!outcome.orphansDeclined) onRepaired();
				break;
			}
			case 'embed-missing':
				await enqueueEmbedMissing(host.plugin);
				new Notice('Search: embed missing vectors — enqueued.');
				onRepaired();
				break;
			case 'image-backfill': {
				const queued = await confirmAndQueueImageDescribeBackfill(host.plugin);
				if (queued) onRepaired();
				break;
			}
			case 'image-retry': {
				const queued = await retryFailedImageDescriptions(host.plugin);
				if (queued) onRepaired();
				break;
			}
			case 'informational':
				break;
		}
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

// wrench = Repair (root AGENTS.md's icon table). WP-R3: driven by the condition's `repairPolicy`
// via the shared `runConditionRepair` dispatcher instead of six per-class branches. A condition
// carrying `rowMutedTitle` (mtimeOnly/unindexable's permanent informational state; embeddingGaps
// and the two image classes, whose repair only exists in bulk from the summary table's wrench)
// renders muted with that title — "muted, never absent" (root AGENTS.md) governs THIS table,
// unlike the summary table's hidden-at-zero rows. The two remaining policies (reconcile-upsert
// for missing/stale, reconcile-orphan for orphans) render a real, enabled wrench for the one path.
function renderRowRepairButton(host: DashboardHost, td: HTMLElement, row: SearchAuditRow, onRepaired: () => void): void {
	const descriptor = conditionFor(row.cls);
	if (descriptor.rowMutedTitle) {
		renderIconButton(td, 'wrench', { ariaLabel: 'Repair', title: descriptor.rowMutedTitle, disabled: true });
		return;
	}
	const isOrphan = descriptor.repairPolicy === 'reconcile-orphan';
	renderIconButton(td, 'wrench', {
		ariaLabel: 'Repair',
		title: isOrphan
			? 'Delete this orphaned path from the search index (confirm required).'
			: 'Enqueue a re-index job for this path.',
		onClick: btn => void runConditionRepair(btn, host, descriptor, [row.path], onRepaired),
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
