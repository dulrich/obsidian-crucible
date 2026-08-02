# Crucible Plugin (Development Guide)

This is the root contract. Instructions here apply repo-wide. Area-local instructions live in
child `AGENTS.md` files — **walk root → the nearest child before editing**, and when they
disagree about gates or mechanics, the nearest child wins (fleet Rule 0).

| Area | File | Covers |
| --- | --- | --- |
| Search + companion | `src/search/AGENTS.md` | FTS/vector legs, schema-version pairing, index lifecycle, latency + quality measurements |
| Orchestration | `src/orchestration/AGENTS.md` | Queue, `JobBackend`s, workflows, triggers, tracker/intake pipelines, note-lock family |
| Providers | `src/providers/AGENTS.md` | Provider kinds and wire protocols, rerank vs embedding endpoints, `max_tokens`, `providerModelContract.ts` |
| Flat `src/` modules | `src/AGENTS.md` | Lint/localize engines, chain/command registration, Dataview refresh, agent template aliasing |
| Ingestion dashboard | `src/ingestion/AGENTS.md` | Derived ID keys, Orphaned Attachments, dashboard render/dirty-flush pipeline |
| Settings UI | `src/settings/AGENTS.md` | Destructive-actions framework, AI/Orchestrate renderer split, settings-chrome UI standards |
| Theme | `theme/AGENTS.md` | The surround axis, `theme.css` specificity law, token vendoring |
| Inference services | `/home/_shared_code/inference-engine/` (own repo since 2026-07-26) | llama-swap router + GLiNER2 sidecar; Vulkan/GPU verification, capability probing live in its `llama/AGENTS.md` |

