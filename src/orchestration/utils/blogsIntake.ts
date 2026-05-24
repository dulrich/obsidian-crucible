import { App, TFile, normalizePath } from 'obsidian';
import type CruciblePlugin from '../../main';
import {
	BlogEntry,
	RemotePost,
	parseBlogsTable,
	postIdFromUrl,
} from './blogs';

export const INTAKE_ROOT_BLOGS = '_crucible/orchestration/blogs/new-posts';
export const QUEUE_SCAN_SKIP_PREFIX_BLOGS = '_crucible/orchestration/';
export const TRACKER_GENERATED_BY_BLOGS = 'orchestrator/blogs_tracker';
export const CONSOLIDATE_GENERATED_BY_BLOGS = 'orchestrator/blogs_tracker_consolidate';

export interface BlogOutcome {
	blog: BlogEntry;
	newPosts: RemotePost[];
	error?: string;
}

export interface BlogsConsolidationScan {
	outcomes: BlogOutcome[];
	runsScanned: number;
	postsSeenInRuns: number;
}

export interface BlogsIntakePostEntry {
	blog: BlogEntry;
	post: RemotePost;
}

export interface BlogsIntakeRunStat {
	file: TFile;
	runAt: string;
	blogsTotal: number;
	blogsWithNew: number;
	postsTotal: number;
	blogsFailed: number;
	rowsSkipped: number;
	generatedBy: string;
}

export function buildBlogsSeenIdSet(app: App, diffMode: boolean): Set<string> {
	const seen = new Set<string>();
	const intakePrefix = `${INTAKE_ROOT_BLOGS}/`;
	for (const file of app.vault.getMarkdownFiles()) {
		const inIntake = file.path.startsWith(intakePrefix);
		const inSkip = file.path.startsWith(QUEUE_SCAN_SKIP_PREFIX_BLOGS);
		if (inSkip && !(diffMode && inIntake)) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;
		ingestStringProperty(fm['post-id'], seen);
		ingestSourceProperty(fm['source'], seen);
		if (diffMode && inIntake) {
			ingestStringProperty(fm['post-ids'], seen);
		}
	}
	return seen;
}

export async function loadConfiguredBlogs(
	app: App,
	plugin: CruciblePlugin,
): Promise<Map<string, { blog: BlogEntry; index: number }>> {
	const out = new Map<string, { blog: BlogEntry; index: number }>();
	const registryPath = normalizePath(plugin.settings.orchestrationBlogsNote);
	const registryFile = app.vault.getAbstractFileByPath(registryPath);
	if (!(registryFile instanceof TFile)) return out;
	const content = await app.vault.read(registryFile);
	const { entries } = parseBlogsTable(content);
	entries.forEach((blog, index) => out.set(blog.link, { blog, index }));
	return out;
}

export async function scanBlogsTrackerRuns(
	app: App,
	seenInVault: Set<string>,
	configuredBlogs: Map<string, { blog: BlogEntry; index: number }>,
): Promise<BlogsConsolidationScan> {
	const intakePrefix = `${INTAKE_ROOT_BLOGS}/`;
	const intakeFiles = app.vault.getMarkdownFiles()
		.filter(file => file.path.startsWith(intakePrefix))
		.sort((a, b) => a.path.localeCompare(b.path));

	const byId = new Map<string, BlogsIntakePostEntry>();
	let runsScanned = 0;
	let postsSeenInRuns = 0;

	for (const file of intakeFiles) {
		const content = await app.vault.read(file);
		const generatedBy: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.generated_by;
		const isTrackerRun = generatedBy === TRACKER_GENERATED_BY_BLOGS
			|| frontmatterHasGeneratedBy(content, TRACKER_GENERATED_BY_BLOGS);
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

	return { outcomes, runsScanned, postsSeenInRuns };
}

export function listBlogsIntakeRuns(app: App): BlogsIntakeRunStat[] {
	const intakePrefix = `${INTAKE_ROOT_BLOGS}/`;
	const out: BlogsIntakeRunStat[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(intakePrefix)) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;
		const generatedBy = stringOf(fm['generated_by']);
		if (!generatedBy) continue;
		if (generatedBy !== TRACKER_GENERATED_BY_BLOGS && generatedBy !== CONSOLIDATE_GENERATED_BY_BLOGS) continue;
		out.push({
			file,
			runAt: stringOf(fm['run_at']) ?? '',
			blogsTotal: numberOf(fm['blogs_total']),
			blogsWithNew: numberOf(fm['blogs_with_new']),
			postsTotal: numberOf(fm['posts_total']),
			blogsFailed: numberOf(fm['blogs_failed']),
			rowsSkipped: numberOf(fm['rows_skipped']),
			generatedBy,
		});
	}
	out.sort((a, b) => b.runAt.localeCompare(a.runAt));
	return out;
}

export function isSeenPost(post: RemotePost, seen: Set<string>): boolean {
	if (seen.has(post.postId)) return true;
	if (post.url && seen.has(post.url)) return true;
	if (post.url && seen.has(postIdFromUrl(post.url))) return true;
	return false;
}

export function parseIntakePosts(content: string): BlogsIntakePostEntry[] {
	const entries: BlogsIntakePostEntry[] = [];
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
