import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), `crucible-source-eval-metrics-${process.pid}`);
const outfile = path.join(outdir, 'sourceEvalMetrics.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export * from './src/sourceEval/metrics';",
			"export * from './src/sourceEval/ratingQueue';",
		].join('\n'),
		resolveDir: process.cwd(),
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const {
	SOURCE_EVAL_SCORE_WEIGHTS,
	buildRatingQueue,
	computeSourceEvalRows,
} = await import(pathToFileURL(outfile).href);

const now = Date.parse('2026-07-03T00:00:00Z');
const day = 24 * 60 * 60 * 1000;
const defaultSettings = {
	readingBudgetWords: 7000,
	budgetPeriod: 'week',
	lookbackDays: 14,
	recencyHalfLifeDays: 7,
	now,
};

test('computeSourceEvalRows computes funnel, read, gold, observation and budget metrics', () => {
	const captures = [
		capture('daily/a.md', 'blog:acme', 1, {
			wordCount: 1000,
			read: true,
			tags: ['gold', '3-2-1'],
			label: { importance: 4, urgent: true, rated: '2026-07-03', tags: [] },
		}),
		capture('daily/b.md', 'blog:acme', 3, {
			wordCount: 3000,
			read: false,
			tags: ['goldmine'],
		}),
		capture('daily/c.md', 'youtube:UC1', 2, {
			wordCount: 2000,
			read: true,
			tags: ['transcript', 'refined', 'key'],
			isTranscript: true,
			isRefined: true,
			label: { importance: 2, urgent: false, rated: '2026-07-02', tags: ['reference'] },
		}),
		capture('daily/d.md', 'youtube:UC1', 4, {
			wordCount: 1000,
			tags: ['transcript'],
			isTranscript: true,
		}),
	];
	const rows = computeSourceEvalRows({
		captures,
		blogRows: [{
			blogKey: 'acme',
			name: 'Acme',
			link: 'https://acme.example',
			trackedPosts: 10,
			ingestedPosts: 3,
			ignoredPosts: 1,
			uncapturedPosts: 6,
			tracked: true,
		}],
		channelRows: [{
			channelId: 'UC1',
			name: 'Channel One',
			aboutFile: null,
			trackedVideos: 8,
			ingestedVideos: 2,
			ignoredVideos: 2,
			uncapturedVideos: 4,
			tracked: true,
		}],
		observations: new Map([
			['daily/a.md', { months: 2, quotes: 5 }],
			['daily/c.md', { months: 1, quotes: 1 }],
		]),
		settings: defaultSettings,
	});

	const blog = rows.find(row => row.source === 'blog:acme');
	assert.equal(blog.name, 'Acme');
	assert.equal(blog.type, 'blog');
	assert.equal(blog.tracked, true);
	assert.equal(blog.captures, 2);
	assert.equal(blog.ingestRate, 3 / 4);
	assert.equal(blog.uncaptured, 6);
	assert.equal(blog.readRate, 1 / 2);
	assert.equal(blog.refinedRate, null);
	assert.equal(blog.goldRate, 1 / 2);
	assert.equal(blog.goldmineCount, 1);
	assert.equal(blog.obsCount, 2);
	assert.equal(blog.obsQuotes, 5);
	assert.equal(blog.wordsPerWeek, 2000);
	assert.equal(blog.budgetShare, 2000 / 7000);
	assert.equal(blog.valueDensity, 7.5);
	assert.equal(blog.labeled, 1);
	assert.equal(blog.labeledPct, 1 / 2);

	const channel = rows.find(row => row.source === 'youtube:UC1');
	assert.equal(channel.readRate, 1 / 2);
	assert.equal(channel.refinedRate, 1 / 2);
	assert.equal(channel.ingestRate, 2 / 4);
	assert.equal(channel.obsCount, 1);
	assert.equal(channel.obsQuotes, 1);
	assert.equal(channel.wordsPerWeek, 1500);
	assert.equal(channel.labeledPct, 1 / 2);
});

