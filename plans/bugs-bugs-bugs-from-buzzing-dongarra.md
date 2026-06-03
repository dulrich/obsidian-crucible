# Bug fixes: locking / queue / mutex fallout from the orchestrator refactor

## Context

Yesterday's orchestrator + locking refactor (commits `4453f92`…`4736b54`) introduced a
per-note async mutex (`NoteLockManager`) and a unified job queue. Four regressions
surfaced, all rooted in *which* operations the lock/queue should apply to and *how* the
lock is keyed:

1. **Chain: Refine Transcript** is serialized by the wrong key — the same chain can't run
   on two different notes because the cycle guard is keyed by the chain, not the note.
2. **Chain: New Dashboard Tab** is read-only but still grabs the note lock (grays the note).
3. **Ingestion dashboard → "Auto enrich from Uncaptured Videos"** shows ON after reload but
   doesn't actually enrich until the toggle is cycled off/on.
4. **Localize** still produced orphaned attachments because the auto edit-triggers race a
   note that an "Ingest as …" chain is mid-mutating.

Decisions made with the user:
- Add an **explicit per-chain "mutating" toggle** (default ON), backed by a **general
  `mutating` command property** on the registry — `mutating` governs whether running a
  command acquires the note lock.
- Fix bug 4 by **gating the auto edit-triggers on the note lock** (the lock becomes the
  single "this note is being mutated, hands off" signal, instead of the leaky global
  `isMaterializing` flag).

Key files: `src/chains.ts`, `src/main.ts`, `src/types.ts`,
`src/settings/sections/automate.ts`, `src/ingestionDashboard.ts`.

---

## Bug 1 — cycle guard keyed by command, not note (`src/chains.ts`)

`ChainManager.executeChain` guards re-entrant cycles with `executingChains: Set<Chain>`
(chains.ts:15), checked at chains.ts:46 **before** `targetFile` is resolved (chains.ts:52).
Keyed by the chain object, it wrongly blocks the *same* chain running on a *different* note
(e.g. a queued `transcript_refine` on note A + a manual "Chain: Refine Transcript" on note B).

**Fix:** key the guard by chain **+ target note path**.
- Change the field to `private executing = new Map<Chain, Set<string>>();`.
- In `executeChain`, resolve `targetFile`/`chainVars.target_path` **first**, compute
  `const noteKey = targetFile?.path ?? '';`, then check
  `this.executing.get(chain)?.has(noteKey)` for the "already running" skip.
- Register/clean up `noteKey` in the chain's set in the `try`/`finally` (delete the chain's
  entry when its set is empty).

A true self-cycle (same chain re-entering on the same note) is still caught; the same chain
on distinct notes now runs concurrently. The note-lock reentrancy
(`heldByContext`, NoteLockManager.ts:35) continues to prevent same-note deadlock.

---

## General `mutating` command property + Bug 2 (`src/types.ts`, `src/main.ts`, `src/chains.ts`, `src/settings/sections/automate.ts`)

**Principle:** a command's `mutating` flag governs whether running it acquires the per-note
lock. Default is `true` (safe). The four built-in lock-takers (lint, localize,
yt-metadata, and chains) are mutating; read-only commands take no lock.

1. **Registry property** — add `mutating?: boolean` to `CrucibleCommandEntry`
   (main.ts:51) and to the `registerCrucibleCommand` opts (main.ts:209); record
   `mutating: opts.mutating ?? true` in `commandRegistry.push` (main.ts:216). Mark the
   obvious read-only built-ins `mutating: false` at their registration (command palette,
   chain *preview*, `orchestrator-scan`/`run-next`, the `source:*` / `copy-active-file`
   commands). This is the general property the user asked for; it is the single source of
   truth consulted by chain execution below and available to any future centralized dispatch.

2. **Per-chain toggle** — add `mutating?: boolean` to the `Chain` interface (types.ts:104).
   In the chain editor (`renderEditChain`, automate.ts), add a toggle right after the
   "Debug mode" one (automate.ts:188-193), mirroring `bindToggle`:
   - name: "Mutates the note", desc: "When off, the chain runs read-only and does not lock
     the note (use for chains that only open views / dashboards)."
   - `get: () => chain.mutating !== false` (default ON), `set: (v) => { chain.mutating = v; }`,
     `after: () => tab.plugin.registerChains()`.

3. **registerChains** (main.ts:812) passes `mutating: chain.mutating !== false` into
   `registerCrucibleCommand`.

