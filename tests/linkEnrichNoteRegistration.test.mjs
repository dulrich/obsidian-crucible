import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// WP-J3: `link-enrich-note` must be registered as a chain-INTERNAL command (via
// internalCommands.ts's `register(...)` helper, aliasing both the manifest-prefixed and
// fixed `crucible:` ids, awaited, boolean-returning, optional-`targetFile`), not only as
// a palette command that routes through `executeCommandById` — same
// `xDiscoverPostLinksRegistration.test.mjs` shape, for the new note-level enrichment
// command. Also pins the full new-job-type registration checklist (JobType union,
// jobTypeConfig factory + dedupe key, main.ts orchestrator.register, DbJobBackend
// isWorkflowEnabled case + settings default, queueMonitor jobTitle, the two settings
// job-type lists) and that referencedVideoJobParams is consumed, never hand-rolled.

test('link-enrich-note is registered as a chain internal command via the register(...) helper', async () => {
	const src = await readFile('src/internalCommands.ts', 'utf8');
	assert.match(
		src,
		/register\('link-enrich-note',\s*async \([^)]*\)\s*=>\s*await enrichNoteLinksForActiveNote\(plugin, tf\)/,
		'must go through the shared register() helper (both id prefixes), not a bare plugin.chainManager.registerInternalCommand call',
	);
});

test('the internal handler defaults targetFile to the active note and returns a boolean', async () => {
	const src = await readFile('src/internalCommands.ts', 'utf8');
	assert.match(src, /export async function enrichNoteLinksForActiveNote\(plugin: CruciblePlugin, targetFile\?: TFile\): Promise<boolean>/);
	assert.match(src, /const file = targetFile \?\? plugin\.app\.workspace\.getActiveViewOfType\(MarkdownView\)\?\.file;/);
});

