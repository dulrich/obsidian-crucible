# Crucible:Lint:Localize attachments

## Context

Obsidian users today rely on the **Local Images Plus** community plugin to (a) download remote images referenced in markdown into the vault, (b) move pasted/dropped attachments into a per-note folder, (c) optionally convert to JPEG/WebP, and (d) hash-rename for de-duplication. We want to subsume that functionality into Crucible as a first-class Lint command — `Crucible:Lint:Localize attachments` — that runs on the active note, on the vault, or automatically on configurable triggers (create / edit / paste). Folding it into Crucible keeps users on a single, audited plugin and lets us reuse the existing template engine, excluded-folder logic, and Lint settings architecture.

This command is **standalone** — it is intentionally NOT part of `Lint: all` (`lint-note`) because it touches binary files and the network, and a user running "lint this note" rarely expects those side effects. It still **respects `lintIgnoredFolders`** so excluded folders are never touched.

## Scope summary

- New command: `lint-localize-attachments` (group `Lint`, name `Lint: localize attachments`).
- Operates on the active note when invoked from the palette; a sibling vault-wide command and a folder-menu entry mirror the existing `Lint vault` / `Lint notes in folder` UX.
- Automatic triggers (toggleable, independent): `create`, `edit`, `paste`.
- **Four media types** — images, audio, video, pdf — each with independent toggles for "process when pasted" and "process when attached/remote" and a per-type extension whitelist drawn from `OBSIDIAN_NATIVE_EMBED_FORMATS`.
- **Conversion applies only to images.** Two independent conversion toggles (attached vs. pasted), each with a **single-select** target format (jpeg | webp) and quality (30–100). Audio/video/pdf are localized (downloaded/moved/renamed) but never re-encoded.
- **Remote URL download enabled.** Embeds like `![](https://...)` are fetched into the attachment folder via `requestUrl`, then rewritten as local embeds.
- **Excluded folders reuses `lintIgnoredFolders`** — no new setting; call `plugin.linter.isPathIgnored()`.
- Per-note attachment folder via template variables.
- Hash-based naming by default; template variable to preserve original names.
- Folder lifecycle: rename/move/delete the per-note attachment folder when the note is renamed/moved/deleted.

## Files to create / modify

### `src/lint/localizeAttachments.ts` (NEW)
Core engine. Exports `class AttachmentLocalizer` with:
- `localizeNote(file: TFile, opts?: { silent?: boolean }): Promise<boolean>` — scan one note's embeds and markdown image/media links, download remote ones, move/rename/convert local ones, rewrite the note body.
- `localizeVault(): Promise<boolean>` — iterate non-ignored markdown files.
- `localizeFolder(folder: TFolder): Promise<boolean>` — folder-menu entry.
- `handlePaste(evt: ClipboardEvent, editor: Editor, view: MarkdownView)` — extract pasted media, localize, insert embed at cursor.
- Internal helpers:
  - `OBSIDIAN_NATIVE_EMBED_FORMATS` constant exported from this file (the user-provided map).
  - `classifyExtension(ext): 'images' | 'audio' | 'video' | 'pdf' | null` — used by every code path to determine which per-type toggle gates this file.
  - `isEnabledForAttached(ext)` / `isEnabledForPasted(ext)` — gate functions that AND the per-type toggle with the per-type whitelist.
  - `parseEmbeds(content, file)` — extract `![[wiki]]` and `![alt](path)` for all supported media types. Use `app.metadataCache.getFileCache(file).embeds` as primary source, fall back to regex for markdown links to remote URLs (which `metadataCache.embeds` does not surface as resolved links).
  - `downloadRemote(url): Promise<{bytes: ArrayBuffer; ext: string}>` — `requestUrl({ url, method: 'GET' })`, sniff content-type and URL extension.
  - `convertImage(bytes, srcExt, targetFormat, quality): Promise<{bytes, ext}>` — Electron Canvas API: `Blob` → `Image` → `<canvas>` → `canvas.toBlob('image/webp', q/100)` (or `image/jpeg`). Single target format (not multiselect). Falls back to source bytes if the converted output is larger.
  - `nameAttachment(template, srcBytes, srcName, ext, note): string` — `md5(srcBytes)` via Node `crypto`, expand template tokens.
  - `resolveAttachmentFolder(note: TFile): string` — expand folder template.
  - `rewriteEmbedInBody(content, oldRef, newRef): string` — preserve embed syntax style (`![[...]]` vs `![](...)`).
