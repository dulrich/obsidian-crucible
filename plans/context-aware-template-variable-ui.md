# Context-Aware Template Variables UI

## Summary
Add a reusable expandable variables helper next to each template-capable setting. The helper appears as an icon button on the setting row and expands inline inside the same `.crucible-settings-group`, immediately before the next `.crucible-row-divider`.

## Key Changes
- Create a shared settings helper that renders an icon-only variables button with a tooltip and an inline variables panel.
- Track expanded panels in memory on `CrucibleSettingTab`; expansion does not persist after settings are closed.
- Reuse the same variable-grid renderer for both the inline panels and the existing global template variables section.
- Show context-specific variables for capture templates, chain arguments, agent prompts, and period note templates.

## Test Plan
- Manually inspect each target location and verify the icon toggles an inline panel before the next separator.
- Verify each location shows only its relevant variable set.
- Verify agent prompt helper appears for inline text prompts and disappears when prompt source is `Vault file`.
- Verify chain variable panel includes custom `chain.variables` entries and built-in runtime variables.
- Run `npm run lint`, `npx tsc -noEmit -skipLibCheck`, and `node esbuild.config.mjs production`.
