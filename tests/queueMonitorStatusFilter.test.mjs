// WP-DP3: the queue monitor's status filter bar (the former whole-DB stats row,
// moved below the enable/run/clear control bar and turned into clickable pills) and
// its two pure decision functions — which `listJobs` call(s) a filter selection
// requires (`queueFetchPlan`) and the honest empty-state line for a filter selection
// (`queueEmptyStateText`). Also covers the row-scope icon language (Run=play,
// Cancel=x, Details=info) and the per-status action-validity gating as STRUCTURAL
// source-text pins — the full fetch→sortable-table render path needs an Orchestrator
// double and a much heavier DOM stub than the behavioral cases below warrant, and the
// codebase's established pattern (see tests/ingestionTableCapAndGating.test.mjs,
// tests/queueMonitorJobDetail.test.mjs) is to pin such shapes textually rather than
// mirror-reimplement them.
//
// Bundles the real queueMonitor.ts against the same minimal obsidian stub as
// tests/queueMonitorJobDetail.test.mjs, plus a recording `setIcon` (same pattern as
// tests/ingestionIntakeActionCell.test.mjs) so the pill-bar behavioral cases exercise
// the real renderer rather than a re-implementation.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-queuemonitor-status-filter-tests');
const outfile = path.join(outdir, 'queueMonitor.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/ingestion/sections/queueMonitor.ts'],
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
					'export class Notice { constructor(message) {} }',
					'export class Modal { constructor() {} }',
					'export class TFile {}',
					'export class TFolder {}',
					'export class App {}',
					'export class Setting {}',
					'export class FuzzySuggestModal {}',
					'export class FileSystemAdapter {}',
					'export function normalizePath(p) { return p; }',
					'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
					'export const Platform = {};',
					'export const moment = () => {};',
					// Recording stub: sets an `iconName` property on the element it was
					// called with, mirroring tests/ingestionIntakeActionCell.test.mjs.
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
	queueFetchPlan,
	queueEmptyStateText,
	renderQueueFilterBar,
} = await import(pathToFileURL(outfile).href);

/* ------------------------------------------------------------------------- fake DOM */

// Same shape as tests/ingestionIntakeActionCell.test.mjs's makeFakeEl, extended with
// `empty()` (renderQueueFilterBar clears its container on every call) and a `title`
// property (assigned directly, not via setAttr, by the button-building code paths
// this file doesn't exercise but the shared stub should tolerate). `cls` accepts a
// space-separated string and splits it, matching Obsidian's real `DomElementInfo.cls`
// contract (see node_modules/obsidian/obsidian.d.ts) — queueMonitor.ts's filter pills
// pass one composed string like `'crucible-pill is-contrast'`.
function makeFakeEl(tag) {
	const el = {
		tag,
		cls: [],
		attrs: {},
		text: '',
		title: '',
		children: [],
		disabled: false,
		iconName: null,
		listeners: {},
		addClass(c) { this.cls.push(c); },
		setAttr(k, v) { this.attrs[k] = v; },
		addEventListener(evt, fn) { this.listeners[evt] = fn; },
		empty() { this.children = []; },
		createEl(childTag, opts = {}) {
			const child = makeFakeEl(childTag);
			if (opts.text != null) child.text = opts.text;
			if (opts.cls) {
				const classes = Array.isArray(opts.cls) ? opts.cls : opts.cls.split(' ').filter(Boolean);
				child.cls.push(...classes);
			}
			this.children.push(child);
			return child;
		},
		createSpan(opts = {}) {
			return this.createEl('span', opts);
		},
	};
	return el;
}

function makeHost(queueStats) {
	return {
		app: {},
		plugin: {
			orchestrator: {
				queueStats: () => queueStats,
			},
		},
		refresh: () => Promise.resolve(),
	};
}

const STATS = { queued: 2, running: 1, done: 4, failed: 0, cancelled: 3 };

/* ------------------------------------------------------------------------- queueFetchPlan */

test('queueFetchPlan: null (default view) plans the combined queued+running fetch', () => {
	assert.deepEqual(queueFetchPlan(null), { kind: 'combined' });
});

// WP-G3: queueFetchPlan's single-status plan also carries an `order` mode — 'claim'
// (dispatch truth) for queued/running, 'recency' (settlement-newest-first) for a
// settled bucket, so a done/failed/cancelled filter doesn't bury recent settlements
// behind older retained rows.
const EXPECTED_ORDER = { queued: 'claim', running: 'claim', done: 'recency', failed: 'recency', cancelled: 'recency' };

for (const status of ['queued', 'running', 'done', 'failed', 'cancelled']) {
	test(`queueFetchPlan: '${status}' plans a single-status fetch for that bucket, ordered '${EXPECTED_ORDER[status]}'`, () => {
		assert.deepEqual(queueFetchPlan(status), { kind: 'single', status, order: EXPECTED_ORDER[status] });
	});
}

