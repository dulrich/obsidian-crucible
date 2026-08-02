import { App, Component, EventRef, Notice, TFile, debounce, setIcon } from 'obsidian';
import type CruciblePlugin from './main';
import { computeBlogControlRows } from './ingestion/data/blogs';
import { computeChannelControlRows } from './ingestion/data/channels';
import { renderTableSection } from './ingestion/render/section';
import type { Column, SortState } from './ingestion/render/types';
import { computeCaptureIndex } from './sourceEval/captureIndex';
import { exportSourceEvalTrainingData } from './sourceEval/export';
import { computeSourceEvalRows } from './sourceEval/metrics';
import { SourceEvalRatingPanel } from './sourceEval/ratingPanel';
import { buildRatingQueue, type RatingQueueBroadScope, type RatingQueueScope } from './sourceEval/ratingQueue';
import { scanObservationSignals } from './sourceEval/signals';
import type { CaptureRecord, ObservationSignalMap, SourceEvalRow, SourceKey, SourceType } from './sourceEval/types';
import type { BlogControlRow, ChannelControlRow } from './ingestion/render/types';
import { INTAKE_ROOT_BLOGS, INTAKE_ROOT_YOUTUBE } from './orchestration/utils/feedIntake';
import { IGNORED_IDS_NOTE } from './orchestration/utils/ignoredIds';
import { countWithPct, formatPct } from './ingestion/render/format';

type SourceEvalSectionId = 'scorecard' | 'labelQueue' | 'coverage';
type ScoreFilter = 'all' | 'tracked' | 'untracked' | 'blogs' | 'youtube';
type QueueFilterScope = RatingQueueBroadScope;

interface SourceEvalSectionContext {
	id: SourceEvalSectionId;
	body: HTMLElement;
	countEl: HTMLElement;
	metaEl: HTMLElement;
	sort: SortState | null;
	refresh: () => Promise<void> | void;
}

interface CoverageRow {
	source: SourceKey;
	name: string;
	type: SourceType;
	captures: number;
	labeled: number;
	meanImportance: number | null;
	urgentPct: number | null;
}

const SCAN_DEBOUNCE_MS = 1000;

export class SourceEvalDashboardUI {
	private readonly app: App;
	private readonly component = new Component();
	private readonly sections = new Map<SourceEvalSectionId, SourceEvalSectionContext>();
	private readonly eventRefs: EventRef[] = [];
	private readonly disposers: Array<() => void> = [];
	private readonly relevantSignatures = new Map<string, string>();
	private captures: CaptureRecord[] = [];
	private rows: SourceEvalRow[] = [];
	private blogRows: BlogControlRow[] = [];
	private channelRows: ChannelControlRow[] = [];
	private observations: ObservationSignalMap = new Map();
	private scoreFilter: ScoreFilter = 'all';
	private queueScope: RatingQueueScope = 'all';
	private queueUnlabeledOnly = true;
	private exportWeakLabels = false;
	private skippedQueuePaths = new Set<string>();
	private refreshSeq = 0;

	constructor(private readonly plugin: CruciblePlugin, private readonly container: HTMLElement) {
		this.app = plugin.app;
	}

	mount(): void {
		this.container.empty();
		this.component.load();

		const header = this.container.createDiv({ cls: 'crucible-source-eval-header' });
		header.createEl('h2', { text: 'Source eval dashboard' });

		if (!this.plugin.settings.sourceEvalEnabled) {
			this.container.createDiv({ cls: 'crucible-empty-state', text: 'Source eval dashboard is disabled in settings.' });
			return;
		}

		this.renderExportControls(header);
		this.buildSection('scorecard', 'Source scorecard');
		this.buildSection('labelQueue', 'Labeling queue');
		this.buildSection('coverage', 'Label coverage');
		this.registerListeners();
		void this.refreshAll();
	}

	unmount(): void {
		for (const off of this.disposers) {
			try { off(); } catch { /* ignore disposer failures */ }
		}
		this.disposers.length = 0;
		for (const ref of this.eventRefs) {
			this.app.vault.offref(ref);
			this.app.metadataCache.offref(ref);
		}
		this.eventRefs.length = 0;
		this.component.unload();
		this.sections.clear();
		this.relevantSignatures.clear();
		this.container.empty();
	}

