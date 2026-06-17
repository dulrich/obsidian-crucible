import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-chaincycle-tests');
const outfile = path.join(outdir, 'chains.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/chains.ts'],
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
					'export class Modal {}',
					'export class Editor {}',
					'export class TFile {}',
					'export class TFolder {}',
					'export const Platform = { isDesktopApp: true, isMobileApp: false };',
					'export function normalizePath(p) { return String(p).replace(/\\/+/g, "/"); }',
					'globalThis.__notices = globalThis.__notices ?? [];',
					'export class Notice { constructor(msg) { globalThis.__notices.push(String(msg)); } hide() {} setMessage() {} }',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { ChainManager, chainStepResult } = await import(pathToFileURL(outfile).href);

// No active file → executeChain skips the note-lock path and runs steps directly,
// so the cycle guard is the only thing standing between a self-referential chain
// and unbounded recursion.
const stubApp = { workspace: { getActiveFile: () => null } };

test('a self-referential chain is skipped instead of recursing forever', async () => {
	globalThis.__notices = [];
	const cm = new ChainManager(stubApp);

	const chain = { name: 'Loop', steps: [{ commandId: 'crucible:re-run' }] };
	let invocations = 0;
	cm.registerInternalCommand('crucible:re-run', async () => {
		invocations++;
		// Re-enter the same chain, exactly as a nested "Chain: Loop" step would.
		await cm.executeChain(chain);
		return true;
	});

	await cm.executeChain(chain);

	// The step ran once; its nested re-entry was detected and short-circuited.
	assert.equal(invocations, 1);
	assert.ok(
		globalThis.__notices.some(n => /already running/i.test(n)),
		`expected a cycle notice, got: ${JSON.stringify(globalThis.__notices)}`,
	);
});

test('an indirect cycle A→B→A is broken at the re-entry of A', async () => {
	globalThis.__notices = [];
	const cm = new ChainManager(stubApp);

	const chainA = { name: 'A', steps: [{ commandId: 'crucible:run-b' }] };
	const chainB = { name: 'B', steps: [{ commandId: 'crucible:run-a' }] };
	let aRuns = 0;
	let bRuns = 0;
	cm.registerInternalCommand('crucible:run-b', async () => { bRuns++; await cm.executeChain(chainB); return true; });
	cm.registerInternalCommand('crucible:run-a', async () => { aRuns++; await cm.executeChain(chainA); return true; });

	await cm.executeChain(chainA);

	// A→B run once each; B's nested call back into A is skipped (A still on the stack).
	assert.equal(bRuns, 1);
	assert.equal(aRuns, 1);
});

test('the same chain can run again after it finishes (guard is stack-scoped, not one-shot)', async () => {
	globalThis.__notices = [];
	const cm = new ChainManager(stubApp);

	const chain = { name: 'Once', steps: [{ commandId: 'crucible:noop' }] };
	let runs = 0;
	cm.registerInternalCommand('crucible:noop', async () => { runs++; return true; });

	await cm.executeChain(chain);
	await cm.executeChain(chain);

	assert.equal(runs, 2);
});

test('the same chain runs on a different note instead of being skipped as a cycle', async () => {
	globalThis.__notices = [];
	const cm = new ChainManager(stubApp);

	const chain = { name: 'Refine', steps: [{ commandId: 'crucible:maybe-nest' }] };
	let runs = 0;
	let nested = false;
	cm.registerInternalCommand('crucible:maybe-nest', async () => {
		runs++;
		// Re-enter the same chain on a *different* note — the cycle guard is keyed by
		// chain + note, so this is not a cycle and must run.
		if (!nested) { nested = true; await cm.executeChain(chain, undefined, { path: 'b.md' }); }
		return true;
	});

	await cm.executeChain(chain, undefined, { path: 'a.md' });

	assert.equal(runs, 2);
});

test('re-entering the same chain on the same note is still skipped', async () => {
	globalThis.__notices = [];
	const cm = new ChainManager(stubApp);

	const chain = { name: 'Self', steps: [{ commandId: 'crucible:maybe-nest' }] };
	let runs = 0;
	let nested = false;
	cm.registerInternalCommand('crucible:maybe-nest', async () => {
		runs++;
		if (!nested) { nested = true; await cm.executeChain(chain, undefined, { path: 'a.md' }); }
		return true;
	});

	await cm.executeChain(chain, undefined, { path: 'a.md' });

	// Nested re-entry on the same note is a true cycle and short-circuits.
	assert.equal(runs, 1);
});

test('a non-mutating chain does not acquire the note lock', async () => {
	globalThis.__notices = [];
	let lockCalls = 0;
	const fakeLocks = { withLock: (_p, _l, action) => { lockCalls++; return action(); } };
	const cm = new ChainManager(stubApp, fakeLocks);

	const chain = { name: 'View', mutating: false, steps: [{ commandId: 'crucible:noop' }] };
	let runs = 0;
	cm.registerInternalCommand('crucible:noop', async () => { runs++; return true; });

	await cm.executeChain(chain, undefined, { path: 'a.md' });

	assert.equal(runs, 1);
	assert.equal(lockCalls, 0);
});

test('a mutating chain (default) acquires the note lock', async () => {
	globalThis.__notices = [];
	let lockCalls = 0;
	const fakeLocks = { withLock: (_p, _l, action) => { lockCalls++; return action(); } };
	const cm = new ChainManager(stubApp, fakeLocks);

	const chain = { name: 'Edit', steps: [{ commandId: 'crucible:noop' }] };
	cm.registerInternalCommand('crucible:noop', async () => true);

	await cm.executeChain(chain, undefined, { path: 'a.md' });

	assert.equal(lockCalls, 1);
});

test('a move step can retarget later steps to the moved note without debug mode', async () => {
	globalThis.__notices = [];
	const fakeLocks = { withLock: (_p, _l, action) => action() };
	const cm = new ChainManager(stubApp, fakeLocks);
	const original = { path: 'Clippings/post.md' };
	const moved = { path: 'daily/day/2026-06-17/post.md' };
	const seen = [];

	cm.registerInternalCommand('obsidian-crucible:move-current-file-to-daily-folder', async (_args, _prev, _editor, targetFile) => {
		seen.push(['move', targetFile?.path]);
		return chainStepResult(true, moved);
	});
	cm.registerInternalCommand('obsidian-crucible:lint-note', async (_args, _prev, _editor, targetFile) => {
		seen.push(['lint', targetFile?.path]);
		return true;
	});

	await cm.executeChain({
		name: 'Ingest as Blog',
		debugMode: false,
		steps: [
			{ commandId: 'obsidian-crucible:move-current-file-to-daily-folder' },
			{ commandId: 'obsidian-crucible:lint-note' },
		],
	}, undefined, original);

	assert.deepEqual(seen, [
		['move', 'Clippings/post.md'],
		['lint', 'daily/day/2026-06-17/post.md'],
	]);
});
