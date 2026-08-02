// WP-SA2: behavioral coverage for src/search/audit.ts — the pure compute behind
// `Search: audit index` / `Search: reconcile index` (src/commands.ts). No `obsidian` import
// anywhere in its dependency graph (it only pulls in the also-dependency-free src/search/types.ts),
// so it bundles and runs directly, the same way tests/providerRefs.test.mjs treats its leaf modules.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-audit-tests');
const outfile = path.join(outdir, 'audit.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/audit.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const {
	computeSearchAudit,
	identifyAuditCandidates,
	isCleanAudit,
	isReconcileTargetClean,
	formatAuditReport,
	formatReconcileNothingToDoSummary,
	formatReconcileCompletedSummary,
} = await import(pathToFileURL(outfile));

function indexedRow(overrides = {}) {
	return { path: 'a.md', mtime: 100, chunkCount: 1, embeddedCount: 1, ...overrides };
}

test('a healthy vault (indexed paths match the vault, no image gaps) reports clean on every axis', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'a.md', mtime: 100 }, { path: 'b.md', mtime: 50 }],
		indexedPaths: [indexedRow({ path: 'a.md', mtime: 100 }), indexedRow({ path: 'b.md', mtime: 50 })],
		images: [{ md5: 'img1', status: 'described', path: 'images/img1.png' }],
		semanticEnabled: true,
	});
	assert.deepEqual(result.missing, []);
	assert.deepEqual(result.orphans, []);
	assert.deepEqual(result.stale, []);
	assert.deepEqual(result.embeddingGaps, []);
	assert.deepEqual(result.imageCoverage, {
		referenced: 1, described: 1, failed: 0, pending: 0, pendingPaths: [], failedPaths: [],
	});
	assert.equal(isCleanAudit(result), true);
});

test('a vault file with no indexed row at all is missing', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'new.md', mtime: 100 }],
		indexedPaths: [],
		images: [],
		semanticEnabled: true,
	});
	assert.deepEqual(result.missing, ['new.md']);
	assert.equal(isCleanAudit(result), false);
});

test('an indexed path with no matching vault file is an orphan, not missing or stale', () => {
	const result = computeSearchAudit({
		vaultFiles: [],
		indexedPaths: [indexedRow({ path: 'deleted.md' })],
		images: [],
		semanticEnabled: true,
	});
	assert.deepEqual(result.orphans, ['deleted.md']);
	assert.deepEqual(result.missing, []);
	assert.deepEqual(result.stale, []);
});

test('a vault file whose mtime is newer than its indexed row is stale, not missing', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'edited.md', mtime: 500 }],
		indexedPaths: [indexedRow({ path: 'edited.md', mtime: 100 })],
		images: [],
		semanticEnabled: true,
	});
	assert.deepEqual(result.stale, ['edited.md']);
	assert.deepEqual(result.missing, []);
});

test('a vault file whose mtime exactly matches (or is older than) its indexed row is not stale', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'same.md', mtime: 100 }, { path: 'older.md', mtime: 40 }],
		indexedPaths: [indexedRow({ path: 'same.md', mtime: 100 }), indexedRow({ path: 'older.md', mtime: 90 })],
		images: [],
		semanticEnabled: true,
	});
	assert.deepEqual(result.stale, []);
});

test('embedding gaps: an indexed path with fewer embedded chunks than chunks, semantic enabled', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'partial.md', mtime: 10 }],
		indexedPaths: [indexedRow({ path: 'partial.md', mtime: 10, chunkCount: 4, embeddedCount: 2 })],
		images: [],
		semanticEnabled: true,
	});
	assert.deepEqual(result.embeddingGaps, ['partial.md']);
});

test('embedding gaps are suppressed entirely when semantic indexing is off, even with real coverage gaps in the data', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'fts-only.md', mtime: 10 }],
		indexedPaths: [indexedRow({ path: 'fts-only.md', mtime: 10, chunkCount: 4, embeddedCount: 0 })],
		images: [],
		semanticEnabled: false,
	});
	assert.deepEqual(result.embeddingGaps, []);
	assert.equal(isCleanAudit(result), true);
});

test('a path with zero chunks is never an embedding gap regardless of embeddedCount', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'empty.md', mtime: 10 }],
		indexedPaths: [indexedRow({ path: 'empty.md', mtime: 10, chunkCount: 0, embeddedCount: 0 })],
		images: [],
		semanticEnabled: true,
	});
	assert.deepEqual(result.embeddingGaps, []);
});

