import type { BlogControlRow, ChannelControlRow } from '../ingestion/render/types';
import type { CaptureRecord, ObservationSignalMap, SourceEvalRow, SourceKey, SourceType } from './types';

export interface SourceEvalMetricSettings {
	readingBudgetWords: number;
	budgetPeriod?: 'week' | 'month';
	lookbackDays: number;
	recencyHalfLifeDays: number;
	now?: number;
}

export interface SourceEvalMetricsInput {
	captures: CaptureRecord[];
	blogRows: BlogControlRow[];
	channelRows: ChannelControlRow[];
	observations: ObservationSignalMap;
	settings: SourceEvalMetricSettings;
}

interface SourceAgg {
	source: SourceKey;
	name: string;
	type: SourceType;
	tracked: boolean;
	ingested: number;
	ignored: number;
	uncaptured: number;
	captures: CaptureRecord[];
}

interface CaptureScore {
	value: number;
	decay: number;
}

// Provisional hand-tuned weights until the dashboard has enough human labels
// to replace this score with a trained model. Gold is content quality; goldmine
// is link-richness/discovery, deliberately lower weight and kept separate.
export const SOURCE_EVAL_SCORE_WEIGHTS = {
	read: 1,
	gold: 3,
	goldmine: 1,
	observation: 2,
	observationQuote: 1,
	maxObservationQuotes: 3,
	deepTag: 2,
	labelImportance: 3,
	urgent: 1,
	ingestRate: 1,
} as const;

const DAYS_PER_WEEK = 7;
const WEEKS_PER_MONTH = 365.2425 / 12 / DAYS_PER_WEEK;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEEP_TAGS = new Set(['3-2-1', 'key', 'quiz-me']);

