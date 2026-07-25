#!/usr/bin/env node
/* global process */
// scripts/inference-bench.mjs — throughput, latency and lifecycle benchmarks for embedding and
// rerank endpoints. Diagnostic tooling, outside `src/`, so the `console.*` ban does not apply.
//
// Companion to embedding-agreement.mjs (do two runtimes agree?) and embedding-quality.mjs (is the
// space any good?). This one answers "how fast, how consistently, and at what cost".
//
// MEASUREMENT POLICY, because most published numbers here previously failed it:
//   - A rate without a duration is not a rate. Every throughput result reports the window and the
//     item count alongside the rate.
//   - Report the DISTRIBUTION. Throughput is the median of >=5 repetitions with min/max; latency
//     is p50/p95/p99 over >=100 requests. A single observation is not a measurement, which is why
//     the previously quoted "90.0 chunks/s" and "0.147s" are treated as provisional.
//   - Discard a warm-up. The first batch after a model load pays a cost no steady-state user does.
//   - Pin one arm and run it FIRST and LAST in a session. If the pinned arm drifts between the two,
//     the session is thermally or contention-confounded and every arm in it is suspect.
//
// Usage:
//   node scripts/inference-bench.mjs --arm <B1|B2|B3|B4|B5|C1|C2|C3|C4|E3|E4|E5> [options]

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------- stats ----------
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
const median = xs => pct(xs, 0.5);
const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

// ---------- transport ----------
async function post(url, body, timeoutMs = 600000) {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: 'POST', signal: ctl.signal,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		const text = await res.text();
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
		return JSON.parse(text);
	} finally { clearTimeout(t); }
}

async function embedBatch(rt, texts) {
	if (rt.kind === 'ollama') {
		const j = await post(`${rt.url}/api/embed`, { model: rt.model, input: texts });
		return j.embeddings;
	}
	const j = await post(`${rt.url}/embeddings`, { model: rt.model, input: texts });
	return j.data.map(d => d.embedding);
}

async function rerank(rt, query, documents, topN) {
	const body = { model: rt.model, query, documents };
	if (topN) body.top_n = topN;
	return post(`${rt.url}/rerank`, body);
}

// ---------- samples ----------
// Same deterministic stratified draw as embedding-agreement.mjs: sha256 of the chunk id, ordered
// within length quintiles. Reproducible from the snapshot alone.
function drawChunks(dbPath, n, opts = {}) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const where = opts.minLen ? `LENGTH(text) >= ${opts.minLen}` : 'LENGTH(text) >= 40';
		const extra = opts.maxLen ? ` AND LENGTH(text) <= ${opts.maxLen}` : '';
		const meta = db.prepare(`SELECT id, LENGTH(text) AS len FROM chunks WHERE ${where}${extra}`).all()
			.map(r => ({ id: r.id, len: r.len, h: createHash('sha256').update(r.id).digest('hex') }));
		if (meta.length === 0) throw new Error('no chunks matched the length filter');
		const sorted = [...meta].sort((a, b) => a.len - b.len);
		const bounds = [1, 2, 3, 4].map(i => sorted[Math.floor((sorted.length * i) / 5)].len);
		const buckets = Array.from({ length: 5 }, () => []);
		const which = len => { for (let i = 0; i < bounds.length; i++) if (len <= bounds[i]) return i; return 4; };
		for (const r of meta) buckets[which(r.len)].push(r);
		for (const b of buckets) b.sort((a, b2) => (a.h < b2.h ? -1 : 1));
		const picked = [];
		const base = Math.floor(n / 5), rem = n % 5;
		for (let i = 0; i < 5; i++) picked.push(...buckets[i].slice(0, base + (i < rem ? 1 : 0)));
		// Deterministic shuffle across the whole draw. WITHOUT this the sample comes out ordered by
		// length quintile, so every batch is length-HOMOGENEOUS: the short batches run ~2.2x faster
		// than the long ones and the rate you report becomes an artifact of where the batch
		// boundaries happen to fall. Measured on Infinity at batch 96 over a quintile-ordered draw:
		// 14.3s / 31.5s / 14.3s / 31.2s alternating, i.e. 6.7 vs 3.1 chunks/s from the same sample.
		// Hash order mixes the quintiles so each batch sees a representative length mix, which is
		// what makes a batch-level number mean anything. (embedding-agreement.mjs already does this.)
		picked.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
		const get = db.prepare('SELECT text FROM chunks WHERE id = ?');
		return picked.map(p => get.get(p.id).text).filter(Boolean);
	} finally { db.close(); }
}

