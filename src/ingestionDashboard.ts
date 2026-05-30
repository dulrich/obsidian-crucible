import { App, EventRef, Notice, TFile, debounce, setIcon } from 'obsidian';
import type CruciblePlugin from './main';
import { ConfirmModal } from './confirmModal';
import {
	BlogOutcome,
	BlogsIntakeRunStat,
	INTAKE_ROOT_BLOGS,
	listBlogsIntakeRuns,
} from './orchestration/utils/blogsIntake';
import {
	INTAKE_ROOT_YOUTUBE,
	YoutubeChannelOutcome,
	YoutubeIntakeRunStat,
	listYoutubeIntakeRuns,
} from './orchestration/utils/youtubeIntake';
import {
	IGNORED_IDS_NOTE,
	addIgnoredBlogId,
	addIgnoredVideoId,
	loadIgnoredBlogIds,
	loadIgnoredVideoIds,
	removeIgnoredBlogId,
	removeIgnoredVideoId,
} from './orchestration/utils/ignoredIds';
import { RemoteVideo } from './orchestration/utils/youtube';
import { RemotePost } from './orchestration/utils/blogs';
import type { EnrichmentQueueEntry, EnrichmentQueueItem } from './orchestration/EnrichmentQueueService';
import type { JobType, OrchestrationJob } from './orchestration/types';
import { renderSortableTable } from './ingestion/render/sortableTable';
import { renderTableSection } from './ingestion/render/section';
import type {
	ClippingRow,
	OrphanRow,
	SectionContext,
	SectionId,
	TranscriptRow,
	UncapturedPostRow,
	UncapturedVideoRow,
	YoutubeNoMetadataRow,
} from './ingestion/render/types';
import { computeUnprocessedClippingRows } from './ingestion/data/clippings';
import { computeUnrefinedTranscriptRows } from './ingestion/data/transcripts';
import {
	computeUncapturedPostRows,
	computeUncapturedVideoRows,
	computeYoutubeNoMetadataRows,
} from './ingestion/data/uncaptured';
import { computeOrphanedAttachmentRows } from './ingestion/data/orphanedAttachments';
import {
	blogIgnoreUrl,
	displayLabel,
	formatDate,
	formatDateTime,
	formatDuration,
	lastRunLabel,
} from './ingestion/render/format';
import {
	renderAuthorCell,
	renderChannelLink,
	renderExternalLink,
	renderIgnoredIdCell,
} from './ingestion/render/cells';

type IntakeKind = 'blog' | 'youtube';

const INTAKE_JOB_TYPE: Record<IntakeKind, JobType> = {
	blog: 'blogs_tracker',
	youtube: 'youtube_tracker',
};

const DEBOUNCE_MS = 150;

export class IngestionDashboardUI {
	private readonly app: App;
	private readonly disposers: Array<() => void> = [];
	private readonly eventRefs: EventRef[] = [];
	private sections = new Map<SectionId, SectionContext>();
	private uncapturedVideosCache: UncapturedVideoRow[] = [];
	private orphanedAttachmentsCache: OrphanRow[] = [];
	private intakeButtons = new Map<IntakeKind, HTMLButtonElement>();

	constructor(private readonly plugin: CruciblePlugin, private readonly container: HTMLElement) {
		this.app = plugin.app;
	}

	mount(): void {
		this.container.empty();

		const header = this.container.createDiv({ cls: 'crucible-ingestion-header' });
		header.createEl('h2', { text: 'Ingestion dashboard' });
		header.createEl('p', {
			text: 'Live view of capture pipelines. Refreshes automatically as the vault changes.',
			cls: 'crucible-ingestion-subtitle',
		});

		this.buildSection('unprocessedClippings', 'Unprocessed clippings', 'Markdown files directly under the configured clipper inbox folder.');
		this.buildSection('unrefinedTranscripts', 'Unrefined transcripts', 'Notes tagged #transcript that are not yet tagged #refined.');
		this.buildSection('blogIntake', 'Blog intake', 'Blog tracker runs (most recent first).', (heading) => this.renderEnqueueIntakeButton(heading, 'blog'), true);
		this.buildSection('youtubeIntake', 'YouTube intake', 'YouTube tracker runs (most recent first).', (heading) => this.renderEnqueueIntakeButton(heading, 'youtube'), true);
		this.buildOrchestrationQueueSection();
		this.buildSection('uncapturedPosts', 'Uncaptured posts', 'Blog posts seen in tracker runs but not yet captured as a vault note.');
		this.buildSection('ignoredPosts', 'Ignored blogs', 'Blog post IDs you chose to ignore. They are skipped by the tracker and the uncaptured list.', undefined, true);
		this.buildEnrichmentQueueSection();
		this.buildSection('uncapturedVideos', 'Uncaptured videos', 'YouTube videos seen in tracker runs but not yet captured as a vault note.');
		this.buildSection('ignoredVideos', 'Ignored videos', 'YouTube video IDs you chose to ignore. They are skipped by the tracker, the uncaptured list, and auto-enrich.', undefined, true);
		this.buildSection(
			'youtubeWithoutMetadata',
			'YouTube captures without metadata',
			'Vault notes with a yt-video-id in frontmatter but no yt-metadata link yet.',
			(heading) => this.renderEnqueueAllMetadataButton(heading),
		);
		this.buildSection(
			'orphanedAttachments',
			'Orphaned attachments',
			'Localized attachments (…_MD5.ext) with no back-reference from any note.',
			(heading) => this.renderCleanupAllButton(heading),
		);

		this.registerListeners();
		void this.refreshAll();
		void this.refreshIntakeButton('blog');
		void this.refreshIntakeButton('youtube');
	}

	unmount(): void {
		for (const off of this.disposers) {
			try { off(); } catch { /* swallow */ }
		}
		this.disposers.length = 0;
		for (const ref of this.eventRefs) {
			this.app.vault.offref(ref);
			this.app.metadataCache.offref(ref);
		}
		this.eventRefs.length = 0;
		this.plugin.enrichmentQueue?.setAutoSource(null);
		this.intakeButtons.clear();
		this.sections.clear();
		this.container.empty();
	}

