import { App, TFile, TFolder } from 'obsidian';
import type { ClippingRow } from '../render/types';

// Markdown files directly under the configured clipper inbox folder. Returns
// null when the folder is missing so the caller can surface that distinctly.
export function computeUnprocessedClippingRows(app: App, folder: string): ClippingRow[] | null {
	const root = app.vault.getAbstractFileByPath(folder);
	if (!(root instanceof TFolder)) return null;
	return root.children
		.filter((c): c is TFile => c instanceof TFile && c.extension === 'md')
		.map(f => ({
			file: f,
			title: f.basename,
			captured: f.stat.mtime,
			size: f.stat.size,
		}));
}
