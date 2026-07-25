# Crucible Search Companion

Crucible's Obsidian plugin talks to a local HTTP service for search storage and ranking. This keeps native SQLite modules out of the plugin bundle.

## Local SQLite

### Docker Compose (primary)

The companion runs as a docker-compose service, either standalone (`docker compose up` from this repo root) or enrolled in the `context-control` fleet as `crucible-search` (`home-compose up crucible-search`). The container binds `0.0.0.0` internally and publishes to the host on loopback only, so from the plugin's point of view it's reachable the same way as the standalone process below.

Defaults inside the container:

- URL: `http://127.0.0.1:4801`
- Database: named volume `crucible-search-data`, mounted at `/data/search.sqlite`

The volume starts **empty** — the schema self-creates on first boot, but it holds no chunks until you run a search index rebuild from the plugin. This is expected after first `up`, not a bug.

### Standalone (dev fallback)

```bash
npm run search:serve
```

Defaults:

- URL: `http://127.0.0.1:4801`
- Database: `.crucible/search.sqlite`

Overrides:

```bash
node scripts/search-companion.mjs --port 4801 --host 127.0.0.1 --db /path/to/search.sqlite
```

Or via environment: `CRUCIBLE_SEARCH_PORT`, `CRUCIBLE_SEARCH_HOST`, `CRUCIBLE_SEARCH_DB`. `CRUCIBLE_SEARCH_HOST` defaults to `127.0.0.1` (loopback-only) for the standalone path; only the container sets it to `0.0.0.0`, since a loopback bind inside a container is unreachable from the host even with a published port.

The bundled companion script implements local SQLite FTS5/BM25. It accepts embedding vectors in the API payload and stores them as JSON, but does not rank with vectors yet. A future `sqlite-vec` implementation should keep the same endpoints and add vector/hybrid ranking behind `/v1/search`.

Recommended plugin settings for the bundled local service:

- Search service URL: `http://127.0.0.1:4801`
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

## Inference services (embeddings + reranking)

Semantic search and the opt-in reranker need a model server; the fleet declares one rather than
leaving it as a thing you have to remember to start. Two CPU containers run beside
`crucible-search`, each hosting one model:

| Service | Port | Model | Purpose |
|---|---|---|---|
| `crucible-embedder` | `127.0.0.1:4802` | `BAAI/bge-m3` (1024d) | `POST /v1/embeddings` — OpenAI-compatible |
| `crucible-reranker` | `127.0.0.1:4803` | `BAAI/bge-reranker-v2-m3` | `POST /rerank` |

Both run the [Infinity](https://github.com/michaelfeil/infinity) inference server
(`michaelf34/infinity:0.0.77-cpu`), started with `--device cpu --engine optimum`. Like
`crucible-search`, both publish to `127.0.0.1` only — the embedder's port also carries an
unauthenticated, full-access inference API.

**Pointing Crucible at the embedder:** in the plugin's provider settings, add a provider of kind
`openai-compatible` with base URL `http://127.0.0.1:4802/v1` (no API key required) and set
`searchEmbeddingModel` to `BAAI/bge-m3` on that provider. The `openai-compatible` client appends
`/embeddings` to the configured base URL itself, so the base URL must include the `/v1` segment
— the embedder is started with `--url-prefix /v1` specifically so this matches.

**Reranker endpoint (for the WP-5 reranker client):** `POST http://127.0.0.1:4803/rerank` — no
`/v1` prefix; Infinity's default route is unprefixed and the reranker container is not started
with `--url-prefix`. Verified request/response shape:

```
POST /rerank
{ "model": "BAAI/bge-reranker-v2-m3", "query": "...", "documents": ["...", "..."] }

200 OK
{ "results": [ { "index": 0, "relevance_score": 0.93 }, ... ], "model": "...", "usage": {...} }
```

**When they're down:** both carry `restart: unless-stopped` and a `/health` healthcheck, same
as `crucible-search`. If the embedder is unreachable, `attachEmbeddings` catches the failure,
logs a debug-gated warning, and the index falls back to FTS-only for that flush — search stays
functional, just without the vector rank, until the container comes back. If the reranker is
unreachable, the explicit rerank action in the search modal fails with an error; it never blocks
type-ahead search, which does not call it.

## API Contract

- `GET /health`
- `POST /v1/index/reset`
- `POST /v1/chunks/upsert`
- `POST /v1/chunks/delete`
- `POST /v1/files/state`
- `POST /v1/search`

All mutation/search requests include `vaultId` so multiple vaults can share one companion database.
