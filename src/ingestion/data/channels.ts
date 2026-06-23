import { App, TFile, TFolder, normalizePath } from 'obsidian';
import type CruciblePlugin from '../../main';
import {
	INTAKE_ROOT_YOUTUBE,
	TRACKER_GENERATED_BY_YOUTUBE,
	buildYoutubeSeenIdSet,
	feedSeenExtraSkipPrefixes,
	loadConfiguredChannels,
	parseIntakeVideos,
} from '../../orchestration/utils/feedIntake';
import { YOUTUBE_FEED_SOURCE } from '../../orchestration/utils/feedSources';
import { loadIgnoredVideoIds } from '../../orchestration/utils/ignoredIds';
import { channelDisplayName } from '../../orchestration/utils/youtube';
import { findExistingChannelAboutNote } from '../../orchestration/utils/youtubeApi';
import type { ChannelControlRow } from '../render/types';

interface ChannelAgg {
	name?: string;
	title?: string;
	// Videos the tracker has discovered for this channel (its monitored catalog).
	intakeIds: Set<string>;
	// Videos surfaced only via enrichment metadata notes — used as the count
	// universe for channels we've captured from but never tracked.
	metaIds: Set<string>;
}

// Per-channel rollup for the Channel control center, keyed by channelId. The
// count universe is the channel's tracker-discovered videos (intake); a channel
// known only through captured metadata notes falls back to those. Within that
// universe the videos partition into ignored / ingested / uncaptured so the
// counts satisfy total − ignored − uncaptured = ingested.
export async function computeChannelControlRows(app: App, plugin: CruciblePlugin): Promise<ChannelControlRow[]> {
	const root = normalizePath(plugin.settings.orchestrationYoutubeMetadataRoot || '_yt_metadata');
	const registry = await loadConfiguredChannels(app, plugin);
	const ignored = await loadIgnoredVideoIds(app);
	// Video ids that have a real capture note (a vault note carrying the video's
	// yt-video-id / source), independent of whether an enrichment metadata note
	// exists. This is what "Ingested" reflects.
	const captured = buildYoutubeSeenIdSet(app, false, undefined, feedSeenExtraSkipPrefixes(plugin, YOUTUBE_FEED_SOURCE));

	const agg = new Map<string, ChannelAgg>();
	const get = (channelId: string): ChannelAgg => {
		let entry = agg.get(channelId);
		if (!entry) {
			entry = { intakeIds: new Set(), metaIds: new Set() };
			agg.set(channelId, entry);
		}
		return entry;
	};

	// Seed with registry channels so tracked channels appear even with no videos yet.
	for (const [channelId, value] of registry) {
		get(channelId).name = value.channel.name;
	}

	// Videos discovered across tracker intake runs.
	const intakePrefix = `${INTAKE_ROOT_YOUTUBE}/`;
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(intakePrefix)) continue;
		const generatedBy: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.generated_by;
		if (generatedBy !== TRACKER_GENERATED_BY_YOUTUBE) continue;
		const content = await app.vault.read(file);
		for (const { channel, video } of parseIntakeVideos(content)) {
			const entry = get(channel.channelId);
			if (!entry.name) entry.name = channel.name;
			entry.intakeIds.add(video.videoId);
		}
	}

	// Enrichment metadata notes under the metadata root, one folder per channel.
	// These surface channels we've captured from but never tracked, and supply
	// the channel title; they do not pad a tracked channel's video total.
	const rootFolder = app.vault.getAbstractFileByPath(root);
	if (rootFolder instanceof TFolder) {
		for (const channelFolder of rootFolder.children) {
			if (!(channelFolder instanceof TFolder)) continue;
			for (const note of channelFolder.children) {
				if (!(note instanceof TFile) || note.extension !== 'md' || note.basename === 'about') continue;
				const fm = app.metadataCache.getFileCache(note)?.frontmatter;
				const channelId = typeof fm?.['channelId'] === 'string' ? fm['channelId'] : '';
				const videoId = typeof fm?.['videoId'] === 'string' ? fm['videoId'] : '';
				if (!channelId) continue;
				const entry = get(channelId);
				if (!entry.title && typeof fm?.['channelTitle'] === 'string') entry.title = fm['channelTitle'];
				if (videoId) entry.metaIds.add(videoId);
			}
		}
	}

	const rows: ChannelControlRow[] = [];
	for (const [channelId, entry] of agg) {
		// Tracked channels are measured against their tracker catalog; an
		// untracked, capture-only channel falls back to its metadata videos.
		const universe = entry.intakeIds.size > 0 ? entry.intakeIds : entry.metaIds;
		let ignoredVideos = 0;
		let ingestedVideos = 0;
		for (const id of universe) {
			if (ignored.has(id)) ignoredVideos++;
			else if (captured.has(id)) ingestedVideos++;
		}
		const uncapturedVideos = Math.max(0, universe.size - ingestedVideos - ignoredVideos);
		const rawName = entry.name || entry.title || channelId;
		rows.push({
			channelId,
			name: channelDisplayName(rawName),
			aboutFile: findExistingChannelAboutNote(app, root, channelId),
			trackedVideos: universe.size,
			ingestedVideos,
			ignoredVideos,
			uncapturedVideos,
			tracked: registry.has(channelId),
		});
	}

	rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
	return rows;
}
