// The frontmatter entity facet (schema 7) — source #1: `author`.
//
// The miss this exists to close: a note carrying `author: Matt Pocock` in its frontmatter could
// not be found by searching `matt pocock`, because the chunker parsed the full frontmatter and
// the companion indexed only path/title/heading/text. The facet is deliberately ONE mechanism
// with two sources — frontmatter now, GLiNER2 body-text spans later — so several cases below
// assert the *shape* (an entity is `{text, type, source}`, the companion flattens to text, a
// bare string is accepted) rather than only the behaviour, because that shape is what lets the
// model-sourced source arrive without a second schema bump.
//
// Every case builds its own in-memory SQLite database and, where it needs HTTP, binds an
// ephemeral loopback port of its own. Nothing here touches the live companion on
// 127.0.0.1:4801 or the real index behind it.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

import {
	createRequestHandler,
	createSchema,
	encodeEmbedding,
	matchedEntityTerms,
	migrateFtsEntitiesColumn,
	normalizeChunkEntities,
	normalizeEmbedding,
	SCHEMA_VERSION,
} from '../scripts/search-companion.mjs';

const VAULT = 'test-vault';

// ── Harnesses ────────────────────────────────────────────────────────────────────────────

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-entity-facet-tests');
const chunkerOutfile = path.join(outdir, 'chunker.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/chunker.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile: chunkerOutfile,
	logLevel: 'silent',
});

const {
	buildSearchChunks,
	entityIndexText,
	extractFrontmatterEntities,
	hashSearchContent,
} = await import(pathToFileURL(chunkerOutfile));

function makeDb() {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	return db;
}

