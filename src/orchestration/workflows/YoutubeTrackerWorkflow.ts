import { TFile, normalizePath } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { nowTimeInTz, todayInTz } from '../utils/dates';
import { ensureFolder } from '../../utils';
import { insertFrontmatterPropertyAfter, updateFrontmatter } from '../../frontmatter';
import { rateLimitedAllSettled } from '../utils/rateLimit';
import {
	ChannelEntry,
	EXAMPLE_CHANNELS_TABLE,
	RemoteVideo,
	extractVideoIdFromUrl,
	fetchChannelFeed,
	parseChannelsTable,
} from '../utils/youtube';
import {
	CONSOLIDATE_GENERATED_BY_YOUTUBE,
	INTAKE_ROOT_YOUTUBE,
	QUEUE_SCAN_SKIP_PREFIX_YOUTUBE,
	TRACKER_GENERATED_BY_YOUTUBE,
	YoutubeChannelOutcome,
	buildYoutubeSeenIdSet,
	loadConfiguredChannels,
	scanYoutubeTrackerRuns,
} from '../utils/youtubeIntake';
import { loadIgnoredVideoIds } from '../utils/ignoredIds';

const FEED_FETCH_CONCURRENCY = 4;
const FEED_FETCH_MIN_INTERVAL_MS = 250;

const PRIORITY_ORDER: Record<ChannelEntry['priority'], number> = { high: 0, normal: 1, low: 2 };

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
		const seen = buildYoutubeSeenIdSet(app, diffMode, await loadIgnoredVideoIds(app));

		const fetchSettled = await rateLimitedAllSettled(
			channels,
			c => fetchChannelFeed(c.channelId),
			FEED_FETCH_CONCURRENCY,
			FEED_FETCH_MIN_INTERVAL_MS,
		);

		const outcomes: YoutubeChannelOutcome[] = channels.map((channel, i) => {
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

	protected async canonicalizeDetectedIds(plugin: WorkflowContext['plugin']): Promise<void> {
		const app = plugin.app;
		for (const file of app.vault.getMarkdownFiles()) {
			if (file.path.startsWith(QUEUE_SCAN_SKIP_PREFIX_YOUTUBE)) continue;
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

	protected async writeIntakeNote(
		plugin: WorkflowContext['plugin'],
		outcomes: YoutubeChannelOutcome[],
		totalNew: number,
		generatedBy = TRACKER_GENERATED_BY_YOUTUBE,
	): Promise<string> {
		const app = plugin.app;
		const tz = plugin.settings.orchestrationTimezone;
		const date = todayInTz(tz);
		const time = nowTimeInTz(tz);
		const displayTime = time.replace(/-/g, ':');
		const path = await this.allocateIntakePath(app, date, time);
		await ensureFolder(app, INTAKE_ROOT_YOUTUBE);

		const sortedOutcomes = [...outcomes].sort(
			(a, b) => PRIORITY_ORDER[a.channel.priority] - PRIORITY_ORDER[b.channel.priority],
		);

		const failedChannels = sortedOutcomes.filter(o => o.error);
		const channelsWithNew = sortedOutcomes.filter(o => o.newVideos.length > 0).length;
		const videoIds = sortedOutcomes.flatMap(o => o.newVideos.map(v => v.videoId));

		const fmLines = [
			'---',
			`date: ${date}`,
			`run_at: ${date}T${displayTime}`,
			`generated_by: ${generatedBy}`,
			`channels_total: ${sortedOutcomes.length}`,
			`channels_with_new: ${channelsWithNew}`,
			`videos_total: ${totalNew}`,
			`channels_failed: ${failedChannels.length}`,
		];
		if (videoIds.length > 0) {
			fmLines.push('yt-video-ids:');
			for (const id of videoIds) fmLines.push(`  - ${id}`);
		} else {
			fmLines.push('yt-video-ids: []');
		}
		fmLines.push('---', '');
		const fm = fmLines.join('\n');

		const sections: string[] = [`# YouTube intake — ${date} ${displayTime}`, ''];

		if (sortedOutcomes.length === 0) {
			sections.push('_No channels configured._');
		} else {
			const withNew = sortedOutcomes.filter(o => o.newVideos.length > 0);
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
		const base = `${INTAKE_ROOT_YOUTUBE}/${date}T${time}`;
		let candidate = normalizePath(`${base}.md`);
		let suffix = 1;
		while (app.vault.getAbstractFileByPath(candidate) instanceof TFile) {
			candidate = normalizePath(`${base}-${suffix}.md`);
			suffix += 1;
		}
		return candidate;
	}
}

export class YoutubeTrackerConsolidateWorkflow extends YoutubeTrackerWorkflow {
	async run(_job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const app = plugin.app;

		await this.canonicalizeDetectedIds(plugin);
		const seenInVault = buildYoutubeSeenIdSet(app, false, await loadIgnoredVideoIds(app));
		const configuredChannels = await loadConfiguredChannels(app, plugin);
		const scan = await scanYoutubeTrackerRuns(app, seenInVault, configuredChannels);
		const totalNew = scan.outcomes.reduce((sum, o) => sum + o.newVideos.length, 0);

		if (scan.runsScanned === 0) {
			return {
				status: 'done',
				outputPaths: [],
				notes: 'No regular YouTube tracker intake runs found; consolidated intake file not written.',
			};
		}

		if (totalNew === 0) {
			return {
				status: 'done',
				outputPaths: [],
				notes: `No videos from ${scan.runsScanned} regular YouTube tracker run(s) are missing from the vault; consolidated intake file not written.`,
			};
		}

		const intakePath = await this.writeIntakeNote(plugin, scan.outcomes, totalNew, CONSOLIDATE_GENERATED_BY_YOUTUBE);
		return {
			status: 'done',
			outputPaths: [intakePath],
			notes: `Runs scanned: ${scan.runsScanned}; Videos in runs: ${scan.videosSeenInRuns}; Still missing: ${totalNew}`,
		};
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

function describeReason(reason: unknown): string {
	if (reason instanceof Error) return reason.message;
	if (typeof reason === 'string') return reason;
	return 'unknown error';
}

function escapeBrackets(text: string): string {
	return text.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

// Re-export RemoteVideo for callers that imported it from this module previously.
export type { RemoteVideo };
