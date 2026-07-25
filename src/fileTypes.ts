import type { App } from 'obsidian';
import { normalizeExtensionFilter } from './fileOpenRanking';

/**
 * fileTypes.ts — the canonical catalog of Obsidian-readable file extensions, grouped by
 * category, plus the app-taking derivation that widens it to whatever Obsidian and the
 * live vault actually support.
 *
 * Two independent consumers sit on top of this catalog (WP-4): the file-open palette's
 * "openable extensions" checkbox grid (`crucibleFileOpenPaletteExtensions`, all
 * categories) and the search indexer's "indexable extensions" grid
 * (`searchIndexExtensions`, restricted to `TEXT_EXTRACTABLE_CATEGORIES`). They stay
 * independent — this module only supplies the shared catalog, never a link between them.
 *
 * The catalog constants below are deliberately obsidian-free (no runtime import — only
 * the `App` *type* is imported, which esbuild/tsc erase) so `tests/fileTypes.test.mjs`
 * can bundle and exercise them in bare Node, the same way `rankScore.ts` and
 * `fileOpenRanking.ts` are tested. `deriveFileTypeGroups` is the one exported function
 * that takes a live `App` — keep any future Obsidian-touching logic there, not in the
 * catalog.
 */

export type FileTypeCategory =
	| 'Markdown'
	| 'Text'
	| 'Canvas'
	| 'Base'
	| 'PDF'
	| 'Images'
	| 'Audio'
	| 'Video'
	// Bucket for extensions discovered via `deriveFileTypeGroups` (live registry or
	// vault union) that don't land in any category above. Never present in the static
	// catalog itself.
	| 'Other';

export interface FileTypeGroup {
	category: FileTypeCategory;
	/** Lowercase, no leading dot. Presentation order within the category. */
	extensions: string[];
}

/**
 * Static fallback catalog. Order is the checkbox-grid presentation order. Every
 * extension is lowercase with no leading dot, and no extension appears in more than one
 * category — see `tests/fileTypes.test.mjs`'s well-formedness assertions.
 */
