import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

// Covers WP-DP5 (icon-language consistency): the fleet law is one concept = one icon.
// `copy` is freed exclusively for copy-to-clipboard/copy-path once every "Duplicate"
// affordance moves to `copy-plus` — this is a cheap source-text sweep (not an AST walk,
// same "cheap honest check" idiom as tests/destructiveActionsWp4Retrofit.test.mjs), not
// a heavy harness for glyph names.

const SETTINGS_SECTIONS_DIR = path.join(process.cwd(), 'src', 'settings', 'sections');

async function collectTsFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...await collectTsFiles(full));
		} else if (entry.isFile() && entry.name.endsWith('.ts')) {
			files.push(full);
		}
	}
	return files;
}

test('no setIcon(\'copy\') call site in src/settings/sections carries a Duplicate tooltip', async () => {
	const files = await collectTsFiles(SETTINGS_SECTIONS_DIR);
	const offenders = [];
	for (const file of files) {
		const content = await readFile(file, 'utf8');
		for (const line of content.split('\n')) {
			if (line.includes("setIcon('copy')") && line.includes('Duplicate')) {
				offenders.push(`${path.relative(process.cwd(), file)}: ${line.trim()}`);
			}
		}
	}
	assert.deepEqual(offenders, [], 'Duplicate affordances must use copy-plus, not copy (copy is reserved for copy-to-clipboard/copy-path)');
});

test('every Duplicate affordance in src/settings/sections uses copy-plus', async () => {
	const files = await collectTsFiles(SETTINGS_SECTIONS_DIR);
	let duplicateSites = 0;
	for (const file of files) {
		const content = await readFile(file, 'utf8');
		for (const line of content.split('\n')) {
			if (!line.includes('Duplicate')) continue;
			if (!line.includes('setIcon(')) continue;
			duplicateSites++;
			assert.ok(
				line.includes("setIcon('copy-plus')"),
				`${path.relative(process.cwd(), file)}: expected copy-plus on a Duplicate call site — got: ${line.trim()}`,
			);
		}
	}
	assert.ok(duplicateSites >= 4, 'expected at least the four known Duplicate call sites (captures, chains, triggers, agents)');
});

test('src/toc.ts collapse chevron pair matches the fleet convention (collapsed = chevron-right, expanded = chevron-down)', async () => {
	const content = await readFile(path.join(process.cwd(), 'src', 'toc.ts'), 'utf8');
	assert.ok(!content.includes('chevron-up'), 'toc.ts must not use chevron-up — the fleet pair is chevron-right/chevron-down');
	assert.ok(
		content.includes("setIcon(chevron, this.isCollapsed ? 'chevron-right' : 'chevron-down')"),
		'toc.ts collapse chevron must read collapsed -> chevron-right, expanded -> chevron-down',
	);
});
