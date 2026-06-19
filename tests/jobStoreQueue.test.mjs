import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-jobstore-tests');
const outfile = path.join(outdir, 'JobStore.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/orchestration/JobStore.ts'],
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
					'export class Notice { constructor() {} hide() {} setMessage() {} }',
					'export class TFile { constructor(name, fm) { this.name = name; this.basename = name.replace(/\\.md$/, ""); this.extension = "md"; this.path = `_crucible/orchestration/queue/inbox/${name}`; this.fm = fm; } }',
					'export class TFolder { constructor(children) { this.children = children; } }',
					'globalThis.__JobStoreTestTFile = TFile;',
					'globalThis.__JobStoreTestTFolder = TFolder;',
					'export const Platform = { isDesktopApp: true, isMobileApp: false };',
					'export function normalizePath(p) { return String(p).replace(/\\/+/g, "/"); }',
					'export function parseYaml() { return {}; }',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { JobStore } = await import(pathToFileURL(outfile).href);
const TFile = globalThis.__JobStoreTestTFile;
const TFolder = globalThis.__JobStoreTestTFolder;

function jobFile(id, priority, lane) {
	return new TFile(`${id}.md`, {
		id,
		type: 'search_upsert_file',
		status: 'queued',
		priority,
		lane,
		created: id,
		params: { path: `${id}.md` },
	});
}

test('file-backed jobs list user lane before background priority', async () => {
	const folder = new TFolder([
		jobFile('001-background-high', 'high', 'background'),
		jobFile('002-user-low', 'low', 'user'),
		jobFile('003-user-high', 'high', 'user'),
	]);
	const plugin = {
		settings: { orchestrationQueueRoot: '_crucible/orchestration/queue' },
		app: {
			vault: { getAbstractFileByPath: () => folder },
			metadataCache: { getFileCache: file => ({ frontmatter: file.fm }) },
		},
	};

	const rows = await new JobStore(plugin).listFolder('queued');

	assert.deepEqual(rows.map(row => row.job.id), [
		'003-user-high',
		'002-user-low',
		'001-background-high',
	]);
});

test('legacy high-priority jobs default to the user lane', async () => {
	const folder = new TFolder([
		jobFile('001-background-normal', 'normal', 'background'),
		new TFile('002-legacy-high.md', {
			id: '002-legacy-high',
			type: 'search_upsert_file',
			status: 'queued',
			priority: 'high',
			created: '002',
			params: { path: 'legacy.md' },
		}),
	]);
	const plugin = {
		settings: { orchestrationQueueRoot: '_crucible/orchestration/queue' },
		app: {
			vault: { getAbstractFileByPath: () => folder },
			metadataCache: { getFileCache: file => ({ frontmatter: file.fm }) },
		},
	};

	const rows = await new JobStore(plugin).listFolder('queued');

	assert.equal(rows[0].job.id, '002-legacy-high');
	assert.equal(rows[0].job.lane, 'user');
});
