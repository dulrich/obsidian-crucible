import { App, Modal, Notice, TFile, debounce, setIcon } from 'obsidian';
import type CruciblePlugin from '../main';
import { isImageChunkHeading } from './chunker';
import { SEARCH_TYPEAHEAD_DEBOUNCE_MS, SEARCH_TYPEAHEAD_MIN_QUERY_LENGTH, shouldAutoSearch } from './debounce';
import type { SearchRerankOutcome } from './SearchManager';
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

	// Rerank state. WP-9: the row and button always render — a hidden affordance is
	// undiscoverable, so an unconfigured reranker instead renders a disabled button plus an
	// explanation and a Configure… link (superseding WP-5's "stays absent" behavior).
	// `rerankConfigured` gates every place that would otherwise enable the button on results —
	// see updateRerankAvailability/setRerankPending — so "no reranker configured" always wins
	// over "results exist." `currentResults` is whatever is on screen right now (post-search or
	// post-rerank); `rerankRowMeta` is non-null only after a rerank has actually rendered, and
	// is cleared by every fresh search so a stale before/after annotation can never survive onto
	// new results.
	private rerankButton: HTMLButtonElement | null = null;
	private rerankConfigured = false;
	private currentResults: SearchResult[] = [];
	private rerankRowMeta: Map<string, RerankRowMeta> | null = null;

	/**
	 * The query-log entry for the ranking currently on screen, or null when nothing has been
	 * logged for it (logging off, or no search has landed yet). It is what ties a later click
	 * back to the exact search that produced the list — so it is cleared the instant a new
	 * search is *issued*, not when one returns: between issue and render there is no ranking on
	 * screen that a click could honestly be attributed to.
	 */
	private queryLogEntryId: string | null = null;

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

		// The Rerank action, WP-5: a deliberate, explicitly-invoked button — never reachable from
		// the input handler above, so the type-ahead debounce/3-character gate stay untouched.
		// WP-9: the row always renders now — hiding it entirely (WP-5's original behavior) made
		// the feature undiscoverable for users who never learn it exists. When unconfigured, the
		// button renders disabled with the same guard copy SearchManager.rerank() throws (single
		// source of truth for the explanation), plus a Configure… link next to it — a disabled
		// <button> swallows clicks, so the click affordance has to live beside it, not on it.
		const rerankRow = this.contentEl.createDiv({ cls: 'crucible-search-rerank-row' });
		const unavailableReason = rerankUnavailableReason(this.plugin.settings.searchRerankEnabled, !!this.plugin.settings.searchRerankModel);
		this.rerankConfigured = unavailableReason === null;
		if (unavailableReason) {
			rerankRow.createSpan({ cls: 'crucible-search-rerank-hint', text: unavailableReason });
			const configureButton = rerankRow.createEl('button', { cls: 'crucible-search-rerank-configure', text: 'Configure…' });
			configureButton.onclick = () => {
				this.close();
				this.plugin.openSettingsToTab('orchestrator');
			};
		}
		this.rerankButton = rerankRow.createEl('button', { cls: 'crucible-search-rerank-button', text: 'Rerank results' });
		this.rerankButton.disabled = true;
		this.rerankButton.onclick = () => void this.runRerank();

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
		this.queryLogEntryId = null;
		this.statusEl.setText('Searching...');
		try {
			const response = this.sweepMode
				? await this.plugin.searchManager.sweep(query)
				: await this.plugin.searchManager.search(query);
			if (generation !== this.searchGeneration) return;
			this.statusEl.setText(formatSearchStatus(response.results.length, response.total, response.mode, response.semanticAvailable === false, response.rebuildRequired === true));
			// The full reason rides along as a tooltip so the status line stays short but no
			// degradation is silent. This is not only the rebuild-required case: WP-1 also sets
			// `message` (without `rebuildRequired`) when a query embedding's width disagrees
			// with the vault's — e.g. mid-model-switch — and that condition deserves the same
			// visibility, or semantic silently drops to FTS with no explanation on screen.
			this.statusEl.setAttr('title', response.message || null);
			// A fresh search invalidates any prior rerank annotation — it described a result set
			// that no longer exists on screen.
			this.rerankRowMeta = null;
			this.currentResults = response.results;
			this.updateRerankAvailability();
			this.renderResults(response.results);
			// Passive logging of the search that was actually shown — after the staleness guard
			// above, so a superseded response is never recorded as something the user saw. The
			// call is deliberately not awaited and cannot throw (see queryLog.ts): a measurement
			// side-channel must add no latency to, and no failure mode to, the search path.
			this.queryLogEntryId = this.plugin.searchQueryLog.recordSearch({
				query,
				mode: response.mode ?? null,
				semanticAvailable: response.semanticAvailable ?? null,
				sweep: this.sweepMode,
				shown: response.results.length,
				total: response.total ?? null,
				results: response.results,
			});
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
			// The `Image: ` heading prefix minted by the chunker's image pass is the entire
			// contract — no schema field, no companion change, no score change. Neutral pill, not a
			// status hue: "this hit came from a figure's description rather than the note's prose"
			// is a non-semantic fact about where the match landed, and spending an ok/warn/error
			// colour on it would spend the reader's alarm budget on nothing.
			if (isImageChunkHeading(result.heading)) {
				meta.createSpan({
					cls: 'crucible-pill is-muted crucible-search-result-figure',
					text: 'matched a figure',
				});
			}
			row.createDiv({ cls: 'crucible-search-result-snippet', text: result.snippet });
			// The explain line is deliberately verbose (see formatScore) and so gets its own
			// full-width wrapping row; as a nowrap column beside the title it dictated the
			// modal's width instead of fitting inside it.
			row.createDiv({ cls: 'crucible-search-result-score', text: formatScore(result) });
			// Only present once a rerank has actually run, and only for rows that were part of
			// the reranked slice (a tail beyond top-N has no entry) — see buildRerankRowMeta.
			// Rendered unconditionally when present, including the unchanged case, so "reranking
			// did nothing to this result set" reads as a fact on screen rather than an absence.
			const rowMeta = this.rerankRowMeta?.get(result.chunkId);
			if (rowMeta) {
				row.createDiv({ cls: 'crucible-search-result-rerank', text: formatRerankRow(rowMeta) });
			}
			// The whole row opens the note; the buttons stay for keyboard/explicit use.
			row.addEventListener('click', (evt) => {
				if ((evt.target as HTMLElement).closest('button')) return;
				void this.openResult(result);
			});
		}
	}

	// Explicit, button-only action — this is never invoked from the `input` handler in onOpen(),
	// so the type-ahead debounce and 3-character gate are untouched by rerank latency.
	private async runRerank(): Promise<void> {
		if (!this.rerankButton || this.rerankButton.disabled || !this.rerankConfigured) return;
		const query = this.inputEl.value.trim();
		if (!query || this.currentResults.length === 0) return;

		// Snapshot the generation and the pre-rerank order *before* awaiting. If a newer search
		// supersedes this generation while the rerank is in flight, isRerankStale() below
		// discards the response — the same guard runSearch uses, just consumed rather than
		// incremented (rerank is never itself a new "search").
		const issuedGeneration = this.searchGeneration;
		const before = this.currentResults;
		this.setRerankPending(true);
		try {
			const outcome = await this.plugin.searchManager.rerank(query, before);
			if (isRerankStale(issuedGeneration, this.searchGeneration)) return;
			this.currentResults = outcome.results;
			this.rerankRowMeta = buildRerankRowMeta(before, outcome);
			this.renderResults(this.currentResults);
			// The reranked order replaces the logged ranking: it is the list the user is now
			// choosing from, so it is the one a subsequent click must be scored against.
			if (this.queryLogEntryId) {
				this.plugin.searchQueryLog.recordRerank(this.queryLogEntryId, outcome.results);
			}
		} catch (e) {
			if (isRerankStale(issuedGeneration, this.searchGeneration)) return;
			const message = e instanceof Error ? e.message : String(e);
			new Notice(`Rerank failed: ${message}`);
		} finally {
			if (!isRerankStale(issuedGeneration, this.searchGeneration)) this.setRerankPending(false);
		}
	}

	private setRerankPending(pending: boolean): void {
		if (!this.rerankButton) return;
		this.rerankButton.disabled = pending || !this.rerankConfigured || this.currentResults.length === 0;
		this.rerankButton.setText(pending ? 'Reranking…' : 'Rerank results');
	}

	// `rerankConfigured` always wins here — without it, a search returning results would
	// re-enable the button on an unconfigured reranker the moment results render.
	private updateRerankAvailability(): void {
		if (!this.rerankButton) return;
		this.rerankButton.disabled = !this.rerankConfigured || this.currentResults.length === 0;
	}

	private async openResult(result: SearchResult): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(result.path);
		if (!(file instanceof TFile)) {
			new Notice(`Note not found: ${result.path}`);
			return;
		}
		// The load-bearing signal: which rank the user actually chose. Recorded before the open
		// so a slow `openFile` cannot lose it, and only for a result that resolves to a real
		// file — a click on a stale path is a broken index, not a relevance judgment.
		if (this.queryLogEntryId) {
			this.plugin.searchQueryLog.recordOpen(this.queryLogEntryId, result.path);
		}
		await this.app.workspace.getLeaf(false).openFile(file);
		this.close();
	}
}

