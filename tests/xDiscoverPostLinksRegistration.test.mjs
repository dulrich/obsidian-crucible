import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// WP-XM3: `x-discover-post-links` must be registered as a chain-INTERNAL command
// (via internalCommands.ts's `register(...)` helper, which aliases both the
// manifest-prefixed and fixed `crucible:` ids and takes an awaited, boolean-
// returning, optional-`targetFile` handler), not only as a palette command that
// routes through `executeCommandById` — the src/AGENTS.md chain-step quirk: a
// note-related chain step that isn't an internal command runs fire-and-forget,
// outside the chain's note lock, and its effect can silently vanish. Source-text
// pin, not a bundle: this is about the registration call shape, not runtime
// behavior (already covered by the workflow/trigger test suites).

test('x-discover-post-links is registered as a chain internal command via the register(...) helper', async () => {
	const src = await readFile('src/internalCommands.ts', 'utf8');
	assert.match(
		src,
		/register\('x-discover-post-links',\s*async \([^)]*\)\s*=>\s*await discoverXPostLinksForActiveNote\(plugin, tf\)/,
		'must go through the shared register() helper (both id prefixes), not a bare plugin.chainManager.registerInternalCommand call',
	);
});

test('the internal handler defaults targetFile to the active note and returns a boolean', async () => {
	const src = await readFile('src/internalCommands.ts', 'utf8');
	assert.match(src, /export async function discoverXPostLinksForActiveNote\(plugin: CruciblePlugin, targetFile\?: TFile\): Promise<boolean>/);
	assert.match(src, /const file = targetFile \?\? plugin\.app\.workspace\.getActiveViewOfType\(MarkdownView\)\?\.file;/);
});

test('the internal handler enqueues x_post_discover with the resolved file\'s path', async () => {
	const src = await readFile('src/internalCommands.ts', 'utf8');
	assert.match(src, /plugin\.orchestrator\.enqueue\('x_post_discover', \{ targetPath: file\.path \}/);
});

test('the palette-facing command in commands.ts routes through executeInternalCommand, not executeCommandById', async () => {
	const src = await readFile('src/commands.ts', 'utf8');
	assert.match(
		src,
		/id: 'x-discover-post-links'[\s\S]{0,200}run: \(\) => plugin\.chainManager\.executeInternalCommand\(`\$\{prefix\}:x-discover-post-links`, \{\}\)/,
	);
});

test('the backfill command enqueues x_metadata_backfill directly (no internal-command indirection needed — it acts on no target note)', async () => {
	const src = await readFile('src/commands.ts', 'utf8');
	assert.match(
		src,
		/id: 'orchestrator-enqueue-x-backfill'[\s\S]{0,200}run: \(\) => plugin\.orchestrator\.enqueue\('x_metadata_backfill', \{\}, \{ priority: 'high', lane: 'user' \}\)/,
	);
});
