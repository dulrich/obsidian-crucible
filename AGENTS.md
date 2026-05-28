# Crucible Plugin (Development Guide)

## Project overview

- **Target:** Obsidian Community Plugin (TypeScript → bundled JavaScript).
- **Consolidation:** Replaces features from Daily Notes, Templater, Shell Commands, Linter, and QuickAdd.
- **Entry point:** `src/main.ts` compiled to `main.js` and loaded by Obsidian.
- **Artifacts:** `main.js`, `manifest.json`, and `styles.css`.

## Environment & tooling

- Node.js: use current LTS.
- **Bundler:** esbuild (configured via `esbuild.config.mjs`).
- **Types:** `obsidian` type definitions.

### Commands

```bash
npm install     # Install dependencies
npm run dev     # Watch for changes and hot-recompile
npm run build   # Production build with minification
npm run lint    # Run ESLint and Stylelint
```

## Full Cleanup Loop (MANDATORY)

Before signaling task completion or reporting success, you MUST execute and pass this sequence. **Run these commands sequentially (do not background them) so that output is immediately visible:**

1.  **Linting:** Run `npm run lint`. This executes both ESLint (for TypeScript) and Stylelint (for CSS). All errors MUST be resolved.
2.  **Type Checking:** Run `npx tsc -noEmit -skipLibCheck`. The project must have zero TypeScript errors.
3.  **Build:** Run `node esbuild.config.mjs production`. Ensure the bundling completes successfully and updates `main.js`.
4.  **Verification:** Confirm all processes exited with code 0.

## Debugging Protocol (UI/UX)

If a UI/UX bug is not resolved on the first attempt, or if the root cause is not immediately obvious from code inspection, you MUST prompt the user for path-dependency details before continuing:
- **Input Method:** Did the issue occur via mouse click, keyboard (e.g., Enter vs. Tab), or command palette?
- **State Context:** What was the specific state of the active note and target note (e.g., selection active, focus location)?
- **Trigger Specifics:** Does the behavior change if a different UI element is used to trigger the same logic?

When debugging a UI-observable Obsidian plugin failure, do not compensate for missing runtime evidence by expanding scope. Add targeted instrumentation or request a sandboxed UI rerun.

If the next useful evidence would come from seeing the UI, stop and return a rerun packet instead of inspecting Obsidian internals.

A valid rerun packet includes:
- patch applied
- command to rebuild/reload
- exact UI steps
- expected console/log output
- what to report back

## UI & UX Standards

- **Grouped Cards:** All settings must be organized within `.crucible-settings-group` containers to match the native Obsidian "Options" look.
- **Inset Dividers:** Use `hr` with `.crucible-row-divider` for separators that don't touch the edges.
- **Widths:** Use the standardized CSS classes: `.pi-width-half` (150px), `.pi-width-normal` (300px), or `.pi-width-wide` (450px). NEVER use hardcoded pixel widths for controls in CSS.
- **Centering:** Vertical centering in settings rows is currently handled by the default Obsidian layout; do not attempt complex flex overrides without careful testing.
- **Tabs:** The settings page is divided into "Settings", "Shortcuts", "Captures", "Lint", and "Variables".
- **Fuzzy Search:** Use the custom `FileSuggest` and `FolderSuggest` classes for any file-path inputs.
- **List + edit pattern:** Tabs that manage a collection (Captures, Chains, Providers, Agents, Workflows) render a list of rows on the main view — each with an Enable toggle (when applicable) and a pencil button — and flip into a per-item detail editor with a `← Back` button via the `editing*Index` / `editingWorkflowId` state on `CrucibleSettingTab`. New collection-style tabs should follow this pattern instead of inlining all fields.

## File & folder conventions

