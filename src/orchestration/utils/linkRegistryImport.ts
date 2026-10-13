import { normalizePath } from 'obsidian';
import type { App } from 'obsidian';
import type { LinkRecordInput, LinkRegistryStore } from '../db/LinkRegistryStore';
import { extractXStatusFromUrl } from './xPost';

/**
 * link-registry-out-of-vault WP-2: one-time import of the legacy note-per-URL link
 * registry (`type: link-record` stubs under `orchestrationLinkRegistryRoot`) into the
 * `link_records` table, plus a read-only reconciliation check. Both are READ-ONLY
 * against the vault: frontmatter comes from `metadataCache` only, no body reads, no
 * writes, no folder deletion (archiving the folder is a user-held step).
 */

export interface LinkRegistrySkip {
	path: string;
	reason: string;
}

export interface LinkRegistryImportResult {
	scanned: number;
	imported: number;
	merged: number;
	unchanged: number;
	skipped: LinkRegistrySkip[];
}

export interface LinkRegistryMismatch {
	path: string;
	canonicalUrl: string;
	reasons: string[];
}

export interface LinkRegistryReconcileResult {
	matched: number;
	mismatched: LinkRegistryMismatch[];
	skipped: LinkRegistrySkip[];
	/** Store rows whose canonical URL has no legacy stub (written after cut-over) —
	 * informational, never a mismatch. */
	postCutover: number;
}

type ImportApp = Pick<App, 'vault' | 'metadataCache'>;

interface ParsedStub {
	path: string;
	input: LinkRecordInput;
}

function str(v: unknown): string | null {
	return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function strOrNum(v: unknown): string | null {
	if (typeof v === 'number' && Number.isFinite(v)) return String(v);
	return str(v);
}

function sourceNotesOf(v: unknown): string[] {
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
	return typeof v === 'string' && v.trim() !== '' ? [v] : [];
}

function validDate(v: unknown): string | null {
	return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v : null;
}

/** Walks the legacy root and parses each stub's frontmatter; every non-stub carries
 * a path + reason skip. */
export function collectLegacyStubs(app: ImportApp, registryRoot: string): { scanned: number; stubs: ParsedStub[]; skipped: LinkRegistrySkip[] } {
	const prefix = `${normalizePath(registryRoot).replace(/\/+$/, '')}/`;
	const stubs: ParsedStub[] = [];
	const skipped: LinkRegistrySkip[] = [];
	let scanned = 0;
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(prefix)) continue;
		scanned++;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		if (!fm) {
			skipped.push({ path: file.path, reason: 'no frontmatter' });
			continue;
		}
		if (fm.type !== 'link-record') {
			skipped.push({ path: file.path, reason: `type is not link-record (${String(fm.type)})` });
			continue;
		}
		const canonicalUrl = str(fm.canonical_url);
		if (!canonicalUrl) {
			skipped.push({ path: file.path, reason: 'missing canonical_url' });
			continue;
		}
		// A string id wins; otherwise the URL-derived id beats a YAML-parsed number (a
		// 19-digit X status id exceeds 2^53 and would arrive precision-corrupted).
		const xStatusId = str(fm['x-status-id'])
			?? extractXStatusFromUrl(canonicalUrl)?.statusId
			?? strOrNum(fm['x-status-id']);
		stubs.push({
			path: file.path,
			input: {
				canonicalUrl,
				url: str(fm.url) ?? canonicalUrl,
				domain: str(fm.domain) ?? undefined,
				sourceNotes: sourceNotesOf(fm.source_notes),
				firstSeen: str(fm.first_seen),
				lastSeen: str(fm.last_seen),
				state: str(fm.state),
				discoveryMethod: str(fm.discovery_method),
				trackedSource: fm.tracked_source,
				trackedSourceType: str(fm.tracked_source_type),
				trackedSourceNote: str(fm.tracked_source_note),
				referredMaterial: str(fm.referred_material),
				decisionReason: str(fm.decision_reason),
				ytVideoId: strOrNum(fm['yt-video-id']),
				xStatusId,
			},
		});
	}
	return { scanned, stubs, skipped };
}

/**
 * Upserts every legacy stub through the store's reconciling merge inside ONE
 * transaction. Idempotent: a second run reports 0 imported / 0 merged. The caller
 * emits the coalesced `link-registry-changed` event (via `onChanged`) once, after
 * commit.
 */
export function importLegacyLinkRegistry(
	app: ImportApp,
	store: LinkRegistryStore,
	registryRoot: string,
	onChanged?: (changed: number) => void,
): LinkRegistryImportResult {
	const { scanned, stubs, skipped } = collectLegacyStubs(app, registryRoot);
	let imported = 0;
	let merged = 0;
	let unchanged = 0;
	store.transaction(() => {
		for (const stub of stubs) {
			const r = store.upsert(stub.input);
			if (r.created) imported++;
			else if (r.changed) merged++;
			else unchanged++;
		}
	});
	onChanged?.(imported + merged);
	return { scanned, imported, merged, unchanged, skipped };
}

/** Per-key check that every parseable legacy stub is represented in the store. */
export function reconcileLegacyLinkRegistry(
	app: ImportApp,
	store: LinkRegistryStore,
	registryRoot: string,
): LinkRegistryReconcileResult {
	const { stubs, skipped } = collectLegacyStubs(app, registryRoot);
	const legacyKeys = new Set<string>();
	const mismatched: LinkRegistryMismatch[] = [];
	let matched = 0;
	for (const { path, input } of stubs) {
		legacyKeys.add(input.canonicalUrl);
		const row = store.get(input.canonicalUrl);
		const reasons: string[] = [];
		if (!row) {
			reasons.push('no store row');
		} else {
			const have = new Set(row.sourceNotes);
			const missing = [...(input.sourceNotes ?? [])].filter(n => !have.has(n));
			if (missing.length) reasons.push(`source_notes missing: ${missing.join(', ')}`);
			const fs = validDate(input.firstSeen);
			if (fs && !(validDate(row.firstSeen) && (row.firstSeen as string) <= fs)) {
				reasons.push(`first_seen ${String(row.firstSeen)} > stub ${fs}`);
			}
			const ls = validDate(input.lastSeen);
			if (ls && !(validDate(row.lastSeen) && (row.lastSeen as string) >= ls)) {
				reasons.push(`last_seen ${String(row.lastSeen)} < stub ${ls}`);
			}
			if (input.xStatusId && !str(row.xStatusId)) reasons.push('x_status_id missing');
		}
		if (reasons.length) mismatched.push({ path, canonicalUrl: input.canonicalUrl, reasons });
		else matched++;
	}
	let postCutover = 0;
	for (const row of store.listAll()) if (!legacyKeys.has(row.canonicalUrl)) postCutover++;
	return { matched, mismatched, skipped, postCutover };
}