- Respects `plugin.linter.isPathIgnored(file.path)` (reused — do not duplicate).
- Wraps mutations in `withMaterializing(setMaterializing, ...)` to prevent re-entrant lint loops.
- Tracks already-localized files by the `_MD5` suffix marker in the filename so re-runs are idempotent.

### `src/main.ts` (MODIFY)
1. Instantiate `AttachmentLocalizer` in `onload()` (next to `this.linter = new Linter(...)`).
2. Register two palette commands via `registerCrucibleCommand` (group `'Lint'`):
   - `lint-localize-attachments` → `Lint: localize attachments` (active note)
   - `lint-localize-attachments-vault` → `Lint: localize attachments (vault)`
3. Register matching internal handlers in `registerInternalCommands()` (around `src/main.ts:651`).
4. Add the folder-menu entry "Localize attachments in folder" next to the existing one at `src/main.ts:271-284`.
5. Wire automatic triggers behind setting toggles:
   - `create` — extend `handleFileCreate` to call the localizer when the new file is markdown.
   - `edit` — add a second debounced handler in the `vault.on('modify')` block (around `src/main.ts:267`); share the existing `isMaterializing` guard.
   - `paste` — `this.registerEvent(this.app.workspace.on('editor-paste', handler))` and `editor-drop`. Inspect `ClipboardEvent.clipboardData` for image MIME types, write the binary, run conversion, insert the embed.
6. Folder lifecycle hooks:
   - `this.registerEvent(this.app.vault.on('rename', ...))` — if a markdown file moved/renamed, rename the matching attachment folder if it exists.
   - `this.registerEvent(this.app.vault.on('delete', ...))` — delete the matching attachment folder.

### `src/types.ts` (MODIFY)
Add a media-type union plus the settings. Flat naming, mirroring the existing `lint*` prefix convention from `src/types.ts:223-230`:

```ts
export type LocalizeMediaType = 'images' | 'audio' | 'video' | 'pdf';
export type ImageConvertFormat = 'jpeg' | 'webp';

// Lint: Localize Attachments
localizeAttachmentsTriggerOnCreate: boolean;
localizeAttachmentsTriggerOnEdit: boolean;
localizeAttachmentsTriggerOnPaste: boolean;

// Per-media-type processing toggles + whitelists
localizeAttachmentsImagesProcessAttached: boolean;
localizeAttachmentsImagesProcessPasted: boolean;
localizeAttachmentsImagesWhitelist: string[];

localizeAttachmentsAudioProcessAttached: boolean;
localizeAttachmentsAudioProcessPasted: boolean;
localizeAttachmentsAudioWhitelist: string[];

localizeAttachmentsVideoProcessAttached: boolean;
localizeAttachmentsVideoProcessPasted: boolean;
localizeAttachmentsVideoWhitelist: string[];

localizeAttachmentsPdfProcessAttached: boolean;
localizeAttachmentsPdfProcessPasted: boolean;
localizeAttachmentsPdfWhitelist: string[];

// Image-only conversion (other types are localized but never re-encoded)
localizeAttachmentsConvertAttachedImages: boolean;
localizeAttachmentsAttachedImageFormat: ImageConvertFormat;
localizeAttachmentsAttachedImageQuality: number; // 30-100

localizeAttachmentsConvertPastedImages: boolean;
localizeAttachmentsPastedImageFormat: ImageConvertFormat;
localizeAttachmentsPastedImageQuality: number; // 30-100

// Folder + naming
localizeAttachmentsFolderTemplate: string;
localizeAttachmentsNameTemplate: string;
localizeAttachmentsFollowNoteLifecycle: boolean;
```

