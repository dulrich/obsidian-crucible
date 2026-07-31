import { App, TFile } from 'obsidian';
import { MD5_NAME_RE, planLocalAttachmentRepair } from '../../localizeAttachments';
import type { MissingRefRow } from '../render/types';

// A caller-supplied narrowing of AttachmentLocalizer's public surface — kept a plain
// duck-typed shape (rather than importing the class as a value) so this module doesn't
// pull the full localizer (and its NoteLockManager/network dependencies) into anything
// that bundles this file standalone, e.g. unit tests exercising the pure ref-decision
// function below.
export interface AttachmentFolderResolver {
	attachmentFolderForNote(note: TFile): string;
}

// Decode a raw metadataCache ref's `link` text (e.g. `folder/hash_MD5.png`,
// `hash%20thing_MD5.png#frag`) down to the basename that would identify a managed
// localized attachment, and return it only when it looks like one. Returns null for any
// ref that isn't a `..._MD5.ext` name — the majority of vault links, which this scan has
// no opinion about. `decodeURIComponent` is guarded: a malformed escape sequence in a
// hand-edited link must not throw and abort the whole scan.
export function managedAttachmentBasename(rawLink: string): string | null {
	const target = rawLink.split('#')[0]?.split('|')[0] ?? '';
	if (!target) return null;
	let decoded = target;
	try {
		decoded = decodeURIComponent(target);
	} catch {
		// Malformed escape (e.g. a lone `%`) — fall back to the raw text rather than throw.
	}
	const base = decoded.split('/').pop() ?? '';
	if (!base || !MD5_NAME_RE.test(base)) return null;
	return base;
}

// Inverse of computeOrphanedAttachmentRows (../data/orphanedAttachments.ts): one row per
// note ref whose managed (…_MD5.ext) target no longer resolves, instead of one row per
// unreferenced managed file. Walks every markdown note's embeds + links (frontmatter-only
// refs are out of scope, same accepted gap as the orphan scan), keeps only refs that look
// like managed attachments, and flags the ones `getFirstLinkpathDest` can no longer
// resolve — the exact brokenness predicate `AttachmentLocalizer.repairNote` uses
// (src/localizeAttachments.ts:427).
export function computeMissingAttachmentRows(app: App, localizer: AttachmentFolderResolver): MissingRefRow[] {
	const vaultPaths = app.vault.getFiles().map(f => f.path);
	const seen = new Set<string>();
	const rows: MissingRefRow[] = [];

	for (const note of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(note);
		const refs = [...(cache?.embeds ?? []), ...(cache?.links ?? [])];
		if (refs.length === 0) continue;

		let expectedFolder: string | null = null;
		for (const ref of refs) {
			if (managedAttachmentBasename(ref.link) === null) continue;
			if (app.metadataCache.getFirstLinkpathDest(ref.link, note.path) instanceof TFile) continue;

			const key = `${note.path}→${ref.link}`;
			if (seen.has(key)) continue;
			seen.add(key);

			if (expectedFolder === null) expectedFolder = localizer.attachmentFolderForNote(note);
			const repairable = planLocalAttachmentRepair(ref.link, expectedFolder, vaultPaths) !== null;
			rows.push({ note, link: ref.link, repairable });
		}
	}
	return rows;
}
