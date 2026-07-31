import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// xApi.ts transitively imports from obsidian (directly, and via utils.ts/
// frontmatterValues.ts) — same esbuild-bundle + obsidian-stub pattern as
// tests/youtubeWorkflowServiceHealth.test.mjs. `requestUrl` delegates to a
// settable global responder; `htmlToMarkdown` is stubbed to a deterministic
// tag-stripping reduction (never a live network call anywhere in this suite).

const outdir = path.join(tmpdir(), 'obsidian-crucible-xapi-tests');
const outfile = path.join(outdir, 'xApi.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export {",
			"  XApiUnavailableError,",
			"  XPostUnavailableError,",
			"  requestXOembed,",
			"  xOembedDeferredResult,",
			"  xMetadataRoot,",
			"  findExistingXMetadataNote,",
			"  ensureXMetadataNote,",
			"} from './src/orchestration/utils/xApi';",
			"export { TFile, TFolder } from 'obsidian';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'x-api-test-entry.ts',
		loader: 'ts',
	},
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
					'export class App {}',
					'export class TFile { constructor() { this.path = ""; } }',
					'export class TFolder { constructor() { this.path = ""; this.children = []; } }',
					'export function normalizePath(p) { return p.replace(/\\\\/g, "/").replace(/\\/+/g, "/"); }',
					'export async function requestUrl(options) { return await globalThis.__xOembedRespond(options); }',
					'export function htmlToMarkdown(html) { return globalThis.__htmlToMarkdown(html); }',
					'export const Platform = {};',
					'export const moment = () => {};',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const {
	XApiUnavailableError,
	XPostUnavailableError,
	requestXOembed,
	xOembedDeferredResult,
	xMetadataRoot,
	findExistingXMetadataNote,
	ensureXMetadataNote,
	TFile,
	TFolder,
} = await import(pathToFileURL(outfile).href);

const fixtureRaw = await readFile(new URL('./fixtures/x-oembed-panda.json', import.meta.url), 'utf8');
const STATUS_ID = '2078296458122645635';
const CANONICAL_URL = `https://x.com/PandaAshwinee/status/${STATUS_ID}`;

// A deterministic HTML → text reduction: strip tags, decode the handful of
// entities the fixture actually uses, collapse whitespace. Good enough to
// assert on substrings without depending on Obsidian's real converter.
globalThis.__htmlToMarkdown = html => String(html)
	.replace(/<[^>]+>/g, ' ')
	.replace(/&mdash;/g, '—')
	.replace(/&amp;/g, '&')
	.replace(/&lt;/g, '<')
	.replace(/&gt;/g, '>')
	.replace(/\s+/g, ' ')
	.trim();

function respondWith(status, { text = '', headers = {} } = {}) {
	globalThis.__xOembedRespond = async () => ({ status, text, headers });
}

function normalizePath(p) {
	return p.replace(/\\/g, '/').replace(/\/+/g, '/');
}

// Minimal in-memory vault: enough for findExistingXMetadataNote's one-level
// child-folder probe and ensureXMetadataNote's ensureFolder + create path.
class FakeVault {
	constructor() {
		this.filesByPath = new Map();
		this.foldersByPath = new Map();
	}
	getAbstractFileByPath(p) {
		const norm = normalizePath(p);
		if (this.filesByPath.has(norm)) return this.filesByPath.get(norm).file;
		if (this.foldersByPath.has(norm)) return this.foldersByPath.get(norm);
		return null;
	}
	async createFolder(p) {
		const norm = normalizePath(p);
		if (this.foldersByPath.has(norm)) throw new Error('Folder already exists.');
		const folder = new TFolder();
		folder.path = norm;
		folder.children = [];
		this.foldersByPath.set(norm, folder);
		const parentPath = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
		if (parentPath && this.foldersByPath.has(parentPath)) {
			this.foldersByPath.get(parentPath).children.push(folder);
		}
	}
	async create(p, content) {
		const norm = normalizePath(p);
		if (this.filesByPath.has(norm)) throw new Error('File already exists.');
		const file = new TFile();
		file.path = norm;
		this.filesByPath.set(norm, { file, content });
		const parentPath = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
		if (parentPath && this.foldersByPath.has(parentPath)) {
			this.foldersByPath.get(parentPath).children.push(file);
		}
		return file;
	}
	async read(file) {
		return this.filesByPath.get(file.path)?.content ?? '';
	}
	bodyAt(p) {
		return this.filesByPath.get(normalizePath(p))?.content;
	}
}

function makePlugin() {
	const vault = new FakeVault();
	return {
		app: { vault, metadataCache: { getFileCache: () => null } },
		settings: { orchestrationXMetadataRoot: '_x_metadata' },
		noteLocks: {
			withResourceLock: (_kind, _id, _label, fn) => fn(),
			withLock: (_path, _label, fn) => fn(),
		},
		_vault: vault,
	};
}

// ── requestXOembed: status classification ───────────────────────────────────

