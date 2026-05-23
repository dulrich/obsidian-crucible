import { TFile, normalizePath } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { nowTimeInTz, todayInTz } from '../utils/dates';
import { ensureFolder } from '../../utils';
import { insertFrontmatterPropertyAfter, updateFrontmatter } from '../../frontmatter';
import { rateLimitedAllSettled } from '../utils/rateLimit';
import {
	BlogEntry,
	BlogPriority,
	BlogRowError,
	EXAMPLE_BLOGS_TABLE,
	RemotePost,
	fetchBlogFeed,
	parseBlogsTable,
	postIdFromUrl,
} from '../utils/blogs';

const INTAKE_ROOT = '_crucible/orchestration/blogs/new-posts';
const QUEUE_SCAN_SKIP_PREFIX = '_crucible/orchestration/';
const FEED_FETCH_CONCURRENCY = 4;
const FEED_FETCH_MIN_INTERVAL_MS = 250;
const TRACKER_GENERATED_BY = 'orchestrator/blogs_tracker';
const CONSOLIDATE_GENERATED_BY = 'orchestrator/blogs_tracker_consolidate';

const PRIORITY_ORDER: Record<BlogPriority, number> = { high: 0, normal: 1, low: 2 };

interface BlogOutcome {
	blog: BlogEntry;
	newPosts: RemotePost[];
	error?: string;
}

interface ConsolidationScan {
	outcomes: BlogOutcome[];
	runsScanned: number;
	postsSeenInRuns: number;
}

