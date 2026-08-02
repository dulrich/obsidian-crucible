import type { SearchAuditResult } from './audit';

/**
 * WP-R3: the single typed condition-descriptor set behind both the search-audit report
 * (`formatAuditReport`, `src/search/audit.ts`) and the Ingestion dashboard's merged Summary/Repair
 * table (`src/ingestion/sections/searchAudit.ts`). Before this module the two renderers
 * hand-duplicated the same eight-condition classification — keys, canonical order, count/path
 * projections, and repair-command routing — kept in sync only by a comment cross-reference (the
 * old `searchAudit.ts:52-54`, deleted by this WP). Both renderers now read the SAME array; they
 * diverge only in the PROSE they print from it (a report bullet vs. a dashboard row label), which
 * is legitimate and stays legitimate — see the image-coverage note below.
 *
 * Dependency-free by design: no `obsidian` import, no DOM, no commands, no orchestration runtime.
 * This module sits under the same purity barrier as `src/search/audit.ts` itself (pinned by
 * `tests/searchAudit.test.mjs`, which bundles `audit.ts` with esbuild's default platform/
 * no-externals settings — and therefore bundles this module too, since `audit.ts` imports
 * `AUDIT_CONDITIONS` from here; an accidental `obsidian` import would fail that build).
 *
 * The dashboard's ninth summary row (`imagesDescribed`, folded into `AuditSummaryKey` below) is
 * deliberately NOT a descriptor here: it has no repair action, no path projection, and is never
 * filterable — it renders the `described / referenced` ratio the report already folds into its
 * one combined "Image coverage: …" bullet. Both renderers special-case that row directly, because
 * it is structurally not a condition (nothing to repair, nothing to filter by), not an omission.
 *
 * Image coverage is the one place the report and dashboard projections genuinely diverge, on
 * purpose (see the WP-R3 brief): the report reports it as ONE bullet (described/referenced/
 * failed/pending counts, no per-path listing — `formatAuditReport`'s Image coverage line); the
 * dashboard expands it into THREE rows (`imagePending`, `imageFailed`, and the virtual
 * `imagesDescribed`). Forcing those two projections to look identical would be wrong, not a
 * simplification — this module expresses both by giving `imagePending`/`imageFailed` real
 * descriptors (so the dashboard's rows and the report's Repair-section entries for them share one
 * source) while leaving the report's combined bullet as its own literal in `formatAuditReport` (it
 * needs `described`+`referenced` too, which no single condition's `paths()` projection carries).
 */

export type AuditConditionKey =
	| 'missing'
	| 'orphans'
	| 'stale'
	| 'mtimeOnly'
	| 'unindexable'
	| 'embeddingGaps'
	| 'imagePending'
	| 'imageFailed';

/**
 * The dashboard's one virtual, non-condition summary row (`described / referenced`, informational
 * ratio, never filterable, never repairable) folded in here only so both renderers can share one
 * "every summary row key" type without re-declaring the union twice.
 */
export type AuditSummaryKey = AuditConditionKey | 'imagesDescribed';

/**
 * The repair-action family a condition routes to — replaces what used to be six near-identical
 * per-key branches duplicated across `formatRepairSection` (audit.ts) and
 * `renderSummaryAction`/`renderRowRepairButton` (searchAudit.ts). `informational` (mtimeOnly,
 * unindexable) and the absent-from-this-module `imagesDescribed` row both mean "no repair exists,"
 * but stay distinguishable: `informational` still has a real path projection and summary count,
 * `imagesDescribed` has neither.
 */
export type AuditRepairPolicy =
	| 'reconcile-upsert'
	| 'reconcile-orphan'
	| 'embed-missing'
	| 'image-backfill'
	| 'image-retry'
	| 'informational';

export interface AuditConditionDescriptor {
	key: AuditConditionKey;
	category: 'note' | 'image';
	/**
	 * Short filter noun — the dashboard paths-table Class column, the summary row's click-filter
	 * title text, and (via `reportRepairInstruction` in audit.ts) the report's per-class repair
	 * wording ("… for each missing path.").
	 */
	classLabel: string;
	/** `formatAuditReport`'s Summary-section bullet label, sans the trailing ": <count>". */
	reportSummaryLabel: string;
	/**
	 * `formatAuditReport`'s per-class body-section heading (`formatAuditSection`'s title arg).
	 * Undefined for the two image conditions — the report never lists image paths, only the
	 * combined coverage bullet (see the module doc above).
	 */
	reportSectionTitle?: string;
	/** The dashboard Summary/Repair table's row label (`SUMMARY_LABELS` before WP-R3). */
	dashboardLabel: string;
	/**
	 * True for exactly missing/orphans/stale: the dashboard's default (unfiltered) paths-table
	 * view and the header's honest total. `commands.ts`'s `search-reconcile-index` (consume-only,
	 * not touched by this module) independently enqueues `[...missing, ...stale]` plus orphans —
	 * the same three classes, by its own long-standing contract, not read from this flag.
	 */
	isDefaultView: boolean;
	repairPolicy: AuditRepairPolicy;
	/**
	 * The one place either renderer reads a condition's affected-path list. A count is always
	 * `paths(result).length` — deliberately not a separate field, so a count and its path list can
	 * never drift apart.
	 */
	paths(result: SearchAuditResult): string[];
	/**
	 * The paths-table per-row repair button's DISABLED title, for every condition whose repair is
	 * either non-existent (`informational`) or only available in bulk from the summary table
	 * (`embed-missing`/`image-backfill`/`image-retry`). Absent for `reconcile-upsert`/
	 * `reconcile-orphan` — those render a real, enabled per-row wrench instead (see
	 * `renderRowRepairButton` in `searchAudit.ts`).
	 */
	rowMutedTitle?: string;
}

