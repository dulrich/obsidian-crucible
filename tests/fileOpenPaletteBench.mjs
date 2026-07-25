/**
 * Micro-benchmark for the file-open palette selection core. Deliberately NOT named
 * `*.test.mjs`, so `npm test` does not run it: it is a measurement, not a gate.
 *
 *   node tests/fileOpenPaletteBench.mjs
 *
 * Design target at 47,310 candidates (the real vault size): p95 <= 8 ms, p99 <= 16 ms
 * for one keystroke. The 1-character query is the worst case — a single letter gives the
 * char-class bitmask almost nothing to reject on. If that case ever busts 16 ms on real
 * hardware, the planned escape hatch is a first-character posting list built alongside
 * the snapshot; do not add one on speculation.
 */

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-file-open-bench');
const outfile = path.join(outdir, 'fileOpenRanking.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/fileOpenRanking.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	minify: true,
	logLevel: 'silent',
});

const { buildFileOpenSnapshot, createNarrowState, selectFileOpenItems } =
	await import(pathToFileURL(outfile).href);

const SIZE = 47310;
const FOLDERS = ['Daily', 'Archive', 'Media', 'Projects', 'Reading', 'Clippings', '_crucible', 'Legal', 'Sources', 'Inbox'];
const WORDS = ['crucible', 'orchestration', 'daily', 'log', 'notes', 'transcript', 'metadata', 'ingest', 'review', 'chart', 'summary', 'draft', 'index', 'plan', 'report', 'weekly'];

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const rng = mulberry32(47310);
const pick = list => list[Math.floor(rng() * list.length)];

const candidates = [];
for (let i = 0; i < SIZE; i++) {
	const depth = Math.floor(rng() * 3);
	const parts = [pick(FOLDERS)];
	for (let d = 0; d < depth; d++) parts.push(pick(WORDS));
	parts.push(`${pick(WORDS)}-${pick(WORDS)}-${i}.md`);
	candidates.push({ path: parts.join('/'), extension: 'md', mtime: 1.7e12 + i });
}

const buildStart = performance.now();
const snapshot = buildFileOpenSnapshot(candidates, { isIgnoredPath: p => p.startsWith('_crucible/') });
const buildMs = performance.now() - buildStart;

const options = { ignoredFolderMode: 'derank', createMissing: true, limit: 100 };

function percentile(samples, p) {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function measure(label, run, iterations = 60, keystrokes = 1) {
	for (let i = 0; i < 10; i++) run();
	const samples = [];
	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		run();
		samples.push((performance.now() - start) / keystrokes);
	}
	const p50 = percentile(samples, 0.5);
	const p95 = percentile(samples, 0.95);
	const p99 = percentile(samples, 0.99);
	const flag = p95 > 8 || p99 > 16 ? '  << OVER TARGET' : '';
	console.log(`${label.padEnd(34)} p50 ${p50.toFixed(2)} ms   p95 ${p95.toFixed(2)} ms   p99 ${p99.toFixed(2)} ms${flag}`);
}

console.log(`corpus ${SIZE} paths, snapshot built in ${buildMs.toFixed(1)} ms\n`);

console.log('cold (no narrowing state — the paste / mid-string-edit path)');
measure('  1 char  "c"', () => selectFileOpenItems(snapshot, 'c', null, options));
measure('  3 chars "cru"', () => selectFileOpenItems(snapshot, 'cru', null, options));
measure('  8 chars "crucible"', () => selectFileOpenItems(snapshot, 'crucible', null, options));
measure('  empty query', () => selectFileOpenItems(snapshot, '', null, options));

console.log('\nnarrowed (the keystroke path — state carried from the previous query)');
for (const query of ['c', 'cru', 'crucible']) {
	const state = createNarrowState();
	for (let i = 1; i < query.length; i++) selectFileOpenItems(snapshot, query.slice(0, i), state, options);
	measure(`  ${String(query.length).padStart(1)} chars "${query}"`, () => selectFileOpenItems(snapshot, query, state, options));
}

console.log('\nfull typing burst (empty -> "crucible"), amortized per keystroke');
measure('  8 keystrokes, narrowed', () => {
	const state = createNarrowState();
	for (let i = 1; i <= 'crucible'.length; i++) selectFileOpenItems(snapshot, 'crucible'.slice(0, i), state, options);
}, 30, 'crucible'.length);
