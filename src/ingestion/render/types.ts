import type { App, TFile } from 'obsidian';
import type { LocalizeMediaType } from '../../types';
import type CruciblePlugin from '../../main';
import type { JobSeed } from '../../orchestration/Orchestrator';

export type IntakeKind = 'blog' | 'youtube';

export type SectionId =
	| 'unprocessedClippings'
	| 'unrefinedTranscripts'
	| 'blogIntake'
	| 'youtubeIntake'
	| 'queueControls'
	| 'queueMonitor'
	| 'uncapturedPosts'
	| 'ignoredPosts'
	| 'blogControl'
	| 'uncapturedVideos'
	| 'ignoredVideos'
	| 'youtubeWithoutMetadata'
	| 'channelControl'
	| 'orphanedAttachments'
	| 'missingAttachments'
	| 'xPosts';

export interface SortState {
	column: string;
	direction: 'asc' | 'desc';
}

export interface TableStateContext {
	// P6: the coordinated flush (ingestionDashboard.ts) calls this with
	// `{ eventDriven: true }` for its automatic, coalesced passes. Every other
	// call site — the header Refresh button (buildSection), a sort-header click
	// (sortableTable.ts), Ignore/Unignore and other user-action refreshes
	// (cells.ts, controlCenter.ts, orphanedAttachments.ts, controlCenters.ts,
	// uncapturedPosts.ts) — calls `ctx.refresh()` with no opts, which is a
	// forced pass. `refresh` is responsible for setting `ctx.eventDriven`
	// (`opts?.eventDriven === true`) *before* invoking the section's render
	// function, since that's what the P5 row-signature skip in
	// render/section.ts (`shouldRepaint`) reads to decide whether an unchanged
	// row model may skip repainting.
	refresh: (opts?: { eventDriven?: boolean }) => Promise<void> | void;
	sort: SortState | null;
	// P5: transient — set by `refresh()` immediately before it calls the
	// section's render function, consumed by `shouldRepaint()` in
	// render/section.ts. true only during the coordinated flush's automatic
	// passes; left false (or unset) by every forced call, which always
	// repaints regardless of whether the computed row signature matches the
	// last-painted one. Not reset back to false after a call — `refresh`
	// re-asserts it (to whichever value is correct) on every invocation, so a
	// stale leftover value can never be read.
	eventDriven?: boolean;
}

// Shared per-section view state: the body element a section renders into, its
// count/meta header slots, the current sort, and a refresh hook. Both the
// controller and the reusable render helpers operate on this.
export interface SectionContext extends TableStateContext {
	id: SectionId;
	title: string;
	description: string;
	body: HTMLElement;
	countEl: HTMLElement;
	metaEl: HTMLElement;
}

// Narrow seam section modules render against instead of the full controller:
// only what render logic actually touches on the controller today (grepped
// per section, see wp-d2-report.md for the per-field justification).
export interface DashboardHost {
	readonly plugin: CruciblePlugin;
	readonly app: App;
	readonly container: HTMLElement;
	refresh(id: SectionId): Promise<void>;
	createSectionHeader(
		card: HTMLElement,
		title: string,
		description: string,
		defaultCollapsed: boolean,
	): { heading: HTMLElement; countEl: HTMLElement; metaEl: HTMLElement };
	registerSection(ctx: SectionContext): void;
	/**
	 * Registers a teardown callback run on `unmount()`, alongside the dashboard's own
	 * event-bus subscriptions. For a section that wires a live subscription outside the
	 * refresh cycle (e.g. `queueMonitor`'s `serviceHealth.onTransition`) — a section
	 * built once in `mount()` has no other hook to release it from.
	 */
	registerDisposer(dispose: () => void): void;
	setSectionCount(id: SectionId, n: number): void;
	setSectionMeta(id: SectionId, text: string): void;
	// The enrichment auto-source: uncaptured videos without an enrichment file yet,
	// in the uncaptured-videos section's current sort order. Owned by
	// uncapturedVideos.ts but read by queueControls.ts too, so it stays on the host.
	uncapturedQueueItems(): JobSeed[];
}

export interface Column<T> {
	key: string;
	label: string;
	sortable?: boolean;
	sortKey?: (row: T) => string | number;
	render: (row: T, td: HTMLElement) => void;
}

