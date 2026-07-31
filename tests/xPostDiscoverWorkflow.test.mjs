import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// XPostDiscoverWorkflow transitively pulls in xApi.ts (findExistingXMetadataNote/
// xMetadataRoot — obsidian's TFolder/TFile/normalizePath, no network), urlExtract.ts
// and urlCanonicalize.ts (both pure). Same esbuild-bundle + obsidian-stub pattern as
// tests/searchWorkflowQueue.test.mjs.

const outdir = path.join(tmpdir(), 'obsidian-crucible-x-post-discover-workflow-tests');
const outfile = path.join(outdir, 'XPostDiscoverWorkflow.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { XPostDiscoverWorkflow } from './src/orchestration/workflows/XPostDiscoverWorkflow';",
			"export { TFile, TFolder } from 'obsidian';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'x-post-discover-workflow-test-entry.ts',
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
					'export function normalizePath(p) { return p.replace(/\\\\/g, "/").replace(/\\/+/g, "/"); }',
					'export async function requestUrl() { throw new Error("requestUrl unavailable in discover tests"); }',
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

const { XPostDiscoverWorkflow, TFile, TFolder } = await import(pathToFileURL(outfile).href);

function normalizePath(p) {
	return p.replace(/\\/g, '/').replace(/\/+/g, '/');
}

// Minimal in-memory vault: getAbstractFileByPath (note lookup + the metadata probe's
// one-level child-folder walk) and cachedRead. No writes are exercised on the vault
// side by this workflow.
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
	async cachedRead(file) {
		return this.filesByPath.get(normalizePath(file.path))?.content ?? '';
	}
	seedNote(p, content) {
		const norm = normalizePath(p);
		const file = new TFile();
		file.path = norm;
		file.extension = 'md';
		this.filesByPath.set(norm, { file, content });
		return file;
	}
	// Registers an already-materialized metadata note under `<root>/<child>/<id>.md`,
	// matching findExistingXMetadataNote's one-level child-folder probe shape (a real
	// root TFolder whose children include the author sub-TFolder).
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
		this.seedNote(`${folderPath}/${statusId}.md`, `---\nstatus-id: "${statusId}"\n---\n`);
	}
}

function makePlugin() {
	const vault = new FakeVault();
	const enqueued = [];
	return {
		app: { vault },
		settings: { orchestrationXMetadataRoot: '_x_metadata' },
		orchestrator: {
			enqueue: async (type, params, options) => {
				enqueued.push({ type, params, options });
				return { id: `job-${enqueued.length}`, type, status: 'queued', priority: options?.priority ?? 'normal', lane: options?.lane ?? 'background' };
			},
		},
		_vault: vault,
		_enqueued: enqueued,
	};
}

function makeCtx(plugin) {
	const signal = new AbortController().signal;
	return { plugin, signal, throwIfAborted: () => signal.throwIfAborted() };
}

// ── missing/invalid targetPath ──────────────────────────────────────────────────

test('missing targetPath fails', async () => {
	const plugin = makePlugin();
	const result = await new XPostDiscoverWorkflow().run({ id: 'j1', params: {} }, makeCtx(plugin));
	assert.equal(result.status, 'failed');
	assert.equal(result.error, 'Missing params.targetPath');
	assert.equal(plugin._enqueued.length, 0);
});

test('a targetPath that does not resolve to a TFile fails', async () => {
	const plugin = makePlugin();
	const result = await new XPostDiscoverWorkflow().run(
		{ id: 'j1', params: { targetPath: 'gone.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'failed');
	assert.equal(result.error, 'Target note not found: gone.md');
});

// ── extraction + dedupe + skip + enqueue ─────────────────────────────────────────

test('a note with mixed URLs enqueues exactly the un-materialized distinct X statuses, each with sourcePaths:[targetPath]', async () => {
	const plugin = makePlugin();
	const content = [
		'# Clip',
		'',
		'Two variant URLs of the same status:',
		'https://x.com/PandaAshwinee/status/2078296458122645635?s=20',
		'https://twitter.com/PandaAshwinee/status/2078296458122645635?t=abc',
		'',
		'A distinct status:',
		'https://x.com/i/web/status/999999999999999201',
		'',
		'Noise that must not match:',
		'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
		'https://arxiv.org/abs/2401.12345',
	].join('\n');
	plugin._vault.seedNote('clips/mixed.md', content);

	const result = await new XPostDiscoverWorkflow().run(
		{ id: 'j1', params: { targetPath: 'clips/mixed.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.equal(plugin._enqueued.length, 2, 'the two x.com/twitter.com variants collapse onto one status');

	const types = new Set(plugin._enqueued.map(j => j.type));
	assert.deepEqual(types, new Set(['x_metadata_fetch']));

	const statusIds = plugin._enqueued.map(j => j.params.statusId).sort();
	assert.deepEqual(statusIds, ['2078296458122645635', '999999999999999201'].sort());

	for (const job of plugin._enqueued) {
		assert.deepEqual(job.params.sourcePaths, ['clips/mixed.md']);
		assert.equal(job.options.lane, 'background');
		assert.deepEqual(job.options.inputPaths, ['clips/mixed.md']);
	}

	assert.match(result.notes, /Found 2 X status\(es\)/);
	assert.match(result.notes, /0 already materialized/);
	assert.match(result.notes, /2 enqueued/);
});

test('an already-materialized status is skipped, not enqueued', async () => {
	const plugin = makePlugin();
	const statusId = '2078296458122645635';
	plugin._vault.seedMaterialized('_x_metadata', statusId);
	plugin._vault.seedNote('clips/one.md', `See https://x.com/PandaAshwinee/status/${statusId}`);

	const result = await new XPostDiscoverWorkflow().run(
		{ id: 'j1', params: { targetPath: 'clips/one.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.equal(plugin._enqueued.length, 0);
	assert.match(result.notes, /Found 1 X status\(es\)/);
	assert.match(result.notes, /1 already materialized/);
	assert.match(result.notes, /0 enqueued/);
});

test('a note with no X links enqueues nothing', async () => {
	const plugin = makePlugin();
	plugin._vault.seedNote('clips/none.md', 'No links here at all.');
	const result = await new XPostDiscoverWorkflow().run(
		{ id: 'j1', params: { targetPath: 'clips/none.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.equal(plugin._enqueued.length, 0);
	assert.match(result.notes, /Found 0 X status\(es\)/);
});
