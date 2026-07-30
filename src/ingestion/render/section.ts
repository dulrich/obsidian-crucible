import type { Column, SortState, TableStateContext } from './types';
import { renderSortableTable } from './sortableTable';

// Default cap for any section built on renderTableSection that doesn't pass its
// own `limit`. Twelve of the thirteen ingestion-dashboard tables render
// uncapped — a long-running vault can grow any of them (uncaptured posts,
// orphaned attachments, ...) into the thousands, at which point every refresh
// re-renders that many rows' worth of DOM. queueMonitor already caps at 100
// (QUEUE_MONITOR_RENDER_LIMIT in queueMonitor.ts) for the same reason; this is
// the equivalent floor for everything else. Callers with a reason to differ
// (a section that's rarely large, or one that wants a tighter cap) pass their
// own `limit`.
export const DEFAULT_TABLE_ROW_LIMIT = 200;

export interface RenderTableSectionOptions<T> {
	body: HTMLElement;
	ctx: TableStateContext;
	rows: T[];
	columns: Column<T>[];
	emptyText: string;
	setCount: (n: number) => void;
	defaultSort?: SortState;
	limit?: number;
	// rsp-wp6: forwarded straight through to renderSortableTable's own
	// `rowKey` option — see its doc comment (sortableTable.ts) for the
	// stability contract. Omit for tables with no natural stable key.
	rowKey?: (row: T) => string;
}

const TABLE_CAPTION_CLS = 'crucible-ingestion-table-caption';

// The scaffold shared by every list section: publish the row count, short-
// circuit to an empty-state message when there are no rows, seed the default
// sort on first render, then hand off to the sortable table. Rows beyond
// `limit` (default DEFAULT_TABLE_ROW_LIMIT) don't render at all — sorting
// happens on the full row set first (renderSortableTable's own `options.limit`
// slices after sorting), so which rows are visible still reflects the active
// sort, not insertion order.
//
// rsp-wp6: `body` is deliberately NOT emptied unconditionally at the top
// anymore — for a keyed table, renderSortableTable owns its own subtree of
// `body` and reconciles it in place; wiping `body` first every render would
// tear down exactly the DOM the reconciler exists to preserve. The zero-rows
// branch still empties `body` itself (there is nothing to reconcile), which
// also self-heals the reconciler's cache: renderSortableTable's own staleness
// check (`state.table.parentElement !== parent`) notices the table is gone
// next time rows reappear and rebuilds clean.
export function renderTableSection<T>(opts: RenderTableSectionOptions<T>): void {
	const { body, ctx, rows, columns, emptyText, setCount, defaultSort, limit = DEFAULT_TABLE_ROW_LIMIT, rowKey } = opts;
	if (rows.length === 0) {
		body.empty();
		setCount(0);
		body.createDiv({ cls: 'crucible-empty-state', text: emptyText });
		return;
	}
	setCount(rows.length);
	if (!ctx.sort && defaultSort) ctx.sort = defaultSort;
	renderSortableTable(body, columns, rows, ctx, { limit, rowKey });

	// The caption is the one other thing renderTableSection puts directly into
	// `body`, so with `body` no longer wiped every render (keyed path) it has
	// to be reconciled the same way: remove whatever caption is there (if any)
	// before deciding whether to add a current one, rather than letting a new
	// one stack on top of a stale one every render.
	const priorCaption = Array.from(body.children).find(c => (c as HTMLElement).className === TABLE_CAPTION_CLS);
	if (priorCaption) priorCaption.remove();
	if (rows.length > limit) {
		body.createDiv({
			cls: TABLE_CAPTION_CLS,
			text: `showing ${limit} of ${rows.length}`,
		});
	}
}

