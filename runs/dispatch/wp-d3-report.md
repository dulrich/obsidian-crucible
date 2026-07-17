# WP-D3 Execution Report — main.ts registration decomposition

## Final module list (line counts)

| File | Lines |
| --- | --- |
| `src/main.ts` | 739 (was 1382; target ≤ ~950) |
| `src/internalCommands.ts` | 342 (new) |
| `src/moveFileCommands.ts` | 131 (new) |
| `src/captureCommands.ts` | 146 (new) |
| `src/periodPickers.ts` | 107 (new) |

`src/commands.ts` is unchanged (`git diff --stat src/commands.ts` shows no diff) — its docstring's claim that Shortcuts/Captures/Chains/Agents "still register from the plugin class itself" remains accurate: `plugin.registerCaptures()` is still a plugin method callers invoke exactly as before; it just now delegates to `captureCommands.ts` internally. Left as-is.

## Kept plugin delegates and their external-caller justification

Every extracted function that had a caller outside `main.ts` keeps a one-line delegating method on `CruciblePlugin` so the call site doesn't churn:

| Delegate on `CruciblePlugin` | Delegates to | External caller(s) |
| --- | --- | --- |
| `promptForText(title)` | `captureCommands.ts: promptForText(plugin, title)` | `src/commands.ts:114`, `:116`, `:129` (`lint-rename-property` / `lint-remove-property` command run callbacks) |
| `openDayPicker()` | `periodPickers.ts: openDayPicker(plugin)` | `src/commands.ts:34` (`materialize-day-picker` command) |
| `openWeekPicker()` | `periodPickers.ts: openWeekPicker(plugin)` | `src/commands.ts:46` (`materialize-week-picker` command) |
| `openMonthPicker()` | `periodPickers.ts: openMonthPicker(plugin)` | `src/commands.ts:58` (`materialize-month-picker` command) |
| `registerMoveFileCommands(prefix)` | `moveFileCommands.ts: registerMoveFileCommands(plugin, prefix)` | `src/commands.ts:265` |
| `registerCaptures()` | `captureCommands.ts: registerCaptures(plugin)` | `src/settings/sections/automate.ts:73,83,94,564,643` (capture add/reorder/delete/import handlers) |

