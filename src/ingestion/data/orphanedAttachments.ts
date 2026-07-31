import { App } from 'obsidian';
import { MD5_NAME_RE } from '../../localizeAttachments';
import { classifyLocalizeMediaType } from '../../utils';
import type { OrphanRow } from '../render/types';

// Localized attachments (…_MD5.ext) with no back-reference from any note.
// resolvedLinks maps each source note to the targets it references (embeds and body links
// included), but NOT frontmatter property links (e.g. a `cover:` property) — the same
// documented gap `buildLinkGraph` (src/search/linkGraph.ts) already closes for search's
// link-boost graph. So frontmatterLinks targets are unioned in here too, resolved via
// getFirstLinkpathDest so a wikilink lands on a real vault path; a managed attachment with
// no entry in EITHER set is orphaned.
export function computeOrphanedAttachmentRows(app: App): OrphanRow[] {
	const referenced = new Set<string>();
	const resolved = app.metadataCache.resolvedLinks;
	for (const source in resolved) {
		for (const target in resolved[source]) referenced.add(target);
	}

	for (const file of app.vault.getFiles()) {
		const frontmatterLinks = app.metadataCache.getFileCache(file)?.frontmatterLinks;
		if (!frontmatterLinks || frontmatterLinks.length === 0) continue;
		for (const fmLink of frontmatterLinks) {
			const dest = app.metadataCache.getFirstLinkpathDest(fmLink.link, file.path);
			if (dest) referenced.add(dest.path);
		}
	}

	const rows: OrphanRow[] = [];
	for (const file of app.vault.getFiles()) {
		if (!MD5_NAME_RE.test(file.name)) continue;
		const type = classifyLocalizeMediaType(file.extension);
		if (!type) continue;
		if (referenced.has(file.path)) continue;
		rows.push({
			file,
			folder: file.parent?.path ?? '',
			type,
			size: file.stat.size,
			mtime: file.stat.mtime,
		});
	}
	return rows;
}
