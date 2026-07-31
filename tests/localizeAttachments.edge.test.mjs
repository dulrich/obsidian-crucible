import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-localize-tests');
const outfile = path.join(outdir, 'localizeAttachments.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/localizeAttachments.ts'],
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
					'export class Editor {}',
					'export class MarkdownView {}',
					'export class Notice { constructor() {} hide() {} setMessage() {} }',
					'export class TFile {}',
					'export class TFolder {}',
					'export const Platform = { isDesktopApp: true, isMobileApp: false };',
					'export function normalizePath(path) { return String(path).replace(/\\/+/g, "/"); }',
					'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const {
	clampImageQuality,
	md5HexForBytes,
	rewriteLocalizedAttachmentRefs,
	stripDataUriImagePlaceholders,
	repointAttachmentFolderPrefix,
	planLocalAttachmentRepair,
	resolveLocalAttachmentRepair,
	buildAttachmentPathIndex,
	PREFIX_REPAIR_MIN_STEM_LENGTH,
	hasOtherAttachmentReferrer,
	formatEmbed,
	formatLink,
	formatRef,
	parseAttachmentRefsFromCache,
} = await import(pathToFileURL(outfile));

test('rewriteLocalizedAttachmentRefs only replaces full markdown image ranges', () => {
	const content = [
		'Numeric alt stays intact: ![2024-01-15](photos/2024-01-15.png)',
		'Numeric filename localizes: ![1](photos/1.png)',
		'Plain numeric filename text stays intact: photos/1.png',
	].join('\n');

	const result = rewriteLocalizedAttachmentRefs(content, [
		{ from: '![1](photos/1.png)', to: '![](Notes/_attachments/post/abc123_MD5.png)' },
		{ from: 'photos/1.png', to: 'BROKEN' },
	]);

	assert.equal(result.content, [
		'Numeric alt stays intact: ![2024-01-15](photos/2024-01-15.png)',
		'Numeric filename localizes: ![](Notes/_attachments/post/abc123_MD5.png)',
		'Plain numeric filename text stays intact: photos/1.png',
	].join('\n'));
	assert.deepEqual(result.appliedFrom, ['![1](photos/1.png)'], 'only the embed replacement was actually present in content and applied');
});

test('rewriteLocalizedAttachmentRefs keeps numeric-heavy sibling filenames separate', () => {
	const content = [
		'![shot 1](assets/2024-01-15-1.png)',
		'![shot 10](assets/2024-01-15-10.png)',
	].join('\n');

	const result = rewriteLocalizedAttachmentRefs(content, [
		{ from: '![shot 1](assets/2024-01-15-1.png)', to: '![](assets/hash1_MD5.png)' },
	]);

	assert.equal(result.content, [
		'![](assets/hash1_MD5.png)',
		'![shot 10](assets/2024-01-15-10.png)',
	].join('\n'));
});

test('stripDataUriImagePlaceholders removes only image data placeholders', () => {
	const result = stripDataUriImagePlaceholders('A ![](data:image/gif;base64,R0lGODlhAQABAAAAACw=) ![](real.png)');
	assert.equal(result.count, 1);
	assert.equal(result.content, 'A ![](real.png)');
});

test('clampImageQuality handles NaN, undefined, and bounds', () => {
	assert.equal(clampImageQuality(Number.NaN), 0.85);
	assert.equal(clampImageQuality(undefined), 0.85);
	assert.equal(clampImageQuality(10), 0.3);
	assert.equal(clampImageQuality(120), 1);
	assert.equal(clampImageQuality(72), 0.72);
});

test('md5HexForBytes handles empty and numeric bytes deterministically', () => {
	assert.equal(md5HexForBytes(new Uint8Array()), 'd41d8cd98f00b204e9800998ecf8427e');
	assert.equal(md5HexForBytes(new Uint8Array([1, 2, 3, 4, 5])), '7cfdd07889b3295d6a550914ab35e068');
});

test('repointAttachmentFolderPrefix rewrites moved embed prefixes (md + wiki, encoded + raw)', () => {
	const oldFolder = '_resources/Clippings/elon-musk';
	const newFolder = '_resources/daily/day/2026-06-13/elon-musk';
	const content = [
		'![](_resources/Clippings/elon-musk/3ff_MD5.webp)',
		'![[_resources/Clippings/elon-musk/abc_MD5.png]]',
		'Prose mentioning _resources/Clippings/elon-musk/ stays untouched.',
	].join('\n');

	const updated = repointAttachmentFolderPrefix(content, oldFolder, newFolder);

	assert.equal(updated, [
		'![](_resources/daily/day/2026-06-13/elon-musk/3ff_MD5.webp)',
		'![[_resources/daily/day/2026-06-13/elon-musk/abc_MD5.png]]',
		'Prose mentioning _resources/Clippings/elon-musk/ stays untouched.',
	].join('\n'));
});