test('a 200 response with the fixture body parses into an XOembedResponse', async () => {
	respondWith(200, { text: fixtureRaw });
	const oembed = await requestXOembed(CANONICAL_URL);
	assert.equal(oembed.author_name, 'Ashwinee Panda');
	assert.equal(oembed.author_url, 'https://x.com/PandaAshwinee');
	assert.equal(oembed.type, 'rich');
	assert.equal(oembed.version, '1.0');
	assert.ok(oembed.html.includes('absurdly information-dense'));
});

test('404 throws XPostUnavailableError with reason deleted-or-private', async () => {
	respondWith(404, {});
	await assert.rejects(requestXOembed(CANONICAL_URL), err => {
		assert.ok(err instanceof XPostUnavailableError);
		assert.equal(err.reason, 'deleted-or-private');
		return true;
	});
});

test('403 also throws XPostUnavailableError with reason deleted-or-private', async () => {
	respondWith(403, {});
	await assert.rejects(requestXOembed(CANONICAL_URL), err => {
		assert.ok(err instanceof XPostUnavailableError);
		assert.equal(err.reason, 'deleted-or-private');
		return true;
	});
});

test('429 throws XApiUnavailableError(rate-limited) with retryAfterMs from headers', async () => {
	respondWith(429, { headers: { 'Retry-After': '90' } });
	await assert.rejects(requestXOembed(CANONICAL_URL), err => {
		assert.ok(err instanceof XApiUnavailableError);
		assert.equal(err.kind, 'rate-limited');
		assert.equal(err.retryAfterMs, 90_000);
		return true;
	});
});

test('a 5xx throws XApiUnavailableError(server-error)', async () => {
	respondWith(503, {});
	await assert.rejects(requestXOembed(CANONICAL_URL), err => {
		assert.ok(err instanceof XApiUnavailableError);
		assert.equal(err.kind, 'server-error');
		return true;
	});
});

test('a network-level throw from requestUrl classifies as refused', async () => {
	globalThis.__xOembedRespond = async () => { throw new Error('connect ECONNREFUSED'); };
	await assert.rejects(requestXOembed(CANONICAL_URL), err => {
		assert.ok(err instanceof XApiUnavailableError);
		assert.equal(err.kind, 'refused');
		return true;
	});
});

test('malformed 200 JSON throws XApiUnavailableError(server-error)', async () => {
	respondWith(200, { text: 'not json at all' });
	await assert.rejects(requestXOembed(CANONICAL_URL), err => {
		assert.ok(err instanceof XApiUnavailableError);
		assert.equal(err.kind, 'server-error');
		return true;
	});
});

test('a 200 body missing required fields is also treated as malformed', async () => {
	respondWith(200, { text: JSON.stringify({ foo: 'bar' }) });
	await assert.rejects(requestXOembed(CANONICAL_URL), err => {
		assert.ok(err instanceof XApiUnavailableError);
		assert.equal(err.kind, 'server-error');
		return true;
	});
});

// ── xOembedDeferredResult ────────────────────────────────────────────────────

test('xOembedDeferredResult constructs a deferred WorkflowResult naming x-oembed, no spread artifacts', () => {
	const err = new XApiUnavailableError('X oEmbed: HTTP 503', 'server-error');
	const result = xOembedDeferredResult(err);
	assert.equal(result.status, 'deferred');
	assert.equal(result.error, err.message);
	assert.deepEqual(result.serviceUnhealthy, { service: 'x-oembed', kind: 'server-error', reason: err.message });
	assert.equal(result.retryAfterMs, undefined);
	// Construct-don't-spread: no stray fields beyond the deferred variant's shape.
	assert.deepEqual(
		Object.keys(result).sort(),
		['error', 'notes', 'retryAfterMs', 'serviceUnhealthy', 'status'].sort(),
	);
});

test('xOembedDeferredResult carries retryAfterMs when the error has one', () => {
	const err = new XApiUnavailableError('X oEmbed: rate limited (HTTP 429)', 'rate-limited', 30_000);
	const result = xOembedDeferredResult(err);
	assert.equal(result.retryAfterMs, 30_000);
	assert.equal(result.serviceUnhealthy.kind, 'rate-limited');
});

// ── ensureXMetadataNote: materializer ────────────────────────────────────────

test('invalid statusId (empty or non-numeric) returns invalid without any network call', async () => {
	const plugin = makePlugin();
	let called = false;
	globalThis.__xOembedRespond = async () => { called = true; return { status: 200, text: fixtureRaw, headers: {} }; };

	const empty = await ensureXMetadataNote(plugin, '', CANONICAL_URL);
	assert.deepEqual(empty, { status: 'invalid', metadataPath: null });

	const nonNumeric = await ensureXMetadataNote(plugin, 'abc123', CANONICAL_URL);
	assert.deepEqual(nonNumeric, { status: 'invalid', metadataPath: null });

	assert.equal(called, false);
});

