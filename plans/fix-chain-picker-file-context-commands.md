# Fix: file-context commands missing from chain step picker

## Context

While building a new "Ingest as Transcript" chain, the user could not select **"Crucible: Move current file to daily folder"** as a step — it was absent from the chain step search results, even though the command is registered and not hidden in either user-toggle list.

## Root cause

The chain step picker (`src/settings.ts:687-689`) uses `CommandSuggest`, which calls `app.commands.listCommands()` (`src/suggesters.ts:142-145`). Obsidian's `listCommands()` only returns commands whose `checkCallback` returns `true` *right now*.

`move-current-file-to-daily-folder` is registered at `src/main.ts:393-409` with:

```ts
checkCallback: (checking) => {
  if (this.settings.hiddenCommands.includes(moveDailyId)) return false;
  const activeFile = this.app.workspace.getActiveFile();
  if (!activeFile) return false;   // ← filters it out during chain authoring
  ...
}
```

When the Settings tab is open, there is often no active file, so the command is filtered out *before* the picker can see it. This affects every file-context command using the same `if (!activeFile) return false` pattern (e.g. `move-current-file-to-folder` at `src/main.ts:411-419`, plus other `addCommand` blocks in `main.ts` that gate on an active file).

This contradicts the existing UI design at `src/settings.ts:220-236`, which exposes **two independent toggles per command** — *Show in Command Palette* and *Show in Chain Search* — implying chain visibility should not depend on palette/runtime availability.

The user's `data.json` confirms `move-current-file-to-daily-folder` is in *neither* `hiddenCommands` nor `hiddenFromChainSearch`, so settings are not the cause.

## Recommended approach

Make chain search source from the **registered command set**, not the **currently-runnable** set, so authoring is independent of current workspace state. Filtering is then governed solely by the existing `hiddenFromChainSearch` blocklist.

### Change 1 — `src/suggesters.ts:142-145`

Replace the source of `getCommandSuggestItems` so it reads from `app.commands.commands` (all registered commands) instead of `app.commands.listCommands()` (currently-available subset).

```ts
export function getCommandSuggestItems(app: App, extraCommands: Command[] = []): Command[] {
  const commands = Object.values((app as any).commands.commands) as Command[];
  return [...extraCommands, ...commands];
}
```

`app.commands.commands` is a dict keyed by command ID; `Object.values` gives the full registry regardless of `checkCallback` state. The `hiddenFromChainSearch` filter in `CommandSuggest.getItems()` (`src/suggesters.ts:106-111`) continues to apply as before, so users keep per-command control.

### Change 2 — verify `findCommandSuggestItem` (`src/suggesters.ts:147-…`)

The neighboring helper `findCommandSuggestItem` also calls `getCommandSuggestItems`, so it inherits the fix automatically. No additional change needed, but confirm during implementation.

### Why not the alternatives

- **Drop the `if (!activeFile) return false` guard** in each file-context command: would surface broken commands in the Command Palette when no file is open, regressing palette UX. The current `checkCallback` behavior is correct *for the palette* and *for runtime gating*; only chain authoring is wrong.
- **Add each file-context command to `getChainCommandExtras()`**: would create duplicate entries when a file *is* active (one from extras, one from `listCommands()`). Also brittle — every new file-context command would need to be remembered.
- **Keep `listCommands()` and special-case `getActiveFile`**: doesn't generalize; other `checkCallback`-gated conditions (selection-only commands, mode-only commands) would still leak the same bug.

## Critical files

- `src/suggesters.ts` — change command source (single-line edit at `getCommandSuggestItems`)
- `src/settings.ts:687-689` — no edit needed; consumer of the fixed function
- `src/main.ts:393-409` — no edit needed; the `checkCallback` remains correct for palette/runtime use

## Verification

1. **Reproduce the bug first**: open Settings → Chains, create a new chain, search for "daily folder" in a step's command picker. Without an active file open, confirm the command is missing.
2. **Apply the fix**, rebuild (`npm run build`), reload the plugin in Obsidian.
3. **Re-test**: with no active file, the command must now appear in the chain step picker.
4. **Regression check**:
   - Toggle "Show in Chain Search" OFF for `move-current-file-to-daily-folder` in Settings → Files → confirm it disappears from the picker.
   - Toggle it back ON → confirm it reappears.
   - Open the Command Palette with no active file → confirm the command is still hidden there (palette behavior unchanged).
   - Open the Command Palette with an active file → confirm the command runs normally.
5. **Author "Ingest as Transcript"** end-to-end: add the daily-folder command as Step 2, save, run the chain on a real file, confirm the file is moved.
