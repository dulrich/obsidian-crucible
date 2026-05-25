# Ingestion Dashboard: Orphaned Attachments cleanup section

## Context

The Localize feature (`src/localizeAttachments.ts`) rewrites note embeds to point at
managed copies it writes into a per-note template folder
(`localizeAttachmentsFolderTemplate`, default `{{folder}}/_attachments/{{slug}}`) using the
name template `{{md5}}_MD5.{{ext}}`. When a note's embed is later edited/removed, the note is
deleted while `localizeAttachmentsFollowNoteLifecycle` is off, or content is rearranged, the
managed file is left behind with **no back-reference from any note** — an orphan that silently
accumulates disk usage.

There is currently **no orphan/back-reference detection anywhere in the codebase** (no use of
`resolvedLinks` or `getBacklinksForFile`). This adds a new Ingestion Dashboard section that lists
orphaned localized attachments and lets the user trash them individually or all at once, mirroring
the existing dashboard sections.

### Decisions (confirmed with user)
- **Scan scope:** vault-wide, restricted to files matching the localizer's name convention
  (`*_MD5.ext`). Only ever touches files Localize created — safe and folder-template-agnostic.
- **File filter:** only Localize media types (images / audio / video / pdf, per
  `OBSIDIAN_NATIVE_EMBED_FORMATS`).
- **Cleanup all:** show a confirmation modal (count + total size) before trashing. Per-item delete
  acts immediately.
