import type { WorkflowContext } from '../workflows/Workflow';
import type { CanonicalizedUrl } from './urlCanonicalize';

/**
 * WP-J3: the per-URL link-registry writer shared by the vault-wide `link_scan`
 * workflow and the note-level `note_link_enrich` workflow. Since
 * link-registry-out-of-vault WP-1 records live in the `link_records` table of the jobs
 * DB (`LinkRegistryStore`), not in vault notes.
 */
export interface AggregateEntry {
	canon: CanonicalizedUrl;
	sourceWikilinks: Set<string>;
}

/** `[[path/without/extension]]` — the wikilink shape both workflows record into a
 * link-record's `source_notes`. Exported so a caller doesn't need to know the
 * ".md"-stripping rule to build one for its own note. */
export function wikilinkFor(path: string): string {
	return `[[${stripMdExt(path)}]]`;
}

export function stripMdExt(path: string): string {
	return path.endsWith('.md') ? path.slice(0, -3) : path;
}

/**
 * Create-or-merge one link record in the `link_records` table
 * (link-registry-out-of-vault WP-1 — the registry no longer writes vault notes). The
 * merge semantics live in `LinkRegistryStore.upsert`/`mergeLinkRecord`; `created` /
 * `candidateFlagged` mean exactly what they did for the frontmatter writer. `path` is
 * the record key (the canonical URL), not a vault path. `changed: false` means the
 * upsert was a no-op. Throws `SqliteUnavailableError` (via `linkRegistry()`) when the
 * DB is unavailable — the calling workflow run fails with it; there is no vault
 * fallback.
 */
export function applyLinkToRegistry(
	plugin: WorkflowContext['plugin'],
	today: string,
	entry: AggregateEntry,
): { path: string; created: boolean; candidateFlagged: boolean; changed: boolean } {
	const canon = entry.canon;
	const result = plugin.orchestrator.linkRegistry().upsert({
		canonicalUrl: canon.canonical,
		url: canon.url,
		domain: canon.domain,
		sourceNotes: entry.sourceWikilinks,
		firstSeen: today,
		lastSeen: today,
		state: 'pending',
		discoveryMethod: 'scan',
		trackedSource: canon.trackedSource ? 'candidate' : false,
		trackedSourceType: canon.trackedSource?.type ?? null,
		ytVideoId: canon.youtubeVideoId ?? null,
		xStatusId: canon.xStatusId ?? null,
	});
	return { path: canon.canonical, ...result };
}

/** Emits `link-registry-changed` once for a whole workflow run, only when the run
 * changed at least one record. */
export function emitLinkRegistryChanged(plugin: WorkflowContext['plugin'], changed: number): void {
	if (changed <= 0) return;
	plugin.ingestionEvents?.emit('link-registry-changed', { changed });
}

/** Normalizes a raw exclusion-folder list (trims, drops empties/trailing slashes).
 * Records live in the `link_records` table, not the vault, so there is no registry
 * folder to self-exclude; a stray legacy stub is skipped by its `type: link-record`. */
export function normalizeExclusions(raw: string[]): string[] {
	const out = new Set<string>();
	for (const item of raw) {
		const trimmed = item.trim().replace(/\/+$/, '');
		if (trimmed) out.add(trimmed);
	}
	return Array.from(out);
}

/** `path` is `excl` or a descendant of it, for any `excl` in `exclusions`. Verbatim
 * lift from `LinkScanWorkflow`; also reused by `LinkNoteEnrichWorkflow`'s refusal
 * guard (metadata/registry roots, not user-configured exclusions, but the same
 * path-prefix test). */
export function isExcluded(path: string, exclusions: string[]): boolean {
	for (const excl of exclusions) {
		if (path === excl) return true;
		if (path.startsWith(`${excl}/`)) return true;
	}
	return false;
}
