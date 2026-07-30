import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// The dashboard's live "queued / enriching…" state for `youtube_metadata_fetch`.
//
// thq WP-8: this replaces `EnrichmentQueueAdapter.metadataInFlightByPath()` and
// `.getEntry(videoId)`. The adapter existed to translate the in-memory queue's entries
// into a video-shaped view; metadata fetches are ordinary durable jobs now, so the whole
// translation layer collapses to one `Orchestrator.listTypeJobs` call plus the two
// indexes the two consuming sections need.

const outdir = path.join(tmpdir(), 'obsidian-crucible-metadata-fetch-status-tests');
const outfile = path.join(outdir, 'metadataFetchStatus.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { computeMetadataFetchStatus, emptyMetadataFetchStatus } from './src/ingestion/data/metadataFetchStatus';",
			"export { ENRICHMENT_JOB_TYPE } from './src/orchestration/jobTypeConfig';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'metadata-fetch-status-test-entry.ts',
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
					'export class Notice {}',
					'export class TFile {}',
					'export class TFolder {}',
					'export class App {}',
					'export class Modal {}',
					'export class Setting {}',
					'export class FuzzySuggestModal {}',
					'export class FileSystemAdapter {}',
					'export function normalizePath(p) { return p; }',
					'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
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

const { computeMetadataFetchStatus, emptyMetadataFetchStatus, ENRICHMENT_JOB_TYPE } = await import(pathToFileURL(outfile).href);

// A plugin whose orchestrator answers `listTypeJobs` from a fixed list — the seam the
// dashboard reads through, and the only thing this module touches.
function makePlugin(jobsByStatus = {}) {
	return {
		orchestrator: {
			calls: [],
			async listTypeJobs(type, statuses) {
				this.calls.push({ type, statuses });
				return statuses.flatMap(status => (jobsByStatus[status] ?? []).map(job => ({ ...job, status })));
			},
		},
	};
}

function job(params) {
	return { id: `job-${JSON.stringify(params)}`, type: ENRICHMENT_JOB_TYPE, params };
}

test('per-note jobs index by target path; standalone jobs index by video id', async () => {
	const plugin = makePlugin({
		queued: [job({ targetPath: 'Notes/a.md', videoId: 'aaaaaaaaaaa' }), job({ videoId: 'bbbbbbbbbbb' })],
	});

	const status = await computeMetadataFetchStatus(plugin);

	assert.deepEqual([...status.byPath], [['Notes/a.md', 'queued']]);
	assert.deepEqual([...status.byStandaloneVideoId], [['bbbbbbbbbbb', 'queued']]);
});

test('a per-note job is NOT indexed by its video id — the two lists ask different questions', async () => {
	// The Uncaptured Videos list is about videos with no vault note yet; a job that
	// carries a targetPath belongs to a note that already exists, so surfacing it there
	// would badge a row that is not in that list's world. The memory queue encoded this
	// in its entry key (`note:` vs `video:`); this reads the cause — the presence of a
	// targetPath — rather than the effect.
	const plugin = makePlugin({ running: [job({ targetPath: 'Notes/a.md', videoId: 'aaaaaaaaaaa' })] });

	const status = await computeMetadataFetchStatus(plugin);

	assert.equal(status.byStandaloneVideoId.size, 0);
	assert.equal(status.byPath.get('Notes/a.md'), 'running');
});

test('running wins over queued for the same target', async () => {
	// Both can exist for one path only transiently, but a badge flipping back to
	// "queued" while the job is visibly running is exactly the kind of flicker the
	// dashboard's repaint signature would then chase.
	const plugin = makePlugin({
		running: [job({ targetPath: 'Notes/a.md' })],
		queued: [job({ targetPath: 'Notes/a.md' })],
	});

	const status = await computeMetadataFetchStatus(plugin);
	assert.equal(status.byPath.get('Notes/a.md'), 'running');
});

test('it asks for running before queued, in ONE query, and only for the enrichment type', async () => {
	const plugin = makePlugin({});
	await computeMetadataFetchStatus(plugin);

	assert.deepEqual(plugin.orchestrator.calls, [{ type: ENRICHMENT_JOB_TYPE, statuses: ['running', 'queued'] }],
		'one call: both consuming sections share the result rather than each paying for a pass');
});

test('jobs with neither a target path nor a video id are simply absent', async () => {
	const plugin = makePlugin({ queued: [job({}), job({ videoId: '' })] });
	const status = await computeMetadataFetchStatus(plugin);

	assert.equal(status.byPath.size, 0);
	assert.equal(status.byStandaloneVideoId.size, 0);
});

test('a plugin with no orchestrator answers empty rather than throwing', async () => {
	// The dashboard can render during a load in which orchestration failed to register
	// (an unopenable jobs DB) — an empty badge map is the honest answer there.
	const status = await computeMetadataFetchStatus({ orchestrator: null });
	assert.deepEqual([...status.byPath], []);
	assert.deepEqual([...status.byStandaloneVideoId], []);
	assert.deepEqual(status, emptyMetadataFetchStatus());
});

test('STRUCTURAL: no dashboard surface reaches for the deleted enrichment adapter', () => {
	// The reach-around this WP closed. `enrichmentQueue` was a plugin field the ingestion
	// dashboard read from four separate modules; every one of them goes through the
	// Orchestrator seam now.
	for (const file of [
		'src/ingestionDashboard.ts',
		'src/ingestion/render/cells.ts',
		'src/ingestion/sections/uncapturedVideos.ts',
		'src/ingestion/sections/youtubeWithoutMetadata.ts',
		'src/ingestion/sections/queueMonitor.ts',
	]) {
		const src = readFileSync(file, 'utf8');
		assert.doesNotMatch(src, /enrichmentQueue|EnrichmentQueueAdapter/, `${file} must not reach for the enrichment adapter`);
	}
});