async function withServer(db, fn) {
	const server = createServer(createRequestHandler(db));
	await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = async (method, requestPath, body) => {
		const response = await fetch(`${base}${requestPath}`, {
			method,
			headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, json: await response.json() };
	};
	try {
		return await fn(call);
	} finally {
		await new Promise(resolveClose => server.close(resolveClose));
	}
}

function note(notePath, frontmatterLines, body) {
	return ['---', ...frontmatterLines, '---', body].join('\n');
}

// Chunks straight from the real chunker, which is the only producer of the facet today — a test
// that hand-wrote `entities` would pass even if the chunker never emitted them.
function chunksFor(notePath, content) {
	return buildSearchChunks({
		vaultId: VAULT,
		path: notePath,
		basename: notePath.replace(/\.md$/, '').split('/').pop(),
		extension: 'md',
		mtime: 1,
		content,
		maxChars: 400,
		overlapChars: 0,
	});
}

// ── 1. Extraction: the chunker's half ────────────────────────────────────────────────────

test('a scalar `author:` becomes one frontmatter-sourced person entity, on EVERY chunk of the note', () => {
	const content = note('t.md', ['author: Matt Pocock'], [
		'# Generics',
		'Paragraph one. '.repeat(40),
		'',
		'## Inference',
		'Paragraph two. '.repeat(40),
	].join('\n'));
	const chunks = chunksFor('typescript/generics.md', content);

	assert.ok(chunks.length > 1, 'the fixture must produce more than one chunk for this case to mean anything');
	for (const chunk of chunks) {
		assert.deepEqual(chunk.entities, [{ text: 'Matt Pocock', type: 'person', source: 'frontmatter' }]);
	}
	// Not chunk 0 only, and that is a ranking decision rather than a convenience: FTS5's implicit
	// AND is per chunk, so an entity living only on chunk 0 could never co-occur with a body term
	// that lands in chunk 1 — the exact split-terms failure the quality diagnosis blamed.
	assert.equal(chunks.filter(chunk => chunk.entities).length, chunks.length);
});

test('a list `author:` becomes one entity per name, in both YAML list forms', () => {
	const block = chunksFor('a.md', note('a.md', ['author:', '  - Matt Pocock', '  - Sarah Drasner'], 'Body.'));
	const inline = chunksFor('b.md', note('b.md', ['author: [Matt Pocock, Sarah Drasner]'], 'Body.'));
	const names = chunks => chunks[0].entities.map(entity => entity.text);

	assert.deepEqual(names(block), ['Matt Pocock', 'Sarah Drasner']);
	assert.deepEqual(names(inline), ['Matt Pocock', 'Sarah Drasner']);
	for (const entity of block[0].entities) {
		assert.equal(entity.type, 'person');
		assert.equal(entity.source, 'frontmatter');
	}
});

test('a note with no author sends no `entities` key at all — omitted, not an empty array', () => {
	const chunks = chunksFor('c.md', note('c.md', ['title: Nothing'], 'Body.'));
	assert.equal('entities' in chunks[0], false, 'a vault with no author frontmatter must send the pre-schema-7 payload');
});

test('junk in the author field costs the note its facet, never its indexing', () => {
	// Blank values, whitespace-only values, and duplicates (case-insensitively) all drop; a
	// multi-line value collapses so it cannot smuggle the `\n` the index text joins on.
	assert.deepEqual(extractFrontmatterEntities({ author: '' }), []);
	assert.deepEqual(extractFrontmatterEntities({ author: '   ' }), []);
	assert.deepEqual(extractFrontmatterEntities({}), []);
	assert.deepEqual(extractFrontmatterEntities(undefined), []);
	assert.deepEqual(extractFrontmatterEntities({ author: ['Matt Pocock', 'matt pocock', ''] }).map(e => e.text), ['Matt Pocock']);
	assert.deepEqual(extractFrontmatterEntities({ author: ['Matt\n\nPocock'] }).map(e => e.text), ['Matt Pocock']);
	assert.deepEqual(extractFrontmatterEntities({ author: [{ nested: true }, ['deep'], null] }), []);
	// Bounded: 32 entities max, 200 chars each, so a pathological clipper-written field cannot
	// multiply itself across every chunk of a long note.
	assert.equal(extractFrontmatterEntities({ author: Array.from({ length: 100 }, (_, i) => `Person ${i}`) }).length, 32);
	assert.equal(extractFrontmatterEntities({ author: 'x'.repeat(500) })[0].text.length, 200);
});

// ── 2. contentHash: the coverage-aware skip must not strand an author edit ────────────────

test('editing ONLY the author changes contentHash, so the note re-indexes instead of being skipped', () => {
	const body = ['# Generics', 'A body that never names anyone.'].join('\n');
	const byMatt = note('t.md', ['title: Generics', 'author: Matt Pocock'], body);
	const bySarah = note('t.md', ['title: Generics', 'author: Sarah Drasner'], body);

	assert.notEqual(hashSearchContent(byMatt), hashSearchContent(bySarah));
	// The load-bearing half, and the reason the entity text is folded in rather than left to be
	// covered incidentally by hashing the raw content: narrow this hash to the note *body* — a
	// perfectly reasonable-looking future optimization — and the assertion above starts passing
	// for the wrong reason while every author-only edit silently stops re-indexing. Folding the
	// emitted text states the invariant directly: the hash covers everything that gets indexed.
	assert.notEqual(
		hashSearchContent(byMatt),
		hashSearchContent(note('t.md', ['title: Generics'], body)),
		'adding an author must change the hash',
	);
});

test('the hash SearchManager compares and the hash the chunks carry are the same value', () => {
	// SearchManager.prepareFile hashes once and threads the result into buildSearchChunks; if the
	// chunker recomputed a *different* fold, the stored hash would never equal the compared hash
	// and every file would re-index on every sweep, forever.
	const content = note('t.md', ['author: Matt Pocock'], 'Body.');
	const chunks = chunksFor('t.md', content);
	assert.equal(chunks[0].contentHash, hashSearchContent(content));

	const threaded = buildSearchChunks({
		vaultId: VAULT,
		path: 't.md',
		basename: 't',
		extension: 'md',
		mtime: 1,
		content,
		contentHash: hashSearchContent(content),
		maxChars: 400,
		overlapChars: 0,
	});
	assert.equal(threaded[0].contentHash, chunks[0].contentHash);
});

// ── 3. The flattening rule, on both sides of the wire ────────────────────────────────────

test('the client and the companion agree, exactly, on the text that reaches the index', () => {
	// There is no shared module across this boundary — the companion is dependency-free `.mjs` —
	// so the two rules are written twice and this is what keeps them one rule. If they diverged,
	// the client would fold text into contentHash that the index does not hold.
	const entities = extractFrontmatterEntities({ author: ['Matt Pocock', 'Sarah Drasner', 'matt pocock'] });
	assert.equal(entityIndexText(entities), normalizeChunkEntities(entities));
	assert.equal(entityIndexText(entities), 'Matt Pocock\nSarah Drasner');
});

test('the companion accepts a bare string entity, so a future producer is not blocked on the object shape', () => {
	assert.equal(normalizeChunkEntities(['Matt Pocock']), 'Matt Pocock');
	assert.equal(normalizeChunkEntities('Matt Pocock'), 'Matt Pocock');
	assert.equal(normalizeChunkEntities([{ text: 'Matt Pocock', type: 'person', source: 'model' }]), 'Matt Pocock');
	// A model-sourced entity is stored identically to a frontmatter-sourced one: same column,
	// same text, no schema event. That is the whole GLiNER2-compatibility claim, asserted.
	assert.equal(
		normalizeChunkEntities([{ text: 'Matt Pocock', type: 'person', source: 'frontmatter' }]),
		normalizeChunkEntities([{ text: 'Matt Pocock', type: 'PERSON', source: 'model' }]),
	);
	assert.equal(normalizeChunkEntities(undefined), '');
	assert.equal(normalizeChunkEntities([null, {}, [], { text: null }]), '', 'nothing usable must yield empty text, never "[object Object]"');
	// A YAML scalar that parsed as a number is still a name someone typed, so it indexes — the
	// same rule the chunker applies, which is what keeps the two flattenings identical.
	assert.equal(normalizeChunkEntities([2024]), '2024');
});

// ── 4. Retrieval: the miss, closed ───────────────────────────────────────────────────────

test('`matt pocock` finds a note whose only claim to the name is `author:` in its frontmatter', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const content = note('t.md', ['title: Total TypeScript Generics', 'author: Matt Pocock'], [
			'# Generics',
			'Conditional types and inference, with no human named anywhere in the body.',
		].join('\n'));
		const upsert = await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks: chunksFor('ts/generics.md', content) });
		assert.equal(upsert.status, 200);

		const search = await call('POST', '/v1/search', { vaultId: VAULT, query: 'matt pocock', limit: 10 });
		assert.equal(search.status, 200);
		assert.equal(search.json.results[0]?.path, 'ts/generics.md');
	});
	db.close();
});

