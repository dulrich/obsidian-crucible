import { App, TFile, normalizePath } from 'obsidian';
import type CruciblePlugin from '../../main';
import {
	ChannelEntry,
	RemoteVideo,
	extractVideoIdFromUrl,
	parseChannelsTable,
} from './youtube';

export const INTAKE_ROOT_YOUTUBE = '_crucible/orchestration/youtube/new-videos';
export const QUEUE_SCAN_SKIP_PREFIX_YOUTUBE = '_crucible/orchestration/';
export const TRACKER_GENERATED_BY_YOUTUBE = 'orchestrator/youtube_tracker';
export const CONSOLIDATE_GENERATED_BY_YOUTUBE = 'orchestrator/youtube_tracker_consolidate';

export interface YoutubeChannelOutcome {
	channel: ChannelEntry;
	newVideos: RemoteVideo[];
	error?: string;
}

export interface YoutubeConsolidationScan {
	outcomes: YoutubeChannelOutcome[];
	runsScanned: number;
	videosSeenInRuns: number;
}

export interface YoutubeIntakeVideoEntry {
	channel: ChannelEntry;
	video: RemoteVideo;
}

export interface YoutubeIntakeRunStat {
	file: TFile;
	runAt: string;
	channelsTotal: number;
	channelsWithNew: number;
	videosTotal: number;
	channelsFailed: number;
	generatedBy: string;
}

export function buildYoutubeSeenIdSet(app: App, diffMode: boolean): Set<string> {
	const seen = new Set<string>();
	const intakePrefix = `${INTAKE_ROOT_YOUTUBE}/`;
	for (const file of app.vault.getMarkdownFiles()) {
		const inIntake = file.path.startsWith(intakePrefix);
		const inSkip = file.path.startsWith(QUEUE_SCAN_SKIP_PREFIX_YOUTUBE);
		if (inSkip && !(diffMode && inIntake)) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;
		ingestVideoIdProperty(fm['yt-video-id'], seen, false);
		ingestVideoIdProperty(fm['source'], seen, true);
		if (diffMode && inIntake) {
			ingestVideoIdProperty(fm['yt-video-ids'], seen, false);
		}
	}
	return seen;
}

export async function loadConfiguredChannels(
	app: App,
	plugin: CruciblePlugin,
): Promise<Map<string, { channel: ChannelEntry; index: number }>> {
	const out = new Map<string, { channel: ChannelEntry; index: number }>();
	const registryPath = normalizePath(plugin.settings.orchestrationYoutubeChannelsNote);
	const registryFile = app.vault.getAbstractFileByPath(registryPath);
	if (!(registryFile instanceof TFile)) return out;
	const content = await app.vault.read(registryFile);
	const entries = parseChannelsTable(content);
	entries.forEach((channel, index) => out.set(channel.channelId, { channel, index }));
	return out;
}

export async function scanYoutubeTrackerRuns(
	app: App,
	seenInVault: Set<string>,
	configuredChannels: Map<string, { channel: ChannelEntry; index: number }>,
): Promise<YoutubeConsolidationScan> {
	const intakePrefix = `${INTAKE_ROOT_YOUTUBE}/`;
	const intakeFiles = app.vault.getMarkdownFiles()
		.filter(file => file.path.startsWith(intakePrefix))
		.sort((a, b) => a.path.localeCompare(b.path));

	const byId = new Map<string, YoutubeIntakeVideoEntry>();
	let runsScanned = 0;
	let videosSeenInRuns = 0;

	for (const file of intakeFiles) {
		const content = await app.vault.read(file);
		const generatedBy: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.generated_by;
		const isTrackerRun = generatedBy === TRACKER_GENERATED_BY_YOUTUBE
			|| frontmatterHasGeneratedBy(content, TRACKER_GENERATED_BY_YOUTUBE);
		if (!isTrackerRun) continue;
		runsScanned++;

		for (const entry of parseIntakeVideos(content)) {
			videosSeenInRuns++;
			const configured = configuredChannels.get(entry.channel.channelId);
			if (!configured) continue;
			if (seenInVault.has(entry.video.videoId) || byId.has(entry.video.videoId)) continue;
			byId.set(entry.video.videoId, { channel: configured.channel, video: entry.video });
		}
	}

	const byChannel = new Map<string, YoutubeChannelOutcome>();
	for (const entry of byId.values()) {
		const existing = byChannel.get(entry.channel.channelId);
		if (existing) {
			existing.newVideos.push(entry.video);
		} else {
			byChannel.set(entry.channel.channelId, {
				channel: entry.channel,
				newVideos: [entry.video],
			});
		}
	}

	const outcomes = Array.from(byChannel.values()).sort((a, b) => {
		const ai = configuredChannels.get(a.channel.channelId)?.index ?? Number.MAX_SAFE_INTEGER;
		const bi = configuredChannels.get(b.channel.channelId)?.index ?? Number.MAX_SAFE_INTEGER;
		return ai - bi;
	});

	return { outcomes, runsScanned, videosSeenInRuns };
}

