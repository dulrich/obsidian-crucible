// Covers WP-DP1: intake action language v2 (posts, videos, ignored) — the uniform
// icon-only action-cell pattern (src/ingestion/render/cells.ts) and its adoption in
// uncapturedPosts.ts / uncapturedVideos.ts / ignored.ts. Supersedes the WP-IC1-era
// pins this file used to carry (renderExternalLink-as-anchor, renderIconLabelButton,
// eye-off Ignore/eye Un-ignore) — see git history for that shape.
//
// Behavioral cases bundle cells.ts against a minimal obsidian stub (same shape as
// apiKeyAffordance.test.mjs / youtubeWorkflowServiceHealth.test.mjs — App/TFile/
// TFolder/normalizePath/requestUrl/Platform/moment, here plus Notice and a recording
// setIcon) and drive the renderers with a fake DOM element supporting only the
// surface they touch (createEl/createSpan/setAttr/addClass/disabled), same rationale
// as ingestionRefreshGates.test.mjs's FakeElement. renderSkipButton/renderIgnoreButton
// (the ignored-set writers) are only exercised up to the point of building the button
// — clicking them would need a real host/vault write, out of scope here (that's
// ignoredIds.ts's own concern). renderClipButton/renderEnrichButton take their actual
// vault/queue work as a caller-supplied `run`/`beforeRun` callback specifically so
// their full click lifecycle (disable-on-click, blocked/muted pre-click state, success
// refresh dispatch, failure re-enable, thrown-error recovery) IS testable here without
// any vault — see cells.ts's doc comment on renderClipButton for why that split exists
// (a blogsApi.ts dependency broke unrelated test harnesses that bundle cells.ts via a
// narrower obsidian stub, e.g. queueMonitorJobDetail.test.mjs).
//
// STRUCTURAL source-text pins cover what isn't reachable as a pure function: each
// section declaring exactly one action column in the WP-DP1 slot order, and the new
// CSS classes existing.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-ingestion-intake-action-cell-tests');
const outfile = path.join(outdir, 'cells.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/ingestion/render/cells.ts'],
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
					'export class Notice { constructor() {} }',
					'export function normalizePath(p) { return p; }',
					'export async function requestUrl() { throw new Error("not used"); }',
					'export const Platform = {};',
					'export const moment = () => {};',
					// Recording stub: sets an `iconName` property on the element it was
					// called with, so tests can assert which lucide glyph was requested
					// without needing a real SVG-rendering DOM.
					'export function setIcon(el, name) { if (el) el.iconName = name; }',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const {
	renderExternalIconButton,
	renderMetaIconButton,
	renderIconButton,
	renderClipButton,
	renderEnrichButton,
	renderSkipButton,
	renderIgnoreButton,
} = await import(pathToFileURL(outfile).href);

/* ------------------------------------------------------------------------- fake DOM */

// A minimal fake element supporting only what cells.ts's renderers touch:
// createEl/createSpan (with `text`/`cls`/`href`/`type` opts), setAttr, addClass,
// addEventListener, `disabled`, and the `iconName` property the stub setIcon writes.
function makeFakeEl(tag) {
	const el = {
		tag,
		cls: [],
		attrs: {},
		text: '',
		children: [],
		disabled: false,
		iconName: null,
		listeners: {},
		addClass(c) { this.cls.push(c); },
		setAttr(k, v) { this.attrs[k] = v; },
		addEventListener(evt, fn) { this.listeners[evt] = fn; },
		createEl(childTag, opts = {}) {
			const child = makeFakeEl(childTag);
			if (opts.text != null) child.text = opts.text;
			if (opts.cls) child.cls.push(...(Array.isArray(opts.cls) ? opts.cls : [opts.cls]));
			if (opts.href != null) child.attrs.href = opts.href;
			if (opts.type != null) child.attrs.type = opts.type;
			this.children.push(child);
			return child;
		},
		createSpan(opts = {}) {
			return this.createEl('span', opts);
		},
	};
	return el;
}

