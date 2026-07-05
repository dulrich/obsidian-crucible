import { TFile, TFolder } from 'obsidian';

export function* walkMarkdown(folder: TFolder): Generator<TFile> {
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === 'md') yield child;
		if (child instanceof TFolder) yield* walkMarkdown(child);
	}
}
