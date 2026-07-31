import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// XBackfillWorkflow transitively pulls in xApi.ts (findExistingXMetadataNote/
// xMetadataRoot — obsidian's TFolder/TFile/normalizePath, no network) and
// xPost.ts (pure). Same esbuild-bundle + obsidian-stub pattern as
// tests/xPostDiscoverWorkflow.test.mjs.

const outdir = path.join(tmpdir(), 'obsidian-crucible-x-backfill-workflow-tests');
const outfile = path.join(outdir, 'XBackfillWorkflow.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { XBackfillWorkflow } from './src/orchestration/workflows/XBackfillWorkflow';",
			"export { TFile, TFolder } from 'obsidian';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'x-backfill-workflow-test-entry.ts',
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
					'export class TFile { constructor() { this.path = ""; this.extension = "md"; } }',
					'export class TFolder { constructor() { this.path = ""; this.children = []; } }',
					'export function normalizePath(p) { return String(p ?? "").replace(/\\\\/g, "/").replace(/\\/+/g, "/"); }',
					'export async function requestUrl() { throw new Error("requestUrl unavailable in backfill tests"); }',
					'export function htmlToMarkdown(html) { return String(html); }',
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

const { XBackfillWorkflow, TFile, TFolder } = await import(pathToFileURL(outfile).href);

function normalizePath(p) {
	return String(p ?? '').replace(/\\/g, '/').replace(/\/+/g, '/');
}

// Minimal in-memory vault + metadataCache: getMarkdownFiles (the registry
// prefix walk), getAbstractFileByPath (source-link probe + the metadata probe's
// one-level child-folder walk), getFileCache (frontmatter), and
// getFirstLinkpathDest (the shorthand-link fallback).
class FakeVault {
	constructor() {
		this.filesByPath = new Map();
		this.foldersByPath = new Map();
		this.frontmatterByPath = new Map();
	}
	getAbstractFileByPath(p) {
		const norm = normalizePath(p);
		if (this.filesByPath.has(norm)) return this.filesByPath.get(norm);
		if (this.foldersByPath.has(norm)) return this.foldersByPath.get(norm);
		return null;
	}
	getMarkdownFiles() {
		return Array.from(this.filesByPath.values()).filter(f => f.extension === 'md');
	}
	// Seeds a link-registry record note with the given frontmatter.
	seedRecord(p, frontmatter) {
		const norm = normalizePath(p);
		const file = new TFile();
		file.path = norm;
		file.extension = 'md';
		this.filesByPath.set(norm, file);
		this.frontmatterByPath.set(norm, frontmatter);
		return file;
	}
	// Seeds a plain (non-registry) source note that a link record can cite.
	seedSourceNote(p) {
		const norm = normalizePath(p);
		const file = new TFile();
		file.path = norm;
		file.extension = 'md';
		this.filesByPath.set(norm, file);
		return file;
	}
	// Registers an already-materialized metadata note under `<root>/<child>/<id>.md`,
	// matching findExistingXMetadataNote's one-level child-folder probe shape.
	seedMaterialized(root, statusId) {
		const rootPath = normalizePath(root);
		let rootFolder = this.foldersByPath.get(rootPath);
		if (!rootFolder) {
			rootFolder = new TFolder();
			rootFolder.path = rootPath;
			rootFolder.children = [];
			this.foldersByPath.set(rootPath, rootFolder);
		}
		const folderPath = normalizePath(`${root}/author`);
		let folder = this.foldersByPath.get(folderPath);
		if (!folder) {
			folder = new TFolder();
			folder.path = folderPath;
			folder.children = [];
			this.foldersByPath.set(folderPath, folder);
			rootFolder.children.push(folder);
		}
		const notePath = normalizePath(`${folderPath}/${statusId}.md`);
		const file = new TFile();
		file.path = notePath;
		file.extension = 'md';
		this.filesByPath.set(notePath, file);
	}
}

function makePlugin(overrides = {}) {
	const vault = new FakeVault();
	const enqueued = [];
	const linkResolvers = new Map(); // linkpath -> TFile, for getFirstLinkpathDest fallback
	const metadataCache = {
		getFileCache: (file) => ({ frontmatter: vault.frontmatterByPath.get(file.path) }),
		getFirstLinkpathDest: (linkpath) => linkResolvers.get(linkpath) ?? null,
	};
	return {
		app: { vault, metadataCache },
		settings: { orchestrationLinkRegistryRoot: '_crucible/link_registry', orchestrationXMetadataRoot: '_x_metadata', ...overrides },
		orchestrator: {
			enqueue: async (type, params, options) => {
				enqueued.push({ type, params, options });
				return { id: `job-${enqueued.length}`, type, status: 'queued', priority: options?.priority ?? 'normal', lane: options?.lane ?? 'background' };
			},
		},
		_vault: vault,
		_enqueued: enqueued,
		_linkResolvers: linkResolvers,
	};
}

function makeCtx(plugin) {
	const signal = new AbortController().signal;
	return { plugin, signal, throwIfAborted: () => signal.throwIfAborted() };
}

const ROOT = '_crucible/link_registry';

// ── basic selection: link-record required, X-status required ────────────────────

test('a non-link-record note under the registry root is ignored entirely', async () => {
	const plugin = makePlugin();
	plugin._vault.seedRecord(`${ROOT}/not-a-record.md`, { type: 'something-else', 'x-status-id': '111' });
	const result = await new XBackfillWorkflow().run({ id: 'j1', params: {} }, makeCtx(plugin));
	assert.equal(result.status, 'done');
	assert.equal(plugin._enqueued.length, 0);
	assert.match(result.notes, /Scanned 0 link-registry record/);
});

test('a link-record with no X identity (YT-only) is scanned but contributes no status', async () => {
	const plugin = makePlugin();
	plugin._vault.seedRecord(`${ROOT}/yt-record.md`, {
		type: 'link-record',
		url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
		canonical_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
		'yt-video-id': 'dQw4w9WgXcQ',
	});
	const result = await new XBackfillWorkflow().run({ id: 'j1', params: {} }, makeCtx(plugin));
	assert.equal(result.status, 'done');
	assert.equal(plugin._enqueued.length, 0);
	assert.match(result.notes, /Scanned 1 link-registry record/);
	assert.match(result.notes, /0 X status\(es\) found/);
});

test('a link-record with an explicit x-status-id enqueues x_metadata_fetch', async () => {
	const plugin = makePlugin();
	const source = plugin._vault.seedSourceNote('clips/one.md');
	plugin._vault.seedRecord(`${ROOT}/x-record.md`, {
		type: 'link-record',
		url: 'https://x.com/PandaAshwinee/status/2078296458122645635',
		canonical_url: 'https://x.com/PandaAshwinee/status/2078296458122645635',
		'x-status-id': '2078296458122645635',
		source_notes: ['[[clips/one]]'],
	});
	const result = await new XBackfillWorkflow().run({ id: 'j1', params: {} }, makeCtx(plugin));
	assert.equal(result.status, 'done');
	assert.equal(plugin._enqueued.length, 1);
	const job = plugin._enqueued[0];
	assert.equal(job.type, 'x_metadata_fetch');
	assert.equal(job.params.statusId, '2078296458122645635');
	assert.equal(job.params.url, 'https://x.com/PandaAshwinee/status/2078296458122645635');
	assert.deepEqual(job.params.sourcePaths, [source.path]);
	assert.equal(job.options.lane, 'background');
});

test('a link-record with no x-status-id falls back to extracting the status from canonical_url', async () => {
	const plugin = makePlugin();
	plugin._vault.seedRecord(`${ROOT}/x-record-2.md`, {
		type: 'link-record',
		url: 'https://twitter.com/PandaAshwinee/status/999999999999999201?s=20',
		canonical_url: 'https://x.com/PandaAshwinee/status/999999999999999201',
	});
	await new XBackfillWorkflow().run({ id: 'j1', params: {} }, makeCtx(plugin));
	assert.equal(plugin._enqueued.length, 1);
	assert.equal(plugin._enqueued[0].params.statusId, '999999999999999201');
});

// ── skip already-materialized ────────────────────────────────────────────────────

test('an already-materialized (or tombstoned) status is skipped, not enqueued', async () => {
	const plugin = makePlugin();
	const statusId = '2078296458122645635';
	plugin._vault.seedMaterialized('_x_metadata', statusId);
	plugin._vault.seedRecord(`${ROOT}/x-record.md`, {
		type: 'link-record',
		canonical_url: `https://x.com/PandaAshwinee/status/${statusId}`,
		'x-status-id': statusId,
	});
	const result = await new XBackfillWorkflow().run({ id: 'j1', params: {} }, makeCtx(plugin));
	assert.equal(plugin._enqueued.length, 0);
	assert.match(result.notes, /1 already materialized/);
	assert.match(result.notes, /0 enqueued/);
});

// ── dedupe across records: unioned sourcePaths, first record's url wins ─────────

test('the same status cited by two records collapses onto one job with unioned sourcePaths', async () => {
	const plugin = makePlugin();
	const statusId = '2078296458122645635';
	const noteA = plugin._vault.seedSourceNote('clips/a.md');
	const noteB = plugin._vault.seedSourceNote('clips/b.md');
	plugin._vault.seedRecord(`${ROOT}/record-a.md`, {
		type: 'link-record',
		url: 'https://x.com/PandaAshwinee/status/2078296458122645635',
		canonical_url: 'https://x.com/PandaAshwinee/status/2078296458122645635',
		'x-status-id': statusId,
		source_notes: ['[[clips/a]]'],
	});
	plugin._vault.seedRecord(`${ROOT}/record-b.md`, {
		type: 'link-record',
		// A second record for the same status carries a different canonical_url
		// string (an artificial case for this test) — the first record processed
		// (record-a, insertion order) must win; record-b only contributes its
		// source note.
		url: 'https://x.com/PandaAshwinee/status/2078296458122645635?s=20',
		canonical_url: 'https://x.com/i/web/status/2078296458122645635',
		'x-status-id': statusId,
		source_notes: ['[[clips/b]]'],
	});
	const result = await new XBackfillWorkflow().run({ id: 'j1', params: {} }, makeCtx(plugin));
	assert.equal(plugin._enqueued.length, 1);
	const job = plugin._enqueued[0];
	assert.equal(job.params.statusId, statusId);
	assert.equal(job.params.url, 'https://x.com/PandaAshwinee/status/2078296458122645635');
	assert.deepEqual(job.params.sourcePaths.sort(), [noteA.path, noteB.path].sort());
	assert.match(result.notes, /1 X status\(es\) found/, 'two records citing the same status collapse onto one status');
});

// ── legacy scalar source_notes ───────────────────────────────────────────────────

test('a legacy single-string source_notes value (not an array) still resolves', async () => {
	const plugin = makePlugin();
	const note = plugin._vault.seedSourceNote('clips/legacy.md');
	plugin._vault.seedRecord(`${ROOT}/legacy-record.md`, {
		type: 'link-record',
		canonical_url: 'https://x.com/PandaAshwinee/status/2078296458122645635',
		'x-status-id': '2078296458122645635',
		source_notes: '[[clips/legacy]]',
	});
	await new XBackfillWorkflow().run({ id: 'j1', params: {} }, makeCtx(plugin));
	assert.deepEqual(plugin._enqueued[0].params.sourcePaths, [note.path]);
});

// ── unresolvable source link: dropped and counted, never thrown ─────────────────

test('an unresolvable source_notes entry is dropped and counted, not thrown on', async () => {
	const plugin = makePlugin();
	plugin._vault.seedRecord(`${ROOT}/dangling.md`, {
		type: 'link-record',
		canonical_url: 'https://x.com/PandaAshwinee/status/2078296458122645635',
		'x-status-id': '2078296458122645635',
		source_notes: ['[[clips/gone]]'],
	});
	const result = await new XBackfillWorkflow().run({ id: 'j1', params: {} }, makeCtx(plugin));
	assert.equal(result.status, 'done');
	assert.equal(plugin._enqueued.length, 1);
	assert.deepEqual(plugin._enqueued[0].params.sourcePaths, []);
	assert.match(result.notes, /1 source link\(s\) dropped/);
});

test('a source link that only resolves via getFirstLinkpathDest (shorthand fallback) is kept, not dropped', async () => {
	const plugin = makePlugin();
	const nested = plugin._vault.seedSourceNote('deep/nested/shorthand.md');
	plugin._linkResolvers.set('shorthand', nested);
	plugin._vault.seedRecord(`${ROOT}/shorthand-record.md`, {
		type: 'link-record',
		canonical_url: 'https://x.com/PandaAshwinee/status/2078296458122645635',
		'x-status-id': '2078296458122645635',
		source_notes: ['[[shorthand]]'],
	});
	const result = await new XBackfillWorkflow().run({ id: 'j1', params: {} }, makeCtx(plugin));
	assert.deepEqual(plugin._enqueued[0].params.sourcePaths, [nested.path]);
	assert.match(result.notes, /0 source link\(s\) dropped/);
});

// ── registry-root scoping ────────────────────────────────────────────────────────

test('a link-record note outside the configured registry root is not scanned', async () => {
	const plugin = makePlugin();
	plugin._vault.seedRecord('elsewhere/not-in-registry.md', {
		type: 'link-record',
		canonical_url: 'https://x.com/PandaAshwinee/status/2078296458122645635',
		'x-status-id': '2078296458122645635',
	});
	const result = await new XBackfillWorkflow().run({ id: 'j1', params: {} }, makeCtx(plugin));
	assert.equal(plugin._enqueued.length, 0);
	assert.match(result.notes, /Scanned 0 link-registry record/);
});

// ── pacing shape: chunked with a pause every ENQUEUE_CHUNK enqueues ─────────────

test('enqueuing more than one chunk worth of statuses pauses between chunks', async () => {
	const plugin = makePlugin();
	for (let i = 0; i < 12; i++) {
		const statusId = `100000000000000000${i}`;
		plugin._vault.seedRecord(`${ROOT}/record-${i}.md`, {
			type: 'link-record',
			canonical_url: `https://x.com/user/status/${statusId}`,
			'x-status-id': statusId,
		});
	}

	const originalSetTimeout = globalThis.setTimeout;
	const pauses = [];
	globalThis.setTimeout = (fn, ms) => {
		pauses.push(ms);
		return originalSetTimeout(fn, 0);
	};
	try {
		const result = await new XBackfillWorkflow().run({ id: 'j1', params: {} }, makeCtx(plugin));
		assert.equal(result.status, 'done');
		assert.equal(plugin._enqueued.length, 12);
		assert.ok(pauses.includes(200), `expected at least one 200ms pacing pause, got: ${JSON.stringify(pauses)}`);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
});