test('repointAttachmentFolderPrefix handles %20-encoded markdown prefixes and is idempotent', () => {
	const oldFolder = '_resources/My Clips/post';
	const newFolder = '_resources/daily/post';
	const md = '![](_resources/My%20Clips/post/x_MD5.webp)';
	const once = repointAttachmentFolderPrefix(md, oldFolder, newFolder);
	assert.equal(once, '![](_resources/daily/post/x_MD5.webp)');
	// Already-updated content has no old prefix left -> no-op.
	assert.equal(repointAttachmentFolderPrefix(once, oldFolder, newFolder), once);
	// No-op when folders are equal.
	assert.equal(repointAttachmentFolderPrefix(md, oldFolder, oldFolder), md);
});

test('planLocalAttachmentRepair prefers the expected folder, then a unique name match', () => {
	const expected = '_resources/daily/day/2026-06-13/elon-musk';
	const vaultPaths = [
		'_resources/daily/day/2026-06-13/elon-musk/3ff_MD5.webp',
		'_resources/other/elsewhere/3ff_MD5.webp',
	];
	// Expected-folder candidate wins even when a same-named file exists elsewhere.
	assert.equal(
		planLocalAttachmentRepair('_resources/Clippings/elon-musk/3ff_MD5.webp', expected, vaultPaths),
		'_resources/daily/day/2026-06-13/elon-musk/3ff_MD5.webp',
	);
	// Falls back to a unique vault-wide match when not in the expected folder.
	assert.equal(
		planLocalAttachmentRepair('_resources/Clippings/x/uniq_MD5.png', expected, ['_resources/wherever/uniq_MD5.png']),
		'_resources/wherever/uniq_MD5.png',
	);
	// Non-MD5 duplicate basenames still bail ambiguous — no content-identity guarantee.
	assert.equal(
		planLocalAttachmentRepair('_resources/Clippings/x/dup.png', expected, ['a/dup.png', 'b/dup.png']),
		null,
	);
	// Missing entirely -> null.
	assert.equal(planLocalAttachmentRepair('_resources/Clippings/x/gone_MD5.png', expected, vaultPaths), null);
	// Decodes %20 before matching the basename.
	assert.equal(
		planLocalAttachmentRepair('_resources/Clippings/x/a%20b_MD5.png', expected, ['_resources/keep/a b_MD5.png']),
		'_resources/keep/a b_MD5.png',
	);
});

// Repair-bounce regression (round-3 feedback, 2026-07-31): re-localizing a note whose ref
// was repaired to point into ANOTHER note's attachment folder must not trash the source
// while that other note still references it — copy semantics for shared attachments.
test('hasOtherAttachmentReferrer detects a second referencing note', () => {
	const links = {
		'daily/day/2026-05-23/Sync.md': { '_resources/_blog_metadata/k/300b_MD5.png': 1 },
		'_blog_metadata/k/2022-06-05-sync.md': { '_resources/_blog_metadata/k/300b_MD5.png': 1 },
	};
	assert.equal(
		hasOtherAttachmentReferrer(links, '_resources/_blog_metadata/k/300b_MD5.png', 'daily/day/2026-05-23/Sync.md'),
		true,
	);
});

test('hasOtherAttachmentReferrer is false when only the excluded note references the file', () => {
	const links = {
		'daily/day/2026-05-23/Sync.md': { '_resources/old/300b_MD5.png': 2 },
		'unrelated/note.md': { '_resources/other/aaa_MD5.png': 1 },
	};
	assert.equal(hasOtherAttachmentReferrer(links, '_resources/old/300b_MD5.png', 'daily/day/2026-05-23/Sync.md'), false);
});

test('hasOtherAttachmentReferrer ignores zero-count entries and empty maps', () => {
	const links = {
		'a.md': { '_resources/x_MD5.png': 0 },
		'b.md': {},
	};
	assert.equal(hasOtherAttachmentReferrer(links, '_resources/x_MD5.png', 'c.md'), false);
	assert.equal(hasOtherAttachmentReferrer({}, '_resources/x_MD5.png', 'c.md'), false);
});