// window.open is called directly by renderExternalIconButton's click handler — Node
// has no global `window`, so stub just enough to record calls.
function withStubbedWindowOpen(fn) {
	const calls = [];
	const prior = globalThis.window;
	globalThis.window = { open: (...args) => { calls.push(args); } };
	try {
		fn(calls);
	} finally {
		if (prior === undefined) delete globalThis.window;
		else globalThis.window = prior;
	}
}

function makeHost(overrides = {}) {
	return {
		app: { workspace: { openLinkText: () => {} } },
		plugin: {},
		refresh: () => Promise.resolve(),
		...overrides,
	};
}

const noopCtx = { refresh: () => {}, sort: null };

/* ------------------------------------------------------------------------- renderIconButton */

test('renderIconButton: active — icon, aria-label, title, click wires the handler with the button itself', () => {
	const td = makeFakeEl('td');
	let received = null;
	const btn = renderIconButton(td, 'download', { ariaLabel: 'Clip', title: 'Clip', onClick: b => { received = b; } });
	assert.equal(td.children.length, 1);
	assert.equal(btn.tag, 'button');
	assert.equal(btn.iconName, 'download');
	assert.equal(btn.attrs['aria-label'], 'Clip');
	assert.equal(btn.attrs.title, 'Clip');
	assert.equal(btn.disabled, false);
	assert.ok(!btn.cls.includes('is-muted'));
	btn.listeners.click();
	assert.equal(received, btn, 'onClick receives the button itself');
});

test('renderIconButton: disabled — is-muted class, disabled=true, no click listener wired even if onClick is passed', () => {
	const td = makeFakeEl('td');
	let called = false;
	const btn = renderIconButton(td, 'download', { ariaLabel: 'Clip', title: 'blocked', disabled: true, onClick: () => { called = true; } });
	assert.equal(btn.disabled, true);
	assert.ok(btn.cls.includes('is-muted'));
	assert.equal(btn.attrs.title, 'blocked');
	assert.equal(btn.listeners.click, undefined, 'a disabled button never wires a click handler');
	assert.equal(called, false);
});

test('renderIconButton: an optional `cls` is appended alongside the base class', () => {
	const td = makeFakeEl('td');
	const btn = renderIconButton(td, 'circle-x', { ariaLabel: 'Skip', title: 'Skip', cls: 'crucible-intake-warn-btn' });
	assert.ok(btn.cls.includes('crucible-intake-icon-btn'));
	assert.ok(btn.cls.includes('crucible-intake-warn-btn'));
});

/* ------------------------------------------------------------------------- renderExternalIconButton (slot 1) */

test('renderExternalIconButton: url present — icon-only, title carries the destination, click opens it', () => {
	withStubbedWindowOpen(calls => {
		const td = makeFakeEl('td');
		renderExternalIconButton(td, 'https://example.com/post', 'Read');
		const el = td.children[0];
		assert.equal(el.iconName, 'external-link');
		assert.equal(el.attrs['aria-label'], 'Read');
		assert.equal(el.attrs.title, 'https://example.com/post', 'title carries the URL, not the aria-label text');
		assert.equal(el.text, '', 'icon-only: no visible text label');
		el.listeners.click();
		assert.deepEqual(calls, [['https://example.com/post', '_blank', 'noopener']]);
	});
});

test('renderExternalIconButton: url null — muted, never absent (rule 1)', () => {
	const td = makeFakeEl('td');
	renderExternalIconButton(td, null, 'Read');
	const el = td.children[0];
	assert.equal(el.disabled, true);
	assert.ok(el.cls.includes('is-muted'));
	assert.equal(el.attrs.title, 'No URL available');
});

/* ------------------------------------------------------------------------- renderMetaIconButton (slot 2) */

