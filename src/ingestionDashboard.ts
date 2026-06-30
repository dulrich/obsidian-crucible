import { App, EventRef, Notice, TFile, debounce, setIcon } from 'obsidian';
import type CruciblePlugin from './main';
import { ConfirmModal } from './confirmModal';
import {
	BlogOutcome,
	BlogsIntakeRunStat,
	INTAKE_ROOT_BLOGS,
	INTAKE_ROOT_YOUTUBE,
	YoutubeChannelOutcome,
	YoutubeIntakeRunStat,
	listYoutubeIntakeRuns,
	listBlogsIntakeRuns,
} from './orchestration/utils/feedIntake';
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
import { blogMetadataRoot, runBlogIngestCommand } from './orchestration/utils/blogsApi';
import { logWarn } from './log';
import type { EnrichmentQueueEntry, EnrichmentQueueItem } from './orchestration/EnrichmentQueueAdapter';
import type { JobType, OrchestrationJob } from './orchestration/types';
import { renderSortableTable } from './ingestion/render/sortableTable';
import { renderTableSection } from './ingestion/render/section';
import type {
	BlogControlRow,
	ChannelControlRow,
	ClippingRow,
	OrphanRow,
	SectionContext,
	SectionId,
	TranscriptRow,
	UncapturedPostRow,
	UncapturedVideoRow,
	YoutubeNoMetadataRow,
} from './ingestion/render/types';
import { computeBlogControlRows } from './ingestion/data/blogs';
import { computeUnprocessedClippingRows } from './ingestion/data/clippings';
import { computeUnrefinedTranscriptRows } from './ingestion/data/transcripts';
import {
	computeUncapturedPostRows,
	computeUncapturedVideoRows,
	computeYoutubeNoMetadataRows,
} from './ingestion/data/uncaptured';
import { computeChannelControlRows } from './ingestion/data/channels';
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

const QUEUE_MONITOR_RENDER_LIMIT = 100;

const INTAKE_JOB_TYPE: Record<IntakeKind, JobType> = {
	blog: 'blogs_tracker',
	youtube: 'youtube_tracker',
};

function fileJobTargetPath(job: OrchestrationJob): string | undefined {
	const path = job.params?.targetPath ?? job.params?.path;
	return typeof path === 'string' ? path : undefined;
}

function fileJobTitle(job: OrchestrationJob): string {
	switch (job.type) {
		case 'image_metadata_extract': return typeof job.params?.imagePath === 'string' ? `Image metadata: ${job.params.imagePath.split('/').pop()}` : 'Image metadata extraction';
		case 'search_rebuild': return 'Vault search index';
		case 'search_upsert_batch': return searchBatchTitle(job);
		case 'search_sweep': return typeof job.params?.description === 'string' ? job.params.description : 'Search sweep';
		default: return job.id;
	}
}

function searchBatchTitle(job: OrchestrationJob): string {
	const batchIndex = typeof job.params?.batchIndex === 'number' ? job.params.batchIndex : -1;
	const batchCount = typeof job.params?.batchCount === 'number' ? job.params.batchCount : -1;
	if (batchIndex >= 0 && batchCount > 0) return `Search batch ${batchIndex + 1} / ${batchCount}`;
	return 'Search batch';
}

function ratio(n: number, d: number): number {
	return d > 0 ? n / d : 0;
}

function countWithPct(n: number, d: number): string {
	return d > 0 ? `${n} (${Math.round((n / d) * 100)}%)` : String(n);
}

const DEBOUNCE_MS = 150;
// Vault-scan sections (uncaptured lists, no-metadata, orphans) recompute the
// whole vault, so they get a longer debounce than the cheap, event-driven ones.
const SCAN_DEBOUNCE_MS = 1000;

