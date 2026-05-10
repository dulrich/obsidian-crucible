# Make Crucible commands work in read mode

## Context

Crucible's chain commands, capture commands, and `mark-as-forwarded` are registered with `editorCheckCallback` / `editorCallback`. Those Obsidian APIs only fire when the active leaf has an `Editor` — which means the read-mode `MarkdownView` is excluded. Consequence: from a note opened in read mode, the user can highlight/copy text and clearly has a selection, but Crucible's commands don't even show up in the Command Palette (looks like they aren't registered). The user reported this as a regression because the new in-tab settings view (`fd55ce6`) and ordinary read-mode workflows both expose the gap.

The fix is to register these as plain `checkCallback` commands so they always appear, then resolve the editor opportunistically and use sensible read-mode equivalents for selection (DOM selection) while clearly rejecting cursor-dependent steps with a Notice.

## Audit: what actually needs an editor

From `src/main.ts` `registerInternalCommands` (line 544) and `src/agents.ts`:

| Step / command | Editor use | Read-mode plan |
|---|---|---|
| `source:selection` (main.ts:577) | `editor.getSelection()` | Fall back to `window.getSelection()?.toString()`; if empty, throw with clear message. |
| `source:line` (in `resolveCaptureValue`, main.ts:489) | `editor.getLine(editor.getCursor().line)` | No DOM equivalent. Throw "Requires edit mode" Notice. |
| `mark-as-forwarded` (main.ts:597) | cursor + `setLine` | Notice "Switch to edit mode to use this command"; return false. |
| `findCurrentSectionHeader` (main.ts:848) | walks editor lines from cursor up | When capture mode is `'source'` and no editor, throw "Requires edit mode for source-section context" Notice. |
| All other internal commands (`materialize-*`, `lint-*`, `source:active-file`, `copy-active-file`, `copy-note-to-folder`, `replace-note-body`, `upsert-tags`, `upsert-property`, `source:input`, `move-current-file-*`, all agents) | unused (`_editor` ignored) | Run unchanged; pass `editor: undefined`. |

So the only steps that genuinely need the source `Editor` are the cursor-line writers (`mark-as-forwarded`) and cursor-line readers (`source:line`, `findCurrentSectionHeader`). `source:selection` has a DOM-based fallback. Everything else is editor-agnostic.

## Files to modify

- `src/main.ts` — three command registrations and three internal-command bodies

## Implementation

### 1. Add an `activeEditor()` helper near the top of `CruciblePlugin`

```ts
private activeEditor(): Editor | undefined {
    return this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? undefined;
}
```

`MarkdownView` is already imported (main.ts:1). Read-mode `MarkdownView.editor` is undefined, so this returns `undefined` cleanly.

### 2. `registerChains` (main.ts:713-732) — switch to `checkCallback`

```ts
this.addCommand({
    id,
    name: `Chain: ${chain.name}`,
    checkCallback: (checking: boolean) => {
        if (this.settings.hiddenCommands.includes(id)) return false;
        if (!checking) {
            const editor = this.activeEditor();
            const spawnFile = this.app.workspace.getActiveFile() ?? undefined;
            void this.chainManager.executeChain(chain, editor, spawnFile);
        }
        return true;
    }
});
```

### 3. `registerCaptures` (main.ts:460-480) — same swap

```ts
this.addCommand({
    id,
    name: `Capture: ${capture.name}`,
    checkCallback: (checking: boolean) => {
        if (this.settings.hiddenCommands.includes(id)) return false;
        if (!checking) {
            void (async () => {
                const editor = this.activeEditor();
                const value = await this.resolveCaptureValue(capture, editor);
                if (value === null) return;
                await this.captureManager.executeCapture(
                    capture,
                    value,
                    undefined,
                    this.resolveCaptureContext(editor, capture),
                );
            })();
        }
        return true;
    }
});
```

`resolveCaptureContext` now takes the `capture` so it can decide whether source-section context is required (see step 6).

### 4. `mark-as-forwarded` public command (main.ts:150-157) — `checkCallback` with Notice on miss

```ts
this.addCommand({
    id: 'mark-as-forwarded',
    name: 'Mark as forwarded',
    checkCallback: (checking: boolean) => {
        if (this.settings.hiddenCommands.includes('mark-as-forwarded')) return false;
        if (!checking) {
            const editor = this.activeEditor();
            if (!editor) { new Notice('Switch to edit mode to use this command'); return; }
            void this.chainManager.executeInternalCommand(`${prefix}:mark-as-forwarded`, {}, null, editor);
        }
        return true;
    }
});
```

Tighten the internal `mark-as-forwarded` (main.ts:597) so it `throw`s when invoked without editor — chains that reach it without an editor surface a clear failure rather than silently halting.

### 5. `source:selection` (main.ts:577-580) — DOM fallback

```ts
register('source:selection', async (_args, _prev, editor) => {
    if (editor) return editor.getSelection();
    const dom = window.getSelection()?.toString() ?? '';
    if (!dom) throw new Error('No text selected. Select text in the note first.');
    return dom;
});
```

Caveat: DOM selection in read mode returns the rendered text, so wikilinks/headers/embeds reflect their displayed form rather than source markdown. Acceptable — Ctrl+C-equivalent UX.

### 6. Captures' `resolveCaptureValue` (main.ts:484-511) and `resolveCaptureContext` (main.ts:513-517)

`resolveCaptureValue`:

- `selection`: editor → DOM selection. Empty → Notice `'No text selected'` and return `null`.
- `selection-fallback`: editor → DOM selection → dialog prompt.
- `line`: when `!editor`, Notice `'Requires edit mode'` and return `null`.
- `line-fallback`: when `!editor`, go straight to `promptForCaptureValue` (existing degraded path).
- `dialog`: unchanged.

`resolveCaptureContext` (now takes `capture`):

```ts
private resolveCaptureContext(editor: Editor | undefined, capture: Capture): CaptureExecutionContext {
    if ((capture.targetSectionMode ?? 'fixed') === 'source' && !editor) {
        new Notice('This capture targets the source section but no editor is active. Switch to edit mode.');
        throw new Error('Source-section capture requires an active editor');
    }
    return { sourceSectionHeader: editor ? findCurrentSectionHeader(editor) : null };
}
```

Update all call sites (main.ts:456, main.ts:474, main.ts:670) to pass `capture`.

## Verification

1. **Build**: `npx tsc --noEmit` and `node esbuild.config.mjs production`. Both must finish clean.
2. **Read-mode discovery**: open a note in read mode, hit Cmd+P, search "Chain:" — chain commands appear. Same for Capture: and Mark as forwarded.
3. **DOM selection chain**: in read mode, highlight a paragraph, run a chain whose first step is `source:selection`; chain runs with the highlighted text as `{{response}}`.
4. **No-selection failure**: in read mode with nothing highlighted, run `source:selection` chain → Notice "No text selected. Select text in the note first." Chain halts cleanly.
5. **mark-as-forwarded in read mode**: invoking shows "Switch to edit mode to use this command" Notice; no edits made.
6. **Capture with `targetSectionMode: 'source'` in read mode**: Notice "Switch to edit mode" and capture is not written.
7. **Capture with `source:dialog` in read mode**: works exactly as before (dialog opens, value written).
8. **Edit-mode regression check**: switch to edit/live-preview, invoke each affected command — behavior matches pre-change.