test('the match is case- and order-insensitive, and a partial trailing term still lands', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const content = note('t.md', ['title: Generics', 'author: Matt Pocock'], 'Conditional types.');
		await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks: chunksFor('ts/generics.md', content) });

		for (const query of ['matt pocock', 'MATT POCOCK', 'Matt Pocock', 'pocock matt', 'pocock', 'matt poco']) {
			const search = await call('POST', '/v1/search', { vaultId: VAULT, query, limit: 10 });
			assert.equal(search.json.results[0]?.path, 'ts/generics.md', `query "${query}" must reach the authored note`);
		}
	});
	db.close();
});

test('an entity hit is visible in attribution, and a row with no facet carries no entity keys', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [
				...chunksFor('ts/generics.md', note('t.md', ['title: Generics', 'author: Matt Pocock'], 'Conditional types and inference.')),
				...chunksFor('ts/plain.md', note('p.md', ['title: Plain'], 'Conditional types and inference.')),
			],
		});

		const search = await call('POST', '/v1/search', { vaultId: VAULT, query: 'matt pocock inference', limit: 10 });
		const authored = search.json.results.find(row => row.path === 'ts/generics.md');
		assert.ok(authored, 'the authored note must be in the results');
		// Which of the query's terms the facet accounts for — without this the facet raises a
		// row's bm25 and nothing anywhere says why, so an apparently unrelated hit is
		// indistinguishable from a ranking bug.
		assert.deepEqual(authored.attribution.entityTerms, ['matt', 'pocock']);

		const plain = search.json.results.find(row => row.path === 'ts/plain.md');
		if (plain) {
			assert.equal('entityTerms' in plain.attribution, false, 'a row with no entity facet keeps its pre-schema-7 attribution shape');
		}
	});
	db.close();
});

