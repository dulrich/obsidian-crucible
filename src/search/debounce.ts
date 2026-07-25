import type { CrucibleSettings } from '../types';

export const DEFAULT_SEARCH_INDEX_DEBOUNCE_MS = 5_000;
export const ACTIVE_NOTE_SEARCH_INDEX_DEBOUNCE_MS = 30_000;

export function searchIndexDebounceMs(settings: Pick<CrucibleSettings, 'searchIndexDebounceMs'>, isActiveNote: boolean): number {
	if (isActiveNote) return ACTIVE_NOTE_SEARCH_INDEX_DEBOUNCE_MS;
	const configured = Number(settings.searchIndexDebounceMs);
	if (!Number.isFinite(configured) || configured < 0) return DEFAULT_SEARCH_INDEX_DEBOUNCE_MS;
	return Math.floor(configured);
}

/**
 * Type-ahead pacing for the search modal.
 *
 * Both constants are derived from measurement against the live containerized companion on
 * the real 52,257-chunk / 5,453-path index, not picked by feel. Median `/v1/search` latency
 * by query length:
 *
 *   "c"    733ms      "cruc"      11ms
 *   "cr"   239ms      "crucible"   5ms
 *   "cru"   27ms      "the"       827ms
 *
 * The cost is driven by how many chunks the FTS query matches — the trailing term is prefix
 * expanded (`term*`), so a one- or two-character query matches most of the index and the
 * pooling CTE has to score all of it. Three characters is the cliff: 733ms -> 27ms. Below
 * `SEARCH_TYPEAHEAD_MIN_QUERY_LENGTH` the modal does not fire automatically at all; the user
 * can still force a short query with Enter or the button, which is the escape hatch that
 * keeps the gate from being a hard restriction.
 *
 * A common short word ("the") stays expensive even above the gate, so the caller must also
 * drop stale responses rather than assume they arrive in order.
 */
export const SEARCH_TYPEAHEAD_DEBOUNCE_MS = 200;
export const SEARCH_TYPEAHEAD_MIN_QUERY_LENGTH = 3;

/** True when a query is worth firing automatically as the user types. */
export function shouldAutoSearch(query: string): boolean {
	return query.trim().length >= SEARCH_TYPEAHEAD_MIN_QUERY_LENGTH;
}
