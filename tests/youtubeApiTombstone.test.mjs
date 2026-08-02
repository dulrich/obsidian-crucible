import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// WP-K1: YouTube taken-down tombstones, the X-pipeline port. `ensureMetadataNote`
// (src/orchestration/utils/youtubeApi.ts) is the materializer under test here — same
// technique and shape as tests/xApi.test.mjs's `ensureXMetadataNote` suite, which this
// mirrors deliberately. `fetchYoutubeVideo`'s own error classification (zero-items /
// 404 -> YoutubeVideoUnavailableError) is covered separately in
// tests/youtubeApiServiceHealth.test.mjs; this file exercises the tombstone
// materialization and snapshot-forever probe behavior end to end.

const outdir = path.join(tmpdir(), 'obsidian-crucible-youtube-api-tombstone-tests');
const outfile = path.join(outdir, 'youtubeApiTombstone.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export {",
			"  YoutubeVideoUnavailableError,",
			"  buildYoutubeTombstoneNoteBody,",
			"  youtubeWatchUrl,",
			"  youtubeMetadataRoot,",
			"  findExistingMetadataNote,",
			"  ensureMetadataNote,",
			"} from './src/orchestration/utils/youtubeApi';",
			"export { TFile, TFolder } from 'obsidian';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'youtube-api-tombstone-test-entry.ts',
		loader: 'ts',
	},
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
					'export class TFile { constructor() { this.path = ""; } }',
					'export class TFolder { constructor() { this.path = ""; this.children = []; } }',
					'export function normalizePath(p) { return String(p ?? "").replace(/\\\\/g, "/").replace(/\\/+/g, "/"); }',
					'export async function requestUrl(options) { return await globalThis.__youtubeApiRespond(options); }',
					'export const Platform = {};',
					'export const moment = () => {};',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const {
	YoutubeVideoUnavailableError,
	buildYoutubeTombstoneNoteBody,
	youtubeWatchUrl,
	youtubeMetadataRoot,
	findExistingMetadataNote,
	ensureMetadataNote,
	TFile,
	TFolder,
} = await import(pathToFileURL(outfile).href);

function normalizePath(p) {
	return String(p ?? '').replace(/\\/g, '/').replace(/\/+/g, '/');
}

// Minimal in-memory vault — same shape as xApi.test.mjs's FakeVault: enough for
// findExistingMetadataNote's one-level child-folder probe and ensureMetadataNote's
// ensureFolder + create path.
class FakeVault {
	constructor() {
		this.filesByPath = new Map();
		this.foldersByPath = new Map();
	}
	getAbstractFileByPath(p) {
		const norm = normalizePath(p);
		if (this.filesByPath.has(norm)) return this.filesByPath.get(norm).file;
		if (this.foldersByPath.has(norm)) return this.foldersByPath.get(norm);
		return null;
	}
	async createFolder(p) {
		const norm = normalizePath(p);
		if (this.foldersByPath.has(norm)) throw new Error('Folder already exists.');
		const folder = new TFolder();
		folder.path = norm;
		folder.children = [];
		this.foldersByPath.set(norm, folder);
		const parentPath = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
		if (parentPath && this.foldersByPath.has(parentPath)) {
			this.foldersByPath.get(parentPath).children.push(folder);
		}
	}
	// Directly registers a file without going through create's collision guard —
	// used to simulate the "file already landed despite the probe miss" race the
	// second collision check inside ensureMetadataNote's catch branch exists for.
	seed(p, content) {
		const norm = normalizePath(p);
		const file = new TFile();
		file.path = norm;
		this.filesByPath.set(norm, { file, content });
		return file;
	}
	async create(p, content) {
		const norm = normalizePath(p);
		if (this.filesByPath.has(norm)) throw new Error('File already exists.');
		const file = new TFile();
		file.path = norm;
		this.filesByPath.set(norm, { file, content });
		const parentPath = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
		if (parentPath && this.foldersByPath.has(parentPath)) {
			this.foldersByPath.get(parentPath).children.push(file);
		}
		return file;
	}
	async read(file) {
		return this.filesByPath.get(file.path)?.content ?? '';
	}
	bodyAt(p) {
		return this.filesByPath.get(normalizePath(p))?.content;
	}
}

function makePlugin({ apiKey = 'test-api-key' } = {}) {
	const vault = new FakeVault();
	return {
		app: { vault, metadataCache: { getFileCache: () => null } },
		settings: { orchestrationYoutubeMetadataRoot: '_yt_metadata' },
		secretRegistry: { get: async () => apiKey },
		noteLocks: {
			withResourceLock: (_kind, _id, _label, fn) => fn(),
			withLock: (_path, _label, fn) => fn(),
		},
		_vault: vault,
	};
}

function respondItemsEmpty() {
	globalThis.__youtubeApiRespond = async () => ({ status: 200, text: JSON.stringify({ items: [] }), headers: {} });
}

function respondWithVideo(videoId, { channelId = 'UCchannel00000000000001', channelTitle = 'Test Channel' } = {}) {
	globalThis.__youtubeApiRespond = async () => ({
		status: 200,
		headers: {},
		text: JSON.stringify({
			items: [{
				id: videoId,
				snippet: {
					title: `Video ${videoId}`,
					description: 'A description.',
					channelId,
					channelTitle,
					publishedAt: '2026-01-01T00:00:00Z',
					categoryId: '22',
					liveBroadcastContent: 'none',
				},
				contentDetails: { duration: 'PT5M' },
				statistics: { viewCount: '10', likeCount: '1', commentCount: '0' },
			}],
		}),
	});
}

