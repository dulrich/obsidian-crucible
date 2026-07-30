import type { TriggerScope } from '../types';

/**
 * Pure path-based version of `triggerAdapter`'s `inScope` scope-prefix test, extracted
 * so the runtime adapter (which has a live `TFile`) and the settings-UI match-volume
 * estimator (which only has vault-wide path strings) share one predicate instead of
 * drifting apart — see the trigger-storm investigation's §Volume estimate. Empty/blank
 * folder = whole vault. `includeSubfolders === false` restricts to files whose
 * immediate parent folder equals `folder` exactly; a file's parent path is derived the
 * same way `src/utils.ts` derives an attachment's folder path
 * (`path.substring(0, path.lastIndexOf('/'))`, empty string at vault root), which is
 * identical to Obsidian's own `TFile.parent.path` for every path in the vault.
 */
export function pathInScope(path: string, scope?: TriggerScope): boolean {
	const folder = scope?.folder?.trim().replace(/\/$/, '');
	if (!folder) return true;
	if (scope?.includeSubfolders === false) {
		const slash = path.lastIndexOf('/');
		const parent = slash === -1 ? '' : path.slice(0, slash);
		return parent === folder;
	}
	return path === folder || path.startsWith(`${folder}/`);
}
