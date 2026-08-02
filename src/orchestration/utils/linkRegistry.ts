import { TFile } from 'obsidian';
import type { WorkflowContext } from '../workflows/Workflow';
import { updateFrontmatter } from '../../frontmatter';
import { CanonicalizedUrl, shortHash } from './urlCanonicalize';

/**
 * WP-J3: the per-URL link-registry writer, lifted verbatim out of
 * `LinkScanWorkflow.applyToRegistry` so both the vault-wide `link_scan` workflow and
 * the new note-level `note_link_enrich` workflow write the same record shape through
 * one function. `LinkScanWorkflow`'s own two-pass structure, its notes string, and
 * WP-J1's progress calls are untouched — only the call site changed, from a private
 * method invocation to an imported function call with the same arguments in the same
 * order. Nothing in the body was reworded or reordered, so vault-level `link_scan`
 * output (frontmatter keys, key order within `updateFrontmatter`, the create-vs-merge
 * branch, the disambiguation-suffix path) is byte-identical to before the lift.
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

/** Create-or-merge one link-record note for `entry`, under `root`. */
export async function applyLinkToRegistry(
	plugin: WorkflowContext['plugin'],
	root: string,
	today: string,
	entry: AggregateEntry,
): Promise<{ path: string; created: boolean; candidateFlagged: boolean }> {
	const app = plugin.app;
	const targetPath = await resolveTargetPath(app, root, entry.canon);

	const existing = app.vault.getAbstractFileByPath(targetPath);
	if (existing instanceof TFile) {
		let candidateFlagged = false;
		await updateFrontmatter(app, existing, (fm) => {
			const merged = mergeSourceNotes(fm['source_notes'], entry.sourceWikilinks);
			fm['type'] = 'link-record';
			fm['url'] = entry.canon.url;
			fm['canonical_url'] = entry.canon.canonical;
			fm['domain'] = entry.canon.domain;
			fm['source_notes'] = merged;
			if (typeof fm['first_seen'] !== 'string' || !fm['first_seen']) fm['first_seen'] = today;
			fm['last_seen'] = today;
			if (typeof fm['state'] !== 'string' || !fm['state']) fm['state'] = 'pending';
			if (typeof fm['discovery_method'] !== 'string' || !fm['discovery_method']) fm['discovery_method'] = 'scan';
			ensureNullableKeys(fm);
			if (entry.canon.youtubeVideoId) {
				const current = fm['yt-video-id'];
				if (typeof current !== 'string' || !current) fm['yt-video-id'] = entry.canon.youtubeVideoId;
			}
			if (entry.canon.xStatusId) {
				const current = fm['x-status-id'];
				if (typeof current !== 'string' || !current) fm['x-status-id'] = entry.canon.xStatusId;
			}
			if (entry.canon.trackedSource) {
				if (fm['tracked_source'] === false || fm['tracked_source'] === undefined || fm['tracked_source'] === null) {
					fm['tracked_source'] = 'candidate';
					fm['tracked_source_type'] = entry.canon.trackedSource.type;
					candidateFlagged = true;
				}
			}
		});
		return { path: targetPath, created: false, candidateFlagged };
	}

	const stub = `# Link: ${entry.canon.url}\n\n## Notes\n`;
	const file = await app.vault.create(targetPath, stub);
	let candidateFlagged = false;
	await updateFrontmatter(app, file, (fm) => {
		fm['type'] = 'link-record';
		fm['url'] = entry.canon.url;
		fm['canonical_url'] = entry.canon.canonical;
		fm['domain'] = entry.canon.domain;
		fm['state'] = 'pending';
		fm['source_notes'] = Array.from(entry.sourceWikilinks);
		fm['first_seen'] = today;
		fm['last_seen'] = today;
		fm['discovery_method'] = 'scan';
		fm['tracked_source'] = false;
		fm['tracked_source_type'] = null;
		fm['tracked_source_note'] = null;
		fm['referred_material'] = null;
		fm['decision_reason'] = null;
		fm['yt-video-id'] = entry.canon.youtubeVideoId ?? null;
		fm['x-status-id'] = entry.canon.xStatusId ?? null;
		if (entry.canon.trackedSource) {
			fm['tracked_source'] = 'candidate';
			fm['tracked_source_type'] = entry.canon.trackedSource.type;
			candidateFlagged = true;
		}
	});
	return { path: targetPath, created: true, candidateFlagged };
}

async function resolveTargetPath(
	app: WorkflowContext['plugin']['app'],
	root: string,
	canon: CanonicalizedUrl,
): Promise<string> {
	const baseSlug = canon.filename;
	let candidate = `${root}/${baseSlug}.md`;
	const existing = app.vault.getAbstractFileByPath(candidate);
	if (!(existing instanceof TFile)) return candidate;

	const fm = app.metadataCache.getFileCache(existing)?.frontmatter;
	const existingCanonical = typeof fm?.['canonical_url'] === 'string' ? fm['canonical_url'] : '';
	if (existingCanonical === canon.canonical) return candidate;

	const suffix = shortHash(canon.canonical);
	candidate = `${root}/${baseSlug}-${suffix}.md`;
	return candidate;
}

function mergeSourceNotes(existing: unknown, additions: Set<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	if (Array.isArray(existing)) {
		for (const v of existing) {
			if (typeof v === 'string' && v.trim() && !seen.has(v)) {
				seen.add(v);
				out.push(v);
			}
		}
	} else if (typeof existing === 'string' && existing.trim()) {
		seen.add(existing);
		out.push(existing);
	}
	for (const v of additions) {
		if (!seen.has(v)) {
			seen.add(v);
			out.push(v);
		}
	}
	return out;
}

function ensureNullableKeys(fm: Record<string, unknown>): void {
	const nullable = ['tracked_source_note', 'referred_material', 'decision_reason'];
	for (const key of nullable) {
		if (!(key in fm)) fm[key] = null;
	}
	if (!('tracked_source' in fm)) fm['tracked_source'] = false;
	if (!('tracked_source_type' in fm)) fm['tracked_source_type'] = null;
	if (!('yt-video-id' in fm)) fm['yt-video-id'] = null;
	if (!('x-status-id' in fm)) fm['x-status-id'] = null;
}

/** Normalizes a raw exclusion-folder list (trims, drops empties/trailing slashes) and
 * always folds in `registryRoot` itself — the registry must never scan its own
 * records. Verbatim lift from `LinkScanWorkflow`. */
export function normalizeExclusions(raw: string[], registryRoot: string): string[] {
	const out = new Set<string>();
	for (const item of raw) {
		const trimmed = item.trim().replace(/\/+$/, '');
		if (trimmed) out.add(trimmed);
	}
	out.add(registryRoot.replace(/\/+$/, ''));
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
