# Context

Implement the backlog of tasks from `plans/next-tasks.md`, batched into logical groups with review checkpoints after each. The batches are ordered: quick wins first, then UI polish, then chain infrastructure (prerequisite for the Refine workflow), the Refine workflow itself, and finally dev observability tooling.

---

# Batch 1 — Quick Wins (3 isolated features)

**Goal:** Three independent, low-risk additions. Checkpoint after all three.

### 1a. Duplicate Chain
- **File:** `src/settings.ts` — chain list section (~line 296-329)
- Add a "Duplicate" button alongside the existing edit/delete buttons
- Create a deep copy of the chain with name `"<original> (copy)"` and push to `settings.chains`
- Save settings and re-render the list

### 1b. Copy Current Note — Internal Command
- **File:** `src/main.ts` — internal command registration block (~line 338-427)
- Register `crucible:copy-active-file` using `registerInternalCommand`
- Command reads active file content (`app.vault.read(activeFile)`) and writes it to clipboard via `navigator.clipboard.writeText()`
- Schema: no args required

### 1c. Agent Running Spinner UI
- **File:** `src/agents.ts` — `executeAgent()` (~line 72)
- Replace the fire-and-forget `new Notice(...)` with a persistent Notice that stays visible for the duration of the API call, then dismisses on success or shows an error
- Use `notice.noticeEl.setText(...)` to update message, or pass `0` duration to `new Notice()` and `.hide()` it in the finally block

---

# Batch 2 — UI/UX Polish (2 independent UI changes)

**Goal:** ToC navigation controls and Commands visibility split. Checkpoint after both.

### 2a. ToC: Jump to Top / Bottom Controls
- **Files:** `src/toc.ts`, `src/types.ts`
- Add two small buttons (↑ top, ↓ bottom) to the ToC footer or as a separate control strip
- On click: call `leaf.view.setEphemeralState({ scroll: 0 })` (top) and `{ scroll: contentEl.scrollHeight }` (bottom)
- Optionally add a `ToCShowJumpControls: boolean` setting (default true) in `CrucibleSettings`

### 2b. Commands: Two-Toggle Visibility (CP vs Chain Search)
- **Files:** `src/types.ts`, `src/settings.ts`, `src/main.ts`, `src/agents.ts`
- Current: single `hiddenCommands: string[]` hides from everywhere
- Change to two sets: `hiddenFromPalette: string[]` and `hiddenFromChainSearch: string[]` (or keep `hiddenCommands` for palette and add `hiddenFromChainSearch`)
- Settings UI: show two toggles per command — "Show in Command Palette" and "Show in Chain Search"
- Chain step command dropdown (`settings.ts` ~line 388): filter using `hiddenFromChainSearch` instead of `hiddenCommands`
- Obsidian command registration: continue using `hiddenFromPalette` to suppress from palette

---

# Batch 3 — Chain Infrastructure (prerequisite for Refine)

**Goal:** Chain variables + guard steps. These unlock the Refine workflow. Checkpoint after both.

### 3a. Chain-Level Variable Substitution
- **Files:** `src/types.ts`, `src/chains.ts`, `src/settings.ts`
- Add `variables?: Record<string, string>` to the `Chain` interface (`types.ts:76`)
- In `ChainManager.executeChain()` (`chains.ts`), interpolate `{{varName}}` in step args before execution (after `{{response}}` substitution)
- Settings UI: add a variable table to the chain editor (key/value rows, add/delete)
- Also expose resolved agent model as a built-in chain variable `{{agent_model}}` after an agent step — set by `AgentManager.executeAgent()` returning an object `{ response: string, model: string }` instead of bare string, and having `ChainManager` extract and store it

### 3b. Chain: Guard Step (Tag / Property Check)
- **Files:** `src/types.ts`, `src/chains.ts`, `src/settings.ts`
- Add `stepType?: 'command' | 'guard'` to `ChainStep`
- Add guard config: `guardCondition?: { type: 'has-tag' | 'has-property' | 'property-equals', tag?: string, property?: string, value?: string }`
- In `ChainManager.executeStep()`: if `stepType === 'guard'`, read active file frontmatter/tags and evaluate condition; return `false` (stops chain unless `keepGoing`) if condition fails
- Settings UI: when command dropdown is set to a guard sentinel value, show condition builder UI (type selector + tag/property inputs)

