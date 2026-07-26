import type { App, TFile } from 'obsidian';
import type { LocalizeMediaType } from '../../types';
import type CruciblePlugin from '../../main';
import type { EnrichmentQueueItem } from '../../orchestration/EnrichmentQueueAdapter';

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
	| 'orphanedAttachments';

export interface SortState {
	column: string;
	direction: 'asc' | 'desc';
}

export interface TableStateContext {
	refresh: () => Promise<void> | void;
	sort: SortState | null;
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
	uncapturedQueueItems(): EnrichmentQueueItem[];
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

export interface OrphanRow {
	file: TFile;
	folder: string;
	type: LocalizeMediaType;
	size: number;
	mtime: number;
}
