import { App } from 'obsidian';
import type CruciblePlugin from '../../main';
import { coerceVideoId } from '../../orchestration/utils/youtubeApi';
import { loadIgnoredVideoIds } from '../../orchestration/utils/ignoredIds';
import type { UncapturedPostRow, UncapturedVideoRow, YoutubeNoMetadataRow } from '../render/types';
import { computeBlogIntakeRows, computeYoutubeIntakeRows } from './intakeSnapshot';

// WP-R4: Blog posts seen in tracker runs but not yet captured as a vault note — the
// "not ignored" half of computeBlogIntakeRows' single scan/metadata-join pass
// (./intakeSnapshot.ts, which also backs computeIgnoredPostRows in ./ignored.ts).
export async function computeUncapturedPostRows(app: App, plugin: CruciblePlugin): Promise<UncapturedPostRow[]> {
	return (await computeBlogIntakeRows(app, plugin)).uncaptured;
}

// WP-R4: YouTube videos seen in tracker runs but not yet captured as a vault note, each
// annotated with its enrichment metadata note (if any) and duration — the "not ignored"
// half of computeYoutubeIntakeRows' single scan/metadata-join pass (./intakeSnapshot.ts,
// which also backs computeIgnoredVideoRows in ./ignored.ts).
export async function computeUncapturedVideoRows(app: App, plugin: CruciblePlugin): Promise<UncapturedVideoRow[]> {
	return (await computeYoutubeIntakeRows(app, plugin)).uncaptured;
}

// Scans every markdown note for the backlog: a usable `yt-video-id` in
// frontmatter with no `yt-metadata` link yet. Keying on `yt-video-id` matches
// the "fetch video metadata for active note" command. Captures whose video id
// has been ignored (e.g. the video was deleted/unavailable) are dropped from the
// backlog — the note stays in the vault, but it no longer nags for enrichment.
export async function computeYoutubeNoMetadataRows(app: App): Promise<YoutubeNoMetadataRow[]> {
	const ignored = await loadIgnoredVideoIds(app);
	const out: YoutubeNoMetadataRow[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;
		const videoId = coerceVideoId(fm['yt-video-id']);
		if (!videoId) continue;
		if (ignored.has(videoId)) continue;
		if (isYtMetadataLinked(fm['yt-metadata'])) continue;
		const createdRaw: unknown = fm['created'];
		const created = typeof createdRaw === 'string' ? Date.parse(createdRaw) || file.stat.ctime : file.stat.ctime;
		out.push({ file, title: file.basename, created, videoId });
	}
	return out;
}

// True when `yt-metadata` already carries a link (a non-empty string, or an
// array with at least one non-empty entry). Such notes are excluded from the
// backlog.
function isYtMetadataLinked(value: unknown): boolean {
	if (typeof value === 'string') return value.trim().length > 0;
	if (Array.isArray(value)) return value.some(v => typeof v === 'string' && v.trim().length > 0);
	return false;
}
