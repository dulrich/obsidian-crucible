import { normalizeExcludedFolder } from './exclusions';

export type CrucibleFileOpenIgnoredFolderMode = 'include' | 'derank' | 'hide';

export interface FileOpenCandidate {
	path: string;
	extension: string;
}

export interface FileOpenFileItem {
	kind: 'file';
	path: string;
	extension: string;
	ignored: boolean;
	score: number | null;
}

export interface FileOpenCreateItem {
	kind: 'create';
	path: string;
}

export type FileOpenItem = FileOpenFileItem | FileOpenCreateItem;

export interface RankFileOpenOptions {
	files: FileOpenCandidate[];
	query: string;
	extensions: string[];
	ignoredFolderMode: CrucibleFileOpenIgnoredFolderMode;
	createMissing: boolean;
	isIgnoredPath: (path: string) => boolean;
	scorePath: (query: string, path: string) => number | null;
	limit?: number;
}

export function rankFileOpenItems(options: RankFileOpenOptions): FileOpenItem[] {
	const limit = options.limit ?? 100;
	const query = options.query.trim();
	const allowedExtensions = normalizeExtensionFilter(options.extensions);
	const exactPaths = new Set(options.files.map(file => normalizeFileOpenPath(file.path).toLowerCase()));
	const fileItems = options.files
		.filter(file => extensionAllowed(file.extension, allowedExtensions))
		.map(file => {
			const path = normalizeFileOpenPath(file.path);
			const ignored = options.isIgnoredPath(path);
			if (ignored && options.ignoredFolderMode === 'hide') return null;
			const score = query ? options.scorePath(query, path) : null;
			if (query && score === null) return null;
			return { kind: 'file' as const, path, extension: normalizeExtension(file.extension), ignored, score };
		})
		.filter((item): item is FileOpenFileItem => item !== null)
		.sort((a, b) => compareFileOpenItems(a, b, options.ignoredFolderMode));

	const items: FileOpenItem[] = fileItems.slice(0, limit);
	const createPath = getCreateFilePath(query, options.createMissing, exactPaths);
	if (createPath !== null && extensionAllowed(fileExtension(createPath), allowedExtensions)) {
		items.push({ kind: 'create', path: createPath });
	}
	return items;
}

export function normalizeExtensionFilter(extensions: string[]): Set<string> {
	const normalized = extensions
		.map(normalizeExtension)
		.filter(ext => ext.length > 0);
	return new Set(normalized);
}

export function parseExtensionFilter(raw: string): string[] {
	const seen = new Set<string>();
	for (const part of raw.split(/[\s,]+/)) {
		const ext = normalizeExtension(part);
		if (ext) seen.add(ext);
	}
	return Array.from(seen);
}

export function formatExtensionFilter(extensions: string[]): string {
	return Array.from(normalizeExtensionFilter(extensions)).sort().join(', ');
}

export function normalizeCreatePath(query: string): string | null {
	if (query.trim().replace(/\\/g, '/').endsWith('/')) return null;
	const normalized = normalizeFileOpenPath(query);
	if (!normalized) return null;
	const extension = fileExtension(normalized);
	if (extension && extension !== 'md') return null;
	return extension ? normalized : `${normalized}.md`;
}

function compareFileOpenItems(a: FileOpenFileItem, b: FileOpenFileItem, ignoredFolderMode: CrucibleFileOpenIgnoredFolderMode): number {
	if (ignoredFolderMode === 'derank' && a.ignored !== b.ignored) return a.ignored ? 1 : -1;
	if (a.score !== b.score) return (a.score ?? 0) - (b.score ?? 0);
	if (a.path.length !== b.path.length) return a.path.length - b.path.length;
	const aDepth = a.path.split('/').length;
	const bDepth = b.path.split('/').length;
	if (aDepth !== bDepth) return aDepth - bDepth;
	return a.path.localeCompare(b.path);
}

function getCreateFilePath(query: string, createMissing: boolean, exactPaths: Set<string>): string | null {
	if (!createMissing) return null;
	const path = normalizeCreatePath(query);
	if (path === null) return null;
	return exactPaths.has(path.toLowerCase()) ? null : path;
}

function extensionAllowed(extension: string, allowedExtensions: Set<string>): boolean {
	return allowedExtensions.size === 0 || allowedExtensions.has(normalizeExtension(extension));
}

function normalizeExtension(extension: string): string {
	return extension.trim().replace(/^\.+/, '').toLowerCase();
}

function fileExtension(path: string): string {
	const filename = path.split('/').pop() ?? '';
	const dot = filename.lastIndexOf('.');
	return dot > 0 && dot < filename.length - 1 ? normalizeExtension(filename.slice(dot + 1)) : '';
}

function normalizeFileOpenPath(path: string): string {
	return normalizeExcludedFolder(path).replace(/\/+/g, '/');
}
