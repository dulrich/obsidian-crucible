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

const { NoteLockManager, withOptionalNoteLock, resourceLockKey } = await import(pathToFileURL(outfile).href);

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

// ── FIFO ordering regression ────────────────────────────────────────────────

test('withLock: three contenders run strictly in submission order, none rejected', async () => {
	const locks = new NoteLockManager();
	const order = [];
	// Kick off all three concurrently; they race to enqueue but the queue must
	// honour arrival order (FIFO).
	const p1 = locks.withLock('x.md', 'first',  async () => { order.push('first'); });
	const p2 = locks.withLock('x.md', 'second', async () => { order.push('second'); });
	const p3 = locks.withLock('x.md', 'third',  async () => { order.push('third'); });
	// All three must settle without rejection.
	await Promise.all([p1, p2, p3]);
	assert.deepEqual(order, ['first', 'second', 'third'], 'strict FIFO ordering');
});

// ── withResourceLock ────────────────────────────────────────────────────────

test('resourceLockKey produces kind::id shape', () => {
	assert.equal(resourceLockKey('yt-video', 'abc'), 'yt-video::abc');
});

test('withResourceLock: same kind+id serializes', async () => {
	const locks = new NoteLockManager();
	const order = [];
	const p1 = locks.withResourceLock('yt-video', 'abc', 'job1', async () => { order.push('job1'); });
	const p2 = locks.withResourceLock('yt-video', 'abc', 'job2', async () => { order.push('job2'); });
	await Promise.all([p1, p2]);
	assert.deepEqual(order, ['job1', 'job2'], 'same resource id serializes in FIFO order');
});

test('withResourceLock: different ids run concurrently', async () => {
	const locks = new NoteLockManager();
	let secondStarted = false;
	// Hold 'id-A' open while we check that 'id-B' is not blocked.
	let releaseA;
	const holdA = new Promise(resolve => { releaseA = resolve; });
	const pA = locks.withResourceLock('yt-video', 'id-A', 'A', () => holdA);
	const pB = locks.withResourceLock('yt-video', 'id-B', 'B', async () => { secondStarted = true; });
	// pB should resolve immediately even while A is still held.
	await pB;
	assert.equal(secondStarted, true, 'different resource id is not blocked by A');
	releaseA();
	await pA;
});

test('resource key never collides with a plain path lock', async () => {
	const locks = new NoteLockManager();
	// A file path that looks like a resource key does not exist in practice
	// because `:` is invalid in vault names, but prove the key shapes are distinct.
	const resourceKey = resourceLockKey('yt-video', 'abc');
	assert.equal(resourceKey.includes('::'), true);
	// Acquire on path 'yt-video::abc' (the file-path code path).
	const relPath = await locks.acquire('yt-video::abc', 'path-lock');
	// A resource lock for the same text must also wait — they share the same
	// underlying mutex key, which is correct (same string = same lock).
	let resourceRan = false;
	const pRes = locks.withResourceLock('yt-video', 'abc', 'res-lock', async () => { resourceRan = true; });
	await tick(); // let the event loop settle; pRes must still be queued.
	assert.equal(resourceRan, false, 'resource lock waits while plain acquire holds same key');
	relPath();
	await pRes;
	assert.equal(resourceRan, true);
});

// ── Nesting + reentrancy ────────────────────────────────────────────────────

test('withLock outer + withResourceLock inner completes without deadlock', async () => {
	const locks = new NoteLockManager();
	const order = [];
	await locks.withLock('note.md', 'outer', async () => {
		order.push('note-start');
		await locks.withResourceLock('yt-video', 'abc', 'inner', async () => {
			order.push('resource');
		});
		order.push('note-end');
	});
	assert.deepEqual(order, ['note-start', 'resource', 'note-end']);
});

test('reentrant withLock inside nested resource lock runs inline (no self-deadlock)', async () => {
	const locks = new NoteLockManager();
	const order = [];
	await locks.withLock('note.md', 'outer', async () => {
		order.push('outer-start');
		await locks.withResourceLock('yt-video', 'abc', 'resource', async () => {
			order.push('resource');
			// Re-entering the same note lock (already held by outer context).
			await locks.withLock('note.md', 'reentrant', async () => {
				order.push('reentrant');
			});
		});
		order.push('outer-end');
	});
	assert.deepEqual(order, ['outer-start', 'resource', 'reentrant', 'outer-end']);
});

