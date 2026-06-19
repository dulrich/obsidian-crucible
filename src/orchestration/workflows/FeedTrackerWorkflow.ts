import { TFile, normalizePath } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { nowTimeInTz, todayInTz } from '../utils/dates';
import { ensureFolder } from '../../utils';
import { insertFrontmatterPropertyAfter, updateFrontmatter } from '../../frontmatter';
import { rateLimitedAllSettled } from '../utils/rateLimit';
import { buildBlogBulletSuffix } from '../utils/blogs';
import type { BlogRowError, RemotePost } from '../utils/blogs';
import { blogMetadataRoot, ensureBlogMetadataNote, findExistingBlogMetadataNote } from '../utils/blogsApi';
import type { RemoteVideo } from '../utils/youtube';
import {
	BLOGS_FEED_SOURCE,
	FeedSource,
	FeedRowError,
	YOUTUBE_FEED_SOURCE,
	yamlScalar,
} from '../utils/feedSources';
import {
	FeedOutcome,
	buildFeedSeenIdSet,
	loadConfiguredFeedEntries,
	scanFeedTrackerRuns,
} from '../utils/feedIntake';
import { loadIgnoredBlogIds, loadIgnoredVideoIds } from '../utils/ignoredIds';

const FEED_FETCH_CONCURRENCY = 4;
const FEED_FETCH_MIN_INTERVAL_MS = 250;

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

type Plugin = WorkflowContext['plugin'];

export class FeedTrackerWorkflow<Entry, Item> implements Workflow {
	constructor(protected readonly source: FeedSource<Entry, Item>) {}

