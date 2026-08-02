/**
 * WP-SA2: pure compute for `Search: audit index` / `Search: reconcile index`
 * (`src/commands.ts`). This module owns none of the I/O — no Obsidian imports, no companion
 * client, no filesystem — only the comparison logic, so it is directly unit-testable and
 * reviewable without DOM/plugin scaffolding (the rem-R4 rule: state logic importable by tests).
 *
 * Every input is a plain, already-gathered snapshot:
 * - `vaultFiles`: `SearchManager.listIndexableFiles()`, reduced to `{path, mtime}`.
 * - `indexedPaths`: the companion's `POST /v1/paths` rows (WP-SA1;
 *   `SearchIndexedPath` in `./types`).
 * - `images`: `computeReferencedImagePaths(plugin)` crossed with
 *   `plugin.imageDescriptions.has/get`, reduced to one status per referenced image.
 * - `semanticEnabled`: whether the vault's `searchSemanticEnabled` toggle is on.
 * - `staleContentHashes`/`missingChunkCounts` (WP-G2, both optional): verification results for
 *   exactly the candidates `identifyAuditCandidates` names, gathered via
 *   `SearchManager.auditPrepareFile` — the real index-write-path hash/chunker, never a second
 *   hash function or a regex heuristic. See their own docs on `ComputeSearchAuditInput`.
 */

import { SearchIndexedPath } from './types';
import { AuditConditionDescriptor, AuditConditionKey, conditionFor, NOTE_CONDITIONS } from './auditConditions';

export interface AuditVaultFile {
	path: string;
	/** `TFile.stat.mtime`, ms epoch — the same clock `SearchManager` stamps chunks with at index time. */
	mtime: number;
}

export type AuditImageStatus = 'described' | 'failed' | 'pending';

export interface AuditImage {
	md5: string;
	status: AuditImageStatus;
	/**
	 * WP-I1: the vault-relative path of the referenced image (from `computeReferencedImagePaths`,
	 * `src/orchestration/utils/imageDescribe.ts` — already available at the `gatherSearchAuditImages`
	 * call site, just not threaded through before this). Feeds `imageCoverage.pendingPaths`/
	 * `failedPaths` so a future dashboard row can filter the paths table to the affected images
	 * without re-deriving them.
	 */
	path: string;
}

export interface ComputeSearchAuditInput {
	vaultFiles: AuditVaultFile[];
	indexedPaths: SearchIndexedPath[];
	images: AuditImage[];
	/**
	 * Gates `embeddingGaps`. With semantic indexing off, `attachEmbeddings` never sends a vector
	 * for anything (`SearchManager.attachEmbeddings` short-circuits to 0 embedded), so every
	 * indexed path with `chunkCount > 0` would trivially read `embeddedCount < chunkCount` —
	 * not a real gap, just the expected shape of an FTS-only vault. Passing `false` here reports
	 * an empty `embeddingGaps` list instead of that permanent noise; flip it on and the same
	 * `indexedPaths` data starts reporting real gaps once semantic search is turned on.
	 */
	semanticEnabled: boolean;
	/**
	 * WP-G2: for each path `identifyAuditCandidates` names in `staleMtime` — a vault file whose
	 * mtime is newer than its indexed row's mtime — the freshly-computed content hash for that
	 * file's CURRENT bytes, from the exact index-write-path hash (`SearchManager.auditPrepareFile`,
	 * which calls the same `prepareFile`/`buildPreparedFileChunks` pair `indexFiles` does — never
	 * a second hash function). When a candidate's fresh hash equals its indexed row's
	 * `contentHash`, the file's *content* hasn't actually changed (a git checkout touch, a
	 * byte-identical re-save, a rewritten-but-reverted edit) and it is reclassified `mtimeOnly`
	 * instead of `stale` — closing the permanent-stale loop: re-enqueuing `search_upsert_file` for
	 * an unchanged file would no-op forever without ever advancing the stored mtime that made it
	 * look stale in the first place (see the mtime false-positive quirk in `src/search/AGENTS.md`).
	 * A candidate absent from this map (the caller didn't verify it, or the read failed) keeps
	 * today's behavior — classified `stale` — rather than being silently reclassified without
	 * proof. Perf: only the mtime-suspect subset needs an entry, never the whole vault.
	 */
	staleContentHashes?: Map<string, string>;
	/**
	 * WP-G2: for each path `identifyAuditCandidates` names in `missing` — a vault file with no
	 * indexed row at all — the real chunk count the chunker would produce for it right now
	 * (`SearchManager.auditPrepareFile`'s `chunkCount`, the actual `buildSearchChunks` output
	 * length, never a regex heuristic over the raw text). A candidate whose count is exactly `0`
	 * is reclassified `unindexable`: it isn't missing from the index by omission, it has no
	 * indexable content to index at all (frontmatter-only notes, empty bodies — e.g. the X
	 * tombstones under `_x_metadata/_unavailable/`) — the same reason `SearchManager.indexFiles`'
	 * flush never sends anything for it, so it can never appear in `/v1/paths` no matter how many
	 * times reconcile enqueues it. A candidate absent from this map keeps today's behavior —
	 * classified `missing` — same absent-means-unverified rule as `staleContentHashes`.
	 */
	missingChunkCounts?: Map<string, number>;
}

