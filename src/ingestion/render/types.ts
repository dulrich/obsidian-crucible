import type { TFile } from 'obsidian';
import type { LocalizeMediaType } from '../../types';

export type SectionId =
	| 'unprocessedClippings'
	| 'unrefinedTranscripts'
	| 'blogIntake'
	| 'youtubeIntake'
	| 'queueMonitor'
	| 'uncapturedPosts'
	| 'ignoredPosts'
	| 'uncapturedVideos'
	| 'ignoredVideos'
	| 'youtubeWithoutMetadata'
	| 'channelControl'
	| 'orphanedAttachments';

export interface SortState {
	column: string;
	direction: 'asc' | 'desc';
}

// Shared per-section view state: the body element a section renders into, its
// count/meta header slots, the current sort, and a refresh hook. Both the
// controller and the reusable render helpers operate on this.
export interface SectionContext {
	id: SectionId;
	title: string;
	description: string;
	body: HTMLElement;
	countEl: HTMLElement;
	metaEl: HTMLElement;
	refresh: () => Promise<void> | void;
	sort: SortState | null;
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
