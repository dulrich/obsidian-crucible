# Crucible Command Palette

## Context

Obsidian's core "Command palette" plugin offers fuzzy search across all registered commands and a "pinned commands" list, but it does not let users curate *which* non-plugin commands appear. Crucible already has a rich visibility system (`hiddenCommands`, `hiddenFromChainSearch`) for its own commands, but no equivalent control over the surrounding Obsidian command surface. This adds an opt-in Crucible-flavored palette that:

1. Mirrors Obsidian's pinned-command behavior (search to add, reorderable list).
2. Continues to honor existing Crucible palette/chain visibility toggles for Crucible-owned commands.
3. Adds whitelist/blacklist filtering for *non-Crucible* commands, so power users can prune noisy palette entries from other plugins.

The feature ships gated behind a master toggle so existing users see no behavioral change until they opt in.

## Approach

A new `FuzzySuggestModal<Command>` subclass populated from `(app as any).commands.commands`, with pinned items pre-pended and an explicit filter applied to non-Crucible commands. Settings live in a new `.crucible-settings-group` appended to the bottom of the Commands tab in `src/settings.ts`. The "Open Crucible command palette" command is registered via `registerCrucibleCommand` with an `available()` predicate tied to the master toggle, so it disappears from Obsidian's own palette and hotkey assignment surface when disabled.

## Settings additions

In `src/types.ts`, extend `CrucibleSettings` and `DEFAULT_SETTINGS`:

```ts
crucibleCommandPaletteEnabled: boolean;          // default: false
crucibleCommandPalettePinned: string[];          // ordered command IDs (Obsidian-prefixed form, e.g. "obsidian-crucible:lint-note"), default: []
crucibleCommandPaletteFilterMode: 'whitelist' | 'blacklist'; // default: 'blacklist'
crucibleCommandPaletteWhitelist: string[];       // command IDs (set semantics), default: []
crucibleCommandPaletteBlacklist: string[];       // command IDs (set semantics), default: []
```

Pinned uses the prefixed ID form (matches what `app.commands.commands` keys look like) so lookups don't require translation at render time. Whitelist/blacklist also use prefixed IDs for the same reason.

## New file: `src/commandPalette.ts`

Exports `CrucibleCommandPaletteModal extends FuzzySuggestModal<Command>`:

- Constructor takes `app` and `plugin`. Calls `super(app)` and `setPlaceholder('Crucible: search commands...')`.
- `getItems()`:
  - Pull all commands: `Object.values((this.app as any).commands.commands) as Command[]`.
  - Build the Crucible ID set: `new Set(plugin.commandRegistry.map(e => \`\${plugin.manifest.id}:\${e.id}\`))`.
  - For each command:
    - If it's a Crucible command: include unless `plugin.settings.hiddenCommands.includes(<un-prefixed id>)` — reuse the same un-prefix step that `registerCrucibleCommand` already implies.
    - Else (non-Crucible): in `'blacklist'` mode include iff not in blacklist; in `'whitelist'` mode include iff in whitelist.
  - Order: pinned commands first (in user-defined order, filtered to those still resolvable and still passing the filter), then remaining matches.
- `getItemText(cmd)`: `cmd.name`.
- `onChooseItem(cmd)`: `(this.app as any).commands.executeCommandById(cmd.id)`.
- `renderSuggestion`: extend default to render a small "📌" prefix (text only, no emoji — use a class `crucible-palette-pinned` for the marker) for pinned items. Confirm with user before adding an icon; if uncertain, ship without the marker.

Note: pinned ordering must be preserved even when fuzzy search would rank them lower; this is achieved by sorting the suggestion list so pinned matches float to the top while preserving their relative order. Implement via a `getSuggestions(query)` override that first calls `super.getSuggestions(query)`, then partitions into pinned vs non-pinned and concatenates.

## Wiring in `src/main.ts`

Register a new command in the existing setup path (group `'Other'`, since no dedicated group exists and adding one would force `CrucibleCommandGroup` + `GROUP_ORDER` edits for one item):

```ts
this.registerCrucibleCommand({
  id: 'open-crucible-command-palette',
  name: 'Open Crucible command palette',
  group: 'Other',
  available: () => this.settings.crucibleCommandPaletteEnabled,
  run: () => new CrucibleCommandPaletteModal(this.app, this).open(),
});
```

The `available` predicate makes the command disappear from Obsidian's own palette when the toggle is off (this is already enforced by `registerCrucibleCommand`'s `checkCallback` at `src/main.ts:352-370`).

## Settings UI in `src/settings.ts`

Append a new section to `renderCommandSettings()` (currently ends around line 392), inside its own `.crucible-settings-group`:

1. **Master toggle row**: `new Setting(group).setName('Enable Crucible command palette').setDesc(...)` with a toggle bound to `settings.crucibleCommandPaletteEnabled`. On change: save settings, call `this.plugin.refreshDynamicCommands?.()` or equivalent so the `available()` predicate is re-evaluated (Obsidian re-reads on each invocation, but settings tab needs to re-render). Then `this.display()` to re-render.
2. **If enabled**, render below the toggle (separated by `crucible-row-divider`):
   - **Pinned commands subsection**:
     - `Setting` with a text input bound to a fresh `CommandSuggest` (from `src/suggesters.ts`) — pass `excludeIds: settings.crucibleCommandPalettePinned` to prevent duplicates. On choose, push the command ID, save, re-render.
     - For each entry in `crucibleCommandPalettePinned`: a row showing the command name (look up via `getCommandSuggestDisplayName`), with `↑` / `↓` / `×` buttons. Disable `↑` for index 0 and `↓` for the last index. Each rearrange/remove saves and re-renders.
   - **Filter mode subsection**:
     - `Setting` with a dropdown: `Whitelist` / `Blacklist`, bound to `crucibleCommandPaletteFilterMode`.
     - Below it, a single list whose label and target array swap based on mode (`Whitelist commands` / `Blacklist commands`). Same `CommandSuggest` + row pattern as pinned, minus the arrows (order doesn't matter for set semantics — confirmed with user).

Use the existing `toggleList()` helper for whitelist/blacklist add/remove. For pinned, write an inline `moveInArray(arr, from, to)` helper local to `settings.ts` (do not over-abstract for a single use site).

## Critical files to modify

- `src/types.ts` — settings interface + defaults (5 new fields).
- `src/main.ts` — register the palette command (one `registerCrucibleCommand` call near other `'Other'`-group registrations).
- `src/settings.ts` — extend `renderCommandSettings()` with the new section at the bottom.
- `src/commandPalette.ts` — **new file**, ~80 lines.
- `styles.css` — minor class for the optional pinned marker if added (see open question).

## Reuse / no-new-abstractions

- `CommandSuggest` (`src/suggesters.ts:92-140`) and its helpers `getCommandSuggestItems`, `findCommandSuggestItem`, `getCommandSuggestDisplayName` cover all command-picker input needs — no new suggester class.
- `toggleList()` (existing) handles whitelist/blacklist add/remove.
- `registerCrucibleCommand`'s `available` field (`src/main.ts:352-370`) is the existing mechanism for conditional command visibility — no new gating system.
- `.crucible-settings-group` and `.crucible-row-divider` (existing CSS) cover the visual structure.
- `FuzzySuggestModal` is already used in `src/modelPicker.ts:1-51` — model the new modal on that file's structure.

## Verification

1. **Build hygiene** (mandatory cleanup loop from AGENTS.md):
   - `npm run lint`
   - `npx tsc -noEmit -skipLibCheck`
   - `node esbuild.config.mjs production`
2. **Functional smoke test in Obsidian** (after `npm run dev` + Reload Plugin):
   - With master toggle OFF: confirm "Open Crucible command palette" does NOT appear in Obsidian's core palette or Hotkeys settings.
   - Flip toggle ON: confirm the command appears and opens the modal.
   - Pin two commands, verify they appear at the top of suggestion list and respect ↑/↓ order.
   - Switch to Whitelist mode with empty list: confirm only Crucible commands appear (subject to `hiddenCommands`).
   - Add one non-Crucible command via the whitelist input: confirm it now appears.
   - Switch back to Blacklist mode: confirm all non-Crucible commands appear again.
   - Add a non-Crucible command to the blacklist: confirm it disappears.
   - Hide a Crucible command via the existing Palette toggle: confirm it disappears from the Crucible palette too.
   - Selecting any suggestion executes the command (try `Lint: lint note` and a built-in like `Open today's daily note`).
3. **Persistence**: reload Obsidian and confirm pinned/whitelist/blacklist/mode/master toggle all round-trip via `data.json`.

## Open questions deferred to implementation

- Pinned-row visual marker: skip on first pass; if user wants a visual cue post-implementation, add a `crucible-palette-pinned` span with a small text glyph.
- Whether to surface a hotkey hint next to each suggestion (Obsidian's own palette does this). Out of scope unless user asks.

## Post-implementation chore

Per memory: copy this plan to `/home/_shared_code/obsidian-crucible/plans/` before starting implementation, and add a one-line entry to `AGENTS.md`'s `## Quirks` section if the modal hits any non-obvious Obsidian behavior (e.g., the `selectSuggestion` ordering bug already documented for `FuzzySuggestModal`).
