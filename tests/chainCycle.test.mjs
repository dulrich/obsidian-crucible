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

const { ChainManager } = await import(pathToFileURL(outfile).href);

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
