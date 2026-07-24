# Crucible Search Companion → docker-compose fleet service

*Recommended model/effort — Claude: Sonnet/medium for both WPs, Opus orchestrator for review/gates/commits; Codex: Terra/medium for both WPs, Sol/medium-high orchestrator.*

## Context

Crucible's vault search is served by a companion HTTP process the user starts by hand with
`npm run search:serve` (`scripts/search-companion.mjs`). It is a 273-line plain-`node:http`
server with **zero npm dependencies** — it imports only Node builtins, including `node:sqlite`
for the FTS5 index. Because it is user-run, it is routinely *not* running: two existing plan
docs (`plans/fix-slow-vault-search-indexing.md:23`) record debugging sessions that ended in
"port 8765 closed, the companion wasn't started." The plugin degrades to
`SearchServiceUnavailableError` and search silently stops working.

Every other local tool on this machine is a docker-compose service in the `context-control`
fleet, started with `home-compose up`, restart-policy `unless-stopped`, and surfaced as a card
in Command Center. This change moves the search companion into that fleet so it starts with the
machine, restarts on failure, and reports health — the same operational story as the other
eleven services.

The service is **headless**: it serves JSON only, no HTML, no static assets. In Command Center
that means a status-only card (no `href`), exactly like the existing `conditioning-engine`
entry.

## Decisions locked

User-confirmed in this session:

1. **Port range extends to `48X0`.** The `47X0` band is exhausted (4710–4790 all allocated;
   4760 reserved for Labeling Studio). Obsidian Crucible takes the new `4800` decade.
2. **The search companion is `4801`, not `4800`.** `4800` is reserved for a future Obsidian
   Crucible dashboard at the tool's base port; the search sidecar sits at `+1`. This mirrors
   the established `conditioning:4780` / `conditioning-engine:4781` pairing.
3. **The index volume starts empty.** The container gets a fresh named volume; the schema
   self-creates on boot (`search-companion.mjs:18-49`). The existing 199 MB
   `.crucible/search.sqlite` is not migrated — the index is a derived cache, and the plugin's
   rebuild command regenerates it.
4. **Execution: orchestrated with dispatched workers.** This session becomes the orchestrator,
   dispatches both WPs, reviews diffs, re-runs each repo's gates, and commits per repo.

## Summary

Add a `Dockerfile` + `.dockerignore` to `obsidian-crucible` that packages the single
`.mjs` server on `node:24-slim` (no install step — it has no dependencies), make the
listen-host configurable so it can bind `0.0.0.0` inside the container, and move the default
port from `8765` to `4801`. Then enroll it in `context-control`'s `compose.home.yml` as an
out-of-repo build context (the pattern already used by four services), add the GIT_SHA export,
and register a headless status-only card in Command Center.

The one security-relevant deviation from fleet convention: the API is **unauthenticated and has
full write access to the index**, so the published port is scoped to loopback
(`127.0.0.1:4801:4801`) rather than all interfaces. Interface-scoped publishing has precedent in
the fleet (Frigate binds `192.168.0.100` via `SMART_HOME_BIND_ADDRESS`).

## Key Changes

**WP-1 — Containerize the companion (obsidian-crucible) (~0.12 kSLOC touched, ~90k tokens, ~7 min wall).**
Make the listen host configurable, repoint the default port to 4801, and add the image +
standalone compose mirror + docs. Files: `scripts/search-companion.mjs`, `src/types.ts`,
`src/settings/sections/orchestration.ts`, `src/search/client.ts`,
`src/orchestration/workflows/SearchIndexWorkflow.ts`, `tests/search*.test.mjs` (3 files), new
`Dockerfile`, new `.dockerignore`, new `docker-compose.yml`, `docs/search-companion.md`,
`AGENTS.md` (Quirks). *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: Claude
subagent (74k vs 90k direct — 18% saving, clean single-repo file scope); Codex subagent (65k vs
90k — 28% saving).*

1. **Configurable listen host** — `scripts/search-companion.mjs:226` currently hardcodes
   `server.listen(port, '127.0.0.1', …)`. This is the one hard containerization blocker: a
   loopback bind inside a container is unreachable from the host even with `-p`. Add, next to
   the existing port/db arg parsing at `:13-14`:
   ```js
   const host = args.get('--host') ?? process.env.CRUCIBLE_SEARCH_HOST ?? '127.0.0.1';
   ```
   and pass it to `listen`. **The default stays `127.0.0.1`** so the standalone
   `npm run search:serve` path keeps its loopback-only security property; only the container
   sets `CRUCIBLE_SEARCH_HOST=0.0.0.0`.

