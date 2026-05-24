import { App, EventRef, Notice, TFile, TFolder, debounce, getAllTags } from 'obsidian';
import type CruciblePlugin from './main';
import {
	BlogOutcome,
	BlogsIntakeRunStat,
	INTAKE_ROOT_BLOGS,
	buildBlogsSeenIdSet,
	listBlogsIntakeRuns,
	loadConfiguredBlogs,
	scanBlogsTrackerRuns,
} from './orchestration/utils/blogsIntake';
import {
	INTAKE_ROOT_YOUTUBE,
	YoutubeChannelOutcome,
	YoutubeIntakeRunStat,
	buildYoutubeSeenIdSet,
	listYoutubeIntakeRuns,
	loadConfiguredChannels,
	scanYoutubeTrackerRuns,
} from './orchestration/utils/youtubeIntake';
import { findExistingMetadataNote } from './orchestration/utils/youtubeApi';
import { RemoteVideo } from './orchestration/utils/youtube';
import { RemotePost } from './orchestration/utils/blogs';
import type { EnrichmentQueueEntry, EnrichmentQueueItem } from './orchestration/EnrichmentQueueService';
import type { JobType, OrchestrationJob } from './orchestration/types';

type SectionId =
	| 'unprocessedClippings'
	| 'unrefinedTranscripts'
	| 'blogIntake'
	| 'youtubeIntake'
	| 'orchestrationQueue'
	| 'uncapturedPosts'
	| 'enrichmentQueue'
	| 'uncapturedVideos';

type IntakeKind = 'blog' | 'youtube';

const INTAKE_JOB_TYPE: Record<IntakeKind, JobType> = {
	blog: 'blogs_tracker',
	youtube: 'youtube_tracker',
};

interface SortState {
	column: string;
	direction: 'asc' | 'desc';
}

interface UncapturedVideoRow {
	videoId: string;
	channelName: string;
	channelId: string;
	title: string;
	publishedAt: string;
	url: string;
	enrichmentFile: TFile | null;
}

interface UncapturedPostRow {
	postId: string;
	blogName: string;
	blogLink: string;
	title: string;
	publishedAt: string;
	url: string;
}

interface SectionContext {
	id: SectionId;
	title: string;
	description: string;
	body: HTMLElement;
	refresh: () => Promise<void> | void;
	sort: SortState | null;
}

interface Column<T> {
	key: string;
	label: string;
	sortable?: boolean;
	sortKey?: (row: T) => string | number;
	render: (row: T, td: HTMLElement) => void;
}

const DEBOUNCE_MS = 150;

export class IngestionDashboardUI {
	private readonly app: App;
	private readonly disposers: Array<() => void> = [];
	private readonly eventRefs: EventRef[] = [];
	private sections = new Map<SectionId, SectionContext>();
	private uncapturedVideosCache: UncapturedVideoRow[] = [];
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
		this.buildSection('blogIntake', 'Blog intake', 'Blog tracker runs (most recent first).', (heading) => this.renderEnqueueIntakeButton(heading, 'blog'));
		this.buildSection('youtubeIntake', 'YouTube intake', 'YouTube tracker runs (most recent first).', (heading) => this.renderEnqueueIntakeButton(heading, 'youtube'));
		this.buildOrchestrationQueueSection();
		this.buildSection('uncapturedPosts', 'Uncaptured posts', 'Blog posts seen in tracker runs but not yet captured as a vault note.');
		this.buildEnrichmentQueueSection();
		this.buildSection('uncapturedVideos', 'Uncaptured videos', 'YouTube videos seen in tracker runs but not yet captured as a vault note.');

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
		const debouncedQueue = debounce(() => void this.refresh('enrichmentQueue'), DEBOUNCE_MS, true);
		const debouncedOrchestrationQueue = debounce(() => {
			void this.refresh('orchestrationQueue');
			void this.refreshIntakeButton('blog');
			void this.refreshIntakeButton('youtube');
		}, DEBOUNCE_MS, true);

