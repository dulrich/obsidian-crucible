// Coalesces a redundant event-driven refresh that a self-initiated write is expected
// to trigger a moment later. Concretely: the Ignore/Unignore button handlers
// (render/cells.ts) await a write to the shared ignored-IDs note
// (orchestration/utils/ignoredIds.ts) and then immediately, synchronously re-render
// the section(s) that write affects. But that same write also fires a vault/
// metadataCache event that the Ingestion Dashboard's own listener (`route()` in
// ingestionDashboard.ts) is watching, which — without this — schedules a SECOND,
// purely redundant re-render of data that's already current: the "Ignore flashes and
// re-renders twice" bug (scroll preservation was never the issue; the double render
// was).
//
// Call `markSelfRefreshedForEcho(id)` synchronously right after the write resolves
// and the section has been (or is about to be) manually refreshed. Call
// `consumeSelfRefreshedEcho(id)` from the event-routing path immediately before it
// would otherwise schedule its own refresh for the same id: a `true` result means
// this is that expected echo — skip the scheduled refresh — and consumes the marker
// so it only suppresses once. A `false` result (no marker, or an expired one) means
// proceed normally; this is a distinct, unrelated event.
//
// One-shot and self-expiring by design: a marker that never gets echoed (e.g. a
// future Obsidian version that doesn't fire the event this write currently triggers)
// would otherwise sit forever and silently swallow a later, genuinely unrelated
// change to the same id. `ECHO_SUPPRESS_WINDOW_MS` is generous relative to the
// dashboard's own SCAN_DEBOUNCE_MS (1000ms) so the expected echo is never mistaken
// for stale.
const ECHO_SUPPRESS_WINDOW_MS = 5000;

const pendingEchoes = new Map<string, number>();

export function markSelfRefreshedForEcho(id: string): void {
	pendingEchoes.set(id, Date.now() + ECHO_SUPPRESS_WINDOW_MS);
}

export function consumeSelfRefreshedEcho(id: string): boolean {
	const expiry = pendingEchoes.get(id);
	if (expiry === undefined) return false;
	pendingEchoes.delete(id);
	return Date.now() < expiry;
}
