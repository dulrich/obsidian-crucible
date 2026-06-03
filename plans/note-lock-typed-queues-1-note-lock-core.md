# Chunk 1 — Note-lock core (`NoteLockManager`)

Part of [note-lock-typed-queues.md](./note-lock-typed-queues.md).

## Goal
A per-note (path-keyed) async mutex so Crucible commands targeting the same note
serialize instead of racing. Fixes the re-appeared **localize race** and the
**YT-metadata-in-chains race**. Lays the event foundation for the Chunk 2 overlay.

## New file: `src/orchestration/NoteLockManager.ts`
```
class NoteLockManager {
  constructor(private bus?: IngestionEventBus)
  acquire(path: string, label: string): Promise<() => void>   // resolves the release fn
  withLock<T>(path: string, label: string, action: () => Promise<T>): Promise<T>
  isLocked(path: string): boolean
  lockedPaths(): string[]
}
```
- State: `Map<string, { label: string; waiters: Array<{label,resolve}> }>`.
- `acquire`: if path free → record holder, emit `note-lock-changed {path, locked:true, label}`,
  return a `release` that pops the next waiter (or clears + emits `locked:false`). If busy →
  push a waiter, return a promise resolving to its release fn when it becomes holder.
- `withLock`: `acquire` → `try { action() } finally { release() }`.
- Release must be idempotent (guard double-call).

## Event: extend `src/orchestration/events.ts`
Add `'note-lock-changed'` to `IngestionEventName` and payload
`{ path: string; locked: boolean; label: string }`.

## Wire-up `main.ts onload()`
Instantiate after `ingestionEvents`: `this.noteLocks = new NoteLockManager(this.ingestionEvents)`.
Expose `noteLocks: NoteLockManager` field. Pass to managers that need it (localizer, chains,
lint) via constructor or setter.

## Lock the single-note mutation choke-points
- **`localizeAttachments.ts`** — wrap the body of `localizeNote(file, silent)` in
  `noteLocks.withLock(file.path, 'localize', …)`. Keep `withMaterializing` inside (it stays
  responsible for self-trigger suppression).
- **`chains.ts`** — in `executeChain`, when `targetFile` is defined, wrap the step loop in
  `withLock(targetFile.path, 'chain:'+chain.name, …)`.
- **`lint.ts`** — the four `withMaterializing(this.setMaterializing, …)` sites (≈205, 280,
  334, 384) gain a `withLock(file.path, 'lint', …)` wrapper. Only lock when a concrete file
  is known.
- **`orchestration/utils/youtubeApi.ts`** — wrap the write phase of
  `ingestYoutubeVideoMetadata` and `setYtMetadataLink` in `withLock(sourceFile.path,
  'yt-metadata', …)`. **This is the YT-in-chains fix:** the metadata link write can no longer
  interleave with another op writing the same note. (NoteLockManager reachable via `plugin.noteLocks`.)

## `isMaterializing` stays
It still suppresses the plugin's own writes from re-triggering `debouncedLint`/
`debouncedLocalize` (`main.ts:115,124`). Note-lock = serialize peers; materializing =
ignore self-events. A mutating command does both.

## Tests: `tests/noteLock.test.mjs`
- Same-path `acquire` serializes (second waits for first release; FIFO order preserved).
- Different paths run concurrently (no blocking).
- `withLock` releases on throw.
- `isLocked`/`lockedPaths` reflect state.
- `note-lock-changed` emitted on acquire and release.

## Verify
- `npm run build` green, `npm test` green.
- Manual: run a chain that fetches YT metadata on a fresh capture → `yt-metadata` link set on
  the **first** run. Localize a large note while editing → no interleaved writes.
