import { TFile, normalizePath } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { nowTimeInTz, todayInTz } from '../utils/dates';
import { ensureFolder } from '../../utils';
import { insertFrontmatterPropertyAfter, updateFrontmatter } from '../../frontmatter';
import { rateLimitedAllSettled } from '../utils/rateLimit';
import {
	BlogPriority,
	BlogRowError,
	EXAMPLE_BLOGS_TABLE,
	RemotePost,
	fetchBlogFeed,
	parseBlogsTable,
	postIdFromUrl,
} from '../utils/blogs';
import {
	BlogOutcome,
	CONSOLIDATE_GENERATED_BY_BLOGS,
	INTAKE_ROOT_BLOGS,
	QUEUE_SCAN_SKIP_PREFIX_BLOGS,
	TRACKER_GENERATED_BY_BLOGS,
	buildBlogsSeenIdSet,
	isSeenPost,
	loadConfiguredBlogs,
	scanBlogsTrackerRuns,
} from '../utils/blogsIntake';

const FEED_FETCH_CONCURRENCY = 4;
const FEED_FETCH_MIN_INTERVAL_MS = 250;

const PRIORITY_ORDER: Record<BlogPriority, number> = { high: 0, normal: 1, low: 2 };

export class BlogsTrackerWorkflow implements Workflow {
	async run(_job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const app = plugin.app;
		const registryPath = normalizePath(plugin.settings.orchestrationBlogsNote);

		const registryFile = app.vault.getAbstractFileByPath(registryPath);
		if (!(registryFile instanceof TFile)) {
			await this.createExampleRegistry(plugin, registryPath);
			return {
				status: 'failed',
				error: `Created registry at ${registryPath}. Add blogs and re-enqueue.`,
			};
		}

		const registryContent = await app.vault.read(registryFile);
		const { entries: blogs, errors: rowErrors } = parseBlogsTable(registryContent);

		if (blogs.length === 0 && rowErrors.length === 0) {
			const intakePath = await this.writeIntakeNote(plugin, [], 0, [], TRACKER_GENERATED_BY_BLOGS);
			return {
				status: 'done',
				outputPaths: [intakePath],
				notes: `Registry at ${registryPath} has no blogs. Wrote empty intake.`,
			};
		}

		await this.canonicalizeDetectedIds(plugin);

		const diffMode = plugin.settings.orchestrationBlogsTrackerDiffMode !== false;
		const seen = buildBlogsSeenIdSet(app, diffMode);

		const fetchSettled = await rateLimitedAllSettled(
			blogs,
			b => fetchBlogFeed(b),
			FEED_FETCH_CONCURRENCY,
			FEED_FETCH_MIN_INTERVAL_MS,
		);

		const outcomes: BlogOutcome[] = blogs.map((blog, i) => {
			const settled = fetchSettled[i];
			if (!settled || settled.status === 'rejected') {
				const reason = settled?.status === 'rejected' ? describeReason(settled.reason) : 'unknown';
				return { blog, newPosts: [], error: reason };
			}
			const fresh = settled.value.filter(p => !isSeenPost(p, seen));
			return { blog, newPosts: fresh };
		});

		const failedCount = outcomes.filter(o => o.error).length;
		const totalNew = outcomes.reduce((sum, o) => sum + o.newPosts.length, 0);

		const writeEmpty = plugin.settings.orchestrationBlogsTrackerWriteEmptyRuns === true;
		if (totalNew === 0 && failedCount === 0 && rowErrors.length === 0 && !writeEmpty) {
			return {
				status: 'done',
				outputPaths: [],
				notes: `No new posts; intake file not written (set "Write empty intake files" to keep an audit trail).`,
			};
		}

		const intakePath = await this.writeIntakeNote(plugin, outcomes, totalNew, rowErrors, TRACKER_GENERATED_BY_BLOGS);

		if (blogs.length > 0 && failedCount === blogs.length) {
			return {
				status: 'failed',
				error: `All ${blogs.length} blog feeds failed to fetch.`,
				outputPaths: [intakePath],
			};
		}

		const summaryParts = [
			`Blogs: ${blogs.length} (${failedCount} failed)`,
			`New posts: ${totalNew}`,
		];
		if (rowErrors.length > 0) summaryParts.push(`Skipped rows: ${rowErrors.length}`);
		const notes = failedCount > 0 || rowErrors.length > 0
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
		await plugin.app.vault.create(path, EXAMPLE_BLOGS_TABLE);
	}

	protected async canonicalizeDetectedIds(plugin: WorkflowContext['plugin']): Promise<void> {
		const app = plugin.app;
		for (const file of app.vault.getMarkdownFiles()) {
			if (file.path.startsWith(QUEUE_SCAN_SKIP_PREFIX_BLOGS)) continue;
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;
			const existing: unknown = fm['post-id'];
			if (typeof existing === 'string' && existing.trim()) continue;
			const detected = detectPostIdSource(fm);
			if (!detected) continue;
			await updateFrontmatter(app, file, current => {
				const present = current['post-id'];
				if (typeof present === 'string' && present.trim()) return;
				insertFrontmatterPropertyAfter(current, detected.sourceKey, 'post-id', detected.id);
			});
		}
	}

