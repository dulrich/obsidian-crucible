# Plan: Add `Crucible: Lint: Remove property from vault` command

## Context

The plugin already has `Crucible: Lint: update property in vault` for renaming/migrating frontmatter keys across the vault (used for the legacy `video_ids`/`post_ids` → kebab-case migration documented in AGENTS.md). There is no symmetric command for *removing* a property entirely. When a property has been deprecated and there is no replacement key — e.g. an obsolete tracker field, a stray typo'd key that propagated to many notes, or any one-off cleanup — users currently have to write a script or edit notes by hand. This command fills that gap and mirrors the existing rename command in UX and implementation, so it appears under the same Lint group with the same prompt-and-run flow.

## Approach

Add a new `lint-remove-property` command that prompts once for a property name, then iterates every Markdown file (respecting `lintIgnoredFolders`) and deletes that frontmatter key via `processFrontMatter`. The implementation is a near-clone of `renamePropertyInVault` in `src/lint.ts`, simplified to a single key.

Per user decision: no extra confirmation step (match update-property flow); count any note where the key existed regardless of value (use `key in fm`).

## Critical files

### 1. `src/lint.ts` — add `removePropertyFromVault`

Insert a new method directly after `renamePropertyInVault` (around line 312). Mirror its structure exactly:

- Validate input: trim, return early with `Notice` if empty.
- `files = this.app.vault.getMarkdownFiles().filter(f => !this.isPathIgnored(f.path))`.
- Open a long-lived progress `Notice`; wrap iteration in `withMaterializing(this.setMaterializing, ...)`.
- For each file, call `updateFrontmatter(this.app, file, (fm) => { if (!(key in fm)) return; delete fm[key]; didRemove = true; })`.
- Track `scanned` / `removed` / `failed`; update notice every 25 files.
- Final `Notice` summary; return `failed === 0`.

Reuse `updateFrontmatter` from `src/frontmatter.ts` and `isPathIgnored` / `withMaterializing` already used by the rename method.

### 2. `src/main.ts` — register palette command + internal handler

**Palette command** (insert after the `lint-rename-property` block at line 166–180):

```typescript
this.registerCrucibleCommand({
  id: 'lint-remove-property',
  name: 'Lint: remove property from vault',
  group: 'Lint',
  run: async () => {
    const key = await this.promptForText('Property name to remove');
    if (key === null || key.trim() === '') return;
    await this.chainManager.executeInternalCommand(`${prefix}:lint-remove-property`, {
      key: key.trim(),
    });
  },
});
```

**Internal handler** (insert after the `lint-rename-property` register at line 753–756):

```typescript
register('lint-remove-property', async (args) => await this.linter.removePropertyFromVault(
  typeof args['key'] === 'string' ? args['key'] : '',
));
```

No changes needed to the `CrucibleCommandGroup` union — `'Lint'` already exists.

## Reused utilities (do not reimplement)

- `Linter.isPathIgnored(path)` — `src/lint.ts:102`
- `updateFrontmatter(app, file, mutator)` — `src/frontmatter.ts:14`
- `withMaterializing(setter, fn)` — recursion guard already used by rename
- `promptForText(label)` — `src/main.ts:689`
- `registerCrucibleCommand({ ..., group: 'Lint' })` — required per AGENTS.md `Quirks` so the command appears in the visibility settings

## Verification

1. `npm run dev` in a separate terminal (user-initiated per AGENTS.md).
2. Reload plugin in Obsidian.
3. In the command palette, run **Crucible: Lint: remove property from vault**.
4. Test cases:
   - Enter a key present on multiple notes → notice reports `Removed N of M notes`; spot-check 2–3 notes to confirm the key is gone and other frontmatter is intact.
   - Enter a key that does not exist → reports `Removed 0 of M notes`, no errors.
   - Cancel the prompt (Esc / empty input) → command exits silently, no file writes.
   - Place a note inside a folder listed in `lintIgnoredFolders` with the target key → confirm the key remains after running.
   - Confirm the command appears in **Settings → Commands → Lint** and can be toggled off.
5. Full Cleanup Loop (AGENTS.md): `npm run lint`, `npx tsc -noEmit -skipLibCheck`, `node esbuild.config.mjs production`. All must exit 0.
