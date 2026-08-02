#!/usr/bin/env node
/* global process */
// scripts/embedding-agreement.mjs — cross-runtime embedding agreement harness.
//
// Answers: given the same real vault text, how much do two (or more) runtimes' vectors agree?
// This is diagnostic tooling, not plugin code — it lives outside `src/`, so the `console.*` ban
// (see root AGENTS.md Quirks) does not apply here.
//
// Reads a SAMPLE of chunk texts from a SNAPSHOT copy of the search companion database (never
// the live one — see scripts/search-snapshot.sh), embeds each sampled text through every
// configured runtime, and reports:
//   - mean / median / MINIMUM pairwise cosine agreement for the same text across each pair of
//     runtimes, plus the 5th-percentile value and the worst 3 texts that produced it;
//   - top-10 rank-overlap (Jaccard) for a handful of queries, ranking the sampled corpus under
//     each runtime independently.
//
// Reporting the MINIMUM is a hard requirement, not a nicety: a mean of 0.999 with a 0.94 tail
// means specific content types diverge, which surfaces later as "search got weird for my code
// notes" — exactly what this harness exists to catch before a decision gets made on the mean
// alone.
//
// POSITIVE CONTROL: bge-m3 (bi-encoder) and a cross-encoder reranker misreported as an embedder
// (e.g. LM Studio's text-embedding-bge-reranker-v2-m3) are the SAME width (1024d) but wildly
// DIFFERENT vector spaces. If this harness reports high agreement between that pair, the harness
// is broken — a cross-encoder's pooled output is not a sentence embedding and was never trained
// for cosine similarity in a shared space. Run that pair as a self-check before trusting any
// other result out of this tool.
//
// Usage:
//   node scripts/embedding-agreement.mjs \
//     --db ./search-backup-2026-07-25-1200.sqlite \
//     --samples 200 --queries 5 --batch-size 16 \
//     infinity-bge-m3=http://127.0.0.1:4802/v1,BAAI/bge-m3 \
//     lmstudio-reranker=http://127.0.0.1:1234/v1,text-embedding-bge-reranker-v2-m3
//
// Runtime spec syntax: label=baseUrl,model[,kind]
//   - baseUrl must include any API path prefix the server needs (e.g. the trailing /v1 for the
//     OpenAI-compatible shape), since the request is POST {baseUrl}/embeddings.
//   - kind defaults to "openai" (OpenAI-compatible POST {baseUrl}/embeddings with
//     {model, input: string[]} -> {data: [{embedding, index}]}).
//   - kind "ollama" uses POST {baseUrl}/api/embed with {model, input: string[]} ->
//     {embeddings: number[][]} (baseUrl should be the bare host:port, no /v1, no trailing path).
//
// With --db omitted, the newest ./search-backup-*.sqlite in the current directory is used.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRuntimeSpec, embedBatch, normalizeDefensively, newNormStats, dot } from './lib/embed-runtime.mjs';

const DEFAULT_SAMPLES = 200;
const DEFAULT_QUERIES = 5;
const DEFAULT_BATCH_SIZE = 16;
const QUINTILES = 5;
const TOP_K = 10;
const QUERY_TEXT_MAX_CHARS = 150;
const WORST_TEXT_PREVIEW_CHARS = 80;
const WORST_N = 3;

function parseArgs(argv) {
	const out = { db: null, samples: DEFAULT_SAMPLES, queries: DEFAULT_QUERIES, batchSize: DEFAULT_BATCH_SIZE, sampling: 'stratified', runtimes: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--db') {
			out.db = argv[++i];
		} else if (arg === '--samples') {
			out.samples = Number(argv[++i]);
		} else if (arg === '--queries') {
			out.queries = Number(argv[++i]);
		} else if (arg === '--batch-size') {
			out.batchSize = Number(argv[++i]);
		} else if (arg === '--sampling') {
			out.sampling = argv[++i];
		} else if (arg === '--help' || arg === '-h') {
			out.help = true;
		} else if (arg.includes('=')) {
			out.runtimes.push(parseRuntimeSpec(arg));
		} else {
			throw new Error(`Unrecognized argument: ${arg}`);
		}
	}
	return out;
}

function findNewestSnapshot() {
	const cwd = process.cwd();
	const candidates = readdirSync(cwd)
		.filter(name => /^search-backup-.*\.sqlite$/.test(name))
		.map(name => {
			const full = resolve(cwd, name);
			return { full, mtime: statSync(full).mtimeMs };
		})
		.sort((a, b) => b.mtime - a.mtime);
	if (candidates.length === 0) {
		throw new Error('No --db given and no ./search-backup-*.sqlite found in the current directory. Run scripts/search-snapshot.sh first.');
	}
	return candidates[0].full;
}

