# Sort dynamic Crucible collections in the settings UI

## Context

The settings tabs that render lists of dynamically-created elements (Captures, Chains, Providers, Agents, Shortcuts) currently display rows in insertion order. With more than a handful of items this becomes hard to scan. The Obsidian command palette already sorts these commands alphabetically (Obsidian's default), and the "Command visibility" section also already sorts its grouped command lists (`src/settings.ts:310,346`). The remaining gap is the per-collection list views in the settings tabs.

We will sort the rendered rows by display name (`localeCompare`) without touching the underlying `settings.*` arrays. Preserving the underlying order is important because three of these collections derive their command IDs from array index — `chain-${index}`, `capture-${index}`, `shortcut-${index}` (see `src/main.ts:494,783,354`) — and those IDs are referenced by `settings.hiddenCommands` and any user-bound hotkeys. Re-ordering the array would silently re-map those IDs.

Unnamed items (empty `name`) will sort to the bottom so newly-added rows don't visually pollute the named list.

## Approach

Replace each `settings.X.forEach((item, index) => ...)` list-rendering call with a sort-by-display-tuple pattern. The `index` value passed into each row's callbacks (edit / duplicate / delete) must remain the index in the underlying array, so we sort tuples of `{ item, index }` rather than the array itself.

Helper pattern (used at every site, not extracted — each site is a single block and inlining keeps the diff easier to read):

```ts
const sorted = this.plugin.settings.X
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
        const an = a.item.name || '';
        const bn = b.item.name || '';
        if (!an && bn) return 1;   // empty names last
        if (an && !bn) return -1;
        return an.localeCompare(bn);
    });
sorted.forEach(({ item, index }, displayIdx) => {
    if (displayIdx > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
    // existing row body, using `item` for display and `index` for callbacks
});
```

## Files to modify

All edits are in `src/settings.ts`:

1. **`renderCaptureListSection`** (`src/settings.ts:467`) — `settings.captures.forEach((capture, index) => ...)`. Callbacks use `index` for `editingCaptureIndex` and `splice(index, 1)`.
2. **`renderChainListSection`** (`src/settings.ts:549`) — `settings.chains.forEach((chain, index) => ...)`. Callbacks use `index` for `editingChainIndex` and `splice(index, 1)`.
3. **`renderProviderListSection`** (`src/settings.ts:969`) — `settings.providers.forEach((provider, index) => ...)`. Callbacks use `index` for `editingProviderIndex` and `deleteProvider(index)`.
4. **`renderAgentListSection`** (`src/settings.ts:1216`) — `settings.agents.forEach((agent, index) => ...)`. Callbacks use `index` for `editingAgentIndex` and `deleteAgent(index)`.
5. **`renderShortcutSettings`** (`src/settings.ts:2268`) — `settings.shortcuts.forEach((shortcut, index) => ...)`. Callback uses `index` for `splice(index, 1)`; inline text/file edits mutate the `shortcut` object reference directly, so they continue to work without re-rendering.

Note: the `index > 0` check that draws inset dividers currently uses the original-array index; switch it to the display index (the second arg of the outer `forEach` on the sorted tuples) so dividers appear between rendered rows rather than between original positions.

## Out of scope (intentionally not touched)

- `src/main.ts` `registerCaptures` / `registerChains` / `registerShortcuts` — registration order doesn't affect palette display order (Obsidian sorts), and changing iteration would risk shifting the index-derived IDs.
- `src/agents.ts` `registerAgents` — registers internal (non-palette) commands; order is irrelevant.
- `renderCommandSettings` (`src/settings.ts:290`) — its `renderGroup` already calls `commands.sort((a, b) => a.name.localeCompare(b.name))`.
- Workflows tab — not in the user's list.

## Verification

1. Run the mandatory cleanup loop from `AGENTS.md`: `npm run lint`, `npx tsc -noEmit -skipLibCheck`, `node esbuild.config.mjs production`.
2. Reload the plugin in Obsidian (Command Palette → "Reload Plugin").
3. Open Settings → Crucible, then for each of the five tabs / sections:
   - Add three items with names like `Zeta`, `Alpha`, `Mike`. Confirm they render `Alpha`, `Mike`, `Zeta`.
   - Add a fourth item and leave its name blank — confirm it renders at the bottom.
   - Edit `Mike` → rename to `Aardvark` and back out — confirm it moves to the top.
   - Click pencil on `Zeta` — confirm the editor opens the correct item (validates that callbacks still use the original-array index).
   - Click trash on `Alpha` — confirm `Alpha` (not the row at its display position in some other array) is what gets removed.
4. For Captures / Chains / Shortcuts specifically: open the Command Palette and confirm any existing hotkey bound to a `Crucible: Capture: Foo` / `Crucible: Chain: Foo` / `Crucible: Shortcut: Foo` still triggers the correct command (validates that command IDs were not shifted).
