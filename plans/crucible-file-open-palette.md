# Crucible File-Open Palette

*Recommended model/effort — Claude: Sonnet/medium; Codex: GPT-5-Codex medium reasoning, because this is a focused UI + ranking change with testable pure scoring logic.*

## Summary

Add a Crucible replacement for Obsidian's Quick Switcher as a new opt-in command. It will fuzzy-match against full vault file paths, support configurable file extension filtering, and use Crucible's existing excluded-folder Search scope to hide, derank, or include ignored folders. It will not monkey-patch Obsidian's native Quick Switcher; users bind the new command to their preferred hotkey.

## Key Changes

**WP-1 — File-open ranking core (~0.35 kSLOC touched, ~35k tokens).** Add a pure ranking helper that takes file paths, query, excluded-folder state, ignore mode, and extension filter, then returns sorted matches plus render metadata.
Files: new `src/fileOpenPalette.ts` or split `src/fileOpenRanking.ts`. *Model: mid (Claude Sonnet/medium; Codex GPT-5-Codex medium). Execution: direct.*

**WP-2 — File-open modal and command (~0.45 kSLOC touched, ~45k tokens).** Add `CrucibleFileOpenPaletteModal` using `SuggestModal` for custom sorting and optional create-note row; register `open-crucible-file-palette` through `registerCrucibleCommand`, `group: 'Other'`, `mutating: false`.
Files: `src/commands.ts`, new modal module. *Model: mid. Execution: direct.*

**WP-3 — Settings UI and defaults (~0.25 kSLOC touched, ~30k tokens).** Add a "File-open palette" settings group near the existing command palette settings.
Files: `src/types.ts`, `src/settings/sections/commands.ts`. *Model: mid. Execution: direct.*

**WP-4 — Tests and cleanup (~0.25 kSLOC touched, ~35k tokens).** Add focused ranking/settings tests, then run the mandatory cleanup loop.
Files: `tests/fileOpenPalette.test.mjs`, existing test helpers as needed. *Model: mid. Execution: direct.*

## Public Interfaces

Add settings to `CrucibleSettings` and `DEFAULT_SETTINGS`:

- `crucibleFileOpenPaletteEnabled: boolean` default `false`
- `crucibleFileOpenPaletteIgnoredFolderMode: 'include' | 'derank' | 'hide'` default `'derank'`
- `crucibleFileOpenPaletteCreateMissing: boolean` default `false`
- `crucibleFileOpenPaletteExtensions: string[]` default `[]`, meaning all `TFile` vault files are eligible

Behavior details:

- File matching uses `prepareFuzzySearch(query)` against full normalized file paths.
- Empty query lists files by path, with non-excluded files before deranked excluded files.
- Excluded-folder state comes from `isPathExcluded(settings, path, 'search')`.
- `hide` removes excluded files, `derank` pushes them below normal matches, `include` treats them normally.
- Extension filtering is case-insensitive; values are stored without leading dots.
- Opening uses the active leaf/current workspace target via Obsidian's file open API.
- Create-missing, when enabled, creates a Markdown note from the typed path, appending `.md` if no extension is present.

## Test Plan

- Unit-test ranking order: basename/path fuzzy match, shorter path tiebreak, ignored-folder derank, hide, include.
- Unit-test extension filtering: blank means all files; configured extensions are case-insensitive.
- Unit-test create-row eligibility: disabled never shows, enabled shows only when query is non-empty and no exact file path already exists.
- Run:
  - `npm test`
  - `npm run lint`
  - `npx tsc -noEmit -skipLibCheck`
  - `node esbuild.config.mjs production`

## Assumptions

- First implementation step after plan approval is to write this plan to `plans/crucible-file-open-palette.md`.
- At implementation start, remind the user to run `npm run dev` in a separate terminal for Obsidian hot reload.
- This is an opt-in replacement command, not a native Quick Switcher override.
- The user wants all vault files eligible by default, with extension filtering available in settings.

Total ≈ 1.3 kSLOC, ~145k tokens.
