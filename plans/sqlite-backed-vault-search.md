# SQLite-Backed Vault Search for Crucible

## Summary

Build v1 as a local-first hybrid search system with a user-run SQLite companion service. Crucible keeps vault indexing/search orchestration inside the plugin, but delegates SQLite FTS/vector storage and ranking queries to a local HTTP service configured by URL.

The first user-facing surface is a command modal returning ranked evidence: note path, title, snippet, metadata, score breakdown, and open-note actions. Embeddings are optional; if embedding generation or semantic index data is unavailable, search falls back to SQLite FTS/BM25.

## Key Changes

- Add a `search` subsystem for vault note discovery, frontmatter-aware metadata extraction, deterministic chunking, companion-service API calls, and result normalization.
- Add a local companion service contract:
  - `GET /health`
  - `POST /v1/index/reset`
  - `POST /v1/chunks/upsert`
  - `POST /v1/chunks/delete`
  - `POST /v1/search`
- Extend Crucible AI providers with embedding-capable model metadata and an embedding call path that uses provider/model settings instead of a standalone embedding URL.
- Add orchestration-backed indexing jobs for full rebuild, file upsert, file delete, and search sweep.
- Hook vault create/modify/delete/rename events to enqueue indexing jobs rather than indexing inline.
- Add commands:
  - `Search: vault`
  - `Search: rebuild index`
  - `Search: reindex active note`
  - `Search: check service health`
  - `Search: sweep vault`

## Search Behavior

- Normal query returns ranked evidence only, not synthesized answers.
- Search attempts query embeddings when a configured embedding model exists and falls back to FTS/BM25 if embeddings or semantic index data are unavailable.
- Sweep search accepts a brief project description and returns grouped ranked results without writing a report note in v1.

## Test Plan

- Unit tests for chunk IDs, markdown/frontmatter parsing, QMD/text inclusion, ignored binary files, and delete/rename payloads.
- Unit tests for provider embedding request/response normalization and optional fallback behavior.
- Unit tests for result normalization and score diagnostics using fixed fixtures.
- Queue tests for full rebuild, modify, delete, rename, and failed companion health checks.
- Manual acceptance queries against `vault/`:
  - `cedar policy harness`
  - `video where Nate talked about scouts, squads, and coordination costs`
  - `note about the pattern of local AGENTS.md in subfolders`
  - sweep for articles/prompt kits relevant to a brief project description
  - QMD / authoritative Supabase / VPS Postgres control-plane pattern
- Final cleanup loop before completion: `npm run lint`, `npx tsc -noEmit -skipLibCheck`, `node esbuild.config.mjs production`.

## Assumptions

- V1 indexes vault notes only.
- The companion service is user-run; Crucible only stores its URL and health-checks it.
- Obsidian plugin code does not depend on native SQLite modules directly.
- Embeddings are optional and routed through Crucible AI provider/model configuration.