	private registerListeners(): void {
		const debouncedClippings = debounce(() => void this.refresh('unprocessedClippings'), DEBOUNCE_MS, true);
		const debouncedTranscripts = debounce(() => void this.refresh('unrefinedTranscripts'), DEBOUNCE_MS, true);
		const debouncedBlogIntake = debounce(() => void this.refresh('blogIntake'), DEBOUNCE_MS, true);
		const debouncedYoutubeIntake = debounce(() => void this.refresh('youtubeIntake'), DEBOUNCE_MS, true);
		const debouncedUncapturedPosts = debounce(() => void this.refresh('uncapturedPosts'), DEBOUNCE_MS, true);
		const debouncedUncapturedVideos = debounce(() => void this.refresh('uncapturedVideos'), DEBOUNCE_MS, true);
		const debouncedIgnoredPosts = debounce(() => void this.refresh('ignoredPosts'), DEBOUNCE_MS, true);
		const debouncedIgnoredVideos = debounce(() => void this.refresh('ignoredVideos'), DEBOUNCE_MS, true);
		const debouncedYoutubeNoMetadata = debounce(() => void this.refresh('youtubeWithoutMetadata'), DEBOUNCE_MS, true);
		const debouncedQueue = debounce(() => void this.refresh('enrichmentQueue'), DEBOUNCE_MS, true);
		const debouncedOrphans = debounce(() => void this.refresh('orphanedAttachments'), DEBOUNCE_MS, true);
		const debouncedOrchestrationQueue = debounce(() => {
			void this.refresh('orchestrationQueue');
			void this.refreshIntakeButton('blog');
			void this.refreshIntakeButton('youtube');
		}, DEBOUNCE_MS, true);

		const route = (path: string) => {
			if (path === IGNORED_IDS_NOTE) {
				debouncedIgnoredPosts();
				debouncedIgnoredVideos();
				debouncedUncapturedPosts();
				debouncedUncapturedVideos();
			}
			const clipperRoot = this.plugin.settings.ingestionClipperInboxFolder;
			const dailyRoot = this.plugin.settings.dailyFolder;
			if (clipperRoot && path.startsWith(`${clipperRoot}/`)) debouncedClippings();
			if (dailyRoot && path.startsWith(`${dailyRoot}/`)) debouncedTranscripts();
			if (path.startsWith(`${INTAKE_ROOT_BLOGS}/`)) {
				debouncedBlogIntake();
				debouncedUncapturedPosts();
			}
			if (path.startsWith(`${INTAKE_ROOT_YOUTUBE}/`)) {
				debouncedYoutubeIntake();
				debouncedUncapturedVideos();
			}
			const ytRoot = this.plugin.settings.orchestrationYoutubeMetadataRoot;
			if (ytRoot && path.startsWith(`${ytRoot}/`)) debouncedUncapturedVideos();
			// Source/post-id/yt-video-id frontmatter on arbitrary notes affects uncaptured lists.
			debouncedUncapturedPosts();
			debouncedUncapturedVideos();
			// yt-video-id added or yt-metadata linked changes the "without metadata" list.
			debouncedYoutubeNoMetadata();
			// Any note edit, or any attachment created/deleted/renamed, can change orphan status.
			debouncedOrphans();
		};

		this.eventRefs.push(this.app.metadataCache.on('changed', file => route(file.path)));
		this.eventRefs.push(this.app.vault.on('create', file => route(file.path)));
		this.eventRefs.push(this.app.vault.on('delete', file => route(file.path)));
		this.eventRefs.push(this.app.vault.on('rename', (file, oldPath) => { route(file.path); route(oldPath); }));

		const bus = this.plugin.ingestionEvents;
		if (bus) {
			this.disposers.push(bus.on('tracker-run', e => {
				if (e.kind === 'blog') { debouncedBlogIntake(); debouncedUncapturedPosts(); }
				else { debouncedYoutubeIntake(); debouncedUncapturedVideos(); }
			}));
			this.disposers.push(bus.on('metadata-enriched', () => debouncedUncapturedVideos()));
			this.disposers.push(bus.on('enrichment-queue-updated', () => debouncedQueue()));
			this.disposers.push(bus.on('orchestration-queue-updated', () => {
				debouncedOrchestrationQueue();
				debouncedYoutubeNoMetadata();
			}));
			this.disposers.push(bus.on('clipping-captured', () => debouncedClippings()));
			this.disposers.push(bus.on('transcript-refined', () => debouncedTranscripts()));
		}
	}

	// Builds the callout-style collapsible header shared by every section: a
	// chevron toggle on the left, the title with a (count) suffix, a meta slot
	// (e.g. "last run X ago"), and the description. Clicking the header collapses
	// the card (CSS hides the body + any queue controls) unless the click landed
	// on an interactive control.
	private createSectionHeader(
		card: HTMLElement,
		title: string,
		description: string,
		defaultCollapsed: boolean,
	): { heading: HTMLElement; countEl: HTMLElement; metaEl: HTMLElement } {
		if (defaultCollapsed) card.addClass('is-collapsed');
		const heading = card.createDiv({ cls: 'crucible-ingestion-section-header' });
		const toggle = heading.createDiv({ cls: 'crucible-ingestion-section-toggle' });
		setIcon(toggle, defaultCollapsed ? 'chevron-right' : 'chevron-down');
		const h3 = heading.createEl('h3', { text: title });
		const countEl = h3.createSpan({ cls: 'crucible-ingestion-section-count' });
		const metaEl = heading.createSpan({ cls: 'crucible-ingestion-section-meta' });
		const sub = heading.createDiv({ cls: 'crucible-ingestion-section-desc' });
		sub.setText(description);

		heading.addEventListener('click', evt => {
			if ((evt.target as HTMLElement).closest('button, input, a, label')) return;
			const collapsed = card.classList.toggle('is-collapsed');
			setIcon(toggle, collapsed ? 'chevron-right' : 'chevron-down');
		});

		return { heading, countEl, metaEl };
	}

