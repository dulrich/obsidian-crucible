import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-notelock-tests');
const outfile = path.join(outdir, 'noteLock.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/orchestration/NoteLockManager.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
});

const { NoteLockManager, withOptionalNoteLock } = await import(pathToFileURL(outfile).href);

// Minimal event bus capturing emitted events.
function makeBus() {
	const events = [];
	return {
		events,
		emit(name, payload) { events.push({ name, payload }); },
	};
}

const tick = () => Promise.resolve().then(() => Promise.resolve());

test('same path serializes in FIFO order', async () => {
	const locks = new NoteLockManager();
	const order = [];
	const release1 = await locks.acquire('a.md', 'first');
	assert.equal(locks.isLocked('a.md'), true);

	// Two waiters queue behind the holder.
	const p2 = locks.acquire('a.md', 'second').then(rel => { order.push('second'); return rel; });
	const p3 = locks.acquire('a.md', 'third').then(rel => { order.push('third'); return rel; });
	await tick();
	assert.deepEqual(order, [], 'waiters do not run while held');

	release1();
	const rel2 = await p2;
	assert.deepEqual(order, ['second']);
	assert.equal(locks.currentLabel('a.md'), 'second');

	rel2();
	const rel3 = await p3;
	assert.deepEqual(order, ['second', 'third'], 'FIFO order preserved');

	rel3();
	assert.equal(locks.isLocked('a.md'), false);
});

test('different paths run concurrently', async () => {
	const locks = new NoteLockManager();
	const relA = await locks.acquire('a.md', 'a');
	let bAcquired = false;
	const pB = locks.acquire('b.md', 'b').then(rel => { bAcquired = true; return rel; });
	const relB = await pB;
	assert.equal(bAcquired, true, 'b.md not blocked by a.md');
	relA();
	relB();
});

test('withLock releases on throw', async () => {
	const locks = new NoteLockManager();
	await assert.rejects(
		locks.withLock('a.md', 'boom', async () => { throw new Error('boom'); }),
		/boom/,
	);
	assert.equal(locks.isLocked('a.md'), false, 'lock released after throw');
	// A subsequent acquire succeeds immediately.
	const rel = await locks.acquire('a.md', 'next');
	rel();
});

test('emits note-lock-changed on acquire and release', async () => {
	const bus = makeBus();
	const locks = new NoteLockManager(bus);
	const rel = await locks.acquire('a.md', 'x');
	rel();
	assert.deepEqual(bus.events, [
		{ name: 'note-lock-changed', payload: { path: 'a.md', locked: true, label: 'x' } },
		{ name: 'note-lock-changed', payload: { path: 'a.md', locked: false, label: '' } },
	]);
});

test('emits new label when a waiter is promoted', async () => {
	const bus = makeBus();
	const locks = new NoteLockManager(bus);
	const rel1 = await locks.acquire('a.md', 'first');
	const p2 = locks.acquire('a.md', 'second');
	rel1();
	const rel2 = await p2;
	assert.deepEqual(bus.events.at(-1), { name: 'note-lock-changed', payload: { path: 'a.md', locked: true, label: 'second' } });
	rel2();
});

test('double release is a no-op', async () => {
	const locks = new NoteLockManager();
	const rel = await locks.acquire('a.md', 'x');
	const other = await (async () => {
		rel();
		// Re-acquire, then call the stale release again — must not free the new holder.
		const rel2 = await locks.acquire('a.md', 'y');
		rel();
		assert.equal(locks.isLocked('a.md'), true, 'stale release did not unlock new holder');
		return rel2;
	})();
	other();
	assert.equal(locks.isLocked('a.md'), false);
});

test('withLock re-enters the same path within one context (no self-deadlock)', async () => {
	const locks = new NoteLockManager();
	const order = [];
	// Outer holds a.md, then an inner op (e.g. a chain step calling lint) takes
	// the same lock. Without reentrancy this would deadlock forever.
	const result = await locks.withLock('a.md', 'chain', async () => {
		order.push('outer-start');
		assert.equal(locks.isLocked('a.md'), true);
		const inner = await locks.withLock('a.md', 'lint', async () => {
			order.push('inner');
			return 'inner-done';
		});
		order.push('outer-end');
		return inner;
	});
	assert.equal(result, 'inner-done');
	assert.deepEqual(order, ['outer-start', 'inner', 'outer-end']);
	assert.equal(locks.isLocked('a.md'), false, 'lock fully released after reentrant run');
});

test('withLock reentrancy does not leak to a different path', async () => {
	const locks = new NoteLockManager();
	let bRanWhileAHeld = false;
	await locks.withLock('a.md', 'outer', async () => {
		// A different path is unrelated; it should acquire its own lock, not
		// be treated as already-held by this context.
		await locks.withLock('b.md', 'inner', async () => {
			bRanWhileAHeld = true;
			assert.equal(locks.isLocked('b.md'), true);
		});
		assert.equal(locks.isLocked('b.md'), false, 'b.md released independently');
	});
	assert.equal(bRanWhileAHeld, true);
});

test('a foreign waiter on a held path still queues (reentrancy is context-scoped)', async () => {
	const locks = new NoteLockManager();
	const order = [];
	const release = await locks.acquire('a.md', 'holder');
	// This withLock is NOT inside the holder's context, so it must wait.
	const waiting = locks.withLock('a.md', 'foreign', async () => { order.push('foreign'); });
	await Promise.resolve();
	assert.deepEqual(order, [], 'foreign waiter must not run while lock is held');
	release();
	await waiting;
	assert.deepEqual(order, ['foreign']);
});

test('withOptionalNoteLock runs without a manager', async () => {
	let ran = false;
	const result = await withOptionalNoteLock(undefined, 'a.md', 'x', async () => { ran = true; return 42; });
	assert.equal(ran, true);
	assert.equal(result, 42);
});
