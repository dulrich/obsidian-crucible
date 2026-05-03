import { App, TFile } from 'obsidian';

export function findRawTranscripts(app: App): TFile[] {
	const out: TFile[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (fm && fm['transcript_status'] === 'raw') out.push(file);
	}
	return out;
}
