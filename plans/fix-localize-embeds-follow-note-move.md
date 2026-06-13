# Fix Localize: embeds not following the note when it moves folders

## Context

When a localized clipping is moved from `Clippings/` to a `daily/...` folder, its attachment
folder physically moves to the new location but the note's embeds keep pointing at the old
`_resources/Clippings/...` path. The embeds break and the moved `…_MD5.*` files become
orphans. This has been silently accumulating across multiple clip-then-move operations
(orphans dating 2026-06-09 → 2026-06-13; the dashboard's `resolvedLinks`-based count is 8).

**Confirmed root cause.** `AttachmentLocalizer.onNoteRename` (`src/localizeAttachments.ts:687`)
runs inside the note's own vault `rename` event handler (`src/main.ts:174`) and immediately
calls `fileManager.renameFile(attachmentFolder, newFolder)`. Obsidian *would* normally rewrite
links when a folder is renamed, but at that instant the metadata cache has not yet reindexed
the just-moved note, so Obsidian can't see the note as a referrer of those attachments and
silently skips it. Net effect for the Elon note: folder correctly relocated to
`_resources/daily/day/2026-06-13/elon-musk…/` (3 webp files present), but the note's three
`![](_resources/Clippings/elon-musk…/…_MD5.webp)` embeds were never updated → broken + orphaned.

Verified directly on disk: old `_resources/Clippings/elon-musk…` folder is gone, new
`_resources/daily/day/2026-06-13/elon-musk…` exists with the files, note still links to the old path.

The template in use is `_resources/{{folder}}/{{slug}}` (not the default `{{folder}}/_attachments/{{slug}}`),
but that is irrelevant to the bug — the failure is cache-timing in the link rewrite.

## Goals

1. **Forward fix** — moving a localized note must keep its embeds pointing at the relocated
   attachment folder, independent of metadata-cache timing.
2. **Reusable repair command** — repoint/re-localize broken attachment embeds on demand, to
   recover the existing 06-09→06-13 damage and any future breakage (bad edits, attachments
   deleted outside Obsidian).

## Part 1 — Forward fix in `onNoteRename`

File: `src/localizeAttachments.ts`, `onNoteRename` (lines 687-701).

After the folder rename succeeds, deterministically rewrite the note body's embeds by swapping
the old attachment-folder path prefix for the new one — no reliance on Obsidian's cache-driven
rewrite.

- Add a small **pure, exported helper** (keeps it unit-testable via the existing esbuild test harness):
  ```ts
  export function repointAttachmentFolderPrefix(content: string, oldFolder: string, newFolder: string): string
  ```
  It replaces, inside markdown/wiki embed refs, any occurrence of `oldFolder/` with `newFolder/`,
  handling both raw and `%20`-encoded space forms of the prefix (folder paths can contain spaces).
  Idempotent: if a ref was already updated, the old prefix isn't present and it's a no-op.
- In `onNoteRename`, after `await this.app.fileManager.renameFile(existing, newFolder)`:
  read the note, apply `repointAttachmentFolderPrefix(content, oldFolder, newFolder)`, and write
  back only if changed. Wrap the read/modify in `withMaterializing(this.setMaterializing, …)` and
  `withOptionalNoteLock(this.noteLocks, file.path, 'localize', …)` (already imported, see
  `localizeNote`) so the write does not retrigger the debounced lint/localize on `modify`
  (`src/main.ts:161-166`). The subsequent localize, if it runs, is idempotent (the files are
  already `_MD5`-named in the expected folder, see the skip at `localizeAttachments.ts:448`).

This is the inverse-safe complement to Obsidian's own rewrite: if Obsidian did update some refs,
ours no-ops them; if it missed them (the bug), ours fixes them.

## Part 2 — Reusable "Repair attachment links" command

Goal: given a note with broken embeds, make each embed resolve again, preferring the
already-downloaded file (no needless re-download) and falling back to re-localizing from a
remote URL when that's all that's available.

New methods on `AttachmentLocalizer` (`src/localizeAttachments.ts`), reusing existing building blocks:

- `repairNote(file: TFile, silent?: boolean): Promise<boolean>`
  - Reuse `parseAttachmentRefs(content, file)` to enumerate embeds.
  - For each match, resolve via `this.app.metadataCache.getFirstLinkpathDest(match.link, file.path)`.
    If it resolves → skip.
  - If unresolved and `match.isRemote` → reuse `processRemote(match, file)` (re-download + localize).
  - If unresolved and local → recover the moved file:
    1. Compute the note's expected attachment folder via `attachmentFolderForNote(file)` and look
       for `<expectedFolder>/<basename-of-broken-link>` (exact inverse of the move bug). If present →
       repoint with `formatEmbed(match.syntax, thatPath)`.
    2. Else search the vault for a unique file whose name equals the broken link's basename (the
       `<contenthash>_MD5.ext` name is content-derived; disambiguate by preferring the expected
       folder). If found → repoint.
    3. Else → unrepairable; count and report in the final Notice/debug log.
  - Collect `AttachmentReplacement[]` and apply with the existing `rewriteLocalizedAttachmentRefs`
    (`localizeAttachments.ts:42`); write with `vault.modify` under `withMaterializing` + note lock,
    mirroring `localizeNote` (lines 296-303).
