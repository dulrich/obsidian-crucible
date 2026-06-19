import { App, TFile, TFolder, htmlToMarkdown, normalizePath } from 'obsidian';
import type CruciblePlugin from '../../main';
import { ensureFolder, slugify } from '../../utils';
import type { UncapturedPostRow } from '../../ingestion/render/types';
import type { BlogPostKind, RemotePost } from './blogs';

export const DEFAULT_BLOGS_METADATA_ROOT = '_blog_metadata';

export interface BlogPostMetadata {
	postId: string;
	title: string;
	url: string;
	blogName: string;
	authors: string[];
	publishedAt: string;
	wordCount: number | null;
	categories: string[];
	kind: BlogPostKind;
	hasBody: boolean;
	audioUrl?: string;
}

export type BlogMetadataResult =
	| { status: 'created'; metadataPath: string }
	| { status: 'updated'; metadataPath: string }
	| { status: 'exists'; metadataPath: string };

export type BlogIngestCommandResult =
	| { status: 'ran'; commandId: string; metadataPath: string }
	| { status: 'missing-command'; commandId: string | null; metadataPath: string | null }
	| { status: 'missing-metadata'; commandId: string | null; metadataPath: null };

export function blogMetadataRoot(plugin: CruciblePlugin): string {
	return normalizePath(plugin.settings.orchestrationBlogsMetadataRoot || DEFAULT_BLOGS_METADATA_ROOT);
}

function yamlString(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildBlogMetadataNoteBody(meta: BlogPostMetadata, bodyMarkdown: string | null): string {
	const fm: string[] = ['---'];
	fm.push(`source: ${meta.url}`);
	fm.push(`post-id: ${yamlString(meta.postId)}`);
	fm.push(`blog: ${yamlString(meta.blogName)}`);
	if (meta.authors.length > 0) {
		fm.push('authors:');
		for (const a of meta.authors) fm.push(`  - ${yamlString(a)}`);
	}
	if (meta.publishedAt) fm.push(`published: ${meta.publishedAt}`);
	fm.push(`word-count: ${meta.wordCount ?? 'null'}`);
	if (meta.categories.length > 0) {
		fm.push('categories:');
		for (const c of meta.categories) fm.push(`  - ${yamlString(c)}`);
	}
	fm.push(`kind: ${meta.kind}`);
	fm.push(`has-body: ${meta.hasBody ? 'true' : 'false'}`);
	if (meta.audioUrl) fm.push(`audio_url: ${meta.audioUrl}`);
	fm.push(`fetched_at: ${new Date().toISOString()}`);
	fm.push(`source_command: blogs-tracker`);
	fm.push('---', '');

	const title = meta.title || meta.url;
	const parts = [`${fm.join('\n')}# ${title}`, ''];
	if (meta.audioUrl) parts.push(`[Audio](${meta.audioUrl})`, '');
	if (bodyMarkdown && bodyMarkdown.trim()) parts.push(bodyMarkdown.trim(), '');
	return parts.join('\n');
}

export async function ensureBlogMetadataNote(plugin: CruciblePlugin, post: RemotePost): Promise<BlogMetadataResult> {
	const app = plugin.app;
	const root = blogMetadataRoot(plugin);
	const postId = post.postId.trim();
	if (!postId) throw new Error('Cannot write blog metadata without a post-id');

	return await plugin.noteLocks.withResourceLock('blog-post', postId, 'blog-metadata', async (): Promise<BlogMetadataResult> => {
		const bodyMarkdown = post.hasBody && post.bodyHtml ? htmlToMarkdown(post.bodyHtml).trim() : null;
		const meta = postToMetadata(post, bodyMarkdown);
		const body = buildBlogMetadataNoteBody(meta, bodyMarkdown);
		const existing = await findExistingBlogMetadataNote(app, root, postId);
		if (existing) {
			const current = await app.vault.read(existing);
			if (current === body) return { status: 'exists', metadataPath: existing.path };
			await app.vault.modify(existing, body);
			return { status: 'updated', metadataPath: existing.path };
		}

		const path = await allocateMetadataNotePath(app, root, meta);
		const slashIdx = path.lastIndexOf('/');
		if (slashIdx > 0) await ensureFolder(app, path.slice(0, slashIdx));
		await app.vault.create(path, body);
		return { status: 'created', metadataPath: path };
	});
}

export async function runBlogIngestCommand(plugin: CruciblePlugin, row: UncapturedPostRow): Promise<BlogIngestCommandResult> {
	const configuredId = (plugin.settings.orchestrationBlogsIngestCommandId || '').trim();
	const commandId = resolveInternalCommandId(plugin, configuredId);
	const metadataPath = row.metadataFile?.path ?? null;
	if (!metadataPath) return { status: 'missing-metadata', commandId: configuredId || null, metadataPath: null };
	if (!commandId) {
		return { status: 'missing-command', commandId: configuredId || null, metadataPath };
	}
	const file = plugin.app.vault.getAbstractFileByPath(metadataPath);
	if (!(file instanceof TFile)) return { status: 'missing-metadata', commandId, metadataPath: null };
	const result = await plugin.chainManager.executeInternalCommand(commandId, {}, null, undefined, file);
	if (result === false) throw new Error(`Command ${commandId} reported failure`);
	return { status: 'ran', commandId, metadataPath };
}

function resolveInternalCommandId(plugin: CruciblePlugin, commandId: string): string | null {
	if (!commandId) return null;
	if (plugin.chainManager.hasInternalCommand(commandId)) return commandId;
	const pluginId = `${plugin.manifest.id}:${commandId}`;
	if (plugin.chainManager.hasInternalCommand(pluginId)) return pluginId;
	const crucibleId = `crucible:${commandId}`;
	if (plugin.chainManager.hasInternalCommand(crucibleId)) return crucibleId;
	return null;
}

export async function findExistingBlogMetadataNote(app: App, root: string, postId: string): Promise<TFile | null> {
	const rootFolder = app.vault.getAbstractFileByPath(normalizePath(root));
	if (!(rootFolder instanceof TFolder)) return null;
	for (const file of walkMarkdown(rootFolder)) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (typeof fm?.['post-id'] === 'string' && fm['post-id'].trim() === postId) return file;
	}
	return null;
}

