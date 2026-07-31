// HTTP plumbing shared by every endpoint: the status-carrying error type, the request-body
// reader, the JSON responder and the required-string guard. Split out of the single-file
// companion (WP-rem-R3) so an endpoint module can depend on the wire contract without
// depending on the schema, the ranking legs, or the server bootstrap.
//
// Zero-dependency, like every module under this directory: Node builtins only.

// An error whose HTTP status is part of the contract. Everything else falls through to a
// 500. The distinction matters: `SearchServiceClient` turns *any* 5xx into
// SearchServiceUnavailableError, which the UI renders as "the companion is not reachable —
// start it with home-compose up crucible-search". A malformed request answered with a 500
// therefore sends the user to restart a container that is perfectly healthy, so every
// request-side rejection (a bad vector, a width conflict) must be a 4xx.
export class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
	}
}

// F5: malformed input is a 4xx, never a 5xx — the request handler's catch-all maps anything
// that is not an HttpError to 500, and the client maps any 5xx to SearchServiceUnavailableError
// ("companion not reachable"), which the caller then defers and retries forever. A too-large or
// unparseable body, or a missing required field, is a client bug, not a companion outage, so
// every rejection below is an explicit HttpError(400) rather than a plain Error.
export function readJson(req) {
	return new Promise((resolveBody, reject) => {
		let raw = '';
		req.setEncoding('utf8');
		req.on('data', chunk => {
			raw += chunk;
			if (raw.length > 20_000_000) reject(new HttpError(400, 'request body too large'));
		});
		req.on('end', () => {
			try {
				resolveBody(raw ? JSON.parse(raw) : {});
			} catch (e) {
				reject(new HttpError(400, `invalid JSON body: ${e instanceof Error ? e.message : String(e)}`));
			}
		});
		req.on('error', reject);
	});
}

export function json(res, status, body) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

export function requireString(value, name) {
	if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `Missing ${name}`);
	return value.trim();
}