/* ------------------------------------------------------------------------- queueEmptyStateText */

test('queueEmptyStateText: null (default view) is the original "Queue is empty." copy', () => {
	assert.equal(queueEmptyStateText(null), 'Queue is empty.');
});

test('queueEmptyStateText: queued/running (not retention-pruned) get a plain "no jobs" line', () => {
	assert.equal(queueEmptyStateText('queued'), 'No queued jobs.');
	assert.equal(queueEmptyStateText('running'), 'No running jobs.');
});

for (const status of ['done', 'failed', 'cancelled']) {
	test(`queueEmptyStateText: '${status}' (a settled, retention-pruned bucket) names retention rather than saying "no jobs"`, () => {
		const text = queueEmptyStateText(status);
		assert.match(text, new RegExp(`^No ${status} jobs retained\\.`));
		assert.match(text, /retention/i, 'must name the mechanism, not just report an empty count');
	});
}

/* ------------------------------------------------------------------------- renderQueueFilterBar */

test('renderQueueFilterBar: renders one pill-button per bucket, labelled with the whole-DB count', () => {
	const container = makeFakeEl('div');
	renderQueueFilterBar(makeHost(STATS), container, null, () => {});
	assert.equal(container.children.length, 5);
	const texts = container.children.map(c => c.text);
	assert.deepEqual(texts, ['queued 2', 'running 1', 'done 4', 'failed 0', 'cancelled 3']);
	for (const btn of container.children) {
		assert.equal(btn.tag, 'button');
		assert.ok(btn.cls.includes('crucible-pill'));
	}
});

test('renderQueueFilterBar: no active filter — is-error only on failed while non-zero, others is-muted, aria-pressed=false throughout', () => {
	const container = makeFakeEl('div');
	renderQueueFilterBar(makeHost({ ...STATS, failed: 5 }), container, null, () => {});
	const byBucket = Object.fromEntries(container.children.map(c => [c.text.split(' ')[0], c]));
	assert.ok(byBucket.failed.cls.includes('is-error'));
	assert.ok(!byBucket.failed.cls.includes('is-muted'));
	for (const bucket of ['queued', 'running', 'done', 'cancelled']) {
		assert.ok(byBucket[bucket].cls.includes('is-muted'), `${bucket} should be is-muted while inactive`);
	}
	for (const btn of container.children) {
		assert.equal(btn.attrs['aria-pressed'], 'false');
	}
});

test('renderQueueFilterBar: the active bucket gets is-contrast (not is-error, even if failed and non-zero) and aria-pressed=true', () => {
	const container = makeFakeEl('div');
	renderQueueFilterBar(makeHost({ ...STATS, failed: 5 }), container, 'failed', () => {});
	const byBucket = Object.fromEntries(container.children.map(c => [c.text.split(' ')[0], c]));
	assert.ok(byBucket.failed.cls.includes('is-contrast'));
	assert.ok(!byBucket.failed.cls.includes('is-error'), 'the active treatment overrides the at-rest error hue');
	assert.equal(byBucket.failed.attrs['aria-pressed'], 'true');
	// Every other pill stays unselected.
	for (const bucket of ['queued', 'running', 'done', 'cancelled']) {
		assert.equal(byBucket[bucket].attrs['aria-pressed'], 'false');
	}
});

test('renderQueueFilterBar: every pill carries an aria-label and a title (icon/count-only controls need both)', () => {
	const container = makeFakeEl('div');
	renderQueueFilterBar(makeHost(STATS), container, null, () => {});
	for (const btn of container.children) {
		assert.ok(btn.attrs['aria-label'], 'aria-label must be set');
		assert.ok(btn.title, 'title must be set');
	}
});

test('renderQueueFilterBar: clicking a bucket button invokes onSelect with that bucket', () => {
	const container = makeFakeEl('div');
	const selected = [];
	renderQueueFilterBar(makeHost(STATS), container, null, status => selected.push(status));
	const doneBtn = container.children.find(c => c.text.startsWith('done'));
	doneBtn.listeners.click();
	assert.deepEqual(selected, ['done']);
});

test('renderQueueFilterBar: null queueStats (orchestration unavailable) renders nothing, same as the pre-DP3 stats row', () => {
	const container = makeFakeEl('div');
	renderQueueFilterBar(makeHost(null), container, null, () => {});
	assert.equal(container.children.length, 0);
});

/* ------------------------------------------------------------------------- STRUCTURAL: icon language + gating */

const SRC = readFileSync('src/ingestion/sections/queueMonitor.ts', 'utf8');