export const AUDIT_CONDITIONS: readonly AuditConditionDescriptor[] = [
	{
		key: 'missing',
		category: 'note',
		classLabel: 'missing',
		reportSummaryLabel: 'Missing (in vault, not indexed)',
		reportSectionTitle: 'Missing',
		dashboardLabel: 'Missing (in vault, not indexed)',
		isDefaultView: true,
		repairPolicy: 'reconcile-upsert',
		paths: result => result.missing,
	},
	{
		key: 'orphans',
		category: 'note',
		classLabel: 'orphans',
		reportSummaryLabel: 'Orphans (indexed, not in vault)',
		reportSectionTitle: 'Orphans',
		dashboardLabel: 'Orphans (indexed, not in vault)',
		isDefaultView: true,
		repairPolicy: 'reconcile-orphan',
		paths: result => result.orphans,
	},
	{
		key: 'stale',
		category: 'note',
		classLabel: 'stale',
		reportSummaryLabel: 'Stale (vault newer than indexed, content changed)',
		reportSectionTitle: 'Stale',
		dashboardLabel: 'Stale (vault newer, content changed)',
		isDefaultView: true,
		repairPolicy: 'reconcile-upsert',
		paths: result => result.stale,
	},
	{
		key: 'mtimeOnly',
		category: 'note',
		classLabel: 'mtime-only',
		reportSummaryLabel: 'Mtime-only (newer mtime, unchanged content — index is current; no action needed)',
		reportSectionTitle: 'Mtime only (unchanged content — informational, no action needed)',
		dashboardLabel: 'Mtime-only (unchanged content — index is current)',
		isDefaultView: false,
		repairPolicy: 'informational',
		paths: result => result.mtimeOnly,
		rowMutedTitle: 'Nothing to repair — index is current (mtime-only drift).',
	},
	{
		key: 'unindexable',
		category: 'note',
		classLabel: 'unindexable',
		reportSummaryLabel: 'Unindexable (no indexable content — frontmatter-only; nothing to index; no action needed)',
		reportSectionTitle: 'Unindexable (no content to index — informational, no action needed)',
		dashboardLabel: 'Unindexable (no indexable content)',
		isDefaultView: false,
		repairPolicy: 'informational',
		paths: result => result.unindexable,
		rowMutedTitle: 'No indexable content (frontmatter-only note).',
	},
	{
		key: 'embeddingGaps',
		category: 'note',
		classLabel: 'embedding gaps',
		reportSummaryLabel: 'Embedding gaps (embedded < chunks)',
		reportSectionTitle: 'Embedding gaps',
		dashboardLabel: 'Embedding gaps (embedded < chunks)',
		isDefaultView: false,
		repairPolicy: 'embed-missing',
		paths: result => result.embeddingGaps,
		rowMutedTitle: 'Use the Embedding gaps row\'s repair action — runs "Search: embed missing vectors" for the whole vault.',
	},
	{
		key: 'imagePending',
		category: 'image',
		classLabel: 'images pending',
		reportSummaryLabel: 'Images pending',
		dashboardLabel: 'Images pending',
		isDefaultView: false,
		repairPolicy: 'image-backfill',
		paths: result => result.imageCoverage.pendingPaths,
		rowMutedTitle: 'Use the Images pending row\'s repair action — describe runs as a vault-wide backfill.',
	},
	{
		key: 'imageFailed',
		category: 'image',
		classLabel: 'images failed',
		reportSummaryLabel: 'Images failed',
		dashboardLabel: 'Images failed',
		isDefaultView: false,
		repairPolicy: 'image-retry',
		paths: result => result.imageCoverage.failedPaths,
		rowMutedTitle: 'Use the Images failed row\'s repair action — retry runs as a vault-wide backfill.',
	},
];

const CONDITIONS_BY_KEY: ReadonlyMap<AuditConditionKey, AuditConditionDescriptor> =
	new Map(AUDIT_CONDITIONS.map(d => [d.key, d]));

/**
 * Looks up a condition by key — throws on an unknown key rather than returning undefined, since
 * every caller already holds an `AuditConditionKey`-typed value (never raw/unvalidated input).
 */
export function conditionFor(key: AuditConditionKey): AuditConditionDescriptor {
	const descriptor = CONDITIONS_BY_KEY.get(key);
	if (!descriptor) throw new Error(`Unknown audit condition key: ${key}`);
	return descriptor;
}

/**
 * `missing`/`orphans`/`stale`, in declared order — the dashboard's default (unfiltered)
 * paths-table view.
 */
export const DEFAULT_VIEW_CONDITIONS: readonly AuditConditionDescriptor[] = AUDIT_CONDITIONS.filter(d => d.isDefaultView);

/**
 * Every note-category condition (all six path classes), in declared order — the six classes
 * `formatAuditReport`'s Summary section and per-class body sections both walk.
 */
export const NOTE_CONDITIONS: readonly AuditConditionDescriptor[] = AUDIT_CONDITIONS.filter(d => d.category === 'note');