Five quirks are genuinely cross-cutting and stay in this file under [Quirks](#quirks): the
NUL/`console.*` gate block, the `updateFrontmatter` stale-cache write barrier, the
`vault.on('create')` startup-replay guard, the shared Claude Code skills location, and the
eval-harness measurement-artifact policy. Everything else — the note-lock family,
chain/command registration, lint, localize, Dataview refresh, the Ingestion dashboard, and
settings-UI mechanics — lives at its nearest child `AGENTS.md` per the table above.

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
- **Icon-mapping table (one concept = one icon, fleet-wide).** The single verb → lucide-glyph lookup. Adding a control means reusing a row or adding a new one — never a second icon for an existing concept, never a second concept on an existing icon.

  | Icon | Concept |
  | --- | --- |
  | `external-link` | External destination |
  | `file-text` | Metadata/meta note |
  | `download` | Clip |
  | `circle-x` | Skip (reversible-warn) |
  | `sparkles` | Enrich |
  | `import` | Ingest (retired at DP1 — intake rows use Clip; reserved, don't reuse) |
  | `play` | Run job |
  | `x` | Cancel job / remove a value from a list |
  | `info` | Details |
  | `pencil` | Edit |
  | `trash` | Delete an entity |
  | `copy-plus` | Duplicate |
  | `copy` | Copy to clipboard/path |
  | `refresh-cw` | Refresh |
  | `chevron-right` / `chevron-down` | Collapsed / expanded |
  | `eye-off` / `eye` | Ignore / Un-ignore |
  | `arrow-up` / `arrow-down` | Reorder |
  | `arrow-right` | Open note (row scope) |

  `trash` is reserved for deleting a standalone entity (a List + edit pattern collection
  row — Capture, Chain, Trigger, Agent, Provider — or an equivalent top-level record with
  its own lifecycle); removing a row/value from an array field nested inside an entity's
  own editor (a condition, a variable, a step, a pinned folder, an excluded folder, a
  provider's model entry, an FX pair, …) uses `x` instead — it deletes list membership,
  not the entity.
- **Pill family choice is a real error, not a nitpick — `.crucible-pill` + a variant is the shared primitive.**
  - **Status** pills (ANSI hue label + border + 5%-tint background) are for ok/warn/error/info and must never be the sole carrier of that meaning.
  - **Neutral** pills — `.is-muted` / `.is-contrast`, transparent background, border and label the same colour, same geometry — are for *non-semantic* states: disabled, n/a, counts-at-rest, and constraints like the Queue Configuration `serial` marker. Spending a status hue on a non-status fact spends the reader's alarm budget on nothing.
  - Geometry is what makes a pill read as one: `border-radius: 99px`, not a corner rounding.
- **Destructive controls carry `mod-warning`**, and never sit flush against a non-destructive one — give the row's action cell a `gap` (see `.crucible-queue-action-cell`). Adjacent Run/Cancel buttons with no spacing are a misclick waiting to happen.
- **Reversible actions carry the warning hue, not `mod-warning`** — the red/warn split is destructive-vs-reversible, not scary-vs-benign.
  - Exemplar: Ignore/Un-ignore on the Ingestion dashboard, icon-only buttons (`eye-off`/`eye`) in `.crucible-intake-warn-btn` (`color: var(--text-warning)` — the same semantic var the `is-warn` pill uses), with `aria-label` + `title` because an icon-only control has no visible label.
  - They deliberately stay OUT of `DESTRUCTIVE_ACTIONS`/`confirmDestructive` (reversible pair). Promoting a reversible action to `mod-warning` red spends the reader's alarm budget on nothing — same law as the pill taxonomy above.
- **Row actions merge into ONE action cell per table.** `.crucible-intake-action-cell` for intake tables; `.crucible-queue-action-cell` for the queue monitor — both nowrap, with a real `gap` between children.
  - **Intake rows are uniform icon-only buttons** (`renderIconButton` in `src/ingestion/render/cells.ts`), fixed order external → meta → command → skip: `external-link` (opens the URL), `file-text` (metadata/blog note), Clip = `download` / Enrich = `sparkles`, Skip = `circle-x` (reversible-warn). Every icon-only control carries `aria-label` + `title` — no exceptions.
  - **Row scope adapts CC-11, it doesn't break it**: in a dense table row an external destination may be icon-only, but the `external-link` glyph stays mandatory *as the icon itself* and the `title` carries the destination. At panel/inline scope the rule is unchanged — `renderExternalLink`'s labeled anchor + trailing 12px glyph (see the control centers' blog links).
  - **Muted, never absent**: a deactivated action stays in the cell, rendered muted (`.is-muted` → `var(--text-faint)` + `cursor: not-allowed`, click never wired) with a `title` explaining why (no body, no metadata note, no configured command, …). Don't add state-readout columns — the old `Enriched?` column is the counter-exemplar; state folds into the relevant button's muted/enabled rendering and tooltip.
  - Ignored-section rows carry no Un-ignore control: Clip/Enrich implicitly un-ignores, then runs the primary action. `eye-off`/`eye` remains the pair only where an explicit Ignore/Un-ignore toggle exists.
  - Queue monitor rows follow the same law: Run = `play`, Details = `info`, Cancel = danger `x` with `mod-warning` (destructive — it kills a job).

- **Settings-chrome UI standards** (Grouped Cards, Inset Dividers, Widths, Centering, Tabs,
  Fuzzy Search, the List + edit pattern) live in `src/settings/AGENTS.md` — this section keeps
  only the fleet-wide design law (N1 language, icon mapping, pill taxonomy, destructive/reversible
  rules, row-action-cell law) that every surface must follow, not settings-local mechanics.

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
    settings/           # Settings framework + sections/ per-tab renderers -> has its own AGENTS.md
    triggers/           # triggerAdapter + guardEval (documented in orchestration/AGENTS.md)
    ingestion/          # Ingestion data/render/sections helpers -> has its own AGENTS.md
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
- `console.*` is banned outside `src/log.ts` — **and the gate needs `-a`** (three NUL incidents).
- Obsidian replays `vault.on('create')` for every pre-existing file at startup — side-effecting create listeners register inside `onLayoutReady`.
- `processFrontMatter` silently drops writes against a stale cache — `updateFrontmatter` is the barrier.

**In `src/AGENTS.md`:** see its Quirks index — word-count stripping, `FuzzySuggestModal` close-before-choose, command registration, localize-attachments scope, the localize re-read/write barrier, the content-MD5 hash + ref-rewrite chokepoint, the `data:image` placeholder strip, the empty markdown alt, chain-step internal-command registration, the `mutating`/cycle-guard flag, the `{{input}}`→`{{value}}` alias, the folder-rename link lag, the `vault.rename` attachment-folder fix, the Dataview revision-bump refresh, and the `LINT_STEPS` registry.

**In `src/ingestion/AGENTS.md`:** see its Quirks index — derived ID frontmatter keys, the Orphaned Attachments `_MD5` scan, and the dashboard's dirty-set-flush render pipeline.

**In `src/settings/AGENTS.md`:** see its Quirks index — the `DESTRUCTIVE_ACTIONS`/`confirmDestructive` framework, the AI/Orchestrate renderer split, and the settings-chrome UI standards (Grouped Cards, Widths, Tabs, Fuzzy Search, List+edit).

**In `src/search/AGENTS.md`:** see its Quirks index — container/host, the `MATERIALIZED` CTE + self-migrating FTS schema, the two-plus-one timeout/deadline stack, match-driven latency, the vector leg, `(vault_id, id)` chunk keying, the `embedding_space` guard, quantization, coverage ranking, the entity facet, the query log, linked-post chunks, superseded-search recall, companion deploy, and the `/v1/paths` audit/reconcile pair.

**In `src/orchestration/AGENTS.md`:** see its Quirks index — the durable SQLite queue, the drain-loop wiring pin, scoped registration failure, the legacy queue folder, per-note YT metadata jobs, auto-source/auto-run separation, trigger hardening, blog/YT post-id and video-id canonicalization, the Data API tracker swap, shared intake pure functions, ignored-ID seeding, Triggers-vs-Chains, Daily Brief FX caching, `newJobId` ordering, image-describe failure classes, the `WorkflowResult` union, the X post pipeline, and — moved here in WP-F4 — note-lock reentrancy, `kind::id` resource-lock ordering, the auto-edit-trigger note-lock bail, and the rename-following lock.

**In `src/providers/AGENTS.md`:** LM Studio is `openai-compatible`, not `ollama`; a reranker is not an embedding model (every structural guard passes it); completion-class calls ride a per-provider concurrency limiter — release on settle, local default 1, embed/rerank exempt; every completion call sends `max_tokens` unconditionally; and `src/providerModelContract.ts` is the dependency-free model-ref/binding leaf.

**In `theme/AGENTS.md`:** the surround axis, the (0,1,1) specificity law, the block-1/block-2 name split, exactly four `!important`s, token vendoring.

**In `inference-engine/llama/AGENTS.md`** (own repo, `/home/_shared_code/inference-engine/` — the container graduated out of `docker/llamacpp-vulkan/` on 2026-07-26)**:** a healthy local inference service has told you nothing — `llvmpipe`, arch-list lies, HTTP-200 capability probes.

## Quirks

Non-obvious Obsidian/runtime behaviors that bit us once and would bite again. Add entries here when a fix turned out to hinge on something the API docs don't surface — and add them to the **nearest** `AGENTS.md`, not automatically this one.

- **Shared Claude Code skills (tn-code-review, plan-workflow, tests-lint, project-setup, migrations-release-cleanup) are NOT in this repo.** They live canonically in `/home/_shared_code/context-control/skills/` and are installed machine-wide as symlinks into `~/.claude/skills/` by that repo's `skills/install.sh`. This repo's local `.claude/skills/tn-code-review` copy was deleted in favor of the shared one — if a skill seems missing, re-run `context-control/skills/install.sh` rather than restoring a local copy (local copies drift).

- **Measurement artifacts land in the eval-harness repo (`/home/_shared_code/eval-harness/local-inference-bench/`), never this repo.** `runs/` was scrubbed from this repo's git history on 2026-07-26 (it is public; one sample file carried vault-derived text) and is `.gitignore`d; the archive over there is the source of record for every measured number cited in `docs/local-inference.md` and `docs/search-companion.md`, including the per-claim validity memo. Future measurement runs get a new sibling dir under that archive's `measurements/`.

- **`console.*` is banned in `src/` outside `src/log.ts`.** Crucible keeps the developer console quiet for users by default. Every diagnostic goes through `logWarn` / `logError` from `src/log.ts`, which no-op unless debug output is enabled (`setCrucibleDebug(true)` programmatically, or `window.__CRUCIBLE_DEBUG__ = true` in an installed vault). `grep -rna --include='*.ts' "console\." src/` should match only `src/log.ts` (the `--include` keeps the child `AGENTS.md` docs under `src/` — which mention `console.*` in prose — out of the sweep). Add new diagnostics via the helpers, not raw `console.*`.

  **Use the `-a`.** Without it this gate is not sound: a single NUL byte anywhere in a file makes GNU grep classify it as binary and *silently skip its contents* while still exiting 0, so a `console.*` call in that file passes the gate unseen. This is not hypothetical — `src/fileOpenRanking.ts` shipped a raw NUL in the `createNarrowState` sentinel (`filterSig: '<NUL>'`, written as a literal control character rather than the `'\0'` escape), and an injected `console.log` in that file was confirmed to evade `grep -rn`. The literal was replaced with the two-character escape `'\0'` — identical runtime value, plain-text file — but the gate keeps `-a` so the next stray control byte can't re-blind it. The same NUL also silently breaks any other `grep`-based sweep over `src/`, which is worth remembering when a search "finds nothing" implausibly.

  **It happened a second time, so treat "sentinel string" as the warning sign.** The vector-leg work wrote the vector backend's all-vaults cache key as a literal NUL (`cacheKey = vaultId => … : '<NUL>all'`) in `scripts/search-companion.mjs` — same idea as `filterSig`, same mistake, a different file outside `src/`. Symptom in review: `grep -n "MATERIALIZED" scripts/search-companion.mjs` returned **nothing** on a file that plainly contains it, and `file` reported `binary data` where `git show master:…` of the same file reported `Unicode text, UTF-8`. Note the byte was valid-UTF-8-clean (`raw.decode('utf-8')` succeeded) — only `file`/grep's binary heuristic caught it, so a UTF-8 validity check is not the test. When you need an in-band sentinel that cannot collide with real data, write `'\0'` (two characters) — never paste the control character. When a `grep` over a known-good file implausibly finds nothing, check `file` on it before believing the result.

  **A third one landed in `scripts/dseries-judge.mjs`, and it widens the warning sign from "sentinel" to "any in-band separator".** The first two were explicit sentinel *values*; this one was a **delimiter inside a hash input** — `createHash('sha256').update(\`${seed}<NUL>${queryId}\`)`, where the separator exists so two different `(seed, queryId)` splits cannot collide. Same reasoning, same byte, and it reads as an ordinary space in every diff and review view, so it is *less* visible than the first two rather than more. Two things this instance adds. (1) **The gate is what caught it, not inspection** — `file` reported `a node script executable (binary data)` and `LC_ALL=C grep -caP '\0'` returned 1, in a file that had already been read, linted and smoke-tested clean. Run `file` on every file you created, not only ones you suspect. (2) **The Bash tool refuses a command containing a literal NUL** ("command contains control characters that would be hidden in the approval dialog"), so the fix cannot be a one-liner `node -e` — write a `.mjs` that reconstructs the byte numerically (`String.fromCharCode(0)`) and run that. The correction is always the same: the two-character escape `\0`, never the pasted control character.

- **Obsidian replays `vault.on('create')` for every pre-existing file during startup vault indexing — a side-effecting create listener must register inside `onLayoutReady`, not at `onload`.** Four defenses now share this pattern: `triggers.start()` (the original, documented at its call site in `main.ts`), the search coordinator's readiness gate, the Ingestion dashboard's vault/metadataCache listeners (pf-2 — a dashboard restored in the boot layout used to re-run the two heaviest attachment scans once per second through the whole replay storm; registration now defers to `onLayoutReady` behind an `unmounted` guard, pinned by `tests/ingestionDashboardLayoutReadyGuard.test.mjs`; the plugin-internal `ingestionEvents` bus listeners stay eager on purpose — they are not vault-indexing events), and — vf-1 — the auto-localize create listener, which moved out of the eager `handleFileCreate` path into its own layout-ready-registered `vault.on('create')` after the replay storm re-scheduled localize over every already-localized note on each restart. That mattered because the localizer's already-localized branch still calls the image-describe enqueue hook, and queue dedupe is active-jobs-only — so every restart minted ~50–105 duplicate `image_describe_note` jobs (verified against the live jobs.sqlite; the same note re-enqueued ×8 across restarts). The second layer: `enqueueImageDescribeForNote` now consults `isImageAlreadyDescribed` (`imageDescriptions.has()` — described AND durable `kind:'failed'` poison-skip records both count) before minting, with a fire-and-forget `ensureLoaded()` kick at onload so the store's in-memory index is warm before the earliest possible enqueue (2500ms after layout-ready). The eager create listener stays only for consumers that self-guard (materialize acts on empty files only; the search/file-open indexes gate on their own readiness). Registration placement is pinned by source-text tests in `tests/autoLocalizeCreateReplayGuard.test.mjs` — if you add another create-driven side effect, register it layout-ready or give it a real readiness gate.

- **`fileManager.processFrontMatter` silently drops the value write when the metadata cache is stale — which it is right after a rename + rapid edit.** `processFrontMatter` merges the callback's mutations against `metadataCache.getFileCache(file).frontmatterPosition`, not the raw content. When the cache hasn't re-indexed the current bytes — e.g. the "Ingest as News" chain runs `move-current-file-to-daily-folder` then `lint-note` immediately after the web clipper wrote the note in staged bursts — the position is stale, so the merged frontmatter is written to the wrong byte range and the value is lost. Symptom that cost a long hunt: lint computed `word-count 380`, the callback's `fm['word-count']` *was* 380, yet the on-disk value came back empty; running `Lint: all` again seconds later worked only because the cache had settled (that was the user's standing workaround). The tell is that `processFrontMatter`'s own resulting `modify` event shows the value already wrong — no later clobber involved. The canonical fix is the **write-consistency barrier inside `updateFrontmatter`** (`src/frontmatter.ts`) — the chokepoint every frontmatter write must go through. Before calling `processFrontMatter` it compares the cache's `frontmatterPosition` end offset and key set against the actual block in the raw content; when they disagree it awaits the file's next `metadataCache.on('changed')` (bounded, ~2s — the write-side mirror of `TriggerRegistry.waitForConsistentCache`), and on timeout it warns, writes anyway, and verifies the mutated keys landed via a raw re-read (escalating the log if not). So: route every frontmatter write through `updateFrontmatter` and the race is handled for free — do **not** add per-key content-based reasserts (the old `setFrontmatterWordCount` workaround was deleted; its `String.replace` rebuild also corrupted empty frontmatter blocks). If a content-based `vault.process` fallback is ever genuinely needed, it must splice by index, never `String.replace(block, …)`. A separate belt-and-suspenders lives in `ChainManager.reconcileOpenEditor`: after a chain that moves-then-mutates a note, it forces any open editor leaf's buffer to match disk (`setViewData`) so a stale editor autosave can't clobber the chain's writes — relevant when the note *is* open (the clipper case leaves it closed, so that path is a no-op there).
