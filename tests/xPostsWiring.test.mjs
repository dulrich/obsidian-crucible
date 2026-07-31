// WP-XM4: structural (source-text) pins for the xPosts dashboard wiring — the "4
// mechanical edits + signature key" the plan calls out. Standing up enough of a
// stub to bundle and execute IngestionDashboardUI (real 'obsidian' App/TFile
// surface + the full CruciblePlugin type) is disproportionate to these additive
// wiring edits, same reasoning tests/metadataFetchStatus.test.mjs's STRUCTURAL
// block gives for the identical class.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dashboardSrc = readFileSync('src/ingestionDashboard.ts', 'utf8');
const typesSrc = readFileSync('src/ingestion/render/types.ts', 'utf8');

test('STRUCTURAL: SectionId union includes xPosts', () => {
	assert.match(typesSrc, /export type SectionId =[\s\S]*?\|\s*'xPosts';/, "SectionId must union in 'xPosts'");
});

test('STRUCTURAL: XPostRow carries the merge fields the data/render layer needs', () => {
	assert.match(typesSrc, /export interface XPostRow \{[\s\S]*?statusId: string;[\s\S]*?\}/);
	assert.match(typesSrc, /state: 'materialized' \| 'unavailable' \| 'pending';/);
});

test('STRUCTURAL: SCAN_SECTIONS includes xPosts (it walks the vault)', () => {
	const scanBlock = dashboardSrc.match(/SCAN_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>\(\[([\s\S]*?)\]\);/);
	assert.ok(scanBlock, 'SCAN_SECTIONS block must be found');
	assert.match(scanBlock[1], /'xPosts'/);
});

test("STRUCTURAL: route() marks xPosts dirty from the orchestrationXMetadataRoot prefix branch", () => {
	assert.match(
		dashboardSrc,
		/const xRoot = xMetadataRoot\(this\.plugin\);\s*\n\s*if \(xRoot && path\.startsWith\(`\$\{xRoot\}\/`\)\) this\.markDirty\('xPosts'\);/,
		'route() must have a dedicated path-prefix branch for the X metadata root, mirroring the YT metadata root exemplar',
	);
});

test('STRUCTURAL: the structural (create/delete/rename) branch also marks xPosts dirty, covering registry-record creation', () => {
	const structuralBlock = dashboardSrc.match(/if \(reason === 'structural'\) \{([\s\S]*?)return;\s*\}/);
	assert.ok(structuralBlock, "the reason === 'structural' block must be found");
	assert.match(structuralBlock[1], /this\.markDirty\('xPosts'\);/);
});

test("STRUCTURAL: the frontmatter-signature key list includes fm['x-metadata'] and fm['x-status-id']", () => {
	const sigLine = dashboardSrc.match(/const fmSig = JSON\.stringify\(\[([\s\S]*?)\]\);/);
	assert.ok(sigLine, 'the fmSig line must be found');
	assert.match(sigLine[1], /fm\['x-metadata'\]/);
	assert.match(sigLine[1], /fm\['x-status-id'\]/);
});

test('STRUCTURAL: an fm signature change also marks xPosts dirty (not just the YT/blog lists)', () => {
	const fmDiffBlock = dashboardSrc.match(/if \(prev && prev\.fm !== next\.fm\) \{([\s\S]*?)\}/);
	assert.ok(fmDiffBlock, 'the prev.fm !== next.fm block must be found');
	assert.match(fmDiffBlock[1], /this\.markDirty\('xPosts'\);/);
});

test("STRUCTURAL: the ingestion event bus listener for 'x-metadata-enriched' marks xPosts dirty", () => {
	assert.match(
		dashboardSrc,
		/bus\.on\('x-metadata-enriched', \(\) => this\.markDirty\('xPosts'\)\)/,
	);
});

test('STRUCTURAL: mount() builds the xPosts section with a Backfill-from-registry heading button', () => {
	assert.match(dashboardSrc, /this\.buildSection\(\s*\n\s*'xPosts',/);
	assert.match(dashboardSrc, /this\.xPosts\.renderBackfillButton\(heading\)/);
});

test('STRUCTURAL: refreshAll() includes xPosts', () => {
	const idsBlock = dashboardSrc.match(/private async refreshAll\(\): Promise<void> \{[\s\S]*?const ids: SectionId\[\] = \[([\s\S]*?)\];/);
	assert.ok(idsBlock, 'refreshAll ids array must be found');
	assert.match(idsBlock[1], /'xPosts'/);
});

test('STRUCTURAL: renderSection() dispatches xPosts to xPosts.render', () => {
	assert.match(dashboardSrc, /case 'xPosts': return this\.xPosts\.render\(body, ctx\);/);
});

test('STRUCTURAL: the xPosts section factory is constructed in the constructor', () => {
	assert.match(dashboardSrc, /this\.xPosts = createXPostsSection\(this\.host\);/);
});