	private buildSection(
		id: SectionId,
		title: string,
		description: string,
		decorateHeader?: (heading: HTMLElement) => void,
		defaultCollapsed = false,
	): void {
		const card = this.container.createDiv({ cls: 'crucible-settings-group crucible-ingestion-section' });
		const { heading, countEl, metaEl } = this.createSectionHeader(card, title, description, defaultCollapsed);
		const refreshBtn = heading.createEl('button', { text: 'Refresh', cls: 'crucible-ingestion-refresh' });
		decorateHeader?.(heading);
		const body = card.createDiv({ cls: 'crucible-ingestion-section-body' });
		body.createDiv({ cls: 'crucible-empty-state', text: 'Loading…' });

		const ctx: SectionContext = {
			id,
			title,
			description,
			body,
			countEl,
			metaEl,
			sort: null,
			refresh: async () => {
				await this.renderSection(id, body, ctx);
			},
		};
		this.sections.set(id, ctx);
		refreshBtn.addEventListener('click', () => void ctx.refresh());
	}

	private setSectionCount(id: SectionId, n: number): void {
		const ctx = this.sections.get(id);
		if (!ctx) return;
		ctx.countEl.setText(n > 0 ? ` (${n})` : '');
	}

	private setSectionMeta(id: SectionId, text: string): void {
		const ctx = this.sections.get(id);
		if (!ctx) return;
		ctx.metaEl.setText(text);
	}

	private buildEnrichmentQueueSection(): void {
		const card = this.container.createDiv({ cls: 'crucible-settings-group crucible-ingestion-section' });
		const { countEl, metaEl } = this.createSectionHeader(
			card,
			'Video enrichment queue',
			'Drains pending videos through the YouTube data API at the configured rate.',
			false,
		);

		const controls = card.createDiv({ cls: 'crucible-ingestion-queue-controls' });

		const toggleLabel = controls.createEl('label', { cls: 'crucible-ingestion-queue-toggle' });
		const toggle = toggleLabel.createEl('input', { type: 'checkbox' });
		toggle.checked = this.plugin.settings.ingestionYoutubeAutoEnrichEnabled === true;
		toggleLabel.appendText(' Auto enrich from Uncaptured Videos');
		toggle.addEventListener('change', () => {
			void (async () => {
				this.plugin.settings.ingestionYoutubeAutoEnrichEnabled = toggle.checked;
				await this.plugin.saveSettings();
				this.plugin.enrichmentQueue?.setAutoEnabled(toggle.checked);
				if (toggle.checked) {
					this.plugin.enrichmentQueue?.setAutoSource(() => this.uncapturedQueueItems());
				}
			})();
		});

		const rateLabel = controls.createEl('label', { cls: 'crucible-ingestion-queue-rate' });
		rateLabel.appendText('Rate limit (seconds): ');
		const rateInput = rateLabel.createEl('input', { type: 'number' });
		rateInput.value = String(this.plugin.settings.ingestionYoutubeEnrichRateLimitSeconds);
		rateInput.min = '0';
		rateInput.addClass('pi-width-small');
		rateInput.addEventListener('change', () => {
			void (async () => {
				const n = Number(rateInput.value);
				const next = Number.isFinite(n) && n >= 0 ? n : 2;
				this.plugin.settings.ingestionYoutubeEnrichRateLimitSeconds = next;
				await this.plugin.saveSettings();
				this.plugin.enrichmentQueue?.setRateLimitSeconds(next);
			})();
		});

		const body = card.createDiv({ cls: 'crucible-ingestion-section-body' });
		body.createDiv({ cls: 'crucible-empty-state', text: 'Queue is empty.' });

		const ctx: SectionContext = {
			id: 'enrichmentQueue',
			title: 'Video Enrichment Queue',
			description: '',
			body,
			countEl,
			metaEl,
			sort: null,
			refresh: () => this.renderEnrichmentQueue(body),
		};
		this.sections.set('enrichmentQueue', ctx);

		// Push the initial auto-source if toggle is on.
		if (toggle.checked) {
			this.plugin.enrichmentQueue?.setAutoSource(() => this.uncapturedQueueItems());
		}
	}

	private buildOrchestrationQueueSection(): void {
		const card = this.container.createDiv({ cls: 'crucible-settings-group crucible-ingestion-section' });
		const { countEl, metaEl } = this.createSectionHeader(
			card,
			'Orchestration queue',
			'Jobs queued for the orchestrator. Run next executes one job; autorun drains as they arrive.',
			false,
		);

		const controls = card.createDiv({ cls: 'crucible-ingestion-queue-controls' });

		const toggleLabel = controls.createEl('label', { cls: 'crucible-ingestion-queue-toggle' });
		const toggle = toggleLabel.createEl('input', { type: 'checkbox' });
		toggle.checked = this.plugin.settings.orchestrationQueueAutorunEnabled === true;
		toggleLabel.appendText(' Autorun');
		toggle.addEventListener('change', () => {
			void (async () => {
				this.plugin.settings.orchestrationQueueAutorunEnabled = toggle.checked;
				await this.plugin.saveSettings();
				this.plugin.orchestrationAutoRunner?.setEnabled(toggle.checked);
			})();
		});

		const runNextBtn = controls.createEl('button', { text: 'Run next', cls: 'crucible-ingestion-run-next' });
		runNextBtn.addEventListener('click', () => {
			void this.plugin.orchestrationAutoRunner?.runOnce();
		});

		const body = card.createDiv({ cls: 'crucible-ingestion-section-body' });
		body.createDiv({ cls: 'crucible-empty-state', text: 'Queue is empty.' });

		const ctx: SectionContext = {
			id: 'orchestrationQueue',
			title: 'Orchestration queue',
			description: '',
			body,
			countEl,
			metaEl,
			sort: null,
			refresh: () => this.renderOrchestrationQueue(body, ctx),
		};
		this.sections.set('orchestrationQueue', ctx);
	}

