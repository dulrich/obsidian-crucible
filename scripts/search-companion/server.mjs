/* global process */
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequestHandler } from './handler.mjs';
import { SCHEMA_VERSION, openDatabase } from './schema.mjs';

// Process startup: argument/environment parsing, the listen call, and the entry-point test.
// Split out of the single-file companion (WP-rem-R3).
//
// `isMainModule` now takes the *caller's* `import.meta.url` rather than reading its own,
// because the entry point is still `scripts/search-companion.mjs` (the facade) and this
// module is one directory down. The facade passes `import.meta.url`; the comparison itself
// — argv[1] resolved, then realpath'd — is unchanged.

export function startServer({ port, host, dbPath }) {
	const db = openDatabase(dbPath);
	const server = createServer(createRequestHandler(db));
	server.listen(port, host, () => {
		process.stdout.write(`Crucible search companion listening on http://${host}:${port}\n`);
		process.stdout.write(`SQLite database: ${dbPath}\n`);
		process.stdout.write(`Schema version: ${SCHEMA_VERSION}\n`);
	});
	return { server, db };
}

// The listen host defaults to loopback everywhere except inside the container: the API is
// unauthenticated with full index write access, so the loopback bind is the entire security
// boundary for a bare `node scripts/search-companion.mjs` run. Only the Dockerfile /
// docker-compose set CRUCIBLE_SEARCH_HOST=0.0.0.0, because a loopback bind inside a
// container is unreachable from the host even with a published port.
export function parseArgs(argv) {
	const args = new Map();
	for (let i = 2; i < argv.length; i += 2) {
		args.set(argv[i], argv[i + 1]);
	}
	return {
		port: Number(args.get('--port') ?? process.env.CRUCIBLE_SEARCH_PORT ?? 4801),
		host: args.get('--host') ?? process.env.CRUCIBLE_SEARCH_HOST ?? '127.0.0.1',
		dbPath: resolve(args.get('--db') ?? process.env.CRUCIBLE_SEARCH_DB ?? '.crucible/search.sqlite'),
	};
}

// The server bootstrap runs only when this file is the entry point, so a unit test can
// import the ranking helpers without opening a database or binding a port. The container's
// CMD passes a *relative* path and Node resolves module URLs through realpath, so compare
// both forms — getting this wrong makes the container start and do nothing.
export function isMainModule(metaUrl) {
	const entry = process.argv[1];
	if (!entry) return false;
	const self = fileURLToPath(metaUrl);
	const absolute = resolve(entry);
	if (absolute === self) return true;
	try {
		return realpathSync(absolute) === self;
	} catch {
		return false;
	}
}
