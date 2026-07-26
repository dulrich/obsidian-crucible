import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-lifecycle-gate-tests');
const outfile = path.join(outdir, 'lifecycleGate.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/lifecycleGate.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const {
	SEARCH_OFFLINE_CACHE_MS,
	SEARCH_ONLINE_CACHE_MS,
	SEARCH_TRANSIENT_OFFLINE_MS,
	SEARCH_PROBE_TIMEOUT_ESCALATION_THRESHOLD,
	CompanionAvailabilityGate,
	SearchReadinessGate,
	SearchServiceUnavailableError,
} = await import(pathToFileURL(outfile));

test('SearchReadinessGate waits for layout and metadata readiness', () => {
	const gate = new SearchReadinessGate();

	assert.equal(gate.isReady(), false);
	gate.markLayoutReady();
	assert.equal(gate.isReady(), false);
	gate.markMetadataResolved();
	assert.equal(gate.isReady(), true);
});

test('CompanionAvailabilityGate caches offline companion checks', async () => {
	let now = 1_000;
	let checks = 0;
	const gate = new CompanionAvailabilityGate(() => now);
	const health = async () => {
		checks++;
		throw new Error('connection refused');
	};

	assert.equal(await gate.available(health), false);
	assert.equal(await gate.available(health), false);
	assert.equal(checks, 1);

	now += SEARCH_OFFLINE_CACHE_MS + 1;
	assert.equal(await gate.available(async () => ({ ok: true })), true);
});

test('CompanionAvailabilityGate shares an in-flight health check and caches online status', async () => {
	let now = 1_000;
	let checks = 0;
	let release;
	const gate = new CompanionAvailabilityGate(() => now);
	const health = () => {
		checks++;
		return new Promise(resolve => {
			release = () => resolve({ ok: true });
		});
	};

	const first = gate.available(health);
	const second = gate.available(health);
	release();
	assert.equal(await first, true);
	assert.equal(await second, true);
	assert.equal(checks, 1);

	assert.equal(await gate.available(async () => {
		checks++;
		return { ok: false };
	}), true);
	assert.equal(checks, 1);

	now += SEARCH_ONLINE_CACHE_MS + 1;
	assert.equal(await gate.available(async () => {
		checks++;
		return { ok: false };
	}), false);
	assert.equal(checks, 2);
});

test('CompanionAvailabilityGate.markOffline short-circuits subsequent checks', async () => {
	let now = 1_000;
	let checks = 0;
	const gate = new CompanionAvailabilityGate(() => now);
	const health = async () => { checks++; return { ok: true }; };

	gate.markOffline();
	assert.equal(await gate.available(health), false);
	assert.equal(checks, 0);

	now += SEARCH_OFFLINE_CACHE_MS + 1;
	assert.equal(await gate.available(health), true);
	assert.equal(checks, 1);
});

// An unavailable companion is not always a missing one. A reachable companion serving an
// index schema this build cannot query reports ok:false with its own message; surfacing the
// generic "not reachable, start the container" text there sends the user to restart
// something already healthy. See searchDeferredResult in SearchIndexWorkflow.ts.
test('CompanionAvailabilityGate keeps the reason a reachable-but-not-ok companion gave', async () => {
	const gate = new CompanionAvailabilityGate();
	const outdated = 'Search companion index schema 1 is older than this build requires (2).';

	assert.equal(gate.lastUnavailableReason(), null);
	assert.equal(await gate.available(async () => ({ ok: false, message: outdated })), false);
	assert.equal(gate.lastUnavailableReason(), outdated);
});

test('CompanionAvailabilityGate reports no reason when nothing answered', async () => {
	const gate = new CompanionAvailabilityGate();

	assert.equal(await gate.available(async () => { throw new Error('ECONNREFUSED'); }), false);
	assert.equal(gate.lastUnavailableReason(), null);
});

// The regression this pins: a rebuild's upsert threw once, markCompanionOffline latched the
// gate for the full five minutes, and every one of the ~20 remaining batch jobs then deferred
// without ever asking the companion — which was healthy the whole time. Each Obsidian reload
// drained exactly one more batch. A mid-operation failure must back off briefly and then
// re-probe for real.
test('CompanionAvailabilityGate.markTransientFailure backs off briefly, not for the full window', async () => {
	let now = 1_000;
	let checks = 0;
	const gate = new CompanionAvailabilityGate(() => now);
	const health = async () => { checks++; return { ok: true }; };

	assert.ok(SEARCH_TRANSIENT_OFFLINE_MS < SEARCH_OFFLINE_CACHE_MS, 'a transient failure must back off for less than a probe-confirmed outage');

	gate.markTransientFailure('Search service /v1/chunks/upsert timed out after 60000ms');
	assert.equal(await gate.available(health), false);
	assert.equal(checks, 0, 'still short-circuits inside the backoff window');

	now += SEARCH_TRANSIENT_OFFLINE_MS + 1;
	assert.equal(await gate.available(health), true, 'recovers on its own once the short backoff elapses');
	assert.equal(checks, 1, 're-probes for real rather than staying latched');
});

