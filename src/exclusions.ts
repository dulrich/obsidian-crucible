import { CrucibleSettings, ExcludedFolder, ExclusionScope } from './types';

export const INTERNAL_PLUGIN_FOLDER = '_crucible';

export function defaultExcludedFolders(): ExcludedFolder[] {
	return [{ folder: INTERNAL_PLUGIN_FOLDER, lint: false, search: true }];
}

export function normalizeExcludedFolder(folder: string): string {
	return folder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

export function isPathExcluded(settings: Pick<CrucibleSettings, 'excludedFolders'>, path: string, scope: ExclusionScope): boolean {
	const normalizedPath = normalizeExcludedFolder(path);
	if (!normalizedPath) return false;
	return (settings.excludedFolders ?? []).some(row => {
		const folder = normalizeExcludedFolder(row.folder);
		if (!folder || !row[scope]) return false;
		return normalizedPath === folder || normalizedPath.startsWith(`${folder}/`);
	});
}

export function ensureDefaultSearchExclusion(rows: ExcludedFolder[]): ExcludedFolder[] {
	const next = [...rows];
	const hasInternalSearch = next.some(row => {
		const folder = normalizeExcludedFolder(row.folder);
		return row.search && (folder === INTERNAL_PLUGIN_FOLDER || INTERNAL_PLUGIN_FOLDER.startsWith(`${folder}/`));
	});
	if (!hasInternalSearch) next.unshift({ folder: INTERNAL_PLUGIN_FOLDER, lint: false, search: true });
	return next;
}

export function migrateExcludedFolders(rows: ExcludedFolder[], legacyLintFolders: string[]): ExcludedFolder[] {
	return ensureDefaultSearchExclusion(dedupeExcludedFolders([
		...rows,
		...legacyLintFolders.map(folder => ({ folder, lint: true, search: false })),
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
		});
	}
	return Array.from(byFolder.values());
}
