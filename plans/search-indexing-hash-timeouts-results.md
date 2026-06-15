# Search Indexing Tweaks

## Summary
- Add note content hashing so unchanged files do not get re-chunked, re-embedded, or upserted.
- Tune automatic search indexing timeouts: 5s default debounce, plus 30s quiet period for active-note edit streams.
- Extend search results so the dialog can show `Showing N of total`.

## Key Changes
- Add a full-note `contentHash` to search indexing payloads and companion storage.
- Add a companion file-state lookup by `(vaultId, path)` so the plugin can skip indexing when the stored hash matches the current note content.
- Compute hash from the full file content before chunking; keep `mtime` as metadata, not the source of truth.
- Add `searchIndexDebounceMs` setting with default `5000`.
- Use 5s debounce for ordinary automatic file modify indexing.
- Use a 30s inactivity delay when the modified file is the active note, so continuous typing does not churn index jobs.
- Keep create/rename/delete and manual `Search: reindex active note` outside the edit debounce path.
- Extend `/v1/search` to return exact `total` and `hasMore`, and update the search dialog to display result count context.

## Interfaces
- `SearchChunk` gains `contentHash: string`.
- Companion `chunks` table gains `content_hash`.
- New companion endpoint, likely `POST /v1/files/state`, returns indexed state for requested paths.
- `SearchResponse` gains optional `total?: number` and `hasMore?: boolean`.
- Settings gain `searchIndexDebounceMs: number`, default `5000`.

## Test Plan
- Hash/state tests:
  - unchanged file hash skips chunking/upsert.
  - changed file hash indexes normally.
  - unknown file state indexes normally.
- Timeout/debounce tests:
  - non-active modify uses 5s default debounce.
  - active-note modify waits for 30s inactivity.
  - manual reindex bypasses debounce.
- Search result tests:
  - companion returns `total` and `hasMore`.
  - client parses both fields.
  - dialog shows `Showing 12 of 47` when total exceeds visible results.
- Run mandatory cleanup:
  - `npm run lint`
  - `npx tsc -noEmit -skipLibCheck`
  - `node esbuild.config.mjs production`

## Assumptions
- Use a deterministic content hash; MD5 is acceptable if simple in this runtime, otherwise use a stable built-in hash and keep the field named `contentHash`.
- Exact SQLite FTS count is acceptable for the local companion.
- The 30s quiet period applies only to active-note automatic modify events.