/* --------------------------------------------- resolveLocalAttachmentRepair: truncated-ref recovery (WP-VF-2d) */

test('PREFIX_REPAIR_MIN_STEM_LENGTH is 8 (32 bits of the content hash — see the doc comment in localizeAttachments.ts)', () => {
	assert.equal(PREFIX_REPAIR_MIN_STEM_LENGTH, 8);
});

test('resolveLocalAttachmentRepair: a unique prefix hit recovers a truncated (spliced) broken basename', () => {
	const expected = '_resources/notes/post';
	const vaultPaths = ['_resources/elsewhere/abcdef1234567890_MD5.png'];
	const result = resolveLocalAttachmentRepair('_resources/Clippings/x/abcdef12_MD5.pn', expected, vaultPaths);
	assert.equal(result.target, '_resources/elsewhere/abcdef1234567890_MD5.png');
	assert.equal(result.reason, null);
	// planLocalAttachmentRepair (the pure wrapper the scan/repairable computation uses)
	// exposes the same recovery through its narrower string|null contract.
	assert.equal(
		planLocalAttachmentRepair('_resources/Clippings/x/abcdef12_MD5.pn', expected, vaultPaths),
		'_resources/elsewhere/abcdef1234567890_MD5.png',
	);
});

test('resolveLocalAttachmentRepair: prefix ambiguity (two candidates share the truncated prefix) reports "ambiguous", not a guess', () => {
	const expected = '_resources/notes/post';
	const vaultPaths = [
		'_resources/elsewhere/abcdef1234567890_MD5.png',
		'_resources/other/abcdef12ffffffffff_MD5.png',
	];
	const result = resolveLocalAttachmentRepair('_resources/Clippings/x/abcdef12_MD5.pn', expected, vaultPaths);
	assert.equal(result.target, null);
	assert.equal(result.reason, 'ambiguous');
});

test('resolveLocalAttachmentRepair: below PREFIX_REPAIR_MIN_STEM_LENGTH, prefix recovery is not attempted even if it would be unique', () => {
	const expected = '_resources/notes/post';
	// stem "abc" is 3 chars — below the 8-char floor — so this must NOT match even though
	// it is the unique prefix of the one candidate below (short-garbage guard, WP-VF-2d).
	const vaultPaths = ['_resources/elsewhere/abcdef1234567890_MD5.png'];
	const result = resolveLocalAttachmentRepair('_resources/Clippings/x/abc_MD5.pn', expected, vaultPaths);
	assert.equal(result.target, null);
	assert.equal(result.reason, 'missing');
});

test('resolveLocalAttachmentRepair: an exact-basename match wins over prefix recovery — the prefix tier never even runs', () => {
	const expected = '_resources/notes/post';
	const vaultPaths = [
		'_resources/exact/abcdef12_MD5.png', // exact basename match
		'_resources/elsewhere/abcdef1234567890_MD5.png', // would ALSO prefix-match, if the exact tier didn't win first
	];
	const result = resolveLocalAttachmentRepair('_resources/Clippings/x/abcdef12_MD5.png', expected, vaultPaths);
	assert.equal(result.target, '_resources/exact/abcdef12_MD5.png');
	assert.equal(result.reason, null);
});

test('resolveLocalAttachmentRepair: prefix recovery ignores a same-prefix candidate that is not itself a managed (_MD5) name', () => {
	const expected = '_resources/notes/post';
	const vaultPaths = ['_resources/elsewhere/abcdef1234567890.png']; // no _MD5 marker at all
	const result = resolveLocalAttachmentRepair('_resources/Clippings/x/abcdef12_MD5.pn', expected, vaultPaths);
	assert.equal(result.target, null);
	assert.equal(result.reason, 'missing');
});

/* --------------------------------------------------- resolveLocalAttachmentRepair: MD5-ambiguity auto-resolve (WP-PF1) */

test('resolveLocalAttachmentRepair: tier-2 exact-basename ambiguity auto-resolves to a candidate under the expected folder when one exists', () => {
	const expected = '_resources/notes/post';
	const vaultPaths = [
		// Nested under `expected` but NOT at the literal `expected/base` path tier 1 checks
		// (a subfolder, not the folder itself) — so tier 1 does NOT short-circuit here;
		// this exercises tier 2's own expected-folder preference in pickAmongIdenticalContent.
		'_resources/notes/post/sub/dup_MD5.png',
		'_resources/other/dup_MD5.png',
		'_resources/third/dup_MD5.png',
	];
	const result = resolveLocalAttachmentRepair('_resources/Clippings/x/dup_MD5.png', expected, vaultPaths);
	assert.equal(result.target, '_resources/notes/post/sub/dup_MD5.png', 'byte-identical candidates -> the one under the expected folder wins, not a bail to ambiguous');
	assert.equal(result.reason, null);
});

