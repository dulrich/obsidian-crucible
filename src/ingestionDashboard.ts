import { App, EventRef, TFile, debounce, setIcon } from 'obsidian';
import type CruciblePlugin from './main';
import {
	BlogOutcome,
	INTAKE_ROOT_BLOGS,
	INTAKE_ROOT_YOUTUBE,
	YoutubeChannelOutcome,
} from './orchestration/utils/feedIntake';
import { IGNORED_IDS_NOTE } from './orchestration/utils/ignoredIds';
import { RemoteVideo } from './orchestration/utils/youtube';
import { RemotePost } from './orchestration/utils/blogs';
import { blogMetadataRoot } from './orchestration/utils/blogsApi';
import type { EnrichmentQueueEntry } from './orchestration/EnrichmentQueueAdapter';
import type { DashboardHost, SectionContext, SectionId } from './ingestion/render/types';
import { renderUnprocessedClippings } from './ingestion/sections/clippings';
import { renderUnrefinedTranscripts } from './ingestion/sections/transcripts';
import { createIntakeSection, type IntakeSection } from './ingestion/sections/intake';
import { buildQueueControlsSection } from './ingestion/sections/queueControls';
import { buildQueueMonitorSection, renderQueueMonitor } from './ingestion/sections/queueMonitor';
import { renderUncapturedPosts } from './ingestion/sections/uncapturedPosts';
import { createUncapturedVideosSection, type UncapturedVideosSection } from './ingestion/sections/uncapturedVideos';
import { renderEnqueueAllMetadataButton, renderYoutubeNoMetadata } from './ingestion/sections/youtubeWithoutMetadata';
import { createControlCentersSection, type ControlCentersSection } from './ingestion/sections/controlCenters';
import { createOrphanedAttachmentsSection, type OrphanedAttachmentsSection } from './ingestion/sections/orphanedAttachments';
import { renderIgnoredPosts, renderIgnoredVideos } from './ingestion/sections/ignored';

const DEBOUNCE_MS = 150;
// Vault-scan sections (uncaptured lists, no-metadata, orphans) recompute the
// whole vault, so they get a longer debounce than the cheap, event-driven ones.
const SCAN_DEBOUNCE_MS = 1000;

// Lifecycle/registry controller for the Ingestion dashboard: owns mounting,
// listener wiring, and the section registry (header chrome, count/meta slots,
// refresh dispatch). Each section's own render logic and state lives in
// src/ingestion/sections/*, rendering against the narrow DashboardHost seam
// declared in src/ingestion/render/types.ts.
export class IngestionDashboardUI {
	private readonly app: App;
	private readonly disposers: Array<() => void> = [];
	private readonly eventRefs: EventRef[] = [];
	private sections = new Map<SectionId, SectionContext>();
	// Last-seen signature of the frontmatter/links that actually drive the
	// vault-scan sections, keyed by path. Lets a metadataCache 'changed' event
	// (which fires on every keystroke) skip those refreshes when nothing relevant
	// to them changed — the source of the "dashboard flashes while typing" bug.
	private readonly relevantSignatures = new Map<string, { fm: string; links: string }>();

	private readonly host: DashboardHost;
	private readonly intake: IntakeSection;
	private readonly uncapturedVideosSection: UncapturedVideosSection;
	private readonly controlCenters: ControlCentersSection;
	private readonly orphanedAttachments: OrphanedAttachmentsSection;