// S4 — rerank probe set, derived deterministically from S5 so it is public, frozen and carries a
// declared reference ordering. Per query: 2 relevant (the article's own EN and FR text), 2
// topically related (same cluster), 4 irrelevant (other clusters, hash-ordered for determinism).
function buildS4(s5, nQueries = 20, nDocs = 8) {
	const docs = s5.docs;
	const byCluster = new Map();
	for (const d of docs) { if (!byCluster.has(d.cluster)) byCluster.set(d.cluster, []); byCluster.get(d.cluster).push(d); }
	const ordered = [...docs].sort((a, b) => (createHash('sha256').update(a.id).digest('hex') < createHash('sha256').update(b.id).digest('hex') ? -1 : 1));
	const probes = [];
	for (const d of ordered) {
		if (probes.length >= nQueries) break;
		const sameCluster = (byCluster.get(d.cluster) || []).filter(x => x.id !== d.id);
		const otherCluster = ordered.filter(x => x.cluster !== d.cluster);
		const nIrrelevant = Math.max(1, nDocs - 4);
		if (sameCluster.length < 2 || otherCluster.length < nIrrelevant) continue;
		// Tiers stay proportionally pinned as nDocs grows: 2 relevant, 2 related, the rest
		// irrelevant. Growing only the irrelevant tier is deliberate — it scales the work the
		// reranker does without changing the difficulty of the judgement being measured.
		const documents = [
			d.en.text, d.fr.text,
			sameCluster[0].en.text, sameCluster[1].en.text,
			...otherCluster.slice(0, nIrrelevant).map(x => x.en.text),
		];
		probes.push({
			id: d.id,
			query: d.en.title,
			documents,
			relevantIdx: [0, 1], relatedIdx: [2, 3],
			irrelevantIdx: documents.map((_, k) => k).filter(k => k >= 4),
		});
	}
	return probes;
}

// Concordance against the reference, which is a PARTIAL order, not a total one.
//
// S4 declares three tiers — relevant (0), related (1), irrelevant (2) — and says nothing about
// order WITHIN a tier, because nothing sensible can be said: an article's own text and its own
// translation are both fully relevant and either may legitimately score higher. Scoring this with
// Kendall's tau against the index order treats every within-tier swap as an inversion and reports
// "0% perfect ordering" for a reranker whose tier separation is in fact flawless (measured margin
// min +2.15, i.e. the worst relevant always beat the best irrelevant). That is a metric artifact,
// not a finding — the same class of error as reading `min Jaccard` as a discriminator in arm A.
//
// So: only cross-tier pairs are scored. Returns the fraction of them the ranking gets right.
function tierConcordance(scores, tiers) {
	let conc = 0, total = 0;
	for (let i = 0; i < scores.length; i++) for (let j = 0; j < scores.length; j++) {
		if (tiers[i] >= tiers[j]) continue; // only pairs where i is strictly the better tier
		total++;
		if (scores[i] > scores[j]) conc++;
	}
	return total ? conc / total : 1;
}

function vramUsedMB() {
	try { return Math.round(Number(readFileSync('/sys/class/drm/card1/device/mem_info_vram_used', 'utf8').trim()) / 1e6); }
	catch { return null; }
}

// ---------- throughput ----------
async function throughput(rt, texts, batchSize, reps) {
	// Warm-up: one batch, discarded. The first batch after a load pays a cost steady state does not.
	await embedBatch(rt, texts.slice(0, batchSize));
	const rates = [], batchLatencies = [];
	for (let r = 0; r < reps; r++) {
		const t0 = performance.now();
		let done = 0;
		for (let i = 0; i < texts.length; i += batchSize) {
			const b0 = performance.now();
			const slice = texts.slice(i, i + batchSize);
			await embedBatch(rt, slice);
			batchLatencies.push(performance.now() - b0);
			done += slice.length;
		}
		const secs = (performance.now() - t0) / 1000;
		rates.push(done / secs);
	}
	return {
		medianRate: median(rates), minRate: Math.min(...rates), maxRate: Math.max(...rates),
		reps, itemsPerRep: texts.length, batchSize,
		windowSecPerRep: +(texts.length / median(rates)).toFixed(2),
		batchP50: median(batchLatencies), batchP95: pct(batchLatencies, 0.95),
	};
}

// ---------- main ----------
const args = {};
{
	const a = process.argv.slice(2);
	for (let i = 0; i < a.length; i++) {
		if (a[i].startsWith('--')) args[a[i].slice(2)] = (a[i + 1] && !a[i + 1].startsWith('--')) ? a[++i] : true;
	}
}

const OUT = args.json ? resolve(args.json) : null;
const emit = obj => {
	console.log(JSON.stringify(obj, null, 1));
	if (OUT) writeFileSync(OUT, JSON.stringify(obj, null, 1));
};

function rtFrom(spec) {
	const eq = spec.indexOf('=');
	const [url, model, kind = 'openai'] = spec.slice(eq + 1).split(',');
	return { label: spec.slice(0, eq), url: url.replace(/\/$/, ''), model, kind };
}

const arm = args.arm;
const snapshot = args.db ? resolve(args.db) : null;
const s5path = args.dataset ? resolve(args.dataset) : null;