test('score applies exponential recency decay and keeps gold stronger than goldmine', () => {
	const recentGold = computeSourceEvalRows({
		captures: [capture('daily/recent.md', 'blog:gold', 0, { tags: ['gold'] })],
		blogRows: [blogRow('gold')],
		channelRows: [],
		observations: new Map(),
		settings: defaultSettings,
	}).find(row => row.source === 'blog:gold');
	const oldGold = computeSourceEvalRows({
		captures: [capture('daily/old.md', 'blog:old', 7, { tags: ['gold'] })],
		blogRows: [blogRow('old')],
		channelRows: [],
		observations: new Map(),
		settings: defaultSettings,
	}).find(row => row.source === 'blog:old');
	const recentGoldmine = computeSourceEvalRows({
		captures: [capture('daily/mine.md', 'blog:mine', 0, { tags: ['goldmine'] })],
		blogRows: [blogRow('mine')],
		channelRows: [],
		observations: new Map(),
		settings: defaultSettings,
	}).find(row => row.source === 'blog:mine');

	assert.equal(SOURCE_EVAL_SCORE_WEIGHTS.gold, 3);
	assert.equal(SOURCE_EVAL_SCORE_WEIGHTS.goldmine, 1);
	assert.equal(recentGold.score, oldGold.score);
	assert.ok(recentGold.score > recentGoldmine.score);
	assert.equal(recentGold.goldRate, 1);
	assert.equal(recentGold.goldmineCount, 0);
	assert.equal(recentGoldmine.goldRate, 0);
	assert.equal(recentGoldmine.goldmineCount, 1);
});

test('mixed old and recent signals are lowered by recency decay', () => {
	const recentOnly = computeSourceEvalRows({
		captures: [capture('daily/recent.md', 'blog:recent', 0, { tags: ['gold'] })],
		blogRows: [blogRow('recent')],
		channelRows: [],
		observations: new Map(),
		settings: defaultSettings,
	}).find(row => row.source === 'blog:recent');
	const mixed = computeSourceEvalRows({
		captures: [
			capture('daily/recent.md', 'blog:mixed', 0, { tags: ['gold'] }),
			capture('daily/old.md', 'blog:mixed', 7, {}),
		],
		blogRows: [blogRow('mixed')],
		channelRows: [],
		observations: new Map(),
		settings: defaultSettings,
	}).find(row => row.source === 'blog:mixed');

	assert.ok(mixed.score < recentOnly.score);
	assert.ok(mixed.score > recentOnly.score / 2);
});

test('empty control rows preserve null division behavior and zero coverage counts', () => {
	const rows = computeSourceEvalRows({
		captures: [],
		blogRows: [{
			blogKey: 'empty',
			name: 'Empty',
			link: null,
			trackedPosts: 0,
			ingestedPosts: 0,
			ignoredPosts: 0,
			uncapturedPosts: 0,
			tracked: false,
		}],
		channelRows: [],
		observations: new Map(),
		settings: { ...defaultSettings, readingBudgetWords: 0 },
	});

	assert.equal(rows.length, 1);
	assert.equal(rows[0].captures, 0);
	assert.equal(rows[0].ingestRate, null);
	assert.equal(rows[0].readRate, null);
	assert.equal(rows[0].refinedRate, null);
	assert.equal(rows[0].goldRate, 0);
	assert.equal(rows[0].budgetShare, null);
	assert.equal(rows[0].valueDensity, null);
	assert.equal(rows[0].labeled, 0);
	assert.equal(rows[0].labeledPct, 0);
	assert.equal(rows[0].score, 0);
});

test('untracked capture-only sources get a row without control counts', () => {
	const rows = computeSourceEvalRows({
		captures: [capture('daily/a.md', 'blog:loose', 1, { wordCount: 700 })],
		blogRows: [],
		channelRows: [],
		observations: new Map(),
		settings: defaultSettings,
	});

	assert.equal(rows.length, 1);
	assert.equal(rows[0].source, 'blog:loose');
	assert.equal(rows[0].name, 'loose');
	assert.equal(rows[0].tracked, false);
	assert.equal(rows[0].ingestRate, null);
	assert.equal(rows[0].uncaptured, 0);
	assert.equal(rows[0].wordsPerWeek, 350);
});

