# Diagnosis: YouTube Data API enrichment stopped (since 2026-07-07)

## Context

Since 2026-07-07, captured/tracked YouTube videos no longer get metadata. Observed
state (from the Ingestion dashboard): Autorun **on**, Auto-enrich uncaptured **on**,
intake → enqueue → jobs **run** and the queue shows them — yet **Uncaptured videos
show no Duration** and the Enriched column shows an **[Enrich]** button (no
`yt-metadata` link). The API key is reportedly unchanged.

The goal is to identify why enrichment produces no output and prescribe the fix.

## What was ruled out (this is NOT a code regression in the enrichment path)

Two commits landed right before the failure window; both were investigated and
exonerated for the YouTube write path:

- **`a3e2e7a` (07-06, "trigger bugfixes")** rewrote `TriggerRegistry`. The founding
  trigger `yt-metadata-on-capture` still fires on `metadata-changed` and enqueues
  `youtube_metadata_fetch`. Verified by `tests/triggerRegistryConsistency.test.mjs`
  (4/4 pass) — the `metadata-changed → enqueue` path is intact.
- **`58af37c` (07-05, "codex … oneshot the review plan")** touched the enrichment
  files but the YouTube changes are behavior-equivalent: `yamlString` was extracted
  to `src/frontmatterValues.ts` as `JSON.stringify` (equivalent quoting); the
  `FeedTrackerWorkflow` generic-metadata refactor only ever persisted **blog**
  metadata (`this.source.persistItemMetadata` is a no-op for the YouTube source —
  YouTube enrichment has always come from the per-note trigger / dashboard queue,
  never the tracker); `uncaptured.ts` changed only imports.

The dashboard's "is-enriched / duration" detection
(`computeUncapturedVideoRows` → `findExistingMetadataNote` + `readDurationSeconds`,
`src/ingestion/data/uncaptured.ts:87-124`) is correct — it just reads the metadata
note that enrichment is supposed to create. No note ⇒ no duration ⇒ [Enrich] button.

## Root-cause mechanism (confirmed by code)

The job **runs but throws at the Data API call and fails silently**:

1. `YoutubeMetadataFetchWorkflow` → `ensureMetadataNote` → `fetchYoutubeVideo`
   (`src/orchestration/utils/youtubeApi.ts:74`). A non-200 response **throws**
   (403/404/quota/empty-items) — see lines 83-108.
2. The throw propagates to `MemoryJobBackend.runNext` (`src/orchestration/MemoryJobBackend.ts:66-68`),
   which calls `markFailed(...)` **with no `logWarn`** — the only other backend
   branch that logs is absent here.
3. `youtubeMetadataJobConfig` sets `terminalRetentionMs: 60_000`
   (`src/orchestration/jobTypeConfig.ts:144`), so `sweepTerminal` deletes the failed
   entry after 60s. **No persistent record anywhere.**

Net effect: the job appears, "runs", vanishes within a minute, writes no metadata
note, and leaves no error — precisely the reported symptom. **The diagnosability
gap (silent, unlogged, 60s-swept failures) is itself the reason this went unnoticed
for ten days and is the first thing to fix.**

## Why the API call newly throws — ranked hypotheses (need runtime confirmation)

- **(A) Daily quota exhaustion — best fit.** "Auto-enrich uncaptured" ON means every
  drain/refill re-enqueues the *entire* uncaptured backlog (`refill()` in
  `MemoryJobQueue.ts`), each fetch costing 1 unit against the default 10,000/day.
  Once the backlog crossed the daily budget (~07-07), every subsequent fetch returns
  403 `quotaExceeded` → throws `"quota exceeded"` (youtubeApi.ts:85-86). Matches a
  hard date cutoff with an unchanged key. Note: quota errors do **not** trip the
  `/api key/` latch below and do **not** block the per-note trigger — they just make
  every over-budget fetch fail.
- **(B) Key/project 403** (Data API disabled, key restriction added, billing lapse):
  `accessNotConfigured`/`forbidden` → throws the generic
  *"forbidden (HTTP 403). Check the API key and Data API enablement."* (youtubeApi.ts:88).
  This **also** trips the latent latch below, silently killing batch auto-enrich.
- **(C) Empty `items[]`** for private/region-blocked/members-only videos → throws
  "video … not found" (youtubeApi.ts:106-108). Per-video, unlikely to be global.

## Latent bug to fix regardless — over-broad failure latch

`src/orchestration/MemoryJobBackend.ts:61`:

```js
if (/api key/i.test(error)) this.queue.setAutoEnabled(false);
```

Intended to stop refilling only when the key is *missing*, but `/api key/i` also
matches the generic 403 message ("…Check the **API key** and Data API enablement").
So **any** 403 permanently latches `setAutoEnabled(false)` with **no auto-recovery
and no UI signal** (the dashboard toggle reads from `settings.ingestionYoutubeAuto-
EnrichEnabled`, which this never touches — it keeps showing "on"). This is a genuine
"stopped and never resumed" trap independent of which hypothesis above is true.

