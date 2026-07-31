#!/usr/bin/env node
/* global process */

// Crucible search companion — the executable entry point and the stable compatibility facade.
//
// The implementation lives in `scripts/search-companion/`, decomposed from the single 2,319-line
// module this file used to be (WP-rem-R3). This file stays two things and nothing else:
//
//   1. **The executable.** `npm run search:serve`, the Dockerfile CMD and `node
//      scripts/search-companion.mjs` all still start the server from here, via the
//      `isMainModule()` guard at the bottom. Nothing above it has a side effect, so importing
//      this file for a unit test neither opens a database nor binds a port — the module-shape
//      rule the ranking tests have always relied on.
//   2. **The export surface.** Every helper the test suite imports from
//      `'../scripts/search-companion.mjs'` still resolves here, unchanged, via the star
//      re-exports below. The module a name physically lives in is an implementation detail;
//      this path is the contract.
//
// **Zero dependencies, still.** Every module under `search-companion/` imports only `node:*`
// builtins — `node:sqlite` (which needs Node >= 23.4) most of all. There is no `npm install`
// step in the Dockerfile, so a single non-builtin import anywhere in the directory silently
// breaks the container image.
//
// **The Dockerfile copies a directory now, not one file.** `COPY scripts/search-companion.mjs`
// plus the matching `.dockerignore` allowlist were both widened to `scripts/search-companion/`
// in the same change, per the standing rule in `src/search/AGENTS.md` that a second script file
// requires a Dockerfile change in the same commit. Adding a module under that directory is
// free; adding one anywhere else is not.

export * from './search-companion/chunks.mjs';
export * from './search-companion/deadline.mjs';
export * from './search-companion/dispatch.mjs';
export * from './search-companion/endpoints/chunksDelete.mjs';
export * from './search-companion/endpoints/filesState.mjs';
export * from './search-companion/endpoints/health.mjs';
export * from './search-companion/endpoints/reset.mjs';
export * from './search-companion/endpoints/search.mjs';
export * from './search-companion/endpoints/upsert.mjs';
export * from './search-companion/handler.mjs';
export * from './search-companion/http.mjs';
export * from './search-companion/ranking.mjs';
export * from './search-companion/schema.mjs';
export * from './search-companion/search.mjs';
export * from './search-companion/searchClients.mjs';
export * from './search-companion/server.mjs';
export * from './search-companion/statements.mjs';
export * from './search-companion/vectors.mjs';

import { isMainModule, parseArgs, startServer } from './search-companion/server.mjs';

// The server bootstrap runs only when this file is the entry point. `isMainModule` takes this
// module's own `import.meta.url` because the entry point is this facade, not the module the
// function now lives in — the argv[1]/realpath comparison it makes is otherwise unchanged.
if (isMainModule(import.meta.url)) {
	startServer(parseArgs(process.argv));
}
