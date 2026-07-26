import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// The registry on its own: no queue, no backends, no Obsidian. Its whole contract is
// "what does a sequence of reports do to the state", which is exactly what these
// assert. The drain's *use* of it is tests/drainBreaker.test.mjs.
const outdir = path.join(tmpdir(), 'obsidian-crucible-servicehealth-tests');
const outfile = path.join(outdir, 'serviceHealth.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/orchestration/serviceHealth.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const {
	ServiceHealthRegistry,
	SERVICE_OPEN_WINDOW_MS,
	SERVICE_MAX_OPEN_WINDOW_MS,
	SERVICE_PROBE_STALE_MS,
} = await import(pathToFileURL(outfile).href);

const SVC = 'search-companion';

// A hand-cranked clock: the backoff and the half-open promotion are both time-based,
// and a test that slept for them would take 10 minutes.
function makeRegistry(start = 1_000_000) {
	const clock = { now: start };
	const registry = new ServiceHealthRegistry(() => clock.now);
	return { registry, clock, advance: (ms) => { clock.now += ms; } };
}

function transitions(registry) {
	const seen = [];
	registry.onTransition(t => seen.push(`${t.service}:${t.from}->${t.to}`));
	return seen;
}

// --- 1. hysteresis ---------------------------------------------------------

test('three consecutive failures open the breaker, and two do not', () => {
	const { registry } = makeRegistry();

	registry.reportFailure(SVC, 'timeout', 'slow');
	assert.equal(registry.isHealthy(SVC), true, 'one blip is not an outage');
	registry.reportFailure(SVC, 'server-error', '500');
	assert.equal(registry.isHealthy(SVC), true, 'two is still not an outage');

	registry.reportFailure(SVC, 'timeout', 'slow again');
	assert.equal(registry.isHealthy(SVC), false);
	assert.equal(registry.stateOf(SVC), 'open');
});

test('a refused connection counts double: two of them open the breaker', () => {
	const { registry } = makeRegistry();

	registry.reportFailure(SVC, 'refused', 'ECONNREFUSED');
	assert.equal(registry.stateOf(SVC), 'closed', 'one refusal is still one data point');
	registry.reportFailure(SVC, 'refused', 'ECONNREFUSED');
	assert.equal(registry.stateOf(SVC), 'open',
		'nothing is listening is unambiguous evidence in a way a timeout is not');
});

test('any success resets the score, so failures must be CONSECUTIVE to open', () => {
	const { registry } = makeRegistry();

	registry.reportFailure(SVC, 'timeout', 'a');
	registry.reportFailure(SVC, 'timeout', 'b');
	registry.reportSuccess(SVC);
	registry.reportFailure(SVC, 'timeout', 'c');
	registry.reportFailure(SVC, 'timeout', 'd');

	assert.equal(registry.stateOf(SVC), 'closed',
		'four failures around one success is a flaky service, not an outage');
	registry.reportFailure(SVC, 'timeout', 'e');
	assert.equal(registry.stateOf(SVC), 'open');
});

test('a success closes an open breaker outright — there is no gradual re-close', () => {
	const { registry } = makeRegistry();
	const seen = transitions(registry);

	for (let i = 0; i < 3; i++) registry.reportFailure(SVC, 'timeout', 'down');
	assert.equal(registry.stateOf(SVC), 'open');

	// A manual run bypasses the breaker, so a success CAN arrive while open.
	registry.reportSuccess(SVC);
	assert.equal(registry.stateOf(SVC), 'closed');
	assert.deepEqual(seen, [`${SVC}:closed->open`, `${SVC}:open->closed`]);
});

// --- 2. backoff growth and cap ---------------------------------------------