test('resolveLocalAttachmentRepair: tier-2 exact-basename ambiguity auto-resolves to the shortest path when none is in the expected folder', () => {
	const expected = '_resources/notes/post';
	const vaultPaths = [
		'_resources/a/much/deeper/nested/folder/dup_MD5.png',
		'_resources/b/dup_MD5.png',
	];
	const result = resolveLocalAttachmentRepair('_resources/Clippings/x/dup_MD5.png', expected, vaultPaths);
	assert.equal(result.target, '_resources/b/dup_MD5.png', 'shortest path wins the tie-break');
	assert.equal(result.reason, null);
});

test('resolveLocalAttachmentRepair: tier-2 exact-basename ambiguity, equal-length paths, auto-resolves lexicographically first', () => {
	const expected = '_resources/notes/post';
	const vaultPaths = ['_resources/bbb/dup_MD5.png', '_resources/aaa/dup_MD5.png'];
	const result = resolveLocalAttachmentRepair('_resources/Clippings/x/dup_MD5.png', expected, vaultPaths);
	assert.equal(result.target, '_resources/aaa/dup_MD5.png');
	assert.equal(result.reason, null);
});

test('resolveLocalAttachmentRepair: tier-2 non-MD5 duplicate basenames still bail ambiguous — no content-identity guarantee', () => {
	const expected = '_resources/notes/post';
	const vaultPaths = ['a/dup.png', 'b/dup.png'];
	const result = resolveLocalAttachmentRepair('_resources/Clippings/x/dup.png', expected, vaultPaths);
	assert.equal(result.target, null);
	assert.equal(result.reason, 'ambiguous');
});

test('resolveLocalAttachmentRepair: tier-3 prefix ambiguity auto-resolves when every candidate shares the exact same full basename', () => {
	const expected = '_resources/notes/post';
	const vaultPaths = [
		'_resources/notes/post/abcdef1234567890_MD5.png',
		'_resources/elsewhere/abcdef1234567890_MD5.png',
	];
	const result = resolveLocalAttachmentRepair('_resources/Clippings/x/abcdef12_MD5.pn', expected, vaultPaths);
	assert.equal(result.target, '_resources/notes/post/abcdef1234567890_MD5.png', 'identical full basenames -> byte-identical -> expected folder wins');
	assert.equal(result.reason, null);
});

test('resolveLocalAttachmentRepair: tier-3 prefix ambiguity with DIFFERING full basenames still bails ambiguous (unchanged)', () => {
	const expected = '_resources/notes/post';
	const vaultPaths = [
		'_resources/elsewhere/abcdef1234567890_MD5.png',
		'_resources/other/abcdef12ffffffffff_MD5.png',
	];
	const result = resolveLocalAttachmentRepair('_resources/Clippings/x/abcdef12_MD5.pn', expected, vaultPaths);
	assert.equal(result.target, null);
	assert.equal(result.reason, 'ambiguous');
});

/* ------------------------------------------- AttachmentPathIndex: index-vs-naive equivalence (WP-PF2) */
// buildAttachmentPathIndex/resolveLocalAttachmentRepair's optional 4th param must produce
// byte-identical decisions to the naive (no-index) path — including PF1's MD5-ambiguity
// auto-resolve ordering (expected-folder / shortest / lexicographic). Re-running every scenario
// above WITH an index built from the same vaultPaths is the targeted half of that guarantee;
// the randomized sweep below is the general half.

function bothResolve(brokenLink, expectedFolder, vaultPaths) {
	const naive = resolveLocalAttachmentRepair(brokenLink, expectedFolder, vaultPaths);
	const index = buildAttachmentPathIndex(vaultPaths);
	const indexed = resolveLocalAttachmentRepair(brokenLink, expectedFolder, vaultPaths, index);
	assert.deepEqual(indexed, naive, `indexed result must match naive result for ${brokenLink} / expected=${expectedFolder}`);
	return naive;
}

