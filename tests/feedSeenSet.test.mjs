import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-feed-seen-tests');
const outfile = path.join(outdir, 'feedIntake.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/orchestration/utils/feedIntake.ts'],
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
						'export class App {}',
						'export class TFile {}',
						'export class TFolder {}',
						'export const Platform = { isDesktopApp: true, isMobileApp: false, isMacOS: false };',
						'export function htmlToMarkdown(html) { return String(html); }',
						'export function normalizePath(p) { return String(p).replace(/\\\\\\\\/g, "/").replace(/\\/+/g, "/"); }',
						'export function parseYaml() { return {}; }',
						'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
					].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const {
	buildYoutubeSeenIdSet,
	feedSeenExtraSkipPrefixes,
} = await import(pathToFileURL(outfile));

function mockApp(files) {
	return {
		vault: {
			getMarkdownFiles: () => files,
		},
		metadataCache: {
			getFileCache: file => ({ frontmatter: file.fm }),
		},
	};
}

test('YouTube seen set counts real captures and ignored seed ids only', () => {
	const captured = 'CAPTURED001';
	const linkedOnly = 'LINKREC0001';
	const metadataOnly = 'METADATA001';
	const sourceOnly = 'SOURCE00001';
	const ignored = 'IGNORED0001';
	const app = mockApp([
		{ path: 'Notes/captured.md', fm: { 'yt-video-id': captured } },
		{ path: '_crucible/link_registry/link-record.md', fm: { type: 'link-record', 'yt-video-id': linkedOnly } },
		{ path: 'Other Registry/link-record.md', fm: { type: 'link-record', 'yt-video-id': 'OTHERLINK01' } },
		{ path: '_yt_metadata/channel/video.md', fm: { 'yt-video-id': metadataOnly } },
		{ path: 'Notes/source.md', fm: { source: `https://youtu.be/${sourceOnly}` } },
	]);

	const seen = buildYoutubeSeenIdSet(app, false, [ignored], ['_yt_metadata', '_crucible/link_registry']);

	assert.equal(seen.has(captured), true);
	assert.equal(seen.has(sourceOnly), true);
	assert.equal(seen.has(ignored), true);
	assert.equal(seen.has(linkedOnly), false);
	assert.equal(seen.has(metadataOnly), false);
	assert.equal(seen.has('OTHERLINK01'), false);
});

test('feedSeenExtraSkipPrefixes follows YouTube settings roots', () => {
	const plugin = {
		settings: {
			orchestrationLinkRegistryRoot: 'Links/Registry',
			orchestrationYoutubeMetadataRoot: 'Metadata/YouTube',
			orchestrationBlogsMetadataRoot: 'Metadata/Blogs',
		},
	};

	assert.deepEqual(feedSeenExtraSkipPrefixes(plugin, { kind: 'youtube' }), ['Links/Registry', 'Metadata/YouTube']);
});
