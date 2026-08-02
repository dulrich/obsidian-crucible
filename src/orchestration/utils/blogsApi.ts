import { App, TFile, TFolder, htmlToMarkdown, normalizePath, parseYaml } from 'obsidian';
import type CruciblePlugin from '../../main';
import { ensureFolder, slugify } from '../../utils';
import { walkMarkdown } from '../../vaultWalk';
import { yamlString } from '../../frontmatterValues';
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

// `row` only needs `metadataFile` — the command runs against the metadata note as
// `targetFile`. Deliberately narrower than `UncapturedPostRow` (WP-DP1) so the Ignored
// Posts action cell (`IgnoredPostRow`, no `authors`/`categories`/`hasBody`/`audioUrl`)
// can share this call site without a fake full row.
export async function runBlogIngestCommand(plugin: CruciblePlugin, row: { metadataFile: TFile | null }): Promise<BlogIngestCommandResult> {
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

// WP-DP1: the Clip button's precondition check, pure (no vault write) so both
// Uncaptured Posts and Ignored Posts can compute the muted/disabled state before
// ever attempting `runBlogIngestCommand` — "muted, never absent" needs to know the
// reason ahead of a click, not just report it after one fails. Precedence matches
// the order a click would actually fail in: no body to clip, then no metadata note
// (the `missing-metadata` branch above), then no configured/resolvable command (the
// `missing-command` branch above).
export function blogClipBlockedTitle(plugin: CruciblePlugin, row: { hasBody: boolean; metadataFile: TFile | null }): string | null {
	if (!row.hasBody) return 'No post body captured';
	if (!row.metadataFile) return 'No blog metadata note';
	const configuredId = (plugin.settings.orchestrationBlogsIngestCommandId || '').trim();
	if (!resolveInternalCommandId(plugin, configuredId)) return 'No ingest command configured (see Orchestrator settings)';
	return null;
}

export async function findExistingBlogMetadataNote(app: App, root: string, postId: string): Promise<TFile | null> {
	const index = await buildBlogMetadataNoteIndex(app, root);
	return index.get(postId) ?? null;
}

export async function buildBlogMetadataNoteIndex(app: App, root: string): Promise<Map<string, TFile>> {
	const out = new Map<string, TFile>();
	const rootFolder = app.vault.getAbstractFileByPath(normalizePath(root));
	if (!(rootFolder instanceof TFolder)) return out;
	for (const file of walkMarkdown(rootFolder)) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		let postId: string | null = null;
		if (fm) {
			postId = typeof fm['post-id'] === 'string' && fm['post-id'].trim() ? fm['post-id'].trim() : null;
		} else {
			// Cache miss: a just-created file isn't in metadataCache until Obsidian
			// re-parses it, so read frontmatter from disk to match it immediately.
			postId = await readPostIdFromDisk(app, file);
		}
		if (postId && !out.has(postId)) out.set(postId, file);
	}
	return out;
}

async function readPostIdFromDisk(app: App, file: TFile): Promise<string | null> {
	try {
		const content = await app.vault.cachedRead(file);
		const match = /^---\n([\s\S]*?)\n---/.exec(content);
		if (!match?.[1]) return null;
		const fm = parseYaml(match[1]) as Record<string, unknown> | null;
		const postId = fm?.['post-id'];
		return typeof postId === 'string' && postId.trim() ? postId.trim() : null;
	} catch {
		return null;
	}
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
