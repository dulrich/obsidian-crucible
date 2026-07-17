# WP-R2 Report — Secret-store facade: registry bookkeeping at the canonical layer

## Files touched

- `src/secretRegistry.ts` — facade (`get`/`store`/`clear`) added to `SecretRegistry`; `reconcile()` hardened against clear-by-empty.
- `src/providers.ts` — `ProviderManager` routes `loadApiKey`/`storeApiKey`/`deleteApiKey` through the facade; constructor now takes a `SecretRegistry`.
- `src/orchestration/utils/youtubeApi.ts` — `loadYoutubeApiKey`/`storeYoutubeApiKey`/`deleteYoutubeApiKey` now take `plugin: CruciblePlugin` and route through `plugin.secretRegistry`; the two internal callers (`ensureMetadataNote`, `ensureChannelAboutNote`) updated to pass `plugin`.
- `src/settings/sections/ai.ts` — removed `record`/`forget` closure wiring from both provider `mountSecretControl` sites; extracted the twice-copy-pasted block into `mountProviderApiKeyControl`.
- `src/settings/sections/orchestration.ts` — removed `record`/`forget` closure wiring from the YouTube key `mountSecretControl` site; call sites updated to the new `(plugin, ...)` signature.
- `src/main.ts` — construction order swapped so `SecretRegistry` is built before `ProviderManager` and passed into it.
- `tests/secretRegistry.test.mjs` — 6 new tests (below).

`src/settings/shared.ts` was **not** touched — `mountSecretControl`'s options shape (`load`/`store`/`clear`/`expectedButMissing`) didn't need to change; the closures just got thinner (no more manual `record`/`forget` calls).

## Facade's final public API

On `SecretRegistry` (`src/secretRegistry.ts`), alongside the pre-existing `isRegistered`/`record`/`forget`/`reconcile`:

```ts
async get(key: string): Promise<string>
async store(key: string, value: string): Promise<void>  // empty value ⇒ delegates to clear()
async clear(key: string): Promise<void>                  // writes '' via setSecret, then forget()
```

These are the only code in the plugin that touches `app.secretStorage` — the sync-or-Promise `await` handling and the `secretStorage` null-guard live here and only here (grep: `secretStorage` appears in `src/secretRegistry.ts` and its type declaration only).

## Decisions and deviations

- **`youtubeApi.ts` key helpers take `plugin` instead of `app`.** The brief's scope line only said "route... through it"; taking `app` and reaching for a facade would need a second `plugin` param anyway since the facade lives on the plugin, so I changed the signature to take `plugin` directly (both call sites already had `plugin` in scope, and `settings/sections/orchestration.ts` already had `tab.plugin`). This is a signature change to non-exported-elsewhere internal helpers, not to `ProviderManager`'s public API, which the brief pinned as stable.
- **`ai.ts` provider `Provider`/`ProviderManager.loadApiKey` public signature**: unchanged, per the brief. Only the constructor of `ProviderManager` gained a second parameter (`secrets: SecretRegistry`), which is construction-site wiring, not a call-site-facing signature.
- **Circular import avoided via `import type`.** `providers.ts` needs `SecretRegistry`'s type but `secretRegistry.ts` already imports a value (`providerSecretKey`) from `providers.ts`. Used `import type { SecretRegistry } from './secretRegistry'` in `providers.ts` so the type import is erased at compile time and there's no runtime cycle.
- **Reconcile hardening probes `getSecret` per listed crucible key.** Per the plan's stated assumption ("`getSecret` probing during reconcile is acceptable at startup cost"), `reconcile()` now calls `storage.getSecret(key)` for every `crucible-`-prefixed key `listSecrets()` returns, and only keeps it as "present" if the value is non-empty. `computeReconcile`'s pure signature is unchanged (it already took a `present` keys list — the change is what `reconcile()` feeds into it), so all 5 pre-existing tests against it still pass unmodified.
- **`mountProviderApiKeyControl` helper** extracted into `ai.ts` near `renderProviderModelsList`; takes `{ name, desc }` for the two label variants (required vs. optional key) since that was the only difference between the two copy-pasted blocks.

Nothing was deferred.

## How each defect is now impossible

1. **`deleteProvider` never forgot the key (`ai.ts:87`, historical).** `deleteProvider` calls `tab.plugin.providerManager.deleteApiKey(provider.id)` (`ai.ts:94`, unchanged call site), which now (`providers.ts:44-46`) calls `this.secrets.clear(providerSecretKey(providerId))`, and `SecretRegistry.clear` (`secretRegistry.ts:128-132`) unconditionally calls `forget(key)` after writing `''`. There is no code path to clear a provider's key that skips `forget` — `deleteApiKey` has no other implementation.
2. **Bookkeeping wired in three `mountSecretControl` closures.** All three closures now call only `providerManager`/`loadYoutubeApiKey` etc., not `secretRegistry.record`/`forget` directly — verified by `grep -rn "secretRegistry\.\(record\|forget\)(" src` returning nothing outside `secretRegistry.ts` itself. `record`/`forget` are called from exactly two places: `SecretRegistry.store` (`secretRegistry.ts:112`) and `SecretRegistry.clear` (`secretRegistry.ts:131`) — the facade methods that `ProviderManager` and the YouTube helpers now route through. Any future store/clear call site gets bookkeeping for free by construction; it cannot be skipped without bypassing the facade entirely (which would also mean bypassing the `secretStorage` null-guard and sync/Promise handling).
3. **Clear-by-empty + `listSecrets()` re-registering cleared keys.** `SecretRegistry.reconcile()` (`secretRegistry.ts:73-105`) now calls `storage.getSecret(key)` for each listed `crucible-` key and only includes it in `present` when the value is truthy (`secretRegistry.ts:92-99`); a listed-but-empty key is therefore treated identically to an absent key — it doesn't grow the registry by observation and doesn't count as present for missing-key warnings. Test: `reconcile treats a listed-but-empty key as absent: no re-register, no false report` (`tests/secretRegistry.test.mjs`).

## Gates (verbatim tails)

### `npm run lint`
```
> obsidian-crucible@1.0.0 lint
> eslint . && stylelint "**/*.css"
```
(exit 0, no findings)

### `npx tsc -noEmit -skipLibCheck`
```
(no output — exit 0)
```

### `npm test`
```
✔ modify and metadata-changed use cache-ready snapshots but remain debounced (0.238888ms)
✔ youtube metadata enriched waits for cache when metadata is not indexed yet (0.170096ms)
✔ rename remains immediate because metadataCache.changed is not emitted for renames (0.127905ms)
✔ targetPath present → key is note:<targetPath> (0.634656ms)
✔ no targetPath, videoId present → key is video:<videoId> (0.115762ms)
✔ empty params → empty string (no dedupe key) (0.076697ms)
✔ two params with same videoId but different targetPaths produce different keys (per-note jobs both enqueue) (0.096866ms)
ℹ tests 219
ℹ suites 0
ℹ pass 219
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 271.755797
```
Baseline was 213/213; this run is 219/219 (the 6 new `tests/secretRegistry.test.mjs` cases: facade store records / facade clear forgets, empty-value store clears instead of recording, deleted-provider clear → reconcile reports nothing missing, listed-but-empty key treated as absent on reconcile, reconcile still grows-by-observation/reports-missing for genuinely present/absent keys, facade `get` returns `''` when `secretStorage` is unavailable).

### `node esbuild.config.mjs production`
```
(no output — exit 0)
```

## Deferred

Nothing deferred from this WP's scope.

---

Orchestrator: review the diff and re-run gates before commit.
