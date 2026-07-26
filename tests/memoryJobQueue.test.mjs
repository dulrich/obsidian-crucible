import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-memqueue-tests');
const outfile = path.join(outdir, 'memoryJobQueue.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/orchestration/MemoryJobQueue.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
});

const { MemoryJobQueue } = await import(pathToFileURL(outfile).href);

function makeQueue(retentionMs = 60_000) {
	const changes = [];
	const queue = new MemoryJobQueue(retentionMs, size => changes.push(size));
	return { queue, changes };
}

test('enqueue dedupes keys that are still pending or running', () => {
	const { queue } = makeQueue();
	assert.equal(queue.enqueue('v1', { videoId: 'v1' }), true);
	assert.equal(queue.enqueue('v1', { videoId: 'v1' }), false, 'pending duplicate rejected');
	assert.equal(queue.getPendingCount(), 1);

	const claimed = queue.claimNext();
	assert.equal(claimed.key, 'v1');
	assert.equal(claimed.status, 'running');
	assert.equal(queue.enqueue('v1', { videoId: 'v1' }), false, 'running duplicate rejected');
});

test('a terminal key can be re-enqueued', () => {
	const { queue } = makeQueue();
	queue.enqueue('v1', { videoId: 'v1' });
	queue.claimNext();
	queue.markDone('v1');
	assert.equal(queue.getPendingCount(), 0);
	assert.equal(queue.enqueue('v1', { videoId: 'v1' }), true, 'done key re-enqueues');
	assert.equal(queue.getEntry('v1').status, 'pending');
});

test('claimNext is FIFO by insertion and flips status atomically', () => {
	const { queue } = makeQueue();
	queue.enqueue('a', {});
	queue.enqueue('b', {});
	assert.equal(queue.claimNext().key, 'a');
	assert.equal(queue.claimNext().key, 'b');
	assert.equal(queue.claimNext(), null, 'nothing left to claim');
});

test('claimNext drains user lane before background without interrupting running jobs', () => {
	const { queue } = makeQueue();
	queue.enqueue('background-running', {}, {}, 'background');
	assert.equal(queue.claimNext().key, 'background-running');
	queue.enqueue('background-pending', {}, {}, 'background');
	queue.enqueue('user-pending', {}, {}, 'user');

	assert.equal(queue.claimNext().key, 'user-pending');
	assert.equal(queue.claimNext().key, 'background-pending');
});

test('a user enqueue promotes a pending background duplicate but not a running one', () => {
	const { queue } = makeQueue();
	queue.enqueue('a', { source: 'auto' }, {}, 'background');
	assert.equal(queue.enqueue('a', { source: 'manual' }, {}, 'user'), true);
	assert.equal(queue.getEntry('a').lane, 'user');
	assert.equal(queue.getEntry('a').params.source, 'manual');

	queue.claimNext();
	assert.equal(queue.enqueue('a', { source: 'late-manual' }, {}, 'user'), false);
	assert.equal(queue.getEntry('a').params.source, 'manual');
});

test('refill only runs when auto enabled and skips known keys', () => {
	const { queue } = makeQueue();
	queue.enqueue('a', {});
	queue.setAutoSource(() => [
		{ key: 'a', params: {} },          // already tracked → skip
		{ key: 'b', params: { videoId: 'b' }, display: { title: 'B' } },
	]);
	// Auto disabled by default → no refill yet.
	assert.equal(queue.getPendingCount(), 1);

	queue.setAutoSourceEnabled(true); // triggers a refill
	assert.equal(queue.getPendingCount(), 2);
	assert.equal(queue.getEntry('b').display.title, 'B');
});

test('dequeueIfPending removes only pending entries', () => {
	const { queue } = makeQueue();
	queue.enqueue('a', {});
	queue.enqueue('b', {});
	queue.claimNext(); // 'a' → running
	assert.equal(queue.dequeueIfPending('a'), false, 'running not dequeued');
	assert.equal(queue.dequeueIfPending('b'), true);
	assert.equal(queue.getEntry('b'), null);
});

