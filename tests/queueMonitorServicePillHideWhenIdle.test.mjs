import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// r2f WP-3: hide-when-idle for the service-health breaker pills. Cancelling the only
// queued/running job of the one job type that declares a service leaves the breaker
// with no possible half-open probe left, so its pill previously sat "open"/"half-open"
// forever (ServiceHealthRegistry is in-memory; reload is the only reset). The fix is
// render-side only: `shouldRenderServicePill` (exported from queueMonitor.ts) hides a
// pill whenever no queued/running job of a type declaring the service exists, leaving
// breaker state itself untouched (backoff memory preserved — the pill reappears if
// work returns while still open). Bundles the real queueMonitor.ts, same 'obsidian'
// stub pattern as tests/queueMonitorJobDetail.test.mjs, since the predicate touches no
// DOM but the module it lives in has DOM-heavy siblings.

const outdir = path.join(tmpdir(), 'obsidian-crucible-queuemonitor-servicepill-tests');
const outfile = path.join(outdir, 'queueMonitor.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/ingestion/sections/queueMonitor.ts'],
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
					'export class Notice { constructor(message) {} }',
					'export class Modal { constructor() {} }',
					'export class TFile {}',
					'export class TFolder {}',
					'export class App {}',
					'export class Setting {}',
					'export class FuzzySuggestModal {}',
					'export class FileSystemAdapter {}',
					'export function normalizePath(p) { return p; }',
					'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
					'export const Platform = {};',
					'export const moment = () => {};',
					'export function setIcon() {}',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { shouldRenderServicePill } = await import(pathToFileURL(outfile).href);

function snapshot(overrides = {}) {
	return {
		service: 'youtube-api',
		state: 'open',
		failureScore: 3,
		openCount: 1,
		probeInFlight: false,
		...overrides,
	};
}

test('shouldRenderServicePill: open + active work renders', () => {
	assert.equal(shouldRenderServicePill(snapshot({ state: 'open' }), true), true);
});

test('shouldRenderServicePill: open + idle is hidden', () => {
	assert.equal(shouldRenderServicePill(snapshot({ state: 'open' }), false), false);
});

test('shouldRenderServicePill: half-open + idle is hidden', () => {
	assert.equal(shouldRenderServicePill(snapshot({ state: 'half-open' }), false), false);
});

test('shouldRenderServicePill: half-open + active work renders', () => {
	assert.equal(shouldRenderServicePill(snapshot({ state: 'half-open' }), true), true);
});

test('shouldRenderServicePill: closed + lastKind + active work renders (muted pill)', () => {
	assert.equal(shouldRenderServicePill(snapshot({ state: 'closed', lastKind: 'http-5xx' }), true), true);
});

test('shouldRenderServicePill: closed + no lastKind is never rendered, active work or not', () => {
	assert.equal(shouldRenderServicePill(snapshot({ state: 'closed', lastKind: undefined }), true), false);
	assert.equal(shouldRenderServicePill(snapshot({ state: 'closed', lastKind: undefined }), false), false);
});

test('shouldRenderServicePill: closed + lastKind + idle is hidden (the incident case — cancelled last job)', () => {
	assert.equal(shouldRenderServicePill(snapshot({ state: 'closed', lastKind: 'timeout' }), false), false);
});

/* -------------------------------------------------------- STRUCTURAL wiring pin */

test('STRUCTURAL: buildQueueMonitorSection wires both the breaker-transition and queue-updated subscriptions with their own disposer', () => {
	const src = readFileSync('src/ingestion/sections/queueMonitor.ts', 'utf8');
	assert.match(
		src,
		/const unsubscribeHealth = host\.plugin\.serviceHealth\?\.onTransition\(\(\) => renderServiceHealthPills\(host, healthRow\)\);/,
	);
	assert.match(
		src,
		/const unsubscribeHealthQueue = host\.plugin\.ingestionEvents\?\.on\('orchestration-queue-updated', \(\) => renderServiceHealthPills\(host, healthRow\)\);/,
	);
	// Each subscription's handle is registered as its own disposer — not shared, not dropped.
	assert.match(src, /if \(unsubscribeHealth\) host\.registerDisposer\(unsubscribeHealth\);/);
	assert.match(src, /if \(unsubscribeHealthQueue\) host\.registerDisposer\(unsubscribeHealthQueue\);/);
});

test('STRUCTURAL: renderServiceHealthPills computes hasActiveWork via typesDependingOn/hasPending and gates through the exported predicate', () => {
	const src = readFileSync('src/ingestion/sections/queueMonitor.ts', 'utf8');
	assert.match(src, /orch\.typesDependingOn\(snapshot\.service\)\.some\(t => orch\.hasPending\(t\)\)/);
	assert.match(src, /if \(!shouldRenderServicePill\(snapshot, hasActiveWork\)\) continue;/);
});

test('STRUCTURAL: shouldRenderServicePill and serviceHealthPill both stay pure — no host/container/DOM parameter', () => {
	const src = readFileSync('src/ingestion/sections/queueMonitor.ts', 'utf8');
	assert.match(src, /export function shouldRenderServicePill\(snapshot: ServiceHealthSnapshot, hasActiveWork: boolean\): boolean \{/);
	assert.match(src, /function serviceHealthPill\(snapshot: ServiceHealthSnapshot\): \{ cls: string; text: string \} \| null \{/);
});