test('image coverage: described, failed, and pending are counted independently, and totals include all three', () => {
	const result = computeSearchAudit({
		vaultFiles: [],
		indexedPaths: [],
		images: [
			{ md5: 'd1', status: 'described', path: 'images/d1.png' },
			{ md5: 'd2', status: 'described', path: 'images/d2.png' },
			{ md5: 'f1', status: 'failed', path: 'images/f1.png' },
			{ md5: 'p1', status: 'pending', path: 'images/p1.png' },
			{ md5: 'p2', status: 'pending', path: 'images/p2.png' },
			{ md5: 'p3', status: 'pending', path: 'images/p3.png' },
		],
		semanticEnabled: true,
	});
	assert.deepEqual(result.imageCoverage, {
		referenced: 6,
		described: 2,
		failed: 1,
		pending: 3,
		pendingPaths: ['images/p1.png', 'images/p2.png', 'images/p3.png'],
		failedPaths: ['images/f1.png'],
	});
	assert.equal(isCleanAudit(result), false, 'failed and pending images both break the clean fast path');
});

// WP-I1: pendingPaths/failedPaths — sorted, independent of input order, and their lengths must
// stay derived-identical to the pending/failed counts (never a second source of truth).

test('imageCoverage.pendingPaths/failedPaths are sorted independent of input order, and their lengths match pending/failed', () => {
	const result = computeSearchAudit({
		vaultFiles: [],
		indexedPaths: [],
		images: [
			{ md5: 'p-z', status: 'pending', path: 'images/z-pending.png' },
			{ md5: 'p-a', status: 'pending', path: 'images/a-pending.png' },
			{ md5: 'f-z', status: 'failed', path: 'images/z-failed.png' },
			{ md5: 'f-a', status: 'failed', path: 'images/a-failed.png' },
			{ md5: 'd1', status: 'described', path: 'images/described.png' },
		],
		semanticEnabled: true,
	});
	assert.deepEqual(result.imageCoverage.pendingPaths, ['images/a-pending.png', 'images/z-pending.png']);
	assert.deepEqual(result.imageCoverage.failedPaths, ['images/a-failed.png', 'images/z-failed.png']);
	assert.equal(result.imageCoverage.pendingPaths.length, result.imageCoverage.pending);
	assert.equal(result.imageCoverage.failedPaths.length, result.imageCoverage.failed);
	// The described image contributes to neither path list.
	assert.ok(!result.imageCoverage.pendingPaths.includes('images/described.png'));
	assert.ok(!result.imageCoverage.failedPaths.includes('images/described.png'));
});

test('formatAuditReport output is unaffected by imageCoverage.pendingPaths/failedPaths — the report stays byte-identical', () => {
	const result = computeSearchAudit({
		vaultFiles: [],
		indexedPaths: [],
		images: [
			{ md5: 'p1', status: 'pending', path: 'images/p1.png' },
			{ md5: 'f1', status: 'failed', path: 'images/f1.png' },
		],
		semanticEnabled: true,
	});
	const report = formatAuditReport(result, '2026-08-01T00:00:00.000Z');
	assert.match(report, /Image coverage: 0\/2 described, 1 failed, 1 pending/);
	assert.doesNotMatch(report, /images\/p1\.png/, 'the report never lists raw image paths');
	assert.doesNotMatch(report, /images\/f1\.png/, 'the report never lists raw image paths');
});

test('isCleanAudit is false when only image coverage has a failed/pending count, even with empty path lists', () => {
	const result = computeSearchAudit({
		vaultFiles: [],
		indexedPaths: [],
		images: [{ md5: 'f1', status: 'failed', path: 'images/f1.png' }],
		semanticEnabled: true,
	});
	assert.equal(isCleanAudit(result), false);
});

test('a fully empty vault (no files, no index, no images) is clean', () => {
	const result = computeSearchAudit({ vaultFiles: [], indexedPaths: [], images: [], semanticEnabled: true });
	assert.equal(isCleanAudit(result), true);
	assert.deepEqual(result.imageCoverage, {
		referenced: 0, described: 0, failed: 0, pending: 0, pendingPaths: [], failedPaths: [],
	});
});