	private renderEnqueueIntakeButton(heading: HTMLElement, kind: IntakeKind): void {
		const btn = heading.createEl('button', { cls: 'crucible-ingestion-enqueue-intake' });
		btn.setText('Enqueue intake');
		btn.addEventListener('click', () => {
			if (btn.disabled) return;
			void this.plugin.orchestrator.enqueue(INTAKE_JOB_TYPE[kind]);
		});
		this.intakeButtons.set(kind, btn);
	}

	private async refreshIntakeButton(kind: IntakeKind): Promise<void> {
		const btn = this.intakeButtons.get(kind);
		if (!btn) return;
		const jobType = INTAKE_JOB_TYPE[kind];
		const store = this.plugin.jobStore;
		if (!store) return;
		let state: 'idle' | 'queued' | 'running' = 'idle';
		try {
			const running = await store.listFolder('running');
			if (running.some(e => e.job.type === jobType)) {
				state = 'running';
			} else {
				const queued = await store.listFolder('queued');
				if (queued.some(e => e.job.type === jobType)) state = 'queued';
			}
		} catch {
			state = 'idle';
		}
		this.setIntakeButtonState(btn, state);
	}

	private setIntakeButtonState(btn: HTMLButtonElement, state: 'idle' | 'queued' | 'running'): void {
		btn.empty();
		switch (state) {
			case 'idle':
				btn.setText('Enqueue intake');
				btn.disabled = false;
				btn.removeAttribute('aria-busy');
				break;
			case 'queued':
				btn.setText('Queued');
				btn.disabled = true;
				btn.removeAttribute('aria-busy');
				break;
			case 'running':
				btn.createSpan({ cls: 'crucible-spinner' });
				btn.appendText(' Running…');
				btn.disabled = true;
				btn.setAttribute('aria-busy', 'true');
				break;
		}
	}

	private async renderOrchestrationQueue(body: HTMLElement, ctx: SectionContext): Promise<void> {
		body.empty();
		const store = this.plugin.jobStore;
		if (!store) {
			this.setSectionCount('orchestrationQueue', 0);
			body.createDiv({ cls: 'crucible-empty-state', text: 'Orchestrator not available.' });
			return;
		}
		let queued: Array<{ job: OrchestrationJob }> = [];
		let running: Array<{ job: OrchestrationJob }> = [];
		try {
			[running, queued] = await Promise.all([store.listFolder('running'), store.listFolder('queued')]);
		} catch (e) {
			this.setSectionCount('orchestrationQueue', 0);
			body.createDiv({ cls: 'crucible-empty-state', text: `Failed to read queue: ${e instanceof Error ? e.message : String(e)}` });
			return;
		}
		type Row = { id: string; type: string; status: 'queued' | 'running'; created: string };
		const rows: Row[] = [
			...running.map(e => ({ id: e.job.id, type: e.job.type, status: 'running' as const, created: e.job.created ?? '' })),
			...queued.map(e => ({ id: e.job.id, type: e.job.type, status: 'queued' as const, created: e.job.created ?? '' })),
		];
		this.setSectionCount('orchestrationQueue', rows.length);
		if (rows.length === 0) {
			body.createDiv({ cls: 'crucible-empty-state', text: 'Queue is empty.' });
			return;
		}
		if (!ctx.sort) ctx.sort = { column: 'status', direction: 'asc' };
		renderSortableTable<Row>(body, [
			{ key: 'status', label: 'Status', sortable: true, sortKey: r => (r.status === 'running' ? 0 : 1), render: (r, td) => td.setText(r.status) },
			{ key: 'type', label: 'Type', sortable: true, sortKey: r => r.type, render: (r, td) => td.setText(r.type) },
			{ key: 'id', label: 'ID', sortable: true, sortKey: r => r.id, render: (r, td) => td.setText(r.id) },
			{ key: 'created', label: 'Created', sortable: true, sortKey: r => r.created, render: (r, td) => td.setText(r.created) },
		], rows, ctx);
	}

	private async refreshAll(): Promise<void> {
		const ids: SectionId[] = [
			'unprocessedClippings',
			'unrefinedTranscripts',
			'blogIntake',
			'youtubeIntake',
			'orchestrationQueue',
			'uncapturedPosts',
			'ignoredPosts',
			'enrichmentQueue',
			'uncapturedVideos',
			'ignoredVideos',
			'youtubeWithoutMetadata',
			'orphanedAttachments',
		];
		for (const id of ids) await this.refresh(id);
	}

	private async refresh(id: SectionId): Promise<void> {
		const ctx = this.sections.get(id);
		if (!ctx) return;
		await ctx.refresh();
	}

	private async renderSection(id: SectionId, body: HTMLElement, ctx: SectionContext): Promise<void> {
		switch (id) {
			case 'unprocessedClippings': return this.renderUnprocessedClippings(body, ctx);
			case 'unrefinedTranscripts': return this.renderUnrefinedTranscripts(body, ctx);
			case 'blogIntake': return this.renderBlogIntake(body, ctx);
			case 'youtubeIntake': return this.renderYoutubeIntake(body, ctx);
			case 'orchestrationQueue': return this.renderOrchestrationQueue(body, ctx);
			case 'uncapturedPosts': return this.renderUncapturedPosts(body, ctx);
			case 'ignoredPosts': return this.renderIgnoredPosts(body, ctx);
			case 'uncapturedVideos': return this.renderUncapturedVideos(body, ctx);
			case 'ignoredVideos': return this.renderIgnoredVideos(body, ctx);
			case 'youtubeWithoutMetadata': return this.renderYoutubeNoMetadata(body, ctx);
			case 'orphanedAttachments': return this.renderOrphanedAttachments(body, ctx);
			case 'enrichmentQueue': this.renderEnrichmentQueue(body); return;
		}
	}