export class IngestionDashboardUI {
	private readonly app: App;
	private readonly disposers: Array<() => void> = [];
	private readonly eventRefs: EventRef[] = [];
	private sections = new Map<SectionId, SectionContext>();
	private uncapturedVideosCache: UncapturedVideoRow[] = [];
	private orphanedAttachmentsCache: OrphanRow[] = [];
	private intakeButtons = new Map<IntakeKind, HTMLButtonElement>();
	// Blog control center filter: which blogs to list.
	private blogFilter: 'all' | 'tracked' | 'untracked' = 'all';
	// Channel control center filter: which channels to list.
	private channelFilter: 'all' | 'tracked' | 'untracked' = 'all';
	// Last-seen signature of the frontmatter/links that actually drive the
	// vault-scan sections, keyed by path. Lets a metadataCache 'changed' event
	// (which fires on every keystroke) skip those refreshes when nothing relevant
	// to them changed — the source of the "dashboard flashes while typing" bug.
	private readonly relevantSignatures = new Map<string, { fm: string; links: string }>();

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
		this.buildQueueMonitorSection();
		this.buildSection('uncapturedPosts', 'Uncaptured posts', 'Blog posts seen in tracker runs but not yet captured as a vault note.', undefined, true);
		this.buildSection('ignoredPosts', 'Ignored blogs', 'Blog post IDs you chose to ignore. They are skipped by the tracker and the uncaptured list.', undefined, true);
		this.buildSection(
			'blogControl',
			'Blog control center',
			'Every blog known to the vault, with tracked / ingested / ignored post counts.',
			undefined,
			true,
		);
		this.buildSection('uncapturedVideos', 'Uncaptured videos', 'YouTube videos seen in tracker runs but not yet captured as a vault note.', undefined, true);
		this.buildSection('ignoredVideos', 'Ignored videos', 'YouTube video IDs you chose to ignore. They are skipped by the tracker, the uncaptured list, and auto-enrich.', undefined, true);
		this.buildSection(
			'youtubeWithoutMetadata',
			'YouTube captures without metadata',
			'Vault notes with a yt-video-id in frontmatter but no yt-metadata link yet.',
			(heading) => this.renderEnqueueAllMetadataButton(heading),
		);
		this.buildSection(
			'channelControl',
			'Channel control center',
			'Every YouTube channel known to the vault, with tracked / ingested / ignored video counts and a link to its about.md.',
			(heading) => this.renderEnrichAllChannelsButton(heading),
			true,
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
		this.relevantSignatures.clear();
		this.container.empty();
	}

