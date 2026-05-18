# Plan: command registry — fix Lint visibility settings drift

## Context

`lint-cleanup-transcript` was added at `src/main.ts:150-158` but never appeared in
**Crucible Settings → Commands → Lint**. The cause is architectural, not a one-line miss:

- Real commands live in `src/main.ts` as ~20 static `this.addCommand({ id, name, checkCallback })`
  calls plus 4 dynamic loops (Shortcuts, Captures, Chains, move-file pickers).
- The settings UI in `src/settings.ts:373-416` is driven by **hardcoded `{ id, name }[]` arrays**
  (`materializeCommands`, `lintCommands`, `filesCommands`, …) that duplicate the registrations.
- These two lists are independent. When a developer adds a command in `main.ts`, the settings
  array silently goes stale and the command becomes uncontrollable from the UI.

Goal: make the settings UI **derive its command list from the actual registrations** so newly
added commands automatically appear in the right group, with no second list to maintain.

## Approach — single source of truth via a registration helper

Introduce a small command-registry on the plugin. Every command flows through one helper that
both registers with Obsidian and records `{ id, name, group }`. Settings renders directly from
the registry.

### 1. Add a registry to `CruciblePlugin` — `src/main.ts`

```ts
export type CrucibleCommandGroup =
  | 'Materialize' | 'Lint'  | 'Files'  | 'Shortcuts'
  | 'Captures'    | 'Chains'| 'Agents' | 'Orchestrations' | 'Other';

export interface CrucibleCommandEntry {
  id: string;
  name: string;
  group: CrucibleCommandGroup;
}

// On the plugin class:
commandRegistry: CrucibleCommandEntry[] = [];
```

### 2. Add `registerCrucibleCommand` helper

Wraps `this.addCommand` and bakes in the uniform `hiddenCommands` check that every existing
command already duplicates.

```ts
private registerCrucibleCommand(opts: {
  id: string;
  name: string;
  group: CrucibleCommandGroup;
  run: () => void | Promise<void>;
  available?: () => boolean;   // optional extra gate (e.g., needs active file)
}) {
  this.commandRegistry.push({ id: opts.id, name: opts.name, group: opts.group });
  this.addCommand({
    id: opts.id,
    name: opts.name,
    checkCallback: (checking) => {
      if (this.settings.hiddenCommands.includes(opts.id)) return false;
      if (opts.available && !opts.available()) return false;
      if (!checking) { void opts.run(); }
      return true;
    },
  });
}
```

Rationale for baking in the hidden-commands check: every existing static command in
`main.ts:68-247` does exactly this check identically. Centralising it removes ~3 duplicated
lines per command and guarantees consistent behavior.

### 3. Convert every `addCommand` call to the helper — `src/main.ts`

- Static commands (`main.ts:68-247`): mechanical rewrite to `registerCrucibleCommand` with the
  correct `group` literal. Mapping:
  - `materialize-*` → `'Materialize'`
  - `word-count`, `lint-note`, `lint-vault`, `lint-cleanup-transcript` → `'Lint'`
  - `mark-as-forwarded`, `reload-plugin`, `open-settings-tab` → `'Other'`
  - `orchestrator-*` → `'Orchestrations'` (new group — these get their own section in the
    settings UI instead of being lumped in with Other)
- Dynamic loops:
  - Shortcuts loop near `main.ts:364` → `group: 'Shortcuts'`
  - Move-file commands near `main.ts:413`/`L431` → `group: 'Files'`
  - Captures loop near `main.ts:518` → `group: 'Captures'`
  - Chains loop near `main.ts:794` → `group: 'Chains'`
- Agents: agents are registered inside `AgentManager.registerAgents()`. Either expose a callback
  so they push into `plugin.commandRegistry`, or have the manager call
  `plugin.registerCrucibleCommand`. Pick whichever keeps the manager's existing constructor
  signature minimal — most likely passing the helper as a bound callback.