test('the open window doubles per re-open and caps at ten minutes', () => {
	const { registry, advance } = makeRegistry();
	const windows = [];

	// Each cycle: open, wait the window out, take the probe, fail it → re-open.
	for (let cycle = 0; cycle < 8; cycle++) {
		if (cycle === 0) {
			for (let i = 0; i < 3; i++) registry.reportFailure(SVC, 'timeout', 'down');
		} else {
			registry.reportFailure(SVC, 'timeout', 'probe failed');
		}
		const snap = registry.snapshotFor(SVC);
		assert.equal(snap.state, 'open');
		windows.push(snap.retryAt - snap.openedAt);

		advance(snap.retryAt - snap.openedAt);
		registry.tick();
		assert.equal(registry.stateOf(SVC), 'half-open');
		assert.equal(registry.tryAcquireProbe(SVC), true);
	}

	assert.deepEqual(windows.slice(0, 5), [
		SERVICE_OPEN_WINDOW_MS,
		SERVICE_OPEN_WINDOW_MS * 2,
		SERVICE_OPEN_WINDOW_MS * 4,
		SERVICE_OPEN_WINDOW_MS * 8,
		SERVICE_OPEN_WINDOW_MS * 16,
	], 'exponential from the 30s base');
	assert.equal(windows.at(-1), SERVICE_MAX_OPEN_WINDOW_MS, 'and capped, not unbounded');
	assert.ok(windows.every(w => w <= SERVICE_MAX_OPEN_WINDOW_MS));
});

test('a success anywhere in the cycle resets the backoff to the base window', () => {
	const { registry, advance } = makeRegistry();

	for (let i = 0; i < 3; i++) registry.reportFailure(SVC, 'timeout', 'down');
	advance(SERVICE_OPEN_WINDOW_MS);
	registry.tick();
	registry.reportFailure(SVC, 'timeout', 'probe failed');
	assert.equal(registry.snapshotFor(SVC).retryAt - registry.snapshotFor(SVC).openedAt, SERVICE_OPEN_WINDOW_MS * 2);

	registry.reportSuccess(SVC);
	for (let i = 0; i < 3; i++) registry.reportFailure(SVC, 'timeout', 'down again');
	const snap = registry.snapshotFor(SVC);
	assert.equal(snap.retryAt - snap.openedAt, SERVICE_OPEN_WINDOW_MS,
		'a recovered-then-failed service starts its backoff over, not where it left off');
});

// --- 3. a 429 overrides the computed backoff -------------------------------

test('a reported retryAfterMs (429 / quota) overrides the computed window', () => {
	const { registry } = makeRegistry();
	const quotaResetMs = 45 * 60_000;

	registry.reportFailure('youtube-api', 'rate-limited', 'quota exceeded', quotaResetMs);
	registry.reportFailure('youtube-api', 'rate-limited', 'quota exceeded', quotaResetMs);
	registry.reportFailure('youtube-api', 'rate-limited', 'quota exceeded', quotaResetMs);

	const snap = registry.snapshotFor('youtube-api');
	assert.equal(snap.state, 'open');
	assert.equal(snap.retryAt - snap.openedAt, quotaResetMs,
		'guessing 30s against a service that said "come back in 45 minutes" is 90 pointless probes');
});

test('a retryAfterMs longer than the cap is honoured, and a nonsense one is not', () => {
	const { registry } = makeRegistry();
	for (let i = 0; i < 3; i++) registry.reportFailure(SVC, 'rate-limited', 'slow down', 30 * 60_000);
	let snap = registry.snapshotFor(SVC);
	assert.equal(snap.retryAt - snap.openedAt, 30 * 60_000, 'the server outranks our cap');

	const other = makeRegistry().registry;
	for (let i = 0; i < 3; i++) other.reportFailure(SVC, 'server-error', 'boom', -5);
	snap = other.snapshotFor(SVC);
	assert.equal(snap.retryAt - snap.openedAt, SERVICE_OPEN_WINDOW_MS, 'a negative retryAfter falls back');
});

// --- 4. tick promotion -----------------------------------------------------

