import { App, EventRef, TFile, setIcon } from 'obsidian';
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
import { ENRICHMENT_JOB_TYPE } from './orchestration/jobTypeConfig';
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
import { createMissingAttachmentsSection, type MissingAttachmentsSection } from './ingestion/sections/missingAttachments';
import { createXPostsSection, type XPostsSection } from './ingestion/sections/xPosts';
import { createSearchAuditSection, type SearchAuditSection } from './ingestion/sections/searchAudit';
import { xMetadataRoot } from './orchestration/utils/xApi';
import { renderIgnoredPosts, renderIgnoredVideos } from './ingestion/sections/ignored';
import { consumeSelfRefreshedEcho } from './ingestion/render/echoSuppress';
import { minIntervalGate, refreshWithScrollPreserved } from './ingestion/render/refresh';

// P6: the two cadence classes the coordinated flush (below) enforces per
// SectionId, replacing what used to be ~10 independent Obsidian
// `debounce(fn, ms, true)` closures (trailing-only "resetTimer" debounces)
// plus two separate `minIntervalGate` instances (queueMonitor,
// youtubeWithoutMetadata). FAST is the cheap, purely event-driven sections;
// SCAN is the full-vault-scan sections (uncaptured lists, no-metadata,
// orphans) plus the two sections that already needed a cadence FLOOR to keep
// rendering during sustained churn (queueMonitor, youtubeWithoutMetadata) —
// both already effectively floored at 1000ms via minIntervalGate, so folding
// them into the SCAN class changes nothing about their observed cadence.
const DEBOUNCE_MS = 150;
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

	// P6: sections marked dirty by vault/metadataCache/event-bus traffic (route()
	// and the bus handlers below), pending a coordinated flush. Sections the
	// user drives directly (queueControls, channelControl — forced-only, no
	// auto-refresh trigger) are never marked dirty and so never touch this set.
	private readonly dirty = new Set<SectionId>();
	private static readonly FAST_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>([
		'unprocessedClippings', 'unrefinedTranscripts', 'blogIntake', 'youtubeIntake',
		'ignoredPosts', 'ignoredVideos',
	]);
	private static readonly SCAN_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>([
		'uncapturedPosts', 'uncapturedVideos', 'blogControl', 'orphanedAttachments',
		'missingAttachments', 'youtubeWithoutMetadata', 'queueMonitor', 'xPosts',
	]);
	// Two cadence-classed gates, reusing the same tested minIntervalGate
	// primitive the pre-P6 code already relied on for youtubeWithoutMetadata
	// and queueMonitor (see render/refresh.ts) — leading-immediate +
	// bounded-trailing semantics, so a lone dirty section still renders right
	// away and a sustained burst still renders periodically rather than being
	// starved until the first quiet gap (the bug an Obsidian resetTimer
	// debounce has). Each call flushes every CURRENTLY dirty section in its
	// class together, in one coordinated pass (see flushDirty), so the shared
	// scroll coordinator (refreshWithScrollPreserved) captures/restores once
	// per batch instead of once per section.
	private readonly flushFast = minIntervalGate(
		() => this.flushDirty(IngestionDashboardUI.FAST_SECTIONS),
		DEBOUNCE_MS,
	);
	private readonly flushScan = minIntervalGate(
		() => this.flushDirty(IngestionDashboardUI.SCAN_SECTIONS),
		SCAN_DEBOUNCE_MS,
	);

	// vf-1 class (root AGENTS.md quirk): true once unmount() has run. registerListeners()
	// defers its vault/metadataCache subscriptions to onLayoutReady (see there); if the leaf
	// closes before that callback fires, the guard keeps it from pushing refs into an
	// eventRefs array unmount() has already drained.
	private unmounted = false;

	private readonly host: DashboardHost;
	private readonly intake: IntakeSection;
	private readonly uncapturedVideosSection: UncapturedVideosSection;
	private readonly controlCenters: ControlCentersSection;
	private readonly orphanedAttachments: OrphanedAttachmentsSection;
	private readonly missingAttachments: MissingAttachmentsSection;
	private readonly xPosts: XPostsSection;
	private readonly searchAudit: SearchAuditSection;

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
		this.missingAttachments = createMissingAttachmentsSection(this.host);
		this.xPosts = createXPostsSection(this.host);
		this.searchAudit = createSearchAuditSection(this.host);
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
			'Per-status post counts, per blog.',
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
			'Per-status video counts and about.md link, per channel.',
			(heading) => this.controlCenters.renderEnrichAllChannelsButton(heading),
			true,
		);
		this.buildSection(
			'orphanedAttachments',
			'Orphaned attachments',
			'Localized attachments (…_MD5.ext) with no back-reference from any note.',
			(heading) => this.orphanedAttachments.renderCleanupAllButton(heading),
		);
		this.buildSection(
			'missingAttachments',
			'Missing localized attachments',
			'Notes whose …_MD5.ext embeds or links point at a file that no longer exists.',
			(heading) => this.missingAttachments.renderRepairAllButton(heading),
		);
		this.buildSection(
			'xPosts',
			'X posts',
			'X statuses seen in the link registry or already materialized as _x_metadata notes.',
			(heading) => this.xPosts.renderBackfillButton(heading),
			true,
		);
		this.buildSection(
			'searchAudit',
			'Search audit',
			'Vault vs search-index drift, with per-class repairs.',
			(heading) => this.searchAudit.renderRunAuditButton(heading),
			true,
		);

		this.registerListeners();
		void this.refreshAll();
		void this.intake.refreshIntakeButton('blog');
		void this.intake.refreshIntakeButton('youtube');
	}

	unmount(): void {
		this.unmounted = true;
		for (const off of this.disposers) {
			try { off(); } catch { /* swallow */ }
		}
		this.disposers.length = 0;
		for (const ref of this.eventRefs) {
			this.app.vault.offref(ref);
			this.app.metadataCache.offref(ref);
		}
		this.eventRefs.length = 0;
		// The enrichment auto-source closes over this dashboard's row cache, so it must
		// not outlive the dashboard. Clearing the SOURCE (not the enabled flag) is the
		// point: the user's Auto-enqueue preference is persisted and survives, there is
		// simply nothing to pull candidates from while no dashboard is mounted.
		this.plugin.orchestrator?.setAutoSource(ENRICHMENT_JOB_TYPE, null);
		this.intake.clear();
		this.sections.clear();
		this.relevantSignatures.clear();
		// P6: drop any pending dirty marks. A minIntervalGate trailing call already
		// scheduled at this point may still fire once more after unmount, but
		// flushDirty's `this.sections.get(id)?.refresh(...)` is a safe no-op once
		// sections is empty — same non-issue the pre-P6 debounce closures had.
		this.dirty.clear();
		this.container.empty();
	}

	// P6: marks `id` dirty and kicks its cadence class's gate. Idempotent to
	// call repeatedly for the same id (the Set absorbs duplicates and the
	// minIntervalGate absorbs repeated calls within its window into one
	// trailing invocation) — every route()/bus-handler call site below just
	// calls this instead of its own independent debounce closure.
	private markDirty(id: SectionId): void {
		this.dirty.add(id);
		if (IngestionDashboardUI.FAST_SECTIONS.has(id)) this.flushFast();
		else if (IngestionDashboardUI.SCAN_SECTIONS.has(id)) this.flushScan();
	}

	// One coordinated pass: renders every CURRENTLY dirty section belonging to
	// `classIds` together. Firing every section's refresh synchronously here —
	// before awaiting any of them — guarantees they overlap in time rather
	// than relying on incidental timer landing, which is what lets the shared
	// scroll coordinator in refreshWithScrollPreserved capture once (on the
	// first call, before any of the batch has started tearing down) and
	// restore once (after the whole batch has settled) instead of once per
	// section. queueMonitor's flush additionally refreshes the two intake
	// header buttons — the same coupling the old gatedQueueMonitorRefresh had,
	// since both were driven by the same enrichment-/orchestration-queue-
	// updated bus events; refreshIntakeButton's own internal state cache
	// (setIntakeButtonState) already makes an unconditional call here cheap
	// when nothing changed.
	private flushDirty(classIds: ReadonlySet<SectionId>): void {
		const due = Array.from(this.dirty).filter(id => classIds.has(id));
		if (due.length === 0) return;
		for (const id of due) this.dirty.delete(id);
		const renders = due.map(id => this.sections.get(id)?.refresh({ eventDriven: true }));
		if (due.includes('queueMonitor')) {
			renders.push(this.intake.refreshIntakeButton('blog'));
			renders.push(this.intake.refreshIntakeButton('youtube'));
		}
		void Promise.all(renders);
	}

	private registerListeners(): void {
		// reason 'structural' = vault create/delete/rename (can change everything);
		// 'meta' = metadataCache 'changed' (fires per keystroke — gated below).
		const route = (path: string, reason: 'meta' | 'structural') => {
			// P1: job files USED to be real vault notes under orchestrationQueueRoot
			// (inbox/running/done/failed/cancelled all lived directly under this root),
			// so every enqueue (create), claim/settle (rename — dispatched TWICE, old+new
			// path), and clear hit this listener and cost five full-vault scans. thq WP-8
			// moved the queue into the plugin database, so no new event can arrive from
			// here — but the folder survives as a frozen archive of ~20k notes until the
			// user deletes it, and deleting it fires one event per note. The guard is
			// therefore kept, and is if anything more load-bearing on that one day than it
			// was in steady state. Queue UI updates arrive via the
			// 'orchestration-queue-updated' bus event, which has its own gated listener.
			const queueRoot = this.plugin.settings.orchestrationQueueRoot;
			if (queueRoot && (path === queueRoot || path.startsWith(`${queueRoot}/`))) return;

			if (path === IGNORED_IDS_NOTE) {
				// The Ignore/Unignore button handlers (render/cells.ts) already
				// synchronously refresh whichever of these sections their action
				// touched, then mark it via markSelfRefreshedForEcho — so this event,
				// which that same write also fires, is the expected echo for those
				// ids and would otherwise re-render already-current data a moment
				// later (the "Ignore flashes twice" bug). consumeSelfRefreshedEcho
				// skips exactly that one redundant call per id; any id NOT marked
				// (e.g. a hand-edit of the note, or an id this exact action didn't
				// touch) is marked dirty as before.
				if (!consumeSelfRefreshedEcho('ignoredPosts')) this.markDirty('ignoredPosts');
				if (!consumeSelfRefreshedEcho('ignoredVideos')) this.markDirty('ignoredVideos');
				if (!consumeSelfRefreshedEcho('uncapturedPosts')) this.markDirty('uncapturedPosts');
				if (!consumeSelfRefreshedEcho('uncapturedVideos')) this.markDirty('uncapturedVideos');
				if (!consumeSelfRefreshedEcho('blogControl')) this.markDirty('blogControl');
				// P2: return here — this path is handled in full above. Without this,
				// both the 'meta' event fired by vault.modify (existing note) and the
				// 'structural' create event fired the first time ignored.md is written
				// fall through to the generic branches below: 'meta' would hit the
				// `!prev` first-sighting check and re-schedule the same sections ~1s
				// later (the echo markers only cover THIS block), and 'structural'
				// would fire all five scan refreshes unconditionally with no echo
				// check at all (the create case, when ignored.md doesn't exist yet).
				// ignored.md never matches any of the path-prefix branches below, so
				// returning here changes nothing else it would otherwise reach.
				return;
			}
			const clipperRoot = this.plugin.settings.ingestionClipperInboxFolder;
			const dailyRoot = this.plugin.settings.dailyFolder;
			if (clipperRoot && path.startsWith(`${clipperRoot}/`)) this.markDirty('unprocessedClippings');
			if (dailyRoot && path.startsWith(`${dailyRoot}/`)) this.markDirty('unrefinedTranscripts');
			if (path.startsWith(`${INTAKE_ROOT_BLOGS}/`)) {
				this.markDirty('blogIntake');
				this.markDirty('uncapturedPosts');
				this.markDirty('blogControl');
			}
			if (path.startsWith(`${INTAKE_ROOT_YOUTUBE}/`)) {
				this.markDirty('youtubeIntake');
				this.markDirty('uncapturedVideos');
			}
			const ytRoot = this.plugin.settings.orchestrationYoutubeMetadataRoot;
			if (ytRoot && path.startsWith(`${ytRoot}/`)) this.markDirty('uncapturedVideos');
			const blogRoot = blogMetadataRoot(this.plugin);
			if (blogRoot && path.startsWith(`${blogRoot}/`)) this.markDirty('blogControl');
			const xRoot = xMetadataRoot(this.plugin);
			if (xRoot && path.startsWith(`${xRoot}/`)) this.markDirty('xPosts');

			if (reason === 'structural') {
				// A note/attachment appeared, vanished, or moved — recompute the
				// scan sections and drop any stale signature for the path.
				this.relevantSignatures.delete(path);
				this.markDirty('uncapturedPosts');
				this.markDirty('uncapturedVideos');
				this.markDirty('blogControl');
				this.markDirty('youtubeWithoutMetadata');
				this.markDirty('orphanedAttachments');
				this.markDirty('missingAttachments');
				// Registry paths (under _crucible/link_registry) have no dedicated
				// path-prefix branch above — a new link-record note fans out through
				// this unconditional structural branch instead, same as every other
				// scan section here.
				this.markDirty('xPosts');
				return;
			}

			// metadataCache 'changed': only refresh a scan section when the data it
			// depends on actually changed since we last saw this path. Body keystrokes
			// leave both signatures untouched, so nothing re-renders. P2: a first
			// sighting of a path (no `prev`) only establishes the baseline — it does
			// NOT schedule a refresh. Before this fix `!prev` treated "never seen this
			// path before" as "changed," so the very first metadataCache event for ANY
			// previously-unseen path fired all five scan refreshes unconditionally —
			// that path already got its due refresh from the 'structural' branch above
			// when the file was created (which always fires on create, regardless of
			// signature), so re-firing here on the very next 'meta' event was pure
			// duplication. A real change on an already-baselined path still fires.
			const next = this.relevantSignature(path);
			const prev = this.relevantSignatures.get(path);
			this.relevantSignatures.set(path, next);
			if (prev && prev.fm !== next.fm) {
				// source/post-id/yt-video-id/yt-metadata drive the uncaptured + no-metadata lists;
				// x-metadata/x-status-id drive the X posts list (a link record gaining/losing its
				// x-status-id, or a source note gaining its x-metadata stamp).
				this.markDirty('uncapturedPosts');
				this.markDirty('uncapturedVideos');
				this.markDirty('blogControl');
				this.markDirty('youtubeWithoutMetadata');
				this.markDirty('xPosts');
			}
			if (prev && prev.links !== next.links) {
				// The set of referenced attachments drives orphan status, in both
				// directions: an unreferenced file (orphan) and a ref pointing at
				// nothing (missing).
				this.markDirty('orphanedAttachments');
				this.markDirty('missingAttachments');
			}
		};

		// vf-1 class (root AGENTS.md quirk): Obsidian replays vault.on('create') for every
		// pre-existing file during startup vault indexing. If this dashboard is part of the
		// restored workspace layout, mount() (and therefore registerListeners()) can run
		// before that replay has settled — and every replayed create used to hit the
		// unconditional 'structural' branch above, marking both heavy scan sections dirty
		// repeatedly through the whole storm. Deferring these vault/metadataCache
		// subscriptions to onLayoutReady mirrors triggers.start() and the auto-localize
		// create listener in main.ts: for the common case (dashboard opened well after
		// boot) onLayoutReady has already fired, so the callback below runs immediately and
		// behavior is unchanged; for a dashboard open at boot, registration now waits until
		// after the replay. The metadataCacheReady latch below is untouched — separate
		// concern (partial-index window vs. create-replay volume).
		this.app.workspace.onLayoutReady(() => {
			if (this.unmounted) return;
			// The orphan scan renders a waiting state until the plugin's
			// metadataCacheReady latch flips (main.ts — resolvedLinks is still
			// rebuilding before that, which false-flagged thousands of orphans after a
			// restart). missingAttachments reads the same getFirstLinkpathDest-backed
			// cache state and is exposed to the identical partial-index window, so it
			// shares the latch. If this dashboard mounted before the flip, re-render
			// both sections the moment the first 'resolved' lands; local latch because
			// 'resolved' also fires after every later change batch.
			let orphanScanUnblocked = this.plugin.metadataCacheReady;
			this.eventRefs.push(this.app.metadataCache.on('resolved', () => {
				if (orphanScanUnblocked) return;
				orphanScanUnblocked = true;
				this.markDirty('orphanedAttachments');
				this.markDirty('missingAttachments');
			}));
			this.eventRefs.push(this.app.metadataCache.on('changed', file => route(file.path, 'meta')));
			this.eventRefs.push(this.app.vault.on('create', file => route(file.path, 'structural')));
			this.eventRefs.push(this.app.vault.on('delete', file => route(file.path, 'structural')));
			this.eventRefs.push(this.app.vault.on('rename', (file, oldPath) => { route(file.path, 'structural'); route(oldPath, 'structural'); }));
		});

		const bus = this.plugin.ingestionEvents;
		if (bus) {
			this.disposers.push(bus.on('tracker-run', e => {
				if (e.kind === 'blog') { this.markDirty('blogIntake'); this.markDirty('uncapturedPosts'); this.markDirty('blogControl'); }
				else { this.markDirty('youtubeIntake'); this.markDirty('uncapturedVideos'); }
			}));
			this.disposers.push(bus.on('metadata-enriched', () => this.markDirty('uncapturedVideos')));
			this.disposers.push(bus.on('x-metadata-enriched', () => this.markDirty('xPosts')));
			// thq WP-8: the separate 'enrichment-queue-updated' listener is gone with the
			// memory queue that emitted it. Nothing is lost — metadata fetches are ordinary
			// jobs now, so they emit 'orchestration-queue-updated', and that listener
			// already marked the identical pair of sections. Having the db backend emit
			// both events instead would have been strictly more code for the same result.
			this.disposers.push(bus.on('orchestration-queue-updated', () => {
				this.markDirty('queueMonitor');
				this.markDirty('youtubeWithoutMetadata');
			}));
			this.disposers.push(bus.on('clipping-captured', () => this.markDirty('unprocessedClippings')));
			this.disposers.push(bus.on('transcript-refined', () => this.markDirty('unrefinedTranscripts')));
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
		const fmSig = JSON.stringify([fm.source, fm.blog, fm['post-id'], fm['yt-video-id'], fm['yt-metadata'], fm['x-metadata'], fm['x-status-id']]);
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
		const refreshBtn = heading.createEl('button', { cls: 'crucible-ingestion-refresh crucible-icon-label-btn' });
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.createSpan({ text: 'Refresh' });
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
			// SectionContext.refresh is itself the scroll-preserving wrapped function
			// (render/refresh.ts) so every call site — the header Refresh button,
			// sort-header clicks, Ignore/Un-ignore, per-row action buttons, and the
			// coordinated flush's dirty-section dispatch (flushDirty above) — gets
			// scroll preservation for free, and participates in the shared
			// dashboard-level scroll coordinator alongside every other section's
			// refresh. P5: `opts.eventDriven` is set on `ctx` BEFORE the render call
			// so render/section.ts's shouldRepaint() can read it — true only for
			// flushDirty's calls; every other call site here passes no opts, which
			// resolves to a forced (always-repaint) pass.
			refresh: (opts) => {
				ctx.eventDriven = opts?.eventDriven === true;
				return refreshWithScrollPreserved(body, () => this.renderSection(id, body, ctx));
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
			'missingAttachments',
			'xPosts',
			'searchAudit',
		];
		for (const id of ids) await this.refresh(id);
	}

	private async refresh(id: SectionId): Promise<void> {
		const ctx = this.sections.get(id);
		if (!ctx) return;
		// Plain dispatch: ctx.refresh is itself the scroll-preserving wrapped
		// function (see each section builder), so this no longer wraps anything
		// itself — it just routes to the section's own refresh. See render/refresh.ts.
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
			case 'missingAttachments': return this.missingAttachments.render(body, ctx);
			case 'xPosts': return this.xPosts.render(body, ctx);
			case 'searchAudit': return this.searchAudit.render(body, ctx);
		}
	}
}

// Re-export for re-use elsewhere if needed.
export type { BlogOutcome, YoutubeChannelOutcome, RemoteVideo, RemotePost };
