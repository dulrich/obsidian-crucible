import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// WP-XM3: `shouldFireXDiscoverOnClip` is the `x-discover-on-clip` founding
// trigger's sync guard, factored out of main.ts (a small pure helper, per the
// dispatch brief) so the folder-prefix-with-boundary logic — the one part with
// a real off-by-one hazard — is unit-testable without bundling the trigger
// registration itself. Only `normalizePath` is pulled from 'obsidian', so the
// same minimal stub as tests/xJobTypeConfig.test.mjs suffices.

const outdir = path.join(tmpdir(), 'obsidian-crucible-x-discover-trigger-tests');
const outfile = path.join(outdir, 'xDiscoverTrigger.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/orchestration/utils/xDiscoverTrigger.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: 'export function normalizePath(p) { return String(p ?? "").replace(/\\\\/g, "/").replace(/\\/+/g, "/"); }',
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { isPathUnderFolder, shouldFireXDiscoverOnClip } = await import(pathToFileURL(outfile).href);

const INBOX = '_clippings/inbox';

function file(pathStr, extension = 'md') {
	return { path: pathStr, extension };
}

function settings(overrides = {}) {
	return { ingestionClipperInboxFolder: INBOX, ingestionXAutoDiscoverEnabled: true, ...overrides };
}

// ── isPathUnderFolder: prefix + boundary ─────────────────────────────────────────

test('a note directly inside the folder is under it', () => {
	assert.equal(isPathUnderFolder(`${INBOX}/clip.md`, INBOX), true);
});

test('a note nested under the folder is under it', () => {
	assert.equal(isPathUnderFolder(`${INBOX}/sub/clip.md`, INBOX), true);
});

test('a sibling folder that merely shares the prefix string is NOT under it (the boundary hazard)', () => {
	assert.equal(isPathUnderFolder('_clippings/inboxes/x.md', INBOX), false);
});

test('a note outside the folder entirely is not under it', () => {
	assert.equal(isPathUnderFolder('daily/2026-07-31.md', INBOX), false);
});

test('an empty folder setting matches nothing', () => {
	assert.equal(isPathUnderFolder('anything.md', ''), false);
});

// ── shouldFireXDiscoverOnClip: all three conditions required ────────────────────

test('fires for a markdown note under the inbox with the setting on', () => {
	assert.equal(shouldFireXDiscoverOnClip(file(`${INBOX}/clip.md`), settings()), true);
});

test('does not fire for a non-markdown file even under the inbox with the setting on', () => {
	assert.equal(shouldFireXDiscoverOnClip(file(`${INBOX}/clip.pdf`, 'pdf'), settings()), false);
});

test('does not fire when the setting is off, even for a matching markdown note', () => {
	assert.equal(shouldFireXDiscoverOnClip(file(`${INBOX}/clip.md`), settings({ ingestionXAutoDiscoverEnabled: false })), false);
});

test('does not fire for a markdown note outside the inbox folder, setting on', () => {
	assert.equal(shouldFireXDiscoverOnClip(file('daily/2026-07-31.md'), settings()), false);
});

test('does not fire for the boundary-hazard sibling folder', () => {
	assert.equal(shouldFireXDiscoverOnClip(file('_clippings/inboxes/x.md'), settings()), false);
});

test('settings are read live at call time, not captured — the same settings object mutated between calls changes the result', () => {
	const live = settings({ ingestionXAutoDiscoverEnabled: false });
	const target = file(`${INBOX}/clip.md`);
	assert.equal(shouldFireXDiscoverOnClip(target, live), false);
	live.ingestionXAutoDiscoverEnabled = true;
	assert.equal(shouldFireXDiscoverOnClip(target, live), true);
});
