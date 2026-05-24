# Crucible>Localize: persistent "working" status + race-condition fix

## Context

`AttachmentLocalizer.localizeNote()` reads a note's content once, then performs N
async `requestUrl` downloads (5–30s+ per remote attachment), then writes the
note back via `vault.modify()`. During that read→download→write window:

1. **No visible feedback** that work is in progress — the user has no UX cue
   to avoid kicking off other note-modifying commands. AI:Agents solved this
   visually with `new Notice(msg, 0)` + `spinner.hide()` (see
   `src/agents.ts:88-110`).
2. **Auto-Lint and auto-Localize can fire** off the debounced `vault.on('modify')`
   handler (`src/main.ts:317-337`). Those handlers gate on `!this.isMaterializing`,
   but `localizeNote()` only sets the materializing flag for the final write
   (`src/localizeAttachments.ts:217`), so auto-Lint is unblocked the whole time
   downloads run.
3. **Manual `Lint: all` (or any other write — paste, sync, manual edit) during
   the window** modifies the file's frontmatter / body via `processFrontMatter`
   or `vault.modify`. When `localizeNote()` then writes its updated string
   (built from the stale read at line 199), those concurrent edits are
   silently clobbered.

The intent: give Localize the same persistent status UX as AI:Agents, and close
the race window so Lint changes (and any other concurrent edits) survive.

## Approach

Three small, complementary changes to `localizeNote()`:

1. **Persistent Notice for UX visibility** — mirror the AI:Agents spinner
   pattern exactly. Create `new Notice('Localizing attachments...', 0)` before
   the download loop, update its message between attachments
   (`spinner.setMessage(...)`), and `spinner.hide()` in both the success and
   error paths.
2. **Extend `withMaterializing()` over the full operation** — wrap the entire
   read→download→write body (not just the final write) so debounced auto-Lint
   and auto-Localize won't fire during the download window. `withMaterializing`
   is a simple try/finally (`src/frontmatter.ts:5-12`), so nesting / extending
   it is safe.
3. **Re-read fresh content before writing** — after downloads complete, do a
   second `vault.read(file)` and apply the `(match.original → newRef)` string
   replacements to the **fresh** content rather than the stale `original`. The
   match keys are the literal embed strings (e.g.
   `![](https://example.com/img.png)`), which other writers (Lint, manual
   edits) are extremely unlikely to touch — so the string replacements remain
   valid against fresh content, and any concurrent edits to other parts of
   the note are preserved.

## Files to modify

- `src/localizeAttachments.ts` — rework `localizeNote(file, silent)` per below.
  No other call sites need to change; `localizeFolder` already wraps a
  persistent notice of its own at line 253 and calls `localizeNote(file, true)`,
  so the inner spinner must be **suppressed when `silent` is true** to avoid
  duplicate notices stacking during bulk runs.

No changes required to: `src/lint.ts`, `src/main.ts`, `src/agents.ts`,
`src/frontmatter.ts`.

## Implementation sketch (localizeNote)

Replace the body of `localizeNote()` (currently `src/localizeAttachments.ts:194-228`)
with this shape:

```ts
async localizeNote(file: TFile, silent: boolean = false): Promise<boolean> {
  if (this.linter.isPathIgnored(file.path)) return true;
  if (file.extension !== 'md') return true;

  const spinner = silent ? null : new Notice(`Localizing attachments in "${file.basename}"...`, 0);

  try {
    return await withMaterializing(this.setMaterializing, async () => {
      const original = await this.app.vault.read(file);
      const matches = this.parseAttachmentRefs(original, file);
      if (matches.length === 0) {
        spinner?.hide();
        if (!silent) new Notice('No attachments to localize');
        return true;
      }

      const replacements: Array<{ from: string; to: string }> = [];
      let i = 0;
      for (const match of matches) {
        spinner?.setMessage(`Localizing attachment ${++i}/${matches.length} in "${file.basename}"...`);
        const newRef = await this.processMatch(match, file);
        if (newRef && newRef !== match.original) {
          replacements.push({ from: match.original, to: newRef });
        }
      }

      if (replacements.length > 0) {
        // Re-read so concurrent edits (manual Lint:all, sync, typing) survive.
        const fresh = await this.app.vault.read(file);
        let updated = fresh;
        for (const r of replacements) updated = updated.split(r.from).join(r.to);
        if (updated !== fresh) {
          await this.app.vault.modify(file, updated);
        }
      }

      spinner?.hide();
      if (!silent) new Notice(`Localized ${replacements.length} of ${matches.length} attachments`);
      return true;
    });
  } catch (e) {
    spinner?.hide();
    console.error(`Localize attachments failed (${file.path}):`, e);
    if (!silent) new Notice(`Localize failed: ${(e as Error).message}`);
    return false;
  }
}
```

Notes on the shape:
- `withMaterializing` now wraps the whole op (read + downloads + write), not
  just the write. Debounced auto-Lint / auto-Localize stay gated for the full
  duration.
- `silent` mode (used by `localizeFolder`) suppresses the per-file spinner so
  the bulk notice at line 253 remains the single source of truth.
- `spinner.setMessage` mirrors how `localizeFolder` updates its own notice at
  line 260 — consistent style with the existing codebase.
- Re-read pattern: replacements list is built from the first read, then
  applied to a fresh read. Safe because `match.original` is a literal embed
  string Lint won't touch. If a remote attachment was somehow removed from the
  note during the window, `split().join()` becomes a no-op for that
  replacement — correct behavior.

## Quirks / followups

- Per `AGENTS.md ## Quirks` convention (auto-memory `feedback_quirks_section`):
  add a short bullet to `AGENTS.md` noting that `localizeNote()` re-reads
  before writing to survive concurrent edits, and that `withMaterializing()`
  spans the whole async op (not just the write) so auto-Lint/auto-Localize
  stay gated during downloads. This is non-obvious from reading the code.
- The race is still theoretically possible for non-Crucible writers (e.g. a
  third-party plugin) that modify `match.original` strings mid-flight. That's
  out of scope — flag only if it appears in practice.

## Verification

1. **Build / typecheck.** `npm run build` (or whichever script the project
   uses — check `package.json` before running) must succeed with no new TS
   errors.
2. **Manual: visible spinner.** Open a note with one or more remote-image
   embeds. Run `Lint: localize attachments`. Confirm a persistent notice
   appears immediately and updates as each attachment is processed, then
   disappears on completion.
3. **Manual: race with Lint:all.** Open a note with a slow / large remote
   image embed. Run `Lint: localize attachments`. While the spinner is still
   visible, run `Lint: all`. After both finish, confirm the note contains:
   - localized attachment links (Localize's work survived), AND
   - updated `modified-date` / `word-count` frontmatter from Lint
     (Lint's work survived).
4. **Manual: bulk run no duplicate notices.** Run `Lint: localize attachments
   in vault` (or folder equivalent). Confirm only the outer `Localizing
   attachments in N notes...` notice appears — no per-file spinners stack
   underneath.
5. **Manual: auto-Lint suppressed during download.** With `lintOnSave`
   enabled, edit a note that has a remote embed (this triggers debounced
   auto-Lint at 2s and auto-Localize at 3s). Confirm that during the Localize
   download window, no second Lint run kicks off mid-download (look for
   `modified-date` only updating once, not twice).
6. **Copy plan to repo.** Per project convention
   (auto-memory `feedback_plan_files`), copy this plan to
   `/home/_shared_code/obsidian-crucible/plans/` before starting
   implementation.