test('renderMetaIconButton: file present — icon-only, in-tool nav on click', () => {
	let opened = null;
	const app = { workspace: { openLinkText: (path) => { opened = path; } } };
	const td = makeFakeEl('td');
	renderMetaIconButton(td, app, { path: 'notes/meta.md' }, 'unused');
	const el = td.children[0];
	assert.equal(el.iconName, 'file-text');
	assert.equal(el.attrs['aria-label'], 'Metadata');
	assert.equal(el.attrs.title, 'Metadata');
	el.listeners.click();
	assert.equal(opened, 'notes/meta.md');
});

test('renderMetaIconButton: file null — muted with the caller-supplied title', () => {
	const td = makeFakeEl('td');
	renderMetaIconButton(td, {}, null, 'No blog metadata note');
	const el = td.children[0];
	assert.equal(el.disabled, true);
	assert.equal(el.attrs.title, 'No blog metadata note');
});

/* ------------------------------------------------------------------------- renderClipButton (slot 3, posts) */

test('renderClipButton: blockedTitle set — muted download icon, run() never wired', () => {
	const td = makeFakeEl('td');
	let called = false;
	renderClipButton(td, makeHost(), 'No post body captured', noopCtx, async () => { called = true; return true; });
	const el = td.children[0];
	assert.equal(el.iconName, 'download');
	assert.equal(el.attrs['aria-label'], 'Clip');
	assert.equal(el.disabled, true);
	assert.equal(el.attrs.title, 'No post body captured');
	assert.equal(el.listeners.click, undefined);
	assert.equal(called, false);
});

test('renderClipButton: active click, run() succeeds, no beforeRun/own/companion — dispatches ctx.refresh() only', async () => {
	const td = makeFakeEl('td');
	let refreshed = 0;
	const ctx = { refresh: () => { refreshed++; }, sort: null };
	let hostRefreshed = false;
	const host = makeHost({ refresh: () => { hostRefreshed = true; return Promise.resolve(); } });
	renderClipButton(td, host, null, ctx, async () => true);
	const el = td.children[0];
	assert.equal(el.attrs.title, 'Clip');
	el.listeners.click();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(refreshed, 1);
	assert.equal(hostRefreshed, false, 'no companion section id was given, so the host-level refresh never fires');
});

test('renderClipButton: Ignored-section shape (opts.beforeRun + own/companion) — beforeRun runs before run(), success refreshes both', async () => {
	const td = makeFakeEl('td');
	const order = [];
	const ctx = { refresh: () => { order.push('ctx.refresh'); }, sort: null };
	let companionRefreshed = null;
	const host = makeHost({ refresh: id => { companionRefreshed = id; order.push('host.refresh:' + id); return Promise.resolve(); } });
	renderClipButton(td, host, null, ctx, async () => { order.push('run'); return true; }, {
		beforeRun: async () => { order.push('beforeRun'); },
		ownSectionId: 'ignoredPosts',
		companionSectionId: 'uncapturedPosts',
	});
	const el = td.children[0];
	el.listeners.click();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(order, ['beforeRun', 'run', 'ctx.refresh', 'host.refresh:uncapturedPosts']);
	assert.equal(companionRefreshed, 'uncapturedPosts');
});

test('renderClipButton: run() returns false — button re-enables, no refresh dispatched', async () => {
	const td = makeFakeEl('td');
	let refreshed = false;
	const ctx = { refresh: () => { refreshed = true; }, sort: null };
	renderClipButton(td, makeHost(), null, ctx, async () => false);
	const el = td.children[0];
	el.listeners.click();
	assert.equal(el.disabled, true, 'disabled for the duration of the click');
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(el.disabled, false, 're-enabled after a handled failure');
	assert.equal(refreshed, false);
});