- **Modular Architecture:** The project is split into functional modules to keep `main.ts` slim.
- **Source Structure**:
  ```
  src/
    main.ts           # Entry point, lifecycle, command/event registration
    settings.ts       # Settings tab UI and pane rendering
    settingsView.ts   # ItemView wrapper that hosts the settings UI in a workspace tab
    types.ts          # Centralized TypeScript interfaces and DEFAULT_SETTINGS
    materialize.ts    # Logic for Day/Week/Month note and folder creation
    lint.ts           # Linting engine (word count, YAML formatting, date mgmt)
    captures.ts       # Capture execution logic and prompt modals
    sections.ts       # Markdown section helpers (findSectionRange, isSectionEmpty, insertIntoSection) — shared between captures and orchestration workflows
    toc.ts            # Table of Contents UI component
    suggesters.ts     # Fuzzy-search autocomplete classes for files/folders
    utils.ts          # Shared helpers (template replacement, folder checks)
    orchestration/    # Job runner, workflow registrations, and workflow-specific logic
  ```

## Template Engine

Supported tokens in any template or property injection:
- `{{date}}`: Target date of the note (YYYY-MM-DD).
- `{{time}}`: Target time of the note (HH:mm).
- `{{today}}`: System date at invocation (YYYY-MM-DD).
- `{{now}}`: System ISO datetime at invocation.
- `{{title}}`: Resolved note title (from property or filename).
- `{{value}}`: User input (supported in Captures).
- `{{datetime:FORMAT}}`: Custom Moment.js format string.

Additional tokens available in **attachment** folder/name templates (`applyAttachmentTemplate` in `src/utils.ts`):
- `{{folder}}`: The note's parent folder path.
- `{{slug}}`: Lowercase-sluggified note basename.
- `{{name}}`: Note basename (alias of `{{title}}`).
- `{{ext}}`: Attachment extension (no dot).
- `{{md5}}`: Hex MD5 of the attachment bytes (only in the name template).
- `{{original}}`: Original attachment filename without extension.

## Coding Conventions

- **Safe YAML:** Always use `this.app.fileManager.processFrontMatter` for metadata updates to ensure structural integrity.
- **Recursive Safety:** Use the `isMaterializing` flag to wrap all plugin-driven file modifications to prevent infinite loops (especially with "Lint on Save").
- **Path Awareness:** Always check `isPathIgnored` from the `Linter` class before running automated note body operations.

## Write out Plans

- When a plan is approved in Plan Mode, write a copy to plans/descriptive-name.md before proceeding with implementation

## Testing

- **Hot reload watcher:** At the start of implementation or debugging work, remind the user to run `npm run dev` in a separate terminal. This watcher is for the user's Obsidian hot-reload workflow; without it, changes may compile only during the final build and can appear not to have taken effect in Obsidian. Do not run `npm run dev` automatically unless the user explicitly asks or the task specifically requires watching live build output. If you do run it, stop it before the full cleanup loop.
- Link the root directory to your vault:
  ```bash
  ln -s /path/to/plugin <Vault>/.obsidian/plugins/obsidian-crucible
  ```
- Use the **Reload Plugin** command from the palette after a re-build.

## Quirks

Non-obvious Obsidian/runtime behaviors that bit us once and would bite again. Add entries here when a fix turned out to hinge on something the API docs don't surface.

