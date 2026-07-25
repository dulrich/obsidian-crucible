import { CrucibleSettings, ExcludedFolder, ExclusionScope } from './types';

export const INTERNAL_PLUGIN_FOLDER = '_crucible';

export function defaultExcludedFolders(): ExcludedFolder[] {
	return [{ folder: INTERNAL_PLUGIN_FOLDER, lint: false, search: true, localize: false }];
}

export function normalizeExcludedFolder(folder: string): string {
	return folder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * Normalized, deduped `search`/`lint`/`localize`-scoped excluded-folder prefixes, computed
 * once. `isPathExcluded` re-normalized every row on every call — the file-open palette used
 * to pay that 47,000 times per keystroke. Callers that check many paths against the same
 * scope (the palette snapshot build, `SearchIndexCoordinator`) should compile once and reuse
 * `isPathExcludedCompiled` instead of calling `isPathExcluded` in a loop.
 */
export function compileExclusions(settings: Pick<CrucibleSettings, 'excludedFolders'>, scope: ExclusionScope): string[] {
	const prefixes = new Set<string>();
	for (const row of settings.excludedFolders ?? []) {
		if (!row[scope]) continue;
		const folder = normalizeExcludedFolder(row.folder);
		if (folder) prefixes.add(folder);
	}
	return Array.from(prefixes).sort();
}

/** Membership test against an already-`compileExclusions`-produced prefix list. */
export function isPathExcludedCompiled(prefixes: string[], path: string): boolean {
	const normalizedPath = normalizeExcludedFolder(path);
	if (!normalizedPath) return false;
	return prefixes.some(folder => normalizedPath === folder || normalizedPath.startsWith(`${folder}/`));
}

export function isPathExcluded(settings: Pick<CrucibleSettings, 'excludedFolders'>, path: string, scope: ExclusionScope): boolean {
	return isPathExcludedCompiled(compileExclusions(settings, scope), path);
}

export function ensureDefaultSearchExclusion(rows: ExcludedFolder[]): ExcludedFolder[] {
	const next = [...rows];
	const hasInternalSearch = next.some(row => {
		const folder = normalizeExcludedFolder(row.folder);
		return row.search && (folder === INTERNAL_PLUGIN_FOLDER || INTERNAL_PLUGIN_FOLDER.startsWith(`${folder}/`));
	});
	if (!hasInternalSearch) next.unshift({ folder: INTERNAL_PLUGIN_FOLDER, lint: false, search: true, localize: false });
	return next;
}

export function migrateExcludedFolders(rows: ExcludedFolder[], legacyLintFolders: string[]): ExcludedFolder[] {
	// Localization used to piggyback on the `lint` scope. Give existing rows that
	// lack an explicit `localize` field `localize = lint`, so folders currently
	// skipped by localize stay skipped after it gets its own scope.
	const withLocalize = rows.map(row => ({
		...row,
		localize: typeof row.localize === 'boolean' ? row.localize : Boolean(row.lint),
	}));
	return ensureDefaultSearchExclusion(dedupeExcludedFolders([
		...withLocalize,
		...legacyLintFolders.map(folder => ({ folder, lint: true, search: false, localize: true })),
	]));
}

export function dedupeExcludedFolders(rows: ExcludedFolder[]): ExcludedFolder[] {
	const byFolder = new Map<string, ExcludedFolder>();
	for (const row of rows) {
		const folder = normalizeExcludedFolder(row.folder);
		if (!folder) continue;
		const existing = byFolder.get(folder);
		byFolder.set(folder, {
			folder,
			lint: Boolean(existing?.lint || row.lint),
			search: Boolean(existing?.search || row.search),
			localize: Boolean(existing?.localize || row.localize),
		});
	}
	return Array.from(byFolder.values());
}
