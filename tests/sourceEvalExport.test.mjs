import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), `crucible-source-eval-export-${process.pid}`);
const outfile = path.join(outdir, 'sourceEvalExport.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const obsidianStub = {
	name: 'obsidian-test-stub',
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
			contents: [
				'export class TFile { constructor(path) { this.path = path; this.extension = path.split(".").pop() || ""; this.basename = path.split("/").pop().replace(/\\.[^.]+$/, ""); this.stat = { ctime: 0, mtime: 0 }; } }',
				'export class TFolder { constructor(path, children = []) { this.path = path; this.children = children; } }',
				'globalThis.__CrucibleTestTFile = TFile;',
				'export function normalizePath(p) { return String(p ?? "").replace(/\\\\/g, "/").replace(/\\/+/g, "/"); }',
				'export function getAllTags(cache) { return cache?.tags ?? []; }',
				'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
				'export function htmlToMarkdown(s) { return String(s ?? ""); }',
				'export function parseYaml() { return {}; }',
				'export const Platform = { isMobile: false, isDesktop: true, isMacOS: false };',
				'export const moment = () => ({ format: () => "" });',
			].join('\n'),
			loader: 'js',
		}));
	},
};

await esbuild.build({
	stdin: {
		contents: "export * from './src/sourceEval/export';",
		resolveDir: process.cwd(),
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [obsidianStub],
	outfile,
	logLevel: 'silent',
});

const {
	buildTrainingExamples,
	serializeTrainingExamples,
} = await import(pathToFileURL(outfile).href);
const TFile = globalThis.__CrucibleTestTFile;

test('human labeled rows export intake-time features and no post-hoc/body fields', () => {
	const examples = buildTrainingExamples({
		captures: [{
			capture: capture('daily/day/2026-07-03/Human.md', 'blog:https://acme.example/feed.xml', {
				wordCount: 1234,
				read: true,
				tags: ['clippings', 'gold'],
				label: { importance: 4, urgent: true, rated: '2026-07-03', tags: ['reference'] },
			}),
			frontmatter: {
				title: 'Useful post',
				description: 'Short feed summary',
				author: '[[People/Alice|Alice]]',
				published: '2026-06-30',
				'post-id': 'https://acme.example/p/useful',
				'word-count': 1234,
				read: true,
				body: 'leaky body text',
			},
		}],
		sourceInfo: new Map([['blog:https://acme.example/feed.xml', {
			name: 'Acme',
			tags: ['research', '#substack'],
			priority: 'high',
		}]]),
	});

	assert.equal(examples.length, 1);
	assert.deepEqual(examples[0], {
		id: 'https://acme.example/p/useful',
		source_type: 'blog',
		source_key: 'https://acme.example/feed.xml',
		source_name: 'Acme',
		source_tags: ['#research', '#substack'],
		source_priority: 'high',
		title: 'Useful post',
		description: 'Short feed summary',
		author: 'Alice',
		published: '2026-06-30',
		word_count: 1234,
		duration_seconds: null,
		label: { importance: 4, urgent: true, tags: ['gold', 'reference'] },
		label_source: 'human',
		rated: '2026-07-03',
	});

	const serialized = serializeTrainingExamples(examples);
	const parsed = JSON.parse(serialized.trim());
	assert.equal(Object.hasOwn(parsed, 'body'), false);
	assert.equal(Object.hasOwn(parsed, 'read'), false);
	assert.equal(Object.hasOwn(parsed, 'observations'), false);
	assert.equal(Object.hasOwn(parsed, 'score'), false);
});

test('eval-skip is not treated as a human label', () => {
	const examples = buildTrainingExamples({
		captures: [{
			capture: capture('daily/skipped.md', 'blog:acme', {
				label: { importance: 5, urgent: false, rated: '2026-07-03', tags: [] },
				evalSkip: true,
			}),
			frontmatter: { 'post-id': 'https://acme.example/p/skipped' },
		}],
		sourceInfo: new Map([['blog:acme', { name: 'Acme', tags: [], priority: 'normal' }]]),
	});

	assert.equal(examples.length, 0);
});

test('weak labels carry goldmine as a label tag without making it important', () => {
	const sourceInfo = new Map([['blog:acme', { name: 'Acme', tags: [], priority: 'normal' }]]);
	const goldmineOnly = buildTrainingExamples({
		captures: [{
			capture: capture('daily/goldmine.md', 'blog:acme', { tags: ['goldmine'] }),
			frontmatter: { 'post-id': 'https://acme.example/p/goldmine' },
		}],
		sourceInfo,
		includeWeakLabels: true,
	});
	assert.equal(goldmineOnly.length, 0);

	const slopGoldmine = buildTrainingExamples({
		captures: [{
			capture: capture('daily/slop.md', 'blog:acme', { tags: ['probably-slop', 'goldmine'] }),
			frontmatter: { 'post-id': 'https://acme.example/p/slop' },
		}],
		sourceInfo,
		includeWeakLabels: true,
		now: Date.parse('2026-07-04T00:00:00Z'),
	});
	assert.equal(slopGoldmine.length, 1);
	assert.equal(slopGoldmine[0].label_source, 'weak');
	assert.equal(slopGoldmine[0].label.importance, 0);
	assert.deepEqual(slopGoldmine[0].label.tags, ['probably-slop', 'goldmine']);
});

test('human labels win over weak labels for the same intake id', () => {
	const examples = buildTrainingExamples({
		captures: [{
			capture: capture('daily/human.md', 'youtube:UC123', {
				tags: ['gold', 'probably-slop'],
				label: { importance: 5, urgent: false, rated: '2026-07-03', tags: [] },
			}),
			frontmatter: {
				'yt-video-id': 'abc123def45',
				title: 'Human rated video',
			},
			ytMetadataFrontmatter: {
				channelTitle: 'Channel',
				duration_seconds: 600,
				publishedAt: '2026-06-01T00:00:00Z',
			},
		}],
		sourceInfo: new Map([['youtube:UC123', { name: 'Channel', tags: ['video'], priority: 'low' }]]),
		ignoredItems: [{
			id: 'abc123def45',
			sourceType: 'youtube',
			sourceKey: 'UC123',
			sourceName: 'Channel',
			sourceTags: ['video'],
			sourcePriority: 'low',
			title: 'Ignored copy',
		}],
		includeWeakLabels: true,
	});

	assert.equal(examples.length, 1);
	assert.equal(examples[0].label_source, 'human');
	assert.equal(examples[0].label.importance, 5);
	assert.equal(examples[0].title, 'Human rated video');
	assert.equal(examples[0].duration_seconds, 600);
});

function capture(path, source, overrides = {}) {
	return {
		file: new TFile(path),
		source,
		wordCount: overrides.wordCount ?? null,
		read: overrides.read ?? false,
		tags: overrides.tags ?? [],
		created: overrides.created ?? 0,
		published: overrides.published ?? null,
		isTranscript: false,
		isRefined: false,
		label: overrides.label ?? null,
		evalSkip: overrides.evalSkip ?? false,
	};
}
