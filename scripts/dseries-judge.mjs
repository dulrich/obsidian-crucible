#!/usr/bin/env node
/* global process */
// The D-series blind pairwise preference harness: three phases, deliberately separated.
//
//   prepare  run both arms over the query set, randomise left/right per query, freeze a session
//   judge    present the pairs unlabelled and record forced choices
//   report   preference rate, Wilson CI, exact n, subgroup split, per-query table
//
// Why three phases and not one. The blind is the whole design (protocol §6.3): knowing which
// configuration produced a ranking contaminates the judgment, and a self-judged nDCG has no
// defence against that. Separating `prepare` from `judge` means the retrieval work — the part that
// prints arm names, model ids and timings — finishes and scrolls away before the judging screen
// exists, and `judge` reads only the frozen session, which carries the assignment but never shows
// it. Separating `report` means a judgment cannot be revised after seeing which arm it favoured.
//
// The randomisation is seeded and recorded so the assignment is auditable after the fact. That is
// not a weakening of the blind: an auditor reads the session file afterwards, the judge does not.
//
// An arm is `label:vaultId:mode[:runtimeSpec]` where mode is fts | vector | rerank:
//
//   node scripts/dseries-judge.mjs prepare --queries runs/.../S2-queries.json \
//     --a 'fts:d-bge-m3-f16:fts' \
//     --b 'vector:d-bge-m3-f16:vector:gpu=http://127.0.0.1:4804/v1,bge-m3,openai' \
//     --space 'BAAI/bge-m3/f16' --out runs/.../D1-fts-vs-vector.json
//   node scripts/dseries-judge.mjs judge  --session runs/.../D1-fts-vs-vector.json
//   node scripts/dseries-judge.mjs report --session runs/.../D1-fts-vs-vector.json

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseRuntimeSpec, embedBatch, normalizeDefensively } from './lib/embed-runtime.mjs';

const DEFAULT_TARGET = 'http://127.0.0.1:4811';
const DEFAULT_LIMIT = 10;
// The rerank window: how many FTS/vector hits are re-scored before the top-10 is cut. 30 is the
// plugin's `searchRerankTopN` default, and arm C measured its cost at 280ms on the GPU.
const DEFAULT_RERANK_TOP_N = 30;

const USAGE = `Usage: node scripts/dseries-judge.mjs <prepare|judge|report> [options]

prepare  --queries <path>   S2 query set: JSON array of
                            {id, text, source: "troublesome"|"fill",
                             targetPaths?: string[],   // known answer notes -> rank reporting
                             answerable?: boolean}     // false = answer provably not in the vault
         --a <arm>          label:vaultId:mode[:runtimeSpec]   mode = fts | vector | rerank
         --b <arm>          the other arm
         --space <id>       embedding_space to send with query vectors (both arms)
         --out <path>       session file to write
         --target <url>     companion. Default: ${DEFAULT_TARGET}
         --limit <n>        results per arm. Default: ${DEFAULT_LIMIT}
         --rerank-url <url> rerank endpoint for mode=rerank. Default: http://127.0.0.1:4805/rerank
         --rerank-model <m> rerank model id
         --rerank-top-n <n> rerank window. Default: ${DEFAULT_RERANK_TOP_N}
         --seed <s>         randomisation seed. Default: a timestamp, recorded either way

judge    --session <path>   [--resume] continue a partly-judged session (default)
report   --session <path>   [--json <path>]
`;

function parseArgs(argv) {
	const out = { target: DEFAULT_TARGET, limit: DEFAULT_LIMIT, rerankTopN: DEFAULT_RERANK_TOP_N };
	out.phase = argv[2];
	for (let i = 3; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--queries') out.queries = argv[++i];
		else if (a === '--a') out.a = argv[++i];
		else if (a === '--b') out.b = argv[++i];
		else if (a === '--space') out.space = argv[++i];
		else if (a === '--out') out.out = argv[++i];
		else if (a === '--session') out.session = argv[++i];
		else if (a === '--target') out.target = argv[++i].replace(/\/+$/, '');
		else if (a === '--limit') out.limit = Number(argv[++i]);
		else if (a === '--rerank-url') out.rerankUrl = argv[++i];
		else if (a === '--rerank-model') out.rerankModel = argv[++i];
		else if (a === '--rerank-top-n') out.rerankTopN = Number(argv[++i]);
		else if (a === '--seed') out.seed = argv[++i];
		else if (a === '--json') out.json = argv[++i];
		else if (a === '--resume') out.resume = true;
		else if (a === '--help' || a === '-h') out.help = true;
		else throw new Error(`Unrecognized argument: ${a}`);
	}
	return out;
}