test('a row that HAS entities but matched none of them reports an empty list, not a missing key', () => {
	// The two answers are different statements and the response says which one it is.
	assert.deepEqual(matchedEntityTerms(['inference'], 'Matt Pocock'), []);
	assert.equal(matchedEntityTerms(['matt'], ''), null);
	assert.equal(matchedEntityTerms(['matt'], undefined), null);
	// Whole-word or prefix, never a bare substring: `att` must not credit `Matt`.
	assert.deepEqual(matchedEntityTerms(['att'], 'Matt Pocock'), []);
	assert.deepEqual(matchedEntityTerms(['poc'], 'Matt Pocock'), ['poc']);
});

test('being the author outranks merely being mentioned in a body', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [
				...chunksFor('ts/authored.md', note('a.md', ['title: Generics', 'author: Matt Pocock'], 'Conditional types and inference.')),
				...chunksFor('ts/mentions.md', note('m.md', ['title: Link Roundup'], 'A roundup that cites matt pocock in passing among other links.')),
			],
		});
		const search = await call('POST', '/v1/search', { vaultId: VAULT, query: 'matt pocock', limit: 10 });
		assert.equal(search.json.results[0]?.path, 'ts/authored.md');
	});
	db.close();
});

// ── 5. Schema 6 → 7 migration ────────────────────────────────────────────────────────────

// The frozen schema-6 shape, written out rather than derived, so a future edit to the live
// declarations cannot silently redefine what "the database we are migrating from" means.
const SCHEMA_6_CHUNKS_SQL = `CREATE TABLE chunks (
  id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  heading TEXT NOT NULL,
  text TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  embedding BLOB,
  embedding_dim INTEGER,
  embedding_model TEXT,
  embedding_space TEXT,
  PRIMARY KEY (vault_id, id)
)`;

const SCHEMA_6_FTS_SQL = `CREATE VIRTUAL TABLE chunks_fts USING fts5(
  id UNINDEXED,
  vault_id UNINDEXED,
  path UNINDEXED,
  title,
  heading,
  text,
  prefix='2 3'
)`;