export interface ClippingRow {
	file: TFile;
	title: string;
	captured: number;
	size: number;
}

export interface TranscriptRow {
	file: TFile;
	title: string;
	tags: string[];
	words: number;
	estReadMin: number | null;
	created: number;
	read: boolean;
}

export interface UncapturedVideoRow {
	videoId: string;
	channelName: string;
	channelId: string;
	channelAboutFile: TFile | null;
	title: string;
	publishedAt: string;
	url: string;
	durationSeconds: number | null;
	enrichmentFile: TFile | null;
}

// WP-IC2: the Ignored Videos row — mirrors UncapturedVideoRow's readable fields, but
// every field besides `id` degrades to null when the video is still ignored yet no
// longer appears in any scanned tracker run (aged out of retention). `channelId` is
// intentionally not carried here (unlike UncapturedVideoRow): it exists there only to
// build a raw youtube.com/channel/<id> fallback link, and a degrade row has no channel
// to link to at all — see renderIgnoredVideos (sections/ignored.ts) for the cell shape.
export interface IgnoredVideoRow {
	id: string;
	title: string | null;
	channelName: string | null;
	publishedAt: string | null;
	url: string | null;
	durationSeconds: number | null;
	channelAboutFile: TFile | null;
	enrichmentFile: TFile | null;
}

export interface YoutubeNoMetadataRow {
	file: TFile;
	title: string;
	created: number;
	videoId: string;
}

export interface ChannelControlRow {
	channelId: string;
	name: string;
	aboutFile: TFile | null;
	trackedVideos: number;
	ingestedVideos: number;
	ignoredVideos: number;
	uncapturedVideos: number;
	tracked: boolean;
}

export interface BlogControlRow {
	blogKey: string;
	name: string;
	link: string | null;
	trackedPosts: number;
	ingestedPosts: number;
	ignoredPosts: number;
	uncapturedPosts: number;
	tracked: boolean;
}

export interface UncapturedPostRow {
	postId: string;
	blogName: string;
	blogLink: string;
	title: string;
	publishedAt: string;
	url: string;
	authors: string[];
	categories: string[];
	wordCount: number | null;
	kind: 'article' | 'podcast';
	hasBody: boolean;
	metadataFile: TFile | null;
	audioUrl?: string;
}

// WP-IC2: the Ignored Posts row — mirrors UncapturedPostRow's readable fields, minus
// `authors`/`categories`/`hasBody`/`audioUrl` (not shown by the Ignored section; see
// renderIgnoredPosts in sections/ignored.ts for the exact column set), degrading to
// null when the post is still ignored yet no longer appears in any scanned tracker
// run (aged out of retention).
export interface IgnoredPostRow {
	id: string;
	title: string | null;
	blogName: string | null;
	publishedAt: string | null;
	url: string | null;
	kind: 'article' | 'podcast' | null;
	wordCount: number | null;
	metadataFile: TFile | null;
}

export interface OrphanRow {
	file: TFile;
	folder: string;
	type: LocalizeMediaType;
	size: number;
	mtime: number;
}

// Inverse of OrphanRow: a note ref pointing at a managed (…_MD5.ext) attachment that no
// longer resolves. `repairable`/`reason` mirror what `resolveLocalAttachmentRepair` would
// find for this exact ref — see src/ingestion/data/missingAttachments.ts. `reason` is
// non-null exactly when `repairable` is false, so the dashboard never shows an opaque "no".
export interface MissingRefRow {
	note: TFile;
	link: string;
	repairable: boolean;
	reason: 'missing' | 'ambiguous' | null;
}

// One row per X status, merged from the link registry (pending/candidate set) and
// materialized `_x_metadata` notes (both live posts and tombstones) — see
// computeXPostRows (../data/xPosts.ts) for the merge rules.
export interface XPostRow {
	statusId: string;
	url: string;
	author: string | null;
	state: 'materialized' | 'unavailable' | 'pending';
	sourceCount: number;
	// The materialized/tombstone note's TFile, when one exists — null for a
	// `pending` row (registry record with nothing fetched yet).
	metadataFile: TFile | null;
}