	async run(_job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const app = plugin.app;
		const registryPath = normalizePath(this.source.registryPath(plugin));

		const registryFile = app.vault.getAbstractFileByPath(registryPath);
		if (!(registryFile instanceof TFile)) {
			await this.createExampleRegistry(plugin, registryPath);
			return {
				status: 'failed',
				error: `Created registry at ${registryPath}. Add ${this.source.missingRegistryNoun} and re-enqueue.`,
			};
		}

		const registryContent = await app.vault.read(registryFile);
		const { entries, rowErrors } = this.source.parseRegistry(registryContent);

		if (entries.length === 0 && rowErrors.length === 0) {
			const intakePath = await this.writeIntakeNote(plugin, [], 0, []);
			return {
				status: 'done',
				outputPaths: [intakePath],
				notes: `Registry at ${registryPath} has no ${this.source.missingRegistryNoun}. Wrote empty intake.`,
			};
		}

		await this.canonicalizeDetectedIds(plugin);

		const diffMode = this.diffMode(plugin);
		const hostRules = this.source.buildHostRules?.(entries);
		const seen = buildFeedSeenIdSet(plugin.app, this.source, diffMode, await this.loadIgnoredIds(plugin), hostRules);

		const fetchSettled = await rateLimitedAllSettled(
			entries,
			entry => this.source.fetchFeed(entry),
			FEED_FETCH_CONCURRENCY,
			FEED_FETCH_MIN_INTERVAL_MS,
		);

		const outcomes: FeedOutcome<Entry, Item>[] = entries.map((entry, i) => {
			const settled = fetchSettled[i];
			if (!settled || settled.status === 'rejected') {
				const reason = settled?.status === 'rejected' ? describeReason(settled.reason) : 'unknown';
				return { entry, newItems: [], error: reason };
			}
			const fresh = settled.value.filter(item => !this.source.isSeen(item, seen));
			return { entry, newItems: fresh };
		});

		const failedCount = outcomes.filter(o => o.error).length;
		const totalNew = outcomes.reduce((sum, o) => sum + o.newItems.length, 0);

		// Persist enriched metadata for every fetched post lacking a file on disk —
		// not just unseen ones — and do it before the no-new early return below.
		if (this.source.kind === 'blogs') {
			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i];
				const settled = fetchSettled[i];
				if (!entry || !settled || settled.status === 'rejected') continue;
				const blogName = this.source.entryName(entry);
				for (const item of settled.value) {
					await this.persistBlogMetadataIfMissing(plugin, item as unknown as RemotePost, blogName);
				}
			}
		}

		if (totalNew === 0 && failedCount === 0 && rowErrors.length === 0 && !this.writeEmptyRuns(plugin)) {
			return {
				status: 'done',
				outputPaths: [],
				notes: this.source.noNewSkipNote,
			};
		}

		const intakePath = await this.writeIntakeNote(plugin, outcomes, totalNew, rowErrors);

		if (entries.length > 0 && failedCount === entries.length) {
			return {
				status: 'failed',
				error: this.source.allFeedsFailedError(entries.length),
				outputPaths: [intakePath],
			};
		}

		const summaryParts = this.source.summaryParts(entries.length, failedCount, totalNew, rowErrors.length);
		const notes = failedCount > 0 || rowErrors.length > 0
			? `Partial: ${summaryParts.join('; ')}`
			: summaryParts.join('; ');

		return {
			status: 'done',
			outputPaths: [intakePath],
			notes,
		};
	}

	// Writes a post's enriched-metadata note only when one does not already exist
	// on disk. Skipping existing files keeps repeat pulls idempotent (the body
	// stamps a fresh fetched_at, so an unconditional write would churn every run).
	private async persistBlogMetadataIfMissing(plugin: Plugin, post: RemotePost, blogName: string): Promise<void> {
		const root = blogMetadataRoot(plugin);
		if (await findExistingBlogMetadataNote(plugin.app, root, post.postId)) return;
		await ensureBlogMetadataNote(plugin, { ...post, blogName });
	}

	private async createExampleRegistry(plugin: Plugin, path: string): Promise<void> {
		const slashIdx = path.lastIndexOf('/');
		if (slashIdx > 0) {
			const folder = path.slice(0, slashIdx);
			await ensureFolder(plugin.app, folder);
		}
		const existing = plugin.app.vault.getAbstractFileByPath(path);
		if (existing) return;
		await plugin.app.vault.create(path, this.source.exampleTable);
	}

	protected async canonicalizeDetectedIds(plugin: Plugin): Promise<void> {
		const app = plugin.app;
		for (const file of app.vault.getMarkdownFiles()) {
			if (file.path.startsWith(this.source.queueScanSkipPrefix)) continue;
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;
			const existing: unknown = fm[this.source.fmIdKey];
			if (typeof existing === 'string' && existing.trim()) continue;
			const detected = this.detectIdSource(fm);
			if (!detected) continue;
			await updateFrontmatter(app, file, current => {
				const present = current[this.source.fmIdKey];
				if (typeof present === 'string' && present.trim()) return;
				insertFrontmatterPropertyAfter(current, detected.sourceKey, this.source.fmIdKey, detected.id);
			});
		}
	}

	protected async writeIntakeNote(
		plugin: Plugin,
		outcomes: FeedOutcome<Entry, Item>[],
		totalNew: number,
		rowErrors: FeedRowError[],
		generatedBy = this.source.trackerGeneratedBy,
	): Promise<string> {
		const app = plugin.app;
		const tz = plugin.settings.orchestrationTimezone;
		const date = todayInTz(tz);
		const time = nowTimeInTz(tz);
		const displayTime = time.replace(/-/g, ':');
		const path = await this.allocateIntakePath(app, date, time);
		await ensureFolder(app, this.source.intakeRoot);

		const sortedOutcomes = [...outcomes].sort(
			(a, b) => PRIORITY_ORDER[this.source.entryPriority(a.entry)] - PRIORITY_ORDER[this.source.entryPriority(b.entry)],
		);

		const failedEntries = sortedOutcomes.filter(o => o.error);
		const entriesWithNew = sortedOutcomes.filter(o => o.newItems.length > 0).length;
		const itemIds = sortedOutcomes.flatMap(o => o.newItems.map(item => this.source.itemId(item)));

		const fmLines = [
			'---',
			`date: ${date}`,
			`run_at: ${date}T${displayTime}`,
			`generated_by: ${generatedBy}`,
			`${this.source.totalFmKey}: ${sortedOutcomes.length}`,
			`${this.source.withNewFmKey}: ${entriesWithNew}`,
			`${this.source.itemsTotalFmKey}: ${totalNew}`,
			`${this.source.failedFmKey}: ${failedEntries.length}`,
		];
		if (this.source.kind === 'blogs') {
			fmLines.push(`rows_skipped: ${rowErrors.length}`);
		}
		if (itemIds.length > 0) {
			fmLines.push(`${this.source.itemIdsFmKey}:`);
			for (const id of itemIds) {
				fmLines.push(`  - ${this.source.kind === 'blogs' ? yamlScalar(id) : id}`);
			}
		} else {
			fmLines.push(`${this.source.itemIdsFmKey}: []`);
		}
		fmLines.push('---', '');
		const fm = fmLines.join('\n');

		const sections: string[] = [`# ${this.source.titlePrefix} — ${date} ${displayTime}`, ''];

		if (sortedOutcomes.length === 0 && rowErrors.length === 0) {
			sections.push(this.source.emptyConfiguredText);
		} else {
			const withNew = sortedOutcomes.filter(o => o.newItems.length > 0);
			if (withNew.length === 0 && rowErrors.length === 0) {
				sections.push(this.source.noNewText, '');
			}
			for (const o of withNew) {
				sections.push(`## ${this.source.entryHeading(o.entry)}`);
				for (const item of o.newItems) {
					const published = (this.source.itemPublishedAt(item) || '').slice(0, 10) || 'unknown';
					// Blogs: encode enrichment fields in a trailing comment and persist the full
					// metadata/body note at fetch time. No-op for re-parsed items (consolidate)
					// whose bodyHtml is absent.
					let suffix = '';
					if (this.source.kind === 'blogs') {
						const post = item as unknown as RemotePost;
						suffix = buildBlogBulletSuffix(post);
						await this.persistBlogMetadataIfMissing(plugin, post, this.source.entryName(o.entry));
					}
					sections.push(`- **${escapeBrackets(this.source.itemTitle(item))}** — published ${published} — ${this.source.itemUrl(item)}${suffix}`);
				}
				sections.push('');
			}
		}

		if (failedEntries.length > 0) {
			sections.push(`## ${this.source.failedHeading}`, '');
			for (const o of failedEntries) {
				sections.push(`- ${this.source.entryHeading(o.entry)}: ${o.error}`);
			}
			sections.push('');
		}

		if (this.source.kind === 'blogs' && rowErrors.length > 0) {
			sections.push('## Skipped registry rows', '');
			for (const r of rowErrors) {
				sections.push(`- ${r.name} (${r.link}) — method=${r.method}: ${r.reason}`);
			}
			sections.push('');
		}

		const body = `${fm}${sections.join('\n').replace(/\n+$/, '\n')}`;

		await app.vault.create(path, body);
		return path;
	}

	private async allocateIntakePath(app: Plugin['app'], date: string, time: string): Promise<string> {
		const base = `${this.source.intakeRoot}/${date}T${time}`;
		let candidate = normalizePath(`${base}.md`);
		let suffix = 1;
		while (app.vault.getAbstractFileByPath(candidate) instanceof TFile) {
			candidate = normalizePath(`${base}-${suffix}.md`);
			suffix += 1;
		}
		return candidate;
	}

	private diffMode(plugin: Plugin): boolean {
		if (this.source.kind === 'youtube') return plugin.settings.orchestrationYoutubeTrackerDiffMode !== false;
		return plugin.settings.orchestrationBlogsTrackerDiffMode !== false;
	}

	private writeEmptyRuns(plugin: Plugin): boolean {
		if (this.source.kind === 'youtube') return plugin.settings.orchestrationYoutubeTrackerWriteEmptyRuns === true;
		return plugin.settings.orchestrationBlogsTrackerWriteEmptyRuns === true;
	}

	protected async loadIgnoredIds(plugin: Plugin): Promise<Set<string>> {
		if (this.source.kind === 'youtube') return loadIgnoredVideoIds(plugin.app);
		return loadIgnoredBlogIds(plugin.app);
	}

	private detectIdSource(fm: Record<string, unknown>): { id: string; sourceKey: string } | null {
		const fromSource = this.source.detectSourceId(fm['source']);
		if (fromSource) return { id: fromSource, sourceKey: 'source' };
		return null;
	}
}