function postToMetadata(post: RemotePost, bodyMarkdown: string | null): BlogPostMetadata {
	return {
		postId: post.postId,
		title: post.title,
		url: post.url,
		blogName: post.blogName,
		authors: post.authors,
		publishedAt: post.publishedAt,
		wordCount: bodyMarkdown ? countMarkdownWords(bodyMarkdown) : post.wordCount,
		categories: post.categories,
		kind: post.kind,
		hasBody: post.hasBody && !!bodyMarkdown,
		...(post.audioUrl ? { audioUrl: post.audioUrl } : {}),
	};
}

async function allocateMetadataNotePath(app: App, root: string, meta: BlogPostMetadata): Promise<string> {
	const folder = `${root}/${slugify(meta.blogName) || 'blog'}`;
	const datePrefix = (meta.publishedAt || '').slice(0, 10);
	const titleSlug = slugify(meta.title).slice(0, 80) || 'post';
	const base = datePrefix ? `${folder}/${datePrefix}-${titleSlug}` : `${folder}/${titleSlug}`;
	let candidate = normalizePath(`${base}.md`);
	let suffix = 1;
	while (app.vault.getAbstractFileByPath(candidate) instanceof TFile) {
		candidate = normalizePath(`${base}-${suffix}.md`);
		suffix += 1;
	}
	return candidate;
}

function* walkMarkdown(folder: TFolder): Generator<TFile> {
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === 'md') yield child;
		if (child instanceof TFolder) yield* walkMarkdown(child);
	}
}

function countMarkdownWords(markdown: string): number {
	const text = markdown
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`[^`]*`/g, ' ')
		.replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
		.replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
		.replace(/\[\[([^\]|]+)\|([^\]]+)]]/g, '$2')
		.replace(/\[\[([^\]]+)]]/g, '$1')
		.replace(/[#>*_\-[\]()]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return text ? text.split(' ').length : 0;
}
