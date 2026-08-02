#!/usr/bin/env node
/* global process */
// scripts/embedding-quality.mjs — ground-truth embedding quality across runtimes/quantizations.
//
// Diagnostic tooling, not plugin code — it lives outside `src/`, so the `console.*` ban
// (see root AGENTS.md Quirks) does not apply here.
//
// WHY THIS EXISTS, given scripts/embedding-agreement.mjs already compares runtimes.
// Agreement can only say whether two servers produce the SAME ranking. It cannot say whether
// either ranking is any GOOD, because "two servers ranked my notes identically" has no ground
// truth in it — two equally broken configurations agree perfectly. Every quality claim in this
// project was, until this harness, either a speed number or an agreement number.
//
// The ground truth here is parallel Wikipedia (built by the dataset builder into
// runs/measurements/*/samples/S5-wikipedia.json):
//
//   ALIGNMENT  An article and its translation are semantically identical and lexically almost
//              disjoint. A working multilingual embedder must rank the true translation FIRST
//              out of all candidates. This is the crispest available "does this space work"
//              measure and it needs no human judgment.
//   SEPARATION Articles are drawn in topic CLUSTERS, giving a graded structure the space must
//              preserve:  translation (same content)  >  same-cluster (same topic, different
//              content)  >  cross-cluster (unrelated).  A collapsed space flattens it.
//   MARGIN     min(translation cosine) - max(cross-cluster cosine). Negative means some
//              unrelated pair scores above some true translation — the space cannot be
//              thresholded at all.
//
// A cross-encoder misused as an embedder is expected to fail alignment outright while still
// returning perfectly well-formed, unit-length vectors of exactly the right width. That is the
// point: this harness measures the one thing every structural guard misses.
//
// Usage:
//   node scripts/embedding-quality.mjs --dataset path/to/S5-wikipedia.json \
//     [--batch-size 16] [--json out.json] \
//     label=url,model[,kind] [label=url,model[,kind] ...]
//
// Runtime spec syntax matches scripts/embedding-agreement.mjs.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRuntimeSpec, embedBatch, normalizeDefensively, dot } from './lib/embed-runtime.mjs';

const DEFAULT_BATCH_SIZE = 16;

function parseArgs(argv) {
	const out = { dataset: null, batchSize: DEFAULT_BATCH_SIZE, json: null, runtimes: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--dataset') out.dataset = argv[++i];
		else if (a === '--batch-size') out.batchSize = Number(argv[++i]);
		else if (a === '--json') out.json = argv[++i];
		else if (a === '--help' || a === '-h') out.help = true;
		else if (a.includes('=')) out.runtimes.push(parseRuntimeSpec(a));
		else throw new Error(`Unrecognized argument: ${a}`);
	}
	return out;
}

async function embedAll(runtime, texts, batchSize) {
	const out = [];
	for (let i = 0; i < texts.length; i += batchSize) {
		for (const v of await embedBatch(runtime, texts.slice(i, i + batchSize))) out.push(normalizeDefensively(v));
		process.stdout.write('.');
	}
	return out;
}

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / (xs.length || 1); }
function quantile(xs, q) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

