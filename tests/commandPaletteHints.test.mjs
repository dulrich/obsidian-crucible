import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-hints-tests');
const outfile = path.join(outdir, 'hints.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/commandPaletteHints.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
});

const { shortestUniqueFuzzyString, shortestTopMatchFuzzyString, isSubsequence, DEFAULT_HINT_OPTIONS } =
	await import(pathToFileURL(outfile).href);

const opts = (over = {}) => ({ ...DEFAULT_HINT_OPTIONS, ...over });
const alphanum = (extra = '') => {
	const set = new Set(extra);
	return (ch) => /[a-z0-9]/.test(ch) || set.has(ch);
};

test('lower-cases output', () => {
	const hint = shortestUniqueFuzzyString('Foo', ['Bar'], opts());
	assert.equal(hint, hint?.toLowerCase());
});

test('charset restriction excludes spaces and punctuation', () => {
	// Only way to distinguish is via the space/colon unless restricted to alphanumerics.
	const hint = shortestUniqueFuzzyString('A: B', ['A B'], opts({ allowedChar: alphanum() }));
	if (hint !== null) {
		for (const ch of hint) assert.ok(/[a-z0-9]/.test(ch), `unexpected char ${ch} in ${hint}`);
	}
});

test('whitelist admits the dot when present', () => {
	const hint = shortestUniqueFuzzyString('a.b', ['axb'], opts({ allowedChar: alphanum('.') }));
	assert.ok(hint !== null && hint.includes('.'));
});

test('prefers the leaf segment over prefixes at equal length', () => {
	// "Crucible: Chain: Ingest" — a single distinguishing char exists in several
	// segments; the leaf ("ingest") should win under the default prefix penalty.
	const target = 'Crucible: Chain: Ingest';
	const competitors = ['Crucible: Chain: Materialize', 'Crucible: Lint: Ingest things'];
	const hint = shortestUniqueFuzzyString(target, competitors, opts({ allowedChar: alphanum() }));
	assert.ok(hint !== null);
	// The chosen characters should come from the leaf word "ingest", not "crucible"/"chain".
	assert.ok('ingest'.includes(hint[hint.length - 1]), `expected leaf-derived hint, got ${hint}`);
});

test('returns null when a competitor contains the whole target', () => {
	assert.equal(shortestUniqueFuzzyString('cat', ['concatenate'], opts()), null);
});

test('returns null when no unique string fits within maxLen', () => {
	assert.equal(shortestUniqueFuzzyString('abc', ['abc'], opts()), null);
});

test('single allowed char when there are no competitors', () => {
	assert.equal(shortestUniqueFuzzyString('Foo', [], opts({ allowedChar: alphanum() })), 'f');
});

test('isSubsequence basic behavior', () => {
	assert.equal(isSubsequence('ac', 'abc'), true);
	assert.equal(isSubsequence('ca', 'abc'), false);
});

test('top-match falls back via injected scorer when no unique string exists', () => {
	// Stub scorer: matches require subsequence; shorter text scores higher
	// (Obsidian likewise favors tighter/shorter matches).
	const score = (q, t) => {
		const tl = t.toLowerCase();
		return isSubsequence(q, tl) ? 1 / tl.length : null;
	};
	// A competitor that contains the whole target means no unique string exists.
	assert.equal(shortestUniqueFuzzyString('cat', ['concatenate'], opts({ allowedChar: alphanum() })), null);
	const top = shortestTopMatchFuzzyString('cat', ['concatenate'], opts({ allowedChar: alphanum() }), score);
	assert.ok(top !== null);
	assert.ok(score(top, 'cat') > (score(top, 'concatenate') ?? -Infinity));
});
