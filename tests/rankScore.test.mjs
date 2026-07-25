import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-rank-score-tests');
const outfile = path.join(outdir, 'rankScore.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/rankScore.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const {
	MODIFIER_CLAMP,
	MOD_COVERAGE,
	MOD_GAP,
	MOD_GAP_CAP,
	MOD_ORDERED,
	MOD_RAW_CASE,
	MOD_RUN,
	MOD_START,
	MOD_START_CAP,
	SCORE_HIGHER_IS_BETTER,
	TIER_EXACT,
	TIER_FUZZY,
	TIER_GAP,
	TIER_PATH_FUZZY,
	TIER_PATH_SUBSTR,
	TIER_PREFIX,
	TIER_SUBSTR,
	TIER_WORD,
	buildRanges,
	compileQuery,
	computeMask,
	maskAccepts,
	scoreCandidateText,
} = await import(pathToFileURL(outfile).href);

function scoreOf(query, text) {
	const result = scoreCandidateText(query, text);
	return result === null ? null : result.score;
}

function rankByScore(query, texts) {
	return texts
		.map(text => ({ text, result: scoreCandidateText(query, text) }))
		.filter(row => row.result !== null)
		// The convention, spelled out: HIGHER IS BETTER, so descending.
		.sort((a, b) => b.result.score - a.result.score)
		.map(row => row.text);
}

test('SCORE CONVENTION: higher is better — the higher-scoring candidate sorts first', () => {
	assert.equal(SCORE_HIGHER_IS_BETTER, true);

	// `notes.md` is an exact basename-stem match for `notes`; `n/o/t/e/s.md` only
	// matches as a path subsequence. The first MUST score higher and sort first.
	const better = scoreOf('notes', 'notes.md');
	const worse = scoreOf('notes', 'n/o/t/e/s.md');
	assert.ok(better !== null && worse !== null);
	assert.ok(better > worse, `expected ${better} > ${worse}`);

	const sorted = [
		{ text: 'n/o/t/e/s.md', score: worse },
		{ text: 'notes.md', score: better },
	].sort((a, b) => b.score - a.score);
	assert.equal(sorted[0].text, 'notes.md');
});

test('tier ordering table: query "log" ranks exact > prefix > word > substring > path-fuzzy', () => {
	const candidates = ['log.md', 'logbook.md', 'daily-log.md', 'catalogue.md', 'Legal/Origins.md'];
	// Under the pre-rewrite ascending sort this list came out backwards.
	assert.deepEqual(rankByScore('log', candidates), candidates);

	assert.equal(scoreCandidateText('log', 'log.md').tier, TIER_EXACT);
	assert.equal(scoreCandidateText('log', 'logbook.md').tier, TIER_PREFIX);
	assert.equal(scoreCandidateText('log', 'daily-log.md').tier, TIER_WORD);
	assert.equal(scoreCandidateText('log', 'catalogue.md').tier, TIER_SUBSTR);
	assert.equal(scoreCandidateText('log', 'Legal/Origins.md').tier, TIER_PATH_FUZZY);
});

test('basename is checked before path', () => {
	// `report` is contiguous in the basename of the first and only in the folder of the
	// second; the basename match must win despite the second being shorter overall.
	const nameMatch = scoreCandidateText('report', 'Archive/2026/quarterly-report.md');
	const pathMatch = scoreCandidateText('report', 'Reports/x.md');
	assert.equal(nameMatch.tier, TIER_WORD);
	assert.equal(pathMatch.tier, TIER_PATH_SUBSTR);
	assert.ok(nameMatch.score > pathMatch.score);
});

test('a query containing a slash switches to path-only matching', () => {
	const compiled = compileQuery('daily/2026');
	assert.equal(compiled.hasSlash, true);
	const hit = scoreCandidateText('daily/2026', 'Daily/2026-07-06.md');
	assert.ok(hit !== null);
	assert.equal(hit.tier, TIER_PATH_SUBSTR);
	// Basename tiers are skipped entirely, so a basename-only match cannot be found.
	assert.equal(scoreCandidateText('daily/2026', 'Notes/daily2026.md'), null);
});

