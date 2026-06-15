import type { CrucibleSettings } from '../types';

export const DEFAULT_SEARCH_INDEX_DEBOUNCE_MS = 5_000;
export const ACTIVE_NOTE_SEARCH_INDEX_DEBOUNCE_MS = 30_000;

export function searchIndexDebounceMs(settings: Pick<CrucibleSettings, 'searchIndexDebounceMs'>, isActiveNote: boolean): number {
	if (isActiveNote) return ACTIVE_NOTE_SEARCH_INDEX_DEBOUNCE_MS;
	const configured = Number(settings.searchIndexDebounceMs);
	if (!Number.isFinite(configured) || configured < 0) return DEFAULT_SEARCH_INDEX_DEBOUNCE_MS;
	return Math.floor(configured);
}