// --- the queued half of the single Cancel verb ------------------------------

test('cancelIfPending stops only pending entries, and marks rather than deletes', () => {
	const { queue } = makeQueue();
	queue.enqueue('a', {});
	queue.enqueue('b', {});
	queue.claimNext(); // 'a' → running

	assert.equal(queue.cancelIfPending('a', 'stopped'), false, 'a running entry is aborted, not dropped');
	assert.equal(queue.getEntry('a').status, 'running');

	assert.equal(queue.cancelIfPending('b', 'stopped'), true);
	const cancelled = queue.getEntry('b');
	assert.equal(cancelled.status, 'cancelled', 'the entry stays, terminal — it is not deleted');
	assert.equal(cancelled.note, 'stopped');
	assert.equal(cancelled.error, undefined, 'a cancellation is not a diagnostic');
	assert.equal(queue.getPendingCount(), 1, 'only the running entry still counts as in flight');
});

test('a cancelled entry suppresses its own auto-source re-seed until it is swept', () => {
	// Retention 0 so the sweep at the end of the test is immediate; the suppression
	// being tested is refill's, and refill never sweeps regardless of the window.
	const { queue } = makeQueue(0);
	queue.setAutoSource(() => [{ key: 'seeded', params: {} }]);
	queue.setAutoSourceEnabled(true);
	assert.equal(queue.getEntry('seeded').status, 'pending');

	assert.equal(queue.cancelIfPending('seeded'), true);
	queue.refill();
	assert.equal(queue.getEntry('seeded').status, 'cancelled',
		'refill skips a tracked key, so an enabled source cannot instantly undo the cancel');

	// The suppression is not permanent, which is exactly why the UI copy says cleared
	// items can come back: once retention expires the source may offer the key again.
	queue.sweepTerminal();
	assert.equal(queue.getEntry('seeded'), null);
	queue.refill();
	assert.equal(queue.getEntry('seeded').status, 'pending', 'after the sweep the source re-seeds it');
});

test('clearPending cancels every pending entry with exactly one change event', () => {
	const { queue, changes } = makeQueue();
	for (let i = 0; i < 5; i++) queue.enqueue(`k${i}`, {});
	queue.claimNext(); // 'k0' → running, untouched by a clear
	changes.length = 0;

	assert.equal(queue.clearPending('bulk'), 4);
	assert.equal(changes.length, 1,
		'one user action must not fan out into N queue-changed events (each one kicks a drain)');
	assert.equal(queue.getEntry('k0').status, 'running');
	for (let i = 1; i < 5; i++) assert.equal(queue.getEntry(`k${i}`).status, 'cancelled');
	assert.equal(queue.getPendingCount(), 1);

	changes.length = 0;
	assert.equal(queue.clearPending(), 0, 'nothing pending');
	assert.equal(changes.length, 0, 'a no-op clear emits nothing at all');
});

test('sweepTerminal drops terminal entries past the retention window', () => {
	const { queue } = makeQueue(0); // retention 0 → terminal entries immediately stale
	queue.enqueue('a', {});
	queue.claimNext();
	queue.markFailed('a', 'boom');
	queue.sweepTerminal();
	assert.equal(queue.getEntry('a'), null, 'failed entry swept');
});

test('snapshot sorts running ahead of pending', () => {
	const { queue } = makeQueue();
	queue.enqueue('a', {});
	queue.enqueue('b', {});
	queue.claimNext(); // 'a' → running
	const order = queue.snapshot().map(e => `${e.key}:${e.status}`);
	assert.deepEqual(order, ['a:running', 'b:pending']);
});

// --- releaseToPending: the transition that made a memory job able to defer -----
//
// Before it existed, MemoryJobBackend.runEntry had no 'deferred' branch at all, so a
// workflow answering "come back later" fell through to the success path and the entry
// was marked DONE. The work silently never happened, and `refill` skips any key it
// already tracks, so the auto-source would not re-offer it either.

