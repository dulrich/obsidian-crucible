# Decouple Provider, Modality, and Model in Crucible:AI

## Context

Crucible's current `Provider` (`src/types.ts:105-111`) conflates a service connection with a single model: every API call reads `provider.model` directly (`src/providers.ts:60, 89, 110, 149, 176`), and every `Agent` is bound to exactly one Provider via `providerId` (`src/types.ts:130`). This forces users into duplicate `Provider` entries per model (`data.json:210-228` shows three OpenRouter providers, one per model) and prevents any of the new features the orchestrator needs:

- Selecting a model at run time, or letting an Agent constrain a list of acceptable models.
- Driving model choice from a Chain variable (e.g. `{{model}}`), so the same agentic workflow can be rerun against different models without editing the agent.
- Invoking a CLI tool (Gemini CLI, Claude Code CLI, future codex/other) instead of an HTTP API — currently impossible because `ProviderManager` only knows HTTP (`src/providers.ts:35-48`).

This refactor splits the conflated concept into three layers — **Provider** (credentials or CLI config), **Modality** (API vs CLI, implied by Provider kind), **Model** (configured per-Provider) — and threads model selection through Agents and Chains. v1 ships a working **Gemini CLI** provider as the reference for the CLI modality. The plugin is pre-alpha; no migration code is included and existing `data.json` provider/agent entries will need to be recreated.

## Conceptual Model

```
Provider
  ├── id, name
  ├── kind: 'openrouter' | 'anthropic' | 'openai' | 'google' | 'ollama' | 'gemini-cli'
  │     (kind implies modality: 'api' for the first five, 'cli' for gemini-cli)
  ├── (api kinds)  baseUrl?  + secret-store API key
  ├── (cli kinds)  command, extraArgs, cwd, env overrides
  └── models: ProviderModel[]
        ├── id      (e.g. "openai/gpt-4o", "gemini-2.5-pro")
        └── label   (display name; falls back to id)

Agent
  ├── id, name, prompts (unchanged: text-or-file system + user)
  └── modelBinding:
        ├── mode: 'pinned' | 'constrained' | 'runtime'
        ├── pinned       → { providerId, modelId }
        ├── constrained  → { allow: { providerId, modelId }[] }   // user picks at invoke time from this list
        └── runtime      → {} (full picker over all configured Provider×Model pairs)

Chain step (calling an agent)
  ├── args.input        (existing)
  └── args.model        (NEW, optional) — string of form "providerId:modelId"
                         When present, overrides the agent's binding for that invocation.
                         Goes through the existing {{var}} substitution path,
                         so users can write   model = "{{router_model}}"   and drive it from chain.variables.
```

Precedence at agent invocation time:
1. If `args.model` resolves to a non-empty `providerId:modelId` and is allowed by the agent's mode → use it.
2. Else use the agent's pinned binding.
3. Else (constrained / runtime with no override) → open a model picker modal.
4. Output `chainVars.agent_model` and a new `chainVars.agent_provider` after the call (extends `src/chains.ts:53-56`).

## Files to Modify

### `src/types.ts` — schema
- Replace `LlmProviderType` with `ProviderKind` covering the API kinds plus `gemini-cli`. Export a derived `providerModality(kind): 'api' | 'cli'` helper.
- Replace `Provider` with the new shape above. Drop top-level `model`. Add `models: ProviderModel[]` and CLI-specific fields (`command`, `extraArgs`, `cwd`).
- Add `ProviderModel { id: string; label: string }`.
- Replace `Agent.providerId` with `modelBinding: AgentModelBinding` (discriminated union by `mode`).
- Update `CrucibleSettings` defaults and bump no version key (pre-alpha, no migration).

### `src/providers.ts` — execution layer
- Change `complete()` signature to `complete(provider: Provider, modelId: string, system: string, user: string)`. Branch on `providerModality(provider.kind)`:
  - **API path** keeps the existing five kind-specific handlers but reads the `modelId` argument instead of `provider.model`. Each handler trimmed to the actual API differences; `baseUrl` survives only on Ollama.
  - **CLI path** new: `callGeminiCli(provider, modelId, system, user)`. Uses Node's `child_process.spawn` (available inside Obsidian's Electron renderer; no extra dep). Default command `gemini`, default args `['-m', modelId, '-p', '<combined-prompt>']`, with system+user concatenated as `"<system>\n\n<user>"` (Gemini CLI takes a single `-p` prompt). Capture stdout, surface stderr on non-zero exit, enforce a configurable timeout (default 120s).
- Keep API-key secret storage paths identical (`providerSecretKey`, `loadApiKey`, etc.); CLI providers skip key loading.

### `src/agents.ts` — model binding + runtime resolution
- Add `resolveModel(agent, args, settings): Promise<{ provider: Provider; modelId: string }>` that implements the precedence above. Returns the chosen pair or throws if nothing valid is available.
- Update `executeAgent()` to call `resolveModel`, then `providerManager.complete(provider, modelId, system, user)`. Return `{ response, model: modelId, provider: provider.id }`.
- Add `ModelPickerModal` (new file `src/modelPicker.ts`, modeled on `src/folderPicker.ts:1-...` for visual consistency and `FuzzySuggestModal` ergonomics — verify `folderPicker.ts` pattern before writing). Surface options as `<provider name> · <model label>`.
- The `AGENT_INPUT_SCHEMA` (`src/agents.ts:9-16`) gains an optional `model` arg of type `text` so chain editors see and can fill it.