function makeSchema6Db() {
	const db = new DatabaseSync(':memory:');
	db.exec(SCHEMA_6_CHUNKS_SQL);
	db.exec(SCHEMA_6_FTS_SQL);
	db.exec('CREATE INDEX idx_chunks_vault_path ON chunks(vault_id, path)');
	db.exec('CREATE INDEX idx_chunks_vault_path_hash ON chunks(vault_id, path, content_hash)');
	// Schema 6's own version cookie, written by migrateFtsRowidPinning on a real upgrade.
	db.exec('PRAGMA user_version = 6');

	const insert = db.prepare(`INSERT INTO chunks
(id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model, embedding_space)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, id, vault_id, path, title, heading, text) VALUES (?, ?, ?, ?, ?, ?, ?)');
	const vector = encodeEmbedding(normalizeEmbedding([0.5, 0.25, 0.125, 1]));
	for (let i = 0; i < 12; i++) {
		const id = `chunk-${i}`;
		const notePath = `notes/note-${i % 4}.md`;
		const text = `chunk ${i} about orchestration queues and vector legs`;
		insert.run(id, i % 3 === 0 ? 'other-vault' : VAULT, notePath, `hash-${i % 4}`, `Note ${i % 4}`, '', text, i, i, '{}', i % 2 === 0 ? vector : null, i % 2 === 0 ? 4 : null, i % 2 === 0 ? 'bge-m3' : null, i % 2 === 0 ? 'bge-m3' : null);
		const { rowid } = db.prepare('SELECT rowid FROM chunks WHERE vault_id = ? AND id = ?').get(i % 3 === 0 ? 'other-vault' : VAULT, id);
		insertFts.run(rowid, id, i % 3 === 0 ? 'other-vault' : VAULT, notePath, `Note ${i % 4}`, '', text);
	}
	return db;
}

function snapshotChunks(db) {
	return db.prepare(`SELECT rowid, id, vault_id, path, content_hash, title, heading, text, mtime, ordinal,
 metadata_json, embedding, embedding_dim, embedding_model, embedding_space FROM chunks ORDER BY rowid`).all()
		// The embedding is compared as hex rather than as a Uint8Array so a byte difference shows
		// up as a readable diff instead of an object-identity failure.
		.map(row => ({ ...row, embedding: row.embedding ? [...new Uint8Array(row.embedding)].map(byte => byte.toString(16).padStart(2, '0')).join('') : null }));
}

test('the 6 -> 7 migration is lossless: every chunk row, rowid and embedding byte survives untouched', () => {
	const db = makeSchema6Db();
	const before = snapshotChunks(db);
	assert.equal(before.length, 12);
	assert.ok(before.some(row => row.embedding), 'the fixture must carry embeddings for their survival to mean anything');

	const migrated = createSchema(db);
	assert.equal(migrated, true, 'a schema-6 database must report that a migration ran');

	const after = snapshotChunks(db);
	// Every column of every row, including rowid (the vector matrix's build order depends on it)
	// and the raw embedding bytes (nothing re-embeds — this is a rebuild of a derived table, not
	// a reindex of the durable one).
	assert.deepEqual(after, before);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('chunks') WHERE name = 'entities'").get().n, 1);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE entities <> ''").get().n, 0,
		'pre-existing rows carry no entity text yet — that is honest, and the client contentHash fold re-upserts them');
	db.close();
});

test('the 6 -> 7 migration refills chunks_fts with the entities column, rowid-pinned to chunks', () => {
	const db = makeSchema6Db();
	createSchema(db);

	const ftsSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunks_fts'").get().sql;
	assert.match(ftsSql, /entities/);
	assert.match(ftsSql, /prefix\s*=/, 'the rebuild must not lose the prefix index the 1 -> 2 migration added');

	const pairs = db.prepare('SELECT c.rowid AS chunk_rowid, f.rowid AS fts_rowid FROM chunks c JOIN chunks_fts f ON f.id = c.id AND f.vault_id = c.vault_id').all();
	assert.equal(pairs.length, 12, 'every chunk must have exactly one FTS row after the refill');
	for (const pair of pairs) assert.equal(pair.fts_rowid, pair.chunk_rowid, 'rowid pinning must survive the entities rebuild');
	db.close();
});

test('the migration advances user_version to 7 and is idempotent across restarts', () => {
	const db = makeSchema6Db();
	assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);

	assert.equal(createSchema(db), true);
	assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
	const after = snapshotChunks(db);

	// A second startup must do nothing at all: no rebuild (the column is structurally present
	// now), no data change. A migration that re-fires every boot costs ~2.7s per start at the
	// live index size and would be invisible except as latency.
	assert.equal(createSchema(db), false);
	assert.equal(migrateFtsEntitiesColumn(db), false);
	assert.deepEqual(snapshotChunks(db), after);
	db.close();
});

test('a fresh database is born at schema 7 and needs no entities rebuild', () => {
	const db = makeDb();
	assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
	assert.equal(migrateFtsEntitiesColumn(db), false);
	db.close();
});

test('search still answers on a migrated database, and its notes gain the facet on re-index', async () => {
	const db = makeSchema6Db();
	createSchema(db);
	await withServer(db, async call => {
		// Text indexed before the migration is still reachable — the FTS refill is lossless.
		const legacy = await call('POST', '/v1/search', { vaultId: VAULT, query: 'orchestration queues', limit: 10 });
		assert.equal(legacy.status, 200);
		assert.ok(legacy.json.results.length > 0, 'pre-migration chunks must still be searchable');

		// And a re-upsert of one of those very paths lands the facet, so the upgrade path is
		// "re-index and it works", not "reset the index".
		const content = note('n.md', ['title: Note 1', 'author: Matt Pocock'], 'Orchestration queues, revisited.');
		await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks: chunksFor('notes/note-1.md', content) });
		const found = await call('POST', '/v1/search', { vaultId: VAULT, query: 'matt pocock', limit: 10 });
		assert.equal(found.json.results[0]?.path, 'notes/note-1.md');
	});
	db.close();
});

test('the client and companion schema constants are paired at 7', async () => {
	// The pairing rule: a companion reporting a lower schemaVersion is flagged rebuildRequired, so
	// a landing that bumps one and not the other silently indexes entities nowhere.
	const typesOutfile = path.join(outdir, 'types.mjs');
	await esbuild.build({
		entryPoints: ['src/search/types.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'es2020',
		outfile: typesOutfile,
		logLevel: 'silent',
	});
	const { SEARCH_REQUIRED_SCHEMA_VERSION } = await import(pathToFileURL(typesOutfile));
	assert.equal(SCHEMA_VERSION, 7);
	assert.equal(SEARCH_REQUIRED_SCHEMA_VERSION, SCHEMA_VERSION);
});