// Deterministic, length-stratified selection key. `ORDER BY RANDOM()` was correct for a one-off
// diagnostic but is not reproducible, and `node:sqlite` exposes no seed hook — so a re-run of the
// same snapshot drew a different sample and no two arms of a comparison were measured on the same
// texts. Hashing the chunk id gives a stable pseudo-random order derivable from the snapshot
// alone (no seed to record, no state to carry), and stratifying by length quintile stops a draw
// from over-weighting short chunks, which is the confound that made `enrich`'s 301 events/s
// untransferable in the first place. See runs/dispatch/esi-field-report-protocol.md sample S1.
function selectionHash(id) {
	return createHash('sha256').update(id).digest('hex');
}

// Cut points at the 20th/40th/60th/80th percentile of the length distribution; index 0..4.
function quintileBounds(lengths) {
	const sorted = [...lengths].sort((a, b) => a - b);
	const bounds = [];
	for (let i = 1; i < QUINTILES; i++) {
		bounds.push(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * i) / QUINTILES))]);
	}
	return bounds;
}

function quintileOf(len, bounds) {
	for (let i = 0; i < bounds.length; i++) {
		if (len <= bounds[i]) return i;
	}
	return QUINTILES - 1;
}

function describeLengths(lengths) {
	const sorted = [...lengths].sort((a, b) => a - b);
	const at = f => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
	const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
	return { n: sorted.length, mean, p5: at(0.05), p50: at(0.5), p95: at(0.95), min: sorted[0], max: sorted[sorted.length - 1] };
}

// Draws `total` ids stratified across length quintiles, each quintile ordered by selection hash.
// A quintile with fewer members than its share does not silently shrink the sample: the shortfall
// is refilled from the hash-ordered remainder, so the caller always gets `total` when the corpus
// has that many rows at all.
function stratifiedIds(meta, total) {
	const bounds = quintileBounds(meta.map(r => r.len));
	const buckets = Array.from({ length: QUINTILES }, () => []);
	for (const row of meta) buckets[quintileOf(row.len, bounds)].push(row);
	for (const bucket of buckets) bucket.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));

	const picked = [];
	const base = Math.floor(total / QUINTILES);
	const remainder = total % QUINTILES;
	for (let i = 0; i < QUINTILES; i++) {
		picked.push(...buckets[i].slice(0, base + (i < remainder ? 1 : 0)));
	}
	if (picked.length < total) {
		const taken = new Set(picked.map(r => r.id));
		const spare = meta
			.filter(r => !taken.has(r.id))
			.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
		picked.push(...spare.slice(0, total - picked.length));
	}
	// Global hash order across the whole draw, so the corpus/query split below is itself stable
	// and independent of how the quintiles happened to fill.
	picked.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
	return { picked, bounds };
}

function sampleChunks(dbPath, sampleCount, queryCount, mode = 'stratified') {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const total = queryCount + sampleCount;
		let rows;
		let bounds = null;
		let lengthStats = null;

		if (mode === 'random') {
			rows = db
				.prepare('SELECT id, path, text FROM chunks WHERE LENGTH(text) >= 40 ORDER BY RANDOM() LIMIT ?')
				.all(total);
		} else {
			const meta = db
				.prepare('SELECT id, LENGTH(text) AS len FROM chunks WHERE LENGTH(text) >= 40')
				.all()
				.map(r => ({ id: r.id, len: r.len, hash: selectionHash(r.id) }));
			if (meta.length === 0) throw new Error('No corpus chunks sampled — snapshot may be empty.');
			lengthStats = describeLengths(meta.map(r => r.len));
			const drawn = stratifiedIds(meta, Math.min(total, meta.length));
			bounds = drawn.bounds;
			// Fetch text only for the drawn ids. Reading every row's text to sample 205 of them
			// would pull ~58MB off disk for nothing.
			const byId = new Map();
			const get = db.prepare('SELECT id, path, text FROM chunks WHERE id = ?');
			for (const row of drawn.picked) {
				const full = get.get(row.id);
				if (full) byId.set(row.id, full);
			}
			rows = drawn.picked.map(r => byId.get(r.id)).filter(Boolean);
		}

		if (rows.length < total) {
			console.error(`WARNING: requested ${total} chunks (samples+queries) but only ${rows.length} chunks with length >= 40 exist in ${dbPath}.`);
		}
		const corpus = rows.slice(0, sampleCount);
		const queryRows = rows.slice(sampleCount, sampleCount + queryCount);
		if (corpus.length === 0) throw new Error('No corpus chunks sampled — snapshot may be empty.');
		if (queryRows.length === 0) console.error('WARNING: no distinct chunks left over for queries; rank-overlap section will be skipped.');
		const queries = queryRows.map(row => ({
			id: row.id,
			path: row.path,
			text: row.text.slice(0, QUERY_TEXT_MAX_CHARS),
		}));
		return { corpus, queries, bounds, lengthStats, mode };
	} finally {
		db.close();
	}
}

