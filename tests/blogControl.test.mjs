import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), `crucible-blog-control-${process.pid}`);
const outfile = path.join(outdir, 'blog-control.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/ingestion/data/blogs.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: [
					'export class TFile { constructor(path, content = "", fm = {}) { this.path = path; this.content = content; this.fm = fm; this.extension = path.split(".").pop() || ""; this.basename = path.split("/").pop().replace(/\\.[^.]+$/, ""); } }',
					'export class TFolder { constructor(path, children = []) { this.path = path; this.children = children; } }',
					'globalThis.__CrucibleTestTFile = TFile;',
					'globalThis.__CrucibleTestTFolder = TFolder;',
					'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
					'export function htmlToMarkdown(s) { return String(s ?? ""); }',
					'export function parseYaml() { return {}; }',
					'export function normalizePath(p) { return p.replace(/\\\\/g, "/").replace(/\\/+/g, "/"); }',
					'export const Platform = { isMobile: false, isDesktop: true };',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { computeBlogControlRows } = await import(pathToFileURL(outfile));
const TFile = globalThis.__CrucibleTestTFile;
const TFolder = globalThis.__CrucibleTestTFolder;

test('computeBlogControlRows rolls up tracked, ingested, ignored, uncaptured, and metadata-only blogs', async () => {
	const registry = file('_system/blogs/Blogs.md', [
		'| Name | Link | Method | Tags | Priority |',
		'|------|------|--------|------|----------|',
		'| Acme | https://acme.example/feed | RSS | | normal |',
	].join('\n'));
	const intake = file('_crucible/orchestration/blogs/new-posts/2026-01-03.md', [
		'---',
		'generated_by: orchestrator/blogs_tracker',
		'---',
		'## Acme (https://acme.example/feed)',
		'- **One** — published 2026-01-01 — https://acme.example/p/one',
		'- **Two** — published 2026-01-02 — https://acme.example/p/two',
		'- **Three** — published 2026-01-03 — https://acme.example/p/three',
	].join('\n'), { generated_by: 'orchestrator/blogs_tracker' });
	const captured = file('Notes/one.md', '', { source: 'https://acme.example/p/one' });
	const ignored = file('_crucible/orchestration/ignored.md', [
		'# Ignored ingestion IDs',
		'## Blogs',
		'- https://acme.example/p/two',
	].join('\n'));
	const stagedOnly = file('_blog_metadata/acme/three.md', '', {
		'post-id': 'https://acme.example/p/three',
		blog: 'Acme',
		source: 'https://acme.example/p/three',
	});
	const untrackedMeta = file('_blog_metadata/other/post.md', '', {
		'post-id': 'https://other.example/p/post',
		blog: 'Other',
		source: 'https://other.example/p/post',
	});
	const app = mockApp([registry, intake, captured, ignored, stagedOnly, untrackedMeta]);
	const plugin = {
		app,
		settings: {
			orchestrationBlogsNote: '_system/blogs/Blogs.md',
			orchestrationBlogsMetadataRoot: '_blog_metadata',
			orchestrationLinkRegistryRoot: '_crucible/link_registry',
		},
	};

	const rows = await computeBlogControlRows(app, plugin);
	const acme = rows.find(r => r.name === 'Acme');
	const other = rows.find(r => r.name === 'Other');

	assert.ok(acme);
	assert.equal(acme.tracked, true);
	assert.equal(acme.link, 'https://acme.example/feed');
	assert.equal(acme.trackedPosts, 3);
	assert.equal(acme.ingestedPosts, 1);
	assert.equal(acme.ignoredPosts, 1);
	assert.equal(acme.uncapturedPosts, 1);

	assert.ok(other);
	assert.equal(other.tracked, false);
	assert.equal(other.link, 'https://other.example/p/post');
	assert.equal(other.trackedPosts, 1);
	assert.equal(other.ingestedPosts, 0);
	assert.equal(other.ignoredPosts, 0);
	assert.equal(other.uncapturedPosts, 1);
});

function file(path, content = '', fm = {}) {
	return new TFile(path, content, fm);
}

function mockApp(files) {
	const byPath = new Map(files.map(f => [f.path, f]));
	return {
		vault: {
			getMarkdownFiles: () => files.filter(f => f.extension === 'md'),
			read: async f => f.content,
			cachedRead: async f => f.content,
			getAbstractFileByPath: p => byPath.get(p) ?? folderForPath(p, files),
		},
		metadataCache: {
			getFileCache: f => ({ frontmatter: f.fm ?? {} }),
		},
	};
}

function folderForPath(path, files) {
	const prefix = path.endsWith('/') ? path : `${path}/`;
	const children = [];
	for (const file of files) {
		if (!file.path.startsWith(prefix)) continue;
		const rest = file.path.slice(prefix.length);
		const slash = rest.indexOf('/');
		if (slash === -1) {
			children.push(file);
		} else {
			const childPath = `${prefix}${rest.slice(0, slash)}`;
			if (!children.some(child => child.path === childPath)) {
				children.push(folderForPath(childPath, files));
			}
		}
	}
	return children.length > 0 ? new TFolder(path, children) : null;
}
