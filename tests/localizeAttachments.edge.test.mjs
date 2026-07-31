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

	const updated = rewriteLocalizedAttachmentRefs(content, [
		{ from: '![1](photos/1.png)', to: '![](Notes/_attachments/post/abc123_MD5.png)' },
		{ from: 'photos/1.png', to: 'BROKEN' },
	]);

	assert.equal(updated, [
		'Numeric alt stays intact: ![2024-01-15](photos/2024-01-15.png)',
		'Numeric filename localizes: ![](Notes/_attachments/post/abc123_MD5.png)',
		'Plain numeric filename text stays intact: photos/1.png',
	].join('\n'));
});

test('rewriteLocalizedAttachmentRefs keeps numeric-heavy sibling filenames separate', () => {
	const content = [
		'![shot 1](assets/2024-01-15-1.png)',
		'![shot 10](assets/2024-01-15-10.png)',
	].join('\n');

	const updated = rewriteLocalizedAttachmentRefs(content, [
		{ from: '![shot 1](assets/2024-01-15-1.png)', to: '![](assets/hash1_MD5.png)' },
	]);

	assert.equal(updated, [
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
	// Ambiguous (multiple same-named, none in expected folder) -> null.
	assert.equal(
		planLocalAttachmentRepair('_resources/Clippings/x/dup_MD5.png', expected, ['a/dup_MD5.png', 'b/dup_MD5.png']),
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