export const FILE_TYPE_CATALOG: readonly FileTypeGroup[] = [
	{ category: 'Markdown', extensions: ['md'] },
	{ category: 'Text', extensions: ['txt', 'qmd'] },
	{ category: 'Canvas', extensions: ['canvas'] },
	{ category: 'Base', extensions: ['base'] },
	{ category: 'PDF', extensions: ['pdf'] },
	{ category: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif'] },
	{ category: 'Audio', extensions: ['mp3', 'wav', 'm4a', '3gp', 'flac', 'ogg', 'oga', 'opus'] },
	{ category: 'Video', extensions: ['mp4', 'webm', 'ogv', 'mov', 'mkv'] },
];

/** Every category the search indexer is offered — Set B is text-extractable types only.
 * Indexing a `.webp` (or a `.pdf`/`.base`) into FTS5 is meaningless: there's no plain
 * text to chunk. */
export const TEXT_EXTRACTABLE_CATEGORIES: readonly FileTypeCategory[] = ['Markdown', 'Text', 'Canvas'];

/** Flat set of every extension in the static catalog. */
export const ALL_CATALOG_EXTENSIONS: readonly string[] = FILE_TYPE_CATALOG.flatMap(g => g.extensions);

/**
 * Obsidian's internal view-type strings, mapped onto our categories, so an extension
 * discovered only through the live registry (not in the static catalog) still lands in
 * a sensible group instead of always falling through to "Other".
 */
const VIEW_TYPE_CATEGORY: Readonly<Record<string, FileTypeCategory>> = {
	markdown: 'Markdown',
	image: 'Images',
	audio: 'Audio',
	video: 'Video',
	pdf: 'PDF',
	canvas: 'Canvas',
	base: 'Base',
	bases: 'Base',
};

/**
 * Build the checkbox-grid groups for a live vault: start from the static catalog, widen
 * it with whatever Obsidian's own view registry reports it can open, then union in every
 * extension actually present in the vault — so a file type the user really has can never
 * become unreachable in a palette/indexer filter, even if it's absent from both the
 * static catalog and the registry (e.g. an obscure or future Obsidian-supported type).
 *
 * `app.viewRegistry.typeByExtension` is an undocumented internal, absent from
 * `obsidian.d.ts`. Presence-guarded exactly the way `src/surround.ts` guards
 * `vault.getConfig`/`setConfig` and `SecretRegistry` guards `app.secretStorage`:
 * feature-detect, fall back to the static catalog alone, never throw.
 */
export function deriveFileTypeGroups(app: App): FileTypeGroup[] {
	const groups = new Map<FileTypeCategory, Set<string>>(
		FILE_TYPE_CATALOG.map(g => [g.category, new Set(g.extensions)]),
	);
	const known = new Set(ALL_CATALOG_EXTENSIONS);
	const other = new Set<string>();

	const admit = (rawExt: string, viewType?: string): void => {
		const ext = normalizeExtension(rawExt);
		if (!ext || known.has(ext)) return;
		known.add(ext);
		const category = viewType ? VIEW_TYPE_CATEGORY[viewType] : undefined;
		const bucket = category ? groups.get(category) : undefined;
		if (bucket) bucket.add(ext);
		else other.add(ext);
	};

	for (const [ext, viewType] of readViewRegistryEntries(app)) admit(ext, viewType);
	for (const ext of readVaultExtensions(app)) admit(ext);

	const result: FileTypeGroup[] = FILE_TYPE_CATALOG.map(g => ({
		category: g.category,
		extensions: Array.from(groups.get(g.category) ?? []).sort(),
	}));
	if (other.size > 0) result.push({ category: 'Other', extensions: Array.from(other).sort() });
	return result;
}

/**
 * `[extension, viewType][]` from Obsidian's live view registry, or `[]` when the
 * internal is absent/shaped unexpectedly. The guard is the point — this must never
 * throw regardless of what a future Obsidian version does to the internal.
 */
function readViewRegistryEntries(app: App): [string, string][] {
	try {
		const registry = app.viewRegistry;
		const map = registry?.typeByExtension;
		if (!map || typeof map !== 'object') return [];
		const entries: [string, string][] = [];
		for (const [ext, viewType] of Object.entries(map)) {
			if (typeof ext === 'string' && typeof viewType === 'string') entries.push([ext, viewType]);
		}
		return entries;
	} catch {
		return [];
	}
}

/** Extensions of files actually present in the vault, or `[]` on any failure. */
function readVaultExtensions(app: App): string[] {
	try {
		return app.vault.getFiles().map(file => file.extension);
	} catch {
		return [];
	}
}

function normalizeExtension(extension: string): string {
	return extension.trim().replace(/^\.+/, '').toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* checkbox-grid selection semantics                                          */
/* -------------------------------------------------------------------------- */

/**
 * The effective selected-extensions set for a checkbox grid, given the raw stored array
 * and whether this grid uses "empty means all" semantics.
 *
 * Set A (the file-open palette's `crucibleFileOpenPaletteExtensions`) is "empty means
 * all" — that's the pre-existing free-text field's migration contract, so an untouched
 * config (`[]`) must keep behaving as "no filter" and render every box checked. Set B
 * (the search indexer's `searchIndexExtensions`) is a plain checkbox list — a user can
 * legitimately uncheck every box to index nothing, so `[]` there means "nothing
 * selected," never "everything."
 *
 * Pure (routes normalization through `fileOpenRanking.ts`'s `normalizeExtensionFilter`
 * rather than reimplementing it) so both settings/sections/commands.ts's Set A and
 * settings/sections/orchestration.ts's Set B render through the identical
 * interpretation of an empty array, and so the semantics are unit-testable without an
 * `obsidian` runtime.
 */
export function resolveSelectedExtensions(
	raw: string[],
	allExtensions: readonly string[],
	emptyMeansAll: boolean,
): Set<string> {
	const normalized = normalizeExtensionFilter(raw);
	if (emptyMeansAll && normalized.size === 0) return new Set(allExtensions);
	return normalized;
}

/**
 * The array to persist after a checkbox-grid edit. When `emptyMeansAll` and the edit
 * leaves every known extension selected, collapse back to `[]` so extensions that don't
 * exist yet (a future Obsidian version, a newly created vault file type) stay included
 * automatically — the same forward-compatible contract the free-text field's blank value
 * had. Set B never collapses: a full checkbox grid there is recorded as the concrete
 * list, since "index everything, including whatever shows up later" is not this set's
 * default behavior the way "open everything" is for Set A.
 */
export function commitSelectedExtensions(
	selected: ReadonlySet<string>,
	allExtensions: readonly string[],
	emptyMeansAll: boolean,
): string[] {
	if (emptyMeansAll && allExtensions.length > 0 && allExtensions.every(ext => selected.has(ext))) return [];
	return Array.from(selected).sort();
}