### `src/chains.ts` — variable plumbing
- After `AgentResult` unwrap (`src/chains.ts:52-59`) also expose `chainVars.agent_provider` so downstream steps can branch on which provider produced the response.
- No change to substitution itself — `args.model` already flows through the existing `{{var}}` loop (`src/chains.ts:136-145`).

### `src/settings.ts` + `src/settingsView.ts` — UI
Provider editor (replacing `src/settings.ts:851-924`):
- Kind dropdown lists API kinds + `Gemini CLI`. Switching kind reveals only the relevant fields.
- API kinds: name, baseUrl (Ollama only), API key field.
- CLI kinds: name, command (default `gemini`), extra-args text field, cwd (optional, file-picker-style folder input — reuse `FolderSuggest` from `src/folderPicker.ts`).
- New **Models** sub-section per provider: list of `{id, label}` rows with add/remove buttons. Empty placeholder text for each kind (e.g. `gpt-4o`, `gemini-2.5-pro`, `anthropic/claude-3.5-sonnet`).

Agent editor (replacing `src/settings.ts:996-1128` provider dropdown block):
- Mode dropdown: Pinned / Constrained / Runtime pick.
- Pinned: two cascading dropdowns — Provider → Model (filtered to that provider's `models[]`).
- Constrained: multi-select list of `(provider, model)` pairs across all configured providers; renders as removable chips.
- Runtime: no extra fields; descriptive helper text only.
- Prompt editors and the rest of the agent UI are unchanged.

### `src/main.ts` — wiring
- No structural change beyond the new `Provider` shape flowing through. Confirm `registerAgents()` still works with the updated `executeAgent` signature.

### `src/orchestration/workflows/*` — sanity check only
- Workflows do not call providers directly today (`src/orchestration/Orchestrator.ts:58-94` dispatches to workflow classes; only the planned Transcript Refiner delegates to `chainManager.executeChain`). No edits required, but re-read after refactor to confirm.

## Reuse / Existing Patterns

- `applyTemplateString` (`src/utils.ts`) already handles `{{datetime:*}}`, `{{title}}`, `{{input}}`, etc. — the new `args.model` flows through the same path; no new template machinery needed.
- `FileSuggest` / folder picker pattern from `src/folderPicker.ts` is the model for `ModelPickerModal`.
- Secret storage helpers in `src/providers.ts:13-27` stay as-is.
- The chain-var substitution loop at `src/chains.ts:136-145` already handles `{{model}}` overrides — only the var contents change.

## Out of Scope (explicit follow-ups)

- Claude Code CLI provider, codex CLI, additional CLI kinds — schema supports them; ship them as separate plans.
- Streaming responses (current API path is non-streaming; CLI path will be one-shot too).
- Per-model parameters (temperature, max_tokens) on `ProviderModel` — possible later; v1 keeps the existing per-handler defaults.
- Migration of existing `data.json` provider/agent entries — pre-alpha, recreate.

## Verification

1. **Build & typecheck**
   - `npm run lint`
   - `npx tsc -noEmit -skipLibCheck`
   - `node esbuild.config.mjs production`

2. **Provider settings UI (manual in Obsidian)**
   - Add an API provider (OpenRouter), give it two models, save.
   - Add a CLI provider (Gemini CLI), set command + args, save.
   - Confirm provider list renders both with kind-appropriate descriptions.

3. **Agent settings UI**
   - Pinned-mode agent → run as a chain step, confirm it uses the configured (provider, model).
   - Constrained-mode agent (allowlist of 2 OpenRouter models) → invoke directly via command palette, confirm `ModelPickerModal` opens and lists exactly the 2 allowed entries.
   - Runtime-mode agent → invoke directly, confirm picker shows all configured Provider×Model pairs.

4. **Chain override**
   - Build a chain with a single step calling an agent, where `args.model = "{{router_model}}"` and `chain.variables.router_model = "<openrouterProviderId>:openai/gpt-4o"`.
   - Run chain, confirm the agent calls OpenRouter with `gpt-4o` regardless of the agent's pinned default.
   - Confirm chain inspector preview (`previewChain`, `src/chains.ts:199-226`) shows the resolved `model` value.

5. **CLI modality end-to-end**
   - With Gemini CLI installed locally and `gemini -p "ping"` working from a terminal, run a chain step that calls a Gemini-CLI-pinned agent.
   - Verify response appears in the chain output and `chainVars.agent_model` / `chainVars.agent_provider` reflect the CLI provider.
   - Force a failure (bad command path) and confirm the error surfaces via `Notice` and stops the chain when `keepGoing` is false.

6. **Negative paths**
   - Agent with constrained mode but empty allowlist → invoke direct, expect a clear error rather than silent fallback.
   - Chain step with `args.model` pointing at a non-existent provider/model → expect an error before any HTTP/CLI call.
