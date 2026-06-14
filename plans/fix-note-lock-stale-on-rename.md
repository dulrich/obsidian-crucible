# Fix: note-lock goes stale when a note is renamed mid-operation

## Context

A note ingested via the **"Chain: ingest as fanfic"** chain
(`open-brain/vault/daily/day/2026-06-14/The Witcher Frozen Blood  (Self-Insert).md`)
got a corrupt write: a body image embed and body text were spliced into the
`word-count` frontmatter field —

```
word-count![](_resources/.../40ddd348..._MD5.jpg) in Borrowed Armor**​
```

That is an **interleaved write** (not last-write-wins), which means a mutating
chain and Localize ran **concurrently** on the same note. By design they should
have serialized on the per-note mutex (`NoteLockManager`).

### Root cause

`NoteLockManager` keys its mutex on a **path string**. The chain acquires the
lock on the note's path captured at chain start
(`chains.ts:79` — `withOptionalNoteLock(this.noteLocks, targetFile.path, …)`),
then a chain step **moves the note** into the daily asset folder via
`moveFileToFolder` → `app.fileManager.renameFile` (`main.ts:491`). After the
rename the note's live path changes, but the held lock is still keyed under the
**old** path. Every path-based gate then reads `false` for the new path and
fires concurrently:

- `debouncedLocalize` / `debouncedLint`: `if (this.noteLocks.isLocked(file.path)) return;` (`main.ts:155`, `main.ts:142`)
- `TriggerRegistry.fireEvent`: same `isLocked` gate (`TriggerRegistry.ts:112`)
- `AttachmentLocalizer.onNoteRename`: acquires a *fresh* `withOptionalNoteLock(file.path=newPath, …)` and rewrites attachment refs (`localizeAttachments.ts:826`)

So the chain (writing frontmatter under the old-path lock) and a localize pass
(rewriting attachment links on the new path) mutate the same file at once.

There is **no rename handling in `NoteLockManager` today** (confirmed: no
`handleRename`/re-key anywhere). The intended outcome: a rename migrates the
held lock to the new path so all path-based gates stay consistent and peers
serialize as designed.

## Approach

Make the note-lock **follow renames**. Migrate the lock entry's key on rename,
and switch the internal re-entrancy/release bookkeeping from path strings to the
stable `LockState` object so it survives a key change.

### 1. `src/orchestration/NoteLockManager.ts`

- Add a `key: string` field to `LockState` (its current path).
- Change re-entrancy tracking from `AsyncLocalStorage<Set<string>>` to
  `AsyncLocalStorage<Set<LockState>>` (held by object identity, stable across rename).
- `acquire(path, label)` keeps its **public signature** (returns `Promise<() => void>` —
  the existing tests rely on this) but builds the `LockState` with `key: path` and
  passes the state (not the path) to `makeRelease`.
- `makeRelease(state)` captures the `LockState` and operates on `state.key`
  (so release still finds the entry after a rename) and `state.waiters`.
- `withLock(path, label, action)`: re-entrancy check becomes
  `const current = this.locks.get(path); if (current && held?.has(current)) return action();`
  After `acquire`, look up the now-held state (`this.locks.get(path)`) and add it
  to `nextHeld`.
- Add:
  ```ts
  /** Follow a note rename so path-keyed gates stay consistent with the held lock. */
  handleRename(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const state = this.locks.get(oldPath);
    if (!state) return;                 // nothing held under the old path
    if (this.locks.has(newPath)) {      // rare: target path already locked — best effort
      logWarn('note-lock rename collision; leaving lock under old path', oldPath, newPath);
      return;
    }
    this.locks.delete(oldPath);
    state.key = newPath;
    this.locks.set(newPath, state);
    this.emit(oldPath, false, '');
    this.emit(newPath, true, state.label);
  }
  ```
- Remove the now-stale comment claiming "raw `acquire` is unchanged for low-level
  callers" — `acquire` is only used internally (`withLock`) and by tests.

This refactor is behavior-preserving for every existing case (re-entrancy keyed
by `LockState` identity, waiter promotion reuses the same state, double-release
no-op all still hold) and additionally survives a rename.

### 2. Wire `handleRename` into the rename event — early

Register a dedicated `vault.on('rename')` that calls
`this.noteLocks.handleRename(oldPath, file.path)` **before** any path-based gate
runs. Listener order = registration order, so it must be registered before
`this.triggers.start()` (`main.ts:119`, which registers `TriggerRegistry`'s
rename listener) and before the existing rename handler at `main.ts:174`.

Place it in `onload` just before `this.triggers.start();`:
```ts
this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
  if (file instanceof TFile) this.noteLocks.handleRename(oldPath, file.path);
}));
```

After this, while the chain holds the lock: the new path reports `isLocked === true`,
so `debouncedLocalize`/`debouncedLint`/`TriggerRegistry` skip, and
`onNoteRename`'s `withOptionalNoteLock(newPath)` queues behind the chain (or runs
inline re-entrantly if dispatched in the chain's own async context) — no concurrent
write either way.

### 3. Regression test — `tests/noteLock.test.mjs`

Add a `handleRename` test:
- Hold `a.md` via `withLock` (or `acquire`); call `handleRename('a.md','b.md')`.
- Assert `isLocked('a.md') === false`, `isLocked('b.md') === true`,
  `currentLabel('b.md')` preserved, and emitted events
  (`a.md` locked:false, `b.md` locked:true).
- Re-entrancy across rename: inside a `withLock('a.md', …)` body, call
  `handleRename('a.md','b.md')` then `withLock('b.md', …)` and assert it runs
  **inline** (no deadlock) — proves the held-set-by-`LockState` migration.
- A foreign waiter that called `withLock('b.md')` after the rename runs only
  after the holder releases.

### 4. Document the quirk — `AGENTS.md` `## Quirks`

Add: "A note-mutating operation that **renames/moves its target note** mid-flight
would otherwise strand its note-lock under the old path (all path-keyed gates —
`isLocked`, `TriggerRegistry`, auto-lint/localize, `onNoteRename` — then see the
new path as unlocked and write concurrently → interleaved frontmatter). The lock
follows renames via `NoteLockManager.handleRename`, wired from an early
`vault.on('rename')` registered before `triggers.start()`. Re-entrancy/release
track the `LockState` object, not the path, so they survive the re-key."

## Critical files

- `src/orchestration/NoteLockManager.ts` — add `handleRename`; key re-entrancy/release on `LockState`.
- `src/main.ts` — early `vault.on('rename')` → `noteLocks.handleRename` (before line 119).
- `tests/noteLock.test.mjs` — rename regression tests.
- `AGENTS.md` — `## Quirks` entry.

## Verification

- `npx tsc --noEmit` (or the repo's typecheck) — confirm types after the
  `Set<string>` → `Set<LockState>` change.
- `node --test tests/noteLock.test.mjs` — existing suite stays green; new
  rename tests pass.
- Manual repro in the vault: enable auto-localize-on-edit, run "Chain: ingest as
  fanfic" on a clipped note whose chain moves it to the daily folder. Before the
  fix the frontmatter can corrupt; after, the move keeps the lock and the chain
  completes with clean frontmatter and intact attachment links.

## Notes

- Per workflow, copy this plan to `obsidian-crucible/plans/` before implementing.
- The one already-damaged note is **not** repaired here (scope: code fix only);
  recover it with the existing `Lint: repair attachment links` command.