test('tick promotes an elapsed open window to half-open, and not a moment sooner', () => {
	const { registry, advance } = makeRegistry();
	const seen = transitions(registry);

	for (let i = 0; i < 3; i++) registry.reportFailure(SVC, 'refused', 'down');

	advance(SERVICE_OPEN_WINDOW_MS - 1);
	registry.tick();
	assert.equal(registry.stateOf(SVC), 'open', 'the window has not elapsed');

	advance(1);
	registry.tick();
	assert.equal(registry.stateOf(SVC), 'half-open');
	assert.deepEqual(seen, [`${SVC}:closed->open`, `${SVC}:open->half-open`]);

	registry.tick();
	registry.tick();
	assert.equal(seen.length, 2, 'a repeated tick in the same state emits nothing');
});

test('tick leaves a closed service completely alone', () => {
	const { registry, advance } = makeRegistry();
	const seen = transitions(registry);
	registry.reportFailure(SVC, 'timeout', 'one blip');
	advance(SERVICE_MAX_OPEN_WINDOW_MS);
	registry.tick();
	assert.equal(registry.stateOf(SVC), 'closed');
	assert.deepEqual(seen, []);
});

// --- 5. half-open single-flight probe --------------------------------------

test('half-open hands out exactly ONE probe token', () => {
	const { registry, advance } = makeRegistry();
	for (let i = 0; i < 3; i++) registry.reportFailure(SVC, 'refused', 'down');
	advance(SERVICE_OPEN_WINDOW_MS);
	registry.tick();

	assert.equal(registry.tryAcquireProbe(SVC), true, 'the first claim is the probe');
	assert.equal(registry.tryAcquireProbe(SVC), false, 'a second worker must not also claim');
	assert.equal(registry.tryAcquireProbe(SVC), false);
	assert.equal(registry.snapshotFor(SVC).probeInFlight, true);
});

test('a closed or open breaker never hands out a probe token', () => {
	const { registry, advance } = makeRegistry();
	assert.equal(registry.tryAcquireProbe(SVC), false, 'closed: the caller should be using isHealthy');

	for (let i = 0; i < 3; i++) registry.reportFailure(SVC, 'refused', 'down');
	assert.equal(registry.tryAcquireProbe(SVC), false, 'open: nothing may be claimed at all');

	advance(SERVICE_OPEN_WINDOW_MS);
	registry.tick();
	assert.equal(registry.tryAcquireProbe(SVC), true);
});

test('releaseProbe hands the token back without a verdict', () => {
	const { registry, advance } = makeRegistry();
	for (let i = 0; i < 3; i++) registry.reportFailure(SVC, 'refused', 'down');
	advance(SERVICE_OPEN_WINDOW_MS);
	registry.tick();

	assert.equal(registry.tryAcquireProbe(SVC), true);
	registry.releaseProbe(SVC);
	assert.equal(registry.stateOf(SVC), 'half-open', 'releasing is not a verdict — the state is unchanged');
	assert.equal(registry.tryAcquireProbe(SVC), true, 'and the next caller can have it');
});

test('a failed probe re-opens immediately, whatever the failure score says', () => {
	const { registry, advance } = makeRegistry();
	for (let i = 0; i < 3; i++) registry.reportFailure(SVC, 'refused', 'down');
	advance(SERVICE_OPEN_WINDOW_MS);
	registry.tick();
	assert.equal(registry.tryAcquireProbe(SVC), true);

	// ONE failure, not three: the probe existed precisely to answer this question.
	registry.reportFailure(SVC, 'timeout', 'still down');
	assert.equal(registry.stateOf(SVC), 'open');
	assert.equal(registry.snapshotFor(SVC).probeInFlight, false, 'and the token went back with it');
});

