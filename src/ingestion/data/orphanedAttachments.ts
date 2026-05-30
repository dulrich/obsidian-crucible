import { App } from 'obsidian';
import { MD5_NAME_RE } from '../../localizeAttachments';
import { classifyLocalizeMediaType } from '../../utils';
import type { OrphanRow } from '../render/types';

// Localized attachments (…_MD5.ext) with no back-reference from any note.
// resolvedLinks maps each source note to the targets it references (embeds
// included); a managed attachment with no entry there is orphaned.
export function computeOrphanedAttachmentRows(app: App): OrphanRow[] {
	const referenced = new Set<string>();
	const resolved = app.metadataCache.resolvedLinks;
	for (const source in resolved) {
		for (const target in resolved[source]) referenced.add(target);
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
