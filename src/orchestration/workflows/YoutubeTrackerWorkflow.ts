import { TFile, normalizePath } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { todayInTz } from '../utils/dates';
import { ensureFolder } from '../../utils';
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

		const seen = this.buildSeenIdSet(plugin);

		const fetchSettled = await Promise.allSettled(
			channels.map(c => fetchChannelFeed(c.channelId)),
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

	private buildSeenIdSet(plugin: WorkflowContext['plugin']): Set<string> {
		const app = plugin.app;
		const seen = new Set<string>();
		for (const file of app.vault.getMarkdownFiles()) {
			if (file.path.startsWith(QUEUE_SCAN_SKIP_PREFIX)) continue;
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;
			ingestProperty(fm['youtube-id'], seen, false);
			ingestProperty(fm['source'], seen, true);
		}
		return seen;
	}

	private async writeIntakeNote(
		plugin: WorkflowContext['plugin'],
		outcomes: ChannelOutcome[],
		totalNew: number,
	): Promise<string> {
		const app = plugin.app;
		const date = todayInTz(plugin.settings.orchestrationTimezone);
		const path = normalizePath(`${INTAKE_ROOT}/${date}.md`);
		await ensureFolder(app, INTAKE_ROOT);

		const failedChannels = outcomes.filter(o => o.error);
		const channelsWithNew = outcomes.filter(o => o.newVideos.length > 0).length;

		const fm = [
			'---',
			`date: ${date}`,
			'generated_by: orchestrator/youtube_tracker',
			`channels_total: ${outcomes.length}`,
			`channels_with_new: ${channelsWithNew}`,
			`videos_total: ${totalNew}`,
			`channels_failed: ${failedChannels.length}`,
			'---',
			'',
		].join('\n');

		const sections: string[] = [`# YouTube intake — ${date}`, ''];

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

		const existing = app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await app.vault.modify(existing, body);
		} else {
			await app.vault.create(path, body);
		}
		return path;
	}
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
