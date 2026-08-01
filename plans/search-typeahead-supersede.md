# Search type-ahead supersede: client abort, companion supersede, deadline skew-guard fix

*Recommended model/effort — Claude: Sonnet/medium workers for SS1–SS2, orchestrator (Fable)
closes SS3 direct; Codex: Terra/medium workers, Sol/medium orchestrator.*

## Context

Live validation (2026-07-31, post-pf sprint) still shows interactive search timeouts. An
Explore trace (master `c5ae17b`) confirmed the stacking hypothesis structurally, with one
correction and one aggravator:

- **Client fires unrecallable queries.** The type-ahead debounce is 200ms trailing with
  reset (`src/search/debounce.ts:34`, `SearchModal.ts:80`) — one query per typing *pause*,
  not per keystroke. But `SearchModal.ts:130` only stamps a generation and *discards*
  stale responses (`:138`, `:173`); `src/search/client.ts:190-200` races `requestUrl`
  against a timer with **no AbortController anywhere** — a superseded or client-timed-out
  request keeps running on the companion to full completion.
- **Companion has no defense.** `/v1/search` carries only `vaultId` + `query`
  (`scripts/search-companion/endpoints/search.mjs:24-25`) — no client/seq identity, so no
  supersede is possible. `runSearch` (`scripts/search-companion/search.mjs:383`) is fully
  synchronous: each request monopolizes the thread for its whole SQL run. N in-flight
  requests form an invisible, unbounded, unordered queue (`handler.mjs:57-73`,
  `server.mjs:20-21`).
- **The deadline skew guard inverts under exactly this load.**
  `scripts/search-companion/deadline.mjs:59`: when queue delay exceeds one budget
  (~3200ms), `sentAt` falls outside the trust window and the deadline **restarts from
  `receivedAt`** — the requests abandoned longest are granted a full fresh budget at full
  cost. The guard's stated justification (the interactive yield bounds real delays under
  one budget) only holds for the upsert flush loop; there is no search-vs-search yield.
- Aggravator, transient: pf-3's `extraHashFacets` fold moved every stamped note's
  `contentHash`, so the next sweep re-upserts (and re-embeds) them all — validation
  queries plausibly queued behind that one-time backfill. The structural gap stands
  regardless.
- pf-3/pf-4 touched zero query-path code (confirmed) — no query-time regression from the
  linked-post work.

## Decisions locked (user, this session)

1. Route: the two tiny repair fixes went direct (`4979e49`); the search stacking work is
   this plan (user chose "direct repair fixes + search plan").
2. All three mechanisms are in scope: client abort, companion supersede, deadline guard.

## Summary

Make superseded queries recallable end to end: the client aborts the in-flight interactive
search when a newer one supersedes it (or on modal close/timeout); the companion learns
client+sequence identity and pre-flight-abandons superseded or already-disconnected
requests before paying any SQL cost; the deadline guard stops granting fresh budgets to
requests that provably sat in a long queue.

## Key Changes

**WP-SS1 — client-side abort on supersede.**
*~0.3 kSLOC · ~200k tokens · ~15 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent (~70% saving); Codex: subagent (~50%)*
Investigation-first: `requestUrl` is not abortable, so the interactive search call must
move to `fetch` + `AbortController` — **repro first** whether Electron's renderer blocks a
loopback `fetch` on CORS; if blocked, add `Access-Control-Allow-Origin` (+ `OPTIONS`
preflight for POST/JSON) to the companion's responses — it is loopback-only and ours. If
`fetch` proves structurally unusable, STOP at a written diagnosis (SS2's server-side
supersede still lands independently). Then: thread an `AbortSignal` through the client's
search request path (interactive search only — upsert/backfill stay on `requestUrl`);
`SearchModal` keeps one live controller and aborts it wherever it bumps
`searchGeneration` (new search at `:130`, below-gate clear at `:85`, `onClose` at `:123`);
the client timeout aborts rather than abandons. **Constraint: an abort is not a companion
failure — it must never trip the availability-gate latch or either failure counter.**
Files: `src/search/client.ts`, `src/search/SearchModal.ts`,
`scripts/search-companion/server.mjs`/`handler.mjs` (CORS headers only), tests. NOT in
scope: supersede logic, deadline.mjs, ranking.

**WP-SS2 — companion supersede + deadline skew-guard fix.**
*~0.3 kSLOC · ~220k tokens · ~17 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent*
- `/v1/search` gains optional `clientId` + `seq` (client sends a per-modal-session UUID
  and a monotonic counter). A handler-scoped holder (same pattern as
  `lastInteractiveSearchAt`) tracks the newest seq per clientId; a request whose seq is
  already superseded is abandoned **pre-flight** — at the same spot as the `overBudget()`
  gate (`search.mjs:412`) — returning a fast degraded/superseded response. Requests
  without clientId/seq behave exactly as today.
- Before starting `runSearch`, also skip if the request socket already closed (`req`
  `'close'`/`aborted`) — SS1's aborts arrive here as closed sockets.
- `deadline.mjs:59`: widen the past-direction trust window from one budget to K budgets
  (K=5): a `sentAt` between `receivedAt - K*budget` and `receivedAt` is trusted (so a
  queue-delayed request correctly reads as over budget and degrades in ~ms); older than
  that, or in the future, still falls back to `receivedAt` (genuine skew/garbage). Pin
  with tests both directions.
- Sequential after SS1 (shared files: client sends clientId/seq; companion touched by
  both).
