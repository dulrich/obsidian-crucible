import type { App } from 'obsidian';
import type { XPostRow } from '../render/types';

interface RegistryEntry {
	url: string;
	sourceCount: number;
}

/** The slice of a `LinkRecord` (`orchestration/db/LinkRegistryStore.ts`) this pure
 * function reads — structural, so tests can pass plain objects. */
export interface XRegistryRecord {
	canonicalUrl: string;
	url: string;
	sourceNotes: readonly string[];
	xStatusId: string | null;
}

function resolveAuthor(fm: Record<string, unknown>): string | null {
	const author = fm['author'];
	if (typeof author === 'string' && author) return author;
	const handle = fm['author-handle'];
	if (typeof handle === 'string' && handle) return handle;
	return null;
}

// Newest-first numeric compare on X's snowflake status ids. Falls back to a plain
// string compare for anything that fails to parse as an integer (hand-edited
// frontmatter) rather than throwing — sort order degrading is fine, a crashed
// dashboard section is not.
function compareStatusIdDesc(a: string, b: string): number {
	try {
		const bigA = BigInt(a);
		const bigB = BigInt(b);
		if (bigA === bigB) return 0;
		return bigA > bigB ? -1 : 1;
	} catch {
		return b.localeCompare(a);
	}
}

/**
 * Pure row-compute for the "X posts" dashboard section (WP-XM4). Merges two
 * sources on statusId:
 *  - link-registry records (`link_records` rows with a non-empty x status id, read
 *    by the caller via `LinkRegistryStore.listWithXStatus`) — the pending set;
 *  - materialized `_x_metadata` notes under `metadataRoot` (frontmatter
 *    `status-id`; `state: 'ok' | 'unavailable'`, per `buildXMetadataNoteBody`/
 *    `buildXTombstoneNoteBody` in `orchestration/utils/xApi.ts`) — both live posts
 *    and tombstones live here, one note per status.
 *
 * A registry record with no matching metadata note is `pending` (nothing fetched
 * yet). A metadata note with no registry record still appears — link_scan is
 * manual-only, so a materialized post can easily outrun what's been scanned —
 * with `sourceCount: 0` since there is nothing to count.
 *
 * One vault-wide markdown scan finds the metadata notes by root prefix.
 */
export function computeXPostRows(app: App, registryRecords: readonly XRegistryRecord[], metadataRoot: string): XPostRow[] {
	const metadataPrefix = metadataRoot ? `${metadataRoot}/` : null;

	const registry = new Map<string, RegistryEntry>();
	const materialized = new Map<string, XPostRow>();

	for (const record of registryRecords) {
		const statusId = (record.xStatusId ?? '').trim();
		if (!statusId) continue;
		registry.set(statusId, { url: record.canonicalUrl || record.url || '', sourceCount: record.sourceNotes.length });
	}

	for (const file of app.vault.getMarkdownFiles()) {
		if (metadataPrefix && file.path.startsWith(metadataPrefix)) {
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm) continue;
			const statusId = typeof fm['status-id'] === 'string' ? fm['status-id'].trim() : '';
			if (!statusId) continue;
			const url = typeof fm['url'] === 'string' && fm['url'] ? fm['url'] : '';
			materialized.set(statusId, {
				statusId,
				url,
				author: resolveAuthor(fm),
				state: fm['state'] === 'unavailable' ? 'unavailable' : 'materialized',
				// Backfilled from the registry below when a matching record exists;
				// a materialized note with no citing registry record stays 0.
				sourceCount: 0,
				metadataFile: file,
			});
		}
	}

	const rows = new Map<string, XPostRow>(materialized);
	for (const [statusId, entry] of registry) {
		const existing = rows.get(statusId);
		if (existing) {
			existing.sourceCount = entry.sourceCount;
			if (!existing.url) existing.url = entry.url;
			continue;
		}
		rows.set(statusId, {
			statusId,
			url: entry.url,
			author: null,
			state: 'pending',
			sourceCount: entry.sourceCount,
			metadataFile: null,
		});
	}

	return Array.from(rows.values()).sort((a, b) => {
		const aPending = a.state === 'pending';
		const bPending = b.state === 'pending';
		if (aPending !== bPending) return aPending ? -1 : 1;
		return compareStatusIdDesc(a.statusId, b.statusId);
	});
}
