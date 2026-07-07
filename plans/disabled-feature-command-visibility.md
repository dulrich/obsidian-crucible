# Disabled-state help for feature-gated commands

*Recommended model/effort — Claude: Sonnet/medium; Codex: GPT-5-Codex medium reasoning, because this is a small cross-surface settings contract change.*

## Summary

Make Command visibility rows distinguish "user hid this command" from "this command is disabled by a separate feature toggle." Rows for feature-gated commands will show a disabled/warning state with help text pointing to the setting that enables the feature, instead of implying the Palette/Chains toggles are sufficient.

## Key Changes

**WP-1 — Feature-gate metadata (~0.15 kSLOC touched, ~20k tokens).** Extend Crucible command registration metadata with optional feature-disabled help, separate from context availability.
Files: `src/main.ts`, `src/commands.ts`. *Model: mid (Claude Sonnet/medium; Codex GPT-5-Codex medium). Execution: direct.*

- Add optional `availabilityHelp?: () => string | null` or equivalent to `registerCrucibleCommand()` and `CrucibleCommandEntry`.
- Use it only for commands disabled by a separate setting, not for context-gated commands like "needs active editor/file."
- Add help for:
  - `Open Crucible command palette`
  - `Debug command palette hints`
  - `Open Crucible file-open palette`

**WP-2 — Command visibility UI state (~0.25 kSLOC touched, ~30k tokens).** Render feature-disabled rows with existing warning/disabled styling and disable their Palette/Chains toggles while preserving stored preferences.
Files: `src/settings/sections/commands.ts`, maybe `styles.css` only if existing styles are insufficient. *Model: mid. Execution: direct.*

- In the main Command visibility list, evaluate `cmd.availabilityHelp?.()`.
- If present:
  - Set row description to the help text.
  - Add `crucible-setting-warning`/disabled styling using existing conventions.
  - Disable Palette and Chains toggle controls but leave their current on/off value visible as the saved preference for when the feature is enabled.
- Help text should be explicit:
  - "Enable Commands -> Command palette -> Enable Crucible command palette."
  - "Enable Commands -> File-open palette -> Enable Crucible file-open palette."

**WP-3 — Chain picker alignment for feature-disabled commands (~0.15 kSLOC touched, ~25k tokens).** Exclude commands disabled by a feature toggle from chain-step search while preserving the prior rule that context-gated commands remain authorable.
Files: `src/settings/sections/automate.ts` plus a small helper if useful. *Model: mid. Execution: direct.*

- Build an additional exclude list from command entries whose feature-disabled help is currently non-null.
- Merge that with `hiddenFromChainSearch` for the chain-step `CommandSuggest`.
- Do not filter active-file/editor-gated commands; only use the new feature-gate metadata.

**WP-4 — Tests and plan record (~0.2 kSLOC touched, ~25k tokens).** Add focused tests for feature-gate metadata behavior and run the required gates.
Files: `tests/*`, `plans/disabled-feature-command-visibility.md`. *Model: mid. Execution: direct.*

## Public Interfaces

- Add optional command metadata:
  - `availabilityHelp?: () => string | null`
- Semantics:
  - `available` remains runtime execution availability.
  - `availabilityHelp` is settings-facing feature-gate help only.
  - `null` means no feature-gate disabled state.
  - Non-null string means the command is disabled by another setting and should show that text in the visibility UI.

## Test Plan

- Unit-test helper behavior if extracted:
  - command with no `availabilityHelp` is not feature-disabled
  - command with `availabilityHelp` returning text is feature-disabled
  - feature-disabled command IDs can be merged with `hiddenFromChainSearch`
- Existing command palette tests should still pass.
- Run:
  - `npm run lint`
  - `npx tsc -noEmit -skipLibCheck`
  - `node esbuild.config.mjs production`
  - `npm test`

## Assumptions

- This should not apply to context availability like active file, active editor, or note mode.
- Saved Palette/Chains preferences should not be overwritten when a feature is disabled.
- First implementation step after approval is writing this plan to `plans/disabled-feature-command-visibility.md`; if `DEVELOPMENT.md` has pending-plan frontmatter, add the quoted wiki-link there without changing the body.

Total ≈ 0.75 kSLOC, ~100k tokens.
