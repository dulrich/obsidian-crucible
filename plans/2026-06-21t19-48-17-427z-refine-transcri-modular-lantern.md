# Plan: Support LM Studio via a new `openai-compatible` provider kind

## Context

The **Refine Transcript (Local)** chain fails with:

> Agent "Transcript Refiner (Local)" … provider "Local LM Studio" model "google/gemma-4-12b" finished with non-normal reason "missing" (normalized: unknown; partial response length: 0).

**Root cause:** the "Local LM Studio" provider (`data.json`, id `kdus4z0`) is configured as `kind: "ollama"` with `baseUrl: http://127.0.0.1:1234`. The Ollama client (`src/providers/ollama.ts:19`) POSTs to `…/api/chat` using Ollama's **native** API. LM Studio is **OpenAI-compatible** — it serves `/v1/chat/completions`, not `/api/chat`. The mismatched response carries no `message.content` and no `done_reason`, so the client yields empty text + `rawFinishReason = undefined` → `normalizeOllamaFinishReason` returns `'unknown'` → the strict `enforceNormalFinishReason` guard (`src/agents.ts:114`) throws the `missing / unknown / length 0` error.

Neither existing kind can currently reach a local OpenAI-compatible server:
- `openai` kind hardcodes `https://api.openai.com/v1/chat/completions` in `complete()` (`src/providers/openaiCompatible.ts:41`) and ignores `provider.baseUrl`.
- `httpContext` (`src/providers.ts:99`) requires a non-empty API key for every non-`ollama` kind.

**Intended outcome:** add a dedicated **OpenAI-Compatible (Local)** provider kind that honors `baseUrl`, treats the API key as optional, and exposes a Server URL field in settings. This covers LM Studio plus llama.cpp server, vLLM, LocalAI, etc. The strict finish-reason check stays as-is (a well-formed LM Studio response returns `finish_reason: "stop"` and passes).

## Changes

### 1. Register the new kind — `src/types.ts`
- Add `'openai-compatible'` to the `ProviderKind` union (~lines 209–218).
- Add `'openai-compatible'` to `API_PROVIDER_KINDS` (line 220). `providerModality()` derives `'api'` from this list, so no other change is needed there.

### 2. Label — `src/settings/shared.ts`
- Add to `PROVIDER_KIND_LABELS` (lines 15–25): `'openai-compatible': 'OpenAI-Compatible (Local)'`.

### 3. Client registry + optional key — `src/providers.ts`
- In `HTTP_PROVIDER_CLIENTS` (lines 18–24) add `'openai-compatible': openAICompatibleClient`.
- In `httpContext()` (lines 97–103) keep loading any optionally-stored key, but do **not** require one for `openai-compatible`:
  - `const apiKey = provider.kind === 'ollama' ? '' : await this.loadApiKey(provider.id);`
  - Change the missing-key guard to skip both `ollama` **and** `openai-compatible`.

### 4. Make the OpenAI-compatible client baseUrl-aware + optional auth — `src/providers/openaiCompatible.ts`
- Add `isLocal(provider) => provider.kind === 'openai-compatible'`.
- `apiBaseUrl()` (lines 28–31): add a local fallback `http://localhost:1234/v1` (vendor defaults for `openai`/`openrouter` unchanged).
- `complete()` (lines 37–68):
  - Replace the hardcoded URL (line 41) with `` `${apiBaseUrl(ctx.provider)}/chat/completions` ``. This is **behavior-preserving** for `openai`/`openrouter` when `baseUrl` is empty (the fallback returns the same vendor URLs), and additionally honors a configured `baseUrl`.
  - Pin `temperature: 0.7` only for the OpenAI vendor (`ctx.provider.kind === 'openai'`); leave it to the model default for local (matching the OpenRouter treatment).
- `authHeaders()` (lines 33–35): only include `Authorization` when `ctx.apiKey` is non-empty (safe for `openai`/`openrouter`, which always have a key).
- `label()` (lines 22–24): return `"Local"` for `openai-compatible` so error/response messages read sensibly.
- Update the stale comment at lines 26–27 (completion no longer uses a fixed vendor URL).

### 5. Settings UI — `src/settings/sections/ai.ts`
- In `renderEditProvider` (lines 130–150), add an `else if (provider.kind === 'openai-compatible')` branch between the `ollama` and the generic API-key branch that renders:
  - A **Server URL** text field bound to `provider.baseUrl`, placeholder `http://localhost:1234/v1`, desc noting the URL must include the API base path (e.g. `/v1` for LM Studio).
  - An **optional** API Key secret control (reuse `mountSecretControl`, desc: optional — only needed for servers that require a key, e.g. vLLM started with `--api-key`).

### 6. User-side reconfiguration (no code; done in the Crucible settings UI after the build)
- Edit the **Local LM Studio** provider: set **Kind** → *OpenAI-Compatible (Local)*, **Server URL** → `http://127.0.0.1:1234/v1`.
- Optional cleanup: the `Transcript Refiner (Local)` agent has a stale top-level `providerId: "usbvs24"` (OpenRouter) + `allow` list that are inert in `pinned` mode but misleading.

## Files
- `src/types.ts` — new kind + API_PROVIDER_KINDS
- `src/settings/shared.ts` — label
- `src/providers.ts` — registry + optional-key
- `src/providers/openaiCompatible.ts` — baseUrl-aware URL, optional auth, temperature/label
- `src/settings/sections/ai.ts` — Server URL + optional key UI
- `AGENTS.md` `## Quirks` — note that `openai-compatible` `baseUrl` must include the API base path (`/v1`), and that LM Studio uses the OpenAI-compatible API (not Ollama's `/api/chat`).

## Verification
1. `npm run build` (or the repo's typecheck/build script) — confirm no TypeScript errors.
2. Confirm LM Studio is reachable directly:
   `curl http://127.0.0.1:1234/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"google/gemma-4-12b","messages":[{"role":"user","content":"ping"}]}'` → expect a JSON body with `choices[0].message.content` and `choices[0].finish_reason: "stop"`.
3. In Obsidian, reconfigure the provider per step 6, then run the **Refine Transcript (Local)** chain on a transcript note → expect refined text written and **no** "non-normal reason" error.
4. Regression: an existing `openai` (and/or `openrouter`) provider with no `baseUrl` set still completes against the vendor endpoint (URL fallback unchanged).

## Notes
- Per repo convention, copy this plan into `<repo>/plans/` before implementing.
- The strict `enforceNormalFinishReason` guard is intentionally left unchanged.
