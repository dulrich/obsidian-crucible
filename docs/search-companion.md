# Crucible Search Companion

Crucible's Obsidian plugin talks to a user-run local HTTP service for search storage and ranking. This keeps native SQLite modules out of the plugin bundle.

## Local SQLite

```bash
npm run search:serve
```

Defaults:

- URL: `http://127.0.0.1:8765`
- Database: `.crucible/search.sqlite`

Overrides:

```bash
node scripts/search-companion.mjs --port 8765 --db /path/to/search.sqlite
```

The bundled companion script implements local SQLite FTS5/BM25. It accepts embedding vectors in the API payload and stores them as JSON, but does not rank with vectors yet. A future `sqlite-vec` implementation should keep the same endpoints and add vector/hybrid ranking behind `/v1/search`.

Recommended plugin settings for the bundled local service:

- Search service URL: `http://127.0.0.1:8765`
- Vault ID: any stable per-vault key, for example `default` or the vault folder name
- Semantic indexing: optional; requires a configured embedding-capable provider/model

The SQLite database is local to the machine running the companion. Back it up with the vault if you want the index cache to survive machine rebuilds, or delete it and run a search rebuild to regenerate it.

## Standalone Local Postgres

The bundled `scripts/search-companion.mjs` does not implement Postgres. For a standalone local Postgres companion, run a separate HTTP service that exposes the same API contract below and configure Crucible to point at that service.

Expected setup shape:

- Postgres database reachable from the companion process, for example `postgres://crucible:crucible@127.0.0.1:5432/crucible_search`
- A chunks table keyed by `vaultId + chunkId`, with metadata JSON and optional embedding storage
- Text ranking with Postgres full-text search, or hybrid ranking if the service also enables `pgvector`
- Plugin Search service URL set to the local companion HTTP URL, not the raw Postgres connection string
- Plugin Vault ID set to a stable vault key shared by all requests

Do not put database credentials in Obsidian settings. Keep them in the standalone companion service environment, for example `DATABASE_URL`, and expose only the local HTTP endpoint to the plugin.

## Supabase

The bundled companion script does not implement Supabase. For Supabase-backed search, run a companion service that talks to Supabase from a trusted server-side process and implements the API contract below.

Expected setup shape:

- Supabase project with Postgres tables equivalent to the chunk storage contract
- Optional `pgvector` extension if the companion ranks embeddings
- Companion service configured with Supabase URL plus a server-side key in its environment
- Plugin Search service URL set to the companion HTTP URL
- Plugin Vault ID set to a stable vault key; use row-level policy or service-side filtering so vaults do not bleed into each other

Do not store Supabase service-role keys in Obsidian settings. If a browser-accessible anon key is used, the companion still needs to enforce vault scoping and should avoid exposing write access directly from the plugin.

## API Contract

- `GET /health`
- `POST /v1/index/reset`
- `POST /v1/chunks/upsert`
- `POST /v1/chunks/delete`
- `POST /v1/files/state`
- `POST /v1/search`

All mutation/search requests include `vaultId` so multiple vaults can share one companion database.
