# Command-palette fuzzy-hint upgrade

## Context

The Crucible command palette can show a "shortest unique fuzzy string" pill next to each
command — the fewest characters you could type to surface only that command. The current
implementation (`src/commandPaletteHints.ts`) has three problems the user wants fixed:

1. **Charset is unrestricted.** It can pick spaces/punctuation, which make awkward hints.
   We want the candidate characters limited (default `a-zA-Z0-9` + a whitelist starting at `.`),
   configurable between "All ASCII" and "Alphanumeric plus whitelist".
2. **Display case + prefix bias.** Hints should display lowercase, and among equal-length
   candidates the algorithm currently favors the leftmost (prefix) characters. For
   `Crucible: Chain: Ingest as fanfic` a 3-char hint drawn from `Ingest as fanfic` is ideal,
   then `Chain`, and only last from `Crucible`. We want a weighting that prefers the leaf
   segment.
3. **No graceful degradation / no tuning.** When no unique string exists within the length
   cap, nothing is shown. We want a "shortest top match" fallback (shortest string that makes
   the command rank #1 in the real palette fuzzy order), rendered in a distinct color, plus
   tunable weighting params and a debug report to tune the algorithm.

User decisions:
- Top-match fallback uses **Obsidian's real fuzzy scorer** (`prepareFuzzySearch`), injected so
  the core module stays obsidian-free and testable.
- **Full knob set**: prefix-segment penalty, within-word position bias, and max length, each
  independently configurable.
- Debug report is appended to the **existing shared debug note** via `appendDebugLog`
  (`_crucible/debug.md`).

## Critical files

- `src/commandPaletteHints.ts` — core algorithm (rewrite).
- `src/commandPalette.ts` — modal: build scorer, choose unique-vs-fallback, lowercase + color.
- `src/types.ts` — settings interface + `DEFAULT_SETTINGS` + a charset-mode union type.
- `src/settings/sections/commands.ts` — settings UI for the new options.
- `styles.css` — fallback-pill color class.
- `src/commands.ts` — register the debug-report command.
- `src/utils.ts` — reuse `appendDebugLog` (no change).
- `tests/` — new `commandPaletteHints.test.mjs` following the existing esbuild-bundle pattern.

## 1. Core algorithm — `src/commandPaletteHints.ts`

Keep the module **obsidian-free** (tests bundle it directly). Introduce an options object so
all knobs flow through one place.

```ts
export interface HintOptions {
  maxLen: number;              // length cap (primary key: shortest wins)
  allowedChar: (ch: string) => boolean;  // charset filter on target chars
  prefixPenalty: number;       // cost per segment-depth-from-leaf, per chosen char
  positionBias: number;        // cost per (offset from start of its word), per chosen char
}
```

- **Segments & weights:** split the lower-cased target on `": "`. Precompute, for each
  character index, `segmentDepthFromLeaf` (leaf = 0, each earlier segment +1) and
  `offsetFromWordStart` (chars since the last word boundary within the name). Per-char tie
  weight = `prefixPenalty * segmentDepthFromLeaf + positionBias * offsetFromWordStart`.
  Candidate weight = sum over chosen indices. Length stays the **primary** ordering key;
  weight is the secondary tiebreaker among equal-length candidates.
- **Charset:** when iterating target positions in the DFS, skip any index whose char fails
  `allowedChar`. (Competitor matching is unaffected — uniqueness still holds against full
  competitor names.)
- **Shortest + min-weight:** replace "return first hit at this depth" with "explore all hits
  at the shortest successful bound and keep the minimum-weight one." Reuse the existing
  iterative-deepening + `Alive[]` + node-budget structure (`src/commandPaletteHints.ts:64-92`);
  change the inner DFS to track a best `{indices, weight}` instead of returning on first hit,
  still guarded by the 20k node budget.
- `shortestUniqueFuzzyString(target, competitors, opts)` returns the lower-cased chosen string
  or `null`. (Drop the original-case behavior; caller wants lowercase. Keep an internal helper
  returning indices so the debug path can reuse it.)

New exported function for the fallback:

```ts
export function shortestTopMatchFuzzyString(
  target: string,
  competitors: string[],
  opts: HintOptions,
  scoreText: (query: string, text: string) => number | null,
): string | null
```

- Same iterative-deepening enumeration over allowed-char subsequences of `target`, same
  length-then-weight ordering.
- A candidate `q` qualifies when `scoreText(q, target)` is non-null **and strictly greater
  than** `scoreText(q, comp)` for every competitor (null competitor score = `-Infinity`).
- Returns the shortest (then min-weight) qualifying lower-cased string, or `null`.
- Keep `isSubsequence` exported for tests.

## 2. Modal wiring — `src/commandPalette.ts`

- Build `HintOptions` once in the constructor from `plugin.settings` (charset predicate from
  mode + whitelist; the three numeric knobs; maxLen).
- Build the scorer from Obsidian: `import { prepareFuzzySearch } from 'obsidian'` and
  `const scoreText = (q, t) => prepareFuzzySearch(q)(t)?.score ?? null;` (memoize the
  per-query `prepareFuzzySearch(q)` inside the function — see `src/folderPicker.ts:39` for the
  call shape).
- Change the hint cache + `getUniqueHint` to return `{ text, kind: 'unique' | 'top-match' } | null`:
  1. try `shortestUniqueFuzzyString`; if non-null → `kind: 'unique'`.
  2. else, if `settings.crucibleCommandPaletteHintFallbackTopMatch` → try
     `shortestTopMatchFuzzyString`; if non-null → `kind: 'top-match'`.
  3. else `null`.
- In `renderSuggestion` (`src/commandPalette.ts:70-77`): text is already lowercase from the
  core fn; add class `crucible-palette-fuzzy-hint-fallback` (in addition to
  `crucible-palette-fuzzy-hint`) when `kind === 'top-match'`.

## 3. Settings — `src/types.ts` + `src/settings/sections/commands.ts`

Add a union type near `CrucibleCommandPaletteFilterMode` (`src/types.ts:40`):
```ts
export type CrucibleCommandPaletteHintCharsetMode = 'all-ascii' | 'alphanumeric-whitelist';
```

Add to `CrucibleSettings` (after `crucibleCommandPaletteShowUniqueString`, `src/types.ts:309`)
and to `DEFAULT_SETTINGS` (`src/types.ts:426`):

| setting | type | default |
|---|---|---|
| `crucibleCommandPaletteHintCharsetMode` | union | `'alphanumeric-whitelist'` |
| `crucibleCommandPaletteHintWhitelist` | string | `'.'` |
| `crucibleCommandPaletteHintFallbackTopMatch` | boolean | `true` |
| `crucibleCommandPaletteHintMaxLen` | number | `6` |
| `crucibleCommandPaletteHintPrefixPenalty` | number | `1` |
| `crucibleCommandPaletteHintPositionBias` | number | `0` |

UI: extend `renderCrucibleCommandPaletteSettings` (`src/settings/sections/commands.ts:159`),
shown only when `crucibleCommandPaletteShowUniqueString` is on, using the existing `bind*`
helpers (`src/settings/bind.ts`):
- `bindDropdown` charset mode (`All ASCII` / `Alphanumeric plus whitelist`).
- `bindText` whitelist (shown only in whitelist mode; `after: tab.refreshDisplay`).
- `bindToggle` "Fall back to shortest top match" (desc notes the distinct color).
- `bindNumber` max length, prefix penalty, position bias (min 1 for length).

## 4. Styling — `styles.css`

After `.crucible-palette-pills .crucible-palette-fuzzy-hint` (`styles.css:237`):
```css
.crucible-palette-pills .crucible-palette-fuzzy-hint-fallback {
  color: var(--text-warning);
}
```

## 5. Debug report — `src/commands.ts`

Register (pattern at `src/commands.ts:164-171`, `group: 'Other'`, `mutating: false`,
`available: () => settings.crucibleCommandPaletteEnabled`):
- id `command-palette-hint-debug`, name `Debug command palette hints`.
- Run: gather the same item set the modal uses (factor the filter out of
  `CrucibleCommandPaletteModal.getItems` into a shared helper, or replicate), build the
  scorer, and for each command compute both the unique and top-match strings at the configured
  maxLen. Format a markdown table (`name | unique (len) | top-match (len) | used`) and append
  via `appendDebugLog(plugin.app, 'Command palette hints', table)`
  (`src/utils.ts:49`) → lands in `_crucible/debug.md`. Notice the user on completion.

## 6. Tests — `tests/commandPaletteHints.test.mjs`

Follow `tests/postId.test.mjs` (esbuild-bundle the TS, import, assert). Cover:
- charset restriction (whitelist excludes spaces/punctuation; `.` allowed when whitelisted),
- lowercase output,
- prefix-weight preference (leaf segment chosen over `Crucible`/`Chain` at equal length),
- `null` when no unique string within maxLen,
- `shortestTopMatchFuzzyString` with a stub `scoreText` (no obsidian dependency).

## Verification

- `npm test` — new + existing tests pass.
- `npm run build` (`tsc -noEmit` + esbuild) — typechecks clean.
- `npm run lint`.
- Manual in vault: enable the palette + unique-string pill; confirm hints are lowercase and
  alphanumeric, leaf-favored; create two near-identical command names to force the fallback and
  confirm a `--text-warning`-colored pill; run **Debug command palette hints** and inspect the
  table appended to `_crucible/debug.md`; toggle charset mode / knobs and re-check.