test('AttachmentPathIndex: tier 1 (expected folder) is index-equivalent', () => {
	const expected = '_resources/Clippings/elon-musk';
	const vaultPaths = ['_resources/Clippings/elon-musk/3ff_MD5.webp', '_resources/wherever/3ff_MD5.webp'];
	const result = bothResolve('_resources/Clippings/x/3ff_MD5.webp', expected, vaultPaths);
	assert.equal(result.target, '_resources/Clippings/elon-musk/3ff_MD5.webp');
});

test('AttachmentPathIndex: tier 2 (unique exact basename) is index-equivalent', () => {
	const result = bothResolve('_resources/Clippings/x/uniq_MD5.png', 'expected/folder', ['_resources/wherever/uniq_MD5.png']);
	assert.equal(result.target, '_resources/wherever/uniq_MD5.png');
});

test('AttachmentPathIndex: tier 2 non-MD5 duplicate ambiguity is index-equivalent', () => {
	const result = bothResolve('_resources/Clippings/x/dup.png', 'expected/folder', ['a/dup.png', 'b/dup.png']);
	assert.equal(result.reason, 'ambiguous');
});

test('AttachmentPathIndex: tier 2 MD5-ambiguity auto-resolve (expected folder / shortest / lexicographic) is index-equivalent', () => {
	const expected = '_resources/notes/post';
	bothResolve('_resources/Clippings/x/dup_MD5.png', expected, [
		'_resources/notes/post/sub/dup_MD5.png',
		'_resources/other/dup_MD5.png',
		'_resources/third/dup_MD5.png',
	]);
	bothResolve('_resources/Clippings/x/dup_MD5.png', expected, [
		'_resources/a/much/deeper/nested/folder/dup_MD5.png',
		'_resources/b/dup_MD5.png',
	]);
	bothResolve('_resources/Clippings/x/dup_MD5.png', expected, ['_resources/bbb/dup_MD5.png', '_resources/aaa/dup_MD5.png']);
});

test('AttachmentPathIndex: tier 3 (unique prefix recovery of a truncated ref) is index-equivalent', () => {
	const expected = '_resources/notes/post';
	const result = bothResolve('_resources/Clippings/x/abcdef12_MD5.pn', expected, ['_resources/elsewhere/abcdef1234567890_MD5.png']);
	assert.equal(result.target, '_resources/elsewhere/abcdef1234567890_MD5.png');
});

test('AttachmentPathIndex: tier 3 prefix ambiguity (differing full basenames) is index-equivalent', () => {
	const expected = '_resources/notes/post';
	const result = bothResolve('_resources/Clippings/x/abcdef12_MD5.pn', expected, [
		'_resources/elsewhere/abcdef1234567890_MD5.png',
		'_resources/other/abcdef12ffffffffff_MD5.png',
	]);
	assert.equal(result.reason, 'ambiguous');
});

test('AttachmentPathIndex: tier 3 prefix ambiguity (identical full basenames -> auto-resolve) is index-equivalent', () => {
	const expected = '_resources/notes/post';
	bothResolve('_resources/Clippings/x/abcdef12_MD5.pn', expected, [
		'_resources/notes/post/abcdef1234567890_MD5.png',
		'_resources/elsewhere/abcdef1234567890_MD5.png',
	]);
});

test('AttachmentPathIndex: below PREFIX_REPAIR_MIN_STEM_LENGTH (no prefix attempt) is index-equivalent', () => {
	const expected = '_resources/notes/post';
	const result = bothResolve('_resources/Clippings/x/abc_MD5.pn', expected, ['_resources/elsewhere/abcdef1234567890_MD5.png']);
	assert.equal(result.reason, 'missing');
});

test('AttachmentPathIndex: a plain missing ref (no match at any tier) is index-equivalent', () => {
	const result = bothResolve('_resources/Clippings/x/gone_MD5.png', 'expected/folder', ['a/other_MD5.png', 'b/thing.png']);
	assert.equal(result.reason, 'missing');
});

