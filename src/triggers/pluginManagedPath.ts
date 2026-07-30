/**
 * True when `path` sits inside one of `roots` — either equal to a root or a
 * descendant of it (`root/...`). Mirrors the ingestion dashboard's queue-root
 * guard (`ingestionDashboard.ts` `route()`) verbatim in shape, extracted as a
 * standalone pure function so `TriggerRegistry`'s exclusion chokepoints and a
 * later match-volume estimator (trigger validation UI) share one predicate
 * instead of drifting apart.
 */
export function isPluginManagedPath(path: string, roots: readonly string[]): boolean {
	for (const root of roots) {
		if (!root) continue;
		if (path === root || path.startsWith(`${root}/`)) return true;
	}
	return false;
}