test('the internal handler enqueues note_link_enrich with the resolved file\'s path', async () => {
	const src = await readFile('src/internalCommands.ts', 'utf8');
	assert.match(src, /plugin\.orchestrator\.enqueue\('note_link_enrich', \{ targetPath: file\.path \}/);
});

test('the palette-facing command in commands.ts routes through executeInternalCommand, not executeCommandById', async () => {
	const src = await readFile('src/commands.ts', 'utf8');
	assert.match(
		src,
		/id: 'link-enrich-note'[\s\S]{0,200}run: \(\) => plugin\.chainManager\.executeInternalCommand\(`\$\{prefix\}:link-enrich-note`, \{\}\)/,
	);
});

// ── new-job-type registration checklist (traced from x_post_discover) ────────────

test('note_link_enrich is a member of the JobType union', async () => {
	const src = await readFile('src/orchestration/types.ts', 'utf8');
	assert.match(src, /\|\s*'note_link_enrich'/);
});

test('jobTypeConfig.ts exports noteLinkEnrichJobConfig, keyed note:<targetPath>, no services', async () => {
	const src = await readFile('src/orchestration/jobTypeConfig.ts', 'utf8');
	assert.match(src, /export function noteLinkEnrichJobConfig\(\): JobTypeConfig \{/);
	assert.match(
		src,
		/noteLinkEnrichJobConfig\(\): JobTypeConfig \{\s*return durableJobConfig\(\(p\) => \(typeof p\.targetPath === 'string' && p\.targetPath \? `note:\$\{p\.targetPath\}` : ''\)\);/,
	);
});

test('main.ts registers note_link_enrich with LinkNoteEnrichWorkflow and noteLinkEnrichJobConfig', async () => {
	const src = await readFile('src/main.ts', 'utf8');
	assert.match(
		src,
		/this\.orchestrator\.register\('note_link_enrich', new LinkNoteEnrichWorkflow\(\), noteLinkEnrichJobConfig\(\)\)/,
	);
});

test('DbJobBackend gates note_link_enrich on orchestrationNoteLinkEnrichEnabled', async () => {
	const src = await readFile('src/orchestration/DbJobBackend.ts', 'utf8');
	assert.match(src, /case 'note_link_enrich': return s\.orchestrationNoteLinkEnrichEnabled;/);
});

test('the setting defaults to false (off by default, like every other new-workflow toggle)', async () => {
	const src = await readFile('src/types.ts', 'utf8');
	assert.match(src, /orchestrationNoteLinkEnrichEnabled: boolean;/);
	assert.match(src, /orchestrationNoteLinkEnrichEnabled: false,/);
});

test('the settings UI exposes an enable toggle for note-level link enrichment', async () => {
	const src = await readFile('src/settings/sections/orchestrationWorkflows.ts', 'utf8');
	assert.match(src, /get: \(\) => s\.orchestrationNoteLinkEnrichEnabled === true,/);
	assert.match(src, /set: \(v\) => \{ s\.orchestrationNoteLinkEnrichEnabled = v; \},/);
});

test('queueMonitor.jobTitle names a note_link_enrich row by its target path', async () => {
	const src = await readFile('src/ingestion/sections/queueMonitor.ts', 'utf8');
	assert.match(
		src,
		/case 'note_link_enrich': return typeof job\.params\?\.targetPath === 'string' \? `Link enrich: \$\{job\.params\.targetPath\.split\('\/'\)\.pop\(\)\}` : 'Link enrich note';/,
	);
});

test('note_link_enrich is listed among the routine-notice job types', async () => {
	const src = await readFile('src/settings/sections/orchestrationQueue.ts', 'utf8');
	assert.match(src, /'link_scan',\s*\n\s*'note_link_enrich',/);
});

test('note_link_enrich is offered as a trigger-action workflow (option only — no founding trigger)', async () => {
	const src = await readFile('src/settings/sections/triggers.ts', 'utf8');
	assert.match(src, /note_link_enrich: 'Link enrich note',/);
});

// ── the workflow itself never hand-rolls referenced-video params ─────────────────

test('LinkNoteEnrichWorkflow enqueues youtube_metadata_fetch via referencedVideoJobParams, not a hand-rolled object literal', async () => {
	const src = await readFile('src/orchestration/workflows/LinkNoteEnrichWorkflow.ts', 'utf8');
	assert.match(src, /import \{ referencedVideoJobParams \} from '\.\.\/jobTypeConfig';/);
	assert.match(
		src,
		/plugin\.orchestrator\.enqueue\(\s*'youtube_metadata_fetch',\s*referencedVideoJobParams\(targetPath, videoId\),/,
	);
});

test('LinkNoteEnrichWorkflow enqueues x_post_discover with only {targetPath} — no second X extraction path', async () => {
	const src = await readFile('src/orchestration/workflows/LinkNoteEnrichWorkflow.ts', 'utf8');
	assert.match(
		src,
		/plugin\.orchestrator\.enqueue\(\s*'x_post_discover',\s*\{ targetPath \},/,
	);
	assert.doesNotMatch(src, /extractXStatusFromUrl|canonicalXStatusUrl/, 'must not re-implement X status extraction locally');
});

// ── linkRegistry.ts lift: LinkScanWorkflow no longer owns the per-URL writer ──────

test('LinkScanWorkflow imports the shared registry writer instead of a private applyToRegistry method', async () => {
	const src = await readFile('src/orchestration/workflows/LinkScanWorkflow.ts', 'utf8');
	assert.match(src, /import \{ AggregateEntry, applyLinkToRegistry, isExcluded, normalizeExclusions, wikilinkFor \} from '\.\.\/utils\/linkRegistry';/);
	assert.doesNotMatch(src, /private async applyToRegistry/);
	assert.match(src, /await applyLinkToRegistry\(plugin, registryRoot, today, entry\)/);
});

test('LinkNoteEnrichWorkflow consumes the same shared registry writer', async () => {
	const src = await readFile('src/orchestration/workflows/LinkNoteEnrichWorkflow.ts', 'utf8');
	assert.match(src, /import \{ AggregateEntry, applyLinkToRegistry, isExcluded, wikilinkFor \} from '\.\.\/utils\/linkRegistry';/);
	assert.match(src, /await applyLinkToRegistry\(plugin, registryRoot, today, entry\)/);
});
