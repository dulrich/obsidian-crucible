// Covers WP-IC1: the intake action-cell pattern (src/ingestion/render/cells.ts) and
// its single-action-column adoption in uncapturedPosts.ts / uncapturedVideos.ts.
//
// Behavioral cases bundle cells.ts against a minimal obsidian stub (same shape as
// apiKeyAffordance.test.mjs / youtubeWorkflowServiceHealth.test.mjs — App/TFile/
// TFolder/normalizePath/requestUrl/Platform/moment, here plus Notice and a recording
// setIcon) and drive the renderers with a fake DOM element supporting only the
// surface they touch (createEl/createSpan/setAttr/addClass), same rationale as
// ingestionRefreshGates.test.mjs's FakeElement. The Ignore/Unignore renderers are
// only exercised up to the point of building the button — clicking them would need
// a real host/ctx and vault write, out of scope here (that's ignoredIds.ts's own
// concern) and irrelevant to the WP-IC1 pins (icon-only, warn class, no mod-warning).
//
// STRUCTURAL source-text pins cover what isn't reachable as a pure function: each
// section declaring exactly one action column, and both new CSS classes existing.

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
	renderExternalLink,
	renderIconLabelButton,
	renderIgnoreButton,
	renderUnignoreButton,
} = await import(pathToFileURL(outfile).href);

/* ------------------------------------------------------------------------- fake DOM */

// A minimal fake element supporting only what cells.ts's renderers touch:
// createEl/createSpan (with `text`/`cls`/`href`/`type` opts), setAttr, addClass,
// addEventListener, and the `iconName` property the stub setIcon writes.
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

/* ------------------------------------------------------------------------- renderExternalLink */

test('renderExternalLink: anchor keeps its label and target/rel', () => {
	const td = makeFakeEl('td');
	renderExternalLink(td, 'https://example.com/post', 'read');
	assert.equal(td.children.length, 1);
	const a = td.children[0];
	assert.equal(a.tag, 'a');
	assert.equal(a.text, 'read');
	assert.equal(a.attrs.href, 'https://example.com/post');
	assert.equal(a.attrs.target, '_blank');
	assert.equal(a.attrs.rel, 'noopener');
});

test('renderExternalLink: appends a trailing external-link glyph as a child of the anchor', () => {
	const td = makeFakeEl('td');
	renderExternalLink(td, 'https://example.com/watch', 'watch');
	const a = td.children[0];
	assert.equal(a.children.length, 1, 'the glyph is a single child of the anchor, not a sibling in the td');
	const icon = a.children[0];
	assert.equal(icon.tag, 'span');
	assert.deepEqual(icon.cls, ['crucible-external-link-icon']);
	assert.equal(icon.iconName, 'external-link');
});

/* ------------------------------------------------------------------------- renderIconLabelButton */

test('renderIconLabelButton: glyph + visible label, and the caller wires its own click handler', () => {
	const td = makeFakeEl('td');
	let wired = null;
	renderIconLabelButton(td, 'import', 'Ingest', btn => { wired = btn; });
	assert.equal(td.children.length, 1);
	const btn = td.children[0];
	assert.equal(btn.tag, 'button');
	assert.equal(btn.iconName, 'import', 'the icon is set on the button itself (sourceEvalDashboard.ts convention)');
	assert.equal(btn.children.length, 1, 'one label span');
	assert.equal(btn.children[0].text, ' Ingest');
	assert.equal(wired, btn, 'onClickWiring receives the created button so the caller can attach its own listener');
});

test('renderIconLabelButton: works for the Enrich (sparkles) call site too', () => {
	const td = makeFakeEl('td');
	renderIconLabelButton(td, 'sparkles', 'Enrich', () => {});
	assert.equal(td.children[0].iconName, 'sparkles');
	assert.equal(td.children[0].children[0].text, ' Enrich');
});

/* ------------------------------------------------------------------------- Ignore / Unignore */

const noopCtx = { refresh: () => {}, sort: null };
const noopHost = { refresh: () => Promise.resolve() };

