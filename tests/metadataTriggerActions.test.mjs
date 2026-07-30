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

test('multi-event command trigger adapts to an event list and preserves jobs', () => {
	const def = {
		id: 't-multi',
		name: 'Run on create or modify',
		enabled: true,
		on: { events: ['create', 'modify'] },
		scope: { folder: 'Clippings', includeSubfolders: true },
		conditions: [],
		action: {
			kind: 'command',
			commandId: 'obsidian-crucible:lint-note',
			args: { mode: 'all' },
		},
	};
	const file = { path: 'Clippings/video.md', parent: { path: 'Clippings' } };
	const trigger = triggerDefToOrchestrationTrigger(def, pluginWithFrontmatter({}));

	assert.deepEqual(trigger.on, { events: ['create', 'modify'] });
	assert.equal(trigger.guard(file), true);
	assert.deepEqual(trigger.jobs(file), [{
		type: 'command_run',
		params: {
			commandId: 'obsidian-crucible:lint-note',
			args: { mode: 'all' },
			targetPath: 'Clippings/video.md',
		},
	}]);
});

test('multi-event trigger with an explicitly empty event list adapts to no events', () => {
	const def = {
		id: 't-empty-events',
		name: 'Empty events',
		enabled: true,
		on: { events: [] },
		conditions: [],
		action: { kind: 'chain', chainName: 'Capture' },
	};
	const trigger = triggerDefToOrchestrationTrigger(def, pluginWithFrontmatter({}));

	// Deliberately no fallback to ['create'] — an explicitly emptied event list
	// goes inert instead of silently re-arming on the broadest event.
	assert.deepEqual(trigger.on, { events: [] });
});

test('a single on.event (no events array) keeps working unchanged', () => {
	const def = {
		id: 't-single-event',
		name: 'Single event',
		enabled: true,
		on: { event: 'create' },
		conditions: [],
		action: { kind: 'chain', chainName: 'Capture' },
	};
	const trigger = triggerDefToOrchestrationTrigger(def, pluginWithFrontmatter({}));

	assert.deepEqual(trigger.on, { event: 'create' });
});

test('chain-kind trigger seeds chain_run with chainName and targetPath', () => {
	const def = {
		id: 't-chain',
		name: 'Run capture chain',
		enabled: true,
		on: { event: 'create' },
		conditions: [],
		action: { kind: 'chain', chainName: 'Capture' },
	};
	const file = { path: 'Clippings/note.md', parent: { path: 'Clippings' } };
	const trigger = triggerDefToOrchestrationTrigger(def, pluginWithFrontmatter({}));

	assert.equal(trigger.guard(file), true);
	assert.deepEqual(trigger.jobs(file), [{
		type: 'chain_run',
		params: { chainName: 'Capture', targetPath: 'Clippings/note.md' },
	}]);
});

test('chain-kind trigger with an empty/whitespace chainName seeds no job', () => {
	const blankDef = {
		id: 't-chain-empty',
		name: 'Blank chain',
		enabled: true,
		on: { event: 'create' },
		conditions: [],
		action: { kind: 'chain', chainName: '' },
	};
	const whitespaceDef = {
		id: 't-chain-whitespace',
		name: 'Whitespace chain',
		enabled: true,
		on: { event: 'create' },
		conditions: [],
		action: { kind: 'chain', chainName: '   ' },
	};
	const file = { path: 'note.md', parent: { path: '' } };
	const blankTrigger = triggerDefToOrchestrationTrigger(blankDef, pluginWithFrontmatter({}));
	const whitespaceTrigger = triggerDefToOrchestrationTrigger(whitespaceDef, pluginWithFrontmatter({}));

	assert.deepEqual(blankTrigger.jobs(file), []);
	assert.deepEqual(whitespaceTrigger.jobs(file), []);
});

test('command-kind trigger with an empty/whitespace commandId seeds no job', () => {
	const blankDef = {
		id: 't-command-empty',
		name: 'Blank command',
		enabled: true,
		on: { event: 'create' },
		conditions: [],
		action: { kind: 'command', commandId: '', args: {} },
	};
	const whitespaceDef = {
		id: 't-command-whitespace',
		name: 'Whitespace command',
		enabled: true,
		on: { event: 'create' },
		conditions: [],
		action: { kind: 'command', commandId: '   ', args: {} },
	};
	const file = { path: 'note.md', parent: { path: '' } };
	const blankTrigger = triggerDefToOrchestrationTrigger(blankDef, pluginWithFrontmatter({}));
	const whitespaceTrigger = triggerDefToOrchestrationTrigger(whitespaceDef, pluginWithFrontmatter({}));

	assert.deepEqual(blankTrigger.jobs(file), []);
	assert.deepEqual(whitespaceTrigger.jobs(file), []);
});

test('trigger guard accepts channelId in a configured property set', () => {
	const def = {
		id: 't-channel-set',
		name: 'Ignore selected channel shorts',
		enabled: true,
		on: { events: ['youtube-metadata-enriched'] },
		conditions: [
			{
				type: 'property-in-set',
				property: 'channelId',
				values: ['CHANNEL_A', 'CHANNEL_B'],
				valueKind: 'youtube-channel',
			},
			{ type: 'property-lt', property: 'duration_seconds', value: '120' },
		],
		conditionMode: 'all',
		action: {
			kind: 'command',
			commandId: 'obsidian-crucible:youtube-ignore-video',
			args: {},
		},
	};
	const file = { path: '_yt_metadata/channel/video.md', parent: { path: '_yt_metadata/channel' } };
	const trigger = triggerDefToOrchestrationTrigger(def, pluginWithFrontmatter({
		channelId: 'CHANNEL_B',
		duration_seconds: 119,
		videoId: 'VIDEO123',
	}));

	assert.equal(trigger.guard(file), true);
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