test('a successful probe closes the breaker', () => {
	const { registry, advance } = makeRegistry();
	const seen = transitions(registry);
	for (let i = 0; i < 3; i++) registry.reportFailure(SVC, 'refused', 'down');
	advance(SERVICE_OPEN_WINDOW_MS);
	registry.tick();
	registry.tryAcquireProbe(SVC);

	registry.reportSuccess(SVC);
	assert.equal(registry.stateOf(SVC), 'closed');
	assert.equal(registry.snapshotFor(SVC).probeInFlight, false);
	assert.deepEqual(seen, [`${SVC}:closed->open`, `${SVC}:open->half-open`, `${SVC}:half-open->closed`]);
});

test('a probe token nobody reported on is reclaimed rather than wedging the service', () => {
	const { registry, advance } = makeRegistry();
	for (let i = 0; i < 3; i++) registry.reportFailure(SVC, 'refused', 'down');
	advance(SERVICE_OPEN_WINDOW_MS);
	registry.tick();
	assert.equal(registry.tryAcquireProbe(SVC), true);

	// The holder vanished (threw somewhere that reports nothing / plugin reloaded).
	advance(SERVICE_PROBE_STALE_MS + 1);
	registry.tick();
	assert.equal(registry.stateOf(SVC), 'half-open', 'still half-open — nothing was decided');
	assert.equal(registry.tryAcquireProbe(SVC), true,
		'but a new probe can be taken; a lost token must not look like a permanent outage');
});

// --- 6. bookkeeping / snapshot ---------------------------------------------

test('services are independent: one outage does not implicate another', () => {
	const { registry } = makeRegistry();
	for (let i = 0; i < 3; i++) registry.reportFailure('search-embedder', 'refused', 'embedder down');

	assert.equal(registry.stateOf('search-embedder'), 'open');
	assert.equal(registry.isHealthy('search-companion'), true);
	assert.equal(registry.isHealthy('youtube-api'), true);
});

test('an unknown service reads healthy without being recorded', () => {
	const { registry } = makeRegistry();
	assert.equal(registry.isHealthy('llm:never-heard-of-it'), true);
	assert.equal(registry.stateOf('llm:never-heard-of-it'), 'closed');
	assert.deepEqual(registry.snapshot(), [], 'asking about a service does not create it');
});

test('snapshot reports the last failure even after recovery', () => {
	const { registry } = makeRegistry();
	for (let i = 0; i < 3; i++) registry.reportFailure(SVC, 'refused', 'ECONNREFUSED 127.0.0.1:4801');
	registry.reportSuccess(SVC);

	const snap = registry.snapshotFor(SVC);
	assert.equal(snap.state, 'closed');
	assert.equal(snap.lastKind, 'refused');
	assert.match(snap.lastReason, /4801/, 'the UI still wants to say what went wrong last');
	assert.equal(snap.failureScore, 0);
	assert.equal(snap.openCount, 0);
});

test('a failure while already open records the reason but does not push recovery away', () => {
	const { registry } = makeRegistry();
	for (let i = 0; i < 3; i++) registry.reportFailure(SVC, 'timeout', 'down');
	const before = registry.snapshotFor(SVC);

	// A manual run bypasses the breaker; its failure must not extend the window.
	registry.reportFailure(SVC, 'refused', 'user clicked Run and it is still down');
	const after = registry.snapshotFor(SVC);

	assert.equal(after.retryAt, before.retryAt, 'a user click must not delay recovery');
	assert.equal(after.openCount, before.openCount);
	assert.equal(after.lastKind, 'refused', 'but what was learned is recorded');
});

test('onTransition unsubscribes, and a throwing listener does not break the others', () => {
	const { registry } = makeRegistry();
	const seen = [];
	const off = registry.onTransition(() => { throw new Error('listener blew up'); });
	registry.onTransition(t => seen.push(t.to));

	for (let i = 0; i < 3; i++) registry.reportFailure(SVC, 'timeout', 'down');
	assert.deepEqual(seen, ['open'], 'the second listener still ran');

	off();
	registry.reportSuccess(SVC);
	assert.deepEqual(seen, ['open', 'closed']);
});
