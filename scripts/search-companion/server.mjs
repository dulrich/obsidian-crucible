/* global process */
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequestHandler } from './handler.mjs';
import { SCHEMA_VERSION, openDatabase } from './schema.mjs';
import { createVectorBackend } from './vectors.mjs';

// Process startup: argument/environment parsing, the listen call, and the entry-point test.
// Split out of the single-file companion (WP-rem-R3).
//
// `isMainModule` now takes the *caller's* `import.meta.url` rather than reading its own,
// because the entry point is still `scripts/search-companion.mjs` (the facade) and this
// module is one directory down. The facade passes `import.meta.url`; the comparison itself
// — argv[1] resolved, then realpath'd — is unchanged.

// Graceful shutdown bound: `docker stop` waits 10s before SIGKILL, so the whole close —
// drain plus DB close — must finish well inside that.
export const SHUTDOWN_TIMEOUT_MS = 4500;

export function startServer({ port, host, dbPath }, options = {}) {
	const db = openDatabase(dbPath);
	// Created here rather than inside createRequestHandler (its `options.vectors` seam) so
	// shutdown can stop the sliced rebuild runner before the DB closes.
	const vectors = createVectorBackend(db, options.vectorOptions);
	// In-flight request tracking keys on the handler's own promise, not on the socket: an
	// upsert resumes after async yields and touches the DB in its finalizer even when the
	// client has already gone, so the DB may close only once every handler has settled.
	// `options.wrapHandler` is a test seam: it lets a test hold a request in flight (gated)
	// and observe that shutdown waits for it before closing the DB.
	const baseHandler = createRequestHandler(db, { vectors });
	const handler = options.wrapHandler ? options.wrapHandler(baseHandler, db) : baseHandler;
	const inFlight = new Set();
	const server = createServer((req, res) => {
		const p = Promise.resolve(handler(req, res)).catch(() => {});
		inFlight.add(p);
		p.finally(() => inFlight.delete(p));
	});
	const timeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
	let shutdownPromise = null;
	// Idempotent: a second call (or second signal) returns the same promise. Resolves
	// `{ drained: true }` after the DB closed, or `{ drained: false }` when the bound expired
	// with a handler still running — the DB is then deliberately left open (process exit
	// releases it) rather than closed under a resumed upsert.
	function shutdown() {
		if (shutdownPromise) return shutdownPromise;
		shutdownPromise = (async () => {
			server.close();
			server.closeIdleConnections?.();
			vectors.stop();
			let timer;
			const expired = new Promise(resolveTimer => {
				timer = setTimeout(() => resolveTimer(false), timeoutMs);
				timer.unref?.();
			});
			const drain = (async () => {
				while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
				return true;
			})();
			const drained = await Promise.race([drain, expired]);
			clearTimeout(timer);
			if (!drained) return { drained: false };
			db.close();
			return { drained: true };
		})();
		return shutdownPromise;
	}
	server.listen(port, host, () => {
		process.stdout.write(`Crucible search companion listening on http://${host}:${port}\n`);
		process.stdout.write(`SQLite database: ${dbPath}\n`);
		process.stdout.write(`Schema version: ${SCHEMA_VERSION}\n`);
	});
	return { server, db, vectors, shutdown };
}

// SIGTERM/SIGINT: `docker stop` used to wait its full 10s grace and SIGKILL. Graceful close,
// then exit 0; an unref'd hard-exit timer bounds the whole thing at 5s. A second signal is a
// no-op (shutdown() is idempotent and the timer is already armed).
export function installSignalHandlers({ shutdown }) {
	let armed = false;
	const onSignal = () => {
		if (armed) return;
		armed = true;
		const hard = setTimeout(() => process.exit(0), 5000);
		hard.unref();
		shutdown().then(
			() => process.exit(0),
			() => process.exit(0),
		);
	};
	process.on('SIGTERM', onSignal);
	process.on('SIGINT', onSignal);
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