- `repairVault(): Promise<boolean>` — walk markdown files like `localizeFolder` (lines 323-353) and
  call `repairNote(file, true)` for each, with a summary Notice.
- Factor the local-target decision into a **pure, exported helper** for testing, e.g.
  `planLocalAttachmentRepair(brokenLink: string, expectedFolder: string, vaultPaths: string[]): string | null`.

Wire the commands to mirror the existing localize commands:
- `src/main.ts` (~line 645): `register('lint-repair-attachments', …)` calling `repairNote(activeFile)`,
  and `register('lint-repair-attachments-vault', …)` calling `repairVault()`.
- `src/commands.ts` (~line 87): two `registerCrucibleCommand` entries, group `'Lint'`, names
  e.g. `Lint: repair attachment links` and `Lint: repair attachment links (vault)`.

## Recovering the current damage (06-09 → 06-13)

After Part 2 ships, run **Lint: repair attachment links (vault)** once. For the existing orphans the
local files still exist at their moved `daily/...` paths, so repair repoints the broken embeds to
them (no re-download), which removes them from the orphan list. Any genuinely unreferenced
leftovers can still be cleared with the existing orphan-cleanup button in the ingestion dashboard
(`src/ingestionDashboard.ts:916`). Verify the orphan count drops to ~0 afterward.

## Quirks to document

Per AGENTS.md `## Quirks`: note that `fileManager.renameFile` on a folder does **not** reliably
rewrite links from a note that was renamed in the same tick — the metadata cache lags — so the
attachment-folder move must rewrite the moving note's embeds itself.

## Files to modify

- `src/localizeAttachments.ts` — `onNoteRename` fix; new `repointAttachmentFolderPrefix`,
  `repairNote`, `repairVault`, `planLocalAttachmentRepair`.
- `src/main.ts` — register the two repair internal commands near line 645.
- `src/commands.ts` — two palette command definitions near line 87.
- `tests/localizeAttachments.edge.test.mjs` (or a sibling) — unit tests for the new pure helpers.
- `AGENTS.md` — `## Quirks` entry.

## Verification

1. `npm test` — add/extend cases:
   - `repointAttachmentFolderPrefix`: rewrites a `_resources/Clippings/<slug>/…_MD5.webp` md embed to
     the `_resources/daily/day/2026-06-13/<slug>/…` prefix; handles `%20`; idempotent on already-new refs;
     leaves unrelated text untouched.
   - `planLocalAttachmentRepair`: picks the expected-folder candidate; returns null when absent;
     disambiguates duplicates by expected folder.
2. Build the plugin and reload in the vault. Reproduce: localize a clipping in `Clippings/`, then run
   the move-to-daily command. Confirm the note's embeds now point at `_resources/daily/day/<date>/<slug>/…`
   and render, and no new orphans appear in the ingestion dashboard.
3. Run **Lint: repair attachment links (vault)** and confirm the orphaned-attachments dashboard count
   drops to ~0 and the previously-broken 06-09→06-13 notes render their images.
