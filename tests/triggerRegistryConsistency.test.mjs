import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-trigger-registry-tests');
const outfile = path.join(outdir, 'TriggerRegistry.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/orchestration/TriggerRegistry.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: `
export class TFile {
	constructor(path) {
		this.path = path;
		this.extension = path.split('.').pop();
		const slash = path.lastIndexOf('/');
		this.parent = { path: slash > 0 ? path.slice(0, slash) : '' };
	}
}
globalThis.__TriggerRegistryTestTFile = TFile;
`,
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { TriggerRegistry } = await import(pathToFileURL(outfile).href);
const TFile = globalThis.__TriggerRegistryTestTFile;

test('create waits for metadataCache.changed before evaluating trigger conditions', () => {
	withFakeWindow(() => {
		const harness = makeHarness();
		const file = harness.addFile('_yt_metadata/channel/video.md');
		const registry = makeStartedRegistry(harness, [triggerDef({
			events: ['create'],
			commandId: 'obsidian-crucible:youtube-ignore-video',
		})]);

		harness.emitVault('create', file);
		assert.equal(harness.enqueues.length, 0);

		harness.emitMetadataChanged(file, {
			channelId: 'CHANNEL_A',
			duration_seconds: 119,
			videoId: 'VIDEO123',
		});

		assert.deepEqual(harness.enqueues.map(e => e.params.targetPath), [file.path]);
		assert.deepEqual(harness.enqueues.map(e => e.params.commandId), ['obsidian-crucible:youtube-ignore-video']);
		registry.dispose();
	});
});

test('modify and metadata-changed use cache-ready snapshots but remain debounced', () => {
	withFakeWindow(timers => {
		const harness = makeHarness();
		const file = harness.addFile('_yt_metadata/channel/video.md');
		const registry = makeStartedRegistry(harness, [triggerDef({
			events: ['modify'],
			commandId: 'obsidian-crucible:youtube-ignore-video',
		})]);

		harness.emitVault('modify', file);
		harness.emitMetadataChanged(file, {
			channelId: 'CHANNEL_A',
			duration_seconds: 119,
			videoId: 'VIDEO123',
		});
		harness.emitVault('modify', file);
		harness.emitMetadataChanged(file, {
			channelId: 'CHANNEL_A',
			duration_seconds: 118,
			videoId: 'VIDEO123',
		});

		assert.equal(harness.enqueues.length, 0);
		assert.equal(timers.timerCount(), 2);

		timers.runTimers();

		assert.equal(harness.enqueues.length, 1);
		assert.equal(harness.enqueues[0].params.targetPath, file.path);
		registry.dispose();
	});
});

test('youtube metadata enriched waits for cache when metadata is not indexed yet', () => {
	withFakeWindow(() => {
		const harness = makeHarness();
		const file = harness.addFile('_yt_metadata/channel/video.md');
		const registry = makeStartedRegistry(harness, [triggerDef({
			events: ['youtube-metadata-enriched'],
			commandId: 'obsidian-crucible:youtube-ignore-video',
		})]);

		harness.emitIngestion('metadata-enriched', { videoId: 'VIDEO123', metadataFile: file });
		assert.equal(harness.enqueues.length, 0);

		harness.emitMetadataChanged(file, {
			channelId: 'CHANNEL_A',
			duration_seconds: 119,
			videoId: 'VIDEO123',
		});

		assert.equal(harness.enqueues.length, 1);
		assert.equal(harness.enqueues[0].params.targetPath, file.path);
		registry.dispose();
	});
});

test('rename remains immediate because metadataCache.changed is not emitted for renames', () => {
	withFakeWindow(() => {
		const harness = makeHarness();
		const file = harness.addFile('_yt_metadata/channel/video.md', {
			channelId: 'CHANNEL_A',
			duration_seconds: 119,
			videoId: 'VIDEO123',
		});
		const registry = makeStartedRegistry(harness, [triggerDef({
			events: ['rename'],
			commandId: 'obsidian-crucible:youtube-ignore-video',
		})]);

		harness.emitVault('rename', file);

		assert.equal(harness.enqueues.length, 1);
		assert.equal(harness.enqueues[0].params.targetPath, file.path);
		registry.dispose();
	});
});

function makeStartedRegistry(harness, triggers) {
	const registry = new TriggerRegistry(harness.plugin, () => false);
	registry.setUserTriggers(triggers);
	registry.start();
	return registry;
}

function triggerDef({ events, commandId }) {
	return {
		id: `t-${events.join('-')}`,
		name: `Trigger ${events.join(',')}`,
		enabled: true,
		on: { events },
		scope: { folder: '_yt_metadata', includeSubfolders: true },
		conditions: [
			{
				type: 'property-in-set',
				property: 'channelId',
				values: ['CHANNEL_A'],
				valueKind: 'youtube-channel',
			},
			{ type: 'property-lt', property: 'duration_seconds', value: '120' },
		],
		conditionMode: 'all',
		action: {
			kind: 'command',
			commandId,
			args: {},
		},
	};
}

function makeHarness() {
	const files = new Map();
	const caches = new Map();
	const enqueues = [];
	const vaultHandlers = new Map();
	const metadataHandlers = new Map();
	const ingestionHandlers = new Map();
	const plugin = {
		settings: { orchestrationTriggersEnabled: {} },
		app: {
			vault: {
				on: (event, callback) => {
					vaultHandlers.set(event, callback);
					return { event, callback };
				},
				getAbstractFileByPath: filePath => files.get(filePath) ?? null,
			},
			metadataCache: {
				on: (event, callback) => {
					metadataHandlers.set(event, callback);
					return { event, callback };
				},
				getFileCache: file => caches.get(file.path) ?? null,
			},
		},
		ingestionEvents: {
			on: (event, callback) => {
				ingestionHandlers.set(event, callback);
				return () => ingestionHandlers.delete(event);
			},
		},
		noteLocks: { isLocked: () => false },
		orchestrator: {
			enqueue: (type, params, options) => {
				enqueues.push({ type, params, options });
				return Promise.resolve(null);
			},
		},
		registerEvent: () => {},
		register: () => {},
		registerInterval: () => {},
	};
	return {
		plugin,
		enqueues,
		addFile(filePath, frontmatter) {
			const file = new TFile(filePath);
			files.set(filePath, file);
			if (frontmatter) caches.set(filePath, { frontmatter, tags: [] });
			return file;
		},
		emitVault(event, file) {
			vaultHandlers.get(event)?.(file);
		},
		emitMetadataChanged(file, frontmatter) {
			const cache = { frontmatter, tags: [] };
			caches.set(file.path, cache);
			metadataHandlers.get('changed')?.(file, '', cache);
		},
		emitIngestion(event, payload) {
			ingestionHandlers.get(event)?.(payload);
		},
	};
}

function withFakeWindow(fn) {
	const originalWindow = globalThis.window;
	let nextId = 1;
	const timers = new Map();
	globalThis.window = {
		setTimeout(callback) {
			const id = nextId++;
			timers.set(id, callback);
			return id;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
		setInterval() {
			return nextId++;
		},
		clearInterval() {},
	};
	try {
		fn({
			runTimers() {
				const callbacks = Array.from(timers.values());
				timers.clear();
				callbacks.forEach(callback => callback());
			},
			timerCount() {
				return timers.size;
			},
		});
	} finally {
		globalThis.window = originalWindow;
	}
}