export interface SearchAuditResult {
	/** In the vault, not indexed, and has real indexable content (chunk-count verified > 0, or unverified). */
	missing: string[];
	/** Indexed, not in the vault (deleted, moved, or now excluded). */
	orphans: string[];
	/** In the vault and indexed, mtime newer than indexed, and content-hash verified as CHANGED (or unverified). */
	stale: string[];
	/**
	 * WP-G2: mtime-newer-than-indexed, but the freshly-computed content hash equals the indexed
	 * row's — the index is current; the mtime bump alone (a touch, a byte-identical re-save)
	 * triggered the old mtime-only staleness test. Informational, not a defect: no repair command
	 * exists for it because there is nothing to repair.
	 */
	mtimeOnly: string[];
	/**
	 * WP-G2: no indexed row AND the real chunker produces zero chunks for it — frontmatter-only
	 * or empty-body content with nothing to index. Informational, not a defect: reconcile would
	 * enqueue a `search_upsert_file` job for it that flushes nothing and settles `done`, forever,
	 * without ever making the path appear in `/v1/paths` — so it is excluded from `missing` (and
	 * therefore from reconcile's enqueue set) rather than reported as a repairable gap.
	 */
	unindexable: string[];
	/** Indexed with at least one chunk, but fewer embedded chunks than chunks (semantic-gated). */
	embeddingGaps: string[];
	imageCoverage: {
		/** Every image referenced by a resolved link somewhere in the vault. */
		referenced: number;
		/** Has a non-`'failed'` description record. */
		described: number;
		/** Has a durable `kind: 'failed'` record — will not be retried by the backfill. */
		failed: number;
		/** Referenced but neither described nor failed — the backfill's actual work queue. */
		pending: number;
		/**
		 * WP-I1: paths of every image counted in `pending`, sorted — matches the sorted-array
		 * convention of the six path classes above (`missing`/`orphans`/`stale`/`mtimeOnly`/
		 * `unindexable`/`embeddingGaps`). `pendingPaths.length === pending` always.
		 */
		pendingPaths: string[];
		/**
		 * WP-I1: paths of every image counted in `failed`, sorted. `failedPaths.length === failed`
		 * always.
		 */
		failedPaths: string[];
	};
}

/**
 * Empty on every axis — the "all clean" fast path `search-audit-index`'s Notice checks for.
 * Deliberately does NOT include `mtimeOnly`/`unindexable` (WP-G2): both are informational
 * findings with no repair command, not defects, so a vault whose only findings are "N files had
 * a mtime bump with unchanged content" and "N files have no indexable content" still reports
 * clean here — exactly the point of classifying them out of `missing`/`stale` in the first place.
 */
export function isCleanAudit(result: SearchAuditResult): boolean {
	return result.missing.length === 0
		&& result.orphans.length === 0
		&& result.stale.length === 0
		&& result.embeddingGaps.length === 0
		&& result.imageCoverage.pending === 0
		&& result.imageCoverage.failed === 0;
}

/**
 * WP-F3: true when reconcile has nothing left to enqueue — every class it can act on
 * (missing, stale, orphans) is empty. Deliberately narrower than `isCleanAudit`, which also
 * requires `embeddingGaps` and `imageCoverage` to be zero: those two classes are never touched
 * by reconcile (see the `/v1/paths` audit/reconcile quirk in `src/search/AGENTS.md`), so a
 * vault with e.g. only embedding gaps has nothing for reconcile's own loop to do even though
 * `isCleanAudit` correctly still calls the overall audit dirty. `search-reconcile-index`
 * (`src/commands.ts`) gates its early-return "nothing to enqueue" branch on this, not on
 * `isCleanAudit` — the old code used `isCleanAudit` there, which meant a vault with only
 * embedding/image gaps fell through into the enqueue loops (both no-ops on empty arrays) and
 * landed on "enqueued 0 upserts and 0 deletes," the exact absurdity this WP fixes.
 */
