import type CruciblePlugin from '../main';
import { ensureFolder } from '../utils';
import { confirmDestructive } from '../settings/destructiveActions';
import { computeReferencedImagePaths } from '../orchestration/utils/imageDescribe';
import {
	AuditImage,
	computeSearchAudit,
	identifyAuditCandidates,
	ReconcileEnqueueSummaryInput,
	SearchAuditResult,
} from './audit';

/**
 * WP-H3: I/O-side companion to the pure `src/search/audit.ts` — everything here touches the
 * vault, the companion client, the orchestrator queue, or a confirm modal, so it lives in its
 * own module rather than inside `audit.ts` (which `tests/searchAudit.test.mjs` bundles and
 * asserts carries no `obsidian` import anywhere in its graph). Extracted verbatim (zero behavior
 * change) from `src/commands.ts`'s private `runSearchAudit`/`gatherSearchAuditImages`/
 * `writeSearchAuditReportNote`, plus a new `enqueueSearchRepairs` pulled out of the inline
 * `search-reconcile-index` body — both `search-audit-index` and `search-reconcile-index` in
 * `src/commands.ts` import from here.
 */

/**
 * WP-SA2: gathers every input `computeSearchAudit` (`src/search/audit.ts`) needs and runs it.
 * Shared by `search-audit-index` (read-only) and `search-reconcile-index` (acts on the result) so
 * the two commands can never disagree about what "clean" means.
 *
 * WP-G2: candidates needing hash/chunk-count verification are named FIRST via
 * `identifyAuditCandidates` — the same function `computeSearchAudit` uses internally, so the two
 * can't disagree about what counts as a candidate — and only THAT subset is read/hashed/chunked
 * (`SearchManager.auditPrepareFile`, the real index-write path). This is the perf requirement: a
 * vault with 21 mtime-suspect files out of 5,500 reads exactly 21, never the whole vault. Audit
 * stays read-only throughout — `auditPrepareFile` only reads the vault and runs the chunker, it
 * never touches the companion.
 */
export async function runSearchAudit(plugin: CruciblePlugin): Promise<SearchAuditResult> {
	const vaultFileList = plugin.searchManager.listIndexableFiles();
	const vaultFiles = vaultFileList.map(file => ({ path: file.path, mtime: file.stat.mtime }));
	const { paths: indexedPaths } = await plugin.searchManager.client().listPaths();
	const images = await gatherSearchAuditImages(plugin);

	const candidates = identifyAuditCandidates(vaultFiles, indexedPaths);
	const filesByPath = new Map(vaultFileList.map(file => [file.path, file]));
	const missingCandidates = new Set(candidates.missing);
	const staleCandidates = new Set(candidates.staleMtime);
	const staleContentHashes = new Map<string, string>();
	const missingChunkCounts = new Map<string, number>();
	for (const path of [...missingCandidates, ...staleCandidates]) {
		const file = filesByPath.get(path);
		if (!file) continue;
		const prepared = await plugin.searchManager.auditPrepareFile(file);
		if (!prepared) continue;
		if (staleCandidates.has(path)) staleContentHashes.set(path, prepared.contentHash);
		if (missingCandidates.has(path)) missingChunkCounts.set(path, prepared.chunkCount);
	}

	return computeSearchAudit({
		vaultFiles,
		indexedPaths,
		images,
		semanticEnabled: plugin.settings.searchSemanticEnabled,
		staleContentHashes,
		missingChunkCounts,
	});
}

/**
 * Crosses `computeReferencedImagePaths` (every image a resolved link in the vault points at)
 * against the image-description store's status for each — without launching a vision run.
 * `has()` alone can't distinguish a described image from a poisoned `kind: 'failed'` one (both
 * are present in the store's index), so a referenced+present image needs one `get()` to read its
 * `kind`; a referenced+absent image is `'pending'` at no extra read.
 */
async function gatherSearchAuditImages(plugin: CruciblePlugin): Promise<AuditImage[]> {
	const referenced = computeReferencedImagePaths(plugin);
	await plugin.imageDescriptions.ensureLoaded();
	const images: AuditImage[] = [];
	for (const image of referenced) {
		if (!plugin.imageDescriptions.has(image.md5)) {
			images.push({ md5: image.md5, status: 'pending' });
			continue;
		}
		const record = await plugin.imageDescriptions.get(image.md5);
		images.push({ md5: image.md5, status: record?.kind === 'failed' ? 'failed' : 'described' });
	}
	return images;
}

