#!/usr/bin/env node
/* global process */
// Builds one D-series experiment index: copies the corpus out of an index snapshot, re-embeds it
// through a chosen runtime, and upserts it into a *second* companion under its own vaultId.
//
// Why this exists. Arms D1-D4 compare retrieval quality across ranking modes, embedding spaces and
// embedding models, which means several indexes over one identical corpus. Building them through
// the plugin is not an option — Obsidian holds one embedding configuration at a time and each
// rebuild would take the live index with it — so the corpus comes from a `VACUUM INTO` snapshot
// (`npm run search:snapshot`) and the vectors are produced here.
//
// Three properties this design buys, each load-bearing for D:
//
//   1. **The corpus is byte-identical across arms.** Chunk text, path, ordinal and heading are
//      copied verbatim from one snapshot, so a difference between two arms cannot be a difference
//      in what was indexed. Re-chunking per arm would void the comparison silently.
//   2. **Chunk ids are reused, not re-derived.** The companion keys on `(vault_id, id)` and never
//      recomputes an id, so the same chunk carries the same id in every arm — which is what makes
//      two arms' top-10 lists directly comparable, and what lets the judging harness align them.
//      (`stableChunkId` folds the vaultId into its hash as of schema 5, so ids re-derived per arm
//      would NOT line up. Copying is not a shortcut here; it is the correct thing.)
//   3. **One companion, one database, a vaultId per arm.** The upsert's width-and-space guard is
//      vault-wide, so each arm's space sits in its own vault and cannot contaminate another. The
//      protocol's "never a second vaultId" rule is about the *live* index, which this never
//      touches — the experiment companion is a separate process on a separate port and file.
//
// D1 (FTS-only / +vector / +rerank) needs only ONE index: the ranking mode is a query-time choice,
// so the FTS-only arm is the same index searched without a query embedding.
//
//   node scripts/dseries-index.mjs --vault d-bge-m3-f16 \
//     gpu=http://127.0.0.1:4804/v1,bge-m3,openai --space 'BAAI/bge-m3/f16'

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseRuntimeSpec, embedAll, newNormStats } from './lib/embed-runtime.mjs';

const SNAPSHOT_DIR = join(homedir(), 'crucible-search-backups');
const DEFAULT_TARGET = 'http://127.0.0.1:4811';
const DEFAULT_BATCH = 96;
const DEFAULT_GROUP_CHUNKS = 400;
// Long enough for an upsert group to be embedded and written; the interactive 5s timeout the
// plugin uses would race local work here, exactly as it did during the first full rebuild.
const REQUEST_TIMEOUT_MS = 120_000;

const USAGE = `Usage: node scripts/dseries-index.mjs --vault <id> [runtime] [options]

  <runtime>              label=url,model[,kind]   kind is "openai" (default) or "ollama".
                         Omit only with --fts-only.
  --vault <id>           REQUIRED. The arm's vaultId in the experiment companion.
  --snapshot <path>      Corpus source. Default: newest *.sqlite in ~/crucible-search-backups.
  --target <url>         Experiment companion. Default: ${DEFAULT_TARGET}
  --space <id>           embedding_space to stamp. Default: the model id (matches the plugin's
                         behaviour when a runtime reports no precision).
  --model-label <id>     embedding_model to stamp. Default: the runtime's model id.
  --batch <n>            Embedding request batch. Default: ${DEFAULT_BATCH}
  --group-chunks <n>     Chunks per upsert request, rounded up to a path boundary. Default: ${DEFAULT_GROUP_CHUNKS}
  --limit-paths <n>      Index only the first n paths (smoke tests).
  --fts-only             Upsert text with no vectors.
  --no-resume            Re-index paths the target already has covered.
  --json <path>          Write a run record.
`;

