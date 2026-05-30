import { App, TFile, TFolder, getAllTags } from 'obsidian';
import type { TranscriptRow } from '../render/types';

// Walks the daily folder for notes tagged #transcript but not yet #refined,
// parsing word-count/created frontmatter and deriving an estimated read time
// from `wpm`. Returns null when the daily folder is missing.
export function computeUnrefinedTranscriptRows(app: App, dailyFolder: string, wpm: number): TranscriptRow[] | null {
	const folder = app.vault.getAbstractFileByPath(dailyFolder);
	if (!(folder instanceof TFolder)) return null;

	const excludeTags = new Set(['clippings', 'using']);
	const rows: TranscriptRow[] = [];

	const visit = (f: TFolder) => {
		for (const child of f.children) {
			if (child instanceof TFolder) visit(child);
			else if (child instanceof TFile && child.extension === 'md') {
				const cache = app.metadataCache.getFileCache(child);
				if (!cache) continue;
				const allTags = (getAllTags(cache) ?? []).map(t => t.replace(/^#/, ''));
				if (!allTags.includes('transcript')) continue;
				if (allTags.includes('refined')) continue;
				const fm: Record<string, unknown> = cache.frontmatter ?? {};
				const rawWordCount: unknown = fm['word-count'];
				const words = typeof rawWordCount === 'number'
					? rawWordCount
					: Number(rawWordCount) || 0;
				const createdRaw: unknown = fm['created'];
				const created = typeof createdRaw === 'string' ? Date.parse(createdRaw) || child.stat.ctime : child.stat.ctime;
				rows.push({
					file: child,
					title: child.basename,
					tags: allTags.filter(t => !excludeTags.has(t) && t !== 'transcript'),
					words,
					estReadMin: words && wpm ? words / wpm : null,
					created,
					read: fm['read'] === true,
				});
			}
		}
	};
	visit(folder);

	return rows;
}