export function isReconcileTargetClean(result: SearchAuditResult): boolean {
	return result.missing.length === 0 && result.stale.length === 0 && result.orphans.length === 0;
}

/**
 * WP-G2: the missing/stale-by-mtime candidate identification half of `computeSearchAudit`,
 * factored out so a caller (`runSearchAudit` in `src/commands.ts`) can name exactly the paths
 * that need hash/chunk-count verification BEFORE doing any I/O — the perf requirement that
 * verification reads only the mtime-suspect subset, never the whole vault. `computeSearchAudit`
 * calls this same function for its own classification, so the two can never disagree about what
 * counts as a candidate.
 */
export interface AuditCandidates {
	/** Vault files with no indexed row at all — need chunk-count verification (missing vs. unindexable). */
	missing: string[];
	/** Vault files with an indexed row whose mtime is newer than indexed — need hash verification (stale vs. mtimeOnly). */
	staleMtime: string[];
}

export function identifyAuditCandidates(vaultFiles: AuditVaultFile[], indexedPaths: SearchIndexedPath[]): AuditCandidates {
	const indexedByPath = new Map<string, SearchIndexedPath>();
	for (const row of indexedPaths) indexedByPath.set(row.path, row);

	const missing: string[] = [];
	const staleMtime: string[] = [];
	for (const file of vaultFiles) {
		const indexed = indexedByPath.get(file.path);
		if (!indexed) {
			missing.push(file.path);
			continue;
		}
		if (file.mtime > indexed.mtime) staleMtime.push(file.path);
	}
	return { missing, staleMtime };
}

export function computeSearchAudit(input: ComputeSearchAuditInput): SearchAuditResult {
	const indexedByPath = new Map<string, SearchIndexedPath>();
	for (const row of input.indexedPaths) indexedByPath.set(row.path, row);
	const vaultPaths = new Set(input.vaultFiles.map(f => f.path));

	const candidates = identifyAuditCandidates(input.vaultFiles, input.indexedPaths);

	const missing: string[] = [];
	const unindexable: string[] = [];
	for (const path of candidates.missing) {
		const chunkCount = input.missingChunkCounts?.get(path);
		if (chunkCount === 0) unindexable.push(path);
		else missing.push(path);
	}

	const stale: string[] = [];
	const mtimeOnly: string[] = [];
	for (const path of candidates.staleMtime) {
		const indexed = indexedByPath.get(path);
		const freshHash = input.staleContentHashes?.get(path);
		if (freshHash !== undefined && indexed?.contentHash !== undefined && freshHash === indexed.contentHash) {
			mtimeOnly.push(path);
		} else {
			stale.push(path);
		}
	}

	const orphans: string[] = [];
	const embeddingGaps: string[] = [];
	for (const row of input.indexedPaths) {
		if (!vaultPaths.has(row.path)) orphans.push(row.path);
		if (input.semanticEnabled && row.chunkCount > 0 && row.embeddedCount < row.chunkCount) {
			embeddingGaps.push(row.path);
		}
	}

	let described = 0;
	let failed = 0;
	let pending = 0;
	const pendingPaths: string[] = [];
	const failedPaths: string[] = [];
	for (const image of input.images) {
		if (image.status === 'described') {
			described++;
		} else if (image.status === 'failed') {
			failed++;
			failedPaths.push(image.path);
		} else {
			pending++;
			pendingPaths.push(image.path);
		}
	}

	return {
		missing: missing.sort(),
		orphans: orphans.sort(),
		stale: stale.sort(),
		mtimeOnly: mtimeOnly.sort(),
		unindexable: unindexable.sort(),
		embeddingGaps: embeddingGaps.sort(),
		imageCoverage: {
			referenced: input.images.length,
			described,
			failed,
			pending,
			pendingPaths: pendingPaths.sort(),
			failedPaths: failedPaths.sort(),
		},
	};
}

/**
 * WP-R3: the report's per-condition repair sentence, derived from `repairPolicy` (plus
 * `classLabel` for the two policies whose wording embeds the class noun) instead of a
 * hand-maintained `Record` keyed in parallel with the dashboard's own per-key branches (the old
 * `REPAIR_INSTRUCTIONS`, deleted by this WP — see `src/search/auditConditions.ts` for the shared
 * descriptor set both this file and `src/ingestion/sections/searchAudit.ts` now read).
 * `null` for `informational` conditions (mtimeOnly/unindexable): no command exists to name —
 * WP-G2 made that the whole point of the two classes.
 */
