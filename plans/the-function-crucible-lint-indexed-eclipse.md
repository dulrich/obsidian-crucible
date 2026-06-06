# Make `Crucible: Lint: word count` content-aware

## Context

`Crucible: Lint: word count` writes a `word-count` value into note frontmatter. It is
wildly inflated for clipped articles that embed charts or other markup.

Concrete example: `open-brain/vault/daily/day/2026-06-05/Carnage in Chip Stocks Hits
Extra Hard in Top-Heavy Market.md` reports `word-count: 7375`. The note's actual prose
is a fraction of that — the bulk of the "words" come from a single inline `<svg>`
Highcharts chart whose hundreds of `<path d="M 0 98.75 L 2.15 …">` coordinate tokens,
tag names, and attribute values all register as word-like.

Root cause: `Linter.calculateWordCount` (`src/lint.ts:113`) strips **only** frontmatter
(`FRONTMATTER_REGEX`), then hands the entire remaining body to `Intl.Segmenter`. Every
numeric/identifier token in embedded markup is counted. There is **no** existing
markdown-to-prose utility in the repo to reuse, so we add one.

Goal: count only readable prose. Strip embedded HTML/SVG, code, and embed/link plumbing
before segmenting. (Re-linting will lower `word-count` on many existing clipped notes —
that is the intended correction.)

## Approach

Add a pure, exported content-stripping pre-pass and run it before segmentation. Keep the
counting (`Intl.Segmenter` primary, whitespace-split fallback) exactly as-is.

### Changes in `src/lint.ts`

1. **Extract counting into pure module-level functions** so they're unit-testable
   without constructing a `Linter` (the current method uses no `this`):
   - `export function stripNonProseContent(body: string): string`
   - `export function calculateWordCount(content: string): number` — strips frontmatter
     via `FRONTMATTER_REGEX` (already imported from `./utils`), calls
     `stripNonProseContent`, then runs the existing `Intl.Segmenter` / fallback logic.
   - Keep `Linter.calculateWordCount(content)` as a thin wrapper delegating to the
     exported function, so the existing call at `src/lint.ts:188`
     (`this.calculateWordCount(content)`) and any other callers are unaffected.

2. **`stripNonProseContent` ordering** (order matters — outer/greedy constructs first so
   inner markup isn't half-processed). Each step replaces the match with a single space:

   1. Fenced code blocks — ` ```…``` ` and `~~~…~~~` (multiline, lazy).
   2. Inline code spans — `` `…` ``.
   3. HTML comments — `<!--…-->`.
   4. Block markup **with content** — `<svg>…</svg>`, `<script>…</script>`,
      `<style>…</style>` (case-insensitive, lazy, `[\s\S]` to span newlines). This is the
      element that removes the chart in the example note.
   5. Image embeds (dropped entirely — alt/path aren't prose):
      markdown `![alt](url)` and wiki `![[target]]`.
   6. Links → visible text only: markdown `[text](url)` → `text`;
      wikilink `[[target|alias]]` → `alias`, `[[target]]` → `target`.
   7. Remaining/stray HTML tags — `</?tag …>` → space (keeps any inner prose text).

   Emphasis/heading/list punctuation needs no handling — `Intl.Segmenter`'s `isWordLike`
   (and the whitespace-split fallback's non-word stripping) already ignore `#`, `*`, `-`,
   etc., and step 4 has already removed the only token-spamming markup.

### Tests — new `tests/lint.wordcount.test.mjs`

Follow the existing esbuild-bundle + obsidian-stub pattern in
`tests/localizeAttachments.edge.test.mjs` (build `src/lint.ts` to a temp `.mjs`, stub the
`obsidian` module, dynamic-import the bundle). Extend the stub's exports with anything
`lint.ts`'s import graph pulls from `obsidian` beyond the existing class stubs — at least
`export const moment = …` (a minimal callable returning `{ format: () => '' }`) since
`src/lint.ts:1` imports `moment`.

Cover, asserting on the exported `stripNonProseContent` / `calculateWordCount`:
- An inline `<svg>…</svg>` Highcharts block contributes **0** words (the core bug).
- Fenced and inline code are excluded.
- `![](img.png)` / `![[embed.png]]` contribute 0; `[text](url)` counts only `text`;
  `[[page|alias]]` counts only `alias`.
- A plain prose paragraph still counts correctly (regression guard).
- Frontmatter is still excluded (existing behavior preserved).

### Docs — `AGENTS.md` `## Quirks`

Add a short entry noting that `word-count` is **prose-only**: `calculateWordCount` runs
`stripNonProseContent` (strips HTML/SVG/code/embeds, reduces links to visible text) before
segmenting, so embedded charts/code don't inflate the count — don't "simplify" it back to
strip-frontmatter-only, and re-linting legacy notes intentionally lowers their count.

## Files
- `src/lint.ts` — extract + export `calculateWordCount`/`stripNonProseContent`; add the
  strip pre-pass; keep the `Linter` method as a delegating wrapper. (Primary change.)
- `tests/lint.wordcount.test.mjs` — new test file (esbuild-bundle pattern).
- `AGENTS.md` — one `## Quirks` entry.

## Verification
1. `npm run build` — `tsc -noEmit` typecheck + esbuild bundle both pass.
2. `npm test` — runs `node --test tests/*.test.mjs`; the new test passes alongside
   existing suites.
3. End-to-end sanity: re-run `Crucible: Lint: word count` on the example note
   (`…/Carnage in Chip Stocks Hits Extra Hard in Top-Heavy Market.md`) and confirm
   `word-count` drops from 7375 to a realistic prose figure (the SVG no longer counts).
   Equivalently, feed the note body through the exported `calculateWordCount` in the test
   bundle and assert it's far below 7375.