test('releaseToPending returns a running entry to pending, with one onChange', () => {
	const { queue, changes } = makeQueue();
	queue.enqueue('a', { videoId: 'a' });
	queue.claimNext();
	changes.length = 0;

	assert.equal(queue.releaseToPending('a'), true);
	const entry = queue.getEntry('a');
	assert.equal(entry.status, 'pending');
	assert.equal(entry.finishedAt, undefined, 'it did not finish — nothing terminal happened');
	assert.equal(entry.error, undefined, 'and a deferral is emphatically not a failure');
	assert.equal(changes.length, 1, 'each onChange emits an event and kicks a drain; one transition is one change');
});

test('releaseToPending only accepts a RUNNING entry', () => {
	const { queue } = makeQueue();
	queue.enqueue('a', {});
	assert.equal(queue.releaseToPending('a'), false, 'a pending entry was never claimed');

	queue.claimNext();
	queue.markDone('a');
	assert.equal(queue.releaseToPending('a'), false, 'and a terminal entry is settled');
	assert.equal(queue.releaseToPending('nope'), false, 'an unknown key is not an error');
});

test('a released entry is claimable again, and keeps its params and lane', () => {
	const { queue } = makeQueue();
	queue.enqueue('a', { videoId: 'a' }, { title: 'T' }, 'user');
	queue.claimNext();
	queue.releaseToPending('a');

	const again = queue.claimNext();
	assert.equal(again.key, 'a');
	assert.deepEqual(again.params, { videoId: 'a' });
	assert.equal(again.lane, 'user', 'a user-lane job stays a user-lane job across a deferral');
});

test('a cooloff makes the released entry unclaimable until it expires', () => {
	const { queue } = makeQueue();
	queue.enqueue('a', {});
	queue.claimNext();
	queue.releaseToPending('a', 60_000);

	assert.equal(queue.getEntry('a').status, 'pending');
	assert.equal(queue.hasPending(), false, 'pending, but not yet claimable');
	assert.equal(queue.claimNext(), null,
		'without this, releasing hands the entry straight back to the drain that just deferred it');
});

test('an expired cooloff releases the entry to the drain again', () => {
	const { queue } = makeQueue();
	queue.enqueue('a', {});
	queue.claimNext();
	queue.releaseToPending('a', -1); // no cooloff at all

	assert.equal(queue.hasPending(), true);
	assert.equal(queue.claimNext().key, 'a');
});

test('a cooled-off entry does not block a different entry from draining', () => {
	const { queue } = makeQueue();
	queue.enqueue('a', {});
	queue.claimNext();
	queue.releaseToPending('a', 60_000);
	queue.enqueue('b', {});

	assert.equal(queue.hasPending(), true);
	assert.equal(queue.claimNext().key, 'b', 'one deferred entry must not stall the whole queue');
});

test('a user enqueue overrides a cooloff, like the manual per-job Run does', () => {
	const { queue } = makeQueue();
	queue.enqueue('a', {}, {}, 'background');
	queue.claimNext();
	queue.releaseToPending('a', 60_000);

	assert.equal(queue.enqueue('a', { fresh: true }, {}, 'user'), true, 'promoted to the user lane');
	assert.equal(queue.hasPending(), true, 'a user asking for it now outranks the cooloff');
	assert.equal(queue.claimNext().key, 'a');
});

test('a cooled-off entry is still claimable by key for a manual Run', () => {
	const { queue } = makeQueue();
	queue.enqueue('a', {});
	queue.claimNext();
	queue.releaseToPending('a', 60_000);

	const claimed = queue.claimEntry('a');
	assert.ok(claimed, 'claimEntry is the manual Run: it ignores the cooloff exactly as claimById does');
	assert.equal(claimed.status, 'running');
});