async function embedAllBatched(runtime, texts, batchSize, normStats) {
	const vectors = [];
	for (let i = 0; i < texts.length; i += batchSize) {
		for (const vec of await embedBatch(runtime, texts.slice(i, i + batchSize))) {
			vectors.push(normalizeDefensively(vec, normStats));
		}
		process.stderr.write(`  [${runtime.label}] embedded ${Math.min(i + batchSize, texts.length)}/${texts.length}\r`);
	}
	process.stderr.write('\n');
	return vectors;
}

function mean(arr) {
	return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(sortedArr) {
	const n = sortedArr.length;
	if (n === 0) return NaN;
	const mid = Math.floor(n / 2);
	return n % 2 === 0 ? (sortedArr[mid - 1] + sortedArr[mid]) / 2 : sortedArr[mid];
}

function percentile(sortedArr, p) {
	if (sortedArr.length === 0) return NaN;
	const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.ceil((p / 100) * sortedArr.length) - 1));
	return sortedArr[idx];
}

function truncate(text, maxChars) {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > maxChars ? flat.slice(0, maxChars) + '…' : flat;
}

function jaccard(setA, setB) {
	let inter = 0;
	for (const x of setA) if (setB.has(x)) inter++;
	const union = new Set([...setA, ...setB]).size;
	return union === 0 ? 1 : inter / union;
}

function topKIds(queryVec, corpusVecs, corpusIds, k) {
	const scored = corpusIds.map((id, i) => ({ id, score: dot(queryVec, corpusVecs[i]) }));
	scored.sort((a, b) => b.score - a.score);
	return new Set(scored.slice(0, k).map(s => s.id));
}