test('renderIgnoreButton: icon-only eye-off button, warn class, aria-label/title, never mod-warning', () => {
	const td = makeFakeEl('td');
	renderIgnoreButton(td, noopHost, 'blog', 'post-1', 'uncapturedPosts', 'ignoredPosts', noopCtx);
	assert.equal(td.children.length, 1);
	const btn = td.children[0];
	assert.equal(btn.tag, 'button');
	assert.equal(btn.text, '', 'icon-only: no visible text label');
	assert.ok(btn.cls.includes('crucible-intake-warn-btn'));
	assert.ok(!btn.cls.includes('mod-warning'), 'reversible action — never the destructive/error-red class');
	assert.equal(btn.iconName, 'eye-off');
	assert.equal(btn.attrs['aria-label'], 'Ignore');
	assert.equal(btn.attrs.title, 'Ignore');
});

test('renderUnignoreButton: icon-only eye button, warn class, aria-label/title, never mod-warning', () => {
	const td = makeFakeEl('td');
	renderUnignoreButton(td, noopHost, 'youtube', 'vid-1', 'ignoredVideos', 'uncapturedVideos', noopCtx);
	assert.equal(td.children.length, 1);
	const btn = td.children[0];
	assert.equal(btn.tag, 'button');
	assert.equal(btn.text, '', 'icon-only: no visible text label');
	assert.ok(btn.cls.includes('crucible-intake-warn-btn'));
	assert.ok(!btn.cls.includes('mod-warning'), 'reversible action — never the destructive/error-red class');
	assert.equal(btn.iconName, 'eye');
	assert.equal(btn.attrs['aria-label'], 'Un-ignore');
	assert.equal(btn.attrs.title, 'Un-ignore');
});

/* ------------------------------------------------------------------------- structural */

const uncapturedPostsSrc = readFileSync('src/ingestion/sections/uncapturedPosts.ts', 'utf8');
const uncapturedVideosSrc = readFileSync('src/ingestion/sections/uncapturedVideos.ts', 'utf8');
const stylesCss = readFileSync('styles.css', 'utf8');

function countColumnsUsingClass(src, className) {
	// Each column render body that applies the class does so via
	// `td.addClass('<className>')`; count occurrences of that call, which is exactly
	// one per action column by construction (renderPostActionCell /
	// renderVideoActionCell each call it once).
	const re = new RegExp(`addClass\\('${className}'\\)`, 'g');
	return (src.match(re) ?? []).length;
}

test('STRUCTURAL: uncapturedPosts.ts declares exactly one action column using crucible-intake-action-cell', () => {
	assert.equal(countColumnsUsingClass(uncapturedPostsSrc, 'crucible-intake-action-cell'), 1);
	// The merged column carries read/metadata/Ingest/Ignore in one cell — the old
	// separate `ignore` column key (rendered via a second `renderIgnoreButton` column
	// entry) must be gone.
	assert.ok(!/key: 'ignore'/.test(uncapturedPostsSrc), 'the ignore column key must be merged away, not just re-styled');
	assert.ok(!uncapturedPostsSrc.includes("createSpan({ text: '  ' })"), 'the literal spacer spans are replaced by the CSS gap');
});

test('STRUCTURAL: uncapturedVideos.ts declares exactly one action column using crucible-intake-action-cell', () => {
	assert.equal(countColumnsUsingClass(uncapturedVideosSrc, 'crucible-intake-action-cell'), 1);
	assert.ok(!/key: 'ignore'/.test(uncapturedVideosSrc), 'the ignore column key must be merged away, not just re-styled');
	assert.ok(!/key: 'watch'/.test(uncapturedVideosSrc), 'the watch column key must be merged into the action column');
	// The stateful Enriched? column must still exist as its own column.
	assert.match(uncapturedVideosSrc, /key: 'enriched'.*label: 'Enriched\?'/);
});

test('STRUCTURAL: styles.css defines both new WP-IC1 classes', () => {
	assert.ok(stylesCss.includes('.crucible-intake-action-cell {'));
	assert.ok(stylesCss.includes('.crucible-intake-warn-btn {'));
});
