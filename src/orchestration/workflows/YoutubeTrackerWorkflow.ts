import { TFile, normalizePath } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { nowTimeInTz, todayInTz } from '../utils/dates';
import { ensureFolder } from '../../utils';
import { insertFrontmatterPropertyAfter, updateFrontmatter } from '../../frontmatter';
import {
	ChannelEntry,
	EXAMPLE_CHANNELS_TABLE,
	RemoteVideo,
	extractVideoIdFromUrl,
	fetchChannelFeed,
	parseChannelsTable,
} from '../utils/youtube';

const INTAKE_ROOT = '_crucible/orchestration/youtube/new-videos';
const QUEUE_SCAN_SKIP_PREFIX = '_crucible/orchestration/';
const FEED_FETCH_CONCURRENCY = 4;
const FEED_FETCH_MIN_INTERVAL_MS = 250;

interface ChannelOutcome {
	channel: ChannelEntry;
	newVideos: RemoteVideo[];
	error?: string;
}

export class YoutubeTrackerWorkflow implements Workflow {
	async run(_job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const app = plugin.app;
		const registryPath = normalizePath(plugin.settings.orchestrationYoutubeChannelsNote);

		const registryFile = app.vault.getAbstractFileByPath(registryPath);
		if (!(registryFile instanceof TFile)) {
			await this.createExampleRegistry(plugin, registryPath);
			return {
				status: 'failed',
				error: `Created registry at ${registryPath}. Add channels and re-enqueue.`,
			};
		}

		const registryContent = await app.vault.read(registryFile);
		const channels = parseChannelsTable(registryContent);

		if (channels.length === 0) {
			const intakePath = await this.writeIntakeNote(plugin, [], 0);
			return {
				status: 'done',
				outputPaths: [intakePath],
				notes: `Registry at ${registryPath} has no channels. Wrote empty intake.`,
			};
		}

		await this.canonicalizeDetectedIds(plugin);

		const diffMode = plugin.settings.orchestrationYoutubeTrackerDiffMode !== false;
		const seen = this.buildSeenIdSet(plugin, diffMode);

		const fetchSettled = await rateLimitedAllSettled(
			channels,
			c => fetchChannelFeed(c.channelId),
			FEED_FETCH_CONCURRENCY,
			FEED_FETCH_MIN_INTERVAL_MS,
		);

		const outcomes: ChannelOutcome[] = channels.map((channel, i) => {
			const settled = fetchSettled[i];
			if (!settled || settled.status === 'rejected') {
				const reason = settled?.status === 'rejected' ? describeReason(settled.reason) : 'unknown';
				return { channel, newVideos: [], error: reason };
			}
			const fresh = settled.value.filter(v => !seen.has(v.videoId));
			return { channel, newVideos: fresh };
		});

		const failedCount = outcomes.filter(o => o.error).length;
		const totalNew = outcomes.reduce((sum, o) => sum + o.newVideos.length, 0);

		const writeEmpty = plugin.settings.orchestrationYoutubeTrackerWriteEmptyRuns === true;
		if (totalNew === 0 && failedCount === 0 && !writeEmpty) {
			return {
				status: 'done',
				outputPaths: [],
				notes: `No new videos; intake file not written (set "Write empty intake files" to keep an audit trail).`,
			};
		}

		const intakePath = await this.writeIntakeNote(plugin, outcomes, totalNew);

		if (failedCount === channels.length) {
			return {
				status: 'failed',
				error: `All ${channels.length} channel feeds failed to fetch.`,
				outputPaths: [intakePath],
			};
		}

		const summaryParts = [
			`Channels: ${channels.length} (${failedCount} failed)`,
			`New videos: ${totalNew}`,
		];
		const notes = failedCount > 0
			? `Partial: ${summaryParts.join('; ')}`
			: summaryParts.join('; ');

		return {
			status: 'done',
			outputPaths: [intakePath],
			notes,
		};
	}

	private async createExampleRegistry(plugin: WorkflowContext['plugin'], path: string): Promise<void> {
		const slashIdx = path.lastIndexOf('/');
		if (slashIdx > 0) {
			const folder = path.slice(0, slashIdx);
			await ensureFolder(plugin.app, folder);
		}
		const existing = plugin.app.vault.getAbstractFileByPath(path);
		if (existing) return;
		await plugin.app.vault.create(path, EXAMPLE_CHANNELS_TABLE);
	}

	private async canonicalizeDetectedIds(plugin: WorkflowContext['plugin']): Promise<void> {
		const app = plugin.app;
		for (const file of app.vault.getMarkdownFiles()) {
			if (file.path.startsWith(QUEUE_SCAN_SKIP_PREFIX)) continue;
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;
			const existing: unknown = fm['yt-video-id'];
			if (typeof existing === 'string' && existing.trim()) continue;
			const detected = detectVideoIdSource(fm);
			if (!detected) continue;
			await updateFrontmatter(app, file, current => {
				const present = current['yt-video-id'];
				if (typeof present === 'string' && present.trim()) return;
				insertFrontmatterPropertyAfter(current, detected.sourceKey, 'yt-video-id', detected.id);
			});
		}
	}

	private buildSeenIdSet(plugin: WorkflowContext['plugin'], diffMode: boolean): Set<string> {
		const app = plugin.app;
		const seen = new Set<string>();
		const intakePrefix = `${INTAKE_ROOT}/`;
		for (const file of app.vault.getMarkdownFiles()) {
			const inIntake = file.path.startsWith(intakePrefix);
			const inSkip = file.path.startsWith(QUEUE_SCAN_SKIP_PREFIX);
			if (inSkip && !(diffMode && inIntake)) continue;
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;
			ingestProperty(fm['yt-video-id'], seen, false);
			ingestProperty(fm['source'], seen, true);
			if (diffMode && inIntake) {
				ingestProperty(fm['video_ids'], seen, false);
			}
		}
		return seen;
	}