// ── handleRename: lock follows a note move ───────────────────────────────────

test('handleRename migrates a held lock to the new path', async () => {
	const bus = makeBus();
	const locks = new NoteLockManager(bus);
	const rel = await locks.acquire('old.md', 'chain');
	locks.handleRename('old.md', 'new.md');
	assert.equal(locks.isLocked('old.md'), false, 'old path no longer locked');
	assert.equal(locks.isLocked('new.md'), true, 'new path locked');
	assert.equal(locks.currentLabel('new.md'), 'chain', 'label preserved across rename');
	assert.deepEqual(bus.events.slice(-2), [
		{ name: 'note-lock-changed', payload: { path: 'old.md', locked: false, label: '' } },
		{ name: 'note-lock-changed', payload: { path: 'new.md', locked: true, label: 'chain' } },
	]);
	// Release still cleans up the (re-keyed) lock.
	rel();
	assert.equal(locks.isLocked('new.md'), false, 'release frees the migrated lock');
});

test('handleRename is a no-op when nothing holds the old path', () => {
	const locks = new NoteLockManager();
	locks.handleRename('absent.md', 'new.md');
	assert.equal(locks.isLocked('new.md'), false);
	assert.equal(locks.isLocked('absent.md'), false);
});

test('handleRename leaves both locks when the new path is already locked', async () => {
	const locks = new NoteLockManager();
	const relOld = await locks.acquire('old.md', 'a');
	const relNew = await locks.acquire('new.md', 'b');
	locks.handleRename('old.md', 'new.md'); // collision: must not clobber new.md's holder
	assert.equal(locks.isLocked('old.md'), true, 'old path untouched on collision');
	assert.equal(locks.currentLabel('new.md'), 'b', 'new path holder untouched on collision');
	relOld();
	relNew();
});

test('reentrancy survives a rename mid-hold (no deadlock)', async () => {
	const locks = new NoteLockManager();
	const order = [];
	const result = await locks.withLock('old.md', 'chain', async () => {
		order.push('outer-start');
		// A chain step moves the target note; the lock follows.
		locks.handleRename('old.md', 'new.md');
		assert.equal(locks.isLocked('new.md'), true, 'lock now keyed under new path');
		// A later step re-enters the lock via the NEW path — must run inline, not wait.
		const inner = await locks.withLock('new.md', 'localize', async () => {
			order.push('inner');
			return 'inner-done';
		});
		order.push('outer-end');
		return inner;
	});
	assert.equal(result, 'inner-done');
	assert.deepEqual(order, ['outer-start', 'inner', 'outer-end']);
	assert.equal(locks.isLocked('new.md'), false, 'lock fully released after reentrant run');
});

test('a foreign waiter on the new path queues behind the renamed holder', async () => {
	const locks = new NoteLockManager();
	const order = [];
	const release = await locks.acquire('old.md', 'chain');
	locks.handleRename('old.md', 'new.md');
	// Not in the holder's context, so this must wait for the migrated lock.
	const waiting = locks.withLock('new.md', 'foreign', async () => { order.push('foreign'); });
	await tick();
	assert.deepEqual(order, [], 'foreign waiter blocked while migrated lock is held');
	release();
	await waiting;
	assert.deepEqual(order, ['foreign']);
});

// ── Resource keys do not emit note-lock-changed ──────────────────────────────

test('withResourceLock does not emit note-lock-changed', async () => {
	const bus = makeBus();
	const locks = new NoteLockManager(bus);
	await locks.withResourceLock('yt-video', 'vid1', 'job', async () => {});
	assert.deepEqual(bus.events, [], 'no events emitted for resource lock');
});

test('plain path locks still emit note-lock-changed when a bus is present', async () => {
	const bus = makeBus();
	const locks = new NoteLockManager(bus);
	const rel = await locks.acquire('note.md', 'work');
	rel();
	assert.equal(bus.events.length, 2, 'acquire + release each emit');
	assert.equal(bus.events[0].name, 'note-lock-changed');
	assert.equal(bus.events[1].name, 'note-lock-changed');
});
