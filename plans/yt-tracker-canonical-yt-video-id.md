# YouTube Tracker — canonical `yt-video-id` property

## Context

The YouTube Tracker workflow scans the vault for notes that represent YouTube videos in order to deduplicate against newly fetched RSS items. Detection currently relies on either a `youtube-id` property (raw 11-char id) or a `source` URL containing a YouTube id. Querying these notes downstream (Dataview, Bases) requires checking multiple properties or re-parsing URLs.

The tweak: each tracker run should canonicalize the detected video id into a property named `yt-video-id`, so a single property is the authoritative query target. The user also chose to rename `youtube-id` → `yt-video-id` repo-wide (go-forward, no migration of existing notes), and to leave existing `yt-video-id` values alone if they conflict.

## Approach

Three changes:

1. **Rename `youtube-id` → `yt-video-id`** in `LinkScanWorkflow` and `YoutubeTrackerWorkflow.buildSeenIdSet` (no positional change in LinkScan — it doesn't currently control frontmatter ordering).
2. **Add a positional-insert helper** `insertFrontmatterPropertyAfter(fm, anchorKey, newKey, value)` to `src/frontmatter.ts`, mirroring the rebuild-the-object pattern already used by `sortFrontmatterProperties`.
3. **Add a canonicalize pass** to `YoutubeTrackerWorkflow.run()` that scans non-orchestration markdown files and, for each detected YT video, writes `yt-video-id` (if missing/empty) directly after the source property where the id was found.

## Files to change

### `src/frontmatter.ts`

Add new helper next to `sortFrontmatterProperties`:

```typescript
export function insertFrontmatterPropertyAfter(
    fm: FrontmatterRecord,
    anchorKey: string,
    newKey: string,
    value: unknown,
): void {
    if (newKey in fm) { fm[newKey] = value; return; }
    if (!(anchorKey in fm)) { fm[newKey] = value; return; }
    const ordered: FrontmatterRecord = {};
    for (const k of Object.keys(fm)) {
        ordered[k] = fm[k];
        if (k === anchorKey) ordered[newKey] = value;
    }
    for (const k of Object.keys(fm)) delete fm[k];
    for (const k of Object.keys(ordered)) fm[k] = ordered[k];
}
```

Relies on the same JS object insertion-order semantics that `sortFrontmatterProperties` already depends on; `processFrontMatter` round-trips that order into the YAML.

### `src/orchestration/workflows/YoutubeTrackerWorkflow.ts`

**Imports:** add `updateFrontmatter, insertFrontmatterPropertyAfter` from `../../frontmatter`.

**`run()`:** call `await this.canonicalizeDetectedIds(plugin);` after the registry-validation block and before `buildSeenIdSet`.

**New private method:**

```typescript
private async canonicalizeDetectedIds(plugin: WorkflowContext['plugin']): Promise<void> {
    const app = plugin.app;
    for (const file of app.vault.getMarkdownFiles()) {
        if (file.path.startsWith(QUEUE_SCAN_SKIP_PREFIX)) continue;
        const fm = app.metadataCache.getFileCache(file)?.frontmatter;
        if (!fm) continue;
        const existing = fm['yt-video-id'];
        if (typeof existing === 'string' && existing.trim()) continue; // leave user-set values alone
        const detected = detectVideoIdSource(fm);
        if (!detected) continue;
        await updateFrontmatter(app, file, current => {
            const present = current['yt-video-id'];
            if (typeof present === 'string' && present.trim()) return;
            insertFrontmatterPropertyAfter(current, detected.sourceKey, 'yt-video-id', detected.id);
        });
    }
}
```

**New module-local helper** (sits next to `ingestProperty`):

```typescript
function detectVideoIdSource(fm: Record<string, unknown>): { id: string; sourceKey: string } | null {
    const fromYt = firstStringId(fm['yt-video-id']);
    if (fromYt) return { id: fromYt, sourceKey: 'yt-video-id' }; // already canonical
    const fromSource = firstUrlId(fm['source']);
    if (fromSource) return { id: fromSource, sourceKey: 'source' };
    return null;
}
function firstStringId(value: unknown): string | null { /* trim + 11-char regex check, handles array */ }
function firstUrlId(value: unknown): string | null { /* extractVideoIdFromUrl, handles array */ }
```

Note: in `detectVideoIdSource`, the `yt-video-id` branch is effectively a no-op because the caller already short-circuits when `yt-video-id` is present. It's listed for symmetry/future-proofing. The active sources are `source` (URL extraction).

**`buildSeenIdSet()` (line 131):** change `ingestProperty(fm['youtube-id'], seen, false);` to `ingestProperty(fm['yt-video-id'], seen, false);`. The `source` and `video_ids` lines stay the same.

### `src/orchestration/workflows/LinkScanWorkflow.ts`

Replace `youtube-id` with `yt-video-id` at:
- Line 103–104 (existing-file update branch)
- Line 135 (new-file create branch)
- Line 217 (`ensureNullableKeys`)

Pure rename; LinkScan's positional behavior is unchanged — `yt-video-id` will land wherever `processFrontMatter` places it (typically at the end of properties added in the callback).

### Verify nothing else references `youtube-id`

`grep -rn "youtube-id" src/` after the rename should return zero hits.

## What is NOT in scope

- Migration of existing notes that have `youtube-id` set by prior LinkScan runs. The user explicitly chose go-forward.
- Touching intake notes under `_crucible/orchestration/youtube/new-videos/` — these list multiple ids in `video_ids` and aren't single-video notes; the `QUEUE_SCAN_SKIP_PREFIX` check excludes them.
- Overwriting an existing `yt-video-id` value, even if it differs from what we'd extract.
- Removing the now-orphaned `youtube-id` properties from existing notes.

## Verification

1. **Unit-style smoke** in vault:
   - Note A (link-record): `source: https://youtu.be/dQw4w9WgXcQ` only → after tracker run, `yt-video-id: dQw4w9WgXcQ` appears directly after `source`.
   - Note B: `source: https://www.youtube.com/watch?v=abcDEFghIJK` and a non-YT property between `source` and end → `yt-video-id` lands immediately after `source`, before the other property.
   - Note C: `source: https://example.com/foo` (non-YT) → no change.
   - Note D: already has `yt-video-id: zzzzzzzzzzz` (different) → unchanged.
   - Note E: under `_crucible/orchestration/...` → unchanged.
2. **Rename verification:** `grep -rn "youtube-id" src/` returns zero hits.
3. **Build:** `pnpm run build` (or whatever the repo uses) passes; existing tests still pass.
4. Run `Orchestrate: enqueue YouTube tracker` from the command palette twice in a row — second run should be a no-op for `yt-video-id` writes (idempotent).

## Critical files

- `src/frontmatter.ts` — add `insertFrontmatterPropertyAfter`
- `src/orchestration/workflows/YoutubeTrackerWorkflow.ts` — canonicalize pass, rename in `buildSeenIdSet`
- `src/orchestration/workflows/LinkScanWorkflow.ts` — rename `youtube-id` → `yt-video-id` (3 sites)
- `src/orchestration/utils/youtube.ts` — reused as-is (`extractVideoIdFromUrl`)