test('TIER-GAP INVARIANT: modifiers are clamped so they can never cross a tier', () => {
	// The arithmetic proof. Every modifier is folded into one clamped delta, and twice
	// the clamp is strictly less than the narrowest tier gap.
	assert.ok(2 * MODIFIER_CLAMP < TIER_GAP, `2*${MODIFIER_CLAMP} must be < ${TIER_GAP}`);

	// The narrowest adjacent tier gaps really are TIER_GAP.
	const tiers = [TIER_EXACT, TIER_PREFIX, TIER_WORD, TIER_SUBSTR, TIER_FUZZY, TIER_PATH_SUBSTR, TIER_PATH_FUZZY];
	for (let i = 1; i < tiers.length; i++) {
		assert.ok(tiers[i - 1] - tiers[i] >= TIER_GAP, `tiers ${tiers[i - 1]}/${tiers[i]} are closer than ${TIER_GAP}`);
	}

	// The raw modifier terms sum well past the gap on their own — the clamp is doing
	// real work, not decorating an already-safe formula.
	const rawPositiveMax = MOD_COVERAGE + MOD_RUN + MOD_RAW_CASE + MOD_ORDERED;
	assert.ok(rawPositiveMax > TIER_GAP, 'clamp is load-bearing; do not remove it');
	const rawNegativeMax = -(MOD_START * MOD_START_CAP + MOD_GAP * MOD_GAP_CAP);
	assert.ok(rawNegativeMax > 0);

	// And the guarantee it buys: the worst possible substring match beats the best
	// possible fuzzy match, whatever the names involved.
	assert.ok(TIER_SUBSTR - MODIFIER_CLAMP > TIER_FUZZY + MODIFIER_CLAMP);
});

test('every score stays inside its tier band', () => {
	const rng = mulberry32(20260724);
	for (let i = 0; i < 4000; i++) {
		const text = randomPath(rng);
		const query = randomQuery(rng, text);
		const result = scoreCandidateText(query, text);
		if (result === null) continue;
		const terms = compileQuery(query).terms.length;
		if (terms === 1) {
			assert.ok(
				Math.abs(result.score - result.tier) <= MODIFIER_CLAMP + 1e-9,
				`score ${result.score} escaped tier ${result.tier} for ${JSON.stringify([query, text])}`,
			);
		} else {
			// Multi-term scores average the per-term tiers, so they sit at or above the
			// worst tier's floor.
			assert.ok(result.score >= result.tier - MODIFIER_CLAMP - 1e-9);
		}
	}
});

test('length normalization and depth: short names and shallow paths win', () => {
	assert.ok(scoreOf('log', 'log.md') > scoreOf('log', 'logistics-planning-document.md'));
	assert.ok(scoreOf('log', 'a/log.md') > scoreOf('log', 'a/b/log.md'));
	assert.ok(scoreOf('note', 'note.md') > scoreOf('note', 'notebook-of-many-things.md'));
});

test('admission is exactly "every term is a subsequence of the lowercased text"', () => {
	const rng = mulberry32(7);
	for (let i = 0; i < 4000; i++) {
		const text = randomPath(rng);
		const query = randomQuery(rng, text);
		const compiled = compileQuery(query);
		if (compiled.isEmpty) continue;
		const admitted = scoreCandidateText(query, text) !== null;
		const expected = compiled.terms.every(term => isSubsequence(term.lower, text.toLowerCase()));
		assert.equal(admitted, expected, `admission disagreed for ${JSON.stringify([query, text])}`);
	}
});

test('admission is monotone under query extension — the narrowing cache depends on it', () => {
	const rng = mulberry32(99);
	const corpus = Array.from({ length: 300 }, () => randomPath(rng));
	for (const target of ['crucible', 'daily 2026', 'src/rank', 'note-x']) {
		for (let i = 1; i < target.length; i++) {
			const shorter = target.slice(0, i);
			const longer = target.slice(0, i + 1);
			for (const text of corpus) {
				if (scoreCandidateText(longer, text) === null) continue;
				assert.notEqual(
					scoreCandidateText(shorter, text),
					null,
					`"${text}" admitted for "${longer}" but rejected for "${shorter}"`,
				);
			}
		}
	}
});

test('match ranges satisfy renderResults: ascending, non-overlapping, in bounds', () => {
	const rng = mulberry32(1234);
	for (let i = 0; i < 3000; i++) {
		const text = randomPath(rng);
		const query = randomQuery(rng, text);
		const compiled = compileQuery(query);
		const ranges = buildRanges(compiled, text);
		let previousEnd = -1;
		for (const range of ranges) {
			assert.equal(range.length, 2);
			assert.ok(Number.isInteger(range[0]) && Number.isInteger(range[1]));
			assert.ok(range[0] >= 0, 'range start below 0');
			assert.ok(range[1] <= text.length, 'range end past text length');
			assert.ok(range[0] < range[1], 'empty or inverted range');
			assert.ok(range[0] >= previousEnd, 'ranges must be ascending and non-overlapping');
			previousEnd = range[1];
		}
		if (scoreCandidateText(query, text) === null) {
			assert.deepEqual(ranges, [], 'a rejected candidate must have no ranges');
		} else if (compiled.terms.length === 1) {
			// The highlighted characters reconstruct the query term, in order.
			const highlighted = ranges.map(([from, to]) => text.slice(from, to)).join('').toLowerCase();
			assert.equal(highlighted, compiled.terms[0].lower);
		}
	}
});