---

# Batch 4 — Refine Transcript Workflow

**Goal:** Full "Refine Transcript" agentic chain (per `plans/agentic-workflows.md`). Depends on Batch 3.

### 4a. Refine Background Note Targeting
- **Files:** `src/chains.ts`, `src/agents.ts`, `src/main.ts`
- When a chain is triggered from a command, capture the active file at the moment of invocation and store it as chain execution context
- Pass this context through to each step so that agent prompts and capture targets refer to the originating note, not whatever becomes active during async execution
- `ChainManager.executeChain()` should accept an optional `targetFile: TFile` parameter; propagate it to `executeStep()` and into internal command args as `{{target_file}}` / `{{target_path}}`

### 4b. Refine Transcript Steps (via Chain configuration, no new code needed beyond 4a)
- Copy note → `_raw_transcript` folder (new internal command: `crucible:copy-note-to-folder`)
- Set frontmatter `raw-transcript` property (use existing `upsert-property` internal command)
- Run configured Refine agent with `{{input}}` = note body (agent step)
- Replace note body with `{{response}}` (new internal command: `crucible:replace-note-body`)
- Run lint
- Add `#refined` tag (use `upsert-tags`)
- Set `model` property to `{{agent_model}}` (use `upsert-property` + chain variable from 3a)

---

# Batch 5 — Debugging & Observability (dev tooling)

**Goal:** Three debugging patterns from `plans/debugging.md`. These are independent of Batches 1-4.

### 5a. Chain Tracing / Debug Mode
- Add `debugMode: boolean` toggle to `Chain` (or global setting)
- When enabled, after each step append `[Step ID] input: ... output: ...` to a "Crucible Debug Log" note (configurable path, default `_crucible/debug.md`)

### 5b. Dry Run / Chain Inspector
- Add a "Preview" button to the chain editor that runs the chain in dry-run mode
- In dry run: resolve all templates/variables, show a modal with each step's resolved system prompt and user prompt — but make no API calls and no writes

### 5c. Intermediate State Capture
- Add `captureIntermediate?: boolean` to `ChainStep`
- When enabled, write `{{response}}` value to a temporary note (`_crucible/step-<name>-output.md`) after the step completes
- Settings UI: per-step toggle

---

# Critical Files

| File | Relevance |
|---|---|
| `src/agents.ts` | Spinner UI, agent model exposure for chain variables |
| `src/chains.ts` | Variable substitution, guard steps, target file context, debug mode |
| `src/toc.ts` | Jump controls |
| `src/types.ts` | All new interface fields |
| `src/settings.ts` | All new settings UI |
| `src/main.ts` | New internal commands, command registration |
| `plans/debugging.md` | Spec for Batch 5 |
| `plans/agentic-workflows.md` | Spec for Batch 4 |

---

# Reusable Patterns

- `registerInternalCommand(id, fn, schema)` — `src/chains.ts:15` — use for all new internal commands
- `applyTemplateString(template, now, fileName, value)` — `src/utils.ts` — use for variable interpolation
- `upsert-property`, `upsert-tags` internal commands — `src/main.ts` — reuse in Refine chain steps
- `hiddenCommands` filtering pattern — `src/main.ts:51` — extend for two-toggle

---

# Verification

After each batch:
1. `npm run build` — confirm no TypeScript errors
2. Load plugin in Obsidian dev vault, exercise the new feature manually
3. Check that existing captures, linting, and command palette behavior are unaffected

Batch 3 specifically: manually build a chain with a variable and a guard step, confirm the guard halts and resumes correctly with `keepGoing`.

Batch 4: run the full Refine chain on a test transcript note and verify all 7 steps complete, `model` property is set, and `#refined` tag is present.