2. **Default port 8765 → 4801**, at every site that hardcodes it:
   - `scripts/search-companion.mjs:13` (server default)
   - `src/types.ts:658` (`searchServiceUrl` default)
   - `src/settings/sections/orchestration.ts:245,248` (placeholder + empty-input fallback)
   - `src/search/client.ts:87` (fallback base URL)
   - `tests/searchWorkflowQueue.test.mjs:42`, `tests/searchExclusions.test.mjs:43`,
     `tests/searchManagerHash.test.mjs:62`
   - `docs/search-companion.md:13,19,26`

3. **`SearchIndexWorkflow.ts:130`** — the outage message currently reads *"Start it with:
   npm run search:serve"*. Update to name the fleet path first (`home-compose up
   crucible-search`) with the npm script as the dev fallback.

4. **New `Dockerfile`** at the repo root. Single stage, no build, no `npm install` — the server
   imports only builtins, so the image needs exactly one file:
   ```dockerfile
   # Crucible Search companion — headless JSON API (SQLite FTS5) for the Obsidian plugin.
   # No dependency install: the server imports only Node builtins. node:sqlite is unflagged
   # from Node 23.4, so the base image must stay >= 24.
   FROM node:24-slim
   ARG GIT_SHA=unknown
   LABEL org.opencontainers.image.revision=${GIT_SHA}
   WORKDIR /app
   COPY scripts/search-companion.mjs ./scripts/search-companion.mjs
   ENV CRUCIBLE_SEARCH_PORT=4801 \
       CRUCIBLE_SEARCH_HOST=0.0.0.0 \
       CRUCIBLE_SEARCH_DB=/data/search.sqlite
   EXPOSE 4801
   VOLUME ["/data"]
   CMD ["node", "scripts/search-companion.mjs"]
   ```
   The `ARG GIT_SHA` + `LABEL org.opencontainers.image.revision` pair is **mandatory** fleet
   contract — Command Center reads that label to compute commits-behind
   (`command_center/apps/api/src/status.ts:83-84`).

5. **New `.dockerignore`** — load-bearing, not hygiene. The build context is the whole repo:
   `node_modules/` (325 packages), `main.js` (2.8 MB), and `.crucible/search.sqlite` (199 MB).
   Since the Dockerfile copies exactly one file, use a deny-all allowlist:
   ```
   *
   !scripts/search-companion.mjs
   ```

6. **New `docker-compose.yml`** at the repo root — a standalone dev mirror of the fleet block,
   per the documented convention in `/home/_shared_code/conditioning/docker-compose.yml:1-3`
   ("Mirrors the block enrolled in the context-control home-compose fleet, so `docker compose
   up` here and `hc up` there bring up the same service").

7. **`docs/search-companion.md`** — document the compose path as primary, the new port, the
   `CRUCIBLE_SEARCH_HOST` variable, and the fact that the named volume starts empty and needs
   one rebuild. Keep the standalone `npm run search:serve` section as the dev path.

8. **`AGENTS.md` Quirks entry** — record the two non-obvious facts: (a) the server's only
   runtime requirement is Node ≥ 24 for unflagged `node:sqlite`, so the base image must not be
   downgraded and no `npm install` belongs in the Dockerfile; (b) the listen host defaults to
   loopback on purpose and only the container overrides it.

**WP-2 — Enroll in the fleet (context-control) (~0.10 kSLOC touched, ~110k tokens, ~9 min wall).**
Add the compose service, GIT_SHA export, Command Center card, smoke assertion, and port-registry
rows. Files: `compose.home.yml`, `scripts/home-compose-up`,
`command_center/apps/api/src/registry.ts`, `command_center/apps/web/src/Landing.svelte`,
`command_center/apps/api/src/smoke.ts`, `SERVICES.md`. *Model: mid (Claude Sonnet/medium; Codex
Terra/medium). Execution: Claude subagent (86k vs 110k direct — 22% saving, disjoint repo from
WP-1 so it parallelizes); Codex subagent (75k vs 110k — 32% saving).*

1. **`compose.home.yml`** — new service block following the established shape:
   ```yaml
     # 4801: headless search companion for the Obsidian Crucible plugin (sibling repo).
     # JSON API only, no UI. Unlike conditioning-engine it must publish to the host, because
     # the consumer is Obsidian running outside the fleet — but the API is unauthenticated
     # with full index write access, so the publish is scoped to loopback.
     crucible-search:
       build:
         context: /home/_shared_code/obsidian-crucible
         args:
           GIT_SHA: ${CRUCIBLE_GIT_SHA:-unknown}
       container_name: crucible-search
       labels:
         com.context-control.display-name: "Crucible Search"
       restart: unless-stopped
       mem_limit: 512m
       ports:
         - "127.0.0.1:4801:4801"
       environment:
         CRUCIBLE_SEARCH_PORT: 4801
         CRUCIBLE_SEARCH_HOST: 0.0.0.0
         CRUCIBLE_SEARCH_DB: /data/search.sqlite
       volumes:
         - crucible-search-data:/data
       healthcheck:
         test: ["CMD", "node", "-e", "fetch('http://localhost:4801/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
         interval: 30s
         timeout: 5s
         retries: 3
   ```
   Two details that differ from a copy-paste of a neighbouring block:
   - The healthcheck uses **`.then()`, not top-level `await`**. The Bun services can write
     `await fetch(...)` because `bun -e` accepts top-level await; `node -e` evaluates as
     CommonJS and would throw a syntax error.
   - `mem_limit: 512m` rather than the usual `256m` — FTS5 queries against a ~200 MB index
     need more headroom than the trivial CRUD services.

   Also add `crucible-search-data:` to the top-level `volumes:` block (`compose.home.yml:361-368`).

2. **`scripts/home-compose-up`** — add alongside the existing exports at lines 21-24:
   ```bash
   export CRUCIBLE_GIT_SHA="$(git_head /home/_shared_code/obsidian-crucible)"
   ```
   Omitting this leaves the fleet view showing permanent "unknown" staleness.

3. **`command_center/apps/api/src/registry.ts`** — headless entry (no `href`, no
   `dashboardSection`; those two omissions are what make it a status-only card per the file's
   own comment at `:21-24`):
   ```ts
     {
       id: "crucible-search",
       label: "Crucible Search",
       hostId: "local",
       description: "Obsidian Crucible vault search companion — SQLite FTS5 index API, loopback :4801, no UI.",
       container: "crucible-search",
       source: { repo: `${CODE_ROOT}/obsidian-crucible` },
       icon: "Search",
     },
   ```
   Inline the repo path like `fitness-tracker` (`:44`) and `seven-afterlives-art-direction`
   (`:99`) do — the `CONDITIONING` constant exists only because that repo hosts two services.

4. **`command_center/apps/web/src/Landing.svelte`** — the icon set is **statically imported**,
   so a registry `icon` name that isn't in the map silently falls back to `Box` (`:99`). Add
   `Search` to the `lucide-svelte` import list (`:14-28`, alphabetically between `Radar` and
   `Target`) **and** to `iconByName` (`:85-96`). No `dashboardOrder` change is needed — that
   only applies to services with an `href`.

5. **`command_center/apps/api/src/smoke.ts`** — add a headless-registration assertion mirroring
   the `conditioning-engine` one at `:114-117`:
   ```ts
   const crucibleSearch = registry.services.find((service) => service.id === "crucible-search");
   if (!crucibleSearch || crucibleSearch.href !== undefined || crucibleSearch.container !== "crucible-search") {
     throw new Error("crucible-search registration is incorrect");
   }
   ```
   The existing set-equality check at `:153-156` picks the new id up automatically, but the
   explicit assertion is the convention for headless entries.

6. **`SERVICES.md`** — extend the documented convention from `47X0`/`57X0` to cover the new
   decade, and add rows. State the `48X0` base / `48X1+` sidecar rule explicitly, since this is
   the first use of it:
   | Port | Dev Port | Service | Path | Notes |
   |---:|---:|---|---|---|
   | `4800` | `5800` | Obsidian Crucible (dashboard) | `/home/_shared_code/obsidian-crucible/` | Reserved base port; no service yet |
   | `4801` | — | Crucible Search | `/home/_shared_code/obsidian-crucible/` | Headless SQLite FTS5 index API for the Crucible plugin; loopback-only publish, no UI |

   `4760` (Labeling Studio) is the existing precedent for a reserved-but-not-yet-running row.

## Public Interfaces

- **HTTP API — unchanged.** `GET /health`, `POST /v1/index/reset`, `POST /v1/chunks/upsert`,
  `POST /v1/chunks/delete`, `POST /v1/files/state`, `POST /v1/search`. No request/response shape
  changes; the documented contract in `docs/search-companion.md:60-69` stays valid, which keeps
  the alternate Postgres/Supabase companion implementations described there compatible.
- **New env var:** `CRUCIBLE_SEARCH_HOST` (default `127.0.0.1`). Joins the existing
  `CRUCIBLE_SEARCH_PORT` and `CRUCIBLE_SEARCH_DB`.
- **New compose var:** `CRUCIBLE_GIT_SHA`.
- **Changed default:** plugin `searchServiceUrl` `http://127.0.0.1:8765` → `http://127.0.0.1:4801`.
- **New host port:** `4801` on loopback. **New named volume:** `crucible-search-data`.

## Execution

Two work packages in **two separate repos with disjoint file sets** — dispatch both in parallel,
then verify end-to-end once both land.

- Both WPs go to workers (Claude Sonnet/medium; Codex Terra/medium). Neither carries a
  must-direct reason: each has a coherent single-repo file scope and no evolving shared contract
  — the only cross-repo seam is a frozen triple (container name `crucible-search`, port `4801`,
  `/health`), pinned in both briefs.
- **Orchestrator retains** diff review, gate re-runs, and commits (must-direct: it *is* the
  integration/gates/commit duty). Subagents never commit.
- **Two commits, one per repo**, each landing on that repo's local `master`, unpushed. Stage by
  path — `obsidian-crucible` has a dirty user-owned `FEEDBACK.md`, so no `git add -A`.
- The `obsidian-crucible` commit also removes `- "[[crucible-search-compose-service]]"` from
  `INITIATIVE.md` `pending-plans` (added when the plan file lands).

**Step 0 (orchestrator, before dispatch):** copy this plan to
`/home/_shared_code/obsidian-crucible/plans/crucible-search-compose-service.md` and register it
in that repo's `INITIATIVE.md` `pending-plans` (currently `[]`).

## Test Plan / Verification

**WP-1 gates** — `obsidian-crucible`, from the repo root, sequentially (AGENTS.md "Full Cleanup
Loop"):
```bash
npm run lint
npx tsc -noEmit -skipLibCheck
node esbuild.config.mjs production
npm test
```

**WP-2 gates** — `context-control`, from `command_center/`, sequentially:
```bash
bun run smoke
bun run typecheck
bun run lint
bun run test:theme
bun run design:verify
```

**End-to-end (user-run, after both commits).** Per the `tests-lint` Rule 0 prohibition on
port-probing, health is verified through compose and Command Center, not `curl`:
```bash
home-compose up crucible-search
home-compose status
```
Observable outcomes:
1. `crucible-search` reports `Up … (healthy)` — the healthcheck is what makes Command Center
   show green rather than plain `running` (`status.ts:29-42` reads Docker's `Status` string).
2. Command Center at `http://localhost:4730` shows a **Crucible Search** card in the bottom
   Services section with an `Internal` pill and no link, a magnifier icon (not the `Box`
   fallback — that would mean step WP-2.4 was missed), and a commits-behind figure rather than
   "unknown" (that would mean the GIT_SHA export was missed).
3. In Obsidian: set **Crucible → Settings → Orchestrate → Search → Service URL** to
   `http://127.0.0.1:4801` (see the manual step below), then run the search index rebuild
   command and confirm a subsequent search returns results.

## Critical Files

| Path | Role |
|---|---|
| `obsidian-crucible/scripts/search-companion.mjs` | The entire server; `:13-15` config, `:226` the loopback bind to fix |
| `obsidian-crucible/Dockerfile`, `.dockerignore` | New; the `.dockerignore` prevents a 200 MB+ build context |
| `obsidian-crucible/src/search/client.ts:87`, `src/types.ts:658` | Plugin-side default URL |
| `context-control/compose.home.yml` | The one file the fleet runs from; `:263-295` is the headless template |
| `context-control/scripts/home-compose-up:18-24` | GIT_SHA exports for out-of-repo builds |
| `command_center/apps/api/src/registry.ts:103-111` | The `conditioning-engine` headless entry to mirror |
| `command_center/apps/web/src/Landing.svelte:14-28,85-96` | Static icon imports + map |
| `command_center/apps/api/src/smoke.ts:114-117` | Headless assertion to mirror |

## Assumptions

1. **A manual settings edit is required once.** Changing the default in `src/types.ts` only
   affects installs that never set the value; the existing vault has `searchServiceUrl`
   persisted, so it keeps pointing at `8765` and will fail silently once the old process stops.
   I deliberately did **not** add a settings migration that rewrites the old default — it would
   be indistinguishable from a user who deliberately chose `8765`, and it would leave
   migration code to retire later. One settings field, once, is the proportionate fix.
2. **`npm run search:serve` is retained** as the dev/standalone path. Compose becomes the
   primary deployment, but the script costs nothing and keeps the loopback default meaningful.
3. **One replica only.** SQLite is single-writer; the compose block must never gain `deploy.replicas`.
4. The plugin reaches the service over published loopback rather than the compose network,
   because Obsidian runs on the host — this is why the service publishes at all, unlike
   `conditioning-engine`.
5. `node:24-slim` ships FTS5 in its bundled SQLite (verified on the host's Node v24.15.0, which
   runs the current server against a live FTS5 index).
6. Not migrating the 199 MB index means one rebuild pass; indexing cost is the user's known
   trade-off from decision 3.

**Total ≈ 0.22 kSLOC, ~200k raw tokens; ~160k Claude-path / ~140k Codex-path Opus/Sol-equivalent tokens.**
