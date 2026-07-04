import type { CaptureRecord, SourceEvalRow, SourceKey } from './types';

export type RatingQueueBroadScope = 'all' | 'tracked' | 'untracked' | 'blogs' | 'youtube';
export type RatingQueueScope = RatingQueueBroadScope | SourceKey;

export interface RatingQueueOptions {
	scope?: RatingQueueScope;
	unlabeledOnly?: boolean;
	includeSkipped?: boolean;
	sources?: Pick<SourceEvalRow, 'source' | 'tracked' | 'type'>[];
}

export function buildRatingQueue(captures: CaptureRecord[], options: RatingQueueOptions = {}): CaptureRecord[] {
	const scope = options.scope ?? 'all';
	const unlabeledOnly = options.unlabeledOnly ?? true;
	const includeSkipped = options.includeSkipped ?? false;
	const sourceMeta = new Map((options.sources ?? []).map(row => [row.source, row]));
	return captures
		.filter(capture => matchesScope(capture, scope, sourceMeta))
		.filter(capture => includeSkipped || capture.evalSkip !== true)
		.filter(capture => !unlabeledOnly || capture.label === null)
		.slice()
		.sort(compareQueueCaptures);
}

function matchesScope(
	capture: CaptureRecord,
	scope: RatingQueueScope,
	sourceMeta: Map<SourceKey, Pick<SourceEvalRow, 'source' | 'tracked' | 'type'>>,
): boolean {
	if (scope === 'all') return true;
	if (!capture.source) return false;
	if (scope === 'blogs') return capture.source.startsWith('blog:');
	if (scope === 'youtube') return capture.source.startsWith('youtube:');
	const row = sourceMeta.get(capture.source);
	if (scope === 'tracked') return row?.tracked === true;
	if (scope === 'untracked') return row?.tracked === false;
	return capture.source === scope;
}

function compareQueueCaptures(a: CaptureRecord, b: CaptureRecord): number {
	const aLabeled = a.label !== null;
	const bLabeled = b.label !== null;
	if (aLabeled !== bLabeled) return aLabeled ? 1 : -1;
	if (a.created !== b.created) return b.created - a.created;
	return a.file.path.localeCompare(b.file.path);
}
