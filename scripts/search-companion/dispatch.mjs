// The method/path dispatcher. Split out of the single-file companion (WP-rem-R3), which
// resolved routes with a serial ladder of `if (req.method === 'POST' && url.pathname === …)`
// branches inside one 473-line handler.
//
// Deliberately a plain frozen table plus a Map lookup — no framework, no pattern matching, no
// generic route magic. Three properties the ladder had that this must keep:
//
//   1. **Exact (method, path) equality.** No prefixes, no params, no trailing-slash tolerance:
//      `POST /v1/search/` was a 404 before and is a 404 now. Every key is one literal method
//      and one literal pathname, so the Map lookup is the same test the ladder made, in the
//      same order-independent way (the route keys are mutually exclusive, so ladder order was
//      never load-bearing).
//   2. **A miss is a 404, not a 405.** A GET to a POST-only path answered "not found" before;
//      keying on `METHOD path` rather than on path-then-method preserves that exactly.
//   3. **The body is read by the route, not by the dispatcher.** Hoisting `readJson` up here
//      would read a body for `/health` (which reads none today) and would move the read
//      relative to the handler's `receivedAt` stamp — the deadline's whole starting point.
//      The dispatcher resolves a handler and nothing else.
export const ROUTE_IDS = Object.freeze([
	'GET /health',
	'POST /v1/index/reset',
	'POST /v1/chunks/delete',
	'POST /v1/files/state',
	'POST /v1/chunks/upsert',
	'POST /v1/search',
	'POST /v1/paths',
]);

export function routeId(method, pathname) {
	return `${method} ${pathname}`;
}

// `routes` must name exactly ROUTE_IDS — no more, no less. A typo in a route key would
// otherwise be a silent 404 on a live endpoint, which is precisely the failure the explicit
// table exists to make impossible; failing at handler-construction time makes it a startup
// error instead of a runtime mystery.
export function createDispatcher(routes) {
	const keys = Object.keys(routes);
	const missing = ROUTE_IDS.filter(id => !keys.includes(id));
	const unknown = keys.filter(key => !ROUTE_IDS.includes(key));
	if (missing.length > 0 || unknown.length > 0) {
		throw new Error(`route table mismatch — missing: [${missing.join(', ')}], unknown: [${unknown.join(', ')}]`);
	}
	const table = new Map(ROUTE_IDS.map(id => [id, routes[id]]));
	return {
		ids: ROUTE_IDS,
		lookup(method, pathname) {
			return table.get(routeId(method, pathname)) ?? null;
		},
	};
}
