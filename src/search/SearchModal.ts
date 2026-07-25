import { App, Modal, Notice, Setting, TFile, setIcon } from 'obsidian';
import type CruciblePlugin from '../main';
import { SearchResult, SearchScoreAttribution } from './types';

export class VaultSearchModal extends Modal {
	private inputEl: HTMLInputElement;
	private resultsEl: HTMLElement;
	private statusEl: HTMLElement;

	constructor(app: App, private readonly plugin: CruciblePlugin, private readonly sweepMode = false) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.sweepMode ? 'Search sweep' : 'Search vault');
		this.contentEl.addClass('crucible-search-modal');

		const form = this.contentEl.createDiv({ cls: 'crucible-search-form' });
		this.inputEl = form.createEl('input', {
			type: 'text',
			placeholder: this.sweepMode ? 'Brief project description...' : 'Search notes...',
		});
		this.inputEl.addClass('crucible-search-input');
		const runButton = form.createEl('button', { cls: 'clickable-icon crucible-search-run' });
		setIcon(runButton, 'search');
		runButton.setAttr('aria-label', 'Search');
		runButton.onclick = () => void this.runSearch();
		this.inputEl.addEventListener('keydown', (evt) => {
			if (evt.key === 'Enter') {
				evt.preventDefault();
				void this.runSearch();
			}
		});

		this.statusEl = this.contentEl.createDiv({ cls: 'crucible-search-status' });
		this.resultsEl = this.contentEl.createDiv({ cls: 'crucible-search-results' });
		this.inputEl.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async runSearch(): Promise<void> {
		const query = this.inputEl.value.trim();
		if (!query) return;
		this.statusEl.setText('Searching...');
		this.resultsEl.empty();
		try {
			const response = this.sweepMode
				? await this.plugin.searchManager.sweep(query)
				: await this.plugin.searchManager.search(query);
			this.statusEl.setText(formatSearchStatus(response.results.length, response.total, response.mode, response.semanticAvailable === false, response.rebuildRequired === true));
			// The full reason rides along as a tooltip so the status line stays short but the
			// stale-index condition is never silent.
			this.statusEl.setAttr('title', response.rebuildRequired && response.message ? response.message : null);
			this.renderResults(response.results);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.statusEl.setText('Search failed');
			new Notice(`Search failed: ${message}`);
		}
	}

	private renderResults(results: SearchResult[]): void {
		this.resultsEl.empty();
		if (results.length === 0) {
			this.resultsEl.createDiv({ cls: 'crucible-empty-state', text: 'No results.' });
			return;
		}
		for (const result of results) {
			const row = this.resultsEl.createDiv({ cls: 'crucible-search-result' });
			const header = row.createDiv({ cls: 'crucible-search-result-header' });
			const title = header.createDiv({ cls: 'crucible-search-result-title' });
			title.setText(result.title || result.path);
			const score = header.createDiv({ cls: 'crucible-search-result-score' });
			score.setText(formatScore(result));
			const meta = row.createDiv({ cls: 'crucible-search-result-meta' });
			meta.setText([result.path, result.heading].filter(Boolean).join(' · '));
			row.createDiv({ cls: 'crucible-search-result-snippet', text: result.snippet });
			new Setting(row)
				.addButton(button => button
					.setButtonText('Open')
					.onClick(() => void this.openResult(result)))
				.addButton(button => button
					.setButtonText('Copy path')
					.onClick(async () => {
						await navigator.clipboard.writeText(result.path);
						new Notice('Copied path');
					}));
		}
	}

	private async openResult(result: SearchResult): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(result.path);
		if (!(file instanceof TFile)) {
			new Notice(`Note not found: ${result.path}`);
			return;
		}
		await this.app.workspace.getLeaf(false).openFile(file);
		this.close();
	}
}

function formatSearchStatus(visible: number, total: number | undefined, mode: string | undefined, ftsOnly: boolean, rebuildRequired = false): string {
	const count = typeof total === 'number' && total > visible
		? `Showing ${visible} of ${total}`
		: `${visible} results`;
	return `${count}${mode ? ` · ${mode}` : ''}${ftsOnly ? ' · FTS only' : ''}${rebuildRequired ? ' · index rebuild required' : ''}`;
}

// The per-stage explain line: base score, the ranks that were fused, every boost that
// fired, and the fused value. Ranking is meant to be tunable by observation, so this stays
// verbose rather than pretty.
function formatScore(result: SearchResult): string {
	const parts = [`${result.score.toFixed(4)}`];
	if (typeof result.scoreText === 'number') parts.push(`text ${result.scoreText.toFixed(3)}`);
	if (typeof result.scoreVector === 'number') parts.push(`vec ${result.scoreVector.toFixed(3)}`);
	if (typeof result.scoreRrf === 'number') parts.push(`rrf ${result.scoreRrf.toFixed(4)}`);
	parts.push(...formatAttribution(result.attribution));
	return parts.join(' · ');
}

function formatAttribution(attribution: SearchScoreAttribution | undefined): string[] {
	if (!attribution) return [];
	const parts: string[] = [];
	if (typeof attribution.textRank === 'number') parts.push(`text #${attribution.textRank}`);
	if (typeof attribution.titleRank === 'number') parts.push(`title #${attribution.titleRank}`);
	if (typeof attribution.titleBoost === 'number' && attribution.titleBoost > 0) parts.push(`title +${attribution.titleBoost.toFixed(2)}`);
	if (typeof attribution.pooledChunks === 'number' && attribution.pooledChunks > 1) parts.push(`${attribution.pooledChunks} chunks`);
	for (const [name, value] of Object.entries(attribution.boosts ?? {})) parts.push(`${name} +${value.toFixed(2)}`);
	return parts;
}