export function listYoutubeIntakeRuns(app: App): YoutubeIntakeRunStat[] {
	const intakePrefix = `${INTAKE_ROOT_YOUTUBE}/`;
	const out: YoutubeIntakeRunStat[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(intakePrefix)) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;
		const generatedBy = stringOf(fm['generated_by']);
		if (!generatedBy) continue;
		if (generatedBy !== TRACKER_GENERATED_BY_YOUTUBE && generatedBy !== CONSOLIDATE_GENERATED_BY_YOUTUBE) continue;
		out.push({
			file,
			runAt: stringOf(fm['run_at']) ?? '',
			channelsTotal: numberOf(fm['channels_total']),
			channelsWithNew: numberOf(fm['channels_with_new']),
			videosTotal: numberOf(fm['videos_total']),
			channelsFailed: numberOf(fm['channels_failed']),
			generatedBy,
		});
	}
	out.sort((a, b) => b.runAt.localeCompare(a.runAt));
	return out;
}

export function parseIntakeVideos(content: string): YoutubeIntakeVideoEntry[] {
	const entries: YoutubeIntakeVideoEntry[] = [];
	let currentChannel: ChannelEntry | null = null;

	for (const line of content.split(/\r?\n/)) {
		const channel = parseChannelHeading(line);
		if (channel) {
			currentChannel = channel;
			continue;
		}

		if (line.startsWith('## ')) {
			currentChannel = null;
			continue;
		}

		if (!currentChannel) continue;
		const video = parseVideoBullet(line, currentChannel.name);
		if (video) entries.push({ channel: currentChannel, video });
	}

	return entries;
}

function parseChannelHeading(line: string): ChannelEntry | null {
	const match = line.match(/^##\s+(.+)\s+\((UC[A-Za-z0-9_-]+)\)\s*$/);
	const name = match?.[1]?.trim();
	const channelId = match?.[2]?.trim();
	if (!name || !channelId) return null;
	return { name, channelId, tags: [], priority: 'normal' };
}

function parseVideoBullet(line: string, channelName: string): RemoteVideo | null {
	const match = line.match(/^- \*\*(.*)\*\* — published ([^—]+) — (https?:\/\/\S+)/);
	const rawTitle = match?.[1]?.trim();
	const publishedAt = match?.[2]?.trim();
	const url = match?.[3]?.trim();
	if (!rawTitle || !publishedAt || !url) return null;
	const videoId = extractVideoIdFromUrl(url);
	if (!videoId) return null;
	return {
		videoId,
		title: unescapeBrackets(rawTitle),
		publishedAt,
		channelName,
		url,
	};
}

function unescapeBrackets(text: string): string {
	return text.replace(/\\\[/g, '[').replace(/\\\]/g, ']');
}

function frontmatterHasGeneratedBy(content: string, expected: string): boolean {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	const frontmatter = match?.[1];
	if (!frontmatter) return false;
	return frontmatter
		.split(/\r?\n/)
		.some(line => line.trim() === `generated_by: ${expected}`);
}

function ingestVideoIdProperty(value: unknown, seen: Set<string>, urlMode: boolean): void {
	if (typeof value === 'string') {
		addVideoId(value, seen, urlMode);
	} else if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === 'string') addVideoId(item, seen, urlMode);
		}
	}
}

function addVideoId(value: string, seen: Set<string>, urlMode: boolean): void {
	const trimmed = value.trim();
	if (!trimmed) return;
	if (urlMode) {
		const id = extractVideoIdFromUrl(trimmed);
		if (id) seen.add(id);
	} else if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
		seen.add(trimmed);
	}
}

function stringOf(value: unknown): string | null {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return trimmed ? trimmed : null;
	}
	return null;
}

function numberOf(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return 0;
}
