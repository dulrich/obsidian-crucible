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

	queue.setAutoEnabled(true); // triggers a refill
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