	// --- Section: Unprocessed Clippings ---
	private renderUnprocessedClippings(body: HTMLElement, ctx: SectionContext): void {
		const folder = this.plugin.settings.ingestionClipperInboxFolder;
		const rows = computeUnprocessedClippingRows(this.app, folder);
		if (rows === null) {
			body.empty();
			this.setSectionCount('unprocessedClippings', 0);
			body.createDiv({ cls: 'crucible-empty-state', text: `Inbox folder "${folder}" not found.` });
			return;
		}

		renderTableSection<ClippingRow>({
			body, ctx, rows,
			emptyText: 'No unprocessed clippings.',
			setCount: n => this.setSectionCount('unprocessedClippings', n),
			columns: [
				{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => this.renderFileLink(td, r.file) },
				{ key: 'captured', label: 'Captured', sortable: true, sortKey: r => r.captured, render: (r, td) => td.setText(formatDateTime(r.captured)) },
				{ key: 'size', label: 'Size (KB)', sortable: true, sortKey: r => r.size, render: (r, td) => td.setText((r.size / 1024).toFixed(1)) },
				{ key: 'open', label: '', render: (r, td) => this.renderOpenButton(td, r.file) },
			],
		});
	}

	// --- Section: Unrefined Transcripts ---
	private renderUnrefinedTranscripts(body: HTMLElement, ctx: SectionContext): void {
		const dailyFolder = this.plugin.settings.dailyFolder;
		const wpm = this.plugin.settings.ingestionReadingWpm || 250;
		const rows = computeUnrefinedTranscriptRows(this.app, dailyFolder, wpm);
		if (rows === null) {
			body.empty();
			this.setSectionCount('unrefinedTranscripts', 0);
			body.createDiv({ cls: 'crucible-empty-state', text: `Daily folder "${dailyFolder}" not found.` });
			return;
		}

		renderTableSection<TranscriptRow>({
			body, ctx, rows,
			emptyText: 'No unrefined transcripts.',
			// Default sort: created ascending (matches user's DataviewJS).
			defaultSort: { column: 'created', direction: 'asc' },
			setCount: n => this.setSectionCount('unrefinedTranscripts', n),
			columns: [
				{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => this.renderFileLink(td, r.file) },
				{ key: 'tags', label: 'Tags', render: (r, td) => td.setText(r.tags.join(', ')) },
				{ key: 'words', label: 'Words', sortable: true, sortKey: r => r.words, render: (r, td) => td.setText(String(r.words)) },
				{ key: 'estRead', label: 'Est. Read', sortable: true, sortKey: r => r.estReadMin ?? 0, render: (r, td) => td.setText(r.estReadMin != null ? `${r.estReadMin.toFixed(1)} min` : '') },
				{ key: 'created', label: 'Created', sortable: true, sortKey: r => r.created, render: (r, td) => td.setText(formatDate(r.created)) },
				{ key: 'read', label: 'Read?', sortable: true, sortKey: r => (r.read ? 1 : 0), render: (r, td) => td.setText(r.read ? '✅' : '❌') },
			],
		});
	}

	// --- Section: Blog Intake ---
	private renderBlogIntake(body: HTMLElement, ctx: SectionContext): void {
		const rows = listBlogsIntakeRuns(this.app);
		this.setSectionMeta('blogIntake', lastRunLabel(rows.map(r => r.runAt)));
		renderTableSection<BlogsIntakeRunStat>({
			body, ctx, rows,
			emptyText: 'No blog tracker runs yet.',
			defaultSort: { column: 'runAt', direction: 'desc' },
			setCount: n => this.setSectionCount('blogIntake', n),
			columns: [
				{ key: 'runAt', label: 'Run At', sortable: true, sortKey: r => r.runAt, render: (r, td) => this.renderFileLink(td, r.file, r.runAt || r.file.basename) },
				{ key: 'blogsTotal', label: 'Blogs', sortable: true, sortKey: r => r.blogsTotal, render: (r, td) => td.setText(String(r.blogsTotal)) },
				{ key: 'blogsWithNew', label: 'With New', sortable: true, sortKey: r => r.blogsWithNew, render: (r, td) => td.setText(String(r.blogsWithNew)) },
				{ key: 'postsTotal', label: 'Posts', sortable: true, sortKey: r => r.postsTotal, render: (r, td) => td.setText(String(r.postsTotal)) },
				{ key: 'blogsFailed', label: 'Failed', sortable: true, sortKey: r => r.blogsFailed, render: (r, td) => td.setText(String(r.blogsFailed)) },
				{ key: 'rowsSkipped', label: 'Skipped', sortable: true, sortKey: r => r.rowsSkipped, render: (r, td) => td.setText(String(r.rowsSkipped)) },
				{ key: 'generatedBy', label: 'Source', render: (r, td) => td.setText(r.generatedBy.replace('orchestrator/', '')) },
			],
		});
	}

	// --- Section: YouTube Intake ---
	private renderYoutubeIntake(body: HTMLElement, ctx: SectionContext): void {
		const rows = listYoutubeIntakeRuns(this.app);
		this.setSectionMeta('youtubeIntake', lastRunLabel(rows.map(r => r.runAt)));
		renderTableSection<YoutubeIntakeRunStat>({
			body, ctx, rows,
			emptyText: 'No YouTube tracker runs yet.',
			defaultSort: { column: 'runAt', direction: 'desc' },
			setCount: n => this.setSectionCount('youtubeIntake', n),
			columns: [
				{ key: 'runAt', label: 'Run At', sortable: true, sortKey: r => r.runAt, render: (r, td) => this.renderFileLink(td, r.file, r.runAt || r.file.basename) },
				{ key: 'channelsTotal', label: 'Channels', sortable: true, sortKey: r => r.channelsTotal, render: (r, td) => td.setText(String(r.channelsTotal)) },
				{ key: 'channelsWithNew', label: 'With New', sortable: true, sortKey: r => r.channelsWithNew, render: (r, td) => td.setText(String(r.channelsWithNew)) },
				{ key: 'videosTotal', label: 'Videos', sortable: true, sortKey: r => r.videosTotal, render: (r, td) => td.setText(String(r.videosTotal)) },
				{ key: 'channelsFailed', label: 'Failed', sortable: true, sortKey: r => r.channelsFailed, render: (r, td) => td.setText(String(r.channelsFailed)) },
				{ key: 'generatedBy', label: 'Source', render: (r, td) => td.setText(r.generatedBy.replace('orchestrator/', '')) },
			],
		});
	}

