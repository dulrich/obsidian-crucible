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
		formatAuditSection('Missing', result.missing),
		formatAuditSection('Orphans', result.orphans),
		formatAuditSection('Stale', result.stale),
		formatAuditSection('Embedding gaps', result.embeddingGaps),
	];
	return `${lines.join('\n')}\n`;
}

function formatAuditSection(title: string, paths: string[]): string {
	const body = paths.length > 0 ? paths.map(p => `- ${p}`).join('\n') : '(none)';
	return `## ${title}\n${body}\n`;
}
