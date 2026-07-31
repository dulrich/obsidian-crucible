// Structural guard: the OrchestrationAutoRunner must actually be constructed in
// onload. The WP-8 queue cutover (0c342e2) accidentally deleted the one
// `new OrchestrationAutoRunner(...)` line while removing the adjacent
// enrichmentQueue wiring — and nothing caught it: the field is declared
// non-optional (no strictPropertyInitialization in tsconfig), every consumer
// dereferences it with `?.`, esbuild tree-shook the whole class out of main.js,
// and all drain tests construct the runner themselves. The shipped plugin
// enqueued jobs forever and drained none of them (198 queued / 0 ever claimed
// in the live jobs.sqlite). These assertions make that class of deletion a red
// gate instead of a silent no-op.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSrc = readFileSync('src/main.ts', 'utf8');

test('STRUCTURAL: onload constructs the OrchestrationAutoRunner drain loop', () => {
	assert.ok(
		mainSrc.includes('this.orchestrationAutoRunner = new OrchestrationAutoRunner(this, this.orchestrator);'),
		'main.ts must assign `this.orchestrationAutoRunner = new OrchestrationAutoRunner(this, this.orchestrator);` — without it no queue drain ever runs',
	);
});

test('STRUCTURAL: the runner is constructed before the TriggerRegistry', () => {
	// Triggers enqueue jobs; the drain loop that services them must exist first
	// so the constructor-time kick and queue-event subscription see every enqueue.
	const runnerIdx = mainSrc.indexOf('new OrchestrationAutoRunner(');
	const triggersIdx = mainSrc.indexOf('new TriggerRegistry(');
	assert.ok(runnerIdx >= 0, 'OrchestrationAutoRunner construction not found');
	assert.ok(triggersIdx >= 0, 'TriggerRegistry construction not found');
	assert.ok(runnerIdx < triggersIdx, 'OrchestrationAutoRunner must be constructed before TriggerRegistry');
});

test('STRUCTURAL: onunload disposes the runner', () => {
	assert.ok(
		mainSrc.includes('this.orchestrationAutoRunner?.dispose();'),
		'onunload must dispose the auto-runner (timers + queue-event subscription)',
	);
});
