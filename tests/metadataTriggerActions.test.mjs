import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-metadata-trigger-tests');
const triggerOutfile = path.join(outdir, 'triggerAdapter.mjs');
const actionsOutfile = path.join(outdir, 'youtubeActions.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/triggers/triggerAdapter.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile: triggerOutfile,
	logLevel: 'silent',
});

await esbuild.build({
	entryPoints: ['src/orchestration/utils/youtubeActions.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile: actionsOutfile,
	logLevel: 'silent',
});

const { triggerDefToOrchestrationTrigger } = await import(pathToFileURL(triggerOutfile).href);
const {
	youtubeVideoIdFromArgsOrFrontmatter,
	youtubeVideoIdFromFrontmatter,
	youtubeWatchUrlFromArgsOrFrontmatter,
	youtubeWatchUrlFromFrontmatter,
} = await import(pathToFileURL(actionsOutfile).href);

function pluginWithFrontmatter(frontmatter) {
	return {
		app: {
			metadataCache: {
				getFileCache: () => ({ frontmatter, tags: [] }),
			},
		},
	};
}

test('metadata-enriched command trigger enqueues command_run for the metadata note', () => {
	const def = {
		id: 't1',
		name: 'Ignore channel shorts',
		enabled: true,
		on: { event: 'youtube-metadata-enriched' },
		scope: { folder: '_yt_metadata', includeSubfolders: true },
		conditions: [
			{ type: 'property-equals', property: 'channelId', value: 'CHANNEL_A' },
			{ type: 'property-lt', property: 'duration_seconds', value: '120' },
		],
		conditionMode: 'all',
		action: {
			kind: 'command',
			commandId: 'obsidian-crucible:youtube-ignore-video',
			args: { videoId: '' },
		},
	};
	const file = { path: '_yt_metadata/channel/video.md', parent: { path: '_yt_metadata/channel' } };
	const trigger = triggerDefToOrchestrationTrigger(def, pluginWithFrontmatter({
		channelId: 'CHANNEL_A',
		duration_seconds: 119,
		videoId: 'VIDEO123',
	}));

	assert.deepEqual(trigger.on, { event: 'youtube-metadata-enriched' });
	assert.equal(trigger.guard(file), true);
	assert.deepEqual(trigger.jobs(file), [{
		type: 'command_run',
		params: {
			commandId: 'obsidian-crucible:youtube-ignore-video',
			args: { videoId: '' },
			targetPath: '_yt_metadata/channel/video.md',
		},
	}]);
});

test('metadata-enriched trigger guard rejects nonmatching metadata frontmatter', () => {
	const def = {
		id: 't2',
		name: 'Watch channel shorts',
		enabled: true,
		on: { event: 'youtube-metadata-enriched' },
		conditions: [
			{ type: 'property-equals', property: 'channelId', value: 'CHANNEL_B' },
			{ type: 'property-lt', property: 'duration_seconds', value: '1200' },
		],
		conditionMode: 'all',
		action: {
			kind: 'command',
			commandId: 'obsidian-crucible:youtube-watch-video',
			args: {},
		},
	};
	const file = { path: '_yt_metadata/channel/video.md', parent: { path: '_yt_metadata/channel' } };
	const trigger = triggerDefToOrchestrationTrigger(def, pluginWithFrontmatter({
		channelId: 'CHANNEL_A',
		duration_seconds: 1300,
		videoId: 'VIDEO123',
	}));

	assert.equal(trigger.guard(file), false);
});

test('youtube action helpers derive video id and watch URL from args or metadata frontmatter', () => {
	const fm = {
		videoId: 'VIDEO123',
		url: 'https://www.youtube.com/watch?v=VIDEO123',
	};
	assert.equal(youtubeVideoIdFromFrontmatter(fm), 'VIDEO123');
	assert.equal(youtubeVideoIdFromArgsOrFrontmatter({ videoId: 'OVERRIDE' }, fm), 'OVERRIDE');
	assert.equal(youtubeWatchUrlFromFrontmatter(fm), 'https://www.youtube.com/watch?v=VIDEO123');
	assert.equal(youtubeWatchUrlFromArgsOrFrontmatter({ url: 'https://youtu.be/OVERRIDE' }, fm), 'https://youtu.be/OVERRIDE');
});

test('youtube action helpers fall back to yt-video-id and synthesize watch URLs', () => {
	const fm = { 'yt-video-id': ['VIDEO456'] };
	assert.equal(youtubeVideoIdFromFrontmatter(fm), 'VIDEO456');
	assert.equal(youtubeWatchUrlFromFrontmatter(fm), 'https://www.youtube.com/watch?v=VIDEO456');
});