	// --- Section: Uncaptured Posts ---
	private async renderUncapturedPosts(body: HTMLElement, ctx: SectionContext): Promise<void> {
		body.empty();
		body.createDiv({ cls: 'crucible-empty-state', text: 'Scanning…' });
		const rows = await computeUncapturedPostRows(this.app, this.plugin);

		renderTableSection<UncapturedPostRow>({
			body, ctx, rows,
			emptyText: 'No uncaptured posts.',
			defaultSort: { column: 'publishedAt', direction: 'desc' },
			setCount: n => this.setSectionCount('uncapturedPosts', n),
			columns: [
				{ key: 'blogName', label: 'Author', sortable: true, sortKey: r => displayLabel(r.blogName).toLowerCase(), render: (r, td) => renderAuthorCell(td, r.blogName) },
				{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => td.setText(r.title) },
				{ key: 'publishedAt', label: 'Publish Date', sortable: true, sortKey: r => r.publishedAt, render: (r, td) => td.setText((r.publishedAt || '').slice(0, 10)) },
				{ key: 'read', label: '', render: (r, td) => renderExternalLink(td, r.url, 'read') },
				{ key: 'ignore', label: '', render: (r, td) => this.renderIgnoreButton(td, 'blog', r.postId, ctx, 'ignoredPosts') },
			],
		});
	}

	// --- Section: Uncaptured Videos ---
	private async renderUncapturedVideos(body: HTMLElement, ctx: SectionContext): Promise<void> {
		body.empty();
		body.createDiv({ cls: 'crucible-empty-state', text: 'Scanning…' });
		const rows = await computeUncapturedVideoRows(this.app, this.plugin);
		this.uncapturedVideosCache = rows;

		renderTableSection<UncapturedVideoRow>({
			body, ctx, rows,
			emptyText: 'No uncaptured videos.',
			defaultSort: { column: 'publishedAt', direction: 'desc' },
			setCount: n => this.setSectionCount('uncapturedVideos', n),
			columns: [
				{ key: 'channelName', label: 'Creator', sortable: true, sortKey: r => displayLabel(r.channelName).toLowerCase(), render: (r, td) => renderChannelLink(td, r.channelId, r.channelName) },
				{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => td.setText(r.title) },
				{ key: 'publishedAt', label: 'Publish Date', sortable: true, sortKey: r => r.publishedAt, render: (r, td) => td.setText((r.publishedAt || '').slice(0, 10)) },
				{ key: 'duration', label: 'Duration', sortable: true, sortKey: r => r.durationSeconds ?? -1, render: (r, td) => td.setText(formatDuration(r.durationSeconds)) },
				{ key: 'watch', label: '', render: (r, td) => renderExternalLink(td, r.url, 'watch') },
				{ key: 'ignore', label: '', render: (r, td) => this.renderIgnoreButton(td, 'youtube', r.videoId, ctx, 'ignoredVideos') },
				{ key: 'enriched', label: 'Enriched?', render: (r, td) => this.renderEnrichedCell(td, r) },
			],
		});

		// Refresh the queue's auto-source so it stays aligned with current sort.
		if (this.plugin.enrichmentQueue?.isAutoEnabled()) {
			this.plugin.enrichmentQueue.setAutoSource(() => this.uncapturedQueueItems());
		}
	}

	private uncapturedQueueItems(): EnrichmentQueueItem[] {
		return this.uncapturedVideosCache
			.filter(r => !r.enrichmentFile)
			.map(r => ({
				videoId: r.videoId,
				title: r.title,
				channelName: r.channelName,
			}));
	}

	// --- Section: YouTube captures without metadata ---
	private async renderYoutubeNoMetadata(body: HTMLElement, ctx: SectionContext): Promise<void> {
		const rows = computeYoutubeNoMetadataRows(this.app);
		const inFlight = await this.youtubeMetadataInFlight();

		renderTableSection<YoutubeNoMetadataRow>({
			body, ctx, rows,
			emptyText: 'No captures awaiting metadata.',
			defaultSort: { column: 'created', direction: 'desc' },
			setCount: n => this.setSectionCount('youtubeWithoutMetadata', n),
			columns: [
				{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => this.renderFileLink(td, r.file) },
				{ key: 'created', label: 'Create Date', sortable: true, sortKey: r => r.created, render: (r, td) => td.setText(formatDate(r.created)) },
				{ key: 'enqueue', label: '', render: (r, td) => this.renderEnqueueMetadataCell(td, r, inFlight) },
			],
		});
	}

	// Reads queued + running orchestrator jobs once and maps each
	// youtube_metadata_fetch job's target note path to its status, so rows show
	// in-flight state instead of an enqueue button.
	private async youtubeMetadataInFlight(): Promise<Map<string, 'queued' | 'running'>> {
		const map = new Map<string, 'queued' | 'running'>();
		const store = this.plugin.jobStore;
		if (!store) return map;
		try {
			const [running, queued] = await Promise.all([store.listFolder('running'), store.listFolder('queued')]);
			for (const e of running) this.recordMetadataJob(map, e.job, 'running');
			for (const e of queued) this.recordMetadataJob(map, e.job, 'queued');
		} catch {
			/* leave map empty on read failure */
		}
		return map;
	}

	private recordMetadataJob(map: Map<string, 'queued' | 'running'>, job: OrchestrationJob, status: 'queued' | 'running'): void {
		if (job.type !== 'youtube_metadata_fetch') return;
		const path = typeof job.params?.targetPath === 'string' ? job.params.targetPath : '';
		if (path && !map.has(path)) map.set(path, status);
	}

