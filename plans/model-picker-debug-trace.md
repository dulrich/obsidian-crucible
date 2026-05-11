# Chain debug: instrument ModelPickerModal lifecycle

## Context

When a chain step runs an agent whose model binding is `runtime` (or `constrained` without a pinned model), `AgentManager.resolveModel` opens a `ModelPickerModal`. Clicking an item or pressing Enter should resolve the promise via `onChooseItem` → `onPick`. Instead, the chain debug log records `ERROR: Model selection cancelled`, which is only thrown when `ModelPickerModal.onClose()` runs with `picked === false`.

The current code (src/modelPicker.ts:32-40) assumes `onChooseItem` runs before `onClose`:

```ts
onChooseItem(item) { this.picked = true; this.onPick(...); }
onClose()         { super.onClose(); if (!this.picked && this.onCancel) this.onCancel(); }
```

Hypotheses for why cancel fires on a real selection:
1. Obsidian's `selectSuggestion` calls `close()` *before* `onChooseSuggestion` → `onClose` runs first, picked is still false, cancel fires.
2. `onChooseItem` isn't being invoked at all (signature mismatch, base class changed, etc.).
3. Some unrelated code path closes the modal before selection completes.

Goal: instrument the modal lifecycle so the next test run captures the actual call order in the chain debug.md, then write the right fix.

## Approach

Surface a lifecycle trace inside the `Model selection cancelled` error message. The existing chain error path (src/chains.ts:81) already writes `[step] ERROR: <message>` into debug.md, so we just enrich the message — no new file writes, no new infrastructure.

## Changes

### src/modelPicker.ts

Add a lightweight event log on the modal and include it in the cancel callback:

- Add fields: `private events: string[] = []` and `private startedAt = Date.now()`.
- Add helper `private trace(event: string)` that pushes `` `${Date.now() - this.startedAt}ms ${event}` `` and also `console.log('[ModelPicker]', event)`.
- Override and trace each lifecycle hook (each calls `super` where applicable):
  - `onOpen()` → `trace('onOpen')`
  - `selectSuggestion(value, evt)` → `trace('selectSuggestion(' + evt?.type + ')')`, then `super.selectSuggestion(value, evt)`
  - `onChooseSuggestion(item, evt)` → `trace('onChooseSuggestion')`, then `super.onChooseSuggestion(item, evt)`
  - `onChooseItem(item, evt)` → existing body + `trace('onChooseItem ' + item.provider.id + ':' + item.model.id)`. Accept the `evt` parameter to match the API signature (currently dropped).
  - `onClose()` → `trace('onClose picked=' + this.picked)`, `super.onClose()`, then `if (!this.picked && this.onCancel) this.onCancel(this.events.join(' → '))`.
- Change the `onCancel` callback type to `(trace?: string) => void` so the trace can be passed through.

### src/agents.ts

Update the cancel handler at src/agents.ts:151 to embed the trace:

```ts
(trace) => reject(new Error('Model selection cancelled' + (trace ? ' [' + trace + ']' : ''))),
```

No other call sites of `ModelPickerModal` exist (grep confirmed only modelPicker.ts and agents.ts).

## Files to modify

- `src/modelPicker.ts` — add lifecycle tracing, widen `onCancel` signature.
- `src/agents.ts` — pass the trace into the rejected error message.

## Verification

1. Build: `npm run build` (or rely on the watcher if dev mode is running).
2. Reload the Crucible plugin in Obsidian (Ctrl/Cmd+P → "Reload app without saving" or toggle the plugin).
3. Confirm the target chain has `debugMode: true` (otherwise no debug.md write — see src/chains.ts:62).
4. Run the Transcript Refine chain with the OpenRouter agent that triggers the picker.
5. Click a model (and separately, try Enter on a model).
6. Open the chain's debug log (default `_crucible/debug.md`). The ERROR line should now look like:
   `[crucible:agent:xyz] ERROR: Model selection cancelled [12ms onOpen → 3104ms selectSuggestion(click) → 3104ms onClose picked=false → 3105ms onChooseSuggestion → 3105ms onChooseItem openrouter:...]`
7. Also check the dev-tools console (Ctrl+Shift+I) for the `[ModelPicker]` lines as a backup.

The trace pins down which hypothesis is correct:
- If `onClose` appears before `onChooseItem` → hypothesis #1 (fix: defer the cancel check via `queueMicrotask`, or set `picked` in `selectSuggestion`/`onChooseSuggestion` override).
- If `onChooseItem` never appears → hypothesis #2 (signature/API issue).
- If neither selection event appears before `onClose` → hypothesis #3 (something else closes the modal — look upstream).

## Cleanup

This is diagnostic-only. Once the root cause is identified and fixed, remove the `trace` helper, the `events`/`startedAt` fields, and the extra overrides, keeping only whatever lifecycle override the fix actually needs.
