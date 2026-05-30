/**
 * The single place in `src/` where `console.*` is allowed.
 *
 * Crucible keeps the developer console quiet by default — an Obsidian plugin
 * should not spam the user's console during normal operation. Every site that
 * used to call `console.warn` / `console.error` directly now routes through
 * `logWarn` / `logError`, so `grep -rn "console\." src/` matches only this file.
 *
 * Logging is gated: nothing is written unless debug output is enabled, either
 * programmatically via `setCrucibleDebug(true)` or, for live troubleshooting in
 * an installed vault, by setting `window.__CRUCIBLE_DEBUG__ = true` in the
 * developer console.
 */

let forced: boolean | null = null;

export function setCrucibleDebug(enabled: boolean): void {
	forced = enabled;
}

function debugEnabled(): boolean {
	if (forced !== null) return forced;
	return (globalThis as { __CRUCIBLE_DEBUG__?: boolean }).__CRUCIBLE_DEBUG__ === true;
}

export function logWarn(context: string, ...details: unknown[]): void {
	if (!debugEnabled()) return;
	console.warn(`[crucible] ${context}`, ...details);
}

export function logError(context: string, ...details: unknown[]): void {
	if (!debugEnabled()) return;
	console.error(`[crucible] ${context}`, ...details);
}
