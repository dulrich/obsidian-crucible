// WP-XM4: structural (source-text) pins for the two remaining mechanical edits —
// the Queue Monitor job-title case and the Ingestion settings panel's two new
// fields. Same STRUCTURAL-over-DOM-bundle reasoning as
// tests/xPostsWiring.test.mjs: these are additive one-liners/one-Setting-block
// edits, not new logic worth standing up a full render harness for.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const queueMonitorSrc = readFileSync('src/ingestion/sections/queueMonitor.ts', 'utf8');
const settingsSrc = readFileSync('src/settings/sections/orchestrationIngestion.ts', 'utf8');

test("STRUCTURAL: queueMonitor's jobTitle switch has a case for x_metadata_fetch", () => {
	assert.match(queueMonitorSrc, /case 'x_metadata_fetch': return xMetadataTitle\(job\);/);
});

test('STRUCTURAL: xMetadataTitle names the job by statusId, falling back to the job id', () => {
	const fn = queueMonitorSrc.match(/function xMetadataTitle\(job: OrchestrationJob\): string \{([\s\S]*?)\n\}/);
	assert.ok(fn, 'xMetadataTitle must be found');
	assert.match(fn[1], /job\.params\?\.statusId/);
	assert.match(fn[1], /job\.id/);
});

test('STRUCTURAL: the Ingestion settings panel binds an X metadata folder field to orchestrationXMetadataRoot with a FolderSuggest', () => {
	const block = settingsSrc.match(/bindSearch\(ingestionGroup, \{\s*\n\s*name: 'X metadata folder',[\s\S]*?\}, save\);/);
	assert.ok(block, "the 'X metadata folder' bindSearch block must be found");
	assert.match(block[0], /get: \(\) => s\.orchestrationXMetadataRoot/);
	assert.match(block[0], /new FolderSuggest\(tab\.app, el\)/);
});

test('STRUCTURAL: the Ingestion settings panel binds an auto-discover toggle to ingestionXAutoDiscoverEnabled', () => {
	const block = settingsSrc.match(/bindToggle\(ingestionGroup, \{\s*\n\s*name: 'Auto-discover X links in clipper inbox',[\s\S]*?\}, save\);/);
	assert.ok(block, 'the auto-discover bindToggle block must be found');
	assert.match(block[0], /get: \(\) => s\.ingestionXAutoDiscoverEnabled === true/);
	assert.match(block[0], /set: \(v\) => \{ s\.ingestionXAutoDiscoverEnabled = v; \}/);
});

test('STRUCTURAL: the auto-discover toggle copy explains the backfill-covers-only-scanned-records caveat', () => {
	const block = settingsSrc.match(/bindToggle\(ingestionGroup, \{\s*\n\s*name: 'Auto-discover X links in clipper inbox',[\s\S]*?\}, save\);/);
	assert.ok(block);
	assert.match(block[0], /link scan/i);
	assert.match(block[0], /x_post_discover/);
});
