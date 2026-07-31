// WP-VF-3: the shared "YouTube Data API key missing" affordance
// (src/ingestion/render/apiKeyAffordance.ts) and the removal of the
// DbJobBackend no-api-key auto-source latch it replaces.
//
// Follows the searchRerankAffordance.test.mjs style: pure-function cases for
// the detector/renderer, bundled via esbuild against a minimal obsidian stub
// (apiKeyAffordance.ts transitively pulls in orchestration/utils/youtubeApi.ts
// for YOUTUBE_DATA_API_SECRET_KEY, same as the existing
// youtubeWorkflowServiceHealth.test.mjs stub), plus STRUCTURAL source-text
// pins for the parts that aren't reachable as pure functions (the latch's
// absence from DbJobBackend, and the Configure… deep links at each render
// site).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-apikey-affordance-tests');
const outfile = path.join(outdir, 'apiKeyAffordance.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { youtubeApiKeyMissing, isYoutubeApiKeyRegistered, renderApiKeyAffordance, YOUTUBE_API_KEY_MISSING_HINT } from './src/ingestion/render/apiKeyAffordance';",
			"export { YOUTUBE_DATA_API_SECRET_KEY } from './src/orchestration/utils/youtubeApi';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'apikey-affordance-test-entry.ts',
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
					'export class TFile {}',
					'export class TFolder {}',
					'export function normalizePath(p) { return p; }',
					'export async function requestUrl() { throw new Error("not used"); }',
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

const {
	youtubeApiKeyMissing,
	isYoutubeApiKeyRegistered,
	renderApiKeyAffordance,
	YOUTUBE_API_KEY_MISSING_HINT,
	YOUTUBE_DATA_API_SECRET_KEY,
} = await import(pathToFileURL(outfile).href);

/* ------------------------------------------------------------------------- pure detector */

test('youtubeApiKeyMissing: a registered key is not missing', () => {
	assert.equal(youtubeApiKeyMissing(true), false);
});

test('youtubeApiKeyMissing: an unregistered key is missing', () => {
	assert.equal(youtubeApiKeyMissing(false), true);
});

test('isYoutubeApiKeyRegistered: delegates to plugin.secretRegistry.isRegistered with the YT key', () => {
	const calls = [];
	const plugin = { secretRegistry: { isRegistered: (key) => { calls.push(key); return true; } } };
	assert.equal(isYoutubeApiKeyRegistered(plugin), true);
	assert.deepEqual(calls, [YOUTUBE_DATA_API_SECRET_KEY]);
});

test('isYoutubeApiKeyRegistered: false when the registry says the key is absent', () => {
	const plugin = { secretRegistry: { isRegistered: () => false } };
	assert.equal(isYoutubeApiKeyRegistered(plugin), false);
});

/* ------------------------------------------------------------------------- renderer */

// A minimal fake element supporting only what renderApiKeyAffordance touches
// (createSpan/createEl) — no real DOM under plain Node, same rationale as
// ingestionRefreshGates.test.mjs's FakeElement, scoped down to this module's
// narrow surface.
function makeFakeContainer() {
	const children = [];
	return {
		children,
		createSpan(opts = {}) {
			const el = { tag: 'span', cls: opts.cls, text: opts.text };
			children.push(el);
			return el;
		},
		createEl(tag, opts = {}) {
			const el = { tag, cls: opts.cls, text: opts.text, disabled: false, onclick: null };
			children.push(el);
			return el;
		},
	};
}

test('renderApiKeyAffordance: appends a muted hint span and a separate Configure… button', () => {
	const container = makeFakeContainer();
	let configured = 0;
	renderApiKeyAffordance(container, () => { configured++; });

	assert.equal(container.children.length, 2, 'hint span + Configure button, nothing else');
	const [hint, button] = container.children;
	assert.equal(hint.tag, 'span');
	assert.equal(hint.cls, 'crucible-apikey-hint');
	assert.equal(hint.text, YOUTUBE_API_KEY_MISSING_HINT);
	assert.equal(button.tag, 'button');
	assert.equal(button.cls, 'crucible-apikey-configure');
	assert.equal(button.text, 'Configure…');

	// A disabled action button swallows clicks — the click affordance must live
	// on this separate button, not be folded into the (elsewhere-)disabled one.
	assert.equal(configured, 0);
	button.onclick();
	assert.equal(configured, 1);
});

test('renderApiKeyAffordance: accepts an overridden hint without touching the default export', () => {
	const container = makeFakeContainer();
	renderApiKeyAffordance(container, () => {}, 'custom copy');
	assert.equal(container.children[0].text, 'custom copy');
});

/* ------------------------------------------------------------------------- structural */

const dbJobBackendSrc = readFileSync('src/orchestration/DbJobBackend.ts', 'utf8');
const orchestratorSrc = readFileSync('src/orchestration/Orchestrator.ts', 'utf8');
const controlCentersSrc = readFileSync('src/ingestion/sections/controlCenters.ts', 'utf8');
const uncapturedVideosSrc = readFileSync('src/ingestion/sections/uncapturedVideos.ts', 'utf8');
const orchestrationIngestionSrc = readFileSync('src/settings/sections/orchestrationIngestion.ts', 'utf8');

test('STRUCTURAL: the no-api-key auto-source latch is gone from DbJobBackend.failEntry', () => {
	const start = dbJobBackendSrc.indexOf('private failEntry(');
	assert.ok(start >= 0, 'failEntry not found');
	const end = dbJobBackendSrc.indexOf('\tprivate isWorkflowEnabled(', start);
	assert.ok(end > start, 'failEntry end boundary not found');
	const body = dbJobBackendSrc.slice(start, end);
	assert.ok(
		!/disableAutoSource\(/.test(body),
		'failEntry must not call disableAutoSource anymore — the latch is removed (WP-VF-3)',
	);
	assert.ok(!/failureReason === 'no-api-key'/.test(body), 'the typed-reason branch that drove the latch must be gone');
});

test('STRUCTURAL: Orchestrator.disableAutoSource itself is kept (no other caller removed it)', () => {
	assert.match(orchestratorSrc, /disableAutoSource\(type: JobType\): void \{/, 'disableAutoSource must still be defined');
});

test('STRUCTURAL: channel control center Configure… deep-links the orchestrator settings tab', () => {
	assert.ok(controlCentersSrc.includes("import { isYoutubeApiKeyRegistered, renderApiKeyAffordance, youtubeApiKeyMissing } from '../render/apiKeyAffordance';"),
		'controlCenters.ts must import the shared affordance module');
	assert.match(controlCentersSrc, /openSettingsToTab\(\s*['"]orchestrator['"]\s*\)/, "must deep-link to the 'orchestrator' tab");
});

test('STRUCTURAL: uncaptured videos Configure… deep-links the orchestrator settings tab and skips the mount-time re-assert when the key is missing', () => {
	assert.match(uncapturedVideosSrc, /openSettingsToTab\(\s*['"]orchestrator['"]\s*\)/, "must deep-link to the 'orchestrator' tab");
	assert.match(
		uncapturedVideosSrc,
		/ingestionYoutubeAutoEnqueueEnabled === true && isYoutubeApiKeyRegistered\(host\.plugin\)/,
		'the mount-time auto-source re-assert must also require the key to be present',
	);
});

test('STRUCTURAL: the auto-enqueue settings toggle warns and deep-links when the key is missing, but the toggle itself stays enabled', () => {
	assert.match(orchestrationIngestionSrc, /openToTab\(\s*['"]orchestrator['"]\s*\)/, "must deep-link to the 'orchestrator' tab");
	assert.ok(orchestrationIngestionSrc.includes('addWarningIcon(autoEnqueueSetting.nameEl'), 'must use the existing addWarningIcon convention');
	// The toggle's own enabled-ness must not be gated on the key — it's a
	// preference, not the key (per the brief). bindToggle's `get`/`set` read
	// straight off `ingestionYoutubeAutoEnqueueEnabled` with no key check.
	const toggleStart = orchestrationIngestionSrc.indexOf("name: 'Auto-enqueue YouTube metadata'");
	const toggleEnd = orchestrationIngestionSrc.indexOf('}, save);', toggleStart);
	const toggleBlock = orchestrationIngestionSrc.slice(toggleStart, toggleEnd);
	assert.ok(!/isYoutubeApiKeyRegistered/.test(toggleBlock), 'the toggle spec itself must not gate on key presence');
});