// WP-9: the copy shown next to the disabled Rerank button when it isn't configured. Reuses
// the exact guard strings SearchManager.rerank() throws (single source of truth — do not
// invent new copy here or there) and picks the one matching the actual missing piece: the
// enabled-flag check comes first because a disabled model, even if one happens to be set,
// is the more fundamental reason. Returns null when reranking is fully configured, which the
// caller treats as "hide the hint and Configure… link." Exported as a pure function so the
// selection logic is testable without a live Modal or SearchManager.
export function rerankUnavailableReason(enabled: boolean, hasModel: boolean): string | null {
	if (!enabled) return 'Reranking is disabled. Enable it in Settings → Orchestrate → Search.';
	if (!hasModel) return 'No reranker model configured in Settings → Orchestrate → Search.';
	return null;
}

// Discards a rerank response that resolved after a newer search superseded it — the same
// searchGeneration guard runSearch uses (see the block comment above `searchGeneration`).
// Exported as a pure function so the "type-ahead safety" behavior is directly testable without
// instantiating a Modal: a rerank is issued against a snapshot of the generation counter, and if
// a fresh search has since bumped it, the response must never render.
export function isRerankStale(issuedGeneration: number, currentGeneration: number): boolean {
	return issuedGeneration !== currentGeneration;
}