/**
 * Overwrite-per-run report note at `_crucible/search-audit.md` (`_crucible` is search-excluded by
 * default, and is the same folder the Localize/Chain debug flow's shared debug note lives in —
 * see `appendDebugLog`). Deliberately NOT that shared append-only log: an audit report is a
 * point-in-time snapshot a user re-runs and re-reads, not a growing history, so overwriting keeps
 * it from accreting into an ever-longer file the way a per-run append would.
 */
export async function writeSearchAuditReportNote(plugin: CruciblePlugin, content: string): Promise<string> {
	const path = '_crucible/search-audit.md';
	const existing = plugin.app.vault.getFileByPath(path);
	if (existing) {
		await plugin.app.vault.modify(existing, content);
	} else {
		const folderPath = path.substring(0, path.lastIndexOf('/'));
		if (folderPath) await ensureFolder(plugin.app, folderPath);
		await plugin.app.vault.create(path, content);
	}
	return path;
}

export interface SearchRepairTargets {
	upsertPaths: string[];
	orphanPaths: string[];
}

/**
 * WP-H3: extracted from `search-reconcile-index`'s inline body (`src/commands.ts`) — identical
 * job types/params, dedupe accounting, and the orphan confirm gate, now reusable by a future
 * caller (H4's Ingestion-Dashboard section) without re-enqueuing hand-rolled loops.
 *
 * Mutates ONLY by enqueueing existing job types (`search_upsert_file` for `upsertPaths`,
 * `search_delete_path` for `orphanPaths`) — never a direct index write, never a new job type. The
 * orphan-deletion half is destructive (it removes rows for paths the companion holds that the
 * vault no longer has) and routes through `confirmDestructive('search-reconcile-orphans', …)`,
 * skipped entirely when `orphanPaths` is empty — matching today's `search-reconcile-index` flow
 * exactly: the confirm modal appears only when there is something destructive to confirm, and
 * only after the (non-destructive) upserts have already been enqueued.
 */
export async function enqueueSearchRepairs(plugin: CruciblePlugin, targets: SearchRepairTargets): Promise<ReconcileEnqueueSummaryInput> {
	// Dedupe-hit detection: `DbJobBackend.enqueue` returns the EXISTING job (its original
	// `created` stamp) on a dedupe hit, and a freshly minted job's `created` is stamped via
	// `nowIso()` at insert time — so any job whose `created` is at or after this run's own start
	// timestamp was newly minted, and anything older was already queued. Both are ISO-8601
	// (`nowIso()`), so lexicographic comparison is chronological comparison. Cheaper and more
	// robust than tracking `countJobs` deltas (which would race concurrent auto-sources) or
	// diffing ids.
	const startedAt = new Date().toISOString();

	let upsertNew = 0;
	let upsertDeduped = 0;
	for (const path of targets.upsertPaths) {
		const job = await plugin.orchestrator.enqueue('search_upsert_file', { path }, { priority: 'low', lane: 'user', inputPaths: [path] });
		if (!job) continue;
		if (job.created >= startedAt) upsertNew++; else upsertDeduped++;
	}

	let deleteNew = 0;
	let deleteDeduped = 0;
	let orphansDeclined = false;
	if (targets.orphanPaths.length > 0) {
		const preview = targets.orphanPaths.slice(0, 10).map(p => `- ${p}`);
		if (targets.orphanPaths.length > preview.length) preview.push(`- …and ${targets.orphanPaths.length - preview.length} more`);
		const confirmed = await confirmDestructive(plugin.app, plugin.settings, 'search-reconcile-orphans', {
			message: `Delete ${targets.orphanPaths.length} orphaned path${targets.orphanPaths.length === 1 ? '' : 's'} from the search index? `
				+ 'These paths are indexed but no longer exist in the vault (deleted, moved, or now excluded).',
			impact: preview,
		});
		if (confirmed) {
			for (const path of targets.orphanPaths) {
				const job = await plugin.orchestrator.enqueue('search_delete_path', { path }, { priority: 'low', lane: 'user' });
				if (!job) continue;
				if (job.created >= startedAt) deleteNew++; else deleteDeduped++;
			}
		} else {
			orphansDeclined = true;
		}
	}

	return {
		upserts: { newCount: upsertNew, dedupedCount: upsertDeduped },
		deletes: { newCount: deleteNew, dedupedCount: deleteDeduped },
		orphansDeclined,
	};
}
