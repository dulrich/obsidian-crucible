import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// SE WP-4 (updated r2f-WP1 for the RSS->Data-API tracker swap): FeedTrackerWorkflow's
// all-feeds-failed branch (shared by YoutubeTrackerWorkflow and BlogsTrackerWorkflow — see
// the class hierarchy at the bottom of src/orchestration/workflows/FeedTrackerWorkflow.ts)
// must defer with `serviceUnhealthy: { service: 'youtube-api', ... }` for the YouTube
// tracker, but leave the blogs tracker's identical branch as a plain job-level `failed` —
// blogs feeds span arbitrary hosts with no single service identity to name (explicitly out
// of scope per the plan).
//
// This bundles the REAL FeedTrackerWorkflow/YoutubeTrackerWorkflow/BlogsTrackerWorkflow
// classes (not a stand-in), and drives FeedTrackerWorkflow directly with a minimal custom
// FeedSource — the class is explicitly generic over `FeedSource<Entry, Item>`, so this is
// exercising the real shared branch, just without the real RSS/Atom parsing machinery. A
// separate structural check below ties that generic behavior back to the two production
// subclasses by asserting their `source.kind`.

const outdir = path.join(tmpdir(), 'obsidian-crucible-feed-tracker-tests');
const outfile = path.join(outdir, 'FeedTrackerWorkflow.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { FeedTrackerWorkflow, YoutubeTrackerWorkflow, BlogsTrackerWorkflow } from './src/orchestration/workflows/FeedTrackerWorkflow';",
			"export { TFile } from 'obsidian';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'feed-tracker-test-entry.ts',
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
				// The full surface every module on the FeedTrackerWorkflow import chain touches
				// at the top level (feedSources -> blogsApi pulls in htmlToMarkdown/parseYaml even
				// though this test never exercises the blogs metadata-note path that calls them).
				contents: [
					'export class App {}',
					'export class TFile {}',
					'export class TFolder {}',
					'export function normalizePath(p) { return p; }',
					"export async function requestUrl() { throw new Error('requestUrl unavailable in tests'); }",
					'export const Platform = {};',
					'export const moment = () => {};',
					'export function htmlToMarkdown() { return ""; }',
					'export function parseYaml() { return {}; }',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { FeedTrackerWorkflow, YoutubeTrackerWorkflow, BlogsTrackerWorkflow, TFile } = await import(pathToFileURL(outfile).href);

// ── Structural: the production classes really do carry the kind this test exercises ────────

test('YoutubeTrackerWorkflow and BlogsTrackerWorkflow wire distinct source.kind', () => {
	assert.equal(new YoutubeTrackerWorkflow().source.kind, 'youtube');
	assert.equal(new BlogsTrackerWorkflow().source.kind, 'blogs');
});

// ── Harness: a minimal FeedSource whose registry has one entry, and whose fetchFeed always
// rejects — enough to walk FeedTrackerWorkflow.run() all the way to the all-feeds-failed
// branch without needing real RSS parsing or a populated vault.

function makeApp(registryPath) {
	const files = new Map();
	files.set(registryPath, Object.assign(new TFile(), { path: registryPath }));
	return {
		vault: {
			getAbstractFileByPath: p => files.get(p) ?? null,
			read: async () => '(opaque — this harness\'s parseRegistry ignores the content)',
			getMarkdownFiles: () => [],
			create: async (p, body) => {
				const file = Object.assign(new TFile(), { path: p, __body: body });
				files.set(p, file);
				return file;
			},
			createFolder: async () => {},
		},
		metadataCache: { getFileCache: () => null },
	};
}

function makePlugin(app) {
	return {
		app,
		settings: {
			orchestrationTimezone: 'UTC',
			orchestrationYoutubeTrackerDiffMode: true,
			orchestrationBlogsTrackerDiffMode: true,
			orchestrationYoutubeTrackerWriteEmptyRuns: false,
			orchestrationBlogsTrackerWriteEmptyRuns: false,
			orchestrationLinkRegistryRoot: '_crucible/link_registry',
			orchestrationYoutubeMetadataRoot: '_yt_metadata',
			orchestrationBlogsMetadataRoot: '_blog_metadata',
		},
	};
}

function makeCtx(plugin) {
	const signal = new AbortController().signal;
	return { plugin, signal, throwIfAborted: () => signal.throwIfAborted() };
}

const REGISTRY_PATH = 'registry.md';

function makeSource(kind, fetchFeed) {
	return {
		kind,
		intakeRoot: `_crucible/orchestration/${kind}/new-items`,
		queueScanSkipPrefix: '_crucible/orchestration/',
		trackerGeneratedBy: `orchestrator/${kind}_tracker`,
		registryPath: () => REGISTRY_PATH,
		parseRegistry: () => ({ entries: [{ id: 'entry-1' }], rowErrors: [] }),
		fetchFeed,
		allFeedsFailedError: n => `All ${n} feeds failed to fetch.`,
		totalFmKey: 'total',
		withNewFmKey: 'with_new',
		itemsTotalFmKey: 'items_total',
		failedFmKey: 'failed',
		itemIdsFmKey: 'item_ids',
		titlePrefix: 'Tracker',
		noNewText: 'No new items.',
		failedHeading: 'Failed',
		entryHeading: entry => entry.id,
		entryPriority: () => 'normal',
	};
}

// ── YouTube: all-feeds-failed defers and names youtube-api ─────────────────────────────────

test('YouTube all-feeds-failed defers with serviceUnhealthy naming youtube-api', async () => {
	const app = makeApp(REGISTRY_PATH);
	const plugin = makePlugin(app);
	const source = makeSource('youtube', async () => { throw new Error('getaddrinfo ENOTFOUND www.googleapis.com'); });
	const workflow = new FeedTrackerWorkflow(source);

	const result = await workflow.run({ id: 'job-1', params: {} }, makeCtx(plugin));

	assert.equal(result.status, 'deferred');
	assert.equal(result.error, 'All 1 feeds failed to fetch.');
	assert.equal(result.retryAfterMs, 30_000);
	assert.deepEqual(result.serviceUnhealthy, {
		service: 'youtube-api',
		kind: 'server-error',
		reason: 'All 1 feeds failed to fetch.',
	});
	// The intake note recording the failure still gets written — deferring the JOB must not
	// mean losing the record of what was attempted.
	assert.equal(result.outputPaths.length, 1);
});

// ── YouTube: an all-missing-key run fails plainly and never opens the breaker ───────────────

test('YouTube all-feeds-failed with only missing-key errors fails plainly, no serviceUnhealthy', async () => {
	const app = makeApp(REGISTRY_PATH);
	const plugin = makePlugin(app);
	const configError = 'YouTube Data API key not configured — set it in Settings → Orchestrator.';
	const source = makeSource('youtube', async () => { throw new Error(configError); });
	const workflow = new FeedTrackerWorkflow(source);

	const result = await workflow.run({ id: 'job-3', params: {} }, makeCtx(plugin));

	assert.equal(result.status, 'failed');
	assert.equal(result.error, configError);
	assert.equal(result.serviceUnhealthy, undefined);
	assert.equal(result.retryAfterMs, undefined);
	assert.equal(result.outputPaths.length, 1);
});

// ── Blogs: the identical branch stays a plain job-level failure — explicitly out of scope ──

test('Blogs all-feeds-failed stays a plain job-level failure — no service to name', async () => {
	const app = makeApp(REGISTRY_PATH);
	const plugin = makePlugin(app);
	const source = makeSource('blogs', async () => { throw new Error('getaddrinfo ENOTFOUND example.com'); });
	const workflow = new FeedTrackerWorkflow(source);

	const result = await workflow.run({ id: 'job-2', params: {} }, makeCtx(plugin));

	assert.equal(result.status, 'failed');
	assert.equal(result.error, 'All 1 feeds failed to fetch.');
	assert.equal(result.serviceUnhealthy, undefined);
	assert.equal(result.retryAfterMs, undefined);
});