// The thrown message is what makes the deferral actionable: without it searchDeferredResult
// falls back to "not reachable at <url>. Start it with: home-compose up crucible-search",
// which is exactly the wrong instruction when the container is up and healthy.
test('CompanionAvailabilityGate.markTransientFailure keeps the thrown reason', async () => {
	const gate = new CompanionAvailabilityGate();
	const thrown = 'Search service /v1/chunks/upsert returned 500: disk full';

	gate.markTransientFailure(thrown);
	assert.equal(gate.lastUnavailableReason(), thrown);
});

test('CompanionAvailabilityGate clears a stale reason once the companion comes back', async () => {
	let now = 0;
	const gate = new CompanionAvailabilityGate(() => now);

	await gate.available(async () => ({ ok: false, message: 'schema too old' }));
	assert.equal(gate.lastUnavailableReason(), 'schema too old');

	now += SEARCH_OFFLINE_CACHE_MS + 1;
	assert.equal(await gate.available(async () => ({ ok: true })), true);
	assert.equal(gate.lastUnavailableReason(), null);
});

// ── WP-3 (sprint-exit-queue-health-and-scrub): probe semantics ─────────────────────────────
//
// A refused connection or a 5xx is confirmed evidence the companion is down or broken and
// earns the full 5-minute latch on the very first probe. A timeout confirms nothing on its
// own — the single-threaded, synchronous-SQLite companion may simply be mid-flush on a bulk
// write — so it only takes the short transient backoff until SEARCH_PROBE_TIMEOUT_ESCALATION_THRESHOLD
// consecutive timeouts (no intervening success) make repeated silence itself the evidence.

test('a refused probe result latches for the full offline window on the first probe', async () => {
	let now = 1_000;
	let checks = 0;
	const gate = new CompanionAvailabilityGate(() => now);
	const health = async () => { checks++; throw new SearchServiceUnavailableError('ECONNREFUSED', 'refused'); };

	assert.equal(await gate.available(health), false);
	assert.equal(checks, 1);

	now += SEARCH_OFFLINE_CACHE_MS - 1;
	assert.equal(await gate.available(health), false, 'still latched just before the full window elapses');
	assert.equal(checks, 1, 'short-circuits without a second probe while latched');

	now += 2;
	assert.equal(await gate.available(async () => { checks++; return { ok: true }; }), true, 'recovers once the full offline window elapses');
	assert.equal(checks, 2);
});

test('a single probe timeout backs off only briefly, not the full offline window', async () => {
	let now = 1_000;
	let checks = 0;
	const gate = new CompanionAvailabilityGate(() => now);
	const timeout = async () => { checks++; throw new SearchServiceUnavailableError('timed out', 'timeout'); };

	assert.equal(await gate.available(timeout), false);
	assert.equal(checks, 1);

	// Well short of the 5-minute latch, but past the transient window: a mere timeout must not
	// have latched for the full offline duration.
	now += SEARCH_TRANSIENT_OFFLINE_MS + 1;
	assert.equal(await gate.available(async () => { checks++; return { ok: true }; }), true, 're-probes and recovers well before the full offline window would have elapsed');
	assert.equal(checks, 2);
});

