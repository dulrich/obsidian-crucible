# Crucible Search Companion

Crucible's Obsidian plugin talks to a user-run local HTTP service for search storage and ranking. This keeps native SQLite modules out of the plugin bundle.

## Run

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

The current script implements SQLite FTS5/BM25. It accepts embedding vectors in the API payload and stores them as JSON, but does not rank with vectors yet. A future `sqlite-vec` implementation should keep the same endpoints and add vector/hybrid ranking behind `/v1/search`.

## API Contract

- `GET /health`
- `POST /v1/index/reset`
- `POST /v1/chunks/upsert`
- `POST /v1/chunks/delete`
- `POST /v1/files/state`
- `POST /v1/search`

All mutation/search requests include `vaultId` so multiple vaults can share one companion database.