interface IntakePostEntry {
	blog: BlogEntry;
	post: RemotePost;
}

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
			const intakePath = await this.writeIntakeNote(plugin, [], 0, [], TRACKER_GENERATED_BY);
			return {
				status: 'done',
				outputPaths: [intakePath],
				notes: `Registry at ${registryPath} has no blogs. Wrote empty intake.`,
			};
		}

		await this.canonicalizeDetectedIds(plugin);

		const diffMode = plugin.settings.orchestrationBlogsTrackerDiffMode !== false;
		const seen = this.buildSeenIdSet(plugin, diffMode);

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
			const fresh = settled.value.filter(p => !isSeen(p, seen));
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

		const intakePath = await this.writeIntakeNote(plugin, outcomes, totalNew, rowErrors, TRACKER_GENERATED_BY);

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
			if (file.path.startsWith(QUEUE_SCAN_SKIP_PREFIX)) continue;
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;
			const existing: unknown = fm['blog-post-id'];
			if (typeof existing === 'string' && existing.trim()) continue;
			const detected = detectPostIdSource(fm);
			if (!detected) continue;
			await updateFrontmatter(app, file, current => {
				const present = current['blog-post-id'];
				if (typeof present === 'string' && present.trim()) return;
				insertFrontmatterPropertyAfter(current, detected.sourceKey, 'blog-post-id', detected.id);
			});
		}
	}

	protected buildSeenIdSet(plugin: WorkflowContext['plugin'], diffMode: boolean): Set<string> {
		const app = plugin.app;
		const seen = new Set<string>();
		const intakePrefix = `${INTAKE_ROOT}/`;
		for (const file of app.vault.getMarkdownFiles()) {
			const inIntake = file.path.startsWith(intakePrefix);
			const inSkip = file.path.startsWith(QUEUE_SCAN_SKIP_PREFIX);
			if (inSkip && !(diffMode && inIntake)) continue;
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;
			ingestStringProperty(fm['blog-post-id'], seen);
			ingestSourceProperty(fm['source'], seen);
			if (diffMode && inIntake) {
				ingestStringProperty(fm['post_ids'], seen);
			}
		}
		return seen;
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
		await ensureFolder(app, INTAKE_ROOT);

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
			fmLines.push('post_ids:');
			for (const id of postIds) fmLines.push(`  - ${yamlScalar(id)}`);
		} else {
			fmLines.push('post_ids: []');
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

export class BlogsTrackerConsolidateWorkflow extends BlogsTrackerWorkflow {
	async run(_job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;

		await this.canonicalizeDetectedIds(plugin);
		const seenInVault = this.buildSeenIdSet(plugin, false);
		const configuredBlogs = await this.loadConfiguredBlogs(plugin);
		const scan = await this.scanRegularTrackerRuns(plugin, seenInVault, configuredBlogs);
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

		const intakePath = await this.writeIntakeNote(plugin, scan.outcomes, totalNew, [], CONSOLIDATE_GENERATED_BY);
		return {
			status: 'done',
			outputPaths: [intakePath],
			notes: `Runs scanned: ${scan.runsScanned}; Posts in runs: ${scan.postsSeenInRuns}; Still missing: ${totalNew}`,
		};
	}

	private async loadConfiguredBlogs(plugin: WorkflowContext['plugin']): Promise<Map<string, { blog: BlogEntry; index: number }>> {
		const app = plugin.app;
		const registryPath = normalizePath(plugin.settings.orchestrationBlogsNote);
		const registryFile = app.vault.getAbstractFileByPath(registryPath);
		const out = new Map<string, { blog: BlogEntry; index: number }>();
		if (!(registryFile instanceof TFile)) return out;
		const content = await app.vault.read(registryFile);
		const { entries } = parseBlogsTable(content);
		entries.forEach((blog, index) => out.set(blog.link, { blog, index }));
		return out;
	}

	private async scanRegularTrackerRuns(
		plugin: WorkflowContext['plugin'],
		seenInVault: Set<string>,
		configuredBlogs: Map<string, { blog: BlogEntry; index: number }>,
	): Promise<ConsolidationScan> {
		const app = plugin.app;
		const intakePrefix = `${INTAKE_ROOT}/`;
		const intakeFiles = app.vault.getMarkdownFiles()
			.filter(file => file.path.startsWith(intakePrefix))
			.sort((a, b) => a.path.localeCompare(b.path));

		const byId = new Map<string, IntakePostEntry>();
		let runsScanned = 0;
		let postsSeenInRuns = 0;

		for (const file of intakeFiles) {
			const content = await app.vault.read(file);
			const generatedBy: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.generated_by;
			const isTrackerRun = generatedBy === TRACKER_GENERATED_BY || frontmatterHasGeneratedBy(content, TRACKER_GENERATED_BY);
			if (!isTrackerRun) continue;
			runsScanned++;

			for (const entry of parseIntakePosts(content)) {
				postsSeenInRuns++;
				const configured = configuredBlogs.get(entry.blog.link);
				if (!configured) continue;
				if (seenInVault.has(entry.post.postId) || seenInVault.has(postIdFromUrl(entry.post.url))) continue;
				if (byId.has(entry.post.postId)) continue;
				byId.set(entry.post.postId, { blog: configured.blog, post: entry.post });
			}
		}

		const byBlog = new Map<string, BlogOutcome>();
		for (const entry of byId.values()) {
			const existing = byBlog.get(entry.blog.link);
			if (existing) {
				existing.newPosts.push(entry.post);
			} else {
				byBlog.set(entry.blog.link, {
					blog: entry.blog,
					newPosts: [entry.post],
				});
			}
		}

		const outcomes = Array.from(byBlog.values()).sort((a, b) => {
			const ai = configuredBlogs.get(a.blog.link)?.index ?? Number.MAX_SAFE_INTEGER;
			const bi = configuredBlogs.get(b.blog.link)?.index ?? Number.MAX_SAFE_INTEGER;
			return ai - bi;
		});

		return {
			outcomes,
			runsScanned,
			postsSeenInRuns,
		};
	}
}

function parseIntakePosts(content: string): IntakePostEntry[] {
	const entries: IntakePostEntry[] = [];
	let currentBlog: BlogEntry | null = null;

	for (const line of content.split(/\r?\n/)) {
		const blog = parseBlogHeading(line);
		if (blog) {
			currentBlog = blog;
			continue;
		}

		if (line.startsWith('## ')) {
			currentBlog = null;
			continue;
		}

		if (!currentBlog) continue;
		const post = parsePostBullet(line, currentBlog.name);
		if (post) entries.push({ blog: currentBlog, post });
	}

	return entries;
}

function parseBlogHeading(line: string): BlogEntry | null {
	const match = line.match(/^##\s+(.+)\s+\((https?:\/\/[^)]+)\)\s*$/);
	const name = match?.[1]?.trim();
	const link = match?.[2]?.trim();
	if (!name || !link) return null;
	return { name, link, method: 'rss', tags: [], priority: 'normal' };
}

function parsePostBullet(line: string, blogName: string): RemotePost | null {
	const match = line.match(/^- \*\*(.*)\*\* — published ([^—]+) — (https?:\/\/\S+)/);
	const rawTitle = match?.[1]?.trim();
	const publishedAt = match?.[2]?.trim();
	const url = match?.[3]?.trim();
	if (!rawTitle || !publishedAt || !url) return null;
	return {
		postId: postIdFromUrl(url),
		title: unescapeBrackets(rawTitle),
		publishedAt,
		blogName,
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

function ingestStringProperty(value: unknown, seen: Set<string>): void {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed) seen.add(trimmed);
	} else if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item !== 'string') continue;
			const trimmed = item.trim();
			if (trimmed) seen.add(trimmed);
		}
	}
}

function ingestSourceProperty(value: unknown, seen: Set<string>): void {
	if (typeof value === 'string') {
		addSourceUrl(value, seen);
	} else if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === 'string') addSourceUrl(item, seen);
		}
	}
}

function addSourceUrl(value: string, seen: Set<string>): void {
	const trimmed = value.trim();
	if (!trimmed || !/^https?:\/\//i.test(trimmed)) return;
	seen.add(trimmed);
	seen.add(postIdFromUrl(trimmed));
}

function isSeen(post: RemotePost, seen: Set<string>): boolean {
	if (seen.has(post.postId)) return true;
	if (post.url && seen.has(post.url)) return true;
	if (post.url && seen.has(postIdFromUrl(post.url))) return true;
	return false;
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