	private renderExportControls(parent: HTMLElement): void {
		const controls = parent.createDiv({ cls: 'crucible-source-eval-export-controls' });
		const weakLabel = controls.createEl('label', { cls: 'crucible-source-eval-toggle' });
		const weak = weakLabel.createEl('input', { type: 'checkbox' });
		weak.checked = this.exportWeakLabels;
		weakLabel.appendText(' Include weak labels');
		weak.addEventListener('change', () => {
			this.exportWeakLabels = weak.checked;
		});

		const button = controls.createEl('button', { cls: 'mod-cta crucible-source-eval-export crucible-icon-label-btn' });
		setIcon(button, 'download');
		button.createSpan({ text: 'Export JSONL' });
		button.addEventListener('click', () => {
			void this.runExport(button);
		});
	}

	private async runExport(button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		try {
			const result = await exportSourceEvalTrainingData(this.app, this.plugin, {
				includeWeakLabels: this.exportWeakLabels,
			});
			new Notice(`Exported ${result.count} source eval row${result.count === 1 ? '' : 's'} to ${result.path}`);
		} catch (e) {
			new Notice(`Source eval export failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			button.disabled = false;
		}
	}

	private buildSection(id: SourceEvalSectionId, title: string): void {
		const card = this.container.createDiv({ cls: 'crucible-source-eval-section' });
		card.addClass('is-collapsed');
		const heading = card.createDiv({ cls: 'crucible-source-eval-section-header' });
		const toggle = heading.createDiv({ cls: 'crucible-source-eval-section-toggle' });
		setIcon(toggle, 'chevron-right');
		const h3 = heading.createEl('h3', { text: title });
		const countEl = h3.createSpan({ cls: 'crucible-source-eval-section-count' });
		const metaEl = heading.createSpan({ cls: 'crucible-source-eval-section-meta' });
		const refreshBtn = heading.createEl('button', { cls: 'clickable-icon crucible-source-eval-refresh' });
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.setAttr('aria-label', `Refresh ${title}`);
		refreshBtn.setAttr('title', 'Refresh');
		const body = card.createDiv({ cls: 'crucible-source-eval-section-body' });
		body.createDiv({ cls: 'crucible-empty-state', text: 'Loading...' });

		const ctx: SourceEvalSectionContext = {
			id,
			body,
			countEl,
			metaEl,
			sort: null,
			refresh: () => this.renderSection(id),
		};
		this.sections.set(id, ctx);
		refreshBtn.addEventListener('click', () => void this.refreshAll());
		heading.addEventListener('click', evt => {
			if ((evt.target as HTMLElement).closest('button, input, a, label, select')) return;
			const collapsed = card.classList.toggle('is-collapsed');
			setIcon(toggle, collapsed ? 'chevron-right' : 'chevron-down');
		});
	}

	private registerListeners(): void {
		const debounced = debounce(() => void this.refreshAll(), SCAN_DEBOUNCE_MS, true);
		const route = (path: string, structural: boolean) => {
			if (structural) {
				this.relevantSignatures.delete(path);
				debounced();
				return;
			}
			if (this.shouldAlwaysRefresh(path)) {
				debounced();
				return;
			}
			const next = this.relevantSignature(path);
			const prev = this.relevantSignatures.get(path);
			this.relevantSignatures.set(path, next);
			if (next !== prev) debounced();
		};

		this.eventRefs.push(this.app.metadataCache.on('changed', file => route(file.path, false)));
		this.eventRefs.push(this.app.vault.on('create', file => route(file.path, true)));
		this.eventRefs.push(this.app.vault.on('delete', file => route(file.path, true)));
		this.eventRefs.push(this.app.vault.on('rename', (file, oldPath) => {
			route(file.path, true);
			route(oldPath, true);
		}));

		const bus = this.plugin.ingestionEvents;
		if (bus) {
			this.disposers.push(bus.on('tracker-run', () => debounced()));
			this.disposers.push(bus.on('metadata-enriched', () => debounced()));
		}
	}

	private shouldAlwaysRefresh(path: string): boolean {
		const monthlyRoot = this.plugin.settings.monthlyFolder;
		return path === IGNORED_IDS_NOTE ||
			path.startsWith(`${INTAKE_ROOT_BLOGS}/`) ||
			path.startsWith(`${INTAKE_ROOT_YOUTUBE}/`) ||
			(Boolean(monthlyRoot) && path.startsWith(`${monthlyRoot}/`));
	}

	private relevantSignature(path: string): string {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return '';
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter ?? {};
		const tags = cache ? cache.tags?.map(t => t.tag).sort().join(',') ?? '' : '';
		const links = [
			...(cache?.embeds ?? []).map(e => e.link),
			...(cache?.links ?? []).map(l => l.link),
		].sort().join(',');
		const headings = cache?.headings?.map(h => `${h.level}:${h.heading}:${h.position.start.offset}`).join('|') ?? '';
		return JSON.stringify([
			fm.source,
			fm.blog,
			fm['post-id'],
			fm['yt-video-id'],
			fm['yt-metadata'],
			fm['word-count'],
			fm.read,
			fm.published,
			fm.created,
			fm['eval-importance'],
			fm['eval-urgent'],
			fm['eval-rated'],
			tags,
			links,
			headings,
		]);
	}

	private async refreshAll(): Promise<void> {
		if (!this.plugin.settings.sourceEvalEnabled) {
			for (const ctx of this.sections.values()) {
				ctx.body.empty();
				ctx.body.createDiv({ cls: 'crucible-empty-state', text: 'Source eval dashboard is disabled in settings.' });
				ctx.countEl.setText('');
				ctx.metaEl.setText('');
			}
			return;
		}

		const seq = ++this.refreshSeq;
		const [captures, observations, blogRows, channelRows] = await Promise.all([
			computeCaptureIndex(this.app, this.plugin),
			scanObservationSignals(this.app, this.plugin.settings.monthlyFolder),
			computeBlogControlRows(this.app, this.plugin),
			computeChannelControlRows(this.app, this.plugin),
		]);
		if (seq !== this.refreshSeq) return;

		this.captures = captures ?? [];
		this.observations = observations;
		this.blogRows = blogRows;
		this.channelRows = channelRows;
		this.rows = computeSourceEvalRows({
			captures: this.captures,
			blogRows,
			channelRows,
			observations,
			settings: {
				readingBudgetWords: this.plugin.settings.sourceEvalReadingBudgetWords,
				budgetPeriod: this.plugin.settings.sourceEvalBudgetPeriod,
				lookbackDays: this.plugin.settings.sourceEvalLookbackDays,
				recencyHalfLifeDays: this.plugin.settings.sourceEvalRecencyHalfLifeDays,
			},
		});
		for (const id of this.sections.keys()) await this.renderSection(id);
	}

	private async renderSection(id: SourceEvalSectionId): Promise<void> {
		switch (id) {
			case 'scorecard':
				this.renderScorecard();
				break;
			case 'labelQueue':
				this.renderLabelQueue();
				break;
			case 'coverage':
				this.renderCoverage();
				break;
		}
	}

	private renderScorecard(): void {
		const ctx = this.sections.get('scorecard');
		if (!ctx) return;
		const rows = this.filteredScoreRows();
		ctx.body.empty();
		this.renderScoreFilters(ctx.body);
		const tableHost = ctx.body.createDiv({ cls: 'crucible-source-eval-scorecard-table-wrap' });
		this.setSectionMeta('scorecard', this.budgetMeta());
		renderTableSection<SourceEvalRow>({
			body: tableHost,
			ctx,
			rows,
			columns: this.scoreColumns(),
			emptyText: 'No sources found.',
			setCount: n => this.setSectionCount('scorecard', n),
			defaultSort: { column: 'score', direction: 'desc' },
		});
	}

	private renderScoreFilters(parent: HTMLElement): void {
		const controls = parent.createDiv({ cls: 'crucible-source-eval-filter-row' });
		const filters: Array<[ScoreFilter, string]> = [
			['all', 'All'],
			['tracked', 'Tracked'],
			['untracked', 'Untracked'],
			['blogs', 'Blogs'],
			['youtube', 'YouTube'],
		];
		for (const [value, label] of filters) {
			const btn = controls.createEl('button', { text: label, cls: 'crucible-source-eval-filter' });
			btn.toggleClass('is-active', this.scoreFilter === value);
			btn.setAttr('aria-pressed', String(this.scoreFilter === value));
			btn.addEventListener('click', () => {
				this.scoreFilter = value;
				this.renderScorecard();
			});
		}
	}

	private scoreColumns(): Column<SourceEvalRow>[] {
		const blogLinks = new Map(this.blogRows.map(row => [`blog:${row.blogKey}` as SourceKey, row.link]));
		return [
			{
				key: 'source',
				label: 'Source',
				sortable: true,
				sortKey: row => row.name.toLowerCase(),
				render: (row, td) => this.renderSourceCell(td, row, blogLinks.get(row.source) ?? null),
			},
			{ key: 'type', label: 'Type', sortable: true, sortKey: row => row.type, render: (row, td) => td.setText(row.type) },
			{ key: 'tracked', label: 'Tracked', sortable: true, sortKey: row => row.tracked ? 1 : 0, render: (row, td) => td.setText(row.tracked ? 'Yes' : 'No') },
			{ key: 'captures', label: 'Captures', sortable: true, sortKey: row => row.captures, render: (row, td) => td.setText(String(row.captures)) },
			{ key: 'ingest', label: 'Ingest %', sortable: true, sortKey: row => row.ingestRate ?? -1, render: (row, td) => td.setText(formatPct(row.ingestRate)) },
			{ key: 'read', label: 'Read %', sortable: true, sortKey: row => row.readRate ?? -1, render: (row, td) => td.setText(formatPct(row.readRate)) },
			{ key: 'gold', label: 'Gold', sortable: true, sortKey: row => row.goldRate, render: (row, td) => td.setText(countWithPct(Math.round(row.goldRate * row.captures), row.captures)) },
			{ key: 'goldmine', label: 'Goldmine', sortable: true, sortKey: row => row.goldmineCount, render: (row, td) => td.setText(String(row.goldmineCount)) },
			{ key: 'obs', label: 'Obs', sortable: true, sortKey: row => row.obsCount, render: (row, td) => td.setText(row.obsQuotes > 0 ? `${row.obsCount} / ${row.obsQuotes}q` : String(row.obsCount)) },
			{ key: 'words', label: 'Words/wk', sortable: true, sortKey: row => row.wordsPerWeek, render: (row, td) => td.setText(formatCompact(row.wordsPerWeek)) },
			{ key: 'budget', label: 'Budget %', sortable: true, sortKey: row => row.budgetShare ?? -1, render: (row, td) => td.setText(formatPct(row.budgetShare)) },
			{ key: 'density', label: 'Density', sortable: true, sortKey: row => row.valueDensity ?? -1, render: (row, td) => td.setText(row.valueDensity === null ? '--' : row.valueDensity.toFixed(1)) },
			{ key: 'score', label: 'Score', sortable: true, sortKey: row => row.score, render: (row, td) => td.setText(row.score.toFixed(2)) },
			{ key: 'labeled', label: 'Labeled %', sortable: true, sortKey: row => row.labeledPct, render: (row, td) => td.setText(countWithPct(row.labeled, row.captures)) },
		];
	}

	private renderLabelQueue(): void {
		const ctx = this.sections.get('labelQueue');
		if (!ctx) return;
		ctx.body.empty();

		const controls = ctx.body.createDiv({ cls: 'crucible-source-eval-queue-controls' });
		const select = controls.createEl('select', { cls: 'crucible-source-eval-scope-select' });
		const broadScopes: Array<[QueueFilterScope, string]> = [
			['all', 'Recent: All'],
			['tracked', 'Recent: Tracked'],
			['untracked', 'Recent: Untracked'],
			['blogs', 'Recent: Blogs'],
			['youtube', 'Recent: YouTube'],
		];
		for (const [value, label] of broadScopes) {
			select.createEl('option', { text: label, value });
		}
		for (const row of this.sourceOptions()) {
			const label = `${row.type === 'blog' ? 'Blog' : 'Channel'}: ${row.name}`;
			select.createEl('option', { text: label, value: row.source });
		}
		if (!this.isKnownQueueScope(this.queueScope)) this.queueScope = 'all';
		select.value = this.queueScope;
		select.addEventListener('change', () => {
			this.queueScope = select.value as RatingQueueScope;
			this.skippedQueuePaths.clear();
			this.renderLabelQueue();
		});

		const toggleLabel = controls.createEl('label', { cls: 'crucible-source-eval-toggle' });
		const toggle = toggleLabel.createEl('input', { type: 'checkbox' });
		toggle.checked = this.queueUnlabeledOnly;
		toggleLabel.appendText(' Unlabeled only');
		toggle.addEventListener('change', () => {
			this.queueUnlabeledOnly = toggle.checked;
			this.skippedQueuePaths.clear();
			this.renderLabelQueue();
		});

		const queue = buildRatingQueue(this.captures, {
			scope: this.queueScope,
			unlabeledOnly: this.queueUnlabeledOnly,
			sources: this.rows,
		}).filter(capture => !this.skippedQueuePaths.has(capture.file.path));
		this.setSectionCount('labelQueue', queue.length);
		this.setSectionMeta('labelQueue', this.queueScopeLabel(this.queueScope));

		const panelHost = ctx.body.createDiv({ cls: 'crucible-source-eval-rating-host' });
		const capture = queue[0] ?? null;
		new SourceEvalRatingPanel({
			app: this.app,
			component: this.component,
			container: panelHost,
			capture,
			sourceName: capture?.source ? this.sourceName(capture.source) : '',
			enabled: this.plugin.settings.sourceEvalEnabled,
			onSaved: async file => {
				this.skippedQueuePaths.add(file.path);
				await this.refreshAll();
			},
				onNext: file => {
					this.skippedQueuePaths.add(file.path);
					this.renderLabelQueue();
				},
				onPersistentSkip: async file => {
					this.skippedQueuePaths.add(file.path);
					await this.refreshAll();
				},
			}).render();
	}

	private renderCoverage(): void {
		const ctx = this.sections.get('coverage');
		if (!ctx) return;
		this.setSectionMeta('coverage', '');
		renderTableSection<CoverageRow>({
			body: ctx.body,
			ctx,
			rows: this.coverageRows(),
			columns: [
				{ key: 'source', label: 'Source', sortable: true, sortKey: row => row.name.toLowerCase(), render: (row, td) => td.setText(row.name) },
				{ key: 'type', label: 'Type', sortable: true, sortKey: row => row.type, render: (row, td) => td.setText(row.type) },
				{ key: 'labeled', label: 'Labeled', sortable: true, sortKey: row => row.captures > 0 ? row.labeled / row.captures : 0, render: (row, td) => td.setText(countWithPct(row.labeled, row.captures)) },
				{ key: 'mean', label: 'Mean importance', sortable: true, sortKey: row => row.meanImportance ?? -1, render: (row, td) => td.setText(row.meanImportance === null ? '--' : row.meanImportance.toFixed(1)) },
				{ key: 'urgent', label: '% urgent', sortable: true, sortKey: row => row.urgentPct ?? -1, render: (row, td) => td.setText(formatPct(row.urgentPct)) },
			],
			emptyText: 'No labeled captures found.',
			setCount: n => this.setSectionCount('coverage', n),
			defaultSort: { column: 'labeled', direction: 'desc' },
		});
	}

	private filteredScoreRows(): SourceEvalRow[] {
		switch (this.scoreFilter) {
			case 'tracked': return this.rows.filter(row => row.tracked);
			case 'untracked': return this.rows.filter(row => !row.tracked);
			case 'blogs': return this.rows.filter(row => row.type === 'blog');
			case 'youtube': return this.rows.filter(row => row.type === 'youtube');
			default: return this.rows;
		}
	}

	private coverageRows(): CoverageRow[] {
		const bySource = new Map<SourceKey, CaptureRecord[]>();
		for (const capture of this.captures) {
			if (!capture.source) continue;
			const list = bySource.get(capture.source) ?? [];
			list.push(capture);
			bySource.set(capture.source, list);
		}
		return Array.from(bySource, ([source, captures]) => {
			const labels = captures.map(c => c.label).filter(label => label !== null);
			const importance = labels
				.map(label => label.importance)
				.filter((value): value is number => value !== null);
			const urgent = labels.filter(label => label.urgent).length;
			const type: SourceType = source.startsWith('youtube:') ? 'youtube' : 'blog';
			return {
				source,
				name: this.sourceName(source),
				type,
				captures: captures.length,
				labeled: labels.length,
				meanImportance: importance.length > 0 ? importance.reduce((sum, value) => sum + value, 0) / importance.length : null,
				urgentPct: labels.length > 0 ? urgent / labels.length : null,
			};
		}).sort((a, b) => b.labeled - a.labeled || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
	}

	private sourceName(source: SourceKey): string {
		return this.rows.find(row => row.source === source)?.name ?? source.slice(source.indexOf(':') + 1);
	}

	private queueScopeLabel(scope: RatingQueueScope): string {
		switch (scope) {
			case 'all': return 'recent all';
			case 'tracked': return 'recent tracked';
			case 'untracked': return 'recent untracked';
			case 'blogs': return 'recent blogs';
			case 'youtube': return 'recent YouTube';
			default: return this.sourceName(scope);
		}
	}

	private sourceOptions(): SourceEvalRow[] {
		return [...this.rows].sort((a, b) =>
			a.type.localeCompare(b.type) || a.name.toLowerCase().localeCompare(b.name.toLowerCase())
		);
	}

	private isKnownQueueScope(scope: RatingQueueScope): boolean {
		if (scope === 'all' || scope === 'tracked' || scope === 'untracked' || scope === 'blogs' || scope === 'youtube') return true;
		return this.rows.some(row => row.source === scope);
	}

	private budgetMeta(): string {
		const words = this.rows.reduce((sum, row) => sum + row.wordsPerWeek, 0);
		const weeklyBudget = this.weeklyBudget();
		return `${formatCompact(words)} of ${formatCompact(weeklyBudget)} words/wk budget`;
	}

	private weeklyBudget(): number {
		const budget = this.plugin.settings.sourceEvalReadingBudgetWords;
		if (this.plugin.settings.sourceEvalBudgetPeriod !== 'month') return budget;
		return budget / (365.2425 / 12 / 7);
	}

	private renderSourceCell(td: HTMLElement, row: SourceEvalRow, blogLink: string | null): void {
		if (row.type === 'blog' && blogLink) {
			const a = td.createEl('a', { text: row.name, href: blogLink });
			a.setAttr('target', '_blank');
			a.setAttr('rel', 'noopener');
			return;
		}
		if (row.type === 'youtube') {
			const channelId = row.source.slice('youtube:'.length);
			const a = td.createEl('a', { text: row.name, href: `https://www.youtube.com/channel/${channelId}` });
			a.setAttr('target', '_blank');
			a.setAttr('rel', 'noopener');
			return;
		}
		td.setText(row.name);
	}

	private setSectionCount(id: SourceEvalSectionId, n: number): void {
		const ctx = this.sections.get(id);
		if (!ctx) return;
		ctx.countEl.setText(n > 0 ? ` (${n})` : '');
	}

	private setSectionMeta(id: SourceEvalSectionId, text: string): void {
		const ctx = this.sections.get(id);
		if (!ctx) return;
		ctx.metaEl.setText(text);
	}
}

function formatCompact(value: number): string {
	if (!Number.isFinite(value)) return '--';
	const rounded = Math.round(value);
	if (Math.abs(rounded) >= 1000) return `${(rounded / 1000).toFixed(rounded >= 10000 ? 0 : 1)}k`;
	return String(rounded);
}