4. **executeChain** (chains.ts:60-64) only wraps in `withOptionalNoteLock` when the chain is
   mutating: `if (targetFile && chain.mutating !== false) { …withOptionalNoteLock… } else { await run(); }`.
   Marking "New Dashboard Tab" non-mutating then skips the lock entirely (fixes bug 2). Chains
   never enqueue jobs themselves, so no job-queue change is needed — the lock was the only
   thing a read-only chain was wrongly touching.

Existing chains have `mutating === undefined` → treated as `true`, so behavior is unchanged
until the user flips a chain off.

---

## Bug 3 — auto-enrich toggle doesn't start until cycled (`src/ingestionDashboard.ts`)

`buildEnrichmentQueueSection` init (ingestionDashboard.ts:393-396) calls only
`setAutoSource()`. `MemoryJobQueue.refill()` early-returns unless **both** `autoEnabled` and
`autoSource` are set (MemoryJobQueue.ts:104), and nothing sets `autoEnabled` on load — only
the toggle's `change` handler does (ingestionDashboard.ts:354). So the box reads ON but
enrichment is idle until a cycle calls `setAutoEnabled(true)`.

**Fix:** mirror the change handler in the init block — when `toggle.checked`, call
`setAutoEnabled(true)` **before** `setAutoSource(...)`:

```ts
if (toggle.checked) {
    this.plugin.enrichmentQueue?.setAutoEnabled(true);
    this.plugin.enrichmentQueue?.setAutoSource(() => this.uncapturedQueueItems());
}
```

(The refresh-time re-push at ingestionDashboard.ts:712-713 already gates on
`isAutoEnabled()`, so it starts working correctly once init sets the flag.)

---

## Bug 4 — orphaned attachments: auto-triggers race a locked note (`src/main.ts`)

`localizeNote` already wraps its work in the note lock (localizeAttachments.ts:272), but the
auto edit-triggers `debouncedLint` (main.ts:124) and `debouncedLocalize` (main.ts:133) gate
only on the global `isMaterializing` flag — not the note lock. While an "Ingest as …" chain
holds the lock and writes the note across several steps, `isMaterializing` is false between
its lint/localize sub-ops, so a `modify` event schedules an auto-localize that then runs
against a note the chain is still mutating — downloading/writing an attachment whose landing
ref never lands → orphan.

**Fix:** make the lock the authoritative "hands off" signal. In both debounced handlers, bail
when the note is locked, in addition to the existing `isMaterializing` check:

```ts
if (this.noteLocks.isLocked(file.path)) return;
```

Place it alongside the `!this.isMaterializing` guard in `debouncedLint` (main.ts:125) and
`debouncedLocalize` (main.ts:134). A note actively held by any mutating command/chain is then
never concurrently auto-processed; the chain (the lock holder) is the sole mutator, and its
own reentrant localize step still runs inline.

---

## Verification

Build/lint/tests:
- `npm run build` and `npm test` (the repo has Jest specs around `NoteLockManager`,
  `MemoryJobQueue`, and chains — extend them per below).
- Add unit tests:
  - **Bug 1:** `executeChain` of the same `Chain` against two different `targetFile` paths
    runs both (no "already running" skip); the same chain+path still self-skips.
  - **Bug 2:** a `mutating: false` chain with a `targetFile` does **not** call into
    `noteLocks` (spy that `withLock`/`acquire` is never hit).
  - **Bug 3:** building the enrichment section with the setting ON leaves the underlying
    `MemoryJobQueue.isAutoEnabled()` true and `refill()` populating from the source.
  - **Bug 4:** with a note locked, the debounced lint/localize handlers return early.

Manual (in a real vault, via `/run` or a dev build):
1. **Bug 1:** queue a `transcript_refine` on note A, then run "Chain: Refine Transcript" on
   note B — both complete; neither shows the "already running; skipping" notice.
2. **Bug 2:** mark "New Dashboard Tab" non-mutating; run it on an open note — the note-lock
   overlay/spinner never appears and the note stays interactive.
3. **Bug 3:** enable "Auto enrich from Uncaptured Videos", reload Obsidian, reopen the
   Ingestion dashboard — uncaptured videos start draining without toggling.
4. **Bug 4:** run an "Ingest as …" chain on a note with remote images; confirm via
   **Localize → Debug mode** (`_crucible/debug.md`) that only the chain localizes, and the
   Orphaned Attachments dashboard section stays empty afterward.