test('match ranges highlight the basename match, not the first path hit', () => {
	assert.deepEqual(buildRanges(compileQuery('log'), 'Logs/daily-log.md'), [[11, 14]]);
	assert.deepEqual(buildRanges(compileQuery('log'), 'log.md'), [[0, 3]]);
});

test('multi-term queries mean their terms and reward left-to-right order', () => {
	const ordered = scoreCandidateText('daily log', 'daily-log.md');
	const backtracking = scoreCandidateText('log daily', 'daily-log.md');
	assert.ok(ordered !== null && backtracking !== null);
	assert.ok(ordered.score > backtracking.score);
	// Every term must match or the candidate is rejected outright.
	assert.equal(scoreCandidateText('daily missing', 'daily-log.md'), null);
});

test('raw-case bonus only fires when the user typed capitals', () => {
	// A long basename keeps the modifier off its clamp, so the bonus is observable.
	const target = 'Media/Quarterly-Chart-Data.png';
	const typedCaps = scoreCandidateText('Chart', target);
	const typedLower = scoreCandidateText('chart', target);
	assert.ok(typedCaps.score > typedLower.score);
	assert.ok(typedCaps.score - typedLower.score <= MOD_RAW_CASE + 1e-9);
	// Case never changes which tier a candidate lands in.
	assert.equal(typedCaps.tier, typedLower.tier);
});

test('char-class bitmask prefilters without ever rejecting a real match', () => {
	const rng = mulberry32(555);
	for (let i = 0; i < 3000; i++) {
		const text = randomPath(rng);
		const query = randomQuery(rng, text);
		const compiled = compileQuery(query);
		if (compiled.isEmpty) continue;
		if (scoreCandidateText(query, text) === null) continue;
		assert.ok(
			maskAccepts(computeMask(text.toLowerCase()), compiled.mask),
			`mask rejected a real match: ${JSON.stringify([query, text])}`,
		);
	}
	// Non-ASCII lives on bit 31; unsigned handling must not break the compare.
	assert.ok(maskAccepts(computeMask('résumé.md'), compileQuery('é').mask));
	assert.equal(maskAccepts(computeMask('abc.md'), compileQuery('é').mask), false);
});

test('compileQuery memoizes and normalizes', () => {
	assert.equal(compileQuery('  log  '), compileQuery('  log  '));
	const compiled = compileQuery('  Daily   Log ');
	assert.equal(compiled.raw, 'Daily   Log');
	assert.deepEqual(compiled.terms.map(term => term.lower), ['daily', 'log']);
	assert.equal(compileQuery('   ').isEmpty, true);
	assert.equal(scoreCandidateText('   ', 'anything.md'), null);
});

/* ---------------------------------------------------------------- helpers */

function isSubsequence(needle, haystack) {
	let at = -1;
	for (const ch of needle) {
		at = haystack.indexOf(ch, at + 1);
		if (at === -1) return false;
	}
	return true;
}

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = ['daily', 'log', 'notes', 'crucible', 'archive', 'media', 'chart', 'origins', 'legal', 'src', 'rank', 'x', 'Réunion'];
const EXTENSIONS = ['md', 'png', 'canvas', 'pdf', ''];

function pick(rng, list) {
	return list[Math.floor(rng() * list.length) % list.length];
}

function randomPath(rng) {
	const depth = Math.floor(rng() * 4);
	const parts = [];
	for (let i = 0; i < depth; i++) parts.push(pick(rng, WORDS));
	const stem = `${pick(rng, WORDS)}${rng() < 0.5 ? `-${pick(rng, WORDS)}` : ''}`;
	const ext = pick(rng, EXTENSIONS);
	parts.push(ext ? `${stem}.${ext}` : stem);
	return parts.join('/');
}

function randomQuery(rng, text) {
	const roll = rng();
	if (roll < 0.25) return pick(rng, WORDS);
	if (roll < 0.45) return `${pick(rng, WORDS)} ${pick(rng, WORDS)}`;
	if (roll < 0.6) return `${pick(rng, WORDS)}/${pick(rng, WORDS)}`;
	// Sample characters out of the text so a decent share of queries actually match.
	const lower = text.toLowerCase();
	const length = 1 + Math.floor(rng() * 5);
	let out = '';
	let at = 0;
	for (let i = 0; i < length && at < lower.length; i++) {
		at += Math.floor(rng() * 3);
		if (at >= lower.length) break;
		out += lower[at];
		at++;
	}
	return out.length > 0 ? out : 'log';
}
