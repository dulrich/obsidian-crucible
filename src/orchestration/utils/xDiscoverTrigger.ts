import { normalizePath } from 'obsidian';

// Pure guard for the `x-discover-on-clip` founding trigger (WP-XM3), factored
// out of `main.ts` so the folder-prefix-with-boundary logic — the part with a
// real off-by-one hazard — is unit-testable without bundling the whole trigger
// registration. `TriggerRegistry.fireEvent` already filters to `.md` before any
// guard runs; the `extension` check here is defense-in-depth (and lets the pure
// helper be tested end-to-end on its own, including the non-md case) rather than
// load-bearing.

/** The minimal file shape the guard needs — deliberately not `TFile`, so this
 * stays callable from plain-object tests without an obsidian stub. */
export interface XDiscoverTriggerFile {
	path: string;
	extension: string;
}

export interface XDiscoverTriggerSettings {
	ingestionClipperInboxFolder: string;
	ingestionXAutoDiscoverEnabled: boolean;
}

/**
 * True when `path` is `folder` itself or lives anywhere under it. Boundary is
 * enforced with a trailing `/` on the prefix so `_clippings/inbox` does not
 * match `_clippings/inboxes/x.md` — a naive `path.startsWith(folder)` would.
 */
export function isPathUnderFolder(path: string, folder: string): boolean {
	const root = normalizePath(folder ?? '').replace(/\/+$/, '');
	if (!root) return false;
	const normalized = normalizePath(path ?? '');
	if (normalized === root) return true;
	return normalized.startsWith(`${root}/`);
}

/**
 * The `x-discover-on-clip` sync guard: markdown file, under the clipper inbox
 * folder (prefix + boundary), and the auto-discover setting is on — all three
 * read live off `settings` at call time, never captured at registration.
 */
export function shouldFireXDiscoverOnClip(file: XDiscoverTriggerFile, settings: XDiscoverTriggerSettings): boolean {
	if (file.extension !== 'md') return false;
	if (settings.ingestionXAutoDiscoverEnabled !== true) return false;
	return isPathUnderFolder(file.path, settings.ingestionClipperInboxFolder);
}