function reportRepairInstruction(descriptor: AuditConditionDescriptor): string | null {
	switch (descriptor.repairPolicy) {
		case 'reconcile-upsert':
			return `Run "Search: reconcile index" — it enqueues a search_upsert_file job for each ${descriptor.classLabel} path.`;
		case 'reconcile-orphan':
			return 'Run "Search: reconcile index" — its orphan-deletion half (confirm-gated) enqueues a search_delete_path job for each orphaned path.';
		case 'embed-missing':
			return 'Run "Search: embed missing vectors" (requires semantic search enabled and an embedding model configured; NOT handled by reconcile).';
		case 'image-backfill':
			return 'Run "Search: describe vault images" (NOT handled by reconcile).';
		case 'image-retry':
			return 'Run "Search: retry failed image descriptions" (NOT handled by reconcile).';
		case 'informational':
		default:
			return null;
	}
}

// The two image conditions have no `reportSectionTitle` (the report never lists image paths —
// see auditConditions.ts's module doc), so the Repair section's line prefix for them is named
// here instead — "Image coverage (pending)"/"(failed)", matching the report's combined Summary
// bullet's vocabulary rather than the dashboard's "Images pending"/"Images failed" row labels.
const IMAGE_REPAIR_PREFIX: Partial<Record<AuditConditionKey, string>> = {
	imagePending: 'Image coverage (pending)',
	imageFailed: 'Image coverage (failed)',
};

// Repair-section line order — deliberately NOT the Summary section's order (there, orphans reads
// third; here it reads third too, but stale reads BEFORE orphans — this is the order the
// "## Repair" section has always listed its lines in, and formatAuditReport's byte-identical
// contract means it stays exactly this order rather than being re-derived from SUMMARY_ORDER).
const REPAIR_SECTION_ORDER: readonly AuditConditionKey[] = ['missing', 'stale', 'orphans', 'embeddingGaps', 'imagePending', 'imageFailed'];

/**
 * Renders `search-audit-index`'s report note. `generatedAt` is a caller-supplied timestamp
 * (rather than `new Date()` inside here) so this stays pure and its output deterministic in
 * tests. Overwrite-per-run at the call site (`src/commands.ts`'s `writeSearchAuditReportNote`) —
 * this function only produces the content, never touches the vault.
 */
export function formatAuditReport(result: SearchAuditResult, generatedAt: string): string {
	const lines: string[] = [
		`# Search index audit — ${generatedAt}`,
		'',
		'## Summary',
		...NOTE_CONDITIONS.map(descriptor => `- ${descriptor.reportSummaryLabel}: ${descriptor.paths(result).length}`),
		`- Image coverage: ${result.imageCoverage.described}/${result.imageCoverage.referenced} described, `
			+ `${result.imageCoverage.failed} failed, ${result.imageCoverage.pending} pending`,
		'',
	];
	const repairSection = formatRepairSection(result);
	if (repairSection) lines.push(repairSection);
	lines.push(...NOTE_CONDITIONS.map(descriptor => formatAuditSection(descriptor.reportSectionTitle ?? descriptor.classLabel, descriptor.paths(result))));
	return `${lines.join('\n')}\n`;
}

/**
 * Compact "## Repair" section naming the exact command for every NON-ZERO class — absent
 * entirely on a clean audit (no repair, nothing to say). Also notes that re-running
 * "Search: audit index" is how this report itself refreshes: reconcile does not auto-refresh
 * it (no completion hook exists yet — known limitation, out of scope for this pass).
 */
function formatRepairSection(result: SearchAuditResult): string {
	const lines: string[] = [];
	for (const key of REPAIR_SECTION_ORDER) {
		const descriptor = conditionFor(key);
		if (descriptor.paths(result).length === 0) continue;
		const instruction = reportRepairInstruction(descriptor);
		if (!instruction) continue;
		const prefix = descriptor.reportSectionTitle ?? IMAGE_REPAIR_PREFIX[key] ?? descriptor.classLabel;
		lines.push(`- ${prefix}: ${instruction}`);
	}
	if (lines.length === 0) return '';
	lines.push('', 'Re-run "Search: audit index" after repairing to refresh this report — reconcile does not do it automatically.');
	return `## Repair\n${lines.join('\n')}\n`;
}