	private registerListeners(): void {
		const debouncedClippings = debounce(() => void this.refresh('unprocessedClippings'), DEBOUNCE_MS, true);
		const debouncedTranscripts = debounce(() => void this.refresh('unrefinedTranscripts'), DEBOUNCE_MS, true);
		const debouncedBlogIntake = debounce(() => void this.refresh('blogIntake'), DEBOUNCE_MS, true);
		const debouncedYoutubeIntake = debounce(() => void this.refresh('youtubeIntake'), DEBOUNCE_MS, true);
		const debouncedUncapturedPosts = debounce(() => void this.refresh('uncapturedPosts'), SCAN_DEBOUNCE_MS, true);
		const debouncedUncapturedVideos = debounce(() => void this.refresh('uncapturedVideos'), SCAN_DEBOUNCE_MS, true);
		const debouncedIgnoredPosts = debounce(() => void this.refresh('ignoredPosts'), DEBOUNCE_MS, true);
		const debouncedIgnoredVideos = debounce(() => void this.refresh('ignoredVideos'), DEBOUNCE_MS, true);
		const debouncedBlogControl = debounce(() => void this.refresh('blogControl'), SCAN_DEBOUNCE_MS, true);
		const debouncedYoutubeNoMetadata = debounce(() => void this.refresh('youtubeWithoutMetadata'), SCAN_DEBOUNCE_MS, true);
		const debouncedQueueMonitor = debounce(() => {
			void this.refresh('queueMonitor');
			void this.refreshIntakeButton('blog');
			void this.refreshIntakeButton('youtube');
		}, DEBOUNCE_MS, true);
		const debouncedOrphans = debounce(() => void this.refresh('orphanedAttachments'), SCAN_DEBOUNCE_MS, true);

		// reason 'structural' = vault create/delete/rename (can change everything);
		// 'meta' = metadataCache 'changed' (fires per keystroke — gated below).
		const route = (path: string, reason: 'meta' | 'structural') => {
			if (path === IGNORED_IDS_NOTE) {
				debouncedIgnoredPosts();
				debouncedIgnoredVideos();
				debouncedUncapturedPosts();
				debouncedUncapturedVideos();
				debouncedBlogControl();
			}
			const clipperRoot = this.plugin.settings.ingestionClipperInboxFolder;
			const dailyRoot = this.plugin.settings.dailyFolder;
			if (clipperRoot && path.startsWith(`${clipperRoot}/`)) debouncedClippings();
			if (dailyRoot && path.startsWith(`${dailyRoot}/`)) debouncedTranscripts();
			if (path.startsWith(`${INTAKE_ROOT_BLOGS}/`)) {
				debouncedBlogIntake();
				debouncedUncapturedPosts();
				debouncedBlogControl();
			}
			if (path.startsWith(`${INTAKE_ROOT_YOUTUBE}/`)) {
				debouncedYoutubeIntake();
				debouncedUncapturedVideos();
			}
			const ytRoot = this.plugin.settings.orchestrationYoutubeMetadataRoot;
			if (ytRoot && path.startsWith(`${ytRoot}/`)) debouncedUncapturedVideos();
			const blogRoot = blogMetadataRoot(this.plugin);
			if (blogRoot && path.startsWith(`${blogRoot}/`)) debouncedBlogControl();

			if (reason === 'structural') {
				// A note/attachment appeared, vanished, or moved — recompute the
				// scan sections and drop any stale signature for the path.
				this.relevantSignatures.delete(path);
				debouncedUncapturedPosts();
				debouncedUncapturedVideos();
				debouncedBlogControl();
				debouncedYoutubeNoMetadata();
				debouncedOrphans();
				return;
			}

			// metadataCache 'changed': only refresh a scan section when the data it
			// depends on actually changed since we last saw this path. Body keystrokes
			// leave both signatures untouched, so nothing re-renders.
			const next = this.relevantSignature(path);
			const prev = this.relevantSignatures.get(path);
			this.relevantSignatures.set(path, next);
			if (!prev || prev.fm !== next.fm) {
				// source/post-id/yt-video-id/yt-metadata drive the uncaptured + no-metadata lists.
				debouncedUncapturedPosts();
				debouncedUncapturedVideos();
				debouncedBlogControl();
				debouncedYoutubeNoMetadata();
			}
			if (!prev || prev.links !== next.links) {
				// The set of referenced attachments drives orphan status.
				debouncedOrphans();
			}
		};

		this.eventRefs.push(this.app.metadataCache.on('changed', file => route(file.path, 'meta')));
		this.eventRefs.push(this.app.vault.on('create', file => route(file.path, 'structural')));
		this.eventRefs.push(this.app.vault.on('delete', file => route(file.path, 'structural')));
		this.eventRefs.push(this.app.vault.on('rename', (file, oldPath) => { route(file.path, 'structural'); route(oldPath, 'structural'); }));

		const bus = this.plugin.ingestionEvents;
		if (bus) {
			this.disposers.push(bus.on('tracker-run', e => {
				if (e.kind === 'blog') { debouncedBlogIntake(); debouncedUncapturedPosts(); debouncedBlogControl(); }
				else { debouncedYoutubeIntake(); debouncedUncapturedVideos(); }
			}));
			this.disposers.push(bus.on('metadata-enriched', () => debouncedUncapturedVideos()));
			this.disposers.push(bus.on('enrichment-queue-updated', () => {
				debouncedQueueMonitor();
				// Metadata-fetch jobs live in the enrichment (memory) queue now, so the
				// "captures without metadata" badges track this event, not the file queue.
				debouncedYoutubeNoMetadata();
			}));
			this.disposers.push(bus.on('orchestration-queue-updated', () => {
				debouncedQueueMonitor();
				debouncedYoutubeNoMetadata();
			}));
			this.disposers.push(bus.on('clipping-captured', () => debouncedClippings()));
			this.disposers.push(bus.on('transcript-refined', () => debouncedTranscripts()));
		}
	}