	constructor(private readonly plugin: CruciblePlugin, private readonly container: HTMLElement) {
		this.app = plugin.app;
		this.host = {
			plugin: this.plugin,
			app: this.app,
			container: this.container,
			refresh: id => this.refresh(id),
			createSectionHeader: (card, title, description, defaultCollapsed) =>
				this.createSectionHeader(card, title, description, defaultCollapsed),
			registerSection: ctx => this.sections.set(ctx.id, ctx),
			registerDisposer: dispose => this.disposers.push(dispose),
			setSectionCount: (id, n) => this.setSectionCount(id, n),
			setSectionMeta: (id, text) => this.setSectionMeta(id, text),
			// Delegates to the uncaptured-videos section's own cache; see that
			// module for why the state itself lives there but is host-reachable.
			uncapturedQueueItems: () => this.uncapturedVideosSection.uncapturedQueueItems(),
		};
		this.intake = createIntakeSection(this.host);
		this.uncapturedVideosSection = createUncapturedVideosSection(this.host);
		this.controlCenters = createControlCentersSection(this.host);
		this.orphanedAttachments = createOrphanedAttachmentsSection(this.host);
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
		this.buildSection('blogIntake', 'Blog intake', 'Blog tracker runs (most recent first).', (heading) => this.intake.renderEnqueueIntakeButton(heading, 'blog'), true);
		this.buildSection('youtubeIntake', 'YouTube intake', 'YouTube tracker runs (most recent first).', (heading) => this.intake.renderEnqueueIntakeButton(heading, 'youtube'), true);
		buildQueueControlsSection(this.host);
		buildQueueMonitorSection(this.host);
		this.buildSection('uncapturedPosts', 'Uncaptured posts', 'Blog posts seen in tracker runs but not yet captured as a vault note.', undefined, true);
		this.buildSection('ignoredPosts', 'Ignored blogs', 'Blog post IDs you chose to ignore. They are skipped by the tracker and the uncaptured list.', undefined, true);
		this.buildSection(
			'blogControl',
			'Blog control center',
			'Every blog known to the vault, with tracked / ingested / ignored post counts.',
			undefined,
			true,
		);
		this.buildSection('uncapturedVideos', 'Uncaptured videos', 'YouTube videos seen in tracker runs but not yet captured as a vault note.', (heading) => this.uncapturedVideosSection.renderAutoEnqueueToggle(heading), true);
		this.buildSection('ignoredVideos', 'Ignored videos', 'YouTube video IDs you chose to ignore. They are skipped by the tracker, the uncaptured list, and auto-enrich.', undefined, true);
		this.buildSection(
			'youtubeWithoutMetadata',
			'YouTube captures without metadata',
			'Vault notes with a yt-video-id in frontmatter but no yt-metadata link yet.',
			(heading) => renderEnqueueAllMetadataButton(this.host, heading),
		);
		this.buildSection(
			'channelControl',
			'Channel control center',
			'Every YouTube channel known to the vault, with tracked / ingested / ignored video counts and a link to its about.md.',
			(heading) => this.controlCenters.renderEnrichAllChannelsButton(heading),
			true,
		);
		this.buildSection(
			'orphanedAttachments',
			'Orphaned attachments',
			'Localized attachments (…_MD5.ext) with no back-reference from any note.',
			(heading) => this.orphanedAttachments.renderCleanupAllButton(heading),
		);

		this.registerListeners();
		void this.refreshAll();
		void this.intake.refreshIntakeButton('blog');
		void this.intake.refreshIntakeButton('youtube');
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
		this.intake.clear();
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
			void this.intake.refreshIntakeButton('blog');
			void this.intake.refreshIntakeButton('youtube');
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
			case 'unprocessedClippings': return renderUnprocessedClippings(this.host, body, ctx);
			case 'unrefinedTranscripts': return renderUnrefinedTranscripts(this.host, body, ctx);
			case 'blogIntake': return this.intake.renderBlogIntake(body, ctx);
			case 'youtubeIntake': return this.intake.renderYoutubeIntake(body, ctx);
			case 'queueMonitor': return renderQueueMonitor(this.host, body, ctx);
			case 'uncapturedPosts': return renderUncapturedPosts(this.host, body, ctx);
			case 'ignoredPosts': return renderIgnoredPosts(this.host, body, ctx);
			case 'blogControl': return this.controlCenters.renderBlogControl(body, ctx);
			case 'uncapturedVideos': return this.uncapturedVideosSection.render(body, ctx);
			case 'ignoredVideos': return renderIgnoredVideos(this.host, body, ctx);
			case 'youtubeWithoutMetadata': return renderYoutubeNoMetadata(this.host, body, ctx);
			case 'channelControl': return this.controlCenters.renderChannelControl(body, ctx);
			case 'orphanedAttachments': return this.orphanedAttachments.render(body, ctx);
		}
	}
}

// Re-export for re-use elsewhere if needed.
export type { EnrichmentQueueEntry };
export type { BlogOutcome, YoutubeChannelOutcome, RemoteVideo, RemotePost };
