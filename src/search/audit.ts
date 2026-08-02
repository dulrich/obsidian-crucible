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
 */

import { SearchIndexedPath } from './types';

export interface AuditVaultFile {
	path: string;
	/** `TFile.stat.mtime`, ms epoch — the same clock `SearchManager` stamps chunks with at index time. */
	mtime: number;
}

export type AuditImageStatus = 'described' | 'failed' | 'pending';

export interface AuditImage {
	md5: string;
	status: AuditImageStatus;
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
}

export interface SearchAuditResult {
	/** In the vault, not indexed at all. */
	missing: string[];
	/** Indexed, not in the vault (deleted, moved, or now excluded). */
	orphans: string[];
	/** In the vault and indexed, but the vault's mtime is newer than the indexed mtime. */
	stale: string[];
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
	};
}

/** Empty on every axis — the "all clean" fast path `search-audit-index`'s Notice checks for. */
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

export function computeSearchAudit(input: ComputeSearchAuditInput): SearchAuditResult {
	const indexedByPath = new Map<string, SearchIndexedPath>();
	for (const row of input.indexedPaths) indexedByPath.set(row.path, row);
	const vaultPaths = new Set(input.vaultFiles.map(f => f.path));

	const missing: string[] = [];
	const stale: string[] = [];
	for (const file of input.vaultFiles) {
		const indexed = indexedByPath.get(file.path);
		if (!indexed) {
			missing.push(file.path);
			continue;
		}
		if (file.mtime > indexed.mtime) stale.push(file.path);
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
	for (const image of input.images) {
		if (image.status === 'described') described++;
		else if (image.status === 'failed') failed++;
		else pending++;
	}

	return {
		missing: missing.sort(),
		orphans: orphans.sort(),
		stale: stale.sort(),
		embeddingGaps: embeddingGaps.sort(),
		imageCoverage: {
			referenced: input.images.length,
			described,
			failed,
			pending,
		},
	};
}

/**
 * Per-class repair instruction, keyed the same way `formatRepairSection` walks the result —
 * WP-F3: the audit used to name zero repair commands, leaving a user who ran it with a dirty
 * report no path forward except reading source. Missing/stale/orphans all repair through the
 * same command (reconcile's upsert half for the first two, its confirm-gated delete half for
 * orphans); embedding gaps and image coverage are NOT touched by reconcile (see the `/v1/paths`
 * quirk in `src/search/AGENTS.md`) and need their own dedicated commands.
 */
const REPAIR_INSTRUCTIONS: Record<'missing' | 'stale' | 'orphans' | 'embeddingGaps' | 'imagePending' | 'imageFailed', string> = {
	missing: 'Run "Search: reconcile index" — it enqueues a search_upsert_file job for each missing path.',
	stale: 'Run "Search: reconcile index" — it enqueues a search_upsert_file job for each stale path.',
	orphans: 'Run "Search: reconcile index" — its orphan-deletion half (confirm-gated) enqueues a search_delete_path job for each orphaned path.',
	embeddingGaps: 'Run "Search: embed missing vectors" (requires semantic search enabled and an embedding model configured; NOT handled by reconcile).',
	imagePending: 'Run "Search: describe vault images" (NOT handled by reconcile).',
	imageFailed: 'Run "Search: retry failed image descriptions" (NOT handled by reconcile).',
};

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
		`- Missing (in vault, not indexed): ${result.missing.length}`,
		`- Orphans (indexed, not in vault): ${result.orphans.length}`,
		`- Stale (vault newer than indexed): ${result.stale.length}`,
		`- Embedding gaps (embedded < chunks): ${result.embeddingGaps.length}`,
		`- Image coverage: ${result.imageCoverage.described}/${result.imageCoverage.referenced} described, `
			+ `${result.imageCoverage.failed} failed, ${result.imageCoverage.pending} pending`,
		'',
	];
	const repairSection = formatRepairSection(result);
	if (repairSection) lines.push(repairSection);
	lines.push(
		formatAuditSection('Missing', result.missing),
		formatAuditSection('Orphans', result.orphans),
		formatAuditSection('Stale', result.stale),
		formatAuditSection('Embedding gaps', result.embeddingGaps),
	);
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
	if (result.missing.length > 0) lines.push(`- Missing: ${REPAIR_INSTRUCTIONS.missing}`);
	if (result.stale.length > 0) lines.push(`- Stale: ${REPAIR_INSTRUCTIONS.stale}`);
	if (result.orphans.length > 0) lines.push(`- Orphans: ${REPAIR_INSTRUCTIONS.orphans}`);
	if (result.embeddingGaps.length > 0) lines.push(`- Embedding gaps: ${REPAIR_INSTRUCTIONS.embeddingGaps}`);
	if (result.imageCoverage.pending > 0) lines.push(`- Image coverage (pending): ${REPAIR_INSTRUCTIONS.imagePending}`);
	if (result.imageCoverage.failed > 0) lines.push(`- Image coverage (failed): ${REPAIR_INSTRUCTIONS.imageFailed}`);
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