Files: `scripts/search-companion/endpoints/search.mjs`, `handler.mjs`, `deadline.mjs`,
`src/search/client.ts` (send clientId/seq), tests. NOT in scope: making `runSearch` async
/ adding a search-vs-search yield (bigger surgery; only if SS1+SS2 measurably fail).

**WP-SS3 — docs close (orchestrator-direct).**
*~0.05 kSLOC docs · ~30k tokens · ~5 min wall · top (orchestrator) · Claude: direct
(must-direct: integration/gates/commit duty); Codex: direct (same)*
`src/search/AGENTS.md`: extend the timeout/deadline entry — superseded interactive queries
are aborted client-side and abandoned server-side; the skew guard's K-budget trust window
and why one budget was wrong. Quirks-index line in root `AGENTS.md`. Plan completion note;
deregister `pending-plans`; ledger actuals.

## Public Interfaces

- `/v1/search` request body gains optional `clientId`/`seq` (absent = today's behavior;
  no schema version bump — additive, backward compatible).
- Companion responses may add CORS headers (loopback-only server, unchanged binding).
- No new settings, commands, or events.

## Execution

SS1 → SS2 sequential (shared client + companion files), SS3 orchestrator-direct. One
worker worktree per WP branched from local master tip; workers never commit; orchestrator
copies the report out first, reviews the full diff, re-runs all six gates verbatim,
commits `(subagent ss-N)`, ff-merges **from the main checkout**, removes worktree then
branch. Ask the user which subagents to spawn before each dispatch. Token bands include
the calibration pad (pf sprint ran 71–109% of padded estimates).

## Test Plan / Verification

Six gates verbatim per landing: `npm run lint`; `npx tsc -noEmit -skipLibCheck`;
`npm test` (floor **1604/125**, count only grows); `node esbuild.config.mjs production`;
`grep -rna --include='*.ts' "console\." src/` → only `src/log.ts`; per touched file
`file` + `LC_ALL=C grep -caP '\0'` exits 1 (companion files have a legal in-band-NUL
history — any grep over them needs `-a`; new sentinels use the two-character `'\0'`
escape, never a pasted control byte). Acceptance: a superseded interactive query is
aborted (client) and abandoned pre-flight (companion, verified via a companion-level
test driving two seq'd requests); an abort never trips the availability latch; a
`sentAt` older than one budget but inside K budgets degrades instead of getting a fresh
budget; requests without clientId/seq behave byte-identically to today. Live validation:
type a long query with pauses — no timeout pile-up; the companion log shows superseded
abandons.

## Critical Files

`src/search/client.ts`, `src/search/SearchModal.ts`,
`scripts/search-companion/{endpoints/search.mjs,handler.mjs,deadline.mjs,server.mjs}`,
`src/search/debounce.ts` (reference only), tests.

## Assumptions

- Electron renderer `fetch` to the loopback companion is workable with server-side CORS
  headers (SS1 verifies first; written diagnosis + stop if not).
- `runSearch` stays synchronous — supersede + abort remove the dead work; a cooperative
  search yield is out of scope unless measurement after SS1+SS2 still shows pile-up.
- The pf-3 re-embed backfill wave is one-time and self-resolves; it is not a defect.

**Total ≈ 0.65 kSLOC, ~450k raw tokens; ~310k Claude-path / ~245k Codex-path
Opus/Sol-equivalent tokens.**

---

## Completion note (2026-07-31)

All three WPs landed same-day; plan closed.

- **SS1** `09cd8b8` — fetch+AbortController transport for interactive `/v1/search` (scoped
  `eslint-disable` for the plugin's no-bare-`fetch` rule, kept deliberately: `requestUrl`
  has no abort story); session-latched `requestUrl` fallback on CORS/network-shaped
  `TypeError`; modal aborts one live controller at all three generation-bump sites;
  timeout aborts instead of abandoning; `SearchAbortedError` structurally unreachable
  from the availability latch; companion CORS/OPTIONS. Actuals: ~256k tokens (128% of
  padded est — test-harness fetch-stub rewrite), 23 min, tests 1604→1624. Ledger 512.
- **SS2** `f9e8be5` — optional `clientId`/`seq` attached only on signal-carrying
  (interactive) calls; bounded-LRU supersede tracker (`searchClients.mjs`,
  `MAX_SEARCH_CLIENTS = 64`) consulted pre-flight; disconnect skip via `res.on('close')`
  registered before the body read — **`req.destroyed` was live-confirmed unusable**
  (autoDestroy flips it after every normal body end; the initial implementation hung
  every real search); `SEARCH_DEADLINE_SKEW_TRUST_BUDGETS = 5`. Identity-less requests
  byte-identical. Actuals: ~239k tokens (109%), 26 min, tests 1624→1638/128. Ledger 513.
- **SS3** (this commit) — quirk entries in `src/search/AGENTS.md` (supersede contract +
  the two traps; companion deploy quirk), root quirks-index line, the
  rebuild-not-restart note in `docs/search-companion.md` (user-requested: the flow was
  undocumented), plan deregistered.

Deviations from plan: none of substance. The SS1 CORS "repro first" step was converted
to defensive coverage (headless worker cannot run Electron) — CORS/OPTIONS shipped
unconditionally plus a session-latched `requestUrl` fallback, live validation left to the
user. `runSearch` stays synchronous as planned; revisit only if pile-up persists after
live validation. Deploy note: these changes reach the running companion only via
`home-compose up crucible-search` (image rebuild — see the new quirk).