- **`FuzzySuggestModal.selectSuggestion` closes before it chooses.** The base implementation calls `this.close()` *before* `onChooseSuggestion`/`onChooseItem`, so any "did the user pick something?" flag set inside `onChooseItem` is too late — `onClose` has already run with the flag still false. If the modal uses an `onCancel` callback distinct from `onChoose`, override `selectSuggestion` to flip the flag (and invoke the resolve callback) *before* calling `super`, or skip `super` and call `close()` yourself. See `src/modelPicker.ts`.
- **Commands must be registered via `this.registerCrucibleCommand({ ..., group })`, not `this.addCommand` directly.** The settings UI (`Crucible → Settings → Commands`) renders from `plugin.commandRegistry`, which is populated only by the helper. A command registered with `this.addCommand` will work but be invisible to the visibility toggles — that's how `lint-cleanup-transcript` slipped through. The `group` literal (`'Lint'`, `'Materialize'`, `'Orchestrations'`, etc.) controls which section it appears in; new groups need an entry in the `CrucibleCommandGroup` union in `src/main.ts` and the `GROUP_ORDER` array in `src/settings.ts`. For dynamic command sets (Shortcuts, Captures, Chains, Agents), the re-register methods call `clearCommandRegistryGroup(group)` first to avoid duplicate entries.
- **`Lint: localize attachments` is NOT part of `Lint: all`.** It's a standalone command in `src/localizeAttachments.ts` that touches binary files and (when downloading remote URLs) the network. Adding it to `lintNote()` would surprise users running plain frontmatter linting. The command still respects `lintIgnoredFolders` via `linter.isPathIgnored()`. Automatic triggers (create/edit/paste) are off by default for the same reason. If you add a future "lint everything everywhere" command, opt it into attachment localization explicitly — don't fold it into `lint-note`.
- **Derived ID frontmatter keys are kebab-case singular/plural pairs**: `yt-video-id`/`yt-video-ids`, `post-id`/`post-ids`. The singulars are per-note metadata (one URL → one ID); the plurals are tracker-intake aggregates. `Lint: all` populates the singulars from the note's `source` field only — it never scans the note body, because the IDs are metadata about what the note represents, not about incidental URLs inside it. Existing notes with legacy snake_case keys (`video_ids`, `post_ids`) are migrated manually via `Lint: update property in vault`, which prompts for old/new key names and rewrites every frontmatter entry under `lintIgnoredFolders` filtering.
- **`localizeNote()` re-reads the file right before writing, and the materializing flag spans the whole async op — not just the write.** Remote attachment downloads inside `processMatch()` can take seconds to tens of seconds. If we kept the original read-once/write-once shape, any concurrent edit landing in that window (manual `Lint: all`, debounced auto-Lint at 2s, paste, sync, the user typing) would be silently overwritten when Localize finally called `vault.modify` with its stale buffer. The fix: build a list of `(match.original → newRef)` string replacements during the download loop, then re-read fresh content and apply the replacements to *that* before writing — the literal embed strings won't be touched by Lint, so the replacements remain valid. And `withMaterializing()` now wraps the entire op so the debounced auto-Lint / auto-Localize handlers in `src/main.ts` (which gate on `!isMaterializing`) stay suppressed for the full duration, not just the millisecond-long write. If you add another long async note-mutating command, follow the same shape.
- **The Localize attachment hash is a deterministic content MD5, not random.** `md5()` in `src/localizeAttachments.ts` hashes the *final post-conversion bytes* of each attachment, and `writeAttachment` feeds that into the `{{md5}}` filename token. It looks like a random string but is fully stable: the same bytes always produce the same `_MD5.ext` name, which is exactly what makes re-localizing idempotent (the `MD5_NAME_RE` gate in `processLocal` skips files already named/placed correctly) and dedupes identical content even when it arrives from two different URLs. Don't "fix" it to hash the source URL instead — that would break content dedup and re-localize stability, and it's intentional that conversion settings changing the bytes also change the hash. The trade-off (two URLs with byte-identical content collapse to one file; a URL whose bytes drift re-localizes under a new name) is the desired behavior.
- **YT video ID extraction has one home.** `extractVideoIdFromUrl` in `src/orchestration/utils/youtube.ts` owns the regex set (`watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`). `canonicalizeUrl` in `src/orchestration/utils/urlCanonicalize.ts` delegates to it for the ID-extraction step while keeping its own URL-rewriting (host normalization, Shorts → watch, tracking-param strip). Don't add new YT regexes elsewhere — extend `URL_PATTERNS` instead. Shorts URLs and watch URLs yield the same ID, which is the load-bearing assumption behind dedup in `YoutubeTrackerWorkflow`.
- **The Ingestion Dashboard and the consolidation workflows share pure functions in `src/orchestration/utils/{blogsIntake,youtubeIntake}.ts`.** `buildBlogsSeenIdSet` / `buildYoutubeSeenIdSet`, `scanBlogsTrackerRuns` / `scanYoutubeTrackerRuns`, `loadConfiguredBlogs` / `loadConfiguredChannels`, and the intake-run listers are the single source of truth for "what is uncaptured" and "which intake runs exist." Both the dashboard and the `*_consolidate` workflows import them. If you change the algorithm, both surfaces follow — but keep them as pure `(app, ...)`-taking functions so the dashboard can call them outside a `WorkflowContext`. Don't reintroduce the logic inline in the workflow class.
- **`plugin.ingestionEvents` is the source of truth for "ingestion happened" signals.** Workflows emit `tracker-run` via the Orchestrator after each blog/youtube tracker job finishes; the YouTube metadata fetch command and the `EnrichmentQueueService` emit `metadata-enriched` after each successful write. The dashboard subscribes to these in addition to Obsidian's `metadataCache.on('changed')` / `vault.on(...)`. If you add a new ingestion path (e.g. a Web Clipper inbox watcher), emit the matching event from there too — the dashboard's live-refresh routing depends on it. `EnrichmentQueueService` items without a source-note `TFile` use `enrichYoutubeMetadataStandalone` (no back-link write); items with a real source file go through `ingestYoutubeVideoMetadata` (writes the `yt-metadata` wikilink back). Don't pass a fake `TFile` to `ingestYoutubeVideoMetadata` — `fileManager.processFrontMatter` will throw.
- **The Orphaned Attachments dashboard section keys off the `_MD5` name convention, not the localize folder.** There is no single "Localize directory" setting — `localizeAttachmentsFolderTemplate` is a per-note template (default `{{folder}}/_attachments/{{slug}}`), so managed attachments are scattered vault-wide. `computeOrphanedAttachmentRows` in `src/ingestionDashboard.ts` therefore scans every vault file matching `MD5_NAME_RE` (exported from `src/localizeAttachments.ts`) of a localizable media type (`classifyLocalizeMediaType` in `src/utils.ts`), and flags those absent from `metadataCache.resolvedLinks`. Consequence 1: if a user changes `localizeAttachmentsNameTemplate` away from the `_MD5` suffix, their files won't be detected — keep the name template and the regex in sync. Consequence 2: `resolvedLinks` covers embeds and body links but **not** frontmatter property links (`frontmatterLinks`), so an attachment referenced only from a YAML property (e.g. `cover:`) can be falsely flagged; if that bites, union `getFileCache(f).frontmatterLinks` targets into the referenced set. Deletion uses `app.fileManager.trashFile` (vault trash), and "Cleanup all" routes through `ConfirmModal` (`src/confirmModal.ts`).
- **Ignored ingestion IDs are folded into the seen set, not checked separately.** `src/orchestration/utils/ignoredIds.ts` stores bare IDs (11-char video IDs; canonical `postIdFromUrl` blog IDs) in the managed note `_crucible/orchestration/ignored.md` under `## Videos` / `## Blogs`. The single chokepoint is the `seedIds` param on `buildYoutubeSeenIdSet` / `buildBlogsSeenIdSet`: every caller (the two tracker workflows, their `*_consolidate` variants, and the dashboard's uncaptured scans) passes `await loadIgnored*Ids(app)`, so ignored items vanish from the uncaptured lists, are filtered out of tracker `newVideos`/`newPosts`, and never auto-enqueue (auto-enrich sources from the now-filtered `uncapturedVideosCache`). Don't add a parallel "is this ignored?" check anywhere — seed the set. The note lives under the `QUEUE_SCAN_SKIP_PREFIX_*` (`_crucible/orchestration/`), so the seen-set vault scan deliberately skips it; it is read explicitly via `loadIgnored*Ids` instead, and writes go through a full read-modify-write re-serialize (`vault.modify`/`create`) since write volume is click-driven. The "YouTube captures without metadata" section is intentionally unaffected — it lists already-captured notes, not tracker candidates.
