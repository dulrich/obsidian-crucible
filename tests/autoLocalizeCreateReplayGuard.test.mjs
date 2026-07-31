// Structural guard: WP-VF-1 (startup create-replay guard).
//
// Obsidian replays `vault.on('create')` for every pre-existing file during vault indexing at
// startup. `triggers.start()` already defends against exactly that storm by registering its
// listeners from inside `onLayoutReady` (src/main.ts, see the comment above that call) rather
// than at `onload`. The auto-localize create path used to have no such guard: the `create`
// listener registered eagerly at onload called `handleFileCreate`, which unconditionally
// scheduled an auto-localize pass — so every restart's replay re-scheduled localize over every
// already-localized note, and the localizer's already-localized branch still enqueued a real,
// redundant `image_describe_note` job per note (~50-105 duplicate jobs per restart, verified
// against the live jobs.sqlite).
//
// The fix moves the `autoLocalizeScheduler.schedule(file, 'create')` call out of the eager
// `handleFileCreate`-driven listener and into a second `vault.on('create')` listener registered
// inside `onLayoutReady`, mirroring `triggers.start()`'s pattern exactly. These assertions pin
// that shape as source text — registration order is markup here, not a runtime state
// transition, so a source-text pin (in the style of tests/autoRunnerWiring.test.mjs) is the
// right tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSrc = readFileSync('src/main.ts', 'utf8');

test('STRUCTURAL: handleFileCreate no longer schedules auto-localize directly', () => {
	assert.ok(
		!mainSrc.includes("this.autoLocalizeScheduler.schedule(file, 'create');\n\n\t\t// CRITICAL"),
		'the auto-localize schedule call must no longer sit directly inside handleFileCreate '
		+ '(that call site ran on every startup create-replay, unguarded)',
	);
});

test('STRUCTURAL: a create listener scheduling auto-localize is registered inside onLayoutReady', () => {
	const layoutReadyIdx = mainSrc.indexOf('this.app.workspace.onLayoutReady(() => {');
	const triggersStartIdx = mainSrc.indexOf('this.triggers.start();');
	const scheduleIdx = mainSrc.indexOf("this.autoLocalizeScheduler.schedule(file, 'create');", triggersStartIdx);
	// The first (eager, onload-time) `vault.on('create')` listener wires search indexing and
	// the file-open index — both already gate on their own readiness, so they stay eager. The
	// ribbon icon registration is the next statement after the onLayoutReady callback closes,
	// bounding the callback body for this check.
	const ribbonIdx = mainSrc.indexOf("this.addRibbonIcon('anvil'");

	assert.ok(layoutReadyIdx >= 0, 'onLayoutReady registration not found');
	assert.ok(triggersStartIdx >= 0, 'triggers.start() call not found');
	assert.ok(scheduleIdx >= 0, 'no auto-localize schedule call found after triggers.start()');
	assert.ok(ribbonIdx >= 0, 'ribbon icon registration not found (used to bound the onLayoutReady callback)');

	assert.ok(layoutReadyIdx < triggersStartIdx, 'triggers.start() must sit inside the onLayoutReady callback');
	assert.ok(triggersStartIdx < scheduleIdx, 'the auto-localize create listener must be registered after triggers.start(), following the same defense');
	assert.ok(scheduleIdx < ribbonIdx, 'the auto-localize create listener must be registered inside the onLayoutReady callback, not after it closes');
});

test('STRUCTURAL: the layout-ready auto-localize listener is its own registerEvent(vault.on(\'create\', ...)) call', () => {
	const triggersStartIdx = mainSrc.indexOf('this.triggers.start();');
	const afterTriggers = mainSrc.slice(triggersStartIdx, triggersStartIdx + 1500);
	assert.ok(
		/registerEvent\(this\.app\.vault\.on\('create',\s*\(file\)\s*=>\s*\{[\s\S]*?autoLocalizeScheduler\.schedule\(file, 'create'\);/.test(afterTriggers),
		'expected a registerEvent(vault.on(\'create\', ...)) call scheduling auto-localize shortly after triggers.start()',
	);
});
