import { App, Modal, Notice, Setting, TFile, setIcon } from 'obsidian';
import type CruciblePlugin from '../main';
import { SearchResult } from './types';

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
			this.statusEl.setText(`${response.results.length} results${response.mode ? ` · ${response.mode}` : ''}${response.semanticAvailable === false ? ' · FTS only' : ''}`);
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

function formatScore(result: SearchResult): string {
	const parts = [`${result.score.toFixed(3)}`];
	if (typeof result.scoreText === 'number') parts.push(`text ${result.scoreText.toFixed(3)}`);
	if (typeof result.scoreVector === 'number') parts.push(`vec ${result.scoreVector.toFixed(3)}`);
	if (typeof result.scoreRrf === 'number') parts.push(`rrf ${result.scoreRrf.toFixed(3)}`);
	return parts.join(' · ');
}