- **Delete API:** `app.fileManager.trashFile()` — consistent with existing deletions in
  `localizeAttachments.ts:379` and `main.ts:1134` (respects the vault's trash setting).

## Approach

A new section `'orphanedAttachments'` added to `IngestionDashboardUI` in
`src/ingestionDashboard.ts`, reusing the existing `buildSection` / `renderSortableTable` /
`renderFileLink` infrastructure. Orphan detection is a new pure helper built on the public
`app.metadataCache.resolvedLinks` index.

### Orphan detection (new logic)

Add a private method `computeOrphanedAttachmentRows(): OrphanRow[]`:

1. Build the **referenced set**: iterate `this.app.metadataCache.resolvedLinks` (shape
   `Record<sourcePath, Record<targetPath, count>>`) and collect every target path into a
   `Set<string>`. `resolvedLinks` already includes embeds (`![[...]]` / `![](...)`), which is how
   Localize links its files.
2. Build the **candidate set**: `this.app.vault.getFiles()` filtered by
   `MD5_NAME_RE.test(file.name)` **and** `classifyLocalizeMediaType(file.extension) !== null`.
3. A candidate is **orphaned** when its `path` is not in the referenced set.
4. Map to `OrphanRow { file: TFile; folder: string; type: LocalizeMediaType; size: number; mtime: number }`.

```ts
interface OrphanRow {
  file: TFile;
  folder: string;            // file.parent?.path ?? ''
  type: LocalizeMediaType;
  size: number;              // file.stat.size
  mtime: number;             // file.stat.mtime
}
```

### Reused / exported pieces
- **`MD5_NAME_RE`** (`src/localizeAttachments.ts:12`) — currently module-private. Export it
  (`export const MD5_NAME_RE = ...`) and import into the dashboard. Reuses the exact convention the
  localizer writes/checks, so the two never drift.
- **`OBSIDIAN_NATIVE_EMBED_FORMATS`** + **`LocalizeMediaType`** (`src/types.ts:16,19`) — used to
  classify candidates. Add a small standalone helper `classifyLocalizeMediaType(ext: string)` in
  `src/utils.ts` (mirrors the instance method `AttachmentLocalizer.classifyExtension` at
  `localizeAttachments.ts:143` but without needing an instance), and optionally refactor that
  method to delegate to it.

### Section rendering (mirrors existing sections)

In `src/ingestionDashboard.ts`:
1. Add `'orphanedAttachments'` to the `SectionId` union (line 27-35).
2. In `mount()` (after the other `buildSection` calls, ~line 116) add:
   ```ts
   this.buildSection(
     'orphanedAttachments',
     'Orphaned attachments',
     'Localized attachments (…_MD5.ext) with no back-reference from any note.',
     (heading) => this.renderCleanupAllButton(heading),
   );
   ```
3. Add `'orphanedAttachments'` to the `refreshAll()` id list (line 409-418).
4. Add a dispatch case in `renderSection()` (line 428-439):
   `case 'orphanedAttachments': return this.renderOrphanedAttachments(body, ctx);`
5. Implement `renderOrphanedAttachments(body, ctx)`: compute rows, cache them in a new instance
   field `private orphanedAttachmentsCache: OrphanRow[] = []` (so Cleanup-all can read the current
   set, same pattern as `uncapturedVideosCache`), render empty-state or a sortable table:

   | Column | Sort | Render |
   |--------|------|--------|
   | Name | by basename | `renderFileLink(td, r.file)` (opens the file) |
   | Folder | by folder | `td.setText(r.folder)` |
   | Type | by type | `td.setText(r.type)` |
   | Size (KB) | by size | `td.setText((r.size/1024).toFixed(1))` |
   | Modified | by mtime | `td.setText(formatDateTime(r.mtime))` (existing helper) |
   | (action) | — | `renderDeleteButton(td, r, ctx)` |

   Default sort: `{ column: 'size', direction: 'desc' }` (largest reclaim first).

### Buttons

- **Per-item delete** — `renderDeleteButton(td, row, ctx)`: a `mod-warning` button "Delete"
  (Obsidian's built-in destructive style, no new CSS). On click: `await trashFile(row.file)`,
  `new Notice(...)`, then `void ctx.refresh()`.
- **Cleanup all** — `renderCleanupAllButton(heading)`: button in the section header (via the
  `decorateHeader` callback, same mechanism as `renderEnqueueIntakeButton`,
  `ingestionDashboard.ts:322`). On click, open a confirmation modal showing the orphan **count and
  total size** from `orphanedAttachmentsCache`; on confirm, trash each file (collect failures into
  a Notice), then refresh the section.
- **Confirm modal** — add a minimal `ConfirmModal extends Modal` (the repo already uses
  `obsidian.Modal` in `src/orchestration/FilePickerModal.ts`, `chains.ts`, etc.). Keep it local to
  `ingestionDashboard.ts` (or a small `src/confirmModal.ts`) with title, message, Cancel /
  destructive Confirm buttons.

### Event wiring (auto-refresh)

In `registerListeners()` (line 140-191) add a debounced refresher and route to it:
```ts
const debouncedOrphans = debounce(() => void this.refresh('orphanedAttachments'), DEBOUNCE_MS, true);
```
Trigger it from the `route()` callback whenever references could change — call `debouncedOrphans()`
on `metadataCache 'changed'` (an edit may have removed the last embed) and on vault
`create`/`delete`/`rename` of any `*_MD5.*` file. Simplest correct approach: call
`debouncedOrphans()` unconditionally inside `route()` alongside the existing unconditional
uncaptured refreshers (line 169-171), since it's already debounced.

## Edge cases & limitations (document in AGENTS.md `## Quirks`)
- **Naming-convention dependent:** detection keys off `MD5_NAME_RE` (the default name template's
  `_MD5` suffix). If a user sets `localizeAttachmentsNameTemplate` to something without `_MD5`,
  their localized files won't be detected as candidates. Note this in the section description and
  AGENTS.md.
- **Frontmatter property links** (e.g. a `cover:` image referenced only from YAML) are tracked in
  `metadataCache` `frontmatterLinks`, which may not appear in `resolvedLinks`. A file referenced
  only via a frontmatter property could be falsely flagged. Acceptable for v1; if it bites,
  augment the referenced set by also scanning `getFileCache(f).frontmatterLinks`. Note this caveat.
- Empty `_attachments/<slug>/` folders left after trashing are **not** auto-removed in v1 (keeps
  the change scoped and avoids touching folders that may hold unmanaged files).

## Files to modify
- `src/ingestionDashboard.ts` — new section, `OrphanRow`, `computeOrphanedAttachmentRows`,
  `renderOrphanedAttachments`, `renderDeleteButton`, `renderCleanupAllButton`, cache field,
  `SectionId` + dispatch + listener wiring. (primary)
- `src/localizeAttachments.ts` — `export` `MD5_NAME_RE`.
- `src/utils.ts` — add `classifyLocalizeMediaType(ext)` helper.
- `src/confirmModal.ts` *(optional new file)* — `ConfirmModal`, or inline it in the dashboard.
- `AGENTS.md` — add the two quirks above to the `## Quirks` section.
- `styles.css` — only if a destructive-button or header-button style is needed; prefer the
  built-in `mod-warning` class and existing `.crucible-ingestion-*` styles (no new CSS expected).

## Verification
1. **Build/typecheck:** run the project's build (e.g. `npm run build` / `tsc`) — must pass with no
   type errors.
2. **Manual in Obsidian (use the `/run` or `/verify` skill to launch):**
   - Create a note, embed a local image, run Localize so a `…_MD5.png` file is written and the
     embed is rewritten. Confirm the file does **not** appear in the new section (it's referenced).
   - Remove the embed from the note (or delete the note with lifecycle-follow off). The
     `…_MD5.png` file should now appear in **Orphaned attachments** within ~150ms (debounced).
   - Click per-item **Delete** → file is trashed (to the vault's configured trash), Notice shown,
     row disappears.
   - Re-create another orphan, click **Cleanup all** → confirm modal shows correct count/size →
     confirm → files trashed, section empties.
   - Sort by each column; verify the Name link opens the file.
3. **Negative check:** a non-`_MD5` image and a `.md` note are never listed.

## Notes
- Per project convention this plan lives in the repo `plans/` directory.
- After implementation, add the quirks to `AGENTS.md` `## Quirks` (see memory).
