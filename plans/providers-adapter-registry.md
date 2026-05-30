# Providers adapter registry

> Part 3 of 6 of the architectural cruft sweep. Independent — can run standalone.
> Behavior-preserving refactor only.

## Context

`src/providers.ts` is **981 lines** (just under the 1k smell threshold) and runs two parallel
per-provider `switch` ladders. Adding or changing a provider means editing several switches in
lockstep.

## Verified current shape (re-read before starting)

- `ProviderManager` (class at 47). HTTP dispatch `switch(provider.kind)` (85): `openai`, `anthropic`,
  `google`, `openrouter`, `ollama` → five near-identical `call*` methods (each: fetch → parse →
  `normalize*FinishReason`).
- Finish-reason normalizers, each a `switch`: `normalizeRawFinishReason` (340, shared),
  `normalizeChatCompletionFinishReason` (346, used by openai + openrouter + ollama-ish),
  `normalizeAnthropicFinishReason` (361), `normalizeGoogleFinishReason` (374),
  `normalizeOllamaFinishReason` (390).
- CLI dispatch: `kind → label` switch (401), then `buildCliInvocation` (426) `switch(p.kind)` →
  `buildClaudeInvocation`, `buildCodexInvocation`, `buildGeminiInvocation`, `buildOpencodeInvocation`
  (near-identical arg-builders).

## Target structure

```ts
interface ProviderAdapter {
  complete?(opts): Promise<...>;            // HTTP request + response parse
  buildCliInvocation?(p): CliInvocation;    // CLI arg builder
  finishReasonMap: Record<string, ProviderFinishReason>;  // replaces the normalize* switches
}
const registry = new Map<ProviderKind, ProviderAdapter>([...]);
```

- `ProviderManager.complete` → `this.registry.get(kind).complete(...)`. Both switches disappear.
- Replace each `normalize*FinishReason` switch with a `Record<string, ProviderFinishReason>` lookup;
  keep the single shared `normalizeRawFinishReason` for pre-cleaning the raw value.
- **Collapse the chat-completion shape:** openai / openrouter / ollama share the chat-completion request
  + response structure — implement ONE chat-completion adapter parameterized by endpoint/auth/model
  instead of three copies. anthropic and google keep dedicated adapters.
- Split adapters into `src/providers/adapters/{chatCompletion,anthropic,google,cli}.ts` if the registry
  file would otherwise approach 1000 lines.

## Steps

1. Define `ProviderAdapter` + the registry.
2. Port each `call*` into its adapter's `complete`; fold openai/openrouter/ollama into the shared
   chat-completion adapter.
3. Convert the four `normalize*FinishReason` switches into per-adapter `finishReasonMap` lookups.
4. Port the four `build*Invocation` builders into adapter `buildCliInvocation` methods; delete both
   CLI switches.
5. Reduce `ProviderManager` to registry lookups. Confirm no file is over 1000 lines.

## Guardrails

- No file over 1000 lines.
- Exact same request payloads, headers, and finish-reason mappings as before (these are observable).
- Don't introduce a thin adapter that only forwards — only split where it removes duplication.

## Verification

- `npm run build` clean; `npm run lint` clean.
- Exercise one HTTP provider and one CLI provider (model picker / a chain run); confirm completions
  succeed and finish-reason values are unchanged.