	private async writeIntakeNote(
		plugin: WorkflowContext['plugin'],
		outcomes: ChannelOutcome[],
		totalNew: number,
	): Promise<string> {
		const app = plugin.app;
		const tz = plugin.settings.orchestrationTimezone;
		const date = todayInTz(tz);
		const time = nowTimeInTz(tz);
		const displayTime = time.replace(/-/g, ':');
		const path = await this.allocateIntakePath(app, date, time);
		await ensureFolder(app, INTAKE_ROOT);

		const failedChannels = outcomes.filter(o => o.error);
		const channelsWithNew = outcomes.filter(o => o.newVideos.length > 0).length;
		const videoIds = outcomes.flatMap(o => o.newVideos.map(v => v.videoId));

		const fmLines = [
			'---',
			`date: ${date}`,
			`run_at: ${date}T${time}`,
			'generated_by: orchestrator/youtube_tracker',
			`channels_total: ${outcomes.length}`,
			`channels_with_new: ${channelsWithNew}`,
			`videos_total: ${totalNew}`,
			`channels_failed: ${failedChannels.length}`,
		];
		if (videoIds.length > 0) {
			fmLines.push('video_ids:');
			for (const id of videoIds) fmLines.push(`  - ${id}`);
		} else {
			fmLines.push('video_ids: []');
		}
		fmLines.push('---', '');
		const fm = fmLines.join('\n');

		const sections: string[] = [`# YouTube intake — ${date} ${displayTime}`, ''];

		if (outcomes.length === 0) {
			sections.push('_No channels configured._');
		} else {
			const withNew = outcomes.filter(o => o.newVideos.length > 0);
			if (withNew.length === 0) {
				sections.push('_No new videos across all channels._', '');
			}
			for (const o of withNew) {
				sections.push(`## ${o.channel.name} (${o.channel.channelId})`);
				for (const v of o.newVideos) {
					const published = (v.publishedAt || '').slice(0, 10) || 'unknown';
					sections.push(`- **${escapeBrackets(v.title)}** — published ${published} — ${v.url}`);
				}
				sections.push('');
			}
		}

		if (failedChannels.length > 0) {
			sections.push('## Failed channels', '');
			for (const o of failedChannels) {
				sections.push(`- ${o.channel.name} (${o.channel.channelId}): ${o.error}`);
			}
			sections.push('');
		}

		const body = `${fm}${sections.join('\n').replace(/\n+$/, '\n')}`;

		await app.vault.create(path, body);
		return path;
	}

	private async allocateIntakePath(app: WorkflowContext['plugin']['app'], date: string, time: string): Promise<string> {
		const base = `${INTAKE_ROOT}/${date}T${time}`;
		let candidate = normalizePath(`${base}.md`);
		let suffix = 1;
		while (app.vault.getAbstractFileByPath(candidate) instanceof TFile) {
			candidate = normalizePath(`${base}-${suffix}.md`);
			suffix += 1;
		}
		return candidate;
	}
}

function detectVideoIdSource(fm: Record<string, unknown>): { id: string; sourceKey: string } | null {
	const fromSource = firstUrlId(fm['source']);
	if (fromSource) return { id: fromSource, sourceKey: 'source' };
	return null;
}

function firstUrlId(value: unknown): string | null {
	if (typeof value === 'string') {
		return extractVideoIdFromUrl(value.trim());
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item !== 'string') continue;
			const id = extractVideoIdFromUrl(item.trim());
			if (id) return id;
		}
	}
	return null;
}

function ingestProperty(value: unknown, seen: Set<string>, urlMode: boolean): void {
	if (typeof value === 'string') {
		addId(value, seen, urlMode);
	} else if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === 'string') addId(item, seen, urlMode);
		}
	}
}

function addId(value: string, seen: Set<string>, urlMode: boolean): void {
	const trimmed = value.trim();
	if (!trimmed) return;
	if (urlMode) {
		const id = extractVideoIdFromUrl(trimmed);
		if (id) seen.add(id);
	} else if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
		seen.add(trimmed);
	}
}

function describeReason(reason: unknown): string {
	if (reason instanceof Error) return reason.message;
	if (typeof reason === 'string') return reason;
	return 'unknown error';
}

function escapeBrackets(text: string): string {
	return text.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

type SettledResult<R> = { status: 'fulfilled'; value: R } | { status: 'rejected'; reason: unknown };

async function rateLimitedAllSettled<T, R>(
	items: T[],
	fn: (item: T) => Promise<R>,
	maxParallel: number,
	minIntervalMs: number,
): Promise<SettledResult<R>[]> {
	const results: SettledResult<R>[] = items.map(() => ({ status: 'rejected', reason: new Error('not started') }));
	let nextIdx = 0;
	let nextStartAllowed = 0;

	const reserveSlot = (): number => {
		const now = Date.now();
		const start = Math.max(now, nextStartAllowed);
		nextStartAllowed = start + minIntervalMs;
		return start - now;
	};

	const worker = async (): Promise<void> => {
		for (;;) {
			const i = nextIdx++;
			const item = items[i];
			if (i >= items.length || item === undefined) return;
			const wait = reserveSlot();
			if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
			try {
				results[i] = { status: 'fulfilled', value: await fn(item) };
			} catch (reason) {
				results[i] = { status: 'rejected', reason };
			}
		}
	};

	const workerCount = Math.min(Math.max(1, maxParallel), items.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}