export function computeSourceEvalRows(input: SourceEvalMetricsInput): SourceEvalRow[] {
	const bySource = seedSources(input.blogRows, input.channelRows);
	for (const capture of input.captures) {
		if (!capture.source) continue;
		const agg = getOrCreateSource(bySource, capture.source);
		agg.captures.push(capture);
	}

	const rows = Array.from(bySource.values()).map(agg => buildRow(agg, input.observations, input.settings));
	rows.sort((a, b) => b.score - a.score || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
	return rows;
}

function seedSources(blogRows: BlogControlRow[], channelRows: ChannelControlRow[]): Map<SourceKey, SourceAgg> {
	const out = new Map<SourceKey, SourceAgg>();
	for (const row of blogRows) {
		const source: SourceKey = `blog:${row.blogKey}`;
		out.set(source, {
			source,
			name: row.name,
			type: 'blog',
			tracked: row.tracked,
			ingested: row.ingestedPosts,
			ignored: row.ignoredPosts,
			uncaptured: row.uncapturedPosts,
			captures: [],
		});
	}
	for (const row of channelRows) {
		const source: SourceKey = `youtube:${row.channelId}`;
		out.set(source, {
			source,
			name: row.name,
			type: 'youtube',
			tracked: row.tracked,
			ingested: row.ingestedVideos,
			ignored: row.ignoredVideos,
			uncaptured: row.uncapturedVideos,
			captures: [],
		});
	}
	return out;
}

function getOrCreateSource(bySource: Map<SourceKey, SourceAgg>, source: SourceKey): SourceAgg {
	const existing = bySource.get(source);
	if (existing) return existing;
	const type = source.startsWith('youtube:') ? 'youtube' : 'blog';
	const name = source.slice(source.indexOf(':') + 1);
	const created: SourceAgg = {
		source,
		name,
		type,
		tracked: false,
		ingested: 0,
		ignored: 0,
		uncaptured: 0,
		captures: [],
	};
	bySource.set(source, created);
	return created;
}

function buildRow(
	agg: SourceAgg,
	observations: ObservationSignalMap,
	settings: SourceEvalMetricSettings,
): SourceEvalRow {
	const captures = agg.captures;
	const captureCount = captures.length;
	const goldCount = captures.filter(c => hasTag(c, 'gold')).length;
	const goldmineCount = captures.filter(c => hasTag(c, 'goldmine')).length;
	const transcriptCount = captures.filter(c => c.isTranscript).length;
	const refinedCount = captures.filter(c => c.isTranscript && c.isRefined).length;
	const labeled = captures.filter(c => c.label !== null).length;
	const obsCount = captures.reduce((sum, capture) => sum + (observations.get(capture.file.path)?.months ?? 0), 0);
	const obsQuotes = captures.reduce((sum, capture) => sum + (observations.get(capture.file.path)?.quotes ?? 0), 0);
	const capturedWords = captures.reduce((sum, capture) => sum + Math.max(0, capture.wordCount ?? 0), 0);
	const wordsPerWeek = computeWordsPerWeek(captures, settings);
	const ingestDenominator = agg.ingested + agg.ignored;
	const ingestRate = ingestDenominator > 0 ? agg.ingested / ingestDenominator : null;

	return {
		source: agg.source,
		name: agg.name,
		type: agg.type,
		tracked: agg.tracked,
		captures: captureCount,
		ingestRate,
		uncaptured: agg.uncaptured,
		readRate: captureCount > 0 ? captures.filter(c => c.read).length / captureCount : null,
		refinedRate: agg.type === 'youtube' && transcriptCount > 0 ? refinedCount / transcriptCount : null,
		goldRate: captureCount > 0 ? goldCount / captureCount : 0,
		goldmineCount,
		obsCount,
		obsQuotes,
		wordsPerWeek,
		budgetShare: budgetShare(wordsPerWeek, settings),
		valueDensity: capturedWords > 0 ? ((goldCount + obsCount) / capturedWords) * 10000 : null,
		score: computeSourceScore(captures, observations, settings, ingestRate),
		labeled,
		labeledPct: captureCount > 0 ? labeled / captureCount : 0,
	};
}

function computeWordsPerWeek(captures: CaptureRecord[], settings: SourceEvalMetricSettings): number {
	const now = settings.now ?? Date.now();
	const lookbackDays = Math.max(0, settings.lookbackDays);
	if (lookbackDays <= 0) return 0;
	const start = now - lookbackDays * MS_PER_DAY;
	const words = captures
		.filter(capture => capture.created >= start && capture.created <= now)
		.reduce((sum, capture) => sum + Math.max(0, capture.wordCount ?? 0), 0);
	return words / (lookbackDays / DAYS_PER_WEEK);
}

function budgetShare(wordsPerWeek: number, settings: SourceEvalMetricSettings): number | null {
	const budget = settings.readingBudgetWords;
	if (!Number.isFinite(budget) || budget <= 0) return null;
	const weeklyBudget = settings.budgetPeriod === 'month' ? budget / WEEKS_PER_MONTH : budget;
	return wordsPerWeek / weeklyBudget;
}

function computeSourceScore(
	captures: CaptureRecord[],
	observations: ObservationSignalMap,
	settings: SourceEvalMetricSettings,
	ingestRate: number | null,
): number {
	const now = settings.now ?? Date.now();
	const lookbackDays = Math.max(0, settings.lookbackDays);
	const start = lookbackDays > 0 ? now - lookbackDays * MS_PER_DAY : now + 1;
	const scores = captures
		.filter(capture => capture.created >= start && capture.created <= now)
		.map(capture => scoreCapture(capture, observations.get(capture.file.path), settings, now));
	const decayedCount = scores.reduce((sum, score) => sum + score.decay, 0);
	const captureScore = decayedCount > 0
		? scores.reduce((sum, score) => sum + score.value * score.decay, 0) / decayedCount
		: 0;
	return captureScore + (ingestRate ?? 0) * SOURCE_EVAL_SCORE_WEIGHTS.ingestRate;
}

function scoreCapture(
	capture: CaptureRecord,
	obs: { months: number; quotes: number } | undefined,
	settings: SourceEvalMetricSettings,
	now: number,
): CaptureScore {
	const weights = SOURCE_EVAL_SCORE_WEIGHTS;
	const tags = captureTags(capture);
	let value = 0;
	if (capture.read) value += weights.read;
	if (tags.has('gold')) value += weights.gold;
	if (tags.has('goldmine')) value += weights.goldmine;
	if (obs && obs.months > 0) {
		value += weights.observation;
		value += weights.observationQuote * Math.min(weights.maxObservationQuotes, obs.quotes);
	}
	if (Array.from(DEEP_TAGS).some(tag => tags.has(tag))) value += weights.deepTag;
	if (capture.label?.importance !== null && capture.label?.importance !== undefined) {
		value += weights.labelImportance * (capture.label.importance / 5);
	}
	if (capture.label?.urgent) value += weights.urgent;
	return {
		value,
		decay: recencyDecay(capture.created, now, settings.recencyHalfLifeDays),
	};
}

function recencyDecay(created: number, now: number, halfLifeDays: number): number {
	if (!Number.isFinite(created) || created > now) return 1;
	if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 1;
	const ageDays = Math.max(0, (now - created) / MS_PER_DAY);
	return Math.exp(-Math.LN2 * ageDays / halfLifeDays);
}

function hasTag(capture: CaptureRecord, tag: string): boolean {
	return captureTags(capture).has(tag);
}

function captureTags(capture: CaptureRecord): Set<string> {
	const tags = new Set<string>();
	for (const tag of capture.tags) tags.add(normalizeTag(tag));
	for (const tag of capture.label?.tags ?? []) tags.add(normalizeTag(tag));
	tags.delete('');
	return tags;
}

function normalizeTag(tag: string): string {
	return tag.trim().replace(/^#/, '').toLowerCase();
}
