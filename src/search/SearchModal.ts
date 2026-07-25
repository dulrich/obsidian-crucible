import { App, Modal, Notice, TFile, debounce, setIcon } from 'obsidian';
import type CruciblePlugin from '../main';
import { SEARCH_TYPEAHEAD_DEBOUNCE_MS, SEARCH_TYPEAHEAD_MIN_QUERY_LENGTH, shouldAutoSearch } from './debounce';
import { SearchResult, SearchScoreAttribution } from './types';

export class VaultSearchModal extends Modal {
	private inputEl: HTMLInputElement;
	private resultsEl: HTMLElement;
	private statusEl: HTMLElement;
	/**
	 * Monotonic id of the most recently *issued* search. A response whose id is no longer the
	 * current one is discarded on arrival.
	 *
	 * Type-ahead makes out-of-order responses routine rather than theoretical: latency scales
	 * with how much of the index a query matches, so a broad early query ("the", ~830ms) can
	 * still be in flight when a narrow later one ("theme.css", ~5ms) has already returned and
	 * rendered. Without this guard the slow, less-specific results would land last and win.
	 */
	private searchGeneration = 0;

	constructor(app: App, private readonly plugin: CruciblePlugin, private readonly sweepMode = false) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.sweepMode ? 'Search sweep' : 'Search vault');
		this.contentEl.addClass('crucible-search-modal');
		// The width class has to live on the modal element, not contentEl — contentEl is inside
		// the box whose width we are widening.
		this.modalEl.addClass('crucible-search-modal-shell');

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
				// Enter forces the query through regardless of length — the auto-search gate is a
				// pacing rule for typing, not a restriction on what may be searched.
				void this.runSearch();
			}
		});

		// A sweep query is a free-text project brief, not a term the user refines keystroke by
		// keystroke, and each one costs a query expansion and a wider result set. Type-ahead is
		// for the search modal only.
		if (!this.sweepMode) {
			const autoSearch = debounce(() => void this.runSearch(), SEARCH_TYPEAHEAD_DEBOUNCE_MS, true);
			this.inputEl.addEventListener('input', () => {
				const query = this.inputEl.value.trim();
				if (!shouldAutoSearch(query)) {
					// Abandon whatever is in flight so a stale render cannot land over the hint.
					this.searchGeneration++;
					this.resultsEl.empty();
					this.statusEl.setText(query ? `Type ${SEARCH_TYPEAHEAD_MIN_QUERY_LENGTH} or more characters, or press Enter to search anyway` : '');
					return;
				}
				autoSearch();
			});
		}

		this.statusEl = this.contentEl.createDiv({ cls: 'crucible-search-status' });
		this.resultsEl = this.contentEl.createDiv({ cls: 'crucible-search-results' });
		this.inputEl.focus();
	}

	onClose(): void {
		// Any response still in flight belongs to a modal that no longer exists.
		this.searchGeneration++;
		this.contentEl.empty();
	}

	private async runSearch(): Promise<void> {
		const query = this.inputEl.value.trim();
		if (!query) return;
		const generation = ++this.searchGeneration;
		this.statusEl.setText('Searching...');
		try {
			const response = this.sweepMode
				? await this.plugin.searchManager.sweep(query)
				: await this.plugin.searchManager.search(query);
			if (generation !== this.searchGeneration) return;
			this.statusEl.setText(formatSearchStatus(response.results.length, response.total, response.mode, response.semanticAvailable === false, response.rebuildRequired === true));
			// The full reason rides along as a tooltip so the status line stays short but the
			// stale-index condition is never silent.
			this.statusEl.setAttr('title', response.rebuildRequired && response.message ? response.message : null);
			this.renderResults(response.results);
		} catch (e) {
			if (generation !== this.searchGeneration) return;
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
			// Compact inline actions rather than a `new Setting(row)` block: Setting renders a
			// full-width bordered row with its own padding, which at a dozen results turned the
			// list into a stack of forms and pushed most of the snippets below the fold.
			const actions = header.createDiv({ cls: 'crucible-search-result-actions' });
			const openButton = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Open' } });
			setIcon(openButton, 'arrow-right');
			openButton.onclick = () => void this.openResult(result);
			const copyButton = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Copy path' } });
			setIcon(copyButton, 'copy');
			copyButton.onclick = async () => {
				await navigator.clipboard.writeText(result.path);
				new Notice('Copied path');
			};

			const meta = row.createDiv({ cls: 'crucible-search-result-meta' });
			meta.setText([result.path, result.heading].filter(Boolean).join(' · '));
			row.createDiv({ cls: 'crucible-search-result-snippet', text: result.snippet });
			// The explain line is deliberately verbose (see formatScore) and so gets its own
			// full-width wrapping row; as a nowrap column beside the title it dictated the
			// modal's width instead of fitting inside it.
			row.createDiv({ cls: 'crucible-search-result-score', text: formatScore(result) });
			// The whole row opens the note; the buttons stay for keyboard/explicit use.
			row.addEventListener('click', (evt) => {
				if ((evt.target as HTMLElement).closest('button')) return;
				void this.openResult(result);
			});
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