		const route = (path: string) => {
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
			this.disposers.push(bus.on('orchestration-queue-updated', () => debouncedOrchestrationQueue()));
			this.disposers.push(bus.on('clipping-captured', () => debouncedClippings()));
			this.disposers.push(bus.on('transcript-refined', () => debouncedTranscripts()));
		}
	}

	private buildSection(
		id: SectionId,
		title: string,
		description: string,
		decorateHeader?: (heading: HTMLElement) => void,
	): void {
		const card = this.container.createDiv({ cls: 'crucible-settings-group crucible-ingestion-section' });
		const heading = card.createDiv({ cls: 'crucible-ingestion-section-header' });
		heading.createEl('h3', { text: title });
		const sub = heading.createDiv({ cls: 'crucible-ingestion-section-desc' });
		sub.setText(description);
		const refreshBtn = heading.createEl('button', { text: 'Refresh', cls: 'crucible-ingestion-refresh' });
		decorateHeader?.(heading);
		const body = card.createDiv({ cls: 'crucible-ingestion-section-body' });
		body.createDiv({ cls: 'crucible-empty-state', text: 'Loading…' });

		const ctx: SectionContext = {
			id,
			title,
			description,
			body,
			sort: null,
			refresh: async () => {
				await this.renderSection(id, body, ctx);
			},
		};
		this.sections.set(id, ctx);
		refreshBtn.addEventListener('click', () => void ctx.refresh());
	}

	private buildEnrichmentQueueSection(): void {
		const card = this.container.createDiv({ cls: 'crucible-settings-group crucible-ingestion-section' });
		const heading = card.createDiv({ cls: 'crucible-ingestion-section-header' });
		heading.createEl('h3', { text: 'Video enrichment queue' });
		const desc = heading.createDiv({ cls: 'crucible-ingestion-section-desc' });
		desc.setText('Drains pending videos through the YouTube data API at the configured rate.');

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
		const heading = card.createDiv({ cls: 'crucible-ingestion-section-header' });
		heading.createEl('h3', { text: 'Orchestration queue' });
		const desc = heading.createDiv({ cls: 'crucible-ingestion-section-desc' });
		desc.setText('Jobs queued for the orchestrator. Run next executes one job; autorun drains as they arrive.');

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
			body.createDiv({ cls: 'crucible-empty-state', text: 'Orchestrator not available.' });
			return;
		}
		let queued: Array<{ job: OrchestrationJob }> = [];
		let running: Array<{ job: OrchestrationJob }> = [];
		try {
			[running, queued] = await Promise.all([store.listFolder('running'), store.listFolder('queued')]);
		} catch (e) {
			body.createDiv({ cls: 'crucible-empty-state', text: `Failed to read queue: ${e instanceof Error ? e.message : String(e)}` });
			return;
		}
		type Row = { id: string; type: string; status: 'queued' | 'running'; created: string };
		const rows: Row[] = [
			...running.map(e => ({ id: e.job.id, type: e.job.type, status: 'running' as const, created: e.job.created ?? '' })),
			...queued.map(e => ({ id: e.job.id, type: e.job.type, status: 'queued' as const, created: e.job.created ?? '' })),
		];
		if (rows.length === 0) {
			body.createDiv({ cls: 'crucible-empty-state', text: 'Queue is empty.' });
			return;
		}
		if (!ctx.sort) ctx.sort = { column: 'status', direction: 'asc' };
		this.renderSortableTable<Row>(body, [
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
			'enrichmentQueue',
			'uncapturedVideos',
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
			case 'uncapturedVideos': return this.renderUncapturedVideos(body, ctx);
			case 'enrichmentQueue': this.renderEnrichmentQueue(body); return;
		}
	}

	// --- Section: Unprocessed Clippings ---
	private renderUnprocessedClippings(body: HTMLElement, ctx: SectionContext): void {
		const folder = this.plugin.settings.ingestionClipperInboxFolder;
		const root = this.app.vault.getAbstractFileByPath(folder);
		body.empty();
		if (!(root instanceof TFolder)) {
			body.createDiv({ cls: 'crucible-empty-state', text: `Inbox folder "${folder}" not found.` });
			return;
		}
		const rows = root.children
			.filter((c): c is TFile => c instanceof TFile && c.extension === 'md')
			.map(f => ({
				file: f,
				title: f.basename,
				captured: f.stat.mtime,
				size: f.stat.size,
			}));

		if (rows.length === 0) {
			body.createDiv({ cls: 'crucible-empty-state', text: 'No unprocessed clippings.' });
			return;
		}

		this.renderSortableTable(body, [
			{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => this.renderFileLink(td, r.file) },
			{ key: 'captured', label: 'Captured', sortable: true, sortKey: r => r.captured, render: (r, td) => td.setText(formatDateTime(r.captured)) },
			{ key: 'size', label: 'Size (KB)', sortable: true, sortKey: r => r.size, render: (r, td) => td.setText((r.size / 1024).toFixed(1)) },
			{ key: 'open', label: '', render: (r, td) => this.renderOpenButton(td, r.file) },
		], rows, ctx);
	}

	// --- Section: Unrefined Transcripts ---
	private renderUnrefinedTranscripts(body: HTMLElement, ctx: SectionContext): void {
		const dailyFolder = this.plugin.settings.dailyFolder;
		const folder = this.app.vault.getAbstractFileByPath(dailyFolder);
		body.empty();
		if (!(folder instanceof TFolder)) {
			body.createDiv({ cls: 'crucible-empty-state', text: `Daily folder "${dailyFolder}" not found.` });
			return;
		}

		const wpm = this.plugin.settings.ingestionReadingWpm || 250;
		const excludeTags = new Set(['clippings', 'using']);

		const rows: Array<{
			file: TFile;
			title: string;
			tags: string[];
			words: number;
			estReadMin: number | null;
			created: number;
			read: boolean;
		}> = [];

		const visit = (f: TFolder) => {
			for (const child of f.children) {
				if (child instanceof TFolder) visit(child);
				else if (child instanceof TFile && child.extension === 'md') {
					const cache = this.app.metadataCache.getFileCache(child);
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

		if (rows.length === 0) {
			body.createDiv({ cls: 'crucible-empty-state', text: 'No unrefined transcripts.' });
			return;
		}

		// Default sort: created ascending (matches user's DataviewJS).
		if (!ctx.sort) ctx.sort = { column: 'created', direction: 'asc' };

		this.renderSortableTable(body, [
			{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => this.renderFileLink(td, r.file) },
			{ key: 'tags', label: 'Tags', render: (r, td) => td.setText(r.tags.join(', ')) },
			{ key: 'words', label: 'Words', sortable: true, sortKey: r => r.words, render: (r, td) => td.setText(String(r.words)) },
			{ key: 'estRead', label: 'Est. Read', sortable: true, sortKey: r => r.estReadMin ?? 0, render: (r, td) => td.setText(r.estReadMin != null ? `${r.estReadMin.toFixed(1)} min` : '') },
			{ key: 'created', label: 'Created', sortable: true, sortKey: r => r.created, render: (r, td) => td.setText(formatDate(r.created)) },
			{ key: 'read', label: 'Read?', sortable: true, sortKey: r => (r.read ? 1 : 0), render: (r, td) => td.setText(r.read ? '✅' : '❌') },
		], rows, ctx);
	}

	// --- Section: Blog Intake ---
	private renderBlogIntake(body: HTMLElement, ctx: SectionContext): void {
		const rows = listBlogsIntakeRuns(this.app);
		body.empty();
		if (rows.length === 0) {
			body.createDiv({ cls: 'crucible-empty-state', text: 'No blog tracker runs yet.' });
			return;
		}
		if (!ctx.sort) ctx.sort = { column: 'runAt', direction: 'desc' };

		this.renderSortableTable<BlogsIntakeRunStat>(body, [
			{ key: 'runAt', label: 'Run At', sortable: true, sortKey: r => r.runAt, render: (r, td) => this.renderFileLink(td, r.file, r.runAt || r.file.basename) },
			{ key: 'blogsTotal', label: 'Blogs', sortable: true, sortKey: r => r.blogsTotal, render: (r, td) => td.setText(String(r.blogsTotal)) },
			{ key: 'blogsWithNew', label: 'With New', sortable: true, sortKey: r => r.blogsWithNew, render: (r, td) => td.setText(String(r.blogsWithNew)) },
			{ key: 'postsTotal', label: 'Posts', sortable: true, sortKey: r => r.postsTotal, render: (r, td) => td.setText(String(r.postsTotal)) },
			{ key: 'blogsFailed', label: 'Failed', sortable: true, sortKey: r => r.blogsFailed, render: (r, td) => td.setText(String(r.blogsFailed)) },
			{ key: 'rowsSkipped', label: 'Skipped', sortable: true, sortKey: r => r.rowsSkipped, render: (r, td) => td.setText(String(r.rowsSkipped)) },
			{ key: 'generatedBy', label: 'Source', render: (r, td) => td.setText(r.generatedBy.replace('orchestrator/', '')) },
		], rows, ctx);
	}

	// --- Section: YouTube Intake ---
	private renderYoutubeIntake(body: HTMLElement, ctx: SectionContext): void {
		const rows = listYoutubeIntakeRuns(this.app);
		body.empty();
		if (rows.length === 0) {
			body.createDiv({ cls: 'crucible-empty-state', text: 'No YouTube tracker runs yet.' });
			return;
		}
		if (!ctx.sort) ctx.sort = { column: 'runAt', direction: 'desc' };

		this.renderSortableTable<YoutubeIntakeRunStat>(body, [
			{ key: 'runAt', label: 'Run At', sortable: true, sortKey: r => r.runAt, render: (r, td) => this.renderFileLink(td, r.file, r.runAt || r.file.basename) },
			{ key: 'channelsTotal', label: 'Channels', sortable: true, sortKey: r => r.channelsTotal, render: (r, td) => td.setText(String(r.channelsTotal)) },
			{ key: 'channelsWithNew', label: 'With New', sortable: true, sortKey: r => r.channelsWithNew, render: (r, td) => td.setText(String(r.channelsWithNew)) },
			{ key: 'videosTotal', label: 'Videos', sortable: true, sortKey: r => r.videosTotal, render: (r, td) => td.setText(String(r.videosTotal)) },
			{ key: 'channelsFailed', label: 'Failed', sortable: true, sortKey: r => r.channelsFailed, render: (r, td) => td.setText(String(r.channelsFailed)) },
			{ key: 'generatedBy', label: 'Source', render: (r, td) => td.setText(r.generatedBy.replace('orchestrator/', '')) },
		], rows, ctx);
	}

	// --- Section: Uncaptured Posts ---
	private async renderUncapturedPosts(body: HTMLElement, ctx: SectionContext): Promise<void> {
		body.empty();
		const placeholder = body.createDiv({ cls: 'crucible-empty-state', text: 'Scanning…' });
		const seen = buildBlogsSeenIdSet(this.app, false);
		const configured = await loadConfiguredBlogs(this.app, this.plugin);
		const scan = await scanBlogsTrackerRuns(this.app, seen, configured);

		const rows: UncapturedPostRow[] = [];
		for (const outcome of scan.outcomes) {
			for (const post of outcome.newPosts) {
				rows.push({
					postId: post.postId,
					blogName: outcome.blog.name,
					blogLink: outcome.blog.link,
					title: post.title,
					publishedAt: post.publishedAt,
					url: post.url,
				});
			}
		}

		placeholder.remove();
		if (rows.length === 0) {
			body.createDiv({ cls: 'crucible-empty-state', text: 'No uncaptured posts.' });
			return;
		}
		if (!ctx.sort) ctx.sort = { column: 'publishedAt', direction: 'desc' };

		this.renderSortableTable<UncapturedPostRow>(body, [
			{ key: 'blogName', label: 'Author', sortable: true, sortKey: r => displayLabel(r.blogName).toLowerCase(), render: (r, td) => this.renderAuthorCell(td, r.blogName) },
			{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => td.setText(r.title) },
			{ key: 'publishedAt', label: 'Publish Date', sortable: true, sortKey: r => r.publishedAt, render: (r, td) => td.setText((r.publishedAt || '').slice(0, 10)) },
			{ key: 'read', label: '', render: (r, td) => this.renderExternalLink(td, r.url, 'read') },
		], rows, ctx);
	}

	// --- Section: Uncaptured Videos ---
	private async renderUncapturedVideos(body: HTMLElement, ctx: SectionContext): Promise<void> {
		body.empty();
		const placeholder = body.createDiv({ cls: 'crucible-empty-state', text: 'Scanning…' });
		const rows = await this.computeUncapturedVideoRows();
		this.uncapturedVideosCache = rows;
		placeholder.remove();

		if (rows.length === 0) {
			body.createDiv({ cls: 'crucible-empty-state', text: 'No uncaptured videos.' });
			return;
		}
		if (!ctx.sort) ctx.sort = { column: 'publishedAt', direction: 'desc' };

		this.renderSortableTable<UncapturedVideoRow>(body, [
			{ key: 'channelName', label: 'Creator', sortable: true, sortKey: r => displayLabel(r.channelName).toLowerCase(), render: (r, td) => this.renderChannelLink(td, r.channelId, r.channelName) },
			{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => td.setText(r.title) },
			{ key: 'publishedAt', label: 'Publish Date', sortable: true, sortKey: r => r.publishedAt, render: (r, td) => td.setText((r.publishedAt || '').slice(0, 10)) },
			{ key: 'watch', label: '', render: (r, td) => this.renderExternalLink(td, r.url, 'watch') },
			{ key: 'enriched', label: 'Enriched?', render: (r, td) => this.renderEnrichedCell(td, r) },
		], rows, ctx);

		// Refresh the queue's auto-source so it stays aligned with current sort.
		if (this.plugin.enrichmentQueue?.isAutoEnabled()) {
			this.plugin.enrichmentQueue.setAutoSource(() => this.uncapturedQueueItems());
		}
	}

	private async computeUncapturedVideoRows(): Promise<UncapturedVideoRow[]> {
		const seen = buildYoutubeSeenIdSet(this.app, false);
		const configured = await loadConfiguredChannels(this.app, this.plugin);
		const scan = await scanYoutubeTrackerRuns(this.app, seen, configured);
		const root = this.plugin.settings.orchestrationYoutubeMetadataRoot || '_yt_metadata';

		const out: UncapturedVideoRow[] = [];
		for (const outcome of scan.outcomes) {
			for (const video of outcome.newVideos) {
				const enrichmentFile = await findExistingMetadataNote(this.app, root, video.videoId);
				out.push({
					videoId: video.videoId,
					channelName: outcome.channel.name,
					channelId: outcome.channel.channelId,
					title: video.title,
					publishedAt: video.publishedAt,
					url: video.url,
					enrichmentFile,
				});
			}
		}
		return out;
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

	// --- Section: Enrichment Queue ---
	private renderEnrichmentQueue(body: HTMLElement): void {
		body.empty();
		const queue = this.plugin.enrichmentQueue;
		if (!queue) {
			body.createDiv({ cls: 'crucible-empty-state', text: 'Queue service not available.' });
			return;
		}
		const entries = queue.getSnapshot();
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

	// --- Sortable table helper ---
	private renderSortableTable<T>(parent: HTMLElement, columns: Column<T>[], rows: T[], ctx: SectionContext): void {
		parent.empty();
		const sort = ctx.sort;
		const sorted = sort
			? [...rows].sort((a, b) => {
				const col = columns.find(c => c.key === sort.column);
				if (!col || !col.sortKey) return 0;
				const av = col.sortKey(a);
				const bv = col.sortKey(b);
				const cmp = av < bv ? -1 : av > bv ? 1 : 0;
				return sort.direction === 'asc' ? cmp : -cmp;
			})
			: rows;

		const table = parent.createEl('table', { cls: 'crucible-ingestion-table' });
		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		for (const col of columns) {
			const th = headerRow.createEl('th', { text: col.label });
			if (col.sortable) {
				th.addClass('is-sortable');
				if (sort && sort.column === col.key) {
					th.addClass(sort.direction === 'asc' ? 'is-sorted-asc' : 'is-sorted-desc');
					th.appendText(sort.direction === 'asc' ? ' ▲' : ' ▼');
				}
				th.addEventListener('click', () => {
					const current = ctx.sort;
					if (current && current.column === col.key) {
						ctx.sort = { column: col.key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
					} else {
						ctx.sort = { column: col.key, direction: 'asc' };
					}
					void ctx.refresh();
				});
			}
		}
		const tbody = table.createEl('tbody');
		for (const row of sorted) {
			const tr = tbody.createEl('tr');
			for (const col of columns) {
				const td = tr.createEl('td');
				col.render(row, td);
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

	private renderExternalLink(td: HTMLElement, url: string, label: string): void {
		const a = td.createEl('a', { text: label, href: url });
		a.setAttr('target', '_blank');
		a.setAttr('rel', 'noopener');
	}

	private renderChannelLink(td: HTMLElement, channelId: string, name: string): void {
		const md = parseMarkdownLink(name);
		const href = md?.url ?? `https://www.youtube.com/channel/${channelId}`;
		const label = md?.label ?? name;
		const a = td.createEl('a', { text: label, href });
		a.setAttr('target', '_blank');
		a.setAttr('rel', 'noopener');
	}

	private renderAuthorCell(td: HTMLElement, name: string): void {
		const md = parseMarkdownLink(name);
		if (md) {
			const a = td.createEl('a', { text: md.label, href: md.url });
			a.setAttr('target', '_blank');
			a.setAttr('rel', 'noopener');
		} else {
			td.setText(name);
		}
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
}

const MD_LINK_RE = /^\s*\[([^\]]+)\]\(\s*<?([^)\s<>]+)>?\s*(?:"[^"]*"|'[^']*')?\s*\)\s*$/;

function parseMarkdownLink(raw: string): { label: string; url: string } | null {
	if (!raw) return null;
	const m = raw.match(MD_LINK_RE);
	if (!m) return null;
	const label = (m[1] ?? '').trim();
	const url = (m[2] ?? '').trim();
	if (!label || !url) return null;
	return { label, url };
}

function displayLabel(raw: string): string {
	return parseMarkdownLink(raw)?.label ?? raw;
}

function formatDate(epochMs: number): string {
	if (!epochMs) return '';
	const d = new Date(epochMs);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

function formatDateTime(epochMs: number): string {
	if (!epochMs) return '';
	const d = new Date(epochMs);
	const date = formatDate(epochMs);
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	return `${date} ${hh}:${mm}`;
}

// Re-export for re-use elsewhere if needed.
export type { EnrichmentQueueEntry };
export type { BlogOutcome, YoutubeChannelOutcome, RemoteVideo, RemotePost };