function printTable(rows, columns) {
	const widths = columns.map(col => Math.max(col.header.length, ...rows.map(r => String(r[col.key]).length)));
	const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
	console.log(line(columns.map(c => c.header)));
	console.log(widths.map(w => '-'.repeat(w)).join('  '));
	for (const row of rows) {
		console.log(line(columns.map(c => row[c.key])));
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || args.runtimes.length === 0) {
		console.log('Usage: node scripts/embedding-agreement.mjs [--db path] [--samples 200] [--queries 5] [--batch-size 16] [--sampling stratified|random] label=url,model[,kind] [label=url,model[,kind] ...]');
		process.exit(args.help ? 0 : 1);
	}
	if (args.runtimes.length < 2) {
		console.error('WARNING: only one runtime spec given; no pairwise agreement can be computed. Provide 2+ to compare.');
	}
	if (!Number.isFinite(args.samples) || args.samples <= 0) throw new Error('--samples must be a positive number');
	if (!Number.isFinite(args.queries) || args.queries < 0) throw new Error('--queries must be a non-negative number');
	if (!Number.isFinite(args.batchSize) || args.batchSize <= 0) throw new Error('--batch-size must be a positive number');
	if (args.sampling !== 'stratified' && args.sampling !== 'random') {
		throw new Error(`--sampling must be "stratified" or "random" (got "${args.sampling}")`);
	}

	const dbPath = args.db ? resolve(args.db) : findNewestSnapshot();
	console.log(`Sampling from snapshot: ${dbPath}`);
	const { corpus, queries, bounds, lengthStats } = sampleChunks(dbPath, args.samples, args.queries, args.sampling);
	if (args.sampling === 'stratified') {
		console.log(`Sampling: stratified by length quintile, ordered by sha256(chunkId) — reproducible from this snapshot alone.`);
		console.log(`Quintile bounds (chars): ${bounds.join(' / ')}`);
		// Publishing the distribution is the point, not decoration: gap G17 exists because the
		// corpus mean (~1,118) and the chunker's 1,800-char cap had been quoted interchangeably.
		console.log(`Corpus length distribution over ${lengthStats.n} chunks: min ${lengthStats.min}, p5 ${lengthStats.p5}, p50 ${lengthStats.p50}, mean ${Math.round(lengthStats.mean)}, p95 ${lengthStats.p95}, max ${lengthStats.max}`);
	} else {
		console.log('Sampling: RANDOM — not reproducible. Use the default --sampling stratified for anything that will be reported.');
	}
	console.log(`Sampled ${corpus.length} corpus chunks and ${queries.length} query chunks (mean corpus text length ${Math.round(mean(corpus.map(c => c.text.length)))} chars).`);

	const corpusTexts = corpus.map(c => c.text);
	const corpusIds = corpus.map(c => c.id);
	const queryTexts = queries.map(q => q.text);

	const perRuntime = new Map();
	const normStatsAll = new Map();

	for (const runtime of args.runtimes) {
		console.log(`\n== Embedding through ${runtime.label} (${runtime.kind}, ${runtime.url}, model=${runtime.model}) ==`);
		const normStats = newNormStats();
		normStatsAll.set(runtime.label, normStats);
		const corpusVecs = await embedAllBatched(runtime, corpusTexts, args.batchSize, normStats);
		const queryVecs = queryTexts.length > 0 ? await embedAllBatched(runtime, queryTexts, args.batchSize, normStats) : [];
		const dim = corpusVecs[0] ? corpusVecs[0].length : 0;
		console.log(`  dim=${dim}, non-unit-norm inputs: ${normStats.nonUnit}/${normStats.total} (zero vectors: ${normStats.zero})`);
		perRuntime.set(runtime.label, { runtime, corpusVecs, queryVecs, dim });
	}

	const labels = args.runtimes.map(r => r.label);
	const agreementRows = [];
	const rankOverlapRows = [];
	const worstTextSections = [];

	for (let i = 0; i < labels.length; i++) {
		for (let j = i + 1; j < labels.length; j++) {
			const a = perRuntime.get(labels[i]);
			const b = perRuntime.get(labels[j]);
			const pairLabel = `${labels[i]} vs ${labels[j]}`;

			if (a.dim !== b.dim) {
				agreementRows.push({
					pair: pairLabel, mean: 'n/a', median: 'n/a', min: 'n/a', p5: 'n/a',
					note: `dimension mismatch (${a.dim}d vs ${b.dim}d) — not directly comparable`,
				});
				continue;
			}

			const scores = corpusIds.map((id, k) => ({ id, path: corpus[k].path, text: corpus[k].text, score: dot(a.corpusVecs[k], b.corpusVecs[k]) }));
			const sortedScores = [...scores].sort((x, y) => x.score - y.score);
			const values = sortedScores.map(s => s.score);

			agreementRows.push({
				pair: pairLabel,
				mean: mean(values).toFixed(4),
				median: median(values).toFixed(4),
				min: values[0].toFixed(4),
				p5: percentile(values, 5).toFixed(4),
				note: '',
			});

			worstTextSections.push({
				pair: pairLabel,
				worst: sortedScores.slice(0, WORST_N).map(s => ({ score: s.score.toFixed(4), path: s.path, preview: truncate(s.text, WORST_TEXT_PREVIEW_CHARS) })),
			});

			if (queries.length > 0) {
				const overlaps = queries.map((q, qi) => {
					const topA = topKIds(a.queryVecs[qi], a.corpusVecs, corpusIds, TOP_K);
					const topB = topKIds(b.queryVecs[qi], b.corpusVecs, corpusIds, TOP_K);
					return jaccard(topA, topB);
				});
				rankOverlapRows.push({
					pair: pairLabel,
					meanJaccardTop10: mean(overlaps).toFixed(4),
					minJaccardTop10: Math.min(...overlaps).toFixed(4),
					queriesUsed: overlaps.length,
				});
			}
		}
	}

	console.log('\n=== Pairwise same-text cosine agreement ===');
	if (agreementRows.length === 0) {
		console.log('(need 2+ runtimes to compare)');
	} else {
		printTable(agreementRows, [
			{ key: 'pair', header: 'pair' },
			{ key: 'mean', header: 'mean' },
			{ key: 'median', header: 'median' },
			{ key: 'min', header: 'MIN' },
			{ key: 'p5', header: 'p5' },
			{ key: 'note', header: 'note' },
		]);
	}

	if (worstTextSections.length > 0) {
		console.log('\n=== Worst-agreement texts per pair ===');
		for (const section of worstTextSections) {
			console.log(`\n-- ${section.pair} --`);
			for (const w of section.worst) {
				console.log(`  cosine=${w.score}  path=${w.path}`);
				console.log(`    "${w.preview}"`);
			}
		}
	}

	if (rankOverlapRows.length > 0) {
		console.log('\n=== Top-10 rank overlap (Jaccard) across queries ===');
		printTable(rankOverlapRows, [
			{ key: 'pair', header: 'pair' },
			{ key: 'meanJaccardTop10', header: 'mean Jaccard@10' },
			{ key: 'minJaccardTop10', header: 'min Jaccard@10' },
			{ key: 'queriesUsed', header: 'queries' },
		]);
	}

	console.log('\n=== Normalization defensiveness ===');
	for (const [label, stats] of normStatsAll) {
		console.log(`  ${label}: ${stats.nonUnit}/${stats.total} inputs were not unit-length before defensive normalization (zero vectors: ${stats.zero})`);
	}
}

main().catch(err => {
	console.error('FATAL:', err.stack || err.message || err);
	process.exit(1);
});