// --- P5: row-model signature skip ---
//
// A "meta"/"structural" vault event that route() (ingestionDashboard.ts) lets
// through a section's coarse path-prefix gate doesn't necessarily mean that
// section's own computed rows changed — e.g. queue churn drags
// uncapturedVideos/youtubeWithoutMetadata along on every tick even when no
// video row actually changed. Every one of those wasted passes was tearing
// down and rebuilding the section's whole table DOM. This tracks, per section
// (keyed by the section's own long-lived TableStateContext object — one per
// section, constructed once in buildSection/buildXSection and reused for
// every render of that section for the life of the mount), the signature of
// what was last actually painted, so a coordinated-flush ("event-driven")
// pass can skip repainting when nothing has changed. A forced pass (header
// Refresh button, sort-header click, Ignore/Unignore, or any other
// user-triggered `ctx.refresh()`/`host.refresh()` call — see
// TableStateContext.eventDriven's doc comment) always repaints.
//
// Keyed on the ctx object itself, not a SectionId string, so this stays
// usable from render/controlCenter.ts (shared by two sections) and any
// future call site without threading an id through. A WeakMap needs no
// explicit clearing on dashboard unmount: buildSection/buildXSection
// construct a fresh ctx object on every mount, so a prior mount's entries
// simply become unreachable (same reasoning as intake.ts's lastButtonState).
const lastRowSignatures = new WeakMap<TableStateContext, string>();

// Deterministic, directly-comparable serialization of a section's row model
// plus any extra render-affecting inputs a section reads OUTSIDE the row
// objects themselves — e.g. youtubeWithoutMetadata's per-row in-flight badge
// state or uncapturedVideos' per-row live enrichment-queue status, neither of
// which lives on the row object, so two calls with byte-identical `rows`
// could still need to repaint. Not a hash/digest: at the row counts these
// tables render (capped at DEFAULT_TABLE_ROW_LIMIT, and even the uncapped
// pre-cap scans top out in the low thousands) a full JSON string compare is
// cheap, and skipping a digest step means zero collision risk for free —
// "cheap and deterministic" doesn't require throwing away exactness.
//
// Row objects widely carry TFile references (row.file,
// row.channelAboutFile, row.enrichmentFile, ...), and a TFile carries a
// back-reference to Vault, which back-references its files — a plain
// `JSON.stringify(rows)` throws on that cycle (or, if it somehow didn't,
// would serialize the entire vault graph). The replacer collapses anything
// duck-typed as a vault entry (a string `.path` alongside a `.vault` field)
// down to just its path, which is the only part of a TFile that actually
// identifies the row — the label text and every other rendered field already
// come from plain values on the row itself. A belt-and-suspenders WeakSet
// guards any other accidental cycle by collapsing a repeat visit rather than
// throwing (this module has no obsidian import — see the test harness note
// in tests/ingestionTableCapAndGating.test.mjs — so this can't `instanceof
// TFile`; duck-typing is deliberate, not a shortcut).
export function computeRowSignature(rows: unknown, extra?: unknown): string {
	const seen = new WeakSet<object>();
	const replacer = (_key: string, value: unknown): unknown => {
		if (value && typeof value === 'object') {
			const maybeFile = value as { path?: unknown; vault?: unknown };
			if (typeof maybeFile.path === 'string' && 'vault' in maybeFile) return maybeFile.path;
			if (seen.has(value)) return '[circular]';
			seen.add(value);
		}
		return value;
	};
	return JSON.stringify({ rows, extra }, replacer);
}

// Returns true when the caller should repaint. Forced passes (the default —
// `ctx.eventDriven !== true`) always repaint. An event-driven pass (the
// coordinated flush) repaints only when `signature` differs from what was
// last actually painted for this `ctx`. Either way, `signature` is always
// recorded as the new baseline before returning — including on a forced
// repaint — so a LATER event-driven pass compares against what is now truly
// on screen, not a stale pre-forced-repaint snapshot.
export function shouldRepaint(ctx: TableStateContext, signature: string): boolean {
	const forced = ctx.eventDriven !== true;
	const prev = lastRowSignatures.get(ctx);
	lastRowSignatures.set(ctx, signature);
	return forced || prev !== signature;
}