test('renderClipButton: run() throws — caught, button re-enables, no refresh dispatched', async () => {
	const td = makeFakeEl('td');
	let refreshed = false;
	const ctx = { refresh: () => { refreshed = true; }, sort: null };
	renderClipButton(td, makeHost(), null, ctx, async () => { throw new Error('boom'); });
	const el = td.children[0];
	el.listeners.click();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(el.disabled, false);
	assert.equal(refreshed, false);
});

/* ------------------------------------------------------------------------- renderEnrichButton (slot 3, videos) */

test('renderEnrichButton: blockedTitle set — muted sparkles icon, enqueueAndRun never called', () => {
	const td = makeFakeEl('td');
	let called = false;
	const host = makeHost({ plugin: { orchestrationAutoRunner: { enqueueAndRun: () => { called = true; return Promise.resolve({}); } } } });
	renderEnrichButton(td, host, { videoId: 'v1', title: 't', channelName: 'c' }, 'Already enriched', noopCtx);
	const el = td.children[0];
	assert.equal(el.iconName, 'sparkles');
	assert.equal(el.attrs['aria-label'], 'Enrich');
	assert.equal(el.disabled, true);
	assert.equal(el.attrs.title, 'Already enriched');
	assert.equal(called, false);
});

test('renderEnrichButton: active click enqueues via orchestrationAutoRunner and dispatches refresh on success', async () => {
	const td = makeFakeEl('td');
	let enqueuedWith = null;
	let refreshed = 0;
	const ctx = { refresh: () => { refreshed++; }, sort: null };
	const host = makeHost({
		plugin: { orchestrationAutoRunner: { enqueueAndRun: (type, params, opts) => { enqueuedWith = { type, params, opts }; return Promise.resolve({ id: 'job-1' }); } } },
	});
	renderEnrichButton(td, host, { videoId: 'v1', title: 't', channelName: 'c' }, null, ctx);
	const el = td.children[0];
	el.listeners.click();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(enqueuedWith.params, { videoId: 'v1', title: 't', channelName: 'c' });
	assert.equal(refreshed, 1);
});

test('renderEnrichButton: no orchestrationAutoRunner — re-enables without throwing', async () => {
	const td = makeFakeEl('td');
	const host = makeHost({ plugin: {} });
	renderEnrichButton(td, host, { videoId: 'v1', title: 't', channelName: 'c' }, null, noopCtx);
	const el = td.children[0];
	el.listeners.click();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(el.disabled, false);
});

/* ------------------------------------------------------------------------- renderSkipButton / renderIgnoreButton */

test('renderSkipButton: icon-only circle-x button, warn class, aria-label/title, never mod-warning', () => {
	const td = makeFakeEl('td');
	renderSkipButton(td, makeHost(), 'blog', 'post-1', 'uncapturedPosts', 'ignoredPosts', noopCtx);
	assert.equal(td.children.length, 1);
	const btn = td.children[0];
	assert.equal(btn.tag, 'button');
	assert.equal(btn.text, '', 'icon-only: no visible text label');
	assert.ok(btn.cls.includes('crucible-intake-icon-btn'));
	assert.ok(btn.cls.includes('crucible-intake-warn-btn'));
	assert.ok(!btn.cls.includes('mod-warning'), 'reversible action — never the destructive/error-red class');
	assert.equal(btn.iconName, 'circle-x');
	assert.equal(btn.attrs['aria-label'], 'Skip');
	assert.equal(btn.attrs.title, 'Skip');
});

test('renderIgnoreButton: kept for youtubeWithoutMetadata.ts — icon-only eye-off button, warn class, aria-label/title', () => {
	const td = makeFakeEl('td');
	renderIgnoreButton(td, makeHost(), 'youtube', 'vid-1', 'youtubeWithoutMetadata', 'ignoredVideos', noopCtx);
	const btn = td.children[0];
	assert.equal(btn.text, '');
	assert.ok(btn.cls.includes('crucible-intake-warn-btn'));
	assert.ok(!btn.cls.includes('mod-warning'));
	assert.equal(btn.iconName, 'eye-off');
	assert.equal(btn.attrs['aria-label'], 'Ignore');
	assert.equal(btn.attrs.title, 'Ignore');
});