	protected async writeIntakeNote(
		plugin: WorkflowContext['plugin'],
		outcomes: BlogOutcome[],
		totalNew: number,
		rowErrors: BlogRowError[],
		generatedBy: string,
	): Promise<string> {
		const app = plugin.app;
		const tz = plugin.settings.orchestrationTimezone;
		const date = todayInTz(tz);
		const time = nowTimeInTz(tz);
		const displayTime = time.replace(/-/g, ':');
		const path = await this.allocateIntakePath(app, date, time);
		await ensureFolder(app, INTAKE_ROOT_BLOGS);

		const sortedOutcomes = [...outcomes].sort(
			(a, b) => PRIORITY_ORDER[a.blog.priority] - PRIORITY_ORDER[b.blog.priority],
		);

		const failedBlogs = sortedOutcomes.filter(o => o.error);
		const blogsWithNew = sortedOutcomes.filter(o => o.newPosts.length > 0).length;
		const postIds = sortedOutcomes.flatMap(o => o.newPosts.map(p => p.postId));

		const fmLines = [
			'---',
			`date: ${date}`,
			`run_at: ${date}T${displayTime}`,
			`generated_by: ${generatedBy}`,
			`blogs_total: ${sortedOutcomes.length}`,
			`blogs_with_new: ${blogsWithNew}`,
			`posts_total: ${totalNew}`,
			`blogs_failed: ${failedBlogs.length}`,
			`rows_skipped: ${rowErrors.length}`,
		];
		if (postIds.length > 0) {
			fmLines.push('post-ids:');
			for (const id of postIds) fmLines.push(`  - ${yamlScalar(id)}`);
		} else {
			fmLines.push('post-ids: []');
		}
		fmLines.push('---', '');
		const fm = fmLines.join('\n');

		const sections: string[] = [`# Blogs intake — ${date} ${displayTime}`, ''];

		if (sortedOutcomes.length === 0 && rowErrors.length === 0) {
			sections.push('_No blogs configured._');
		} else {
			const withNew = sortedOutcomes.filter(o => o.newPosts.length > 0);
			if (withNew.length === 0 && rowErrors.length === 0) {
				sections.push('_No new posts across all blogs._', '');
			}
			for (const o of withNew) {
				sections.push(`## ${o.blog.name} (${o.blog.link})`);
				for (const p of o.newPosts) {
					const published = (p.publishedAt || '').slice(0, 10) || 'unknown';
					sections.push(`- **${escapeBrackets(p.title)}** — published ${published} — ${p.url}`);
				}
				sections.push('');
			}
		}

		if (failedBlogs.length > 0) {
			sections.push('## Failed blogs', '');
			for (const o of failedBlogs) {
				sections.push(`- ${o.blog.name} (${o.blog.link}): ${o.error}`);
			}
			sections.push('');
		}

		if (rowErrors.length > 0) {
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

	private async allocateIntakePath(app: WorkflowContext['plugin']['app'], date: string, time: string): Promise<string> {
		const base = `${INTAKE_ROOT_BLOGS}/${date}T${time}`;
		let candidate = normalizePath(`${base}.md`);
		let suffix = 1;
		while (app.vault.getAbstractFileByPath(candidate) instanceof TFile) {
			candidate = normalizePath(`${base}-${suffix}.md`);
			suffix += 1;
		}
		return candidate;
	}
}

export class BlogsTrackerConsolidateWorkflow extends BlogsTrackerWorkflow {
	async run(_job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const app = plugin.app;

		await this.canonicalizeDetectedIds(plugin);
		const seenInVault = buildBlogsSeenIdSet(app, false);
		const configuredBlogs = await loadConfiguredBlogs(app, plugin);
		const scan = await scanBlogsTrackerRuns(app, seenInVault, configuredBlogs);
		const totalNew = scan.outcomes.reduce((sum, o) => sum + o.newPosts.length, 0);

		if (scan.runsScanned === 0) {
			return {
				status: 'done',
				outputPaths: [],
				notes: 'No regular Blogs tracker intake runs found; consolidated intake file not written.',
			};
		}

		if (totalNew === 0) {
			return {
				status: 'done',
				outputPaths: [],
				notes: `No posts from ${scan.runsScanned} regular Blogs tracker run(s) are missing from the vault; consolidated intake file not written.`,
			};
		}

		const intakePath = await this.writeIntakeNote(plugin, scan.outcomes, totalNew, [], CONSOLIDATE_GENERATED_BY_BLOGS);
		return {
			status: 'done',
			outputPaths: [intakePath],
			notes: `Runs scanned: ${scan.runsScanned}; Posts in runs: ${scan.postsSeenInRuns}; Still missing: ${totalNew}`,
		};
	}
}

function detectPostIdSource(fm: Record<string, unknown>): { id: string; sourceKey: string } | null {
	const fromSource = firstUrlAsId(fm['source']);
	if (fromSource) return { id: fromSource, sourceKey: 'source' };
	return null;
}

function firstUrlAsId(value: unknown): string | null {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed || !/^https?:\/\//i.test(trimmed)) return null;
		return postIdFromUrl(trimmed);
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item !== 'string') continue;
			const trimmed = item.trim();
			if (!trimmed || !/^https?:\/\//i.test(trimmed)) continue;
			return postIdFromUrl(trimmed);
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

function yamlScalar(value: string): string {
	if (/^[A-Za-z0-9_./:?=&%+#~@!$()-]+$/.test(value) && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) {
		return value;
	}
	const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	return `"${escaped}"`;
}

// Re-export RemotePost for callers that imported it from this module previously.
export type { RemotePost };