	private renderEnqueueMetadataCell(td: HTMLElement, row: YoutubeNoMetadataRow, inFlight: Map<string, 'queued' | 'running'>): void {
		const state = inFlight.get(row.file.path);
		if (state) {
			td.setText(state === 'running' ? 'running…' : 'queued');
			return;
		}
		const btn = td.createEl('button', { text: 'Enqueue metadata' });
		btn.addEventListener('click', () => {
			void (async () => {
				btn.disabled = true;
				const job = await this.plugin.orchestrator.enqueue('youtube_metadata_fetch', {
					targetPath: row.file.path,
					videoId: row.videoId,
				});
				if (job) btn.setText('Queued');
				else btn.disabled = false;
			})();
		});
	}

	private renderEnqueueAllMetadataButton(heading: HTMLElement): void {
		const btn = heading.createEl('button', { text: 'Enqueue all', cls: 'crucible-ingestion-enqueue-intake' });
		btn.addEventListener('click', () => {
			void (async () => {
				btn.disabled = true;
				try {
					const rows = computeYoutubeNoMetadataRows(this.app);
					if (rows.length === 0) {
						new Notice('No captures awaiting metadata.');
						return;
					}
					const inFlight = await this.youtubeMetadataInFlight();
					let enqueued = 0;
					for (const row of rows) {
						if (inFlight.has(row.file.path)) continue;
						const job = await this.plugin.orchestrator.enqueue('youtube_metadata_fetch', {
							targetPath: row.file.path,
							videoId: row.videoId,
						});
						if (job) enqueued++;
					}
					new Notice(enqueued > 0 ? `Enqueued ${enqueued} metadata fetch${enqueued === 1 ? '' : 'es'}.` : 'Nothing to enqueue.');
				} finally {
					btn.disabled = false;
					void this.refresh('youtubeWithoutMetadata');
				}
			})();
		});
	}

	// --- Section: Orphaned Attachments ---
	private renderOrphanedAttachments(body: HTMLElement, ctx: SectionContext): void {
		const rows = computeOrphanedAttachmentRows(this.app);
		this.orphanedAttachmentsCache = rows;
		renderTableSection<OrphanRow>({
			body, ctx, rows,
			emptyText: 'No orphaned attachments.',
			defaultSort: { column: 'size', direction: 'desc' },
			setCount: n => this.setSectionCount('orphanedAttachments', n),
			columns: [
				{ key: 'name', label: 'Name', sortable: true, sortKey: r => r.file.name.toLowerCase(), render: (r, td) => this.renderFileLink(td, r.file, r.file.name) },
				{ key: 'folder', label: 'Folder', sortable: true, sortKey: r => r.folder.toLowerCase(), render: (r, td) => td.setText(r.folder) },
				{ key: 'type', label: 'Type', sortable: true, sortKey: r => r.type, render: (r, td) => td.setText(r.type) },
				{ key: 'size', label: 'Size (KB)', sortable: true, sortKey: r => r.size, render: (r, td) => td.setText((r.size / 1024).toFixed(1)) },
				{ key: 'mtime', label: 'Modified', sortable: true, sortKey: r => r.mtime, render: (r, td) => td.setText(formatDateTime(r.mtime)) },
				{ key: 'delete', label: '', render: (r, td) => this.renderDeleteButton(td, r, ctx) },
			],
		});
	}

	private renderDeleteButton(td: HTMLElement, row: OrphanRow, ctx: SectionContext): void {
		const btn = td.createEl('button', { text: 'Delete' });
		btn.addClass('mod-warning');
		btn.addEventListener('click', () => {
			void (async () => {
				btn.disabled = true;
				try {
					await this.app.fileManager.trashFile(row.file);
					new Notice(`Trashed ${row.file.name}`);
				} catch (e) {
					new Notice(`Failed to trash ${row.file.name}: ${e instanceof Error ? e.message : String(e)}`);
				}
				void ctx.refresh();
			})();
		});
	}

	private renderCleanupAllButton(heading: HTMLElement): void {
		const btn = heading.createEl('button', { text: 'Cleanup all', cls: 'crucible-ingestion-cleanup-all' });
		btn.addClass('mod-warning');
		btn.addEventListener('click', () => {
			void (async () => {
				const rows = this.orphanedAttachmentsCache;
				if (rows.length === 0) {
					new Notice('No orphaned attachments to clean up.');
					return;
				}
				const totalKb = rows.reduce((sum, r) => sum + r.size, 0) / 1024;
				const confirmed = await new ConfirmModal(this.app, {
					title: 'Cleanup orphaned attachments',
					message: `Trash ${rows.length} orphaned attachment${rows.length === 1 ? '' : 's'} (${totalKb.toFixed(1)} KB)? Files go to the vault's configured trash.`,
					confirmText: 'Trash all',
					destructive: true,
				}).openAndAwait();
				if (!confirmed) return;

				let failed = 0;
				for (const row of rows) {
					try {
						await this.app.fileManager.trashFile(row.file);
					} catch (e) {
						failed++;
						console.warn('Cleanup: could not trash', row.file.path, e);
					}
				}
				const ok = rows.length - failed;
				new Notice(failed === 0 ? `Trashed ${ok} attachment${ok === 1 ? '' : 's'}.` : `Trashed ${ok}, ${failed} failed.`);
				void this.refresh('orphanedAttachments');
			})();
		});
	}