test('missing/orphans/stale/embeddingGaps are each returned sorted, independent of input order', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'z-missing.md', mtime: 1 }, { path: 'a-missing.md', mtime: 1 }],
		indexedPaths: [indexedRow({ path: 'z-orphan.md' }), indexedRow({ path: 'a-orphan.md' })],
		images: [],
		semanticEnabled: true,
	});
	assert.deepEqual(result.missing, ['a-missing.md', 'z-missing.md']);
	assert.deepEqual(result.orphans, ['a-orphan.md', 'z-orphan.md']);
});

test('a path can be simultaneously an embedding gap check and unaffected by unrelated stale/orphan logic', () => {
	// A path present in both the vault and the index, not stale, but under-embedded: only
	// embeddingGaps should fire for it.
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'mixed.md', mtime: 10 }],
		indexedPaths: [indexedRow({ path: 'mixed.md', mtime: 10, chunkCount: 3, embeddedCount: 1 })],
		images: [],
		semanticEnabled: true,
	});
	assert.deepEqual(result.missing, []);
	assert.deepEqual(result.orphans, []);
	assert.deepEqual(result.stale, []);
	assert.deepEqual(result.embeddingGaps, ['mixed.md']);
});

test('formatAuditReport renders the summary counts and per-category path lists, "(none)" for empty categories', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'missing.md', mtime: 1 }],
		indexedPaths: [indexedRow({ path: 'orphan.md' })],
		images: [{ md5: 'p1', status: 'pending', path: 'images/p1.png' }, { md5: 'f1', status: 'failed', path: 'images/f1.png' }],
		semanticEnabled: true,
	});
	const report = formatAuditReport(result, '2026-08-01T00:00:00.000Z');
	assert.match(report, /^# Search index audit — 2026-08-01T00:00:00\.000Z/);
	assert.match(report, /Missing \(in vault, not indexed\): 1/);
	assert.match(report, /Orphans \(indexed, not in vault\): 1/);
	assert.match(report, /Image coverage: 0\/2 described, 1 failed, 1 pending/);
	assert.match(report, /## Missing\n- missing\.md/);
	assert.match(report, /## Orphans\n- orphan\.md/);
	assert.match(report, /## Stale\n\(none\)/);
});

test('formatAuditReport is a pure function of its inputs — same result, same output, no hidden clock read', () => {
	const result = computeSearchAudit({ vaultFiles: [], indexedPaths: [], images: [], semanticEnabled: true });
	const a = formatAuditReport(result, 'fixed-timestamp');
	const b = formatAuditReport(result, 'fixed-timestamp');
	assert.equal(a, b);
});

// WP-F3: formatAuditReport names the exact repair command per non-zero class.

test('formatAuditReport has no "## Repair" section on a fully clean audit', () => {
	const result = computeSearchAudit({ vaultFiles: [], indexedPaths: [], images: [], semanticEnabled: true });
	const report = formatAuditReport(result, '2026-08-01T00:00:00.000Z');
	assert.doesNotMatch(report, /## Repair/);
});

test('formatAuditReport names "Search: reconcile index" for missing, stale, and orphans', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'missing.md', mtime: 1 }, { path: 'stale.md', mtime: 500 }],
		indexedPaths: [indexedRow({ path: 'orphan.md' }), indexedRow({ path: 'stale.md', mtime: 100 })],
		images: [],
		semanticEnabled: true,
	});
	const report = formatAuditReport(result, '2026-08-01T00:00:00.000Z');
	assert.match(report, /## Repair/);
	assert.match(report, /- Missing: Run "Search: reconcile index"/);
	assert.match(report, /- Stale: Run "Search: reconcile index"/);
	assert.match(report, /- Orphans: Run "Search: reconcile index"/);
	assert.match(report, /Re-run "Search: audit index" after repairing/);
});

test('formatAuditReport names "Search: embed missing vectors" for embedding gaps only', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'partial.md', mtime: 10 }],
		indexedPaths: [indexedRow({ path: 'partial.md', mtime: 10, chunkCount: 4, embeddedCount: 2 })],
		images: [],
		semanticEnabled: true,
	});
	const report = formatAuditReport(result, '2026-08-01T00:00:00.000Z');
	assert.match(report, /## Repair/);
	assert.match(report, /- Embedding gaps: Run "Search: embed missing vectors"/);
	assert.doesNotMatch(report, /- Missing:/);
	assert.doesNotMatch(report, /- Orphans:/);
});

