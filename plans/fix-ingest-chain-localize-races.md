# Fix Ingest Chain Rename Sequencing and Auto Localize Races

## Summary

Fix two timing-sensitive paths:
- `Ingest as Blog` starts from the command palette, moves the target note from `Clippings` into the day folder, then runs `Lint: all`; debug mode likely masks the bug by adding awaited vault I/O between steps.
- Automatic Localize should work from note creation even when a clipper creates an empty note first and writes body/images shortly after.

## Key Changes

- Add chain target-file refresh support after move steps:
  - Let the move-file internal command report the moved `TFile` back to `ChainManager`.
  - Have `ChainManager` update its current `targetFile` and `target_path` chain variable before the next step.
  - After `renameFile`, synchronously call `noteLocks.handleRename(oldPath, targetPath)` and resolve the moved file from the vault so subsequent `Lint: all` runs on the daily-folder path, not stale `Clippings` state.
- Harden command execution in chains:
  - Keep `Lint: all` on the internal awaited path.
  - Add a test proving a chain step using the Obsidian-prefixed Crucible command ID is awaited and receives the moved target note.
- Replace one-shot create localization with a small auto-localize scheduler:
  - On create, schedule localization after a short stabilization delay instead of requiring `file.stat.size > 0` immediately.
  - If the note is still empty, locked, or `isMaterializing`, reschedule with a bounded retry window instead of dropping the event.
  - Reuse the same scheduler for edit-trigger localization so lock/materializing skips are deferred rather than lost.
  - Resolve the current `TFile` at execution time, so a note moved after creation is localized at its new path.

## Tests

- Add chain test coverage for: move step updates target file, next `crucible:lint-note`/`obsidian-crucible:lint-note` step runs on the moved path, and debug mode is not required for success.
- Add auto-localize scheduler tests for: create-empty-then-modify, locked note reschedules after release, and create-only localization works without relying on edit-trigger.
- Run the existing focused tests around locks/chains/localize, then the mandatory cleanup loop:
  - `npm run lint`
  - `npx tsc -noEmit -skipLibCheck`
  - `node esbuild.config.mjs production`

## Assumptions

- At implementation start, remind the user to run `npm run dev` in a separate terminal for Obsidian hot reload.
- The referenced vault note is outside the current plugin workspace, so validation will be by code tests plus a rerun packet for the user if Obsidian UI evidence is still needed.
