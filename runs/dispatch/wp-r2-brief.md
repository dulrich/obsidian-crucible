# WP-R2 Execution Brief — Secret-store facade: registry bookkeeping at the canonical layer

## Mission

You are an implementation worker for the obsidian-crucible Obsidian plugin, working
directly in the repo at `/home/_shared_code/obsidian-crucible` on branch `master`. Your
work package is **WP-R2** of the committed plan
`plans/tn-review-remediation-2026-07-17.md` — read that plan's WP-R2 section and its
Findings item 3 first, then this brief. You implement, verify, and write a report; you do
not commit.

## Hard constraints — violating any of these voids the work

- **Never commit or push.** Leave all changes uncommitted in the working tree. The
  orchestrator reviews the diff, re-runs gates, and commits.
- **Never store or log secret VALUES.** The `SecretRegistry` persists secret key NAMES
  only (this is its documented contract); the facade must keep it that way. No secret
  value may land in settings, logs, or test fixtures beyond obvious dummies.
- **Do not touch** `DEVELOPMENT.md`, anything under `plans/`, `AGENTS.md`, or any file
  outside the File scope below.
- **No `console.*`** — the only logging allowed is `logWarn`/`logError` from `src/log.ts`
  (grep-enforced convention: `console.` appears only in `src/log.ts`).
- `app.secretStorage` is **optional** (older Obsidian) and its `getSecret`/`setSecret`
  may be **sync or Promise-returning across Obsidian versions** — always `await` the
  result and null-guard `secretStorage` itself. This handling currently lives at three
  call sites; after your change it must live in exactly one place (the facade).
- Frontmatter writes (if you ever need one — you shouldn't in this WP) go through
  `updateFrontmatter` in `src/frontmatter.ts`, never raw `processFrontMatter`.

## The defects being fixed (verified findings — do not re-derive)

1. `deleteProvider` (`src/settings/sections/ai.ts:87`) clears the provider's secret via
   `ProviderManager.deleteApiKey` but never calls `secretRegistry.forget`, so a deleted
   provider warns "API key missing" forever, labeled with the raw key name (the provider
   is gone, so `describeSecretKey` can't resolve a friendly label).
2. The `record`/`forget` bookkeeping is wired inside UI closures at three
   `mountSecretControl` sites — `ai.ts:154-165` and `ai.ts:171-182` (verbatim
   copy-paste of each other) and `orchestration.ts:740-750` — instead of living beside
   the store operations. Any new store/clear call site can (and did) miss it.
3. Reconcile + clear-by-empty interact badly: clearing a secret writes `''` (see
   `deleteApiKey` in `src/providers.ts:45-48` and the youtube helper in
   `src/orchestration/utils/youtubeApi.ts:24-26`), but `listSecrets()` still lists the
   key, so grow-by-observation re-registers intentionally cleared keys and they
   false-report as present/missing.

## Scope of change

Build a single plugin-owned secrets **facade** and route everything through it:

1. **Facade** — extend `src/secretRegistry.ts` (natural home; `SecretRegistry` class is
   already there). Add facade methods wrapping `app.secretStorage` for `crucible-`
   prefixed keys, e.g. `get(key): Promise<string>`, `store(key, value): Promise<void>`,
   `clear(key): Promise<void>` (names may follow existing class idiom). `store` performs
   `record(key)` when the value is non-empty (empty value ⇒ treat as clear);
   `clear` writes `''` via `setSecret` and performs `forget(key)`. The sync-or-Promise
   `await` handling and the `secretStorage` null-guard live here and only here.
2. **Route callers through it:**
   - `ProviderManager.loadApiKey` / `storeApiKey` / `deleteApiKey`
     (`src/providers.ts:34-48`) — public signatures stay stable. Note
     `ProviderManager` will need access to the facade; follow the existing construction
     pattern in `src/main.ts` for wiring.
   - The YouTube key helpers in `src/orchestration/utils/youtubeApi.ts` (lines ~11-26).
   - This automatically fixes `deleteProvider` (defect 1) because clearing now forgets.
3. **Delete the closure bookkeeping** — remove the `record`/`forget` wiring from all
   three `mountSecretControl` call sites (they keep their `expectedButMissing` checks
   and their get/set plumbing, now expressed via the facade). While there, extract the
   twice-copy-pasted provider `mountSecretControl` block in `ai.ts` (154-165 vs 171-182)
   into one helper — they are verbatim duplicates.
4. **Harden reconcile** — in the reconcile path (`computeReconcile` /
   `SecretRegistry` usage), treat a key that `listSecrets()` lists but whose
   `getSecret` value is empty as **absent**: it must neither re-register via
   grow-by-observation nor count as present for missing-key warnings.
5. **Tests** — extend `tests/secretRegistry.test.mjs` with at minimum: (a) cleared key
   (empty value, still listed) does not re-register on reconcile and does not
   false-report; (b) deleting a provider forgets its key (no missing-key warning after
   delete); (c) facade `store` records, facade `clear` forgets. Follow the existing
   test file's stub/bundling style.

**File scope:** `src/secretRegistry.ts`, `src/providers.ts`,
`src/orchestration/utils/youtubeApi.ts`, `src/settings/sections/ai.ts`,
`src/settings/sections/orchestration.ts`, `src/settings/shared.ts` (only if
`mountSecretControl`'s options shape changes), `src/main.ts` (wiring only),
`tests/secretRegistry.test.mjs`. Nothing else.

**Explicitly NOT in scope:** per-type queue controls, autorun gate, frontmatter code,
localizer, any settings-UI restructuring beyond the named closure dedup.

## Gates — run all four verbatim; all must pass

- `npm run lint` — baseline clean (eslint + stylelint).
- `npx tsc -noEmit -skipLibCheck` — baseline clean.
- `npm test` — baseline is **213/213 passing**; your new tests raise the count.
- `node esbuild.config.mjs production` — exits 0.

No known flakes; a failure is real. Do not invent other verification commands.

## Report-back

Write `runs/dispatch/wp-r2-report.md` containing: files touched; the facade's final
public API; decisions and any deviations from this brief with reasons; how each of the
three defects is now impossible (point at file:line); verbatim tails of all four gates;
anything deferred. Close with: "Orchestrator: review the diff and re-run gates before
commit." Your final message should be a short summary; the report file is the artifact.