test('formatAuditReport names describe/retry commands for pending and failed image coverage independently', () => {
	const pendingOnly = formatAuditReport(computeSearchAudit({
		vaultFiles: [], indexedPaths: [], images: [{ md5: 'p1', status: 'pending', path: 'images/p1.png' }], semanticEnabled: true,
	}), 'ts');
	assert.match(pendingOnly, /- Image coverage \(pending\): Run "Search: describe vault images"/);
	assert.doesNotMatch(pendingOnly, /retry failed image descriptions/);

	const failedOnly = formatAuditReport(computeSearchAudit({
		vaultFiles: [], indexedPaths: [], images: [{ md5: 'f1', status: 'failed', path: 'images/f1.png' }], semanticEnabled: true,
	}), 'ts');
	assert.match(failedOnly, /- Image coverage \(failed\): Run "Search: retry failed image descriptions"/);
	assert.doesNotMatch(failedOnly, /describe vault images"/);
});

// WP-F3: `isReconcileTargetClean` — narrower than `isCleanAudit`, ignores embeddingGaps/imageCoverage.

test('isReconcileTargetClean is true when missing/stale/orphans are empty, even with embedding gaps or image gaps', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'partial.md', mtime: 10 }],
		indexedPaths: [indexedRow({ path: 'partial.md', mtime: 10, chunkCount: 4, embeddedCount: 2 })],
		images: [{ md5: 'p1', status: 'pending', path: 'images/p1.png' }, { md5: 'f1', status: 'failed', path: 'images/f1.png' }],
		semanticEnabled: true,
	});
	assert.equal(isReconcileTargetClean(result), true);
	assert.equal(isCleanAudit(result), false, 'isCleanAudit must still flag this dirty — that asymmetry is the point');
});

test('isReconcileTargetClean is false when missing, stale, or orphans is non-empty', () => {
	assert.equal(isReconcileTargetClean(computeSearchAudit({
		vaultFiles: [{ path: 'new.md', mtime: 1 }], indexedPaths: [], images: [], semanticEnabled: true,
	})), false);
	assert.equal(isReconcileTargetClean(computeSearchAudit({
		vaultFiles: [], indexedPaths: [indexedRow({ path: 'orphan.md' })], images: [], semanticEnabled: true,
	})), false);
	assert.equal(isReconcileTargetClean(computeSearchAudit({
		vaultFiles: [{ path: 'edited.md', mtime: 500 }],
		indexedPaths: [indexedRow({ path: 'edited.md', mtime: 100 })],
		images: [], semanticEnabled: true,
	})), false);
});

// WP-F3: the reconcile Notice-text pure helpers.

test('formatReconcileNothingToDoSummary reads as fully clean when every axis (including embedding/image) is zero', () => {
	const result = computeSearchAudit({ vaultFiles: [], indexedPaths: [], images: [], semanticEnabled: true });
	assert.equal(formatReconcileNothingToDoSummary(result), 'Search: reconcile index — already matches the vault. Nothing to do.');
});

test('formatReconcileNothingToDoSummary names embedding-gap and image-coverage commands instead of claiming full health', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'partial.md', mtime: 10 }],
		indexedPaths: [indexedRow({ path: 'partial.md', mtime: 10, chunkCount: 4, embeddedCount: 2 })],
		images: [{ md5: 'p1', status: 'pending', path: 'images/p1.png' }],
		semanticEnabled: true,
	});
	const summary = formatReconcileNothingToDoSummary(result);
	assert.doesNotMatch(summary, /already matches the vault\. Nothing to do\./);
	assert.match(summary, /nothing to enqueue/i);
	assert.match(summary, /embedding gap/);
	assert.match(summary, /Search: embed missing vectors/);
	assert.match(summary, /Search: describe vault images/);
});

test('formatReconcileCompletedSummary reports new-vs-deduped counts for upserts and deletes separately', () => {
	const result = computeSearchAudit({ vaultFiles: [], indexedPaths: [], images: [], semanticEnabled: true });
	const summary = formatReconcileCompletedSummary(result, {
		upserts: { newCount: 3, dedupedCount: 1 },
		deletes: { newCount: 0, dedupedCount: 2 },
		orphansDeclined: false,
	});
	assert.match(summary, /3 upserts newly enqueued \(\+1 already queued\)/);
	assert.match(summary, /0 deletes newly enqueued \(\+2 already queued\)/);
	assert.match(summary, /Queue Monitor/);
	assert.match(summary, /"done" status filter/);
});