test('STRUCTURAL: row-scope actions use the fleet icon language — Run=play, Cancel=x, Details=info', () => {
	assert.match(SRC, /renderIconButton\(td, 'play', \{\s*\n\s*ariaLabel: 'Run',/);
	assert.match(SRC, /renderIconButton\(td, 'x', \{\s*\n\s*ariaLabel: 'Cancel',/);
	assert.match(SRC, /renderIconButton\(td, 'info', \{\s*\n\s*ariaLabel: 'Details',/);
});

test('STRUCTURAL: Cancel keeps mod-warning (destructive-family styling) even though it is now icon-only', () => {
	assert.match(SRC, /cancel\.addClass\('mod-warning'\);/);
});

// WP-K2: "muted, never absent" — every row renders all three action buttons
// (Run/Details/Cancel), unconditionally. Each of the three call sites below is a
// mutually-exclusive if/else (or an early-return guard inside renderCancelAction)
// that resolves to exactly one renderIconButton call no matter the row status, so
// pinning "one call per branch, no omission branch survives" is equivalent to
// pinning "3 children in the action cell" without needing a full DOM harness for
// buildQueueMonitorSection (which needs an Orchestrator double + listJobs stubs —
// heavier than every other case in this file, which are structural source-text
// pins for the same reason; see the file banner).
test('STRUCTURAL: Run always renders — live for queued rows, muted (disabled) with a status-specific title otherwise', () => {
	assert.match(SRC, /if \(r\.status === 'queued'\) \{\s*\n\s*renderIconButton\(td, 'play', \{\s*\n\s*ariaLabel: 'Run',\s*\n\s*title: 'Run this job now/);
	assert.match(SRC, /\} else \{\s*\n\s*renderIconButton\(td, 'play', \{\s*\n\s*ariaLabel: 'Run',\s*\n\s*disabled: true,/);
	assert.match(SRC, /'This job is already running\.'/);
	assert.match(SRC, /'Finished jobs aren\\'t re-run from the queue; re-queue it from its source instead\.'/);
});

test('STRUCTURAL: Details is unconditional (no status guard) and Cancel is always invoked (no status guard at the call site)', () => {
	// Details has no status guard around its renderIconButton call — the surrounding
	// text between the Run block and the Cancel call is exactly the Details call.
	const runBlockEnd = SRC.indexOf("renderIconButton(td, 'info'");
	const cancelCallIdx = SRC.indexOf('renderCancelAction(host, td, r.type as JobType, r.key, r.status);');
	assert.ok(runBlockEnd > 0 && cancelCallIdx > runBlockEnd, 'Details call must sit between the Run and Cancel blocks');
	// No `if (r.status === ...)` guard immediately precedes the renderCancelAction call
	// — assert the previous non-blank line is the "unconditional" comment, not an `if`.
	const before = SRC.slice(0, cancelCallIdx);
	const lastIfIdx = before.lastIndexOf('if (r.status');
	assert.ok(lastIfIdx === -1 || before.slice(lastIfIdx).includes('Details'), 'no status guard wraps the renderCancelAction call');
});

test('STRUCTURAL: renderCancelAction takes the full JobStatus union and renders a muted, non-destructive Cancel for settled rows, before the isCancelling check', () => {
	assert.match(SRC, /status: JobStatus,\s*\n\)\s*:\s*void \{/);
	const terminalBranchIdx = SRC.indexOf("if (status !== 'queued' && status !== 'running')");
	const isCancellingIdx = SRC.indexOf('host.plugin.orchestrator.isCancelling(type, key)');
	assert.ok(terminalBranchIdx > 0 && isCancellingIdx > terminalBranchIdx, 'the terminal muted branch must precede the isCancelling check');
	const terminalBranch = SRC.slice(terminalBranchIdx, isCancellingIdx);
	assert.match(terminalBranch, /renderIconButton\(td, 'x', \{\s*\n\s*ariaLabel: 'Cancel',\s*\n\s*title: 'This job has already finished — there\\'s nothing left to stop\.',\s*\n\s*cls: 'crucible-queue-cancel-btn',\s*\n\s*disabled: true,/);
	assert.doesNotMatch(terminalBranch, /mod-warning/, 'the muted terminal Cancel must not carry mod-warning — nothing destructive on offer');
});

test('STRUCTURAL: the filter bar row is created after (moves below) the enable/run/clear control bar', () => {
	const controlsIdx = SRC.indexOf("cls: 'crucible-ingestion-queue-controls'");
	const statsRowIdx = SRC.indexOf("const statsRow = card.createDiv({ cls: 'crucible-queue-stats-row' });");
	assert.ok(controlsIdx > 0 && statsRowIdx > 0, 'both anchors must exist');
	assert.ok(statsRowIdx > controlsIdx, 'the stats/filter row must be created after the control bar, so it renders below it');
});

test('STRUCTURAL: the active filter is per-mount view state on the SectionContext, never persisted to settings', () => {
	assert.match(SRC, /queueStatusFilter: null,/);
	assert.doesNotMatch(SRC, /settings\.queueStatusFilter/, 'the filter must never be read from or written to plugin settings');
});