// Randomized sweep: a synthetic path set (managed + non-managed, some duplicated basenames,
// some duplicated stems) and a batch of broken-link probes (exact, truncated-prefix, and
// pure-miss), asserting indexed === naive for every one. Seeded (mulberry32) so a failure is
// reproducible.
function mulberry32(seed) {
	let a = seed;
	return () => {
		a |= 0; a = (a + 0x6D2B79F5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function hexFrom(rng, n) {
	let s = '';
	for (let i = 0; i < n; i++) s += Math.floor(rng() * 16).toString(16);
	return s;
}

test('AttachmentPathIndex: randomized equivalence sweep over a synthetic path set', () => {
	const rng = mulberry32(0xC0FFEE);
	const folders = ['_resources/a', '_resources/b/nested', '_resources/c', 'attachments/x', 'attachments/y/z'];
	const vaultPaths = [];
	// Deliberately duplicate some basenames/stems (both managed and not) to exercise the
	// ambiguity branches, not just the unique-hit ones.
	const sharedHexes = Array.from({ length: 15 }, () => hexFrom(rng, 32));
	for (let i = 0; i < 400; i++) {
		const folder = folders[Math.floor(rng() * folders.length)];
		if (rng() < 0.7) {
			// Managed attachment — reuse a shared hex ~30% of the time to create duplicates.
			const h = rng() < 0.3 ? sharedHexes[Math.floor(rng() * sharedHexes.length)] : hexFrom(rng, 32);
			vaultPaths.push(`${folder}/${h}_MD5.png`);
		} else {
			vaultPaths.push(`${folder}/plain-${Math.floor(rng() * 50)}.md`);
		}
	}

	const expectedFolders = [...folders, ''];
	for (let i = 0; i < 300; i++) {
		const expected = expectedFolders[Math.floor(rng() * expectedFolders.length)] ?? '';
		let brokenLink;
		const mode = rng();
		if (mode < 0.34) {
			// Exact-basename probe against a real managed or plain file.
			const src = vaultPaths[Math.floor(rng() * vaultPaths.length)] ?? '';
			const base = src.split('/').pop() ?? '';
			brokenLink = `some/other/folder/${base}`;
		} else if (mode < 0.67) {
			// Truncated-prefix probe against a real managed hex.
			const h = sharedHexes[Math.floor(rng() * sharedHexes.length)] ?? '';
			const stemLen = 8 + Math.floor(rng() * 10);
			brokenLink = `some/other/folder/${h.slice(0, stemLen)}_MD5.pn`;
		} else {
			// Pure miss.
			brokenLink = `some/other/folder/${hexFrom(rng, 20)}_MD5.png`;
		}
		bothResolve(brokenLink, expected, vaultPaths);
	}
});

/* --------------------------------------------------------- formatEmbed / formatLink / formatRef (WP-VF-2a) */

test('formatEmbed produces a wiki or markdown embed with an empty alt (unchanged pre-existing behavior)', () => {
	assert.equal(formatEmbed('wiki', 'folder/x_MD5.png'), '![[folder/x_MD5.png]]');
	assert.equal(formatEmbed('md', 'folder/x_MD5.png'), '![](folder/x_MD5.png)');
	assert.equal(formatEmbed('md', 'a folder/x_MD5.png'), '![](a%20folder/x_MD5.png)');
});

test('formatLink preserves display text and produces a LINK, not an embed', () => {
	assert.equal(formatLink('wiki', 'folder/x_MD5.pdf'), '[[folder/x_MD5.pdf]]');
	assert.equal(formatLink('wiki', 'folder/x_MD5.pdf', 'the source PDF'), '[[folder/x_MD5.pdf|the source PDF]]');
	assert.equal(formatLink('md', 'folder/x_MD5.pdf', 'the source PDF'), '[the source PDF](folder/x_MD5.pdf)');
	assert.equal(formatLink('md', 'a folder/x_MD5.pdf', 'doc'), '[doc](a%20folder/x_MD5.pdf)');
});

test('formatRef dispatches on isEmbed: an embed match stays an embed, a link match stays a link with its display text', () => {
	assert.equal(formatRef({ syntax: 'wiki', isEmbed: true }, 'x_MD5.png'), '![[x_MD5.png]]');
	assert.equal(
		formatRef({ syntax: 'md', isEmbed: false, displayText: 'the report' }, 'x_MD5.pdf'),
		'[the report](x_MD5.pdf)',
	);
});

/* ----------------------------------------- parseAttachmentRefsFromCache: embeds/links symmetry (bug 1) */

test('parseAttachmentRefsFromCache: collects embeds as before, tagged isEmbed', () => {
	const cache = { embeds: [{ link: 'a_MD5.png', original: '![[a_MD5.png]]' }] };
	const matches = parseAttachmentRefsFromCache(cache, '![[a_MD5.png]]');
	assert.equal(matches.length, 1);
	assert.equal(matches[0].isEmbed, true);
	assert.equal(matches[0].syntax, 'wiki');
});

test('parseAttachmentRefsFromCache: collects a broken non-embed link ONLY when it looks like a managed (_MD5) attachment', () => {
	const cache = {
		links: [
			{ link: 'attachments/a_MD5.pdf', original: '[[attachments/a_MD5.pdf|the report]]', displayText: 'the report' },
			{ link: 'notes/other-note.md', original: '[[notes/other-note.md]]' }, // not managed -> ignored
		],
	};
	const matches = parseAttachmentRefsFromCache(cache, '');
	assert.equal(matches.length, 1, 'only the managed-attachment link is collected — an ordinary note link stays out of scope, same as before this fix');
	assert.equal(matches[0].isEmbed, false);
	assert.equal(matches[0].syntax, 'wiki');
	assert.equal(matches[0].displayText, 'the report');
	assert.equal(matches[0].link, 'attachments/a_MD5.pdf');
});

test('parseAttachmentRefsFromCache: a markdown-syntax managed-attachment link keeps its display text and syntax', () => {
	const cache = {
		links: [
			{ link: 'attachments/a_MD5.pdf', original: '[the report](attachments/a_MD5.pdf)', displayText: 'the report' },
		],
	};
	const matches = parseAttachmentRefsFromCache(cache, '');
	assert.equal(matches.length, 1);
	assert.equal(matches[0].isEmbed, false);
	assert.equal(matches[0].syntax, 'md');
	assert.equal(matches[0].displayText, 'the report');
});

test('parseAttachmentRefsFromCache: dedupes an identical `original` string seen via both embeds and links', () => {
	const ref = { link: 'a_MD5.png', original: '![[a_MD5.png]]' };
	const cache = { embeds: [ref], links: [ref] };
	const matches = parseAttachmentRefsFromCache(cache, '');
	assert.equal(matches.length, 1, 'the same (note, link) pair from embeds and links collapses to one match, mirroring the scan\'s own dedup key');
});

test('parseAttachmentRefsFromCache: still finds remote markdown image embeds via the content regex, unaffected by the links change', () => {
	const content = '![alt](https://example.com/pic.png)';
	const matches = parseAttachmentRefsFromCache(null, content);
	assert.equal(matches.length, 1);
	assert.equal(matches[0].isRemote, true);
	assert.equal(matches[0].isEmbed, true);
});

/* ------------------------------------------------- rewriteLocalizedAttachmentRefs: link coverage (WP-PF1) */
//
// vf-2 shipped parseAttachmentRefsFromCache seeing broken non-embed managed-attachment
// links, but the rewrite chokepoint that actually WRITES the fix stayed embeds-only —
// repairNote would compute a link replacement, report "Repaired 1", and silently write
// nothing, because the old MARKDOWN_ATTACHMENT_REF_RE never matched a bare `[[...]]` /
// `[...](...)` span. This section round-trips all four ref shapes (embed/link x wiki/md)
// through the actual rewrite chokepoint and asserts the write LANDS.

test('rewriteLocalizedAttachmentRefs: a wiki LINK (not embed) to a managed attachment is rewritten and reported as applied', () => {
	const content = 'See [[attachments/old/a_MD5.pdf|the report]] for details.';
	const result = rewriteLocalizedAttachmentRefs(content, [
		{ from: '[[attachments/old/a_MD5.pdf|the report]]', to: '[[attachments/new/a_MD5.pdf|the report]]' },
	]);
	assert.equal(result.content, 'See [[attachments/new/a_MD5.pdf|the report]] for details.');
	assert.deepEqual(result.appliedFrom, ['[[attachments/old/a_MD5.pdf|the report]]']);
});

test('rewriteLocalizedAttachmentRefs: a %20-encoded markdown LINK to a managed attachment is rewritten and reported as applied', () => {
	const content = 'The [source PDF](attachments/old%20folder/a_MD5.pdf) is here.';
	const result = rewriteLocalizedAttachmentRefs(content, [
		{ from: '[source PDF](attachments/old%20folder/a_MD5.pdf)', to: '[source PDF](attachments/new%20folder/a_MD5.pdf)' },
	]);
	assert.equal(result.content, 'The [source PDF](attachments/new%20folder/a_MD5.pdf) is here.');
	assert.deepEqual(result.appliedFrom, ['[source PDF](attachments/old%20folder/a_MD5.pdf)']);
});

test('rewriteLocalizedAttachmentRefs: mixed note (embed + link + ordinary note link) — only the managed refs move, the ordinary link is untouched', () => {
	const content = [
		'![[attachments/old/img_MD5.png]]',
		'[[attachments/old/doc_MD5.pdf|the doc]]',
		'See also [[Some Other Note]] and [more](Other%20Note.md).',
	].join('\n');
	const result = rewriteLocalizedAttachmentRefs(content, [
		{ from: '![[attachments/old/img_MD5.png]]', to: '![[attachments/new/img_MD5.png]]' },
		{ from: '[[attachments/old/doc_MD5.pdf|the doc]]', to: '[[attachments/new/doc_MD5.pdf|the doc]]' },
	]);
	assert.equal(result.content, [
		'![[attachments/new/img_MD5.png]]',
		'[[attachments/new/doc_MD5.pdf|the doc]]',
		'See also [[Some Other Note]] and [more](Other%20Note.md).',
	].join('\n'));
	assert.equal(result.appliedFrom.length, 2);
});

test('rewriteLocalizedAttachmentRefs: NEVER rewrites an ordinary note link even if it happens to be passed as a "from" (defense in depth)', () => {
	const content = 'Check [[Some Other Note]] and [the text](Other%20Note.md) for more.';
	const result = rewriteLocalizedAttachmentRefs(content, [
		{ from: '[[Some Other Note]]', to: '[[Renamed Note]]' },
		{ from: '[the text](Other%20Note.md)', to: '[the text](Renamed.md)' },
	]);
	assert.equal(result.content, content, 'neither ordinary link matches the managed-attachment gate, so both replacements are refused');
	assert.deepEqual(result.appliedFrom, []);
});

test('rewriteLocalizedAttachmentRefs: idempotent — re-running on already-rewritten content with the same replacement list is a no-op', () => {
	const content = 'See [[attachments/new/a_MD5.pdf|the report]] for details.';
	const replacements = [{ from: '[[attachments/old/a_MD5.pdf|the report]]', to: '[[attachments/new/a_MD5.pdf|the report]]' }];
	const result = rewriteLocalizedAttachmentRefs(content, replacements);
	assert.equal(result.content, content, 'the old `from` text is no longer present, so nothing changes');
	assert.deepEqual(result.appliedFrom, []);
});

/* ------------------------------------------------ repointAttachmentFolderPrefix: link coverage (WP-PF1) */

test('repointAttachmentFolderPrefix: repoints a wiki LINK to a managed attachment alongside embeds, in the same note', () => {
	const oldFolder = '_resources/Clippings/elon-musk';
	const newFolder = '_resources/daily/day/2026-06-13/elon-musk';
	const content = [
		'![](_resources/Clippings/elon-musk/3ff_MD5.webp)',
		'[[_resources/Clippings/elon-musk/doc_MD5.pdf|Open: the source PDF]]',
	].join('\n');

	const updated = repointAttachmentFolderPrefix(content, oldFolder, newFolder);

	assert.equal(updated, [
		'![](_resources/daily/day/2026-06-13/elon-musk/3ff_MD5.webp)',
		'[[_resources/daily/day/2026-06-13/elon-musk/doc_MD5.pdf|Open: the source PDF]]',
	].join('\n'));
});

test('repointAttachmentFolderPrefix: a %20-encoded markdown LINK to a managed attachment is repointed and stays idempotent', () => {
	const oldFolder = '_resources/My Clips/post';
	const newFolder = '_resources/daily/post';
	const md = '[the source](attachments/_resources/My%20Clips/post/x_MD5.pdf)';
	const once = repointAttachmentFolderPrefix(md, oldFolder, newFolder);
	assert.equal(once, '[the source](attachments/_resources/daily/post/x_MD5.pdf)');
	assert.equal(repointAttachmentFolderPrefix(once, oldFolder, newFolder), once, 'already-updated content has no old prefix left -> no-op');
});

test('repointAttachmentFolderPrefix: NEVER rewrites an ordinary note link even when its path text contains the moved folder prefix', () => {
	const oldFolder = '_resources/Clippings/elon-musk';
	const newFolder = '_resources/daily/day/2026-06-13/elon-musk';
	const content = [
		'[[_resources/Clippings/elon-musk/Some Note]]',
		'[a note](_resources/Clippings/elon-musk/Some%20Note.md)',
	].join('\n');

	const updated = repointAttachmentFolderPrefix(content, oldFolder, newFolder);

	assert.equal(updated, content, 'neither ref targets a managed (_MD5) attachment, so the ordinary note links are left completely alone');
});