function parseArgs(argv) {
	const out = {
		vault: null, snapshot: null, target: DEFAULT_TARGET, space: null, modelLabel: null,
		batch: DEFAULT_BATCH, groupChunks: DEFAULT_GROUP_CHUNKS, limitPaths: 0,
		ftsOnly: false, resume: true, json: null, runtime: null, help: false,
	};
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--vault') out.vault = argv[++i];
		else if (a === '--snapshot') out.snapshot = argv[++i];
		else if (a === '--target') out.target = argv[++i].replace(/\/+$/, '');
		else if (a === '--space') out.space = argv[++i];
		else if (a === '--model-label') out.modelLabel = argv[++i];
		else if (a === '--batch') out.batch = Number(argv[++i]);
		else if (a === '--group-chunks') out.groupChunks = Number(argv[++i]);
		else if (a === '--limit-paths') out.limitPaths = Number(argv[++i]);
		else if (a === '--fts-only') out.ftsOnly = true;
		else if (a === '--no-resume') out.resume = false;
		else if (a === '--json') out.json = argv[++i];
		else if (a === '--help' || a === '-h') out.help = true;
		else if (a.includes('=')) out.runtime = parseRuntimeSpec(a);
		else throw new Error(`Unrecognized argument: ${a}`);
	}
	return out;
}