test('formatReconcileCompletedSummary omits a segment entirely when its total (new + deduped) is zero', () => {
	const result = computeSearchAudit({ vaultFiles: [], indexedPaths: [], images: [], semanticEnabled: true });
	const summary = formatReconcileCompletedSummary(result, {
		upserts: { newCount: 5, dedupedCount: 0 },
		deletes: { newCount: 0, dedupedCount: 0 },
		orphansDeclined: false,
	});
	assert.match(summary, /5 upserts newly enqueued/);
	assert.doesNotMatch(summary, /delete/);
});

test('formatReconcileCompletedSummary singularizes a count of exactly one', () => {
	const result = computeSearchAudit({ vaultFiles: [], indexedPaths: [], images: [], semanticEnabled: true });
	const summary = formatReconcileCompletedSummary(result, {
		upserts: { newCount: 1, dedupedCount: 0 },
		deletes: { newCount: 1, dedupedCount: 0 },
		orphansDeclined: false,
	});
	assert.match(summary, /1 upsert newly enqueued/);
	assert.doesNotMatch(summary, /1 upserts/);
	assert.match(summary, /1 delete newly enqueued/);
	assert.doesNotMatch(summary, /1 deletes/);
});

test('formatReconcileCompletedSummary says "nothing enqueued" and notes a declined orphan confirm when both totals are zero', () => {
	const result = computeSearchAudit({ vaultFiles: [], indexedPaths: [], images: [], semanticEnabled: true });
	const summary = formatReconcileCompletedSummary(result, {
		upserts: { newCount: 0, dedupedCount: 0 },
		deletes: { newCount: 0, dedupedCount: 0 },
		orphansDeclined: true,
	});
	assert.match(summary, /nothing enqueued/i);
	assert.match(summary, /declined/i);
});

// WP-G2: identifyAuditCandidates — the shared candidate-naming function `computeSearchAudit`
// itself calls, and the one `runSearchAudit` (src/commands.ts) uses to scope hash/chunk
// verification to only the mtime-suspect subset.

test('identifyAuditCandidates: a vault file with no indexed row is a missing candidate', () => {
	const result = identifyAuditCandidates([{ path: 'new.md', mtime: 100 }], []);
	assert.deepEqual(result.missing, ['new.md']);
	assert.deepEqual(result.staleMtime, []);
});

test('identifyAuditCandidates: a vault file newer than its indexed row is a staleMtime candidate, not missing', () => {
	const result = identifyAuditCandidates(
		[{ path: 'edited.md', mtime: 500 }],
		[indexedRow({ path: 'edited.md', mtime: 100 })],
	);
	assert.deepEqual(result.missing, []);
	assert.deepEqual(result.staleMtime, ['edited.md']);
});

test('identifyAuditCandidates: a vault file at or behind its indexed mtime is neither candidate', () => {
	const result = identifyAuditCandidates(
		[{ path: 'same.md', mtime: 100 }],
		[indexedRow({ path: 'same.md', mtime: 100 })],
	);
	assert.deepEqual(result.missing, []);
	assert.deepEqual(result.staleMtime, []);
});

// WP-G2: hash-verified staleness — mtimeOnly closes the permanent-stale loop.

test('a staleMtime candidate whose freshly-computed hash matches the indexed contentHash reclassifies mtimeOnly, not stale', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'touched.md', mtime: 500 }],
		indexedPaths: [indexedRow({ path: 'touched.md', mtime: 100, contentHash: 'abc123' })],
		images: [],
		semanticEnabled: true,
		staleContentHashes: new Map([['touched.md', 'abc123']]),
	});
	assert.deepEqual(result.stale, []);
	assert.deepEqual(result.mtimeOnly, ['touched.md']);
	assert.equal(isCleanAudit(result), true, 'mtimeOnly is informational, not a defect');
	assert.equal(isReconcileTargetClean(result), true);
});

test('a staleMtime candidate whose freshly-computed hash differs from the indexed contentHash stays stale', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'edited.md', mtime: 500 }],
		indexedPaths: [indexedRow({ path: 'edited.md', mtime: 100, contentHash: 'old-hash' })],
		images: [],
		semanticEnabled: true,
		staleContentHashes: new Map([['edited.md', 'new-hash']]),
	});
	assert.deepEqual(result.stale, ['edited.md']);
	assert.deepEqual(result.mtimeOnly, []);
});