When the registry is rebuilt (e.g., user edits shortcuts and they re-register), clear the
relevant group's entries first or rebuild the whole registry — implementation can decide based
on the existing re-registration flow. **Open this during implementation:** verify whether
shortcut/capture/chain re-registration already removes-then-adds commands, and mirror that for
the registry.

### 4. Drive the settings UI from the registry — `src/settings.ts`

Replace the four hardcoded arrays in `renderCommandSettings()` (`settings.ts:373-416`) with:

```ts
const GROUP_ORDER: CrucibleCommandGroup[] = [
  'Materialize', 'Lint', 'Files', 'Shortcuts',
  'Captures', 'Chains', 'Agents', 'Orchestrations', 'Other',
];

for (const group of GROUP_ORDER) {
  const commands = this.plugin.commandRegistry.filter(c => c.group === group);
  renderGroup(group, commands);   // existing helper, unchanged
}
```

`renderGroup` already sorts and renders — no changes needed there. Existing `renderHotkey`,
`hiddenCommands`, `hiddenFromChainSearch` plumbing is untouched.

### 5. Document the quirk — `AGENTS.md`

Add one line under the existing **## Quirks** section (`AGENTS.md:112`):

> - **Commands must be registered via `this.registerCrucibleCommand({ ..., group })`, not
>   `this.addCommand` directly.** The group field is what makes the command appear in
>   Crucible → Settings → Commands; bypassing the helper means the command works but is
>   invisible to the visibility UI.

## Files to modify

| File | Change |
| --- | --- |
| `src/main.ts` | Add `commandRegistry` field, `registerCrucibleCommand` helper, and rewrite ~20 static + 4 dynamic `addCommand` call sites to use it. |
| `src/settings.ts` | Delete `materializeCommands` / `lintCommands` / `filesCommands` / `otherCommands` literals (`L373-L416`). Replace with `GROUP_ORDER`-driven loop reading `this.plugin.commandRegistry`. |
| `src/agents.ts` (or wherever `AgentManager.registerAgents` lives) | Route agent command registration through the helper so Agents appear in the registry. |
| `AGENTS.md` | Add Quirks bullet. |
| `src/types.ts` | Optional: export `CrucibleCommandGroup` / `CrucibleCommandEntry` if used outside `main.ts`. |

## Reused / existing pieces

- `renderGroup` / `renderChainOnlyGroup` in `settings.ts:312-371` — unchanged, they already
  accept `{ id, name }[]` and handle sorting, hotkeys, and both toggles.
- `settings.hiddenCommands` / `settings.hiddenFromChainSearch` plumbing — unchanged.
- `this.chainManager.executeInternalCommand(...)` invocation pattern — unchanged; just moves
  inside the helper's `run` callback.

## Verification

1. `npm run lint` — required per `AGENTS.md`. Must pass.
2. `npm run build` — must succeed.
3. Reload the plugin in Obsidian. Open **Crucible → Settings → Commands** and confirm:
   - **Lint: cleanup transcript** now appears in the Lint group with both Palette and Chains
     toggles.
   - All other previously visible commands (Materialize, Lint, Files, Other, Shortcuts,
     Captures, Chains, Agents) still appear with the same order and labels.
4. Toggle **Lint: cleanup transcript → Palette** off, open the Obsidian command palette, and
   confirm the command is hidden. Toggle it back on, confirm it reappears.
5. As a regression check, run any existing materialize/lint/orchestrate command via the palette
   and confirm behavior is unchanged.
6. Add a throwaway test command somewhere with `group: 'Other'`, reload, confirm it appears in
   the Other section automatically — then remove it.

## Out of scope (intentional)

- The chain-only internal command registry at `main.ts:~630` (`register(...)`) and its
  `renderChainOnlyGroup` consumers — those use a separate mechanism and are not affected by
  the visibility-tab drift.
- Apparent name/id mismatches in some orchestrator command blocks (e.g.,
  `orchestrator-run-next` paired with the name `Orchestrate: scan`). Worth a separate look but
  not part of this fix.