function formatAuditSection(title: string, paths: string[]): string {
	const body = paths.length > 0 ? paths.map(p => `- ${p}`).join('\n') : '(none)';
	return `## ${title}\n${body}\n`;
}

/**
 * Names the classes reconcile never touches, with their commands, whenever they're non-zero —
 * shared by both reconcile Notice variants below so the wording can't drift between "nothing to
 * enqueue" and "enqueued N" outcomes. `''` when both classes are zero (nothing to note).
 */
function formatUnhandledClassesNote(result: SearchAuditResult): string {
	const parts: string[] = [];
	if (result.embeddingGaps.length > 0) {
		parts.push(`${result.embeddingGaps.length} embedding gap${result.embeddingGaps.length === 1 ? '' : 's'} `
			+ '(run "Search: embed missing vectors")');
	}
	if (result.imageCoverage.pending > 0) {
		parts.push(`${result.imageCoverage.pending} image${result.imageCoverage.pending === 1 ? '' : 's'} pending description `
			+ '(run "Search: describe vault images")');
	}
	if (result.imageCoverage.failed > 0) {
		parts.push(`${result.imageCoverage.failed} failed image description${result.imageCoverage.failed === 1 ? '' : 's'} `
			+ '(run "Search: retry failed image descriptions")');
	}
	return parts.join('; ');
}

/**
 * WP-F3: `search-reconcile-index`'s early-return Notice when `isReconcileTargetClean` is true —
 * i.e. missing/stale/orphans are all empty, so reconcile's own loops would enqueue nothing. If
 * embeddingGaps/imageCoverage are also zero this is a genuinely clean vault; otherwise it says so
 * plainly instead of implying full health, naming the commands that actually repair those classes.
 */
export function formatReconcileNothingToDoSummary(result: SearchAuditResult): string {
	const unhandled = formatUnhandledClassesNote(result);
	if (!unhandled) return 'Search: reconcile index — already matches the vault. Nothing to do.';
	return 'Search: reconcile index — index files already match the vault. Reconcile has nothing to enqueue, '
		+ `but the vault still has: ${unhandled}.`;
}

/** One enqueue loop's outcome: how many jobs were freshly minted vs. how many enqueue calls hit
 * an existing (dedupe) job instead — see the `job.created`-vs-`startedAt` discriminator at the
 * `search-reconcile-index` call site in `src/commands.ts`. */
export interface ReconcileJobOutcome {
	newCount: number;
	dedupedCount: number;
}

export interface ReconcileEnqueueSummaryInput {
	upserts: ReconcileJobOutcome;
	deletes: ReconcileJobOutcome;
	/** True when orphans existed but the destructive confirm was declined (or suppressed to "no"
	 * — `confirmDestructive` returning false either way), so the delete loop never ran. */
	orphansDeclined: boolean;
}

function formatJobOutcome(label: string, outcome: ReconcileJobOutcome): string | null {
	const total = outcome.newCount + outcome.dedupedCount;
	if (total === 0) return null;
	let text = `${outcome.newCount} ${label}${outcome.newCount === 1 ? '' : 's'} newly enqueued`;
	if (outcome.dedupedCount > 0) text += ` (+${outcome.dedupedCount} already queued)`;
	return text;
}

/**
 * WP-F3: `search-reconcile-index`'s terminal Notice — replaces the old
 * "enqueued N upserts and M deletes" line, which (a) counted a dedupe hit (the backend returning
 * an already-existing job) as freshly enqueued, and (b) never said where the work went or that
 * embeddingGaps/imageCoverage are separate, unhandled classes.
 */
export function formatReconcileCompletedSummary(result: SearchAuditResult, input: ReconcileEnqueueSummaryInput): string {
	const segments = [formatJobOutcome('upsert', input.upserts), formatJobOutcome('delete', input.deletes)]
		.filter((s): s is string => s !== null);
	const unhandled = formatUnhandledClassesNote(result);

	if (segments.length === 0) {
		let msg = 'Search: reconcile index — nothing enqueued.';
		if (input.orphansDeclined) msg += ' Orphan deletion was declined.';
		if (unhandled) msg += ` Not handled by reconcile: ${unhandled}.`;
		return msg;
	}

	let msg = `Search: reconcile index — ${segments.join('; ')}. Rows appear in the Ingestion dashboard's `
		+ 'Queue Monitor and typically settle in seconds (see the "done" status filter).';
	if (unhandled) msg += ` Not handled by reconcile: ${unhandled}.`;
	return msg;
}
