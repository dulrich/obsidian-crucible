import type { TFile } from 'obsidian';

export type SourceKey = `blog:${string}` | `youtube:${string}`;
export type SourceType = 'blog' | 'youtube';

export interface EvalLabel {
	importance: number | null;
	urgent: boolean;
	rated: string | null;
	tags: string[];
}

export interface CaptureRecord {
	file: TFile;
	source: SourceKey | null;
	wordCount: number | null;
	read: boolean;
	tags: string[];
	created: number;
	published: number | null;
	isTranscript: boolean;
	isRefined: boolean;
	label: EvalLabel | null;
	evalSkip: boolean;
}

export interface ObservationSignal {
	months: number;
	quotes: number;
}

export type ObservationSignalMap = Map<string, ObservationSignal>;

export interface SourceEvalRow {
	source: SourceKey;
	name: string;
	type: SourceType;
	tracked: boolean;
	captures: number;
	ingestRate: number | null;
	uncaptured: number;
	readRate: number | null;
	refinedRate: number | null;
	goldRate: number;
	goldmineCount: number;
	obsCount: number;
	obsQuotes: number;
	wordsPerWeek: number;
	budgetShare: number | null;
	valueDensity: number | null;
	score: number;
	labeled: number;
	labeledPct: number;
}