/* ------------------------------------------------------------------------- structural */

const uncapturedPostsSrc = readFileSync('src/ingestion/sections/uncapturedPosts.ts', 'utf8');
const uncapturedVideosSrc = readFileSync('src/ingestion/sections/uncapturedVideos.ts', 'utf8');
const ignoredSrc = readFileSync('src/ingestion/sections/ignored.ts', 'utf8');
const cellsSrc = readFileSync('src/ingestion/render/cells.ts', 'utf8');
const stylesCss = readFileSync('styles.css', 'utf8');

function countColumnsUsingClass(src, className) {
	const re = new RegExp(`addClass\\('${className}'\\)`, 'g');
	return (src.match(re) ?? []).length;
}

test('STRUCTURAL: uncapturedPosts.ts declares exactly one action column, slot order external/meta/command/skip', () => {
	assert.equal(countColumnsUsingClass(uncapturedPostsSrc, 'crucible-intake-action-cell'), 1);
	assert.ok(!/key: 'ignore'/.test(uncapturedPostsSrc));
	const order = ['renderExternalIconButton', 'renderMetaIconButton', 'renderClipButton', 'renderSkipButton']
		.map(name => uncapturedPostsSrc.indexOf(name + '('));
	assert.ok(order.every(i => i >= 0), 'all four slot renderers must be called');
	assert.deepEqual(order, [...order].sort((a, b) => a - b), 'slot order must be external, meta, command, skip');
});

test('STRUCTURAL: uncapturedVideos.ts declares exactly one action column and the Enriched? column is gone', () => {
	assert.equal(countColumnsUsingClass(uncapturedVideosSrc, 'crucible-intake-action-cell'), 1);
	assert.ok(!/key: 'ignore'/.test(uncapturedVideosSrc));
	assert.ok(!/key: 'watch'/.test(uncapturedVideosSrc));
	assert.ok(!/key: 'enriched'/.test(uncapturedVideosSrc), 'the stateful Enriched? column must be gone (WP-DP1 rule 3)');
	assert.ok(!uncapturedVideosSrc.includes("label: 'Enriched?'"));
	assert.match(uncapturedVideosSrc, /renderExternalIconButton\(td, row\.url, 'Watch'\)/);
	assert.match(uncapturedVideosSrc, /renderEnrichButton\(/);
	assert.match(uncapturedVideosSrc, /renderSkipButton\(/);
});

test('STRUCTURAL: ignored.ts has no Skip/Un-ignore slot and no renderUnignoreButton reference', () => {
	assert.ok(!ignoredSrc.includes('renderUnignoreButton'));
	assert.ok(!ignoredSrc.includes('renderSkipButton'), 'Ignored sections have no skip slot (WP-DP1 rule 4)');
	assert.equal(countColumnsUsingClass(ignoredSrc, 'crucible-intake-action-cell'), 2);
});

test('STRUCTURAL: renderUnignoreButton and renderIconLabelButton no longer exist in cells.ts', () => {
	assert.ok(!cellsSrc.includes('export function renderUnignoreButton'));
	assert.ok(!cellsSrc.includes('export function renderIconLabelButton'));
});

test('STRUCTURAL: styles.css defines the WP-DP1 icon-button classes plus the retained warn/action-cell classes', () => {
	assert.ok(stylesCss.includes('.crucible-intake-action-cell {'));
	assert.ok(stylesCss.includes('.crucible-intake-warn-btn {'));
	assert.ok(stylesCss.includes('.crucible-intake-icon-btn {'));
	assert.ok(stylesCss.includes('.crucible-intake-icon-btn.is-muted {'));
	assert.ok(stylesCss.includes('.crucible-intake-date-cell {'));
});