## CONFIRMED root cause (2026-07-17)

With the Step-1 log line in place, one [Enrich] attempt produced:

```
[crucible] job youtube_metadata_fetch video:eF6UiqKHil4 failed: YouTube Data API key not configured.
```

Not quota, not a 403 — the fetch never reaches the network. `loadYoutubeApiKey`
returns empty, i.e. **the stored key is no longer readable from `app.secretStorage`**.
`secretStorage` is an undocumented Obsidian API the plugin declares as *synchronous*
(`src/types.ts`); the most likely 07-07 trigger is an Obsidian update that reset/
migrated the secret store (or made the API async). The `no-api-key` result also
(correctly, now) latches auto-enrich off via the Step-3 change.

**Runtime probe (2026-07-17) — CONFIRMED the store was WIPED, not the API broken:**
`app.secretStorage` is present and *synchronous* (`getSecret` returns `null`
synchronously — the async hypothesis is ruled out, so the await-hardening below is
defensive only, not the fix). `listSecrets()` is **empty** — every secret is gone,
including the OpenRouter provider key (`crucible-provider-<id>-key`), not just the
YouTube key. So both integrations broke at once. Cause: Obsidian reset/migrated its
secret backend; wiped secrets are unrecoverable in code. **Fix = re-enter all keys**
(YouTube in Settings → Orchestrate; OpenRouter + any provider keys in Settings → AI),
then re-enable auto-enrich. This is a silent, cross-integration credential-loss mode
— strong argument for the empty-key startup/dashboard warning noted below.

**Operational fix:** re-enter the key in Settings → Orchestrate → "YouTube Data API
key". After typing it and clicking away, the field should switch to the "API Key in
Obsidian Secrets" indicator (that indicator only shows when `load()` returns a
non-empty value — `src/settings/shared.ts:129`). Then re-enable auto-enrich (the
latch cleared it) and re-run enrichment.

**Code hardening applied** so re-entry survives an async secretStorage API:
`SecretStorage` methods are now typed `… | Promise<…>` and `app.secretStorage` is
optional; `loadYoutubeApiKey`/`storeYoutubeApiKey`/`deleteYoutubeApiKey` and the
provider-key equivalents (`src/providers.ts`) now `await` get/set (a no-op when the
API is synchronous, correct when it is a Promise).

## Remediation

### Step 1 — Make failures visible (do this first; it also confirms root cause)
- In `MemoryJobBackend.runNext`, add a `logWarn('job', this.type, entry.key, error)`
  on the `markFailed` path (both the `result.status === 'failed'` branch and the
  `catch`). Reuse `logWarn` from `src/log` (already used in `TriggerRegistry`).
- Trigger one enrichment (dashboard [Enrich] on a known-public video) and read the
  logged error string. That string selects the branch below.

### Step 2 — Fix by confirmed branch
- **(A) quota:** confirm in Google Cloud console (APIs & Services → YouTube Data API
  → Quotas). Either request more quota or throttle: stop refilling the *whole*
  backlog every drain, and back off for the rest of the day on the first
  `quotaExceeded`. A dedicated `quotaExceeded` short-circuit (distinct from the
  key latch) that pauses refill until the next Pacific-midnight reset is the durable
  fix.
- **(B) key/project:** re-check the key's API restrictions / referrer-IP limits and
  that the Data API v3 is enabled + billing active; rotate if needed via the existing
  `storeYoutubeApiKey` secret flow.

### Step 3 — Harden the latch (always)
- Narrow the disable condition at `MemoryJobBackend.ts:61` to the genuinely-missing-key
  case only. Prefer a typed signal over string-matching: have `fetchYoutubeVideo` /
  the workflow surface a distinct reason (e.g. the existing `no-api-key` status vs.
  the thrown 403), and gate `setAutoEnabled(false)` on `no-api-key` exclusively.
- Surface the disabled state in the dashboard so a latched auto-enrich is visible
  rather than silently off.

## Verification

- Unit gates: `npm run lint`, `npx tsc -noEmit -skipLibCheck`, and
  `node --test tests/triggerRegistryConsistency.test.mjs` (must stay 4/4).
- End-to-end: with the log line in place, click [Enrich] on a public video and
  confirm the real error appears in the console; after the branch fix, confirm a
  `_yt_metadata/<channel>/<videoId>.md` note is created, the Uncaptured row shows a
  Duration, and the Enriched column shows the metadata link.

## Note on the other open defect (unrelated)

The "Lint: Localize: ignore folder (initiatives) separate from no-link" TODO
(DEVELOPMENT.md, added in `39c3dba` on 07-08) concerns the Lint → Localize command's
handling of external images in the `initiatives` folder. It does **not** touch the
TriggerRegistry or the YouTube enrichment path and has no bearing on this
investigation.