if (arm === 'throughput') {
	const specs = process.argv.slice(2).filter(x => x.includes('=') && !x.startsWith('--')).map(rtFrom);
	const n = Number(args.n || 192);
	const batch = Number(args.batch || 96);
	const reps = Number(args.reps || 5);
	const texts = drawChunks(snapshot, n, { minLen: args.minLen ? Number(args.minLen) : undefined, maxLen: args.maxLen ? Number(args.maxLen) : undefined });
	const results = [];
	for (const rt of specs) {
		process.stderr.write(`\n[${rt.label}] batch=${batch} n=${texts.length} reps=${reps} `);
		const vram0 = vramUsedMB();
		try {
			const r = await throughput(rt, texts, batch, reps);
			results.push({ ...rt, ...r, vramBeforeMB: vram0, vramAfterMB: vramUsedMB(), meanTextChars: Math.round(mean(texts.map(t => t.length))) });
			process.stderr.write(`-> ${r.medianRate.toFixed(1)} chunks/s`);
		} catch (e) { results.push({ ...rt, error: e.message }); process.stderr.write(`-> FAILED ${e.message}`); }
	}
	process.stderr.write('\n');
	emit({ arm: args.name || 'throughput', batch, reps, n: texts.length, results });
} else if (arm === 'rerank') {
	const specs = process.argv.slice(2).filter(x => x.includes('=') && !x.startsWith('--')).map(rtFrom);
	const s5 = JSON.parse(readFileSync(s5path, 'utf8'));
	const probes = buildS4(s5, Number(args.queries || 20), Number(args.docs || 8));
	const topN = args.topN ? Number(args.topN) : null;
	const minRequests = Number(args.minRequests || 100);
	const results = [];
	for (const rt of specs) {
		process.stderr.write(`\n[${rt.label}] docs=${probes[0].documents.length} topN=${topN ?? 'none'} `);
		try {
			await rerank(rt, probes[0].query, probes[0].documents, topN); // warm-up, discarded
			const lat = [], taus = [], margins = [];
			let i = 0;
			while (lat.length < minRequests) {
				const p = probes[i % probes.length];
				const t0 = performance.now();
				const j = await rerank(rt, p.query, p.documents, topN);
				lat.push(performance.now() - t0);
				if (!topN) {
					const scores = new Array(p.documents.length).fill(NaN);
					for (const r of j.results) scores[r.index] = r.relevance_score;
					if (scores.every(Number.isFinite)) {
						const tiers = p.documents.map((_, k) => p.relevantIdx.includes(k) ? 0 : p.relatedIdx.includes(k) ? 1 : 2);
						taus.push(tierConcordance(scores, tiers));
						margins.push(Math.min(...p.relevantIdx.map(k => scores[k])) - Math.max(...p.irrelevantIdx.map(k => scores[k])));
					}
				}
				i++;
			}
			results.push({
				...rt, requests: lat.length, documents: probes[0].documents.length, topN,
				p50: median(lat), p95: pct(lat, 0.95), p99: pct(lat, 0.99), min: Math.min(...lat), max: Math.max(...lat),
				docsPerSec: probes[0].documents.length / (median(lat) / 1000),
				tierConcordanceMean: taus.length ? mean(taus) : null,
				tierConcordanceMin: taus.length ? Math.min(...taus) : null,
				queriesFullyCorrect: taus.length ? taus.filter(t => t === 1).length / taus.length : null,
				marginMean: margins.length ? mean(margins) : null,
				marginMin: margins.length ? Math.min(...margins) : null,
			});
			process.stderr.write(`-> p50 ${median(lat).toFixed(1)}ms`);
		} catch (e) { results.push({ ...rt, error: e.message }); process.stderr.write(`-> FAILED ${e.message}`); }
	}
	process.stderr.write('\n');
	emit({ arm: args.name || 'rerank', queries: probes.length, results });
} else if (arm === 'concurrency') {
	const specs = process.argv.slice(2).filter(x => x.includes('=') && !x.startsWith('--')).map(rtFrom);
	const texts = drawChunks(snapshot, Number(args.n || 96));
	const batch = Number(args.batch || 32);
	const results = [];
	for (const rt of specs) {
		for (const conc of [1, 2, 4]) {
			await embedBatch(rt, texts.slice(0, batch)); // warm
			const slices = [];
			for (let i = 0; i < texts.length; i += batch) slices.push(texts.slice(i, i + batch));
			const t0 = performance.now();
			for (let i = 0; i < slices.length; i += conc) {
				await Promise.all(slices.slice(i, i + conc).map(s => embedBatch(rt, s)));
			}
			const secs = (performance.now() - t0) / 1000;
			results.push({ ...rt, concurrency: conc, rate: texts.length / secs, seconds: +secs.toFixed(2) });
			process.stderr.write(`\n[${rt.label}] conc=${conc} -> ${(texts.length / secs).toFixed(1)} chunks/s`);
		}
	}
	process.stderr.write('\n');
	emit({ arm: 'E5-concurrency', results });
} else {
	console.log('Usage: --arm throughput|rerank|concurrency [--db snap.sqlite] [--dataset S5.json] [--batch N] [--reps N] [--n N] [--minLen N] [--maxLen N] [--topN N] [--queries N] [--json out.json] [--name label] label=url,model[,kind] ...');
	process.exit(1);
}
