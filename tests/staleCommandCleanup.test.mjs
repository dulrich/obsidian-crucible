// Structural guard: WP-G5 (stale-command cleanup, live-validation-remediation Plan G).
//
// `clearCommandRegistryGroup` used to prune `commandRegistry`/`commandRunners` but never
// unregistered from Obsidian's own `app.commands` registry, so a deleted chain/capture/
// shortcut/agent lingered in the NATIVE command palette (not just Crucible's) as a silent
// no-op (`executeCrucibleCommand` returns null once `commandRunners` no longer has the id)
// until the next reload. The fix mirrors the cleanup `registerChains` already does for its
// own chain-internal ids: `clearCommandRegistryGroup` now also calls
// `this.removeCommand(entry.id)` for every pruned entry — `Plugin.removeCommand` is typed on
// the installed obsidian.d.ts (since 1.7.2), feature-detected because manifest.json's
// `minAppVersion` predates that release. These assertions pin that shape as source text, in
// the style of `tests/autoLocalizeCreateReplayGuard.test.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSrc = readFileSync('src/main.ts', 'utf8');
const captureSrc = readFileSync('src/captureCommands.ts', 'utf8');

/** Crude brace-matched body extraction for a `name(...): ReturnType {` style signature. */
function extractFunctionBody(src, signature) {
	const start = src.indexOf(signature);
	assert.ok(start >= 0, `expected to find "${signature}" in the source`);
	const braceStart = src.indexOf('{', start);
	assert.ok(braceStart >= 0, `expected an opening brace after "${signature}"`);
	let depth = 0;
	for (let i = braceStart; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) return src.slice(braceStart, i + 1);
		}
	}
	throw new Error('unterminated function body — brace matching failed');
}

test('STRUCTURAL: clearCommandRegistryGroup calls the native removeCommand API for each pruned entry', () => {
	const body = extractFunctionBody(mainSrc, 'clearCommandRegistryGroup(group: CrucibleCommandGroup): void {');
	assert.ok(
		/this\.removeCommand\(\s*entry\.id\s*\)/.test(body),
		'clearCommandRegistryGroup must call this.removeCommand(entry.id) so a pruned command '
		+ "leaves the native app.commands registry immediately, not just Crucible's own registry "
		+ '(commandRegistry/commandRunners)',
	);
});

test('STRUCTURAL: the removeCommand call is feature-detected, not called unconditionally', () => {
	const body = extractFunctionBody(mainSrc, 'clearCommandRegistryGroup(group: CrucibleCommandGroup): void {');
	assert.ok(
		/typeof this\.removeCommand === 'function'/.test(body),
		"expected a typeof-function guard before calling this.removeCommand, since manifest.json's "
		+ 'minAppVersion (0.15.0) predates Obsidian 1.7.2, where Plugin.removeCommand was added',
	);
});

test('STRUCTURAL: every dynamic re-register flow still routes stale-command cleanup through clearCommandRegistryGroup', () => {
	// clearCommandRegistryGroup is the single chokepoint — fixing it there covers Agents,
	// Shortcuts, Chains (all in main.ts) and Captures (captureCommands.ts) without touching
	// each call site.
	assert.ok(mainSrc.includes("this.clearCommandRegistryGroup('Agents');"), 'Agents re-register must clear its group first');
	assert.ok(mainSrc.includes("this.clearCommandRegistryGroup('Shortcuts');"), 'Shortcuts re-register must clear its group first');
	assert.ok(mainSrc.includes("this.clearCommandRegistryGroup('Chains');"), 'Chains re-register must clear its group first');
	assert.ok(captureSrc.includes("plugin.clearCommandRegistryGroup('Captures');"), 'Captures re-register must clear its group first');
});

test('STRUCTURAL: registerChains still cleans up its own chain-internal ids ahead of the native-command cleanup', () => {
	// The ordering discipline this WP mirrors: registerChains already drops stale
	// chain-internal registrations (registeredChainInternalIds) before re-adding chains.
	// clearCommandRegistryGroup('Chains') runs first inside registerChains(), so the native
	// removeCommand cleanup and the chain-internal cleanup both land before any command in
	// the group is re-added.
	const body = extractFunctionBody(mainSrc, 'registerChains() {');
	const clearIdx = body.indexOf("this.clearCommandRegistryGroup('Chains');");
	const internalCleanupIdx = body.indexOf('this.registeredChainInternalIds.clear();');
	const forEachIdx = body.indexOf('this.settings.chains.forEach(');
	assert.ok(clearIdx >= 0, 'expected clearCommandRegistryGroup(\'Chains\') inside registerChains');
	assert.ok(internalCleanupIdx >= 0, 'expected registeredChainInternalIds.clear() inside registerChains');
	assert.ok(forEachIdx >= 0, 'expected the chains.forEach re-registration loop inside registerChains');
	assert.ok(clearIdx < forEachIdx, 'native-command cleanup must run before chains are re-added');
	assert.ok(internalCleanupIdx < forEachIdx, 'chain-internal cleanup must run before chains are re-added');
});