test('buildRatingQueue filters scope, defaults to unlabeled only, and orders unlabeled newest first', () => {
	const newestLabeled = capture('daily/labeled.md', 'blog:acme', 0, {
		label: { importance: 5, urgent: false, rated: '2026-07-03', tags: [] },
	});
	const newestUnlabeled = capture('daily/new.md', 'blog:acme', 1);
	const olderUnlabeled = capture('daily/old.md', 'blog:acme', 4);
	const otherSource = capture('daily/other.md', 'youtube:UC1', 0);

	assert.deepEqual(
		buildRatingQueue([olderUnlabeled, newestLabeled, otherSource, newestUnlabeled], { scope: 'blog:acme' })
			.map(item => item.file.path),
		['daily/new.md', 'daily/old.md'],
	);
	assert.deepEqual(
		buildRatingQueue([olderUnlabeled, newestLabeled, otherSource, newestUnlabeled], {
			scope: 'blog:acme',
			unlabeledOnly: false,
		}).map(item => item.file.path),
		['daily/new.md', 'daily/old.md', 'daily/labeled.md'],
	);
	assert.deepEqual(
		buildRatingQueue([olderUnlabeled, newestLabeled, otherSource, newestUnlabeled], {
			scope: 'all',
			unlabeledOnly: false,
		}).map(item => item.file.path),
		['daily/other.md', 'daily/new.md', 'daily/old.md', 'daily/labeled.md'],
	);
});

test('buildRatingQueue filters broad recent scopes by source row metadata', () => {
	const trackedBlog = capture('daily/tracked-blog.md', 'blog:tracked', 0);
	const untrackedBlog = capture('daily/untracked-blog.md', 'blog:untracked', 1);
	const trackedYoutube = capture('daily/tracked-youtube.md', 'youtube:UC1', 2);
	const unattributed = capture('daily/unattributed.md', null, 3);
	const captures = [unattributed, trackedYoutube, untrackedBlog, trackedBlog];
	const sources = [
		sourceRow('blog:tracked', 'blog', true),
		sourceRow('blog:untracked', 'blog', false),
		sourceRow('youtube:UC1', 'youtube', true),
	];

	assert.deepEqual(
		buildRatingQueue(captures, { scope: 'tracked', sources }).map(item => item.file.path),
		['daily/tracked-blog.md', 'daily/tracked-youtube.md'],
	);
	assert.deepEqual(
		buildRatingQueue(captures, { scope: 'untracked', sources }).map(item => item.file.path),
		['daily/untracked-blog.md'],
	);
	assert.deepEqual(
		buildRatingQueue(captures, { scope: 'blogs', sources }).map(item => item.file.path),
		['daily/tracked-blog.md', 'daily/untracked-blog.md'],
	);
	assert.deepEqual(
		buildRatingQueue(captures, { scope: 'youtube', sources }).map(item => item.file.path),
		['daily/tracked-youtube.md'],
	);
	assert.deepEqual(
		buildRatingQueue(captures, { scope: 'all', sources }).map(item => item.file.path),
		['daily/tracked-blog.md', 'daily/untracked-blog.md', 'daily/tracked-youtube.md', 'daily/unattributed.md'],
	);
});

test('buildRatingQueue excludes persistent eval skips unless explicitly included', () => {
	const active = capture('daily/active.md', 'blog:acme', 0);
	const skipped = capture('daily/skipped.md', 'blog:acme', 1, { evalSkip: true });

	assert.deepEqual(
		buildRatingQueue([skipped, active], { scope: 'blog:acme' }).map(item => item.file.path),
		['daily/active.md'],
	);
	assert.deepEqual(
		buildRatingQueue([skipped, active], { scope: 'blog:acme', includeSkipped: true }).map(item => item.file.path),
		['daily/active.md', 'daily/skipped.md'],
	);
});

function blogRow(key) {
	return {
		blogKey: key,
		name: key,
		link: null,
		trackedPosts: 1,
		ingestedPosts: 0,
		ignoredPosts: 0,
		uncapturedPosts: 1,
		tracked: true,
	};
}

function sourceRow(source, type, tracked) {
	return { source, type, tracked };
}

function capture(path, source, ageDays, overrides = {}) {
	const tags = overrides.tags ?? [];
	return {
		file: { path },
		source,
		wordCount: overrides.wordCount ?? null,
		read: overrides.read ?? false,
		tags,
		created: now - ageDays * day,
		published: null,
		isTranscript: overrides.isTranscript ?? tags.includes('transcript'),
		isRefined: overrides.isRefined ?? tags.includes('refined'),
		label: overrides.label ?? null,
		evalSkip: overrides.evalSkip ?? false,
	};
}
