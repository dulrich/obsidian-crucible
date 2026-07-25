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
	CompanionAvailabilityGate,
	SearchReadinessGate,
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