export interface RerankRowMeta {
	beforeRank: number;
	afterRank: number;
	relevanceScore: number;
}

// Pure: computes the before/after rank (1-based) and reranker score for every result that
// participated in a rerank, keyed by chunkId. `before` is the result order the user saw at the
// moment they clicked Rerank; `outcome.results`/`outcome.scores` come straight from
// SearchManager.rerank(). A result absent from `outcome.scores` was beyond the reranked top-N
// (the untouched tail) and gets no row meta at all — there's nothing to report about a move that
// never had a chance to happen. Exported so tests/providerRerank.test.mjs can assert the mapping
// — including the out-of-order case — without a live Modal.
export function buildRerankRowMeta(before: SearchResult[], outcome: SearchRerankOutcome): Map<string, RerankRowMeta> {
	const beforeRank = new Map<string, number>();
	before.forEach((result, i) => beforeRank.set(result.chunkId, i + 1));

	const meta = new Map<string, RerankRowMeta>();
	outcome.results.forEach((result, i) => {
		const relevanceScore = outcome.scores.get(result.chunkId);
		if (relevanceScore === undefined) return;
		meta.set(result.chunkId, {
			beforeRank: beforeRank.get(result.chunkId) ?? i + 1,
			afterRank: i + 1,
			relevanceScore,
		});
	});
	return meta;
}

// Renders explicitly as "(unchanged)" rather than repeating the same number twice, so a rerank
// that reorders nothing reads as an observed fact rather than something the reader has to notice
// by comparing two identical numbers.
export function formatRerankRow(meta: RerankRowMeta): string {
	const movement = meta.beforeRank === meta.afterRank
		? `#${meta.beforeRank} (unchanged)`
		: `#${meta.beforeRank} → #${meta.afterRank}`;
	return `rerank ${movement} · score ${meta.relevanceScore.toFixed(3)}`;
}

function formatSearchStatus(visible: number, total: number | undefined, mode: string | undefined, ftsOnly: boolean, rebuildRequired = false): string {
	const count = typeof total === 'number' && total > visible
		? `Showing ${visible} of ${total}`
		: `${visible} results`;
	return `${count}${mode ? ` · ${mode}` : ''}${ftsOnly ? ' · FTS only' : ''}${rebuildRequired ? ' · index rebuild required' : ''}`;
}

// The per-stage explain line: base score, the ranks that were fused, every boost that
// fired, and the fused value. Ranking is meant to be tunable by observation, so this stays
// verbose rather than pretty. Exported so tests/searchModalFormat.test.mjs can assert on it
// without instantiating a Modal.
export function formatScore(result: SearchResult): string {
	const parts = [`${result.score.toFixed(4)}`];
	if (typeof result.scoreText === 'number') parts.push(`text ${result.scoreText.toFixed(3)}`);
	if (typeof result.scoreVector === 'number') parts.push(`vec ${result.scoreVector.toFixed(3)}`);
	if (typeof result.scoreRrf === 'number') parts.push(`rrf ${result.scoreRrf.toFixed(4)}`);
	parts.push(...formatAttribution(result.attribution));
	return parts.join(' · ');
}

export function formatAttribution(attribution: SearchScoreAttribution | undefined): string[] {
	if (!attribution) return [];
	const parts: string[] = [];
	if (typeof attribution.textRank === 'number') parts.push(`text #${attribution.textRank}`);
	if (typeof attribution.titleRank === 'number') parts.push(`title #${attribution.titleRank}`);
	if (typeof attribution.vectorRank === 'number') parts.push(`vec #${attribution.vectorRank}`);
	if (typeof attribution.titleBoost === 'number' && attribution.titleBoost > 0) parts.push(`title +${attribution.titleBoost.toFixed(2)}`);
	if (typeof attribution.pooledChunks === 'number' && attribution.pooledChunks > 1) parts.push(`${attribution.pooledChunks} chunks`);
	for (const [name, value] of Object.entries(attribution.boosts ?? {})) parts.push(`${name} +${value.toFixed(2)}`);
	return parts;
}