// P@1 and MRR for source[i] -> target[i], over all target candidates.
function retrieval(source, target) {
	let hits = 0;
	let rrSum = 0;
	const ranks = [];
	for (let i = 0; i < source.length; i++) {
		const scores = target.map((t, j) => ({ j, s: dot(source[i], t) }));
		scores.sort((a, b) => b.s - a.s);
		const rank = scores.findIndex(x => x.j === i) + 1;
		ranks.push(rank);
		if (rank === 1) hits++;
		rrSum += 1 / rank;
	}
	return { p1: hits / source.length, mrr: rrSum / source.length, medianRank: quantile(ranks, 0.5), worstRank: Math.max(...ranks) };
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.dataset || args.runtimes.length === 0) {
		console.log('Usage: node scripts/embedding-quality.mjs --dataset S5-wikipedia.json [--batch-size 16] [--json out.json] label=url,model[,kind] ...');
		process.exit(args.help ? 0 : 1);
	}

	const ds = JSON.parse(readFileSync(resolve(args.dataset), 'utf8'));
	const docs = ds.docs;
	const langs = ds.languages;
	console.log(`Dataset: ${ds.name}`);
	console.log(`  ${docs.length} articles x ${langs.length} languages (${langs.join(', ')}), ${new Set(docs.map(d => d.cluster)).size} clusters, sha256 ${String(ds.sha256).slice(0, 16)}…`);

	return (async () => {
		const results = [];
		for (const runtime of args.runtimes) {
			console.log(`\n== ${runtime.label} (${runtime.model} @ ${runtime.url}) ==`);
			const byLang = {};
			let dims = null;
			const t0 = Date.now();
			try {
				for (const lang of langs) {
					process.stdout.write(`  ${lang} `);
					byLang[lang] = await embedAll(runtime, docs.map(d => d[lang].text), args.batchSize);
					dims = byLang[lang][0].length;
					process.stdout.write(` (${dims}d)\n`);
				}
			} catch (e) {
				console.log(`\n  FAILED: ${e.message}`);
				results.push({ label: runtime.label, model: runtime.model, error: e.message });
				continue;
			}
			const secs = (Date.now() - t0) / 1000;

			// Alignment: English -> each other language.
			const alignment = {};
			for (const lang of langs.filter(l => l !== 'en')) {
				alignment[lang] = retrieval(byLang.en, byLang[lang]);
			}

			// Separation, measured inside English only so language is not a confound.
			const trans = [];
			for (const lang of langs.filter(l => l !== 'en')) {
				for (let i = 0; i < docs.length; i++) trans.push(dot(byLang.en[i], byLang[lang][i]));
			}
			const sameCluster = [];
			const crossCluster = [];
			for (let i = 0; i < docs.length; i++) {
				for (let j = i + 1; j < docs.length; j++) {
					const s = dot(byLang.en[i], byLang.en[j]);
					(docs[i].cluster === docs[j].cluster ? sameCluster : crossCluster).push(s);
				}
			}
			const margin = Math.min(...trans) - Math.max(...crossCluster);
			const ordered = mean(trans) > mean(sameCluster) && mean(sameCluster) > mean(crossCluster);

			const row = {
				label: runtime.label, model: runtime.model, dims, seconds: +secs.toFixed(1),
				alignment,
				separation: {
					translation: { mean: mean(trans), min: Math.min(...trans), p5: quantile(trans, 0.05) },
					sameCluster: { mean: mean(sameCluster), max: Math.max(...sameCluster) },
					crossCluster: { mean: mean(crossCluster), max: Math.max(...crossCluster) },
					margin, orderingPreserved: ordered,
					spread: mean(trans) - mean(crossCluster),
				},
			};
			results.push(row);
			for (const [lang, r] of Object.entries(alignment)) {
				console.log(`  align en->${lang}: P@1 ${(r.p1 * 100).toFixed(1)}%  MRR ${r.mrr.toFixed(4)}  worstRank ${r.worstRank}`);
			}
			console.log(`  separation: translation ${row.separation.translation.mean.toFixed(4)} | same-cluster ${row.separation.sameCluster.mean.toFixed(4)} | cross-cluster ${row.separation.crossCluster.mean.toFixed(4)}`);
			console.log(`  spread ${row.separation.spread.toFixed(4)}  margin ${margin.toFixed(4)}  ordering ${ordered ? 'PRESERVED' : '** BROKEN **'}`);
		}

		console.log('\n\n=== SUMMARY ===');
		const cols = ['config', 'dims', 'en->fr P@1', 'en->ja P@1', 'transl.', 'same-cl', 'cross-cl', 'spread', 'margin', 'order'];
		const rows = results.map(r => r.error
			? [r.label, 'ERR', '-', '-', '-', '-', '-', '-', '-', '-']
			: [
				r.label, String(r.dims),
				r.alignment.fr ? `${(r.alignment.fr.p1 * 100).toFixed(1)}%` : '-',
				r.alignment.ja ? `${(r.alignment.ja.p1 * 100).toFixed(1)}%` : '-',
				r.separation.translation.mean.toFixed(4),
				r.separation.sameCluster.mean.toFixed(4),
				r.separation.crossCluster.mean.toFixed(4),
				r.separation.spread.toFixed(4),
				r.separation.margin.toFixed(4),
				r.separation.orderingPreserved ? 'ok' : 'BROKEN',
			]);
		const w = cols.map((c, i) => Math.max(c.length, ...rows.map(r => r[i].length)));
		const line = cs => cs.map((c, i) => String(c).padEnd(w[i])).join('  ');
		console.log(line(cols));
		console.log(w.map(x => '-'.repeat(x)).join('  '));
		for (const r of rows) console.log(line(r));

		if (args.json) {
			writeFileSync(resolve(args.json), JSON.stringify({ dataset: { name: ds.name, sha256: ds.sha256, n: docs.length }, results }, null, 1));
			console.log(`\nwrote ${args.json}`);
		}
	})();
}

main();
