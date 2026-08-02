import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// WP-J1 scope item 4: "verify/pin that r.progress folds into the queue monitor's row
// signature so a live cell repaints rather than being signature-skipped." Investigation
// (not a fix): `queueMonitor.ts` never imports `computeRowSignature`/`shouldRepaint`
// from `src/ingestion/render/section.ts` at all — unlike every vault-scan-derived
// section (uncapturedPosts, searchAudit, ignored, missingAttachments, ...), the Queue
// monitor's table is driven by `renderSortableTable`'s own keyed reconciler, whose
// `paintRow` unconditionally re-renders every visible row's cells on every call
// (src/ingestion/render/sortableTable.ts's `paintRow`: `td.empty()` + `col.render(row,
// td)`, no signature check). `renderQueueMonitor` itself re-fetches rows fresh from the
// backend and calls `renderSortableTable` unconditionally on every dirty flush
// triggered by `orchestration-queue-updated` (src/ingestionDashboard.ts, which
// `DbJobBackend.setProgress`'s coalesced emit reaches). There is therefore no
// signature-skip gate that could leave the Progress cell showing a stale value — this
// pins that structural fact directly (source-text, not a DOM harness) so a future
// change that *adds* a signature gate to this section is forced to keep `progress` in
// whatever it hashes, rather than silently reintroducing the staleness this WP exists
// to avoid.

const source = readFileSync('src/ingestion/sections/queueMonitor.ts', 'utf8');

test('queueMonitor.ts does not gate its table repaint behind computeRowSignature/shouldRepaint', () => {
	assert.doesNotMatch(source, /computeRowSignature|shouldRepaint/,
		'a signature-skip gate here would need `progress` folded into what it hashes, or a live '
		+ 'Progress cell could go stale between orchestration-queue-updated events');
});

test('the Progress column renders the live row.progress field', () => {
	assert.match(source, /key:\s*'progress'/);
	assert.match(source, /td\.setText\(r\.progress\s*\?\?\s*''\)/);
});

test('renderQueueMonitor re-fetches rows (fresh progress values) rather than reusing a cached list', () => {
	assert.match(source, /orchestrator\.listJobs\(/);
});
