// Search-latency-durability WP-3: name the cause of every non-success search, from evidence only.
//
// Pure (no obsidian import) so tests can import it directly. The law (audit finding 7): the text
// defaults to the ORIGINAL error unless a health snapshot supplies a specific, supported cause. A
// probe that did not answer is not proof of an outage — it maps only to the honest "starting or
// unavailable", never "down"/"unreachable". Absent fields (an older companion) never yield a cause.

import { SearchHealth, SearchHealthProbe, SearchMemorySnapshot, SearchResponse, SearchServiceUnavailableError } from './types';

export const CAUSE_STARTING_OR_UNAVAILABLE = 'Search companion starting or unavailable';
export const CAUSE_SEMANTIC_REBUILDING = 'semantic index rebuilding';
export const CAUSE_INDEXING = 'indexing in progress';

export function formatBytes(bytes: number): string {
	const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	let value = bytes;
	let unit = 0;
	while (Math.abs(value) >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function memoryCause(memory: SearchMemorySnapshot | undefined): string | null {
	if (!memory || (memory.pressure !== 'pressure' && memory.pressure !== 'exhausted')) return null;
	const limit = memory.limitBytes === null ? 'no limit' : `limit ${formatBytes(memory.limitBytes)}`;
	return `under memory pressure (swap ${formatBytes(memory.swapBytes)}, ${limit})`;
}

/**
 * Every supported cause the health snapshot evidences, in precedence order: semantic rebuild,
 * then indexing, then memory pressure. All that fire are reported (joined) rather than one
 * winning silently — they are independent facts and often co-occur (a rebuild under pressure).
 */
export function healthCauses(health: SearchHealth): string[] {
	const causes: string[] = [];
	const vector = health.vector?.status;
	if (vector === 'building' || vector === 'stale') causes.push(CAUSE_SEMANTIC_REBUILDING);
	if (health.indexing?.flushActive === true) causes.push(CAUSE_INDEXING);
	const memory = memoryCause(health.memory);
	if (memory) causes.push(memory);
	return causes;
}

/** One-line probe summary for the `logWarn` timeout breadcrumb. */
export function summarizeHealthProbe(probe: SearchHealthProbe): string {
	if (!probe.answered) return `no answer (${probe.error})`;
	const h = probe.health;
	const parts = [
		`vector ${h.vector?.status ?? 'n/a'}`,
		`flushActive ${h.indexing ? String(h.indexing.flushActive) : 'n/a'}`,
	];
	if (h.memory) {
		const limit = h.memory.limitBytes === null ? 'none' : formatBytes(h.memory.limitBytes);
		parts.push(`memory ${h.memory.pressure} (swap ${formatBytes(h.memory.swapBytes)}, limit ${limit})`);
	} else {
		parts.push('memory n/a');
	}
	return parts.join(', ');
}

export interface SearchFailureDescription {
	/** Modal status line — never a bare "Search failed". */
	status: string;
	/** Status `title`: the cause plus the original error text, so evidence is never lost. */
	title: string;
	/** Notice text, carrying the same cause. */
	notice: string;
}

export function describeSearchFailure(error: unknown): SearchFailureDescription {
	const original = error instanceof Error ? error.message : String(error);
	const probe = error instanceof SearchServiceUnavailableError ? error.healthProbe : undefined;
	let cause: string | null = null;
	if (probe && !probe.answered) {
		cause = CAUSE_STARTING_OR_UNAVAILABLE;
	} else if (probe && probe.answered) {
		const causes = healthCauses(probe.health);
		if (causes.length > 0) cause = causes.join('; ');
	}
	if (!cause) {
		const text = `Search failed: ${original}`;
		return { status: text, title: original, notice: text };
	}
	const text = `Search failed: ${cause}`;
	return { status: text, title: `${cause} — ${original}`, notice: `${text} (${original})` };
}

export interface SearchPartialDescription {
	/** Status-line prefix, or '' for a complete response. */
	prefix: string;
	/** The reason, for the status `title`; null when nothing is partial. */
	reason: string | null;
}

/** WP-3: why a successful response is partial — `vectorPending` and/or `degraded`. */
export function describePartialResponse(response: Pick<SearchResponse, 'degraded' | 'vectorPending'>): SearchPartialDescription {
	const reasons: string[] = [];
	if (response.vectorPending === true) reasons.push('semantic leg pending — semantic index rebuilding');
	if (response.degraded === true) reasons.push('partial within the search time budget — indexing in progress, retry in a moment');
	if (reasons.length === 0) return { prefix: '', reason: null };
	const reason = `Partial results: ${reasons.join('; ')}`;
	return { prefix: `${reason} · `, reason };
}