	// Compact signature of the frontmatter and link targets the vault-scan sections
	// depend on. Two 'changed' events with the same signature mean nothing those
	// sections care about changed (e.g. a body keystroke), so they can be skipped.
	private relevantSignature(path: string): { fm: string; links: string } {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return { fm: '', links: '' };
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter ?? {};
		const fmSig = JSON.stringify([fm.source, fm.blog, fm['post-id'], fm['yt-video-id'], fm['yt-metadata']]);
		const links = [
			...(cache?.embeds ?? []).map(e => e.link),
			...(cache?.links ?? []).map(l => l.link),
		].sort().join(',');
		return { fm: fmSig, links };
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

	private buildQueueMonitorSection(): void {
		const card = this.container.createDiv({ cls: 'crucible-settings-group crucible-ingestion-section' });
		const { countEl, metaEl } = this.createSectionHeader(
			card,
			'Queue monitor',
			'All queued and running jobs across the file-backed and in-memory queues.',
			false,
		);

		const controls = card.createDiv({ cls: 'crucible-ingestion-queue-controls' });

		// --- Orchestrator controls ---
		const autorunLabel = controls.createEl('label', { cls: 'crucible-ingestion-queue-toggle' });
		const autorunToggle = autorunLabel.createEl('input', { type: 'checkbox' });
		autorunToggle.checked = this.plugin.settings.orchestrationQueueAutorunEnabled === true;
		autorunLabel.appendText(' Autorun');
		autorunToggle.addEventListener('change', () => {
			void (async () => {
				this.plugin.settings.orchestrationQueueAutorunEnabled = autorunToggle.checked;
				await this.plugin.saveSettings();
				this.plugin.orchestrationAutoRunner?.setEnabled(autorunToggle.checked);
			})();
		});

		const runNextBtn = controls.createEl('button', { text: 'Run next', cls: 'crucible-ingestion-run-next' });
		runNextBtn.addEventListener('click', () => {
			void this.plugin.orchestrationAutoRunner?.runOnce();
		});

		// --- Enrichment queue controls ---
		const enrichToggleLabel = controls.createEl('label', { cls: 'crucible-ingestion-queue-toggle' });
		const enrichToggle = enrichToggleLabel.createEl('input', { type: 'checkbox' });
		enrichToggle.checked = this.plugin.settings.ingestionYoutubeAutoEnrichEnabled === true;
		enrichToggleLabel.appendText(' Auto enrich from Uncaptured Videos');
		enrichToggle.addEventListener('change', () => {
			void (async () => {
				this.plugin.settings.ingestionYoutubeAutoEnrichEnabled = enrichToggle.checked;
				await this.plugin.saveSettings();
				this.plugin.enrichmentQueue?.setAutoEnabled(enrichToggle.checked);
				if (enrichToggle.checked) {
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
				// The metadata queue's gate reads ingestionYoutubeEnrichRateLimitSeconds
				// live, so saving the setting is all that's needed.
			})();
		});

		const body = card.createDiv({ cls: 'crucible-ingestion-section-body' });
		body.createDiv({ cls: 'crucible-empty-state', text: 'Queue is empty.' });

		const ctx: SectionContext = {
			id: 'queueMonitor',
			title: 'Queue monitor',
			description: '',
			body,
			countEl,
			metaEl,
			sort: null,
			refresh: () => this.renderQueueMonitor(body, ctx),
		};
		this.sections.set('queueMonitor', ctx);

		// Enable + push the initial auto-source if the toggle is on. Both are required:
		// MemoryJobQueue.refill() no-ops unless autoEnabled AND autoSource are set, and
		// nothing else enables the queue on load — without this the box reads ON but
		// enrichment stays idle until the toggle is cycled off/on.
		if (enrichToggle.checked) {
			this.plugin.enrichmentQueue?.setAutoEnabled(true);
			this.plugin.enrichmentQueue?.setAutoSource(() => this.uncapturedQueueItems());
		}
	}

	private renderEnqueueIntakeButton(heading: HTMLElement, kind: IntakeKind): void {
		const btn = heading.createEl('button', { cls: 'crucible-ingestion-enqueue-intake' });
		btn.setText('Enqueue intake');
		btn.addEventListener('click', () => {
			if (btn.disabled) return;
			void this.plugin.orchestrator.enqueue(INTAKE_JOB_TYPE[kind], {}, { priority: 'high', lane: 'user' });
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

	private async renderQueueMonitor(body: HTMLElement, ctx: SectionContext): Promise<void> {
		body.empty();

		// --- File-backed jobs (orchestrator job store) ---
		type QueueRow = {
			// 'file' rows come from jobStore; 'memory' rows come from enrichmentQueue
			source: 'file' | 'memory';
			status: 'queued' | 'running';
			type: string;
			// file rows: job id; memory rows: key used for Cancel
			key: string;
			// memory rows: videoId for dequeue calls
			videoId?: string;
			// memory rows: targetPath note link when available
			targetPath?: string;
			// memory rows: display title / channel fallback
			title?: string;
			created: string;
			error?: string;
			progress?: string;
		};

		const store = this.plugin.jobStore;
		let fileRows: QueueRow[] = [];
		if (store) {
			try {
				const [running, queued] = await Promise.all([store.listFolder('running'), store.listFolder('queued')]);
				fileRows = [
					...running.map(e => ({ source: 'file' as const, status: 'running' as const, type: e.job.type, key: e.job.id, targetPath: fileJobTargetPath(e.job), title: fileJobTitle(e.job), created: e.job.created ?? '', error: e.job.error, progress: e.job.progress })),
					...queued.map(e => ({ source: 'file' as const, status: 'queued' as const, type: e.job.type, key: e.job.id, targetPath: fileJobTargetPath(e.job), title: fileJobTitle(e.job), created: e.job.created ?? '', error: e.job.error, progress: e.job.progress })),
				];
			} catch (e) {
				body.createDiv({ cls: 'crucible-empty-state', text: `Failed to read file queue: ${e instanceof Error ? e.message : String(e)}` });
				this.setSectionCount('queueMonitor', 0);
				return;
			}
		}

		// --- In-memory jobs (enrichment queue snapshot) ---
		const memoryRows: QueueRow[] = (this.plugin.enrichmentQueue?.getSnapshot() ?? [])
			.filter(e => e.status === 'pending' || e.status === 'running')
			.map(e => ({
				source: 'memory' as const,
				// Map enrichment queue status to display status: pending → queued
				status: e.status === 'pending' ? ('queued' as const) : ('running' as const),
				type: 'youtube_metadata_fetch',
				key: e.key,
				videoId: e.videoId,
				targetPath: e.targetPath,
				title: e.title || e.videoId,
				created: e.addedAt ? formatDateTime(e.addedAt) : '',
				error: e.error,
			}));

		const rows: QueueRow[] = [...fileRows, ...memoryRows];

		// Per-type pending counts for section meta line
		const typeCounts = new Map<string, number>();
		for (const r of rows) typeCounts.set(r.type, (typeCounts.get(r.type) ?? 0) + 1);
		const metaParts = Array.from(typeCounts.entries()).map(([t, n]) => `${t} ${n}`);
		if (rows.length > QUEUE_MONITOR_RENDER_LIMIT) metaParts.push(`showing ${QUEUE_MONITOR_RENDER_LIMIT} of ${rows.length}`);
		const metaText = metaParts.join(' · ');
		this.setSectionMeta('queueMonitor', metaText);
		this.setSectionCount('queueMonitor', rows.length);

		if (rows.length === 0) {
			body.createDiv({ cls: 'crucible-empty-state', text: 'Queue is empty.' });
			return;
		}

		if (!ctx.sort) ctx.sort = { column: 'status', direction: 'asc' };

		renderSortableTable<QueueRow>(body, [
			{
				key: 'status',
				label: 'Status',
				sortable: true,
				// Running rows sort before queued rows
				sortKey: r => (r.status === 'running' ? 0 : 1),
				render: (r, td) => td.setText(r.status),
			},
			{
				key: 'type',
				label: 'Type',
				sortable: true,
				sortKey: r => r.type,
				render: (r, td) => td.setText(r.type),
			},
			{
				key: 'target',
				label: 'Target',
				sortable: true,
				sortKey: r => r.targetPath ?? r.title ?? r.key,
				render: (r, td) => {
					if (r.source === 'memory') {
						if (r.targetPath) {
							// Resolve note TFile and render a clickable vault link
							const file = this.app.vault.getAbstractFileByPath(r.targetPath);
							if (file instanceof TFile) {
								this.renderFileLink(td, file);
								return;
							}
						}
						// Fallback: title or videoId
						td.setText(r.title ?? r.videoId ?? r.key);
					} else {
						if (r.targetPath) {
							const file = this.app.vault.getAbstractFileByPath(r.targetPath);
							if (file instanceof TFile) {
								this.renderFileLink(td, file);
								return;
							}
						}
						td.setText(r.title ?? r.key);
					}
				},
			},
			{
				key: 'progress',
				label: 'Progress',
				render: (r, td) => td.setText(r.progress ?? ''),
			},
			{
				key: 'created',
				label: 'Created',
				sortable: true,
				sortKey: r => r.created,
				render: (r, td) => td.setText(r.created),
			},
			{
				key: 'error',
				label: 'Error',
				render: (r, td) => td.setText(r.error ?? ''),
			},
			{
				key: 'action',
				label: 'Action',
				render: (r, td) => {
					// Only memory-queue pending entries have a Cancel action
					if (r.source === 'memory' && r.status === 'queued') {
						const cancel = td.createEl('button', { text: 'Cancel' });
						cancel.addEventListener('click', () => {
							this.plugin.enrichmentQueue?.dequeueIfPending(r.key);
						});
					}
				},
			},
		], rows, ctx, { limit: QUEUE_MONITOR_RENDER_LIMIT });
	}

	private async refreshAll(): Promise<void> {
		const ids: SectionId[] = [
			'unprocessedClippings',
			'unrefinedTranscripts',
			'blogIntake',
			'youtubeIntake',
			'queueMonitor',
			'uncapturedPosts',
			'ignoredPosts',
			'blogControl',
			'uncapturedVideos',
			'ignoredVideos',
			'youtubeWithoutMetadata',
			'channelControl',
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
			case 'queueMonitor': return this.renderQueueMonitor(body, ctx);
			case 'uncapturedPosts': return this.renderUncapturedPosts(body, ctx);
			case 'ignoredPosts': return this.renderIgnoredPosts(body, ctx);
			case 'blogControl': return this.renderBlogControl(body, ctx);
			case 'uncapturedVideos': return this.renderUncapturedVideos(body, ctx);
			case 'ignoredVideos': return this.renderIgnoredVideos(body, ctx);
			case 'youtubeWithoutMetadata': return this.renderYoutubeNoMetadata(body, ctx);
			case 'channelControl': return this.renderChannelControl(body, ctx);
			case 'orphanedAttachments': return this.renderOrphanedAttachments(body, ctx);
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
				{ key: 'blogName', label: 'Author', sortable: true, sortKey: r => postAuthorLabel(r).toLowerCase(), render: (r, td) => renderPostAuthorCell(td, r) },
				{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => td.setText(r.title) },
				{ key: 'kind', label: 'Type', sortable: true, sortKey: r => r.kind, render: (r, td) => td.setText(r.kind) },
				{ key: 'wordCount', label: 'Words', sortable: true, sortKey: r => r.wordCount ?? -1, render: (r, td) => td.setText(r.wordCount == null ? '—' : String(r.wordCount)) },
				{ key: 'publishedAt', label: 'Publish Date', sortable: true, sortKey: r => r.publishedAt, render: (r, td) => td.setText((r.publishedAt || '').slice(0, 10)) },
				{ key: 'action', label: '', render: (r, td) => this.renderPostActionCell(td, r, ctx) },
				{ key: 'ignore', label: '', render: (r, td) => this.renderIgnoreButton(td, 'blog', r.postId, ctx, 'ignoredPosts') },
			],
		});
	}

	private renderPostActionCell(td: HTMLElement, row: UncapturedPostRow, ctx: SectionContext): void {
		renderExternalLink(td, row.url, 'read');
		td.createSpan({ text: '  ' });
		if (row.metadataFile) {
			this.renderFileLink(td, row.metadataFile, 'metadata');
		} else {
			td.createSpan({ text: 'metadata' }).addClass('crucible-muted');
		}
		if (!row.hasBody) return;
		td.createSpan({ text: '  ' });
		this.renderIngestButton(td, row, ctx);
	}

	private renderIngestButton(td: HTMLElement, row: UncapturedPostRow, ctx: SectionContext): void {
		const btn = td.createEl('button', { text: 'Ingest' });
		btn.addEventListener('click', () => {
			void (async () => {
				btn.disabled = true;
				try {
					const res = await runBlogIngestCommand(this.plugin, row);
					if (res.status === 'ran') {
						new Notice(`Ran ${res.commandId}`);
					} else if (res.status === 'missing-command') {
						new Notice('Choose a queueable blog ingest command in settings.');
						btn.disabled = false;
						return;
					} else {
						new Notice('No blog metadata note found for this post.');
						btn.disabled = false;
						return;
					}
				} catch (e) {
					new Notice(`Ingest failed: ${e instanceof Error ? e.message : String(e)}`);
					btn.disabled = false;
					return;
				}
				void ctx.refresh();
			})();
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
		const rows = await computeYoutubeNoMetadataRows(this.app);
		const inFlight = this.youtubeMetadataInFlight();

		renderTableSection<YoutubeNoMetadataRow>({
			body, ctx, rows,
			emptyText: 'No captures awaiting metadata.',
			defaultSort: { column: 'created', direction: 'desc' },
			setCount: n => this.setSectionCount('youtubeWithoutMetadata', n),
			columns: [
				{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => this.renderFileLink(td, r.file) },
				{ key: 'created', label: 'Create Date', sortable: true, sortKey: r => r.created, render: (r, td) => td.setText(formatDate(r.created)) },
				{ key: 'enqueue', label: '', render: (r, td) => this.renderEnqueueMetadataCell(td, r, inFlight) },
				{ key: 'ignore', label: '', render: (r, td) => this.renderIgnoreButton(td, 'youtube', r.videoId, ctx, 'ignoredVideos') },
			],
		});
	}

	// youtube_metadata_fetch now runs in the unified queue's in-memory path, so
	// in-flight state comes from the enrichment adapter (target note path → status)
	// rather than scanning the file-backed job folders.
	private youtubeMetadataInFlight(): Map<string, 'queued' | 'running'> {
		return this.plugin.enrichmentQueue?.metadataInFlightByPath() ?? new Map();
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
					title: row.title,
				}, { priority: 'high', lane: 'user', inputPaths: [row.file.path] });
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
					const rows = await computeYoutubeNoMetadataRows(this.app);
					if (rows.length === 0) {
						new Notice('No captures awaiting metadata.');
						return;
					}
					const inFlight = this.youtubeMetadataInFlight();
					let enqueued = 0;
					for (const row of rows) {
						if (inFlight.has(row.file.path)) continue;
						const job = await this.plugin.orchestrator.enqueue('youtube_metadata_fetch', {
							targetPath: row.file.path,
							videoId: row.videoId,
							title: row.title,
						}, { priority: 'high', lane: 'user', inputPaths: [row.file.path] });
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

	// --- Section: Blog control center ---
	private async renderBlogControl(body: HTMLElement, ctx: SectionContext): Promise<void> {
		body.empty();
		body.createDiv({ cls: 'crucible-empty-state', text: 'Scanning…' });
		const all = await computeBlogControlRows(this.app, this.plugin);
		body.empty();

		const controls = body.createDiv({ cls: 'crucible-ingestion-queue-controls' });
		const filters: Array<{ id: 'all' | 'tracked' | 'untracked'; label: string }> = [
			{ id: 'all', label: 'All' },
			{ id: 'tracked', label: 'Tracked' },
			{ id: 'untracked', label: 'Untracked' },
		];
		for (const f of filters) {
			const btn = controls.createEl('button', { text: f.label });
			if (this.blogFilter === f.id) btn.addClass('mod-cta');
			btn.addEventListener('click', () => {
				if (this.blogFilter === f.id) return;
				this.blogFilter = f.id;
				void ctx.refresh();
			});
		}

		const rows = all.filter(r =>
			this.blogFilter === 'all'
				? true
				: this.blogFilter === 'tracked' ? r.tracked : !r.tracked);

		const tableBody = body.createDiv();
		renderTableSection<BlogControlRow>({
			body: tableBody, ctx, rows,
			emptyText: 'No blogs match this filter.',
			defaultSort: { column: 'name', direction: 'asc' },
			setCount: n => this.setSectionCount('blogControl', n),
			columns: [
				{ key: 'name', label: 'Blog', sortable: true, sortKey: r => r.name.toLowerCase(), render: (r, td) => r.link ? renderExternalLink(td, r.link, r.name) : td.setText(r.name) },
				{ key: 'tracked', label: 'Posts', sortable: true, sortKey: r => r.trackedPosts, render: (r, td) => td.setText(String(r.trackedPosts)) },
				{ key: 'ingested', label: 'Ingested', sortable: true, sortKey: r => ratio(r.ingestedPosts, r.trackedPosts), render: (r, td) => td.setText(countWithPct(r.ingestedPosts, r.trackedPosts)) },
				{ key: 'ignored', label: 'Ignored', sortable: true, sortKey: r => ratio(r.ignoredPosts, r.trackedPosts), render: (r, td) => td.setText(countWithPct(r.ignoredPosts, r.trackedPosts)) },
				{ key: 'uncaptured', label: 'Uncaptured', sortable: true, sortKey: r => ratio(r.uncapturedPosts, r.trackedPosts), render: (r, td) => td.setText(countWithPct(r.uncapturedPosts, r.trackedPosts)) },
				{ key: 'isTracked', label: 'Tracked?', sortable: true, sortKey: r => r.tracked ? 1 : 0, render: (r, td) => td.setText(r.tracked ? 'yes' : 'no') },
			],
		});
	}

	// --- Section: Channel control center ---
	private async renderChannelControl(body: HTMLElement, ctx: SectionContext): Promise<void> {
		body.empty();
		body.createDiv({ cls: 'crucible-empty-state', text: 'Scanning…' });
		const all = await computeChannelControlRows(this.app, this.plugin);
		body.empty();

		// Filter control row (re-built each render); survives because it lives in the
		// section body while the table renders into a child container.
		const controls = body.createDiv({ cls: 'crucible-ingestion-queue-controls' });
		const filters: Array<{ id: 'all' | 'tracked' | 'untracked'; label: string }> = [
			{ id: 'all', label: 'All' },
			{ id: 'tracked', label: 'Tracked' },
			{ id: 'untracked', label: 'Untracked' },
		];
		for (const f of filters) {
			const btn = controls.createEl('button', { text: f.label });
			if (this.channelFilter === f.id) btn.addClass('mod-cta');
			btn.addEventListener('click', () => {
				if (this.channelFilter === f.id) return;
				this.channelFilter = f.id;
				void ctx.refresh();
			});
		}

		const rows = all.filter(r =>
			this.channelFilter === 'all'
				? true
				: this.channelFilter === 'tracked' ? r.tracked : !r.tracked);

		const tableBody = body.createDiv();
		renderTableSection<ChannelControlRow>({
			body: tableBody, ctx, rows,
			emptyText: 'No channels match this filter.',
			defaultSort: { column: 'name', direction: 'asc' },
			setCount: n => this.setSectionCount('channelControl', n),
			columns: [
				{ key: 'name', label: 'Channel', sortable: true, sortKey: r => r.name.toLowerCase(), render: (r, td) => r.aboutFile ? this.renderFileLink(td, r.aboutFile, r.name) : renderChannelLink(td, r.channelId, r.name) },
				{ key: 'tracked', label: 'Videos', sortable: true, sortKey: r => r.trackedVideos, render: (r, td) => td.setText(String(r.trackedVideos)) },
				{ key: 'ingested', label: 'Ingested', sortable: true, sortKey: r => ratio(r.ingestedVideos, r.trackedVideos), render: (r, td) => td.setText(countWithPct(r.ingestedVideos, r.trackedVideos)) },
				{ key: 'ignored', label: 'Ignored', sortable: true, sortKey: r => ratio(r.ignoredVideos, r.trackedVideos), render: (r, td) => td.setText(countWithPct(r.ignoredVideos, r.trackedVideos)) },
				{ key: 'uncaptured', label: 'Uncaptured', sortable: true, sortKey: r => ratio(r.uncapturedVideos, r.trackedVideos), render: (r, td) => td.setText(countWithPct(r.uncapturedVideos, r.trackedVideos)) },
				{ key: 'isTracked', label: 'Tracked?', sortable: true, sortKey: r => r.tracked ? 1 : 0, render: (r, td) => td.setText(r.tracked ? 'yes' : 'no') },
				{ key: 'enrich', label: '', render: (r, td) => this.renderChannelEnrichButton(td, r, ctx) },
			],
		});
	}

	private renderChannelEnrichButton(td: HTMLElement, row: ChannelControlRow, ctx: SectionContext): void {
		const btn = td.createEl('button', { text: row.aboutFile ? 'Re-enrich' : 'Enrich' });
		btn.addEventListener('click', () => {
			void (async () => {
				btn.disabled = true;
				const job = await this.plugin.orchestrator.enqueue('youtube_channel_enrich', {
					channelId: row.channelId,
					force: true,
				}, { priority: 'high', lane: 'user' });
				if (job) {
					btn.setText('Queued');
					new Notice(`Enqueued channel enrichment for ${row.name}.`);
				} else {
					btn.disabled = false;
				}
				void ctx.refresh();
			})();
		});
	}

	private renderEnrichAllChannelsButton(heading: HTMLElement): void {
		const btn = heading.createEl('button', { text: 'Enrich all', cls: 'crucible-ingestion-enqueue-intake' });
		btn.addEventListener('click', () => {
			void (async () => {
				btn.disabled = true;
				try {
					const job = await this.plugin.orchestrator.enqueue('youtube_channel_enrich_sweep', {}, { priority: 'high', lane: 'user' });
					new Notice(job ? 'Enqueued channel enrichment sweep.' : 'Channel enrichment sweep already queued.');
				} finally {
					btn.disabled = false;
					void this.refresh('channelControl');
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
						logWarn('cleanup: could not trash', row.file.path, e);
					}
				}
				const ok = rows.length - failed;
				new Notice(failed === 0 ? `Trashed ${ok} attachment${ok === 1 ? '' : 's'}.` : `Trashed ${ok}, ${failed} failed.`);
				void this.refresh('orphanedAttachments');
			})();
		});
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

// Prefer the post's real author(s) (dc:creator / atom author) over the blog name when present.
function postAuthorLabel(row: UncapturedPostRow): string {
	return row.authors.length > 0 ? row.authors.join(', ') : displayLabel(row.blogName);
}

function renderPostAuthorCell(td: HTMLElement, row: UncapturedPostRow): void {
	if (row.authors.length > 0) td.setText(row.authors.join(', '));
	else renderAuthorCell(td, row.blogName);
}

// Re-export for re-use elsewhere if needed.
export type { EnrichmentQueueEntry };
export type { BlogOutcome, YoutubeChannelOutcome, RemoteVideo, RemotePost };