	// --- Section: Enrichment Queue ---
	private renderEnrichmentQueue(body: HTMLElement): void {
		body.empty();
		const queue = this.plugin.enrichmentQueue;
		if (!queue) {
			this.setSectionCount('enrichmentQueue', 0);
			body.createDiv({ cls: 'crucible-empty-state', text: 'Queue service not available.' });
			return;
		}
		const entries = queue.getSnapshot();
		this.setSectionCount('enrichmentQueue', entries.length);
		if (entries.length === 0) {
			body.createDiv({ cls: 'crucible-empty-state', text: 'Queue is empty.' });
			return;
		}

		const table = body.createEl('table', { cls: 'crucible-ingestion-table' });
		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		for (const label of ['Title', 'Channel', 'Status', '']) headerRow.createEl('th', { text: label });
		const tbody = table.createEl('tbody');
		for (const e of entries) {
			const tr = tbody.createEl('tr');
			tr.createEl('td', { text: e.title });
			tr.createEl('td', { text: e.channelName });
			const statusTd = tr.createEl('td');
			statusTd.setText(e.error ? `${e.status} (${e.error})` : e.status);
			statusTd.addClass(`crucible-queue-status-${e.status}`);
			const actionTd = tr.createEl('td');
			if (e.status === 'pending') {
				const cancel = actionTd.createEl('button', { text: 'Cancel' });
				cancel.addEventListener('click', () => {
					queue.dequeueIfPending(e.videoId);
				});
			}
		}
	}

	// --- DOM helpers ---
	private renderFileLink(td: HTMLElement, file: TFile, label?: string): void {
		const a = td.createEl('a', { text: label ?? file.basename, href: '#' });
		a.addEventListener('click', evt => {
			evt.preventDefault();
			void this.app.workspace.openLinkText(file.path, '', false);
		});
	}

	private renderOpenButton(td: HTMLElement, file: TFile): void {
		const btn = td.createEl('button', { text: 'Open' });
		btn.addEventListener('click', () => {
			void this.app.workspace.openLinkText(file.path, '', false);
		});
	}

	private renderEnrichedCell(td: HTMLElement, row: UncapturedVideoRow): void {
		if (row.enrichmentFile) {
			this.renderFileLink(td, row.enrichmentFile, 'metadata');
			return;
		}
		const queue = this.plugin.enrichmentQueue;
		const entry = queue?.getEntry(row.videoId) ?? null;
		if (entry && (entry.status === 'pending' || entry.status === 'running')) {
			td.setText(entry.status === 'running' ? 'enriching…' : 'queued');
			return;
		}
		const btn = td.createEl('button', { text: 'Enrich' });
		btn.addEventListener('click', () => {
			if (!queue) {
				new Notice('Enrichment service not available.');
				return;
			}
			const ok = queue.enqueue({
				videoId: row.videoId,
				title: row.title,
				channelName: row.channelName,
			});
			if (!ok) new Notice('Already queued or in progress.');
		});
	}

	// --- Section: Ignored blogs ---
	private async renderIgnoredPosts(body: HTMLElement, ctx: SectionContext): Promise<void> {
		const rows = Array.from(await loadIgnoredBlogIds(this.app)).map(id => ({ id }));
		renderTableSection<{ id: string }>({
			body, ctx, rows,
			emptyText: 'No ignored blogs.',
			defaultSort: { column: 'id', direction: 'asc' },
			setCount: n => this.setSectionCount('ignoredPosts', n),
			columns: [
				{ key: 'id', label: 'Blog ID', sortable: true, sortKey: r => r.id.toLowerCase(), render: (r, td) => renderIgnoredIdCell(td, r.id, blogIgnoreUrl(r.id)) },
				{ key: 'unignore', label: '', render: (r, td) => this.renderUnignoreButton(td, 'blog', r.id, ctx, 'uncapturedPosts') },
			],
		});
	}

	// --- Section: Ignored videos ---
	private async renderIgnoredVideos(body: HTMLElement, ctx: SectionContext): Promise<void> {
		const rows = Array.from(await loadIgnoredVideoIds(this.app)).map(id => ({ id }));
		renderTableSection<{ id: string }>({
			body, ctx, rows,
			emptyText: 'No ignored videos.',
			defaultSort: { column: 'id', direction: 'asc' },
			setCount: n => this.setSectionCount('ignoredVideos', n),
			columns: [
				{ key: 'id', label: 'Video ID', sortable: true, sortKey: r => r.id.toLowerCase(), render: (r, td) => renderIgnoredIdCell(td, r.id, `https://www.youtube.com/watch?v=${r.id}`) },
				{ key: 'unignore', label: '', render: (r, td) => this.renderUnignoreButton(td, 'youtube', r.id, ctx, 'uncapturedVideos') },
			],
		});
	}

	// Adds the id to the ignored note, then refreshes the source list (the row
	// drops out as it is now "seen") and the matching ignored section.
	private renderIgnoreButton(td: HTMLElement, kind: IntakeKind, id: string, ctx: SectionContext, ignoredSection: SectionId): void {
		const btn = td.createEl('button', { text: 'Ignore' });
		btn.addEventListener('click', () => {
			void (async () => {
				btn.disabled = true;
				try {
					if (kind === 'youtube') await addIgnoredVideoId(this.app, id);
					else await addIgnoredBlogId(this.app, id);
				} catch (e) {
					new Notice(`Failed to ignore: ${e instanceof Error ? e.message : String(e)}`);
					btn.disabled = false;
					return;
				}
				void ctx.refresh();
				void this.refresh(ignoredSection);
			})();
		});
	}

	// Removes the id from the ignored note, then refreshes this section and the
	// matching uncaptured section (where the item may reappear).
	private renderUnignoreButton(td: HTMLElement, kind: IntakeKind, id: string, ctx: SectionContext, uncapturedSection: SectionId): void {
		const btn = td.createEl('button', { text: 'Un-ignore' });
		btn.addEventListener('click', () => {
			void (async () => {
				btn.disabled = true;
				try {
					if (kind === 'youtube') await removeIgnoredVideoId(this.app, id);
					else await removeIgnoredBlogId(this.app, id);
				} catch (e) {
					new Notice(`Failed to un-ignore: ${e instanceof Error ? e.message : String(e)}`);
					btn.disabled = false;
					return;
				}
				void ctx.refresh();
				void this.refresh(uncapturedSection);
			})();
		});
	}
}

// Re-export for re-use elsewhere if needed.
export type { EnrichmentQueueEntry };
export type { BlogOutcome, YoutubeChannelOutcome, RemoteVideo, RemotePost };