Defaults (mirror Obsidian's native embed support; all media types default off so the feature is opt-in):
```ts
localizeAttachmentsTriggerOnCreate: false,
localizeAttachmentsTriggerOnEdit: false,
localizeAttachmentsTriggerOnPaste: false,
localizeAttachmentsImagesProcessAttached: true,
localizeAttachmentsImagesProcessPasted: true,
localizeAttachmentsImagesWhitelist: ['avif','bmp','gif','jpeg','jpg','png','svg','webp'],
localizeAttachmentsAudioProcessAttached: false,
localizeAttachmentsAudioProcessPasted: false,
localizeAttachmentsAudioWhitelist: ['flac','m4a','mp3','ogg','wav','webm','3gp'],
localizeAttachmentsVideoProcessAttached: false,
localizeAttachmentsVideoProcessPasted: false,
localizeAttachmentsVideoWhitelist: ['mkv','mov','mp4','ogv','webm'],
localizeAttachmentsPdfProcessAttached: false,
localizeAttachmentsPdfProcessPasted: false,
localizeAttachmentsPdfWhitelist: ['pdf'],
localizeAttachmentsConvertAttachedImages: false,
localizeAttachmentsAttachedImageFormat: 'webp',
localizeAttachmentsAttachedImageQuality: 85,
localizeAttachmentsConvertPastedImages: true,
localizeAttachmentsPastedImageFormat: 'webp',
localizeAttachmentsPastedImageQuality: 80,
localizeAttachmentsFolderTemplate: '{{folder}}/_attachments/{{slug}}',
localizeAttachmentsNameTemplate: '{{md5}}_MD5.{{ext}}',
localizeAttachmentsFollowNoteLifecycle: true,
```

Note: `audio/webm` and `video/webm` overlap on the `webm` extension — when classifying, we sniff via MIME for pasted/remote data first and only fall back to extension for local files. Classification on extension alone picks `video` for `webm` by convention.

### `src/utils.ts` (MODIFY)
Extend `applyTemplateString` (or add a sibling `applyAttachmentTemplate`) to support new tokens:
- `{{folder}}` — note's parent folder path
- `{{slug}}` — lowercase-sluggified note basename (`foo-bar` from `Foo Bar`)
- `{{name}}` — note basename (alias of existing `{{title}}` for spec clarity)
- `{{ext}}` — file extension (no dot)
- `{{md5}}` — MD5 hex of file bytes (only for naming template, never folder template)
- `{{original}}` — original filename without extension

Existing `{{title}}`, `{{date}}`, `{{now}}`, `{{datetime:FMT}}` continue to work. Document additions in `AGENTS.md` § Template Engine.

### `src/settings.ts` (MODIFY)
Add a new section inside `renderLintSettings` (after Excluded folders, around `src/settings.ts:2282`):

```
[Heading] Localize attachments
[Group .crucible-settings-group] Automatic triggers
  Toggle: Trigger on create
  Toggle: Trigger on edit
  Toggle: Trigger on paste

[Heading] Media types
For each of {images, audio, video, pdf}:
  [Sub-heading: Images / Audio / Video / PDFs]
  [Group .crucible-settings-group]
    Toggle: Handle when attached/remote
    Toggle: Handle when pasted
    Multiselect (checkbox grid): Allowed extensions
      — options come from OBSIDIAN_NATIVE_EMBED_FORMATS[type]

[Heading] Image conversion
[Group .crucible-settings-group]
  Toggle: Convert attached images
    (if on) Dropdown: target format (jpeg | webp)
    (if on) Number (30-100): quality
  --hr--
  Toggle: Convert pasted images
    (if on) Dropdown: target format (jpeg | webp)
    (if on) Number (30-100): quality

[Heading] Storage
[Group .crucible-settings-group]
  Text: Attachment folder template (supports {{folder}}, {{slug}}, {{name}}, ...)
  Text: Attachment name template (supports {{md5}}, {{ext}}, {{original}}, ...)
  Toggle: Follow note lifecycle (rename/move/delete folder)

[Buttons]
  Localize attachments in this note
  Localize attachments in vault
```

UI patterns to reuse (verified from existing code):
- Toggle: `.addToggle(...)` (e.g., `src/settings.ts:2222`).
- Dropdown (single-select, now used for "convert to" since multiselect was dropped): `.addDropdown(...)` with `.addOptions({...})` (e.g., `src/settings.ts:2337`).
- Number with bounds: no existing helper. Use `.addText(...)` and set `text.inputEl.type = 'number'`, `min = '30'`, `max = '100'`, `step = '1'`. Validate in `onChange`: `Math.min(100, Math.max(30, parseInt(v) || 85))`.
- Multiselect (checkbox grid) for per-type extension whitelist: `setting.controlEl.createDiv({cls: 'crucible-checkbox-grid'})` with one `createEl('label')` per allowed extension, each containing a native `<input type="checkbox">` bound to the per-type array. Add a small CSS rule for `.crucible-checkbox-grid` (flex-wrap, gap) to `styles.css`.
- Conditional sub-settings: gate render with `if (settings.localizeAttachmentsConvertAttachedImages)` and call `this.display()` from the parent toggle's `onChange` (mirrors `showToC` pattern at `src/settings.ts:1605-1625`).
- Folder/path inputs: `FolderSuggest` from `src/suggesters.ts`.
- Cards/dividers per AGENTS.md: `.crucible-settings-group` wrapper, `<hr class="crucible-row-divider">` between rows.

### `AGENTS.md` (MODIFY)
- Add the new template tokens (`{{folder}}`, `{{slug}}`, `{{name}}`, `{{ext}}`, `{{md5}}`, `{{original}}`) to the **Template Engine** section.
- Add a **Quirks** entry:
  > **`Lint: localize attachments` is NOT part of `Lint: all`.** It's a standalone command that touches binary files and (when downloading remote URLs) the network. Adding it to `lintNote()` would surprise users. If you add a future "lint everything everywhere" command, it should opt-in to attachment localization, not the other way around.

### `manifest.json` / `package.json` (no changes expected)
Image conversion uses the Electron Canvas API (built-in). MD5 uses Node `crypto` (built-in to the Obsidian Electron runtime). No new dependencies.

## Reused utilities (do NOT duplicate)
- `ensureFolder(app, path)` — `src/utils.ts:5`
- `applyTemplateString(...)` — `src/utils.ts:19` (extend, don't fork)
- `normalizeFolderPath(...)` and the `moveFileToFolder` pattern — `src/main.ts:491-525`
- `Linter.isPathIgnored(path)` — `src/lint.ts:80` (call via `plugin.linter.isPathIgnored`)
- `withMaterializing(setMaterializing, fn)` — `src/frontmatter.ts`
- `FolderSuggest` — `src/suggesters.ts`
- `registerCrucibleCommand({id, name, group, run})` — `src/main.ts:304` (mandatory per AGENTS.md quirks)

## Verification

1. `npm run lint` → zero errors.
2. `npx tsc -noEmit -skipLibCheck` → zero errors.
3. `node esbuild.config.mjs production` → builds.
4. Manual smoke (in vault):
   - **Remote image download.** Create a note with `![](https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png)`; with images/attached on, run `Lint: localize attachments`. Expect: file downloaded into the templated folder, renamed `<md5>_MD5.png` (or `.webp` if convert-attached is on), embed rewritten to `![[<folder>/<hash>_MD5.webp]]`.
   - **Paste image.** Paste a screenshot into an editor with paste trigger on and convert-pasted on. Expect: image lands in attachment folder as `*_MD5.webp`, embed inserted at the cursor.
   - **Audio off by default.** Embed an MP3 with `![[song.mp3]]`; with audio/attached off, run the command. Expect: file untouched.
   - **Audio on.** Flip audio/attached on; re-run. Expect: file moved into the templated folder and renamed (no re-encoding).
   - **PDF whitelist.** Disable `pdf` in the per-type whitelist; embed a `.pdf` with pdf/attached on. Expect: file untouched (whitelist gates even when the type is enabled).
   - **Excluded folder.** Place a note in a `lintIgnoredFolders` path; run vault-wide localize. Expect: note is skipped (Notice count reflects this).
   - **Lint:all isolation.** Leave create/edit triggers off — confirm `Lint: all` does NOT call the localizer.
   - **Note rename.** Rename a note with `Follow note lifecycle` on. Expect: attachment folder is renamed alongside, embeds inside the note remain resolved.
   - **Idempotent re-run.** Run the command twice; second pass is a no-op (filenames already `*_MD5.*`, so dedup matches).
5. Confirm visibility toggles in `Crucible → Settings → Commands → Lint` list the new entries.
