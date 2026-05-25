# Crucible Command Palette: hotkey + shortest-unique-string pills

## Context

The Crucible Command Palette (`src/commandPalette.ts`, a `FuzzySuggestModal<Command>` opened by the
`open-crucible-command-palette` command) currently renders each command as a plain suggestion row,
only adding a `crucible-palette-pinned` class to pinned items. We want two opt-in display affordances,
each gated by its own toggle that appears **inside the existing settings block that only renders when
the palette is enabled** (`renderCrucibleCommandPaletteSettings`, `settings.ts:397`, after the
`if (!...crucibleCommandPaletteEnabled) return;` guard at `settings.ts:414`):

1. **Display configured hotkeys** (default: **enabled**) — show each command's bound hotkey as a
   pill, reusing the exact pill style already used in the Settings → Commands tab
   (`renderHotkey`, `settings.ts:549`; CSS `.crucible-hotkey-display kbd`, `styles.css:163`).
2. **Display shortest unique fuzzy string** (default: **disabled**) — show, as a similar pill, the
   shortest character sequence a user could type into the palette to make this command the **sole**
   fuzzy match out of the full set of commands present when the palette was launched.

Sole-match semantics were confirmed with the user: the hint is the shortest string that fuzzy-matches
ONLY the target command among the launched set (deterministic, independent of Obsidian's scoring).

> Per project convention, copy this plan into `/home/_shared_code/obsidian-crucible/plans/` as the
> first implementation step.

## Changes

### 1. New settings (`src/types.ts`)
Add to the `CrucibleSettings` interface near the existing palette fields (`types.ts:286-290`):
```ts
crucibleCommandPaletteShowHotkeys: boolean;
crucibleCommandPaletteShowUniqueString: boolean;
```
Add to `DEFAULT_SETTINGS` near `types.ts:386-390`:
```ts
crucibleCommandPaletteShowHotkeys: true,
crucibleCommandPaletteShowUniqueString: false,
```

### 2. Settings toggles (`src/settings.ts`)
In `renderCrucibleCommandPaletteSettings`, inside the enabled block (after `settings.ts:414`,
before `renderPinnedCommandList`), add a divider + two `new Setting(group).addToggle(...)` rows
following the existing toggle pattern (`settings.ts:406-412`): each sets its setting, calls
`saveSettings()`, and `refreshDisplay()`. Suggested copy:
- "Show configured hotkeys" — "Display each command's bound hotkey as a pill in the palette."
- "Show shortest unique fuzzy string" — "Display the shortest text you could type to surface each
  command on its own, as a pill."

### 3. Extract a reusable hotkey-label helper (`src/utils.ts`)
The current `renderHotkey` (`settings.ts:549-573`) only handles Crucible commands (it re-prefixes
with the manifest id) and owns its DOM. Extract just the label computation so the palette (which has
arbitrary, already-prefixed command ids) can reuse it:
```ts
// utils.ts — takes a FULL command id (already prefixed)
export function getCommandHotkeyLabel(app: App, fullCommandId: string): string | null
```
It encapsulates `app.hotkeyManager.getHotkeys(fullCommandId)`, the `Mod → Cmd/Ctrl` Platform mapping,
single-char upper-casing, and `' ' → 'Space'` — exactly the logic at `settings.ts:552-566` — returning
e.g. `"Cmd + B"` or `null` when unbound. Refactor `settings.renderHotkey` to build `fullId` then call
this helper (keeping its own `.crucible-hotkey-display` DOM + `prepend`). The `hotkeyManager` type
augmentation already exists (`types.ts:42-64`).

### 4. Shortest-unique-fuzzy-string algorithm (new `src/commandPaletteHints.ts`)
```ts
export function shortestUniqueFuzzyString(
  target: string, competitors: string[], maxLen = 6,
): string | null
```
- Obsidian fuzzy search matches iff the query is a case-insensitive **subsequence** of the name, so
  "matches at all" reduces to a fast subsequence test — no need to call `prepareFuzzySearch` in the
  inner loop. "Sole match" = the query is a subsequence of `target` but of **no** competitor.
- Exact shortest distinguishing subsequence over an arbitrary set is NP-hard, so use **iterative
  deepening** with a small cap: for length `L = 1..min(maxLen, target.length)`, DFS over strictly
  increasing index sets of `target` (leftmost-first for prefix/acronym-like hints), maintaining a
  per-competitor subsequence pointer to prune dead branches and detect uniqueness; return the first
  (hence shortest) subsequence matched by no competitor. Return `null` if none within `maxLen`.
- Compare lowercased; return the substring using `target`'s original case (nicer to read; typing is
  case-insensitive anyway).

### 5. Palette rendering (`src/commandPalette.ts`)
- Constructor: add `this.modalEl.addClass('crucible-command-palette')` for CSS scoping; capture the
  launched competitor set once — `this.allItemNames = this.getItems().map(c => c.name)` — and a memo
  `Map<string, string | null>` for computed hints.
- `renderSuggestion` (`commandPalette.ts:53`): after `super.renderSuggestion(...)` and the existing
  pinned class, append a `.crucible-palette-pills` container, then:
  - if `settings.crucibleCommandPaletteShowHotkeys`: `getCommandHotkeyLabel(app, cmd.id)`; when
    non-null, add a `<kbd>` pill.
  - if `settings.crucibleCommandPaletteShowUniqueString`: look up/compute the memoized hint via
    `shortestUniqueFuzzyString(cmd.name, allItemNames-without-this-name)`; when non-null, add a
    `<kbd class="crucible-palette-fuzzy-hint">` pill.
  - Compute lazily here (only rendered rows pay the cost; the set shrinks as the user types) and only
    when the respective toggle is on. Uniqueness is always evaluated against the fixed launched set.

### 6. Styles (`styles.css`)
Reuse the existing `.crucible-hotkey-display kbd` look. Add, scoped to the palette:
```css
.crucible-command-palette .suggestion-item { display: flex; align-items: center; }
.crucible-command-palette .crucible-palette-pills { display: flex; gap: 4px; margin-left: auto; padding-left: 8px; }
.crucible-palette-pills kbd { /* same chip style as .crucible-hotkey-display kbd */ }
.crucible-palette-pills .crucible-palette-fuzzy-hint { color: var(--text-accent); } /* distinguish from hotkey */
```
(If `modalEl` doesn't carry the class down to suggestion items, fall back to `containerEl` or a class
on the results container — verify during implementation.)

## Verification
- `npm run build` (esbuild) and `tsc --noEmit` — clean compile, no type errors.
- Unit-check the algorithm in isolation (e.g. a scratch `ctx_execute` run): `shortestUniqueFuzzyString("Toggle bold", ["Table of contents", "Toggle sidebar"])` returns the shortest subsequence of "Toggle bold" not a subsequence of the others; confirm `null` when a duplicate name is in competitors and that results never exceed `maxLen`.
- In Obsidian (BRAT/dev vault): enable the palette, bind a hotkey to a couple commands. With "Show configured hotkeys" on, those commands show the hotkey pill matching the Settings→Commands tab. Toggle off → pills disappear.
- Turn on "Show shortest unique fuzzy string": each row shows an accent hint pill; type that exact hint and confirm the command is the only result. Confirm rows with no hint within the cap (or duplicate names) simply show no hint pill. Both toggles only appear once the palette is enabled.
```