test('SEARCH_PROBE_TIMEOUT_ESCALATION_THRESHOLD consecutive probe timeouts escalate to the full latch', async () => {
	let now = 1_000;
	let checks = 0;
	const gate = new CompanionAvailabilityGate(() => now);
	const timeout = async () => { checks++; throw new SearchServiceUnavailableError('timed out', 'timeout'); };

	assert.ok(SEARCH_PROBE_TIMEOUT_ESCALATION_THRESHOLD >= 2, 'the test below assumes at least 2 timeouts precede the escalating one');

	// Every timeout before the threshold only backs off briefly, so re-probing requires
	// advancing past the short transient window each time.
	for (let i = 1; i < SEARCH_PROBE_TIMEOUT_ESCALATION_THRESHOLD; i++) {
		assert.equal(await gate.available(timeout), false);
		now += SEARCH_TRANSIENT_OFFLINE_MS + 1;
	}
	assert.equal(checks, SEARCH_PROBE_TIMEOUT_ESCALATION_THRESHOLD - 1);

	// The Nth consecutive timeout escalates: the gate now latches for the full offline window,
	// not just the transient one.
	assert.equal(await gate.available(timeout), false);
	assert.equal(checks, SEARCH_PROBE_TIMEOUT_ESCALATION_THRESHOLD);

	now += SEARCH_TRANSIENT_OFFLINE_MS + 1;
	assert.equal(await gate.available(async () => { checks++; return { ok: true }; }), false, 'still short-circuits: the escalation latched for the full window, not just the transient one');

	now += SEARCH_OFFLINE_CACHE_MS;
	assert.equal(await gate.available(async () => { checks++; return { ok: true }; }), true, 'recovers once the full offline window elapses');
});

test('a success between timeouts resets the consecutive-timeout streak', async () => {
	let now = 1_000;
	const gate = new CompanionAvailabilityGate(() => now);
	const timeout = async () => { throw new SearchServiceUnavailableError('timed out', 'timeout'); };
	const ok = async () => ({ ok: true });

	// One short of the escalation threshold, then a success — the streak must not carry over.
	for (let i = 1; i < SEARCH_PROBE_TIMEOUT_ESCALATION_THRESHOLD; i++) {
		await gate.available(timeout);
		now += SEARCH_TRANSIENT_OFFLINE_MS + 1;
	}
	await gate.available(ok);
	now += SEARCH_ONLINE_CACHE_MS + 1;

	// Immediately after the reset, one more timeout must only back off briefly again — if the
	// streak had survived the success, this alone would already be at the threshold.
	await gate.available(timeout);
	now += SEARCH_TRANSIENT_OFFLINE_MS + 1;
	assert.equal(await gate.available(ok), true, 'recovered after only the short transient window, proving the streak reset on success');
});

test('a probe timeout while the bulk-write flush flag is set records nothing', async () => {
	let now = 1_000;
	let checks = 0;
	let flushInFlight = true;
	const gate = new CompanionAvailabilityGate(() => now, () => flushInFlight);
	const timeout = async () => { checks++; throw new SearchServiceUnavailableError('timed out', 'timeout'); };

	// While flushing, the gate must not even issue the probe — a timeout here is inconclusive
	// by construction (the companion is busy with our own write), not evidence of anything.
	assert.equal(await gate.available(timeout), true, 'optimistically available during our own flush, without probing');
	assert.equal(checks, 0, 'the health check was never called');
	assert.equal(gate.lastUnavailableReason(), null, 'no state was recorded');

	// Once the flush ends, probing resumes normally.
	flushInFlight = false;
	assert.equal(await gate.available(timeout), false);
	assert.equal(checks, 1);
});

// The offline copy this pins: `SearchIndexWorkflow.searchDeferredResult` falls back to the
// "not reachable ... Start it with: home-compose up crucible-search" text only when
// `lastUnavailableReason()` is null. A refused/server-error outage deliberately stays null (so
// that correct copy fires); an escalated timeout must NOT stay null, or the same "go restart a
// healthy container" instruction would fire for a companion that is merely busy.
test('offline copy: a refused outage leaves no reason (the container-restart fallback is correct there)', async () => {
	const gate = new CompanionAvailabilityGate();
	await gate.available(async () => { throw new SearchServiceUnavailableError('ECONNREFUSED', 'refused'); });
	assert.equal(gate.lastUnavailableReason(), null);
});

test('offline copy: an escalated timeout carries its own honest reason, never the container-restart hint', async () => {
	let now = 1_000;
	const gate = new CompanionAvailabilityGate(() => now);
	const timeout = async () => { throw new SearchServiceUnavailableError('timed out', 'timeout'); };

	for (let i = 1; i < SEARCH_PROBE_TIMEOUT_ESCALATION_THRESHOLD; i++) {
		await gate.available(timeout);
		now += SEARCH_TRANSIENT_OFFLINE_MS + 1;
	}
	await gate.available(timeout);

	const reason = gate.lastUnavailableReason();
	assert.notEqual(reason, null, 'a repeated timeout must not fall back to the null/container-restart path');
	assert.doesNotMatch(reason, /home-compose/i, 'the container-restart hint is reserved for a confirmed refused/server-error outage');
});