test('a 200 fixture creates the note at <root>/<author-slug>/<id>.md with correct frontmatter and body', async () => {
	const plugin = makePlugin();
	let fetchCount = 0;
	globalThis.__xOembedRespond = async () => { fetchCount++; return { status: 200, text: fixtureRaw, headers: {} }; };

	const result = await ensureXMetadataNote(plugin, STATUS_ID, CANONICAL_URL);
	assert.equal(result.status, 'created');
	assert.equal(result.metadataPath, `_x_metadata/pandaashwinee/${STATUS_ID}.md`);
	assert.equal(fetchCount, 1);

	const body = plugin._vault.bodyAt(result.metadataPath);
	assert.match(body, /^---\n/);
	assert.match(body, new RegExp(`status-id: "${STATUS_ID}"`));
	assert.match(body, /author: "Ashwinee Panda"/);
	assert.match(body, /author-handle: "PandaAshwinee"/);
	assert.match(body, /state: ok/);
	assert.match(body, /source_command: x-fetch-post-metadata/);
	assert.ok(body.includes('absurdly information-dense'));
	assert.ok(body.includes('rate-adjacent'));
	assert.ok(!body.includes('<script'));
});

test('a second ensure call for the same statusId returns exists and makes no second fetch', async () => {
	const plugin = makePlugin();
	let fetchCount = 0;
	globalThis.__xOembedRespond = async () => { fetchCount++; return { status: 200, text: fixtureRaw, headers: {} }; };

	const first = await ensureXMetadataNote(plugin, STATUS_ID, CANONICAL_URL);
	assert.equal(first.status, 'created');
	assert.equal(fetchCount, 1);

	const second = await ensureXMetadataNote(plugin, STATUS_ID, CANONICAL_URL);
	assert.equal(second.status, 'exists');
	assert.equal(second.metadataPath, first.metadataPath);
	assert.equal(fetchCount, 1, 'no second network call on the probe hit');
});

test('a 404 tombstones the post at <root>/_unavailable/<id>.md with state: unavailable', async () => {
	const plugin = makePlugin();
	respondWith(404, {});
	const deadId = '999999999999999001';
	const url = `https://x.com/i/web/status/${deadId}`;

	const result = await ensureXMetadataNote(plugin, deadId, url);
	assert.equal(result.status, 'tombstoned');
	assert.equal(result.metadataPath, `_x_metadata/_unavailable/${deadId}.md`);

	const body = plugin._vault.bodyAt(result.metadataPath);
	assert.match(body, /state: unavailable/);
	assert.match(body, /unavailable-reason: "deleted-or-private"/);
	assert.ok(!body.includes('# Post by'), 'tombstones carry no body');
});

test('an existing tombstone note is found by the shared probe and returns exists with no refetch', async () => {
	const plugin = makePlugin();
	const deadId = '999999999999999002';
	const url = `https://x.com/i/web/status/${deadId}`;
	respondWith(404, {});

	const first = await ensureXMetadataNote(plugin, deadId, url);
	assert.equal(first.status, 'tombstoned');

	let fetchCount = 0;
	globalThis.__xOembedRespond = async () => { fetchCount++; return { status: 200, text: fixtureRaw, headers: {} }; };
	const second = await ensureXMetadataNote(plugin, deadId, url);
	assert.equal(second.status, 'exists');
	assert.equal(second.metadataPath, first.metadataPath);
	assert.equal(fetchCount, 0);
});

test('a transient XApiUnavailableError propagates out of ensureXMetadataNote untouched (no tombstone written)', async () => {
	const plugin = makePlugin();
	respondWith(503, {});
	const id = '999999999999999003';
	await assert.rejects(
		ensureXMetadataNote(plugin, id, `https://x.com/i/web/status/${id}`),
		err => err instanceof XApiUnavailableError && err.kind === 'server-error',
	);
	// Nothing materialized for a transport-level failure.
	assert.equal(await findExistingXMetadataNote(plugin.app, xMetadataRoot(plugin), id), null);
});

test('an author_url-less fixture falls back to the canonical-URL handle, then unknown-author', async () => {
	const plugin = makePlugin();
	const bareFixture = JSON.stringify({
		url: CANONICAL_URL,
		author_name: '',
		author_url: '',
		html: '<p>no author url here</p>',
		type: 'rich',
		version: '1.0',
	});
	respondWith(200, { text: bareFixture });
	const result = await ensureXMetadataNote(plugin, STATUS_ID, CANONICAL_URL);
	assert.equal(result.status, 'created');
	// canonical URL's own handle segment ("PandaAshwinee") is the fallback.
	assert.equal(result.metadataPath, `_x_metadata/pandaashwinee/${STATUS_ID}.md`);
});

test('xMetadataRoot falls back to the default when the setting is blank', () => {
	const plugin = makePlugin();
	plugin.settings.orchestrationXMetadataRoot = '';
	assert.equal(xMetadataRoot(plugin), '_x_metadata');
});
