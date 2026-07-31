import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// rem-R1: WorkflowResult is a discriminated union; every result-producing code path must
// construct the variant it means, never spread one into another (the one hole TypeScript
// leaves open — see tests/workflowResultUnion.test.mjs's identical pin on cancellation.ts).
// Source-text check, not a bundle: this is about what the file's literals look like, not
// runtime behavior.

const WORKFLOW_FILES = [
	'src/orchestration/workflows/XMetadataFetchWorkflow.ts',
	'src/orchestration/workflows/XPostDiscoverWorkflow.ts',
];

for (const file of WORKFLOW_FILES) {
	test(`${file}: no variant is spread into another (no "...result," / "...ensured,")`, async () => {
		const src = await readFile(file, 'utf8');
		assert.doesNotMatch(src, /\.\.\.result,/, 'spreading a WorkflowResult variant into another is the compiler blind spot');
		assert.doesNotMatch(src, /\.\.\.ensured,/, 'spreading an XEnsureResult variant into a WorkflowResult would smuggle unrelated fields across');
	});
}

test('XMetadataFetchWorkflow constructs each WorkflowResult variant explicitly', async () => {
	const src = await readFile('src/orchestration/workflows/XMetadataFetchWorkflow.ts', 'utf8');
	assert.match(src, /status: 'failed'/, 'the missing-statusId/invalid-statusId paths construct failed');
	assert.match(src, /status: 'done'/, 'the created/exists/tombstoned paths construct done');
	// The deferred variant is built exclusively via xOembedDeferredResult — a construct
	// site outside this file, but the caught error type is what must route there.
	assert.match(src, /XApiUnavailableError/);
});

test('XPostDiscoverWorkflow constructs each WorkflowResult variant explicitly', async () => {
	const src = await readFile('src/orchestration/workflows/XPostDiscoverWorkflow.ts', 'utf8');
	assert.match(src, /status: 'failed'/, 'missing targetPath / target not found construct failed');
	assert.match(src, /status: 'done'/, 'the summary result constructs done');
	assert.doesNotMatch(src, /status: 'deferred'/, 'discovery never talks to the oEmbed endpoint, so it never defers');
});