test('a staleMtime candidate with no verification entry keeps today\'s behavior: stale, not silently reclassified', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'unverified.md', mtime: 500 }],
		indexedPaths: [indexedRow({ path: 'unverified.md', mtime: 100, contentHash: 'abc123' })],
		images: [],
		semanticEnabled: true,
		// staleContentHashes omitted entirely — same as pre-WP-G2 callers.
	});
	assert.deepEqual(result.stale, ['unverified.md']);
	assert.deepEqual(result.mtimeOnly, []);
});

test('a staleMtime candidate is not reclassified when the indexed row itself carries no contentHash', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'nohash.md', mtime: 500 }],
		indexedPaths: [{ path: 'nohash.md', mtime: 100, chunkCount: 1, embeddedCount: 1 }],
		images: [],
		semanticEnabled: true,
		staleContentHashes: new Map([['nohash.md', 'whatever']]),
	});
	assert.deepEqual(result.stale, ['nohash.md']);
	assert.deepEqual(result.mtimeOnly, []);
});

// WP-G2: chunker-verified missing — unindexable closes the permanent phantom-missing loop.

test('a missing candidate whose real chunk count is zero reclassifies unindexable, not missing', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'frontmatter-only.md', mtime: 10 }],
		indexedPaths: [],
		images: [],
		semanticEnabled: true,
		missingChunkCounts: new Map([['frontmatter-only.md', 0]]),
	});
	assert.deepEqual(result.missing, []);
	assert.deepEqual(result.unindexable, ['frontmatter-only.md']);
	assert.equal(isCleanAudit(result), true, 'unindexable is informational, not a defect');
	assert.equal(isReconcileTargetClean(result), true);
});

test('a missing candidate with a non-zero real chunk count stays missing', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'real-content.md', mtime: 10 }],
		indexedPaths: [],
		images: [],
		semanticEnabled: true,
		missingChunkCounts: new Map([['real-content.md', 3]]),
	});
	assert.deepEqual(result.missing, ['real-content.md']);
	assert.deepEqual(result.unindexable, []);
});

test('a missing candidate with no verification entry keeps today\'s behavior: missing, not silently reclassified', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'unverified-missing.md', mtime: 10 }],
		indexedPaths: [],
		images: [],
		semanticEnabled: true,
		// missingChunkCounts omitted entirely.
	});
	assert.deepEqual(result.missing, ['unverified-missing.md']);
	assert.deepEqual(result.unindexable, []);
});

test('mtimeOnly and unindexable are excluded from missing/stale, so reconcile\'s [...missing, ...stale] enqueue set never contains them', () => {
	const result = computeSearchAudit({
		vaultFiles: [
			{ path: 'touched.md', mtime: 500 },
			{ path: 'genuinely-stale.md', mtime: 500 },
			{ path: 'frontmatter-only.md', mtime: 10 },
			{ path: 'genuinely-missing.md', mtime: 10 },
		],
		indexedPaths: [
			indexedRow({ path: 'touched.md', mtime: 100, contentHash: 'same' }),
			indexedRow({ path: 'genuinely-stale.md', mtime: 100, contentHash: 'old' }),
		],
		images: [],
		semanticEnabled: true,
		staleContentHashes: new Map([['touched.md', 'same'], ['genuinely-stale.md', 'new']]),
		missingChunkCounts: new Map([['frontmatter-only.md', 0], ['genuinely-missing.md', 2]]),
	});
	assert.deepEqual(result.mtimeOnly, ['touched.md']);
	assert.deepEqual(result.unindexable, ['frontmatter-only.md']);
	const enqueueSet = [...result.missing, ...result.stale];
	assert.deepEqual(enqueueSet.sort(), ['genuinely-missing.md', 'genuinely-stale.md']);
	assert.ok(!enqueueSet.includes('touched.md'));
	assert.ok(!enqueueSet.includes('frontmatter-only.md'));
});

