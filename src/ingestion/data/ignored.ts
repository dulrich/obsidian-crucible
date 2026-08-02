import { App } from 'obsidian';
import type CruciblePlugin from '../../main';
import { computeBlogIntakeRows, computeYoutubeIntakeRows } from './intakeSnapshot';
import type { IgnoredPostRow, IgnoredVideoRow } from '../render/types';

// WP-R4 (formerly WP-IC2): computeIgnoredPostRows / computeIgnoredVideoRows project the
// "ignored" half of the single canonical scan/metadata-join pass shared with Uncaptured
// (computeBlogIntakeRows / computeYoutubeIntakeRows, ../intakeSnapshot.ts — see that
// module's header comment for the shared skeleton and the ignored-state partition policy).
// computeUncapturedPostRows/computeUncapturedVideoRows (../uncaptured.ts) are not touched
// by this file. An ignored id absent from every scanned run (aged out of tracker
// retention) still degrades to a bare-ID row there, so Un-ignore always has something to
// act on.
export async function computeIgnoredPostRows(app: App, plugin: CruciblePlugin): Promise<IgnoredPostRow[]> {
	return (await computeBlogIntakeRows(app, plugin)).ignored;
}

export async function computeIgnoredVideoRows(app: App, plugin: CruciblePlugin): Promise<IgnoredVideoRow[]> {
	return (await computeYoutubeIntakeRows(app, plugin)).ignored;
}
