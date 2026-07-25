#!/usr/bin/env node
/* global process */
// Samples a search companion's /health over time and reports the end-to-end embedding rate.
//
// This is the plugin half of arm E1. The raw-endpoint rate is easy — point a harness at the
// embeddings server and divide — but the number that describes what a user actually waits for is
// the rate achieved *through* `SearchManager.indexFiles`, which additionally reads and chunks
// every file on the main thread, batches, and round-trips the companion. That path cannot be
// driven from outside Obsidian, so it is measured from the outside instead: `embeddedChunks` in
// `/health` is a monotonic counter during a backfill, and its slope is the plugin-path rate.
//
// E1 is a PAIRED comparison and the pairing is the point: run the raw arm in the same session,
// against the same runtime, at the same batch size, immediately before or after the plugin pass.
// The ~0.68 factor currently in the record was inferred across two different sessions, which is
// exactly the kind of cross-session comparison this protocol exists to stop making.
//
// Reports the slope over a trailing window rather than since-start, because a backfill's rate is
// not constant: it stalls on large files, and a since-start average silently folds the ramp-up
// and any idle tail into the figure.
//
//   node scripts/index-rate-monitor.mjs --json runs/.../E1-plugin-pass.json
//   (start it BEFORE the indexing pass; Ctrl-C when the pass finishes)

import { writeFileSync } from 'node:fs';

const DEFAULT_TARGET = 'http://127.0.0.1:4801';
const DEFAULT_INTERVAL_MS = 5000;
// Trailing window for the reported rate. Long enough to smooth a single slow batch, short enough
// that a stall shows up as a stall rather than being averaged away.
const WINDOW_MS = 60_000;
// After this long with no new chunks the pass is treated as finished, and the summary's wall
// clock stops at the last sample that moved rather than at Ctrl-C.
const IDLE_END_MS = 120_000;

const USAGE = `Usage: node scripts/index-rate-monitor.mjs [options]

  --target <url>     Companion to watch. Default: ${DEFAULT_TARGET}
  --interval <ms>    Poll interval. Default: ${DEFAULT_INTERVAL_MS}
  --json <path>      Write the full sample series and summary on exit.
`;

function parseArgs(argv) {
	const out = { target: DEFAULT_TARGET, interval: DEFAULT_INTERVAL_MS, json: null };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--target') out.target = argv[++i].replace(/\/+$/, '');
		else if (a === '--interval') out.interval = Number(argv[++i]);
		else if (a === '--json') out.json = argv[++i];
		else if (a === '--help' || a === '-h') out.help = true;
		else throw new Error(`Unrecognized argument: ${a}`);
	}
	return out;
}

function formatDuration(ms) {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

// Slope across the trailing window, in chunks/s. Null until the window has two samples in it.
function windowRate(samples) {
	const now = samples[samples.length - 1];
	const cutoff = now.t - WINDOW_MS;
	const first = samples.find(s => s.t >= cutoff) ?? samples[0];
	const dt = (now.t - first.t) / 1000;
	if (dt <= 0) return null;
	return (now.embedded - first.embedded) / dt;
}

async function main() {
	const args = parseArgs(process.argv);
	if (args.help) { console.log(USAGE); return; }

	const samples = [];
	let stopping = false;
	process.on('SIGINT', () => { stopping = true; });

	console.log(`Watching ${args.target} every ${args.interval}ms. Ctrl-C to stop and summarize.\n`);
	console.log(`time      embedded   +delta   rate (60s)   note`);

	while (!stopping) {
		let health;
		try {
			health = await (await fetch(`${args.target}/health`, { signal: AbortSignal.timeout(5000) })).json();
		} catch (e) {
			console.log(`${new Date().toISOString().slice(11, 19)}  — unreachable: ${e.message}`);
			await new Promise(r => setTimeout(r, args.interval));
			continue;
		}
		const now = { t: Date.now(), embedded: Number(health.embeddedChunks ?? 0), spaces: health.embeddingSpaces };
		const prev = samples[samples.length - 1];
		samples.push(now);
		const delta = prev ? now.embedded - prev.embedded : 0;
		const rate = samples.length > 1 ? windowRate(samples) : null;
		const idleFor = (() => {
			for (let i = samples.length - 1; i > 0; i--) if (samples[i].embedded !== samples[i - 1].embedded) return now.t - samples[i].t;
			return now.t - samples[0].t;
		})();
		const note = delta === 0 && idleFor > IDLE_END_MS ? `idle ${formatDuration(idleFor)}` : '';
		console.log(`${new Date(now.t).toISOString().slice(11, 19)}  ${String(now.embedded).padStart(8)}`
			+ `  ${String(delta >= 0 ? '+' + delta : delta).padStart(7)}`
			+ `  ${(rate === null ? '—' : rate.toFixed(2)).padStart(10)}   ${note}`);
		await new Promise(r => setTimeout(r, args.interval));
	}

	// Summary over the active span only: first sample that moved, to last sample that moved.
	const moved = [];
	for (let i = 1; i < samples.length; i++) if (samples[i].embedded !== samples[i - 1].embedded) moved.push(i);
	console.log('');
	if (moved.length < 2) {
		console.log('No sustained progress observed — nothing to summarize.');
	} else {
		const startIdx = moved[0] - 1, endIdx = moved[moved.length - 1];
		const span = (samples[endIdx].t - samples[startIdx].t) / 1000;
		const chunks = samples[endIdx].embedded - samples[startIdx].embedded;
		const rates = [];
		for (let i = startIdx + 1; i <= endIdx; i++) {
			const dt = (samples[i].t - samples[i - 1].t) / 1000;
			if (dt > 0) rates.push((samples[i].embedded - samples[i - 1].embedded) / dt);
		}
		rates.sort((a, b) => a - b);
		const p = q => rates[Math.min(rates.length - 1, Math.floor(q * rates.length))];
		console.log(`Active span:  ${formatDuration(span * 1000)}`);
		console.log(`Chunks:       ${chunks}`);
		console.log(`Mean rate:    ${(chunks / span).toFixed(2)} chunks/s   <- this is the E1 plugin-path figure`);
		console.log(`Per-interval: p50 ${p(0.5).toFixed(2)}  p95 ${p(0.95).toFixed(2)}  max ${rates[rates.length - 1].toFixed(2)} chunks/s`);
		console.log(`\nPair this against a raw-endpoint run in THIS session before quoting a ratio.`);
	}

	if (args.json) {
		writeFileSync(args.json, JSON.stringify({
			generatedAt: new Date().toISOString(), target: args.target, intervalMs: args.interval,
			windowMs: WINDOW_MS, samples,
		}, null, 2) + '\n');
		console.log(`\nWrote ${args.json}`);
	}
}

main().catch(err => {
	console.error(`\n${err.stack || err.message}`);
	process.exit(1);
});