`registerInternalCommands()` had **no** external caller (only `main.ts`'s own `onload`), so it moved with no delegate — `onload` now calls the imported `registerInternalCommands(this)` directly.

`fetchYoutubeMetadataForActiveNote(targetFile?)` was grepped per the brief's explicit instruction and also has **no** external caller (only the chain-internal registration inside `registerInternalCommands`, which moved with it) — moved with no delegate, as a plain exported function in `internalCommands.ts`.

`openMoveFileFolderPicker`, `moveFileToFolder`, `resolveCaptureValue`, `resolveCaptureContext`, `promptForCaptureValue`, `openCaptureDialog`, `handlePeriodFileCreate`, `materializePeriodFromString`, `openPeriodPicker`, `upsertActiveFileTags`, `upsertActiveFileProperty`, `targetFrontmatter`, `ignoreYoutubeVideoCommand`, `watchYoutubeVideoCommand` were all private with no external callers — moved fully as plain functions in their target module, no delegates.

## Deviations from the brief, with reasons

1. **Widened three fields and one method from `private` to plugin-internal (package-visible) on `CruciblePlugin`**: `isMaterializing`, `materializer`, `captureManager` (fields) and `clearCommandRegistryGroup` (method). The extracted modules take `plugin: CruciblePlugin` and read/write these (e.g. `internalCommands.ts`'s `upsertActiveFileTags`/`upsertActiveFileProperty`/`replace-note-body` all thread `plugin.isMaterializing` through `withMaterializing`; `periodPickers.ts` and `internalCommands.ts` both call `plugin.materializer.materializeX`; `captureCommands.ts` and `internalCommands.ts`'s `capture` handler call `plugin.captureManager.executeCapture`; `captureCommands.ts`'s `registerCaptures` calls `plugin.clearCommandRegistryGroup('Captures')`). TypeScript `private` is compile-time only — this has zero runtime behavior change, matching the existing convention in the class (most other manager fields like `chainManager`, `orchestrator`, `noteLocks` were already public for exactly this reason).

2. **`emitMetadataEnriched` moved into `internalCommands.ts`** (not named in the brief's helper list) as an unexported local function. It was a `private` method with its only two call sites both inside `fetchYoutubeMetadataForActiveNote`, which the brief does direct to move. Leaving it in `main.ts` was not possible without also widening it to plugin-internal visibility for a single-caller helper, so moving it alongside its sole caller was the smaller, more contained change.

3. **`coerceVideoId` was duplicated, not imported**, into `internalCommands.ts` (used by `fetchYoutubeMetadataForActiveNote`). The original module-level function in `main.ts` is also used by `registerFoundingTriggers`, which stays in `main.ts` per the brief ("autorun gate/runner internals... stay where it is"). Exporting it from `main.ts` and importing it into `internalCommands.ts` would create a circular value-level import (`main.ts` → `internalCommands.ts` → `main.ts`); the exemplar `commands.ts` only has a circular **type-only** import of `CruciblePlugin` (erased at compile time), so a value-level cycle would be a new pattern. Duplicating this trivial, dependency-free 8-line pure function avoided the cycle. Both copies are identical; if `coerceVideoId`'s logic ever needs to change, both sites must be updated — flagging this for the orchestrator's awareness.

4. **The brief's file-tail class is `PickerModal`, not `PromptModal`.** The brief says (§3, captureCommands.ts): "the file-tail `PromptModal` class (~1359–1382) if `promptForText` moves with it." The actual class at the file tail is `class PickerModal extends Modal` (used exclusively by `openDayPicker`/`openWeekPicker`/`openMonthPicker`); `promptForText` already used `TextInputModal` imported from `./captures`, with no local modal of its own. Per the brief's own note that "line anchors... may have drifted," `PickerModal` was moved to `periodPickers.ts` (its only callers) instead of `captureCommands.ts`.

5. **`openCaptureDialog` is dead code** — grepped and found unreferenced anywhere in the codebase (not even in `main.ts` before this change). Moved and exported from `captureCommands.ts` anyway per the brief's explicit scope list, for zero-behavior-change parity (nothing was removed that existed before).

None of these deviations change command IDs, palette groups, modals shown, settings reads/writes, or event-registration order.

## Gates — verbatim tails

### `npm run lint`
```
> obsidian-crucible@1.0.0 lint
> eslint . && stylelint "**/*.css"

EXIT:0
```
Note: this worktree was initially missing `.stylelintrc.json` (it's `.gitignore`d as a "Local Config" and therefore isn't checked out into any `git worktree`, including the sibling WP-D2 worktree — confirmed pre-existing/environmental, unrelated to this change). Copied it from `/home/_shared_code/obsidian-crucible/.stylelintrc.json` to unblock local verification; it remains untracked (gitignored) so it does not appear in the diff. The orchestrator's checkout should already have it, or will hit the same one-time gap.

### `npx tsc -noEmit -skipLibCheck`
```
EXIT:0
```
(No diagnostics.)

### `TMPDIR=$(mktemp -d) npm test`
```
...
ℹ tests 230
ℹ suites 0
ℹ pass 230
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 194.730284
EXIT:0
```

### `node esbuild.config.mjs production`
```
EXIT:0
```

## Verification checks from the brief

- `wc -l src/main.ts` → **739** (≤ ~950 target, met with margin).
- `grep -c registerCrucibleCommand src/internalCommands.ts src/moveFileCommands.ts src/captureCommands.ts src/commands.ts`:
  - `src/internalCommands.ts:1` — this is a doc-comment reference, not a call; `registerInternalCommands` only registers **chain-internal** commands via `chainManager.registerInternalCommand` (matching original `main.ts` behavior — it never called `registerCrucibleCommand` itself). The corresponding palette-facing commands for these ids (`lint-note`, `materialize-day-today`, `youtube-fetch-video-metadata`, etc.) are registered in `src/commands.ts`, unchanged.
  - `src/moveFileCommands.ts:2` — both `registerCrucibleCommand` calls for `move-current-file-to-daily-folder` / `move-current-file-to-folder` preserved.
  - `src/captureCommands.ts:1` — the per-capture `registerCrucibleCommand` call inside `registerCaptures`'s loop preserved.
  - `src/commands.ts:43` — unchanged from before.
- `grep -rn "console\." src/ | grep -v src/log.ts` → no matches (console usage confined to `src/log.ts`).
- `git status --short` shows only `src/main.ts` modified plus the four new files — no changes to `src/ingestionDashboard.ts`, `src/ingestion/*`, `DEVELOPMENT.md`, `plans/`, or `AGENTS.md`.

## Deferred / not done

Nothing deferred — all four extraction targets, all grepped external-caller delegates, and all four gates are complete.

---

Orchestrator: review the diff and re-run gates before commit.
