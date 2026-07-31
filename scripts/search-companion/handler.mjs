import { setTimeout as sleepMs } from 'node:timers/promises';

import { createDispatcher } from './dispatch.mjs';
import { createChunksDeleteEndpoint } from './endpoints/chunksDelete.mjs';
import { createFilesStateEndpoint } from './endpoints/filesState.mjs';
import { createHealthEndpoint } from './endpoints/health.mjs';
import { createResetEndpoint } from './endpoints/reset.mjs';
import { createSearchEndpoint } from './endpoints/search.mjs';
import { createUpsertEndpoint } from './endpoints/upsert.mjs';
import { HttpError, json } from './http.mjs';
import { createStatements } from './statements.mjs';
import { createVectorBackend } from './vectors.mjs';

// WP-SS1: every response — success, 4xx, 5xx, and the OPTIONS preflight itself — carries the
// same CORS headers, so a browser/Electron-renderer `fetch` never treats an error response as a
// second, separate CORS failure on top of whatever status it already carries. `*` is acceptable
// specifically because this server binds loopback-only (src/search/AGENTS.md) and has no
// cookie/credential surface to leak — it is not a general CORS policy, just an unblock for our
// own renderer talking to our own loopback process.
function applyCorsHeaders(res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// The request handler: dependency wiring, the route table, the `receivedAt` stamp, and the
// one catch-all that maps a throw to a status. Split out of the single-file companion
// (WP-rem-R3) — everything an individual endpoint owns (its transaction, its body read, its
// deadline) now lives in that endpoint's own module, and nothing that was inside one branch
// moved out to a shared layer.
export function createRequestHandler(db, options = {}) {
	// The vector backend is injectable so a different implementation (or a test double) can
	// take over without touching a single line of the request handling below — that is the
	// seam doing its job.
	const vectors = options.vectors ?? createVectorBackend(db);
	// WP-3: injectable clock, same pattern as runSearch's own `now` option — production
	// always gets the real Date.now via the default, and a real-HTTP test can inject a
	// controlled clock so the sentAt/skew deadline math is deterministic instead of racing the
	// wall clock.
	const now = options.now ?? Date.now;
	// WP-4: injectable pause, same pattern and same reason as `now` above — production always
	// gets the real `setTimeout` promise, and a real-HTTP test can inject a stub that records the
	// requested duration and resolves immediately, so the interactive-yield/cumulative-cap tests
	// are deterministic instead of actually sleeping 1500ms+ per case.
	const delay = options.delay ?? sleepMs;
	// Handler-scoped, shared across every request this instance processes (not per-request
	// state) — the upsert flush loop needs to know whether a search landed *during this flush*,
	// and a search is necessarily a different request than the upsert. It was a closure `let`
	// in the single-file handler; a one-field holder is what carries that same sharing across a
	// module boundary. Read/written only through `now`, so it participates in the same
	// injected-clock determinism as the rest of the deadline math.
	const state = { lastInteractiveSearchAt: -Infinity };
	// One prepare pass per handler instance, exactly as before. Injectable for the same reason
	// `vectors` is: a test can hand in doubles without a real database.
	const statements = options.statements ?? createStatements(db);

	// The explicit method/path table that replaced the serial `if` ladder. Every route's
	// dependencies are named here, at the one place that knows all of them — an endpoint module
	// imports no ambient singleton, only its own pure helpers.
	const dispatch = createDispatcher({
		'GET /health': createHealthEndpoint({ vectors }),
		'POST /v1/index/reset': createResetEndpoint({ db, statements, vectors }),
		'POST /v1/chunks/delete': createChunksDeleteEndpoint({ db, statements, vectors }),
		'POST /v1/files/state': createFilesStateEndpoint({ statements }),
		'POST /v1/chunks/upsert': createUpsertEndpoint({ db, statements, vectors, now, delay, state }),
		'POST /v1/search': createSearchEndpoint({ db, statements, vectors, now, state }),
	});

	return async (req, res) => {
		// WP-3: captured as the FIRST statement of the request handler, before anything else —
		// including the URL parse, the route lookup and, inside a route, `await readJson`, which
		// is itself a yield point a queued upsert flush sub-batch can preempt. This is what lets
		// the /v1/search deadline account for the time a request spent waiting for this handler
		// to even start running, on top of whatever `sentAt` the client itself reports. It is
		// handed to the route as `request.receivedAt`; only /v1/search reads it.
		const receivedAt = now();
		// WP-SS1: the companion is loopback-only and answers only this plugin's own renderer, so
		// a permissive `Access-Control-Allow-Origin: *` costs nothing and is what lets
		// `src/search/client.ts` move the interactive search request onto an abortable `fetch` —
		// `requestUrl` (Obsidian's own transport, still used for every other endpoint) has no
		// AbortController and cannot be told to give up on a superseded request. Set via
		// `setHeader` (not `writeHead`) so it survives whichever status code a route eventually
		// answers with — `json()` in http.mjs calls `writeHead(status, {...})` afterwards, and
		// Node merges a `writeHead` header set with anything already set via `setHeader` rather
		// than replacing it.
		applyCorsHeaders(res);
		// A CORS preflight never reaches the route table — it carries no body and answers only
		// "is this method/these headers allowed", so it is handled here, before dispatch, rather
		// than as a seventh row in the strict ROUTE_IDS table (which asserts an exact match on
		// every table it wires and would need a real endpoint module for no real work).
		if (req.method === 'OPTIONS') {
			res.writeHead(204);
			res.end();
			return;
		}
		try {
			const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
			const route = dispatch.lookup(req.method, url.pathname);
			// A miss is a 404 — the same answer the ladder's fall-through gave, including for a
			// known path reached with the wrong method.
			if (!route) return json(res, 404, { ok: false, error: 'not found' });
			// `await` is load-bearing: without it a route's rejection would escape this try and
			// become an unhandled rejection instead of the 4xx/5xx mapping below.
			return await route(req, res, { receivedAt });
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			// A rejection the caller can fix keeps its own 4xx; everything else is a 500.
			// The client maps 5xx (only) to SearchServiceUnavailableError → "the companion is
			// not reachable", so answering a bad request with a 500 would send the user off to
			// restart a healthy container.
			const status = e instanceof HttpError ? e.status : 500;
			// Log before replying. Without this line a request that failed on its own merits is
			// indistinguishable from a down container, and `docker logs` on a perfectly healthy
			// companion shows nothing at all. That cost a long hunt during the first full rebuild.
			if (status >= 500) {
				console.error(`[crucible-search] ${req.method} ${req.url} failed: ${message}`);
				if (e instanceof Error && e.stack) console.error(e.stack);
			} else {
				console.error(`[crucible-search] ${req.method} ${req.url} rejected (${status}): ${message}`);
			}
			return json(res, status, { ok: false, error: message });
		}
	};
}
