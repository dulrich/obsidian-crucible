// WP-PF2: the Ingestion dashboard's own vault.on(...)/metadataCache.on(...) registrations were
// NOT layout-ready gated — the vf-1 create-replay class (root AGENTS.md quirk;
// tests/autoLocalizeCreateReplayGuard.test.mjs is the original exemplar for main.ts). Obsidian
// replays vault.on('create') for every pre-existing file during startup vault indexing; if the
// Ingestion dashboard is part of the restored workspace layout, mount() -> registerListeners()
// could run before that replay settled, and every replayed create hit route()'s unconditional
// 'structural' branch — marking both heavy scan sections (orphanedAttachments,
// missingAttachments) dirty repeatedly through the whole storm.
//
// The fix moves the vault/metadataCache subscriptions (metadataCache 'resolved'/'changed',
// vault 'create'/'delete'/'rename') into a callback registered via
// `this.app.workspace.onLayoutReady(...)`, mirroring triggers.start() and the auto-localize
// create listener in main.ts. A `this.unmounted` guard covers the leaf-closes-before-layout-
// ready edge case. These assertions pin that shape as source text — registration order is
// markup here, not a runtime state transition, so a source-text pin (in the style of
// tests/autoLocalizeCreateReplayGuard.test.mjs) is the right tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/ingestionDashboard.ts', 'utf8');

test('STRUCTURAL: registerListeners defers its vault/metadataCache subscriptions to onLayoutReady', () => {
	const registerListenersIdx = src.indexOf('private registerListeners(): void {');
	const layoutReadyIdx = src.indexOf('this.app.workspace.onLayoutReady(() => {', registerListenersIdx);
	const busIdx = src.indexOf('const bus = this.plugin.ingestionEvents;', registerListenersIdx);

	assert.ok(registerListenersIdx >= 0, 'registerListeners method not found');
	assert.ok(layoutReadyIdx >= 0, 'onLayoutReady registration not found inside registerListeners');
	assert.ok(busIdx >= 0, 'the ingestionEvents bus wiring (unaffected, stays eager) not found');
	assert.ok(registerListenersIdx < layoutReadyIdx, 'onLayoutReady call must sit inside registerListeners');
	assert.ok(layoutReadyIdx < busIdx, 'onLayoutReady registration must precede the bus wiring (which stays eager, outside the callback)');
});

test('STRUCTURAL: the unmounted guard is the first statement inside the onLayoutReady callback', () => {
	const layoutReadyIdx = src.indexOf('this.app.workspace.onLayoutReady(() => {');
	assert.ok(layoutReadyIdx >= 0, 'onLayoutReady registration not found');
	const body = src.slice(layoutReadyIdx, layoutReadyIdx + 400);
	assert.ok(
		/onLayoutReady\(\(\) => \{\s*\n\s*if \(this\.unmounted\) return;/.test(body),
		'expected `if (this.unmounted) return;` as the first statement in the onLayoutReady callback, guarding against a leaf that closed before layout became ready',
	);
});

test('STRUCTURAL: every vault/metadataCache listener registration sits after onLayoutReady and before the bus wiring', () => {
	const registerListenersIdx = src.indexOf('private registerListeners(): void {');
	const layoutReadyIdx = src.indexOf('this.app.workspace.onLayoutReady(() => {', registerListenersIdx);
	const busIdx = src.indexOf('const bus = this.plugin.ingestionEvents;', registerListenersIdx);
	const window = src.slice(layoutReadyIdx, busIdx);

	for (const needle of [
		"this.app.metadataCache.on('resolved'",
		"this.app.metadataCache.on('changed'",
		"this.app.vault.on('create'",
		"this.app.vault.on('delete'",
		"this.app.vault.on('rename'",
	]) {
		assert.ok(window.includes(needle), `expected ${needle} to be registered inside the onLayoutReady callback (between it and the bus wiring)`);
	}
});

test('STRUCTURAL: unmount() sets the guard before draining disposers/eventRefs', () => {
	const unmountIdx = src.indexOf('unmount(): void {');
	assert.ok(unmountIdx >= 0, 'unmount() not found');
	const body = src.slice(unmountIdx, unmountIdx + 200);
	assert.ok(
		/unmount\(\): void \{\s*\n\s*this\.unmounted = true;/.test(body),
		'expected `this.unmounted = true;` as the first statement in unmount()',
	);
});