export class FeedTrackerConsolidateWorkflow<Entry, Item> extends FeedTrackerWorkflow<Entry, Item> {
	constructor(source: FeedSource<Entry, Item>) {
		super(source);
	}

	async run(_job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const app = plugin.app;

		await this.canonicalizeDetectedIds(plugin);
		const configuredEntries = await loadConfiguredFeedEntries(app, plugin, this.source);
		const hostRules = this.source.buildHostRules?.(
			Array.from(configuredEntries.values(), v => v.entry),
		);
		const seenInVault = buildFeedSeenIdSet(app, this.source, false, await this.loadIgnoredIds(plugin), hostRules);
		const scan = await scanFeedTrackerRuns(app, this.source, seenInVault, configuredEntries);
		const totalNew = scan.outcomes.reduce((sum, o) => sum + o.newItems.length, 0);

		if (scan.runsScanned === 0) {
			return {
				status: 'done',
				outputPaths: [],
				notes: this.source.noRegularRunsNote,
			};
		}

		if (totalNew === 0) {
			return {
				status: 'done',
				outputPaths: [],
				notes: this.source.noMissingFromRunsNote(scan.runsScanned),
			};
		}

		const intakePath = await this.writeIntakeNote(plugin, scan.outcomes, totalNew, [], this.source.consolidateGeneratedBy);
		return {
			status: 'done',
			outputPaths: [intakePath],
			notes: this.source.consolidateNotes(scan.runsScanned, scan.itemsSeenInRuns, totalNew),
		};
	}
}

export class YoutubeTrackerWorkflow extends FeedTrackerWorkflow<Parameters<typeof YOUTUBE_FEED_SOURCE.entryKey>[0], RemoteVideo> {
	constructor() {
		super(YOUTUBE_FEED_SOURCE);
	}
}

export class YoutubeTrackerConsolidateWorkflow extends FeedTrackerConsolidateWorkflow<Parameters<typeof YOUTUBE_FEED_SOURCE.entryKey>[0], RemoteVideo> {
	constructor() {
		super(YOUTUBE_FEED_SOURCE);
	}
}

export class BlogsTrackerWorkflow extends FeedTrackerWorkflow<Parameters<typeof BLOGS_FEED_SOURCE.entryKey>[0], RemotePost> {
	constructor() {
		super(BLOGS_FEED_SOURCE);
	}
}

export class BlogsTrackerConsolidateWorkflow extends FeedTrackerConsolidateWorkflow<Parameters<typeof BLOGS_FEED_SOURCE.entryKey>[0], RemotePost> {
	constructor() {
		super(BLOGS_FEED_SOURCE);
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

// Re-export legacy workflow-module item types.
export type { BlogRowError, RemotePost, RemoteVideo };