// label:vaultId:mode[:runtimeSpec]. The runtime spec itself contains commas but no colons before
// its own URL's, so split off exactly three fields and keep the remainder whole.
function parseArm(spec) {
	const parts = spec.split(':');
	if (parts.length < 3) throw new Error(`Arm must be label:vaultId:mode[:runtimeSpec]: ${spec}`);
	const [label, vaultId, mode] = parts;
	const runtimeSpec = parts.slice(3).join(':');
	if (!['fts', 'vector', 'rerank'].includes(mode)) {
		throw new Error(`Arm mode must be fts|vector|rerank: ${spec}`);
	}
	if (mode !== 'fts' && !runtimeSpec) {
		throw new Error(`Arm mode "${mode}" needs a runtime spec for the query embedding: ${spec}`);
	}
	return { label, vaultId, mode, runtime: runtimeSpec ? parseRuntimeSpec(runtimeSpec) : null, spec };
}

// Deterministic from (seed, queryId): re-running prepare with the same seed reproduces the same
// left/right assignment, and the assignment cannot correlate with query order.
function sideForQuery(seed, queryId) {
	const h = createHash('sha256').update(`${seed}\0${queryId}`).digest();
	return (h[0] & 1) === 0 ? 'a-left' : 'b-left';
}

async function postJson(url, body, timeoutMs = 60_000) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${text.slice(0, 300)}`);
	return JSON.parse(text);
}

async function embedQuery(runtime, text) {
	const [vec] = await embedBatch(runtime, [text]);
	return normalizeDefensively(vec);
}

async function rerankResults(opts, query, results) {
	const documents = results.map(r => `${r.title}${r.heading ? ' — ' + r.heading : ''}\n${r.snippet ?? ''}`);
	const json = await postJson(opts.rerankUrl, { model: opts.rerankModel, query, documents });
	const scored = (json.results ?? []).map(r => ({
		result: results[r.index],
		// llama.cpp returns raw logits, Infinity sigmoid-normalised 0-1. Higher is better in both,
		// so sorting is safe — but the score itself is not comparable across servers and must
		// never be thresholded. See docs/local-inference.md.
		score: r.relevance_score ?? r.score,
	}));
	scored.sort((x, y) => y.score - x.score);
	return scored.map(s => s.result);
}

async function runArm(arm, query, opts) {
	const body = { vaultId: arm.vaultId, query: query.text, limit: arm.mode === 'rerank' ? opts.rerankTopN : opts.limit };
	if (arm.mode !== 'fts') {
		body.queryEmbedding = await embedQuery(arm.runtime, query.text);
		if (opts.space) body.embeddingSpace = opts.space;
	}
	const res = await postJson(`${opts.target}/v1/search`, body);
	let results = res.results ?? [];
	if (arm.mode === 'rerank') results = (await rerankResults(opts, query.text, results)).slice(0, opts.limit);
	return {
		mode: res.mode,
		semanticAvailable: res.semanticAvailable,
		message: res.message,
		results: results.slice(0, opts.limit).map(r => ({
			path: r.path, title: r.title, heading: r.heading, snippet: r.snippet,
		})),
	};
}

// 1-based rank of the first result matching any known-good path, or null for "not in the list"
// (which includes "no ground truth declared" — the two are distinguished by the caller having
// targetPaths at all, never by conflating absent with missed).
function targetRank(arm, targetPaths) {
	if (!targetPaths?.length) return undefined;
	const idx = arm.results.findIndex(r => targetPaths.includes(r.path));
	return idx === -1 ? null : idx + 1;
}

async function prepare(opts) {
	if (!opts.queries || !opts.a || !opts.b || !opts.out) throw new Error(`prepare needs --queries, --a, --b, --out\n\n${USAGE}`);
	const armA = parseArm(opts.a);
	const armB = parseArm(opts.b);
	const queries = JSON.parse(readFileSync(opts.queries, 'utf8'));
	if (!Array.isArray(queries) || !queries.length) throw new Error(`${opts.queries} is not a non-empty JSON array`);
	for (const q of queries) {
		if (!q.id || !q.text) throw new Error(`Every query needs {id, text}: ${JSON.stringify(q)}`);
		if (q.source !== 'troublesome' && q.source !== 'fill') {
			throw new Error(`Query ${q.id}: source must be "troublesome" or "fill" — the two subgroups are reported separately, never pooled`);
		}
		// `answerable: false` means the vault provably does not contain what the query is looking
		// for. Such a query still belongs in the set — "what does the system do when the answer is
		// not there" is a real question, and the honest answer for a vector leg is "it returns ten
		// confident irrelevant results" — but its preference judgments are a coin flip between two
		// wrong answer sets, so pooling it into the troublesome rate would drag that rate toward
		// 50% and understate the vector leg on the queries it can actually serve.
		if (q.answerable === false && q.targetPaths?.length) {
			throw new Error(`Query ${q.id}: answerable:false contradicts targetPaths`);
		}
	}
	const seed = opts.seed ?? String(Date.now());
	const rerankOpts = {
		...opts,
		rerankUrl: opts.rerankUrl ?? 'http://127.0.0.1:4805/rerank',
		rerankModel: opts.rerankModel ?? 'bge-reranker-v2-m3',
	};

	const pairs = [];
	for (const q of queries) {
		process.stderr.write(`  ${q.id} …\r`);
		const a = await runArm(armA, q, rerankOpts);
		const b = await runArm(armB, q, rerankOpts);
		// Where the answer note is known, the rank it lands at is ground truth and outranks any
		// preference judgment as evidence — the same reason arm A4's translation pairs settled the
		// cross-encoder question that a four-document demonstration could not.
		a.targetRank = targetRank(a, q.targetPaths);
		b.targetRank = targetRank(b, q.targetPaths);
		pairs.push({ query: q, side: sideForQuery(seed, q.id), a, b, judgment: null });
	}
	process.stderr.write('\n');

	// Blinding self-check. If one arm's rankings are trivially identifiable — because they are
	// identical to the other's, or because the arm silently fell back to FTS — the blind did not
	// hold and the run record has to say so rather than pretending otherwise.
	const identical = pairs.filter(p => JSON.stringify(p.a.results.map(r => r.path)) === JSON.stringify(p.b.results.map(r => r.path)));
	const degraded = pairs.filter(p => (armA.mode !== 'fts' && p.a.mode === 'fts') || (armB.mode !== 'fts' && p.b.mode === 'fts'));

	// Result-count asymmetry is the tell that actually bites, and it bites hardest exactly where
	// the measurement matters. A vector arm returns its k nearest neighbours for any query, so it
	// fills to `limit` always; an FTS-only arm returns only genuine keyword matches, so on a query
	// whose answer shares no vocabulary with it — the troublesome subgroup, the population this
	// whole leg exists to serve — it comes back short. The longer column is then the vector arm
	// nearly every time, and a judge notices that within a few pairs.
	//
	// It is NOT fixed by truncating both columns to the shorter one: those extra results are the
	// vector leg's entire contribution on such a query, and hiding them would measure away the
	// effect under test. So it is surfaced instead — recorded here, marked in the judging view,
	// and reported — per protocol §6.3, which asks for exactly this admission rather than a
	// pretence that the blind held. Residual risk is expectation bias (a judge who has worked out
	// which side is keyword-only may expect the other to win), which is real but strictly weaker
	// than knowing the arm label, and belongs in the run record as a stated limitation.
	const asymmetric = pairs
		.filter(p => p.a.results.length !== p.b.results.length)
		.map(p => ({ id: p.query.id, source: p.query.source, a: p.a.results.length, b: p.b.results.length }));
	const aShorter = asymmetric.filter(x => x.a < x.b).length;
	const bShorter = asymmetric.filter(x => x.b < x.a).length;

	const session = {
		generatedAt: new Date().toISOString(),
		target: opts.target, space: opts.space ?? null, limit: opts.limit,
		rerankTopN: opts.rerankTopN, seed,
		armA: { ...armA, runtime: armA.runtime }, armB: { ...armB, runtime: armB.runtime },
		blindingNotes: {
			identicalRankings: identical.map(p => p.query.id),
			degradedToFts: degraded.map(p => p.query.id),
			resultCountAsymmetry: { pairs: asymmetric, aShorterCount: aShorter, bShorterCount: bShorter },
		},
		pairs,
	};
	writeFileSync(opts.out, JSON.stringify(session, null, 2) + '\n');

	console.log(`Prepared ${pairs.length} pairs -> ${opts.out}`);
	console.log(`  A: ${armA.label} (${armA.vaultId}, ${armA.mode})`);
	console.log(`  B: ${armB.label} (${armB.vaultId}, ${armB.mode})`);
	console.log(`  seed: ${seed}`);
	if (identical.length) console.log(`  NOTE: ${identical.length}/${pairs.length} pairs have identical rankings — those are forced "indistinguishable".`);
	if (degraded.length) console.log(`  WARNING: ${degraded.length} pairs where a vector arm answered in FTS mode. Check the index and space before judging.`);
	if (asymmetric.length) {
		console.log(`  BLIND LIMITATION: ${asymmetric.length}/${pairs.length} pairs return different result counts`
			+ ` (${armA.label} shorter ${aShorter}x, ${armB.label} shorter ${bShorter}x).`);
		console.log(`  A consistently shorter column is an arm tell. Not corrected — truncating would hide the effect`);
		console.log(`  under test — so it is recorded and must be stated as a limitation in the run record.`);
	}
	console.log(`\nJudge with: node scripts/dseries-judge.mjs judge --session ${opts.out}`);
}

function truncate(s, n) {
	const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
	return flat.length <= n ? flat : flat.slice(0, n - 1) + '…';
}

// `otherLength` only decides whether to print the end-of-results marker. A column that simply ran
// out otherwise renders as trailing blank lines, which reads as a display glitch; the marker says
// "this ranking has nothing further to offer", which is the fact the judge is meant to weigh.
function renderColumn(arm, width, otherLength) {
	const rows = arm.results.map((r, i) => {
		const head = `${String(i + 1).padStart(2)}. ${truncate(r.path, width - 4)}`;
		const sub = `    ${truncate(r.heading || r.snippet, width - 4)}`;
		return [head, sub];
	});
	if (arm.results.length < otherLength) rows.push(['    (no further results)', '']);
	return rows;
}

// Resolves to 'q' if the input closes (Ctrl-D, or a piped stdin running out) instead of leaving
// the promise pending forever — which Node answers by exiting silently mid-sitting, losing nothing
// but reporting nothing either.
function ask(rl, question) {
	return new Promise(resolve => {
		const onClose = () => resolve('q');
		rl.once('close', onClose);
		rl.question(question, answer => {
			rl.off('close', onClose);
			resolve(answer.trim().toLowerCase());
		});
	});
}

async function judge(opts) {
	if (!opts.session) throw new Error(`judge needs --session\n\n${USAGE}`);
	const session = JSON.parse(readFileSync(opts.session, 'utf8'));
	const width = Math.max(40, Math.floor(((process.stdout.columns || 160) - 5) / 2));
	const rl = createInterface({ input: process.stdin, output: process.stdout });

	const pending = session.pairs.filter(p => p.judgment === null);
	console.log(`\n${pending.length} of ${session.pairs.length} pairs to judge.`);
	console.log(`Choose the ranking you would rather have been given for the query.`);
	console.log(`  [l] left   [r] right   [i] genuinely indistinguishable   [q] stop and save\n`);

	let n = 0;
	for (const pair of session.pairs) {
		if (pair.judgment !== null) continue;
		n++;
		// The arm labels live in the session and are deliberately not printed here.
		const aLeft = pair.side === 'a-left';
		const left = aLeft ? pair.a : pair.b;
		const right = aLeft ? pair.b : pair.a;

		console.log('\n' + '═'.repeat(width * 2 + 5));
		console.log(`(${n}/${pending.length})  ${pair.query.text}`);
		console.log('─'.repeat(width * 2 + 5));
		console.log(`${'LEFT'.padEnd(width)}  |  RIGHT`);
		const lc = renderColumn(left, width, right.results.length);
		const rc = renderColumn(right, width, left.results.length);
		for (let i = 0; i < Math.max(lc.length, rc.length); i++) {
			const [lh, ls] = lc[i] ?? ['', ''];
			const [rh, rs] = rc[i] ?? ['', ''];
			console.log(`${lh.padEnd(width)}  |  ${rh}`);
			console.log(`${ls.padEnd(width)}  |  ${rs}`);
		}
		console.log('─'.repeat(width * 2 + 5));

		let answer = '';
		while (!['l', 'r', 'i', 'q'].includes(answer)) answer = await ask(rl, 'left / right / indistinguishable  [l/r/i/q]: ');
		if (answer === 'q') break;
		// Recorded as the *arm*, resolved through the side assignment, so the report never has to
		// re-derive which column was which.
		pair.judgment = answer === 'i' ? 'indistinguishable' : ((answer === 'l') === aLeft ? 'a' : 'b');
		pair.judgedAt = new Date().toISOString();
		writeFileSync(opts.session, JSON.stringify(session, null, 2) + '\n');
	}
	rl.close();

	const judged = session.pairs.filter(p => p.judgment !== null).length;
	console.log(`\nSaved. ${judged}/${session.pairs.length} judged.`);
	if (judged < session.pairs.length) console.log(`Resume with the same command; judged pairs are skipped.`);
	else console.log(`\nReport with: node scripts/dseries-judge.mjs report --session ${opts.session}`);
}

// Wilson score interval — not the normal approximation, which is badly wrong at the small n and
// near-0/near-1 rates this test will routinely produce (25 queries, possibly 24 preferences).
function wilson(successes, total, z = 1.96) {
	if (!total) return [0, 0];
	const p = successes / total;
	const d = 1 + (z * z) / total;
	const centre = p + (z * z) / (2 * total);
	const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
	return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

function summarize(pairs, armALabel, armBLabel) {
	const judged = pairs.filter(p => p.judgment !== null);
	const a = judged.filter(p => p.judgment === 'a').length;
	const b = judged.filter(p => p.judgment === 'b').length;
	const tie = judged.filter(p => p.judgment === 'indistinguishable').length;
	const decisive = a + b;
	// Two denominators, both reported. Over decisive calls it answers "when the judge could tell,
	// which won"; over all judged calls it answers "how often did this arm win at all", which the
	// first silently inflates when most pairs are ties.
	const [loD, hiD] = wilson(b, decisive);
	const [loA, hiA] = wilson(b, judged.length);
	return {
		n: judged.length, decisive, a, b, tie, armALabel, armBLabel,
		bRateOfDecisive: decisive ? b / decisive : null, ciDecisive: [loD, hiD],
		bRateOfAll: judged.length ? b / judged.length : null, ciAll: [loA, hiA],
	};
}

function pct(x) { return x === null ? '   —  ' : `${(x * 100).toFixed(1)}%`; }

function printSummary(title, s) {
	console.log(`\n${title}`);
	if (!s.n) { console.log('  (no judgments)'); return; }
	console.log(`  n = ${s.n}   decisive = ${s.decisive}   indistinguishable = ${s.tie}`);
	console.log(`  ${s.armALabel}: ${s.a}    ${s.armBLabel}: ${s.b}`);
	console.log(`  ${s.armBLabel} preferred, of decisive calls: ${pct(s.bRateOfDecisive)}  95% CI [${pct(s.ciDecisive[0])}, ${pct(s.ciDecisive[1])}]`);
	console.log(`  ${s.armBLabel} preferred, of all judged:     ${pct(s.bRateOfAll)}  95% CI [${pct(s.ciAll[0])}, ${pct(s.ciAll[1])}]`);
}

function report(opts) {
	if (!opts.session) throw new Error(`report needs --session\n\n${USAGE}`);
	const session = JSON.parse(readFileSync(opts.session, 'utf8'));
	const A = session.armA.label, B = session.armB.label;

	console.log(`\nBlind pairwise preference — ${A} vs ${B}`);
	console.log(`Session: ${opts.session}   prepared ${session.generatedAt}   seed ${session.seed}`);
	console.log(`A = ${A} (${session.armA.vaultId}, ${session.armA.mode})`);
	console.log(`B = ${B} (${session.armB.vaultId}, ${session.armB.mode})`);

	const answerable = p => p.query.answerable !== false;
	const troublesome = session.pairs.filter(p => p.query.source === 'troublesome' && answerable(p));
	const unanswerable = session.pairs.filter(p => p.query.answerable === false);
	const fill = session.pairs.filter(p => p.query.source === 'fill' && answerable(p));
	// Never pooled: the troublesome queries are an observed failure of keyword retrieval and the
	// population the vector leg exists to serve. Pooling lets easy fill queries mask them, and
	// pooling the unanswerable ones drags the rate toward 50% from two wrong answer sets.
	printSummary('TROUBLESOME subgroup (the user\'s own hard retrievals, answer present in vault)', summarize(troublesome, A, B));
	printSummary('FILL subgroup', summarize(fill, A, B));
	if (unanswerable.length) {
		printSummary('UNANSWERABLE subgroup (answer provably NOT in the vault — read as behaviour, not quality)', summarize(unanswerable, A, B));
	}
	printSummary('All queries (context only — the subgroups above are the result)', summarize(session.pairs, A, B));

	// Ground truth, where it exists, reported before and separately from preference: a rank is a
	// fact, a preference is a judgment.
	const withTruth = session.pairs.filter(p => p.query.targetPaths?.length);
	if (withTruth.length) {
		console.log(`\nGROUND TRUTH — rank of the known answer note (lower is better, "miss" = absent from top ${session.limit})`);
		let hitA = 0, hitB = 0;
		for (const p of withTruth) {
			const ra = p.a.targetRank, rb = p.b.targetRank;
			if (ra != null) hitA++;
			if (rb != null) hitB++;
			console.log(`  ${truncate(p.query.text, 52).padEnd(54)} ${A}: ${String(ra ?? 'miss').padStart(4)}   ${B}: ${String(rb ?? 'miss').padStart(4)}`);
		}
		console.log(`  ${'hit rate'.padEnd(54)} ${A}: ${hitA}/${withTruth.length}   ${B}: ${hitB}/${withTruth.length}`);
		console.log(`  This is evidence of a different kind from the preference rates above. Where the two`);
		console.log(`  disagree, the ranks are the stronger claim — cite them first.`);
	}

	console.log(`\nPer-query:`);
	for (const p of session.pairs) {
		const verdict = p.judgment === 'a' ? A : p.judgment === 'b' ? B : p.judgment ?? '(unjudged)';
		console.log(`  [${p.query.source.padEnd(11)}] ${truncate(p.query.text, 58).padEnd(60)} ${verdict}`);
	}

	const notes = session.blindingNotes ?? {};
	const asym = notes.resultCountAsymmetry;
	if (notes.identicalRankings?.length || notes.degradedToFts?.length || asym?.pairs?.length) {
		console.log(`\nBlinding notes:`);
		if (notes.identicalRankings?.length) console.log(`  identical rankings (blind could not hold): ${notes.identicalRankings.join(', ')}`);
		if (notes.degradedToFts?.length) console.log(`  vector arm answered in FTS mode: ${notes.degradedToFts.join(', ')}`);
		if (asym?.pairs?.length) {
			const troubleAsym = asym.pairs.filter(x => x.source === 'troublesome').length;
			console.log(`  result-count asymmetry: ${asym.pairs.length}/${session.pairs.length} pairs`
				+ ` (${A} shorter ${asym.aShorterCount}x, ${B} shorter ${asym.bShorterCount}x;`
				+ ` ${troubleAsym} of them in the troublesome subgroup)`);
			console.log(`    A consistently shorter column is an arm tell, and it concentrates in the subgroup that`);
			console.log(`    matters most. The preference rates above are contaminated by expectation bias to that`);
			console.log(`    extent — state it as a limitation; do not report them as a fully blind result.`);
		}
	}

	console.log(`\nThis is a preference test. It reports which ranking was preferred and how often —`);
	console.log(`never how much better one is. Do not restate these numbers as nDCG, MRR or P@k.`);

	if (opts.json) {
		writeFileSync(opts.json, JSON.stringify({
			session: opts.session, armA: session.armA, armB: session.armB, seed: session.seed,
			troublesome: summarize(troublesome, A, B), fill: summarize(fill, A, B),
			unanswerable: summarize(unanswerable, A, B), all: summarize(session.pairs, A, B),
			groundTruth: withTruth.map(p => ({ id: p.query.id, targetPaths: p.query.targetPaths, aRank: p.a.targetRank, bRank: p.b.targetRank })),
			perQuery: session.pairs.map(p => ({
				id: p.query.id, text: p.query.text, source: p.query.source,
				answerable: p.query.answerable !== false, judgment: p.judgment,
			})),
			blindingNotes: notes,
		}, null, 2) + '\n');
		console.log(`\nWrote ${opts.json}`);
	}
}

async function main() {
	const opts = parseArgs(process.argv);
	if (opts.help || !opts.phase) { console.log(USAGE); return; }
	if (opts.phase === 'prepare') await prepare(opts);
	else if (opts.phase === 'judge') await judge(opts);
	else if (opts.phase === 'report') report(opts);
	else throw new Error(`Unknown phase "${opts.phase}"\n\n${USAGE}`);
}

main().catch(err => {
	console.error(`\n${err.stack || err.message}`);
	process.exit(1);
});
