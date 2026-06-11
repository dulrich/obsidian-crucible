import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-template-token-tests');
const outfile = path.join(outdir, 'utils.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/utils.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: [
					'export const Platform = { isMacOS: false };',
					'export class TFolder {}',
					'export function moment() { throw new Error("moment unavailable in tests"); }',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const fakeMoment = { format: (fmt) => `[${fmt}]` };
globalThis.window = { moment: () => fakeMoment };

const { collapseWhitespace, applyTemplateString } = await import(pathToFileURL(outfile));

test('collapseWhitespace flattens whitespace runs and trims edges', () => {
	assert.equal(collapseWhitespace('a  b\n\nc\td'), 'a b c d');
	assert.equal(collapseWhitespace('  leading and trailing \n'), 'leading and trailing');
	assert.equal(collapseWhitespace(''), '');
});

test('{{value:oneline}} collapses a multi-paragraph value to one line', async () => {
	const value = 'First paragraph of the\nobservation.\n\nSecond paragraph here.';
	const result = await applyTemplateString('- {{value:oneline}}', fakeMoment, 'Note', value);
	assert.equal(result, '- First paragraph of the observation. Second paragraph here.');
});

test('{{value}} still preserves newlines and coexists with {{value:oneline}}', async () => {
	const value = 'line one\n\nline two';
	const result = await applyTemplateString('{{value:oneline}}|{{value}}', fakeMoment, 'Note', value);
	assert.equal(result, 'line one line two|line one\n\nline two');
});