function findNewestSnapshot() {
	const files = readdirSync(SNAPSHOT_DIR)
		.filter(f => f.endsWith('.sqlite'))
		.map(f => ({ path: join(SNAPSHOT_DIR, f), mtime: statSync(join(SNAPSHOT_DIR, f)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
	if (!files.length) throw new Error(`No .sqlite snapshot in ${SNAPSHOT_DIR} — run: npm run search:snapshot`);
	return files[0].path;
}

// Reads the whole corpus grouped by path. The grouping is not cosmetic: an upsert clears every
// existing row for a (vaultId, path) when it first sees that path *within a request*, so a path
// split across two requests would have its first half deleted by its second.
function readCorpus(snapshotPath, limitPaths) {
	const db = new DatabaseSync(snapshotPath, { readOnly: true });
	try {
		const rows = db.prepare(`SELECT id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json
			FROM chunks ORDER BY path, ordinal`).all();
		const byPath = new Map();
		for (const row of rows) {
			let group = byPath.get(row.path);
			if (!group) {
				if (limitPaths && byPath.size >= limitPaths) break;
				group = [];
				byPath.set(row.path, group);
			}
			group.push(row);
		}
		return byPath;
	} finally {
		db.close();
	}
}

async function postJson(url, body) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${text.slice(0, 400)}`);
	return text ? JSON.parse(text) : null;
}

// A path counts as done only under the same fail-closed conjunction the plugin uses: content hash
// matches AND coverage is total AND the space is the one this arm is building. Anything unknown
// re-indexes — skipping a path that actually needs work is a silent permanent gap in the arm,
// while re-indexing one that did not costs a few seconds.
async function coveredPaths(target, vault, byPath, space, ftsOnly) {
	const paths = [...byPath.keys()];
	const done = new Set();
	for (let i = 0; i < paths.length; i += 500) {
		const slice = paths.slice(i, i + 500);
		const res = await postJson(`${target}/v1/files/state`, { vaultId: vault, paths: slice });
		for (const file of res.files ?? []) {
			const expected = byPath.get(file.path);
			if (!expected || file.chunkCount !== expected.length) continue;
			if (file.contentHash !== expected[0].content_hash) continue;
			if (ftsOnly) { done.add(file.path); continue; }
			if (file.hasEmbeddings && file.embeddingSpace === space) done.add(file.path);
		}
	}
	return done;
}

function formatDuration(ms) {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

async function main() {
	const args = parseArgs(process.argv);
	if (args.help) { console.log(USAGE); return; }
	if (!args.vault) throw new Error(`--vault is required.\n\n${USAGE}`);
	if (!args.runtime && !args.ftsOnly) throw new Error(`A runtime spec is required unless --fts-only.\n\n${USAGE}`);

	const snapshot = args.snapshot ? resolve(args.snapshot) : findNewestSnapshot();
	const modelLabel = args.modelLabel ?? args.runtime?.model ?? null;
	const space = args.space ?? modelLabel;

	const health = await fetch(`${args.target}/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
	if (!health.ok) throw new Error(`Target companion at ${args.target} is not healthy: ${JSON.stringify(health)}`);

	console.log(`Snapshot:   ${snapshot}`);
	console.log(`Target:     ${args.target}  (schema ${health.schemaVersion}, ${health.embeddedChunks} embedded chunks)`);
	console.log(`Vault:      ${args.vault}`);
	console.log(args.ftsOnly
		? 'Runtime:    none (--fts-only)'
		: `Runtime:    ${args.runtime.label} — ${args.runtime.model} @ ${args.runtime.url} (${args.runtime.kind})`);
	if (!args.ftsOnly) console.log(`Space:      ${space}   Model label: ${modelLabel}`);

	const byPath = readCorpus(snapshot, args.limitPaths);
	const totalChunks = [...byPath.values()].reduce((n, g) => n + g.length, 0);
	console.log(`Corpus:     ${totalChunks} chunks across ${byPath.size} paths\n`);

	const skip = args.resume ? await coveredPaths(args.target, args.vault, byPath, space, args.ftsOnly) : new Set();
	if (skip.size) console.log(`Resuming:   ${skip.size} paths already covered, skipping them\n`);

	const normStats = newNormStats();
	const started = Date.now();
	let doneChunks = 0, donePaths = 0, sentChunks = 0;
	const dims = new Set();
	let group = [], groupChunkCount = 0;

	const flush = async () => {
		if (!group.length) return;
		const rows = group.flat();
		let vectors = null;
		if (!args.ftsOnly) {
			vectors = await embedAll(args.runtime, rows.map(r => r.text), args.batch, { normStats });
			for (const v of vectors) dims.add(v.length);
		}
		const chunks = rows.map((row, i) => ({
			id: row.id,
			path: row.path,
			contentHash: row.content_hash,
			title: row.title,
			heading: row.heading,
			text: row.text,
			mtime: row.mtime,
			ordinal: row.ordinal,
			metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
			...(vectors ? { embedding: vectors[i] } : {}),
		}));
		await postJson(`${args.target}/v1/chunks/upsert`, {
			vaultId: args.vault,
			...(args.ftsOnly ? {} : { embeddingModel: modelLabel, embeddingSpace: space }),
			chunks,
		});
		sentChunks += rows.length;
		const elapsed = (Date.now() - started) / 1000;
		const rate = sentChunks / elapsed;
		const remaining = (totalChunks - doneChunks - rows.length) / (rate || 1);
		process.stdout.write(
			`  ${doneChunks + rows.length}/${totalChunks} chunks  ${rate.toFixed(1)}/s  eta ${formatDuration(remaining * 1000)}      \r`);
		doneChunks += rows.length;
		group = [];
		groupChunkCount = 0;
	};

	for (const [path, rows] of byPath) {
		if (skip.has(path)) { doneChunks += rows.length; continue; }
		group.push(rows);
		groupChunkCount += rows.length;
		donePaths++;
		if (groupChunkCount >= args.groupChunks) await flush();
	}
	await flush();
	process.stdout.write('\n');

	const wall = Date.now() - started;
	const finalHealth = await fetch(`${args.target}/health`).then(r => r.json());
	console.log(`\nIndexed ${sentChunks} chunks across ${donePaths} paths in ${formatDuration(wall)}`
		+ (sentChunks ? ` (${(sentChunks / (wall / 1000)).toFixed(1)} chunks/s)` : ''));
	if (!args.ftsOnly) {
		console.log(`Dimensions: ${[...dims].join(', ') || 'none'}`);
		console.log(`Norms:      ${normStats.total} vectors, ${normStats.nonUnit} non-unit, ${normStats.zero} zero`);
	}
	console.log(`Companion:  ${finalHealth.embeddedChunks} embedded chunks, spaces: ${JSON.stringify(finalHealth.embeddingSpaces)}`);

	if (args.json) {
		writeFileSync(args.json, JSON.stringify({
			generatedAt: new Date().toISOString(),
			snapshot, target: args.target, vault: args.vault,
			runtime: args.runtime, embeddingModel: modelLabel, embeddingSpace: space,
			ftsOnly: args.ftsOnly, batch: args.batch, groupChunks: args.groupChunks,
			corpusChunks: totalChunks, corpusPaths: byPath.size,
			indexedChunks: sentChunks, indexedPaths: donePaths, skippedPaths: skip.size,
			wallMs: wall, chunksPerSecond: sentChunks / (wall / 1000),
			dimensions: [...dims], normStats, health: finalHealth,
		}, null, 2) + '\n');
		console.log(`\nRun record: ${args.json}`);
	}
}

main().catch(err => {
	console.error(`\n${err.stack || err.message}`);
	process.exit(1);
});