// ── buildYoutubeTombstoneNoteBody / youtubeWatchUrl (pure) ─────────────────────────

test('youtubeWatchUrl builds the canonical watch URL', () => {
	assert.equal(youtubeWatchUrl('abc123XYZ_-'), 'https://www.youtube.com/watch?v=abc123XYZ_-');
});

test('buildYoutubeTombstoneNoteBody is frontmatter-only with the documented keys', () => {
	const body = buildYoutubeTombstoneNoteBody('deadvideo01', youtubeWatchUrl('deadvideo01'), 'deleted-or-private');
	assert.match(body, /^---\n/);
	assert.match(body, /yt-video-id: "deadvideo01"/);
	assert.match(body, /url: https:\/\/www\.youtube\.com\/watch\?v=deadvideo01/);
	assert.match(body, /state: unavailable/);
	assert.match(body, /unavailable-reason: "deleted-or-private"/);
	assert.match(body, /source_command: youtube-fetch-video-metadata/);
	assert.match(body, /---\n\n?$/, 'no body — frontmatter-only, nothing invented');
});

// ── ensureMetadataNote: tombstone materialization ───────────────────────────────────

test('a zero-items fetch tombstones the video at <root>/_unavailable/<id>.md with state: unavailable', async () => {
	const plugin = makePlugin();
	respondItemsEmpty();
	const deadId = 'deadvideo001';

	const result = await ensureMetadataNote(plugin, deadId);
	assert.equal(result.status, 'tombstoned');
	assert.equal(result.metadataPath, `_yt_metadata/_unavailable/${deadId}.md`);

	const body = plugin._vault.bodyAt(result.metadataPath);
	assert.match(body, /yt-video-id: "deadvideo001"/);
	assert.match(body, /state: unavailable/);
	assert.match(body, /unavailable-reason: "deleted-or-private"/);
	assert.ok(!('channelId' in result), 'the tombstoned variant carries no channelId');
});

test('an existing tombstone is found by the shared probe and returns exists with no refetch', async () => {
	const plugin = makePlugin();
	const deadId = 'deadvideo002';
	respondItemsEmpty();

	const first = await ensureMetadataNote(plugin, deadId);
	assert.equal(first.status, 'tombstoned');

	let fetchCount = 0;
	globalThis.__youtubeApiRespond = async () => { fetchCount++; return { status: 200, text: JSON.stringify({ items: [] }), headers: {} }; };
	const second = await ensureMetadataNote(plugin, deadId);
	assert.equal(second.status, 'exists', 'snapshot forever — the probe treats a tombstone as exists');
	assert.equal(second.metadataPath, first.metadataPath);
	assert.equal(fetchCount, 0, 'no refetch of a durable outcome, dead or alive');
});

test('a collision at the tombstone path (file already landed despite the probe miss) returns tombstoned without a second create', async () => {
	const plugin = makePlugin();
	const deadId = 'deadvideo003';
	respondItemsEmpty();
	// Simulate the file already existing at the tombstone path by the time the catch
	// branch runs, without going through findExistingMetadataNote's folder-scan probe
	// (which only looks under a TFolder root) — the same shape as ensureXMetadataNote's
	// second collision check.
	plugin._vault.seed(`_yt_metadata/_unavailable/${deadId}.md`, 'PRE-EXISTING');

	const result = await ensureMetadataNote(plugin, deadId);
	assert.equal(result.status, 'tombstoned');
	assert.equal(result.metadataPath, `_yt_metadata/_unavailable/${deadId}.md`);
	assert.equal(plugin._vault.bodyAt(result.metadataPath), 'PRE-EXISTING', 'no create() call — the pre-existing body is untouched');
});

test('a live fetch still creates a normal metadata note (tombstoning is per-video, not global)', async () => {
	const plugin = makePlugin();
	const liveId = 'livevideo001';
	respondWithVideo(liveId);

	const result = await ensureMetadataNote(plugin, liveId);
	assert.equal(result.status, 'created');
	assert.equal(result.channelId, 'UCchannel00000000000001');
	assert.ok(!result.metadataPath.includes('_unavailable'));
});

test('a transient YoutubeApiUnavailableError-class failure (5xx) propagates untouched — no tombstone written', async () => {
	const plugin = makePlugin();
	globalThis.__youtubeApiRespond = async () => ({ status: 503, text: '', headers: {} });
	const id = 'flakyvideo01';

	await assert.rejects(ensureMetadataNote(plugin, id));
	assert.equal(await findExistingMetadataNote(plugin.app, youtubeMetadataRoot(plugin), id), null);
});

test('YoutubeVideoUnavailableError carries the deleted-or-private reason', () => {
	const err = new YoutubeVideoUnavailableError('YouTube Data API: video x not found', 'deleted-or-private');
	assert.equal(err.name, 'YoutubeVideoUnavailableError');
	assert.equal(err.reason, 'deleted-or-private');
	assert.ok(err instanceof Error);
});
