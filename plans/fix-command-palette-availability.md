# Fix Crucible command palette availability filtering

## Summary

Fix the Crucible command palette so it does not show commands that Obsidian would currently hide via `checkCallback(true)`. This preserves the project's existing split: runtime palettes honor availability, while settings and chain-authoring surfaces continue to show registered commands based on visibility toggles rather than current workspace state.

## Key Changes

- Add `available?: () => boolean` to `CrucibleCommandEntry` and store it from `registerCrucibleCommand()`.
- Update `getPaletteItems()` to filter runtime suggestions:
  - Crucible commands: include only when not hidden and `entry.available?.()` is not false.
  - Non-Crucible commands: include only when whitelist/blacklist permits them and `cmd.checkCallback?.(true)` is not false/undefined.
  - Commands without `checkCallback` remain eligible.
- Do not change `CommandSuggest`, chain search, queueable command selection, or Settings -> Commands rendering.

## Test Plan

- Add focused tests for `getPaletteItems()`:
  - unavailable Crucible command is omitted
  - hidden Crucible command is omitted
  - available Crucible command remains
  - non-Crucible command with failing `checkCallback(true)` is omitted
  - non-Crucible whitelist/blacklist behavior still applies
- Run:
  - `npm run lint`
  - `npx tsc -noEmit -skipLibCheck`
  - `node esbuild.config.mjs production`
  - `npm test`

## Assumptions

- The reported no-op is caused by the file-open palette command being visible in Crucible's palette while `crucibleFileOpenPaletteEnabled` is false.
- Settings visibility remains registry-driven so users can still configure commands independent of current availability.
- Chain authoring remains registry-driven, preserving the prior fix for active-file-dependent commands.