test('mtimeOnly and unindexable are each returned sorted, independent of input order', () => {
	const result = computeSearchAudit({
		vaultFiles: [
			{ path: 'z-touched.md', mtime: 500 },
			{ path: 'a-touched.md', mtime: 500 },
			{ path: 'z-empty.md', mtime: 10 },
			{ path: 'a-empty.md', mtime: 10 },
		],
		indexedPaths: [
			indexedRow({ path: 'z-touched.md', mtime: 100, contentHash: 'same' }),
			indexedRow({ path: 'a-touched.md', mtime: 100, contentHash: 'same' }),
		],
		images: [],
		semanticEnabled: true,
		staleContentHashes: new Map([['z-touched.md', 'same'], ['a-touched.md', 'same']]),
		missingChunkCounts: new Map([['z-empty.md', 0], ['a-empty.md', 0]]),
	});
	assert.deepEqual(result.mtimeOnly, ['a-touched.md', 'z-touched.md']);
	assert.deepEqual(result.unindexable, ['a-empty.md', 'z-empty.md']);
});

// WP-G2: report text — the two new classes read as informational, never gain a repair command.

test('formatAuditReport summarizes mtimeOnly/unindexable counts and lists them under their own informational sections', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'touched.md', mtime: 500 }, { path: 'frontmatter-only.md', mtime: 10 }],
		indexedPaths: [indexedRow({ path: 'touched.md', mtime: 100, contentHash: 'same' })],
		images: [],
		semanticEnabled: true,
		staleContentHashes: new Map([['touched.md', 'same']]),
		missingChunkCounts: new Map([['frontmatter-only.md', 0]]),
	});
	const report = formatAuditReport(result, '2026-08-01T00:00:00.000Z');
	assert.match(report, /Mtime-only \(newer mtime, unchanged content — index is current; no action needed\): 1/);
	assert.match(report, /Unindexable \(no indexable content — frontmatter-only; nothing to index; no action needed\): 1/);
	assert.match(report, /## Mtime only \(unchanged content — informational, no action needed\)\n- touched\.md/);
	assert.match(report, /## Unindexable \(no content to index — informational, no action needed\)\n- frontmatter-only\.md/);
	// Missing/stale summary lines report zero — the two files fully moved out of those classes.
	assert.match(report, /Missing \(in vault, not indexed\): 0/);
	assert.match(report, /Stale \(vault newer than indexed, content changed\): 0/);
});

test('formatAuditReport names no repair command for mtimeOnly or unindexable — they are not defects', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'touched.md', mtime: 500 }, { path: 'frontmatter-only.md', mtime: 10 }],
		indexedPaths: [indexedRow({ path: 'touched.md', mtime: 100, contentHash: 'same' })],
		images: [],
		semanticEnabled: true,
		staleContentHashes: new Map([['touched.md', 'same']]),
		missingChunkCounts: new Map([['frontmatter-only.md', 0]]),
	});
	const report = formatAuditReport(result, '2026-08-01T00:00:00.000Z');
	// No repair section at all: missing/stale/orphans/embeddingGaps/imageCoverage are all zero,
	// and mtimeOnly/unindexable never contribute a repair line.
	assert.doesNotMatch(report, /## Repair/);
});

test('formatReconcileNothingToDoSummary treats mtimeOnly/unindexable-only findings as fully clean', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'touched.md', mtime: 500 }, { path: 'frontmatter-only.md', mtime: 10 }],
		indexedPaths: [indexedRow({ path: 'touched.md', mtime: 100, contentHash: 'same' })],
		images: [],
		semanticEnabled: true,
		staleContentHashes: new Map([['touched.md', 'same']]),
		missingChunkCounts: new Map([['frontmatter-only.md', 0]]),
	});
	assert.equal(formatReconcileNothingToDoSummary(result), 'Search: reconcile index — already matches the vault. Nothing to do.');
});

test('formatReconcileCompletedSummary names unhandled embedding/image classes alongside a real enqueue result', () => {
	const result = computeSearchAudit({
		vaultFiles: [{ path: 'partial.md', mtime: 10 }],
		indexedPaths: [indexedRow({ path: 'partial.md', mtime: 10, chunkCount: 4, embeddedCount: 2 })],
		images: [{ md5: 'f1', status: 'failed', path: 'images/f1.png' }],
		semanticEnabled: true,
	});
	const summary = formatReconcileCompletedSummary(result, {
		upserts: { newCount: 2, dedupedCount: 0 },
		deletes: { newCount: 0, dedupedCount: 0 },
		orphansDeclined: false,
	});
	assert.match(summary, /2 upserts newly enqueued/);
	assert.match(summary, /Not handled by reconcile/);
	assert.match(summary, /embedding gap/);
	assert.match(summary, /Search: retry failed image descriptions/);
});
