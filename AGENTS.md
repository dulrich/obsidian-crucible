# Crucible Plugin (Development Guide)

This is the root contract. Instructions here apply repo-wide. Area-local instructions live in
child `AGENTS.md` files — **walk root → the nearest child before editing**, and when they
disagree about gates or mechanics, the nearest child wins (fleet Rule 0).

| Area | File | Covers |
| --- | --- | --- |
| Search + companion | `src/search/AGENTS.md` | FTS/vector legs, schema-version pairing, index lifecycle, latency + quality measurements |
| Orchestration | `src/orchestration/AGENTS.md` | Queue, `JobBackend`s, workflows, triggers, tracker/intake pipelines |
| Providers | `src/providers/AGENTS.md` | Provider kinds and wire protocols, rerank vs embedding endpoints |
| Theme | `theme/AGENTS.md` | The surround axis, `theme.css` specificity law, token vendoring |
| Inference services | `/home/_shared_code/inference-engine/` (own repo since 2026-07-26) | llama-swap router + GLiNER2 sidecar; Vulkan/GPU verification, capability probing live in its `llama/AGENTS.md` |

Everything cross-cutting — the NUL/`console.*` gates, the frontmatter write barrier, the
note-lock family, chain/command registration, lint, localize, templates, settings UI — stays in
this file under [Quirks](#quirks).

## Project overview

- **Target:** Obsidian Community Plugin (TypeScript → bundled JavaScript).
- **Consolidation:** Replaces features from Daily Notes, Templater, Shell Commands, Linter, and QuickAdd.
- **Entry point:** `src/main.ts` compiled to `main.js` and loaded by Obsidian.
- **Artifacts:** `main.js`, `manifest.json`, and `styles.css`.

## Environment & tooling

- Node.js: use current LTS. `node:sqlite` in the search companion requires **Node ≥ 23.4**; the repo runs on 24.
- **Bundler:** esbuild (configured via `esbuild.config.mjs`).
- **Types:** `obsidian` type definitions.

### Commands

```bash
npm install            # Install dependencies
npm run dev            # Watch for changes and hot-recompile
npm run build          # tsc -noEmit -skipLibCheck && production bundle
npm run lint           # ESLint (TypeScript) + Stylelint (CSS)
npm test               # node --test tests/*.test.mjs
npm run search:serve   # Run the search companion locally (loopback only)
npm run search:quality # Ground-truth embedding quality measurement
```

## Full Cleanup Loop (MANDATORY)

Before signaling task completion or reporting success, you MUST execute and pass this sequence. **Run these commands sequentially (do not background them) so that output is immediately visible:**

1.  **Linting:** Run `npm run lint`. This executes both ESLint (for TypeScript) and Stylelint (for CSS). All errors MUST be resolved.
2.  **Type Checking:** Run `npx tsc -noEmit -skipLibCheck`. The project must have zero TypeScript errors.
3.  **Tests:** Run `npm test`. Baseline is **949 tests across 79 files, 0 failures** — a drop in the count is a deleted test, not a pass.
4.  **Build:** Run `node esbuild.config.mjs production`. Ensure the bundling completes successfully and updates `main.js`.
5.  **Verification:** Confirm all processes exited with code 0.

(`npm run build` already chains steps 2 and 4; run them explicitly when you need the output separated.)

Two gates are not commands and are easy to skip — run both on every file you create or touch:

- **`console.*` ban:** `grep -rna --include='*.ts' "console\." src/` must match only `src/log.ts`. **The `-a` is load-bearing** — see the NUL quirk. (The `--include` arrived with the dox split: child `AGENTS.md` files under `src/` legitimately *mention* `console.*` in prose.)
- **No literal control bytes:** `file <path>` must report text, and `LC_ALL=C grep -caP '\0' <path>` must exit 1.

Docs-only and plan-only changes scope their gates to the diff — a change that touches no gated
surface does not need lint/tsc/build.

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

- **Crucible builds primarily against the N1 Console design system**, adapted where Obsidian's built-in UI requires it. The component specs live in the shared `signalworks-design` skill (`~/.claude/skills/signalworks-design/`, canonical source `context-control/skills/`) — consult them before inventing a treatment or copying a nearby ad-hoc rule. Two rules that look contradictory and are not:
  - **The design language comes from N1**: the pill taxonomy (status / tag / neutral), pill geometry, status semantics, and the fixed lucide icon mapping (one concept = one icon fleet-wide).
  - **The expression stays in Obsidian semantic vars**: write `var(--text-muted)`, never `var(--n1-muted)`. `theme/theme.css`'s adapter maps N1 tokens onto Obsidian's names, and that indirection is exactly what lets the theme reskin plugin views for free (see `theme/AGENTS.md`). **Never reach for an `--n1-*` token from `styles.css`.**
- **Pills follow the fleet taxonomy, and picking the wrong family is a real error, not a nitpick.** `.crucible-pill` + a variant is the shared primitive. **Status** pills (ANSI hue label + border + 5%-tint background) are for ok/warn/error/info and must never be the sole carrier of that meaning. **Neutral** pills — `.is-muted` / `.is-contrast`, transparent background, border and label the same colour, same geometry — are for *non-semantic* states: disabled, n/a, counts-at-rest, and constraints like the Queue Configuration `serial` marker. Spending a status hue on a non-status fact spends the reader's alarm budget on nothing. Geometry is what makes a pill read as one: `border-radius: 99px`, not a corner rounding.
- **Destructive controls carry `mod-warning`**, and never sit flush against a non-destructive one — give the row's action cell a `gap` (see `.crucible-queue-action-cell`). Adjacent Run/Cancel buttons with no spacing are a misclick waiting to happen.
- **Grouped Cards:** All settings must be organized within `.crucible-settings-group` containers to match the native Obsidian "Options" look.
- **Inset Dividers:** Use `hr` with `.crucible-row-divider` for separators that don't touch the edges.
- **Widths:** Use the standardized CSS classes: `.pi-width-half` (150px), `.pi-width-normal` (300px), or `.pi-width-wide` (450px). NEVER use hardcoded pixel widths for controls in CSS.
- **Centering:** Vertical centering in settings rows is currently handled by the default Obsidian layout; do not attempt complex flex overrides without careful testing.
- **Tabs:** The settings page is divided into **Configure, Automate, AI, Orchestrator, Lint, Commands** (`CrucibleSettingsTab` in `src/settings.ts`; each tab's renderer lives in `src/settings/sections/`).
- **Fuzzy Search:** Use the custom `FileSuggest` and `FolderSuggest` classes for any file-path inputs.
- **List + edit pattern:** Tabs that manage a collection (Captures, Chains, Providers, Agents, Workflows) render a list of rows on the main view — each with an Enable toggle (when applicable) and a pencil button — and flip into a per-item detail editor with a `← Back` button via the `editing*Index` / `editingWorkflowId` state on `CrucibleSettingTab`. New collection-style tabs should follow this pattern instead of inlining all fields.

## File & folder conventions

- **Modular Architecture:** The project is split into functional modules to keep `main.ts` slim.
- **Source Structure** (representative — `src/` holds ~45 top-level modules; the subdirectories are the load-bearing part):
  ```
  src/
    main.ts             # Entry point, lifecycle, command/event registration
    commands.ts         # registerCrucibleCommand call sites (the palette-visible commands)
    internalCommands.ts # registerInternalCommands(): the awaited, targetFile-taking chain-step registry
    settings.ts         # Settings tab shell, tab switching, template-variable panels
    settingsView.ts     # ItemView wrapper that hosts the settings UI in a workspace tab
    types.ts            # Centralized TypeScript interfaces and DEFAULT_SETTINGS
    frontmatter.ts      # updateFrontmatter — the ONLY sanctioned frontmatter write path
    materialize.ts      # Day/Week/Month note and folder creation
    lint.ts             # Linting engine (word count, YAML formatting, date mgmt)
    localizeAttachments.ts  # Attachment download/localize/repair
    captures.ts         # Capture execution logic and prompt modals
    chains.ts           # ChainManager: guarded, locked, multi-step command sequences
    sections.ts         # Markdown section helpers — shared between captures and workflows
    suggesters.ts       # Fuzzy-search autocomplete classes for files/folders/currencies/locations
    utils.ts            # Shared helpers (template replacement, folder checks)
    log.ts              # logWarn/logError — the only file allowed to call console.*
    exclusions.ts       # Path exclusion predicates per surface
    surround.ts         # The dark/med/light surround axis + base-theme alignment
    orchestration/      # Job runner, backends, workflows  -> has its own AGENTS.md
    search/             # Vault search client + index lifecycle -> has its own AGENTS.md
    providers/          # Model provider clients -> has its own AGENTS.md
    settings/sections/  # Per-tab settings renderers (ai, automate, commands, configure, lint, …)
    triggers/           # triggerAdapter + guardEval (documented in orchestration/AGENTS.md)
    ingestion/          # Ingestion data/render/sections helpers
    sourceEval/         # Source-evaluation dashboard internals
  scripts/              # search-companion.mjs + measurement/bench scripts
  theme/                # N1 Console Obsidian theme -> has its own AGENTS.md
  tests/                # node --test suites (*.test.mjs)
  docs/                 # User-facing documentation
  ```

## Template Engine

Supported tokens in any template or property injection:
- `{{date}}`: Target date of the note (YYYY-MM-DD).
- `{{time}}`: Target time of the note (HH:mm).
- `{{today}}`: System date at invocation (YYYY-MM-DD).
- `{{now}}`: System ISO datetime at invocation.
- `{{title}}`: Resolved note title (from property or filename).
- `{{value}}`: User input (supported in Captures).
- `{{value:oneline}}`: User input with all whitespace runs (including newlines/paragraph breaks) collapsed to single spaces — for inserting multi-paragraph input into list items.
- `{{datetime:FORMAT}}`: Custom Moment.js format string.

Additional tokens available in **attachment** folder/name templates (`applyAttachmentTemplate` in `src/utils.ts`):
- `{{folder}}`: The note's parent folder path.
- `{{slug}}`: Lowercase-sluggified note basename.
- `{{name}}`: Note basename (alias of `{{title}}`).
- `{{ext}}`: Attachment extension (no dot).
- `{{md5}}`: Hex MD5 of the attachment bytes (only in the name template).
- `{{original}}`: Original attachment filename without extension.

## Coding Conventions

- **Safe YAML:** Always route metadata updates through `updateFrontmatter` (`src/frontmatter.ts`) — never call `fileManager.processFrontMatter` directly. The wrapper adds the stale-cache write barrier (see the quirk below) on top of `processFrontMatter`'s structural integrity.
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

## Quirks index

The one-line hooks below say *where to walk*, not what to do — read the full entry before acting.

**In this file (repo-wide / cross-cutting):**
- Shared Claude Code skills are not vendored here — re-run `context-control/skills/install.sh`.
- Measurement artifacts belong in the eval-harness repo; `runs/` is scrubbed and gitignored here.
- `Lint: word count` is prose-only (`stripNonProseContent`); the strip steps are order-sensitive.
- `FuzzySuggestModal.selectSuggestion` closes *before* it chooses.
- Register commands via `registerCrucibleCommand({…, group})`, never bare `addCommand`.
- `Lint: localize attachments` is deliberately NOT part of `Lint: all`.
- Derived ID frontmatter keys are kebab-case singular/plural pairs, derived from `source` only.
- `localizeNote()` re-reads before writing; `withMaterializing` spans the whole async op.
- The Localize attachment hash is a deterministic content MD5, not random.
- Localize strips `data:image` lazy-load placeholders that `parseAttachmentRefs` can't see.
- Localize emits an *empty* markdown alt — a numeric alt is read as a display width.
- Orphaned Attachments keys off the `_MD5` name convention, not a localize folder.
- `console.*` is banned outside `src/log.ts` — **and the gate needs `-a`** (three NUL incidents).
- `NoteLockManager.withLock` is re-entrant per async-execution context.
- A note-mutating chain step must be a chain *internal* command or it runs fire-and-forget.
- `mutating` decides whether a command/chain takes the note lock; the cycle guard is chain **+ note**.
- The auto edit-triggers bail on the note lock, not on `isMaterializing`.
- `processFrontMatter` silently drops writes against a stale cache — `updateFrontmatter` is the barrier.
- Agent prompts rewrite `{{input}}` → `{{value}}` including modifier suffixes.
- `fileManager.renameFile` on a folder skips a note renamed in the same tick.
- Attachment folder moves must use `vault.rename`, not `fileManager.renameFile`.
- `NoteLockManager` also locks `kind::id` resources — **note lock BEFORE resource lock**.
- The note-lock follows renames; a mover must not strand its lock under the old path.
- Every LLM completion call sends `max_tokens` — an uncapped request can generate to the context ceiling.

**In `src/search/AGENTS.md`:** dependency-free container image (`node:24-slim`); loopback-only default host; the `MATERIALIZED` pooling CTE + self-migrating FTS schema; job files inflate vault note counts ~7.7x; two client timeouts and the availability-gate latch; query-length-driven latency and the 3-char type-ahead gate; Obsidian's "Excluded files" list (hidden in search, deranked in the palette); the vector leg (dimension-agnostic, full-matrix scan, measured numbers, coverage-aware skip, schema pairing, backend seam); `(vault_id, id)` chunk keying; `embedding_space` as a conservative guard; quantization degrades spread, not ranking; per-chunk implicit AND is the miss root cause and `coverage` is the measured default `rankingMode` (a leg, never a pool rerank); the entity facet (schema 7 — every-chunk emission, weight 8.0, `contentHash` folds entity text, GLiNER2-compatible shape); the query log lives outside the note tree and its export omits click-less queries.

**In `src/orchestration/AGENTS.md`:** one queue with two persistence backends; `JobStore.move` rollback; re-homing file jobs whose type flipped to memory; `youtube_metadata_fetch` is one job per note; `plugin.ingestionEvents`; platform-aware `post-id` canonicalization; the single YT video-ID home; shared intake pure functions; ignored IDs seeded into the seen set; `_blog_metadata` notes are not captures; Triggers are the *if* and Chains the *then*; Daily Brief FX + settings-cached autocompletes; `newJobId` is millisecond+monotonic and claim order is mint order.

**In `src/providers/AGENTS.md`:** LM Studio is `openai-compatible`, not `ollama`; a reranker is not an embedding model (every structural guard passes it).

**In `theme/AGENTS.md`:** the surround axis, the (0,1,1) specificity law, the block-1/block-2 name split, exactly four `!important`s, token vendoring.

**In `inference-engine/llama/AGENTS.md`** (own repo, `/home/_shared_code/inference-engine/` — the container graduated out of `docker/llamacpp-vulkan/` on 2026-07-26)**:** a healthy local inference service has told you nothing — `llvmpipe`, arch-list lies, HTTP-200 capability probes.

## Quirks

Non-obvious Obsidian/runtime behaviors that bit us once and would bite again. Add entries here when a fix turned out to hinge on something the API docs don't surface — and add them to the **nearest** `AGENTS.md`, not automatically this one.

- **Shared Claude Code skills (tn-code-review, plan-workflow, tests-lint, project-setup, migrations-release-cleanup) are NOT in this repo.** They live canonically in `/home/_shared_code/context-control/skills/` and are installed machine-wide as symlinks into `~/.claude/skills/` by that repo's `skills/install.sh`. This repo's local `.claude/skills/tn-code-review` copy was deleted in favor of the shared one — if a skill seems missing, re-run `context-control/skills/install.sh` rather than restoring a local copy (local copies drift).

- **Measurement artifacts land in the eval-harness repo (`/home/_shared_code/eval-harness/local-inference-bench/`), never this repo.** `runs/` was scrubbed from this repo's git history on 2026-07-26 (it is public; one sample file carried vault-derived text) and is `.gitignore`d; the archive over there is the source of record for every measured number cited in `docs/local-inference.md` and `docs/search-companion.md`, including the per-claim validity memo. Future measurement runs get a new sibling dir under that archive's `measurements/`.

- **`Lint: word count` is prose-only — it strips markup before segmenting.** `calculateWordCount` in `src/lint.ts` runs `stripNonProseContent` (after removing frontmatter, before `Intl.Segmenter`), which deletes fenced/inline code, HTML comments, `<svg>`/`<script>`/`<style>` blocks, and image embeds, and reduces `[text](url)`/`[[page|alias]]` links to their visible text. This exists because web-clipped articles embed inline `<svg>` Highcharts charts whose hundreds of `<path d="M 0 98.75 L …">` coordinate tokens each register as `isWordLike` — one chart pushed a real ~1k-word article to `word-count: 7375`. Don't "simplify" it back to strip-frontmatter-only, and don't be alarmed that re-linting legacy notes lowers their `word-count`: that's the count being corrected, not a regression. `stripNonProseContent` and the now-module-level `calculateWordCount` are exported for unit tests (`tests/lint.wordcount.test.mjs`); the `Linter.calculateWordCount` method is a thin wrapper. The strip steps are order-sensitive (outer/greedy constructs first) — see the comment above `stripNonProseContent`.
- **`FuzzySuggestModal.selectSuggestion` closes before it chooses.** The base implementation calls `this.close()` *before* `onChooseSuggestion`/`onChooseItem`, so any "did the user pick something?" flag set inside `onChooseItem` is too late — `onClose` has already run with the flag still false. If the modal uses an `onCancel` callback distinct from `onChoose`, override `selectSuggestion` to flip the flag (and invoke the resolve callback) *before* calling `super`, or skip `super` and call `close()` yourself. See `src/modelPicker.ts`.
- **Commands must be registered via `this.registerCrucibleCommand({ ..., group })`, not `this.addCommand` directly.** The settings UI (`Crucible → Settings → Commands`) renders from `plugin.commandRegistry`, which is populated only by the helper. A command registered with `this.addCommand` will work but be invisible to the visibility toggles — that's how `lint-cleanup-transcript` slipped through. The `group` literal (`'Lint'`, `'Materialize'`, `'Orchestrations'`, etc.) controls which section it appears in; new groups need an entry in the `CrucibleCommandGroup` union in `src/main.ts` and the `GROUP_ORDER` array in `src/settings/sections/commands.ts`. For dynamic command sets (Shortcuts, Captures, Chains, Agents), the re-register methods call `clearCommandRegistryGroup(group)` first to avoid duplicate entries.
- **`Lint: localize attachments` is NOT part of `Lint: all`.** It's a standalone command in `src/localizeAttachments.ts` that touches binary files and (when downloading remote URLs) the network. Adding it to `lintNote()` would surprise users running plain frontmatter linting. The command still respects `lintIgnoredFolders` via `linter.isPathIgnored()`. Automatic triggers (create/edit/paste) are off by default for the same reason. If you add a future "lint everything everywhere" command, opt it into attachment localization explicitly — don't fold it into `lint-note`.
- **Derived ID frontmatter keys are kebab-case singular/plural pairs**: `yt-video-id`/`yt-video-ids`, `post-id`/`post-ids`. The singulars are per-note metadata (one URL → one ID); the plurals are tracker-intake aggregates. `Lint: all` populates the singulars from the note's `source` field only — it never scans the note body, because the IDs are metadata about what the note represents, not about incidental URLs inside it. Existing notes with legacy snake_case keys (`video_ids`, `post_ids`) are migrated manually via `Lint: update property in vault`, which prompts for old/new key names and rewrites every frontmatter entry under `lintIgnoredFolders` filtering.
- **`localizeNote()` re-reads the file right before writing, and the materializing flag spans the whole async op — not just the write.** Remote attachment downloads inside `processMatch()` can take seconds to tens of seconds. If we kept the original read-once/write-once shape, any concurrent edit landing in that window (manual `Lint: all`, debounced auto-Lint at 2s, paste, sync, the user typing) would be silently overwritten when Localize finally called `vault.modify` with its stale buffer. The fix: build a list of `(match.original → newRef)` string replacements during the download loop, then re-read fresh content and apply the replacements to *that* before writing — the literal embed strings won't be touched by Lint, so the replacements remain valid. And `withMaterializing()` now wraps the entire op so the debounced auto-Lint / auto-Localize handlers in `src/main.ts` (which gate on `!isMaterializing`) stay suppressed for the full duration, not just the millisecond-long write. If you add another long async note-mutating command, follow the same shape.
- **The Localize attachment hash is a deterministic content MD5, not random.** `md5()` in `src/localizeAttachments.ts` hashes the *final post-conversion bytes* of each attachment, and `writeAttachment` feeds that into the `{{md5}}` filename token. It looks like a random string but is fully stable: the same bytes always produce the same `_MD5.ext` name, which is exactly what makes re-localizing idempotent (the `MD5_NAME_RE` gate in `processLocal` skips files already named/placed correctly) and dedupes identical content even when it arrives from two different URLs. Don't "fix" it to hash the source URL instead — that would break content dedup and re-localize stability, and it's intentional that conversion settings changing the bytes also change the hash. The trade-off (two URLs with byte-identical content collapse to one file; a URL whose bytes drift re-localizes under a new name) is the desired behavior.
- **Localize strips web-clipper `data:image` lazy-load placeholders, and they're invisible to `parseAttachmentRefs`.** Web clippers capture lazy-loaded `<img>` as *two* markdown images glued on one line: a 1×1 transparent placeholder `![](data:image/gif;base64,...)` immediately followed by the real image, separated by a space. Obsidian's metadata cache does **not** list `data:` URIs as embeds, so `parseAttachmentRefs` never sees them (`localizeNote`'s match list excludes them entirely — confirmed via Localize debug mode). Left in place, the placeholder shares an inline run with the real internal embed and **prevents Obsidian from rendering that embed at all** — the note shows no images even though Localize correctly downloaded every real attachment to a valid path. `localizeNote` therefore strips them separately via `DATA_URI_IMAGE_RE` (`![alt](data:image/...)` + trailing inline whitespace) as a post-pass on the fresh content, gated on `localizeAttachmentsImagesProcessAttached`. This is independent of the match/replacement loop, so the `matches.length === 0` early-return and the `replacements.length > 0` write-guard both also check `placeholderCount`. To diagnose "Localize ran but images don't show," enable **Localize → Debug mode** (writes to the shared `_crucible/debug.md`) and read the per-image decision lines.
- **Localize emits markdown embeds with an *empty* alt (`![](path)`), because Obsidian reads a numeric alt as a display size.** Obsidian parses `![1](img.png)` as "render at 1px wide" — the alt is interpreted as a width when it looks like a number (or `WxH`), so the image collapses to an invisible sliver. Localize's "alt" is only a guessed filename (`guessRemoteOriginalName` returns the last path segment sans extension — Patreon's `.../1.png` → `1`, which is exactly the poison value), so `formatEmbed` drops it entirely for the `md` branch. Don't reintroduce alt text into `formatEmbed` to "improve accessibility" — a numeric filename will silently break rendering again. Wiki embeds (`![[path]]`) never carried alt anyway.
- **The Orphaned Attachments dashboard section keys off the `_MD5` name convention, not the localize folder.** There is no single "Localize directory" setting — `localizeAttachmentsFolderTemplate` is a per-note template (default `{{folder}}/_attachments/{{slug}}`), so managed attachments are scattered vault-wide. `computeOrphanedAttachmentRows` in `src/ingestion/data/orphanedAttachments.ts` therefore scans every vault file matching `MD5_NAME_RE` (exported from `src/localizeAttachments.ts`) of a localizable media type (`classifyLocalizeMediaType` in `src/utils.ts`), and flags those absent from `metadataCache.resolvedLinks`. Consequence 1: if a user changes `localizeAttachmentsNameTemplate` away from the `_MD5` suffix, their files won't be detected — keep the name template and the regex in sync. Consequence 2: `resolvedLinks` covers embeds and body links but **not** frontmatter property links (`frontmatterLinks`), so an attachment referenced only from a YAML property (e.g. `cover:`) can be falsely flagged; if that bites, union `getFileCache(f).frontmatterLinks` targets into the referenced set. Deletion uses `app.fileManager.trashFile` (vault trash), and "Cleanup all" routes through `ConfirmModal` (`src/confirmModal.ts`).
- **`console.*` is banned in `src/` outside `src/log.ts`.** Crucible keeps the developer console quiet for users by default. Every diagnostic goes through `logWarn` / `logError` from `src/log.ts`, which no-op unless debug output is enabled (`setCrucibleDebug(true)` programmatically, or `window.__CRUCIBLE_DEBUG__ = true` in an installed vault). `grep -rna --include='*.ts' "console\." src/` should match only `src/log.ts` (the `--include` keeps the child `AGENTS.md` docs under `src/` — which mention `console.*` in prose — out of the sweep). Add new diagnostics via the helpers, not raw `console.*`.

  **Use the `-a`.** Without it this gate is not sound: a single NUL byte anywhere in a file makes GNU grep classify it as binary and *silently skip its contents* while still exiting 0, so a `console.*` call in that file passes the gate unseen. This is not hypothetical — `src/fileOpenRanking.ts` shipped a raw NUL in the `createNarrowState` sentinel (`filterSig: '<NUL>'`, written as a literal control character rather than the `'\0'` escape), and an injected `console.log` in that file was confirmed to evade `grep -rn`. The literal was replaced with the two-character escape `'\0'` — identical runtime value, plain-text file — but the gate keeps `-a` so the next stray control byte can't re-blind it. The same NUL also silently breaks any other `grep`-based sweep over `src/`, which is worth remembering when a search "finds nothing" implausibly.

  **It happened a second time, so treat "sentinel string" as the warning sign.** The vector-leg work wrote the vector backend's all-vaults cache key as a literal NUL (`cacheKey = vaultId => … : '<NUL>all'`) in `scripts/search-companion.mjs` — same idea as `filterSig`, same mistake, a different file outside `src/`. Symptom in review: `grep -n "MATERIALIZED" scripts/search-companion.mjs` returned **nothing** on a file that plainly contains it, and `file` reported `binary data` where `git show master:…` of the same file reported `Unicode text, UTF-8`. Note the byte was valid-UTF-8-clean (`raw.decode('utf-8')` succeeded) — only `file`/grep's binary heuristic caught it, so a UTF-8 validity check is not the test. When you need an in-band sentinel that cannot collide with real data, write `'\0'` (two characters) — never paste the control character. When a `grep` over a known-good file implausibly finds nothing, check `file` on it before believing the result.

  **A third one landed in `scripts/dseries-judge.mjs`, and it widens the warning sign from "sentinel" to "any in-band separator".** The first two were explicit sentinel *values*; this one was a **delimiter inside a hash input** — `createHash('sha256').update(\`${seed}<NUL>${queryId}\`)`, where the separator exists so two different `(seed, queryId)` splits cannot collide. Same reasoning, same byte, and it reads as an ordinary space in every diff and review view, so it is *less* visible than the first two rather than more. Two things this instance adds. (1) **The gate is what caught it, not inspection** — `file` reported `a node script executable (binary data)` and `LC_ALL=C grep -caP '\0'` returned 1, in a file that had already been read, linted and smoke-tested clean. Run `file` on every file you created, not only ones you suspect. (2) **The Bash tool refuses a command containing a literal NUL** ("command contains control characters that would be hidden in the approval dialog"), so the fix cannot be a one-liner `node -e` — write a `.mjs` that reconstructs the byte numerically (`String.fromCharCode(0)`) and run that. The correction is always the same: the two-character escape `\0`, never the pasted control character.
- **`NoteLockManager.withLock` is re-entrant per async-execution context — and it has to be, because chains hold a note's lock while invoking lint/localize/yt-metadata steps that re-lock the *same* note.** The lock is a path-keyed FIFO mutex (`src/orchestration/NoteLockManager.ts`). `executeChain` wraps the whole step loop in `withLock(targetFile.path, 'chain:'+name, …)`, but chain steps can call internal commands (`lint-note`, `lint-cleanup-transcript`, `lint-localize-attachments-note`, the YT-metadata write) that *also* call `withLock` on the same path. With a plain mutex that's a guaranteed self-deadlock — the holder waits on a lock it already owns — which is exactly what stuck "Refine Transcript: Gemma 4" (the refined text was written, then the chain's lint/cleanup step blocked forever and the overlay spinner never cleared). The fix: `withLock` tracks held paths in an `AsyncLocalStorage<Set<string>>` and runs inline (no re-acquire) when the current context already holds the path. Reentrancy is **context-scoped on purpose** — a *foreign* `withLock` on a held path (a different top-level operation) is not in the holder's async context, so it still queues as a waiter; only nested calls within the holder re-enter. Two consequences: (1) low-level `acquire` is deliberately left non-reentrant — only `withLock` (what every mutation choke-point uses via `withOptionalNoteLock`) re-enters; if you add a new choke-point, go through `withLock`, not raw `acquire`. (2) This pulls in `node:async_hooks`, so `esbuild.config.mjs` externalizes both bare and `node:`-prefixed builtins (`...builtinModules.map(m => 'node:'+m)`); Electron's renderer Node resolves the `require("node:async_hooks")` at runtime.
- **A note-mutating command used as a chain step must be registered as a chain *internal* command, or it runs fire-and-forget.** `ChainManager.executeStep` resolves `step.commandId` against the internal registry (`registerInternalCommand`, populated by the `register(...)` helper in `registerInternalCommands()` — `src/internalCommands.ts`, called from `main.ts`'s `onload`). On a hit it `await`s the fn and passes `targetFile` (the chain's note). On a **miss** it falls through to the external branch — `this.app.commands.executeCommandById(step.commandId); return true;` — which is fire-and-forget: it does *not* await the command's promise, returns `true` immediately (so debug.md logs "success"), ignores `targetFile` (the command reads the *active* note), and runs **outside** the chain's note-lock context. That's how `youtube-fetch-video-metadata` (registered only via `registerCrucibleCommand`/`addCommand`, not as an internal command) silently no-op'd inside "Ingest as Transcript": every step logged success but the `yt-metadata` link never landed, because the real write happened after the step returned, as a foreign lock-waiter, and got lost — while running the command standalone worked. Fix pattern: register the command as an internal command too (`register('youtube-fetch-video-metadata', (_a,_p,_e,tf) => this.fetchYoutubeMetadataForActiveNote(tf))`), having its handler accept an optional `targetFile` that defaults to the active note, and return a boolean. The `register()` helper aliases both `obsidian-crucible:<id>` and `crucible:<id>`, so either stored `commandId` form resolves. If you expose another note-mutating Crucible command that users may drop into a chain, register it internally — don't rely on the external `executeCommandById` path for anything that writes. Audited coverage (all self-register an internal command taking `targetFile`): the lint family, `materialize-*-today`, `mark-as-forwarded`, `youtube-fetch-video-metadata`, the two move-file commands (`registerMoveFileCommands`), per-capture (`registerCaptures`), per-agent (`agents.ts registerAgents`), and per-chain — `registerChains` now also registers each `chain-<index>` as an internal command so a **nested chain** runs awaited, on the parent's target note, under the reentrant lock (it cleans up `registeredChainInternalIds` first so reordered/deleted chains don't leak a stale id). Intentionally **not** internal: the `materialize-*-picker` commands (interactive modal, no `targetFile` semantics) and the `move-current-file-to-folder...` picker — they prompt, so they don't fit the awaited-target-file chain-step model.
- **`mutating` is the single flag that decides whether running a command/chain takes the note lock, and the chain cycle-guard is keyed by chain *+ note*, not the chain alone.** Every registry entry carries `mutating` (`CrucibleCommandEntry` in `main.ts`; `registerCrucibleCommand` defaults it to `true`), and `Chain` has an optional `mutating?: boolean` (omitted === mutating, surfaced as the "Mutates the note" toggle in the chain editor). `executeChain` only wraps the step loop in `withOptionalNoteLock` when `chain.mutating !== false`; a read-only chain (e.g. one that just opens a dashboard view) runs without locking/graying the note. Default-true is deliberate — existing chains and any command you forget to mark stay safely serialized. Separately, the recursion guard is now `executing: Map<Chain, Set<string>>` keyed by the resolved target path, so the **same chain runs concurrently on different notes** (a queued `transcript_refine` on note A and a manual "Chain: Refine Transcript" on note B no longer false-trip the "already running; skipping" cycle notice) while a true self-cycle on the *same* note is still caught. Resolve `targetFile` *before* the guard check — the key needs the path. Don't reintroduce a chain-only `Set<Chain>` guard (false-positives across notes) or hoist locking out of the `mutating` check (re-grays read-only chains). The built-in lock-takers (lint, localize, yt-metadata) are inherently mutating and lock unconditionally; the registry `mutating` flag only drives the chain path today (read-only built-ins are marked `false` for documentation / future centralized dispatch).
- **The auto edit-triggers bail when the note lock is held — the lock, not `isMaterializing`, is the authoritative "this note is being mutated, hands off" signal.** `debouncedLint` / `debouncedLocalize` (the `vault.on('modify')` handlers in `main.ts`) now early-return on `this.noteLocks.isLocked(file.path)` *in addition to* `!this.isMaterializing`. `isMaterializing` is a **global** boolean that a long chain only sets around its own lint/localize sub-ops, so between an "Ingest as …" chain's steps it reads false; the debounced localize would then fire against a note the chain is mid-writing, download an attachment, and lose the landing ref when the chain's next write clobbered the buffer — leaving an orphaned `_MD5` file. Gating on the note lock makes the lock holder (the chain) the sole mutator; the auto-trigger simply skips while it's busy and the chain's own reentrant localize step still runs inline. If you add another auto-fired note-mutating handler, gate it on `noteLocks.isLocked(path)` too — don't rely on `isMaterializing` alone.
- **`fileManager.processFrontMatter` silently drops the value write when the metadata cache is stale — which it is right after a rename + rapid edit.** `processFrontMatter` merges the callback's mutations against `metadataCache.getFileCache(file).frontmatterPosition`, not the raw content. When the cache hasn't re-indexed the current bytes — e.g. the "Ingest as News" chain runs `move-current-file-to-daily-folder` then `lint-note` immediately after the web clipper wrote the note in staged bursts — the position is stale, so the merged frontmatter is written to the wrong byte range and the value is lost. Symptom that cost a long hunt: lint computed `word-count 380`, the callback's `fm['word-count']` *was* 380, yet the on-disk value came back empty; running `Lint: all` again seconds later worked only because the cache had settled (that was the user's standing workaround). The tell is that `processFrontMatter`'s own resulting `modify` event shows the value already wrong — no later clobber involved. The canonical fix is the **write-consistency barrier inside `updateFrontmatter`** (`src/frontmatter.ts`) — the chokepoint every frontmatter write must go through. Before calling `processFrontMatter` it compares the cache's `frontmatterPosition` end offset and key set against the actual block in the raw content; when they disagree it awaits the file's next `metadataCache.on('changed')` (bounded, ~2s — the write-side mirror of `TriggerRegistry.waitForConsistentCache`), and on timeout it warns, writes anyway, and verifies the mutated keys landed via a raw re-read (escalating the log if not). So: route every frontmatter write through `updateFrontmatter` and the race is handled for free — do **not** add per-key content-based reasserts (the old `setFrontmatterWordCount` workaround was deleted; its `String.replace` rebuild also corrupted empty frontmatter blocks). If a content-based `vault.process` fallback is ever genuinely needed, it must splice by index, never `String.replace(block, …)`. A separate belt-and-suspenders lives in `ChainManager.reconcileOpenEditor`: after a chain that moves-then-mutates a note, it forces any open editor leaf's buffer to match disk (`setViewData`) so a stale editor autosave can't clobber the chain's writes — relevant when the note *is* open (the clipper case leaves it closed, so that path is a no-op there).
- **Agent prompts rewrite `{{input}}` → `{{value}}` including modifier suffixes.** `src/agents.ts` maps the alias with `/{{input(:[^}]*)?}}/g` → `{{value$1}}` before `applyTemplateString`, so `{{input:oneline}}` becomes `{{value:oneline}}` automatically. Any new `{{value:*}}` modifier added to `replaceTokens` in `src/utils.ts` gets its `{{input:*}}` alias for free — don't add a second alias rewrite, and don't narrow that regex back to plain `{{input}}`.
- **`fileManager.renameFile` on a folder does NOT rewrite links from a note renamed in the same tick — the metadata cache lags.** When a localized note moves folders, `AttachmentLocalizer.onNoteRename` (`src/localizeAttachments.ts`) moves its attachment folder with `fileManager.renameFile(folder, newFolder)` from inside the note's own `vault.on('rename')` handler. Obsidian *would* normally rewrite every link into a renamed folder, but at that instant the moving note's cache entry hasn't reindexed at its new path, so Obsidian can't see it as a referrer and silently skips the moving note's own embeds. The folder lands at the new location while the note's embeds still point at the dead old path → broken embeds + orphaned `_MD5` files (this accumulated silently across clip-then-move runs). Fix: after the folder rename, `onNoteRename` reads the note and runs `repointAttachmentFolderPrefix(content, oldFolder, newFolder)` itself — a deterministic, cache-independent prefix swap scoped to embed refs (handles raw wiki + `%20`-encoded markdown forms, idempotent so it harmlessly no-ops any ref Obsidian *did* update). The read/modify is wrapped in `withOptionalNoteLock` + `withMaterializing` so it doesn't retrigger the debounced auto-lint/localize. Don't rely on Obsidian's automatic folder-rename link rewrite for a note that moved in the same tick. To recover pre-fix damage there's `Lint: repair attachment links [(vault)]` (`repairNote`/`repairVault`): it repoints broken embeds to the moved file via `planLocalAttachmentRepair` (prefers the note's expected attachment folder), or re-downloads when the ref is still a remote URL.
- **Attachment folder moves must use `vault.rename`, not `fileManager.renameFile`.** The folder-move fix above still let Obsidian start its own automatic link rewrite before Crucible's deterministic `repointAttachmentFolderPrefix`. In clip-then-ingest flows with auto-localize enabled, that automatic rewrite can race a Localize pass that has just shortened a long remote image URL to a local `_MD5` embed. Obsidian's rewrite is position/cache based, so stale offsets can splice the embed into nearby prose (e.g. `these days` became `th![](hash_MD5.webp)hash_tail.webp)`). `onNoteRename` now moves the attachment folder with `app.vault.rename(existing, newFolder)` specifically to bypass Obsidian's link-rewrite machinery, then performs the scoped embed-prefix rewrite itself under the note lock/materializing guard. Do not change it back to `fileManager.renameFile` unless you also prove Obsidian's rewrite is fully disabled or position-safe in this same-tick rename path.
- **`NoteLockManager` also locks non-note resources (`kind::id` keys), with a strict acquisition order: note lock BEFORE resource lock.** `withResourceLock(kind, id, …)` maps to `withLock(resourceLockKey(kind, id), …)` — the same FIFO mutex map, namespaced as `kind::id` (`:` is illegal in vault filenames, so a resource key can never collide with a note path). First user: `yt-video::<id>` serializes the check-then-create of a video's metadata note across per-note `youtube_metadata_fetch` jobs and the direct command, which would otherwise both miss `findExistingMetadataNote` and double-fetch/double-create. The ordering rule is the deadlock guard: code holding a note lock may acquire a resource lock inside it, but code holding a resource lock must NEVER acquire a note lock — note→resource everywhere means no wait cycle is possible. Reentrancy works across the nesting (both go through `withLock`'s `AsyncLocalStorage` held-set). Resource keys deliberately do not emit `note-lock-changed`: they drive no editor overlay, and listeners key off vault paths.
- **The note-lock follows renames; a mutating op that moves its target note mid-flight must not strand its lock under the old path.** The lock is keyed by path, but every gate that prevents concurrent writes reads the *live* path: `isLocked(file.path)` in the auto-lint/localize debounces (`main.ts`), `TriggerRegistry.fireEvent`, and `onNoteRename`'s own `withOptionalNoteLock`. An "Ingest as …" chain holds `withOptionalNoteLock(targetFile.path, …)` for the whole chain, then a step moves the note into the daily asset folder (`moveFileToFolder` → `fileManager.renameFile`). Before the fix the held lock stayed keyed under the *old* path, so all those gates saw the new path as unlocked and fired concurrently — the chain (writing frontmatter under the old-path lock) and a localize pass (rewriting attachment refs on the new path) interleaved, splicing a body `![](…_MD5.jpg)` embed into the `word-count` frontmatter field. Fix: `NoteLockManager.handleRename(oldPath, newPath)` re-keys the held `LockState` to the new path, wired from a dedicated `vault.on('rename')` registered **before** `triggers.start()` and the other rename handler so it runs first (vault listeners fire in registration order). Reentrancy and release track the `LockState` object (not the path), so re-keying is safe for the holder and a re-entrant `withLock(newPath)` from a later chain step still runs inline. If `newPath` already has its own lock (shouldn't happen — the mover checks the target is free), it logs and leaves both untouched rather than clobbering a holder.
- **Every LLM completion call must send `max_tokens` — an uncapped request is `n_predict: -1` on llama-server, and a temperature-0 repetition loop will generate until the context ceiling.** The first live image-descriptions batch hit this twice in 100 images: `describeImagePass` sent no cap, so a dense chart at `temperature: 0` looped for ~10 minutes at 97% GPU (`extraction=597888ms`) until the model's 32k context filled, storing 94k/76k-char degenerate coordinate dumps that were then indexed into notes — while the batch appeared silently stalled (no timeout existed anywhere in the path, and `requestUrl` is not abortable). The hardening (`plans/image-describe-hardening-ux.md` WP-1) has four layers, and each is load-bearing: (1) per-pass caps sent **unconditionally** — `IMAGE_DESCRIPTION_NARRATIVE_MAX_TOKENS` 512 / `IMAGE_DESCRIPTION_EXTRACTION_MAX_TOKENS` 2048 in `src/providers/shared.ts`; `max_tokens` is universal on chat/completions, so unlike `reasoning_effort` it takes no `isLocal` gate; (2) `withTimeout` (`src/orchestration/utils/imageDescribe.ts`) bounds every provider pass (120s) and transcode (30s) — since the request can't be aborted, the race abandons the promise and the server-side cap bounds the rest; (3) a per-image try/catch writes a durable `kind: 'failed'` store record: `has()` staying true for it is the point (poison images are skipped on later runs, not retried forever), but failed records must emit **no chunks and no facet** — `resolveImageDescriptions` filters them explicitly so a failure's arrival never moves a note's `contentHash`; (4) the backfill self-heals pre-cap damage via `pruneDegenerate(20_000)` (healthy extraction: median ~1.3k chars, max ~7.4k — the 20k threshold is far from both) so degenerate vision records fall out of `has()` and re-describe under the caps. The generalizable rule: a bounded `max_tokens` is part of the request contract for any new completion call in this plugin, not a tuning knob — and "the router looks idle" proves nothing, because llama-swap logs only completed requests while an in-flight runaway is invisible.
