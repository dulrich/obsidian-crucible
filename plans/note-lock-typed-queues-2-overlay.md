# Chunk 2 — Locked-note overlay + auto-localize spinner

Part of [note-lock-typed-queues.md](./note-lock-typed-queues.md). Depends on Chunk 1.

## Goal
Visual feedback that a note is busy: gray-out + spinner overlay on the **active/visible**
note while it holds a note-lock. Also fixes "**working spinner missing on auto-localize**".

## New file: `src/noteLockOverlay.ts`
`class NoteLockOverlay` registered/owned by `main.ts`.
- Subscribe to `note-lock-changed`. Maintain the current set of locked paths + their labels.
- `sync()`: look up the active `MarkdownView` (`app.workspace.getActiveViewOfType(MarkdownView)`).
  If its `file.path` is locked → mount a `.crucible-note-locked` overlay div over the editor
  content area (`view.contentEl`), with a centered `crucible-spinner` + label text mapped from
  the lock label (`localize` → "Localizing…", `chain:*` → "Running chain…", `lint` → "Linting…",
  `yt-metadata` → "Fetching metadata…"). Otherwise remove any existing overlay.
- Overlay CSS: absolutely positioned, dim translucent background, `pointer-events: all` to
  block edits, spinner centered. Only one overlay at a time (active note only).
- Re-run `sync()` on: `note-lock-changed`, and `workspace.on('active-leaf-change')` (registered
  via `plugin.registerEvent`) so switching into/out of a locked note shows/hides correctly.
- `dispose()` removes overlay + unsubscribes.

## Wire-up `main.ts`
Instantiate in `onload()` after `noteLocks`; call `dispose()` in `onunload()`.

## Styles: `styles.css`
Add `.crucible-note-locked` (overlay) rules. Reuse existing `.crucible-spinner`.

## Auto-localize spinner fix
Root cause: auto path calls `localizeNote(file, /*silent*/ true)` (`main.ts:123-127`), so no
Notice spinner. Now UI feedback comes from the **lock overlay** (Chunk 1 makes auto-localize
hold the lock), independent of the `silent` flag. Keep `silent: true` to suppress Notice toast
spam; the overlay covers visibility. No change needed to the `silent` semantics beyond
confirming the overlay appears for auto-localize.

## Verify
- `npm run build` green.
- Manual: trigger localize on a note with remote images → active note grays out with spinner,
  editing blocked, clears on completion. Edit a note to trigger auto-localize → overlay appears
  (previously nothing). Switch to another note mid-localize → overlay only on the locked note.
