# Metadata-Consistent Trigger Evaluation

## Summary

Fix trigger evaluation so conditions are checked only after Obsidian has produced a consistent metadata/content snapshot. Timer debounce remains only for coalescing repeated edits, not for achieving consistency.

## Key Changes

- Refactor `TriggerRegistry` into two stages:
  - Raw event capture: `create`, `modify`, `rename`, and custom ingestion events record trigger intent per path/event.
  - Consistent evaluation: evaluate guards only from a cache-ready path, primarily `metadataCache.on('changed', (file, data, cache) => ...)`.
- Preserve trigger event semantics: a trigger configured for `create` still fires as `create`, but only after the matching metadata-cache update for that file arrives.
- For `modify`, use metadata-cache `changed` as the consistency barrier, then apply the existing debounce to avoid repeated firings during active editing.
- For `metadata-changed`, evaluate directly from the `changed` event’s supplied `cache`, with debounce only for edit coalescing.
- For `rename`, keep vault `rename` as the consistency source because Obsidian documents that metadata `changed` is not emitted for renames; content is unchanged, and path/scope must update immediately.
- For `youtube-metadata-enriched`, do not fire directly from the ingestion event if the target metadata note may not yet be indexed; record the intent and evaluate when `metadataCache.changed` arrives for that metadata note. If cache is already present and complete, evaluation may proceed through the same consistent-evaluation path.

## Implementation Details

- Introduce a small pending-event map keyed by file path, storing event names awaiting cache consistency.
- On `metadataCache.changed`, merge pending raw events for that path plus `metadata-changed`, then schedule/evaluate those event names using the provided `CachedMetadata`.
- Read note content at evaluation time after the metadata-cache event when a content-backed guard needs it; current trigger guards remain frontmatter/tag-based, but the evaluation pipeline should not assume metadata-only consistency.
- Keep existing note-lock / `isMaterializing` suppression before enqueueing jobs.
- Do not change `data.json`, ignored ID format, YouTube metadata schema, or the configured “Ignore Shorts from Channels” trigger.

## Tests

- Add TriggerRegistry tests covering:
  - `create` does not evaluate guards immediately from vault create.
  - `create` evaluates after `metadataCache.changed` for the same file, preserving event identity.
  - `modify` coalesces repeated cache-ready updates but does not rely on the timer for cache availability.
  - `youtube-metadata-enriched` waits for cache-ready metadata before evaluating channel/duration guards.
  - `rename` remains immediate and path/scope-aware.
- Keep existing trigger action tests for `channelId in set`, `duration_seconds < 120`, and `youtube-ignore-video`.

## Validation

- Run:
  - `npm run lint`
  - `npx tsc -noEmit -skipLibCheck`
  - `node esbuild.config.mjs production`
