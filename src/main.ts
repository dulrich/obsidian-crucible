import { Plugin, TFile, MarkdownView, Notice, debounce, TAbstractFile, TFolder, Editor } from 'obsidian';
import { CrucibleSettingTab, CrucibleSettingsTab } from "./settings";
import { CrucibleSettings, DEFAULT_SETTINGS, Provider } from "./types";
import { normalizeAgentBinding } from "./providerModelContract";
import { Materializer } from "./materialize";
import { Linter } from "./lint";
import { AttachmentLocalizer } from "./localizeAttachments";
import { CaptureManager } from "./captures";
import { ChainManager } from "./chains";
import { ProviderManager } from "./providers";
import { SecretRegistry, describeSecretKey } from "./secretRegistry";
import { AgentManager, agentCommandId } from "./agents";
import { TableOfContentsUI } from "./toc";
import { applyTemplateString } from './utils';
import { Orchestrator } from './orchestration/Orchestrator';
import type { AutoSourceFn } from './orchestration/Orchestrator';
import type { JobType } from './orchestration/types';
import { DailyBriefLiteWorkflow } from './orchestration/workflows/DailyBriefLiteWorkflow';
import { TranscriptRefinerWorkflow } from './orchestration/workflows/TranscriptRefinerWorkflow';
import {
	BlogsTrackerConsolidateWorkflow,
	BlogsTrackerWorkflow,
	YoutubeTrackerConsolidateWorkflow,
	YoutubeTrackerWorkflow,
} from './orchestration/workflows/FeedTrackerWorkflow';
import { coerceVideoId, isYtMetadataLinked } from './orchestration/utils/youtubeApi';
import { LinkScanWorkflow } from './orchestration/workflows/LinkScanWorkflow';
import { YoutubeMetadataFetchWorkflow } from './orchestration/workflows/YoutubeMetadataFetchWorkflow';
import { YoutubeChannelEnrichWorkflow } from './orchestration/workflows/YoutubeChannelEnrichWorkflow';
import { YoutubeChannelEnrichSweepWorkflow } from './orchestration/workflows/YoutubeChannelEnrichSweepWorkflow';
import { XMetadataFetchWorkflow } from './orchestration/workflows/XMetadataFetchWorkflow';
import { XPostDiscoverWorkflow } from './orchestration/workflows/XPostDiscoverWorkflow';
import { CrucibleSettingsView, CRUCIBLE_SETTINGS_VIEW_TYPE } from './settingsView';
import { IngestionDashboardView, INGESTION_DASHBOARD_VIEW_TYPE } from './ingestionDashboardView';
import { SourceEvalDashboardView, SOURCE_EVAL_DASHBOARD_VIEW_TYPE } from './sourceEvalDashboardView';
import { IngestionEventBus } from './orchestration/events';
import { NoteLockManager } from './orchestration/NoteLockManager';
import { NoteLockOverlay } from './noteLockOverlay';
import { migrateJobTypeControls, readTypeAutorun, setTypeControl } from './orchestration/autorunGate';
import { maybeShowArchiveNotice } from './orchestration/archiveNotice';
import { ENRICHMENT_JOB_TYPE, chainRunJobConfig, commandRunJobConfig, imageDescribeBackfillJobConfig, imageDescribeBatchJobConfig, imageDescribeNoteJobConfig, searchBatchJobConfig, searchEmbedMissingJobConfig, searchFileJobConfig, searchRebuildJobConfig, searchSweepJobConfig, transcriptRefineJobConfig, xMetadataFetchJobConfig, xPostDiscoverJobConfig, youtubeChannelEnrichJobConfig, youtubeChannelEnrichSweepJobConfig, youtubeMetadataJobConfig, youtubeTrackerJobConfig } from './orchestration/jobTypeConfig';
import { ServiceHealthRegistry } from './orchestration/serviceHealth';
import { ChainRunWorkflow } from './orchestration/workflows/ChainRunWorkflow';
import { CommandRunWorkflow } from './orchestration/workflows/CommandRunWorkflow';
import { ImageDescribeBackfillWorkflow, ImageDescribeBatchWorkflow, ImageDescribeNoteWorkflow } from './orchestration/workflows/ImageDescribeWorkflow';
import { OrchestrationAutoRunner } from './orchestration/OrchestrationAutoRunner';
import { TriggerRegistry } from './orchestration/TriggerRegistry';
import { TriggerValidationCtx, validateTrigger } from './triggers/triggerValidation';
import { registerStaticCommands } from './commands';
import { SearchManager } from './search/SearchManager';
import { SearchIndexCoordinator } from './search/SearchIndexCoordinator';
import { SEARCH_QUERY_LOG_FILENAME, SearchQueryLog } from './search/queryLog';
import { ImageDescriptionStorage, ImageDescriptionStore } from './search/imageDescriptionStore';
import { FileOpenIndex } from './fileOpenIndex';
import { SearchDeletePathWorkflow, SearchEmbedMissingWorkflow, SearchRebuildWorkflow, SearchSweepWorkflow, SearchUpsertBatchWorkflow, SearchUpsertFileWorkflow } from './orchestration/workflows/SearchIndexWorkflow';
import { migrateExcludedFolders } from './exclusions';
import { isImageAlreadyDescribed, shouldEnqueueImageDescribe } from './orchestration/utils/imageDescribe';
import { logError, logWarn } from './log';
import { AutoLocalizeScheduler } from './autoLocalizeScheduler';
import { registerInternalCommands } from './internalCommands';
import { registerMoveFileCommands as registerMoveFileCommandsImpl } from './moveFileCommands';
import { registerCaptures as registerCapturesImpl, promptForText as promptForTextImpl } from './captureCommands';
import { openDayPicker, openWeekPicker, openMonthPicker, handlePeriodFileCreate } from './periodPickers';
import { applySurround } from './surround';

export type CrucibleCommandGroup =
	| 'Appearance'
	| 'Materialize'
	| 'Lint'
	| 'Files'
	| 'Shortcuts'
	| 'Captures'
	| 'Chains'
	| 'Agents'
	| 'Orchestrations'
	| 'Ingestion'
	| 'Search'
	| 'Other';

export interface CrucibleCommandEntry {
	id: string;
	name: string;
	group: CrucibleCommandGroup;
	// Whether running the command mutates the active/target note. Governs whether it
	// acquires the per-note lock. Defaults to true (safe); read-only commands set false.
	mutating: boolean;
	// Whether the command may be enqueued as a `command_run` job (by a trigger or an
	// orchestration workflow). Requires a chain-internal twin — the awaited,
	// target-file-aware registration — so the queued run targets the job's note
	// instead of fire-and-forget on the active one. Defaults to "twin exists".
	queueable: boolean;
	// Runtime availability for palette invocation. Settings and chain-authoring
	// surfaces intentionally remain registry-driven instead of availability-driven.
	available?: () => boolean;
	// Settings-facing feature-gate help. Return text only when a separate feature
	// setting disables the command; context gates like "needs active file" stay out.
	availabilityHelp?: () => string | null;
}

type CrucibleCommandRunner = () => Promise<unknown>;

export default class CruciblePlugin extends Plugin {
	settings: CrucibleSettings;
	linter: Linter;
	attachmentLocalizer: AttachmentLocalizer;
	commandRegistry: CrucibleCommandEntry[] = [];
	private commandRunners = new Map<string, CrucibleCommandRunner>();
	// Widened from `private`: read/written by internalCommands.ts, captureCommands.ts
	// and periodPickers.ts, which take `plugin` rather than being class members
	// (see the commands.ts registration-hub pattern). TS visibility only —
	// no runtime behavior change.
	isMaterializing = false;
	materializer: Materializer;
	captureManager: CaptureManager;
	chainManager: ChainManager;
	providerManager: ProviderManager;
	secretRegistry: SecretRegistry;
	agentManager: AgentManager;
	orchestrator: Orchestrator;
	/**
	 * Per-dependency circuit breaker for the queue. Deliberately in-memory and NEVER
	 * persisted: a breaker that survives a reload can wedge a service that recovered
	 * while Obsidian was closed, and rebuilding the hysteresis costs at most three
	 * deferrals with zero failures.
	 */
	serviceHealth: ServiceHealthRegistry;
	ingestionEvents: IngestionEventBus;
	noteLocks: NoteLockManager;
	private noteLockOverlay: NoteLockOverlay;
	searchManager: SearchManager;
	// Passive, bounded, local record of executed vault searches and which result was opened
	// (src/search/queryLog.ts). Lives in the plugin's data dir, never in the vault's note tree.
	searchQueryLog: SearchQueryLog;
	// The MD5-keyed image description store (src/search/imageDescriptionStore.ts,
	// docs/multimodal-image-search.md Decision 2). Also lives in the plugin's data dir, outside
	// the vault's note tree — WP-2/WP-3 read it at chunk-prep and enqueue time respectively.
	imageDescriptions: ImageDescriptionStore;
	searchIndexCoordinator: SearchIndexCoordinator;
	fileOpenIndex: FileOpenIndex;
	orchestrationAutoRunner: OrchestrationAutoRunner;
	triggers: TriggerRegistry;
	// Latched true on the metadata cache's first full 'resolved' after load, never
	// reset. The orphaned-attachments scan trusts `metadataCache.resolvedLinks`;
	// computing it before this latch flips reported 3,323 false orphans of 5,284
	// localized attachments after a restart (live validation 2026-07-30 — a raw
	// text scan showed 0 truly unreferenced files). Consumers render a waiting
	// state while false; the dashboard re-renders on the flip via its own
	// one-shot 'resolved' listener.
	metadataCacheReady = false;
	// The single native-settings-modal instance (registered via addSettingTab in onload).
	// Kept as a field — rather than only living inside the anonymous addSettingTab(new ...)
	// call — so openSettingsToTab() can deep-link it even while the modal isn't open.
	private settingTab: CrucibleSettingTab;
	private tocComponent: TableOfContentsUI | null = null;
	// Chain-internal command ids registered for each "Chain: X" command, so a chain
	// can be used as an (awaited, target-file-aware) step inside another chain.
	// Cleared and rebuilt on every registerChains() so renames/deletes don't leak.
	private registeredChainInternalIds = new Set<string>();
	private autoLocalizeScheduler: AutoLocalizeScheduler;

	async onload() {
		await this.loadSettings();

		// Apply the N1 Console surround before the workspace paints, so there is no
		// flash of the wrong surround on startup. The companion theme keys off this.
		applySurround(this.app, this.settings.surround);

		this.ingestionEvents = new IngestionEventBus();
		this.noteLocks = new NoteLockManager(this.ingestionEvents);
		// One-shot latch: 'resolved' fires when the cache finishes resolving every
		// file (first during startup indexing, then again after each change batch);
		// only the first firing matters here, so the listener removes itself.
		const resolvedRef = this.app.metadataCache.on('resolved', () => {
			this.metadataCacheReady = true;
			this.app.metadataCache.offref(resolvedRef);
		});
		this.registerEvent(resolvedRef);
		this.materializer = new Materializer(this.app, this.settings, (state: boolean) => { this.isMaterializing = state; });
		this.linter = new Linter(this.app, this.settings, (state: boolean) => { this.isMaterializing = state; }, this.noteLocks);
		this.attachmentLocalizer = new AttachmentLocalizer(
			this.app,
			this.settings,
			(state: boolean) => { this.isMaterializing = state; },
			this.noteLocks,
			(imagePath, sourceNotePath) => this.enqueueImageDescribeForNote(imagePath, sourceNotePath),
		);
		this.autoLocalizeScheduler = new AutoLocalizeScheduler({
			resolveFile: path => {
				const file = this.app.vault.getAbstractFileByPath(path);
				return file instanceof TFile ? file : null;
			},
			isLocked: path => this.noteLocks.isLocked(path),
			isMaterializing: () => this.isMaterializing,
			sourceEnabled: source => source === 'create'
				? this.settings.localizeAttachmentsTriggerOnCreate
				: this.settings.localizeAttachmentsTriggerOnEdit,
			localize: async file => await this.attachmentLocalizer.localizeNote(file, true),
		});
		this.captureManager = new CaptureManager(this.app, this.settings, (state: boolean) => { this.isMaterializing = state; });
		this.chainManager = new ChainManager(this.app, this.noteLocks);
		this.secretRegistry = new SecretRegistry(this);
		this.providerManager = new ProviderManager(this.app, this.secretRegistry);
		this.searchManager = new SearchManager(this.app, this.settings, this.providerManager);
		// `app.vault.adapter` structurally satisfies QueryLogStorage. The file sits beside
		// data.json in the plugin's own directory — outside the vault's note tree, so the log
		// can never be indexed by the search leg it exists to measure. Loading is lazy (first
		// write or read), so nothing here costs startup time.
		this.searchQueryLog = new SearchQueryLog({
			storage: this.app.vault.adapter,
			filePath: this.pluginDataPath(SEARCH_QUERY_LOG_FILENAME),
			isEnabled: () => this.settings.searchQueryLogEnabled,
			maxEntries: () => this.settings.searchQueryLogMaxEntries,
		});
		// Same "outside the note tree by construction" reasoning as the query log above, but the
		// adapter's own read/write/list shapes don't structurally satisfy ImageDescriptionStorage
		// (adapter.read throws on a missing path; adapter.list returns {files,folders}), so this
		// gets a thin wrapper instead of a direct pass-through. The wrapper also lazily mkdir's the
		// base dir on first write — nothing here calls mkdir eagerly at startup.
		this.imageDescriptions = new ImageDescriptionStore(
			this.createImageDescriptionStorage(this.pluginDataPath('image-descriptions')),
			this.pluginDataPath('image-descriptions'),
		);
		// Post-construction injection: the SearchManager is built above, before the store exists
		// (pluginDataPath needs onload to be further along), so it takes the store through a
		// setter. Without this call the image-description facet is silently inert — prepareFile
		// folds no facet and emits no image chunks.
		this.searchManager.setImageDescriptionStore(this.imageDescriptions);
		// vf-1: kick off the store's directory listing as early as possible (fire-and-forget;
		// `load()` never throws — see imageDescriptionStore.ts). `enqueueImageDescribeForNote`
		// below consults `has()` synchronously off the in-memory index to skip already-described
		// images, and the earliest an auto-localize create schedule can fire is 2500ms after
		// onLayoutReady — starting the load here, at onload, gives it the whole plugin
		// construction + layout-ready window to finish first.
		void this.imageDescriptions.ensureLoaded();
		this.searchIndexCoordinator = new SearchIndexCoordinator(this, () => this.isMaterializing);
		this.fileOpenIndex = new FileOpenIndex(this);
		this.agentManager = new AgentManager(this.app, this.settings, this.chainManager, this.providerManager);
		// Before the orchestrator and the autorunner: both read it, and the autorunner
		// subscribes to its transitions in its own constructor.
		this.serviceHealth = new ServiceHealthRegistry();
		this.orchestrator = new Orchestrator(this);
		// thq WP-8: the first `register` opens the jobs DB, and a DB that cannot be
		// opened fails the registration hard (SqliteUnavailableError, already surfaced as
		// a Notice + logError inside the Orchestrator). Catching here is what keeps that
		// honest failure *scoped*: orchestration is dead — no types registered, so every
		// enqueue answers null and no drain runs — while lint, localize, chains, captures
		// and search all still load. Letting it escape `onload` would take the whole
		// plugin down over a queue that is, by design, disposable.
		try {
			this.registerJobTypes();
		} catch (e) {
			logError('orchestration is unavailable: the jobs database could not be opened', e);
		}
		void this.migrateGlobalAutorun();
		// The drain loop. Constructed unconditionally (it tolerates an orchestrator
		// with no registered types): its constructor kicks an immediate drain,
		// subscribes to queue events, starts the 60s service-health backstop, and
		// arms the 5s post-layout-ready drain. This line was accidentally deleted
		// in the WP-8 queue cutover (0c342e2) — with it gone, esbuild tree-shakes
		// the entire class out of main.js and every `?.` call site silently
		// no-ops, so NOTHING ever drains. A structural test now pins it
		// (tests/autoRunnerWiring.test.mjs).
		this.orchestrationAutoRunner = new OrchestrationAutoRunner(this, this.orchestrator);
		this.triggers = new TriggerRegistry(this, () => this.isMaterializing);
		this.registerFoundingTriggers();
		// Migrate a held note-lock when its note is moved/renamed mid-operation, so
		// path-keyed gates stay consistent and peers keep serializing. Registered
		// BEFORE triggers.start() and the rename handler below so it runs first
		// (vault listeners fire in registration order).
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (file instanceof TFile) this.noteLocks.handleRename(oldPath, file.path);
		}));

		registerInternalCommands(this);
		this.registerAgents();
		this.registerChains();
		this.registerTriggers();

		this.registerView(CRUCIBLE_SETTINGS_VIEW_TYPE, (leaf) => new CrucibleSettingsView(leaf, this));
		this.registerView(INGESTION_DASHBOARD_VIEW_TYPE, (leaf) => new IngestionDashboardView(leaf, this));
		this.registerView(SOURCE_EVAL_DASHBOARD_VIEW_TYPE, (leaf) => new SourceEvalDashboardView(leaf, this));
		this.registerEvent(this.app.metadataCache.on('resolved', () => {
			this.searchIndexCoordinator.markMetadataResolved();
			// The link-boost graph is derived from resolvedLinks/frontmatterLinks, so this is
			// the one event that means "the graph moved". Cheap: it only clears a field.
			this.searchManager.invalidateLinkGraph();
		}));
		this.app.workspace.onLayoutReady(() => {
			this.searchIndexCoordinator.markLayoutReady();
			this.fileOpenIndex.markLayoutReady();
			this.orchestrator.scan({ notify: false }).catch((e) => logError('startup orchestrator scan failed', e));
			// thq WP-8: tell the user, once, that the old markdown queue folder is now a
			// frozen archive they may delete. See archiveNotice.ts for why it is a Notice,
			// why the folder is never auto-deleted, and why the flag is persisted.
			void maybeShowArchiveNotice(this.app, this.settings, () => this.saveSettings());
			void this.warnOnMissingSecrets();
			// Obsidian replays vault.on('create') for every pre-existing file during
			// vault indexing at startup — with a populated orchestration queue that's
			// thousands of job-note creates. Starting triggers here (after that
			// replay has settled) skips the storm instead of reacting to it.
			// start() is idempotent (the `started` guard) and registration still runs
			// after the noteLock rename handler above, so path re-keying on rename
			// still wins the race; user-trigger schedule anchoring in setUserTriggers
			// (called from registerTriggers() above) is unaffected either way.
			this.triggers.start();
			// vf-1: the same create-replay storm above also drove auto-localize, whose
			// already-localized branch (localizeAttachments.ts) still enqueues an
			// image_describe_note job per note — every restart re-minted ~50-105 duplicate
			// describe jobs (verified against the live jobs.sqlite). Registering the
			// auto-localize create listener here, after the replay has settled, skips the
			// storm the same way triggers.start() does. This listener is separate from the
			// one at onload time (which still drives search indexing and the file-open
			// index on every create, including the replay — both already gate on their own
			// readiness); the modify/edit auto-localize trigger is registered eagerly and is
			// unaffected — only the create source was ever subject to the replay.
			this.registerEvent(this.app.vault.on('create', (file) => {
				if (this.isMaterializing || !(file instanceof TFile) || file.extension !== 'md') return;
				this.autoLocalizeScheduler.schedule(file, 'create');
			}));
		});

		this.addRibbonIcon('anvil', 'Crucible settings', () => {
			this.app.setting.open();
			this.app.setting.openTabById(this.manifest.id);
		});

		// --- Commands ---
		registerStaticCommands(this);

		// --- Events ---
		// vf-1: this listener no longer drives auto-localize scheduling — that moved to a
		// second `vault.on('create')` listener registered inside onLayoutReady (see the
		// comment there). handleFileCreate still runs here for materialize (it self-guards
		// on non-empty files), and search indexing / file-open indexing stay here too since
		// both already gate on their own readiness state during the startup replay.
		this.registerEvent(this.app.vault.on('create', (file) => {
			void this.handleFileCreate(file);
			this.searchIndexCoordinator.handleCreate(file);
			if (file instanceof TFile) {
				this.fileOpenIndex.handleCreate({ path: file.path, extension: file.extension, mtime: file.stat.mtime });
			}
		}));

		const debouncedLint = debounce(async (file: TFile) => {
			// Skip while a mutating command/chain holds the note's lock: it is the sole
			// mutator until it releases, and auto-linting underneath it races its writes.
			if (this.noteLocks.isLocked(file.path)) return;
			if (this.settings.lintOnSave && !this.isMaterializing) {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.file?.path === file.path) {
					await this.linter.lintNote(activeView);
				}
			}
		}, 2000, true);

		this.register(() => this.autoLocalizeScheduler.clear());
		this.register(() => this.searchIndexCoordinator.dispose());
		this.register(() => this.fileOpenIndex.dispose());

		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file instanceof TFile && file.extension === 'md') {
				debouncedLint(file);
				this.autoLocalizeScheduler.schedule(file, 'edit');
			}
			if (file instanceof TFile) this.searchIndexCoordinator.handleModify(file);
		}));

		this.registerEvent(this.app.workspace.on('editor-paste', (evt, editor, view) => {
			if (!this.settings.localizeAttachmentsTriggerOnPaste) return;
			if (!(view instanceof MarkdownView)) return;
			void this.attachmentLocalizer.handlePaste(evt, editor, view);
		}));

		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (file instanceof TFile && file.extension === 'md') {
				this.autoLocalizeScheduler.move(oldPath, file.path);
				void this.attachmentLocalizer.onNoteRename(file, oldPath);
			}
			this.searchIndexCoordinator.handleRename(file, oldPath);
			if (file instanceof TFile) {
				this.fileOpenIndex.handleRename({ path: file.path, extension: file.extension, mtime: file.stat.mtime }, oldPath);
			}
		}));

		this.registerEvent(this.app.vault.on('delete', (file) => {
			this.autoLocalizeScheduler.cancel(file.path);
			void this.attachmentLocalizer.onNoteDelete(file.path);
			this.searchIndexCoordinator.handleDelete(file.path);
			this.fileOpenIndex.handleDelete(file.path);
		}));

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem((item) => {
						item
							.setTitle('Lint notes in folder')
							.setIcon('check-circle')
							.onClick(async () => {
								await this.linter.lintFolder(file);
							});
					});
					menu.addItem((item) => {
						item
							.setTitle('Localize attachments in folder')
							.setIcon('image-down')
							.onClick(async () => {
								await this.attachmentLocalizer.localizeFolder(file);
							});
					});
				}
			})
		);

		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshToC()));
		this.registerEvent(this.app.metadataCache.on('changed', () => this.refreshToC()));

		this.registerShortcuts();
		this.registerCaptures();
		this.settingTab = new CrucibleSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.noteLockOverlay = new NoteLockOverlay(this);

		this.refreshToC();
	}

	onunload() {
		if (this.tocComponent) this.tocComponent.unload();
		this.noteLockOverlay?.dispose();
		this.triggers?.dispose();
		this.orchestrationAutoRunner?.dispose();
		this.serviceHealth?.dispose();
		this.ingestionEvents?.dispose();
	}

	activeEditor(): Editor | undefined {
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? undefined;
	}

	// Called per-image by AttachmentLocalizer once a localize finishes (four call sites — see
	// the localize-hook quirk). The job itself is per-NOTE (dedupe key note:<sourceNotePath>),
	// so several calls from the same note's localize pass collapse onto one queued
	// image_describe_note job via FileJobBackend's existing dedupe — no separate per-note
	// batching needed here.
	enqueueImageDescribeForNote(imagePath: string, sourceNotePath?: string): void {
		if (!sourceNotePath) return;
		if (!shouldEnqueueImageDescribe(this.settings, imagePath)) return;
		// vf-1: skip minting a job for an image that already has a description record — see
		// `isImageAlreadyDescribed`'s doc comment. Execution-time `has()` in `describeOneImage`
		// stays as the second layer for whatever does get enqueued.
		if (isImageAlreadyDescribed(md5 => this.imageDescriptions.has(md5), imagePath)) return;
		this.orchestrator.enqueue('image_describe_note', {
			targetPath: sourceNotePath,
		}, { priority: 'low', lane: 'background', inputPaths: [sourceNotePath, imagePath] })
			.catch((e) => logError('image_describe_note enqueue failed', e));
	}

	// Code-defined triggers (queue-first design): each one only ENQUEUES jobs, so
	// triggered work inherits queue semantics — dedupe, pacing, timeout, note locks.
	// Settings → Orchestrate → Triggers exposes per-trigger enable toggles.
	private registerFoundingTriggers(): void {
		this.triggers.register({
			id: 'yt-metadata-on-capture',
			description: 'When a note gains a yt-video-id without a yt-metadata link, enqueue a per-note metadata fetch.',
			on: { event: 'metadata-changed' },
			enabled: () => this.settings.ingestionYoutubeAutoEnqueueEnabled,
			guard: (_file, fm) => {
				if (!fm) return false;
				return coerceVideoId(fm['yt-video-id']) !== '' && !isYtMetadataLinked(fm['yt-metadata']);
			},
			jobs: (file) => file ? [{
				type: 'youtube_metadata_fetch',
				params: { targetPath: file.path, videoId: coerceVideoId(this.app.metadataCache.getFileCache(file)?.frontmatter?.['yt-video-id']), title: file.basename },
			}] : [],
		});
		this.triggers.register({
			id: 'youtube-tracker-schedule',
			description: 'Enqueue a YouTube tracker run on a fixed interval (0 minutes = off).',
			on: { everyMs: () => Math.max(0, this.settings.orchestrationYoutubeTrackerIntervalMinutes) * 60_000 },
			enabled: () => this.settings.orchestrationYoutubeTrackerEnabled,
			jobs: () => [{ type: 'youtube_tracker' }],
		});
		this.triggers.register({
			id: 'youtube-channel-enrich-schedule',
			description: 'Refresh stale YouTube channel about.md notes on a fixed interval (0 minutes = off).',
			on: { everyMs: () => Math.max(0, this.settings.orchestrationYoutubeChannelEnrichIntervalMinutes) * 60_000 },
			enabled: () => this.settings.orchestrationYoutubeChannelEnrichEnabled,
			jobs: () => [{ type: 'youtube_channel_enrich_sweep' }],
		});
		this.triggers.register({
			id: 'blogs-tracker-schedule',
			description: 'Enqueue a blog tracker run on a fixed interval (0 minutes = off).',
			on: { everyMs: () => Math.max(0, this.settings.orchestrationBlogsTrackerIntervalMinutes) * 60_000 },
			enabled: () => this.settings.orchestrationBlogsTrackerEnabled,
			jobs: () => [{ type: 'blogs_tracker' }],
		});
	}

	registerCrucibleCommand(opts: {
		id: string;
		name: string;
		group: CrucibleCommandGroup;
		run: () => unknown;
		available?: () => boolean;
		availabilityHelp?: () => string | null;
		mutating?: boolean;
		queueable?: boolean;
	}): void {
		// A command is queueable when a chain-internal twin exists at registration
		// time (built-ins register internals first in onload; captures/chains register
		// theirs immediately before this call).
		const queueable = opts.queueable
			?? (this.chainManager.hasInternalCommand(`${this.manifest.id}:${opts.id}`)
				|| this.chainManager.hasInternalCommand(`crucible:${opts.id}`));
		this.commandRegistry.push({
			id: opts.id,
			name: opts.name,
			group: opts.group,
			mutating: opts.mutating ?? true,
			queueable,
			available: opts.available,
			availabilityHelp: opts.availabilityHelp,
		});
		this.commandRunners.set(opts.id, async () => await opts.run());
		this.addCommand({
			id: opts.id,
			name: opts.name,
			checkCallback: (checking: boolean) => {
				if (this.settings.hiddenCommands.includes(opts.id)) return false;
				if (opts.available && !opts.available()) return false;
				if (!checking) void this.executeCrucibleCommand(opts.id).catch(e => this.reportCommandFailure(opts.name, e));
				return true;
			},
		});
	}

	async executeCrucibleCommand(id: string): Promise<unknown> {
		const runner = this.commandRunners.get(id);
		return runner ? await runner() : null;
	}

	// Widened from `private`: called by captureCommands.ts's registerCaptures.
	clearCommandRegistryGroup(group: CrucibleCommandGroup): void {
		for (const entry of this.commandRegistry) {
			if (entry.group === group) this.commandRunners.delete(entry.id);
		}
		this.commandRegistry = this.commandRegistry.filter(c => c.group !== group);
	}

	private reportCommandFailure(name: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		logError(`command failed (${name})`, error);
		new Notice(`${name} failed: ${message}`);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<CrucibleSettings>);
		await this.migrateSettings();
	}

	// Reconcile the stored-secret registry against Obsidian's secret store and warn
	// once if a key the user saved has vanished (e.g. an Obsidian update reset the
	// store). Silent when the store is unavailable (a different failure) or intact.
	async warnOnMissingSecrets(): Promise<void> {
		const result = await this.secretRegistry.reconcile();
		if (!result || result.missing.length === 0) return;
		const labels = result.missing.map(key => describeSecretKey(this, key));
		logWarn('secrets', 'missing from store:', labels.join(', '));
		new Notice(
			`Crucible: ${labels.length} saved API key${labels.length > 1 ? 's are' : ' is'} missing from Obsidian's secret store — re-enter in Settings (${labels.join(', ')}).`,
			0,
		);
	}
	
	private async migrateSettings() {
		let dirty = false;
		const legacySettings = this.settings as CrucibleSettings & { lintIgnoredFolders?: unknown };
		const excludedFolders = Array.isArray(this.settings.excludedFolders) ? this.settings.excludedFolders : [];
		const legacyLintFolders = Array.isArray(legacySettings.lintIgnoredFolders)
			? legacySettings.lintIgnoredFolders.filter((v): v is string => typeof v === 'string')
			: [];
		const migratedExclusions = migrateExcludedFolders(excludedFolders, legacyLintFolders);
		if (JSON.stringify(migratedExclusions) !== JSON.stringify(this.settings.excludedFolders)) {
			this.settings.excludedFolders = migratedExclusions;
			dirty = true;
		}
		if ('lintIgnoredFolders' in legacySettings) {
			delete legacySettings.lintIgnoredFolders;
			dirty = true;
		}

		// Rename the enrichment auto-ENQUEUE (source) flag: the old
		// `ingestionYoutubeAutoEnrichEnabled` conflated source and drain; it now means
		// auto-enqueue only (drain is the per-type auto-run flag, seeded below). Copy
		// the value across so the source stays on for existing users, then drop the key.
		const legacyEnrich = this.settings as CrucibleSettings & { ingestionYoutubeAutoEnrichEnabled?: unknown };
		if ('ingestionYoutubeAutoEnrichEnabled' in legacyEnrich) {
			if (typeof legacyEnrich.ingestionYoutubeAutoEnrichEnabled === 'boolean') {
				this.settings.ingestionYoutubeAutoEnqueueEnabled = legacyEnrich.ingestionYoutubeAutoEnrichEnabled;
			}
			delete legacyEnrich.ingestionYoutubeAutoEnrichEnabled;
			dirty = true;
		}

		// Fold the sprint-era `orchestrationJobTypeAutorun` boolean map into the
		// per-type controls map (one-shot: the old map existed for a single
		// unreleased sprint), seeding the enrichment type's auto-run (drain) from the
		// legacy combined flag so existing users keep their current behavior. Explicit
		// choices already in the controls map are preserved.
		const legacyAutorun = this.settings as CrucibleSettings & { orchestrationJobTypeAutorun?: unknown };
		const migratedControls = migrateJobTypeControls(
			this.settings.orchestrationJobTypeControls,
			legacyAutorun.orchestrationJobTypeAutorun,
			this.settings.ingestionYoutubeAutoEnqueueEnabled === true,
		);
		if ('orchestrationJobTypeAutorun' in legacyAutorun
			|| JSON.stringify(migratedControls) !== JSON.stringify(this.settings.orchestrationJobTypeControls)) {
			this.settings.orchestrationJobTypeControls = migratedControls;
			delete legacyAutorun.orchestrationJobTypeAutorun;
			dirty = true;
		}

		for (const agent of this.settings.agents) {
			if (!agent.executionMode) {
				agent.executionMode = 'read-only';
				dirty = true;
			}
			if (agent.requireNormalFinishReason === undefined) {
				agent.requireNormalFinishReason = true;
				dirty = true;
			}
			// The one place a persisted `modelBinding` crosses into the typed
			// `AgentModelBinding` union. Legacy JSON can hold a mode tag with no payload, or
			// stale pinned data left behind by the old in-place mode mutation; normalizing here
			// means nothing downstream has to defend against either. Total and conservative —
			// see `normalizeAgentBinding`'s doc comment.
			const normalizedBinding = normalizeAgentBinding(agent.modelBinding);
			if (JSON.stringify(normalizedBinding) !== JSON.stringify(agent.modelBinding)) {
				agent.modelBinding = normalizedBinding;
				dirty = true;
			}
		}

		for (const provider of this.settings.providers) {
			const legacy = provider as Provider & { cliLogEnabled?: boolean; cliLogDirectory?: string };
			if ('cliLogEnabled' in legacy) {
				if (provider.cliRunArtifactsEnabled === undefined) {
					provider.cliRunArtifactsEnabled = legacy.cliLogEnabled;
				}
				delete legacy.cliLogEnabled;
				dirty = true;
			}
			if ('cliLogDirectory' in legacy) {
				if (provider.cliRunDirectory === undefined && legacy.cliLogDirectory) {
					provider.cliRunDirectory = legacy.cliLogDirectory;
				}
				delete legacy.cliLogDirectory;
				dirty = true;
			}
		}

		if (dirty) await this.saveSettings();
	}

	registerAgents() {
		this.agentManager.registerAgents();
		this.clearCommandRegistryGroup('Agents');
		for (const agent of this.settings.agents) {
			if (!agent.id) continue;
			this.commandRegistry.push({
				id: agentCommandId(agent.id),
				name: `Agent: ${agent.name || '(unnamed)'}`,
				group: 'Agents',
				mutating: true,
				// Agents self-register a chain-internal command under this exact id.
				queueable: true,
			});
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * A vault-adapter path inside this plugin's own data directory (where `data.json` lives) —
	 * i.e. `.obsidian/plugins/<id>/<name>`. Nothing written here is part of the vault's note
	 * tree, so it is invisible to Obsidian's indexer and to Crucible's own search leg.
	 * `manifest.dir` is populated by Obsidian for a normally-installed plugin; the fallback
	 * reconstructs the same path from `vault.configDir` for the cases where it is not.
	 */
	pluginDataPath(filename: string): string {
		const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		return `${dir}/${filename}`;
	}

	/**
	 * Wraps `app.vault.adapter` to satisfy `ImageDescriptionStorage` (`src/search/
	 * imageDescriptionStore.ts`): nullable `read` instead of a throw-on-missing, `list` returning
	 * bare file paths instead of `{files, folders}`, and a lazy, once-per-session `mkdir` of
	 * `baseDir` before the first write (the store itself never creates directories — see its
	 * module doc). `baseDir` is threaded in rather than re-derived from `filename` on every call
	 * so the mkdir memoization has a single stable key.
	 */
	private createImageDescriptionStorage(baseDir: string): ImageDescriptionStorage {
		const adapter = this.app.vault.adapter;
		let ensureBaseDir: Promise<void> | null = null;
		const ensureDir = (): Promise<void> => {
			if (!ensureBaseDir) {
				ensureBaseDir = (async () => {
					if (!(await adapter.exists(baseDir))) await adapter.mkdir(baseDir);
				})();
			}
			return ensureBaseDir;
		};
		return {
			async read(path) {
				if (!(await adapter.exists(path))) return null;
				return await adapter.read(path);
			},
			async write(path, data) {
				await ensureDir();
				await adapter.write(path, data);
			},
			async exists(path) {
				return await adapter.exists(path);
			},
			async remove(path) {
				if (await adapter.exists(path)) await adapter.remove(path);
			},
			async list(dir) {
				if (!(await adapter.exists(dir))) return [];
				return (await adapter.list(dir)).files;
			},
		};
	}

	// Set a per-type auto-run (drain/execution) flag, persist it, and kick a drain
	// when enabling so the change takes effect immediately. Turning it off leaves any
	// in-flight worker to finish its current job, then the type goes idle (the drain
	// loop re-checks the gate each iteration). Uniform for every type, enrichment
	// included — auto-enqueue (source) is a separate control (setEnrichmentAutoEnqueue).
	async setJobTypeAutorun(type: JobType, enabled: boolean): Promise<void> {
		this.settings.orchestrationJobTypeControls = setTypeControl(this.settings.orchestrationJobTypeControls, type, { autoRun: enabled });
		await this.saveSettings();
		if (enabled) this.orchestrationAutoRunner?.kickDrainType(type);
	}

	// Set or clear (ms === undefined) a per-type rate-limit override. The drain loop
	// reads it live before each job start, so persisting is all that's needed.
	async setJobTypeMinInterval(type: JobType, ms: number | undefined): Promise<void> {
		this.settings.orchestrationJobTypeControls = setTypeControl(this.settings.orchestrationJobTypeControls, type, { minIntervalMsOverride: ms });
		await this.saveSettings();
	}

	// Set or clear (workers === undefined) a per-type worker-count override. Same shape
	// as the rate override on purpose: the drain loop reads it live when it starts a
	// drain, so persisting is all that's needed — no re-registration, no restart. A
	// type declaring `maxParallelFixed` ignores it (resolveMaxParallel), and the global
	// orchestrationMaxConcurrent semaphore still caps total in-flight work.
	async setJobTypeMaxParallel(type: JobType, workers: number | undefined): Promise<void> {
		this.settings.orchestrationJobTypeControls = setTypeControl(this.settings.orchestrationJobTypeControls, type, { maxParallelOverride: workers });
		await this.saveSettings();
		this.orchestrationAutoRunner?.kickDrainType(type);
	}

	// Auto-ENQUEUE (source) control for enrichment: whether metadata jobs are
	// automatically created (the capture event trigger and the Uncaptured Videos
	// auto-source both read this flag). This is ORTHOGONAL to draining — executing
	// queued jobs is governed by the youtube_metadata_fetch per-type auto-run flag
	// (setJobTypeAutorun). Enqueueing a type does not force it to drain. The
	// auto-source is dashboard-owned (its items follow the dashboard's sort order),
	// so it is only pushed when the caller has one; other callers leave it alone.
	async setEnrichmentAutoEnqueue(enabled: boolean, autoSource?: AutoSourceFn): Promise<void> {
		this.settings.ingestionYoutubeAutoEnqueueEnabled = enabled;
		await this.saveSettings();
		this.orchestrator?.setAutoSourceEnabled(ENRICHMENT_JOB_TYPE, enabled);
		if (enabled && autoSource) this.orchestrator?.setAutoSource(ENRICHMENT_JOB_TYPE, autoSource);
	}

	/**
	 * Every job type the queue knows about, in one place.
	 *
	 * Extracted from `onload` (thq WP-8) so the whole block can sit inside one
	 * try/catch: the first `register` call is what opens the jobs database, and an
	 * unopenable database throws out of it. See the call site for why that failure is
	 * caught and scoped rather than allowed to abort plugin load.
	 */
	private registerJobTypes(): void {
		this.orchestrator.register('daily_brief_lite', new DailyBriefLiteWorkflow());
		this.orchestrator.register('transcript_refine', new TranscriptRefinerWorkflow(), transcriptRefineJobConfig());
		this.orchestrator.register('youtube_tracker', new YoutubeTrackerWorkflow(), youtubeTrackerJobConfig());
		this.orchestrator.register('youtube_tracker_consolidate', new YoutubeTrackerConsolidateWorkflow());
		this.orchestrator.register('blogs_tracker', new BlogsTrackerWorkflow());
		this.orchestrator.register('blogs_tracker_consolidate', new BlogsTrackerConsolidateWorkflow());
		this.orchestrator.register('link_scan', new LinkScanWorkflow());
		this.orchestrator.register('youtube_metadata_fetch', new YoutubeMetadataFetchWorkflow(), youtubeMetadataJobConfig(this));
		this.orchestrator.register('youtube_channel_enrich', new YoutubeChannelEnrichWorkflow(), youtubeChannelEnrichJobConfig(this));
		this.orchestrator.register('youtube_channel_enrich_sweep', new YoutubeChannelEnrichSweepWorkflow(), youtubeChannelEnrichSweepJobConfig());
		this.orchestrator.register('x_metadata_fetch', new XMetadataFetchWorkflow(), xMetadataFetchJobConfig());
		this.orchestrator.register('x_post_discover', new XPostDiscoverWorkflow(), xPostDiscoverJobConfig());
		this.orchestrator.register('command_run', new CommandRunWorkflow(), commandRunJobConfig());
		this.orchestrator.register('chain_run', new ChainRunWorkflow(), chainRunJobConfig());
		this.orchestrator.register('image_describe_note', new ImageDescribeNoteWorkflow(), imageDescribeNoteJobConfig());
		this.orchestrator.register('image_describe_backfill', new ImageDescribeBackfillWorkflow(), imageDescribeBackfillJobConfig());
		this.orchestrator.register('image_describe_batch', new ImageDescribeBatchWorkflow(), imageDescribeBatchJobConfig());
		this.orchestrator.register('search_rebuild', new SearchRebuildWorkflow(), searchRebuildJobConfig());
		this.orchestrator.register('search_embed_missing', new SearchEmbedMissingWorkflow(), searchEmbedMissingJobConfig());
		this.orchestrator.register('search_upsert_file', new SearchUpsertFileWorkflow(), searchFileJobConfig());
		this.orchestrator.register('search_upsert_batch', new SearchUpsertBatchWorkflow(), searchBatchJobConfig());
		this.orchestrator.register('search_delete_path', new SearchDeletePathWorkflow(), searchFileJobConfig());
		this.orchestrator.register('search_sweep', new SearchSweepWorkflow(), searchSweepJobConfig());
	}

	// One-shot migration for the removed global Autorun master: if it was on, its
	// effect folds into the per-type auto-run flags — seed autoRun:true for every type
	// without an explicit flag so previously-draining types keep draining. Runs after
	// the backends register (needs the type list); persists only if something changed.
	private async migrateGlobalAutorun(): Promise<void> {
		const legacy = this.settings as CrucibleSettings & { orchestrationQueueAutorunEnabled?: unknown };
		if (!('orchestrationQueueAutorunEnabled' in legacy)) return;
		if (legacy.orchestrationQueueAutorunEnabled === true) {
			for (const type of this.orchestrator.jobTypes()) {
				if (this.orchestrator.drainsWithoutAutorun(type)) continue;
				if (readTypeAutorun(this.settings.orchestrationJobTypeControls, type) === undefined) {
					this.settings.orchestrationJobTypeControls = setTypeControl(this.settings.orchestrationJobTypeControls, type, { autoRun: true });
				}
			}
		}
		delete legacy.orchestrationQueueAutorunEnabled;
		await this.saveSettings();
	}

	refreshToC() {
		if (this.tocComponent) { this.tocComponent.unload(); this.tocComponent = null; }
		if (!this.settings.showToC) return;
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView) {
			this.tocComponent = new TableOfContentsUI(this.app, activeView, this.settings.tocPosition, this.settings.tocCollapseBehavior);
			this.tocComponent.load();
		}
	}

	registerShortcuts() {
		this.clearCommandRegistryGroup('Shortcuts');
		this.settings.shortcuts.forEach((shortcut, index) => {
			if (!shortcut.name || !shortcut.file) return;
			const id = `shortcut-${index}`;
			this.registerCrucibleCommand({
				id,
				name: `Shortcut: ${shortcut.name}`,
				group: 'Shortcuts',
				run: async () => {
					const file = this.app.vault.getAbstractFileByPath(shortcut.file);
					if (file instanceof TFile) await this.app.workspace.getLeaf().openFile(file);
				},
			});
		});
	}

	registerMoveFileCommands(prefix: string): void {
		registerMoveFileCommandsImpl(this, prefix);
	}

	registerCaptures() {
		registerCapturesImpl(this);
	}

	async promptForText(title: string): Promise<string | null> {
		return promptForTextImpl(this, title);
	}

	// Load user-defined triggers from settings into the engine. Mirrors registerChains():
	// call on load and after any trigger edit so the live registry tracks settings.
	//
	// Defense-in-depth (thq WP-2): the settings UI already gates the Enable toggle on
	// validateTrigger, but a hand-edited data.json can still carry an invalid-yet-
	// enabled def (a deleted chain, a blank chainName like the trigger-storm incident).
	// Filter every def through the same validator here before it ever reaches the
	// adapter/registry — an invalid def is skipped (not rewritten, not deleted, its
	// `enabled` flag untouched on disk) with a logWarn naming the first error.
	registerTriggers() {
		const ctx: TriggerValidationCtx = {
			chainNames: this.settings.chains.map(c => c.name),
			hasInternalCommand: (id) => this.chainManager.hasInternalCommand(id),
			knownJobTypes: this.orchestrator.jobTypes(),
			folderExists: (folder) => this.app.vault.getAbstractFileByPath(folder) instanceof TFolder,
		};
		const validDefs = this.settings.triggers.filter(def => {
			const { errors } = validateTrigger(def, ctx);
			if (errors.length > 0) {
				logWarn('trigger', def.id, errors[0]);
				return false;
			}
			return true;
		});
		this.triggers.setUserTriggers(validDefs);
	}

	registerChains() {
		this.clearCommandRegistryGroup('Chains');
		// Drop the previous chain-internal registrations so reordered/deleted chains
		// don't leave stale ids resolving to the wrong chain.
		const prefix = this.manifest.id;
		for (const id of this.registeredChainInternalIds) this.chainManager.unregisterInternalCommand(id);
		this.registeredChainInternalIds.clear();
		this.settings.chains.forEach((chain, index) => {
			if (!chain.name) return;
			const id = `chain-${index}`;
			this.registerCrucibleCommand({
				id,
				name: `Chain: ${chain.name}`,
				group: 'Chains',
				mutating: chain.mutating !== false,
				run: () => {
					const editor = this.activeEditor();
					// Capture the active file at invocation time so async steps never
					// accidentally target a different note if the user navigates away.
					const spawnFile = this.app.workspace.getActiveFile() ?? undefined;
					return this.chainManager.executeChain(chain, editor, spawnFile);
				},
			});
			// Also expose the chain as a chain-internal command so a nested chain step
			// runs awaited, on the parent's target note, inside the (reentrant) note
			// lock — instead of fire-and-forget on the active note via executeCommandById.
			const runNested = async (_a: Record<string, string>, _p: unknown, editor?: Editor, targetFile?: TFile) => {
				const file = targetFile ?? this.app.workspace.getActiveFile() ?? undefined;
				await this.chainManager.executeChain(chain, editor, file);
				return true;
			};
			for (const fullId of [`${prefix}:${id}`, `crucible:${id}`]) {
				this.chainManager.registerInternalCommand(fullId, runNested);
				this.registeredChainInternalIds.add(fullId);
			}
		});
	}

	async activateSettingsView(initialTab?: CrucibleSettingsTab) {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(CRUCIBLE_SETTINGS_VIEW_TYPE);
		const leaf = existing[0] ?? workspace.getLeaf('tab');
		if (!existing.length) {
			await leaf.setViewState({ type: CRUCIBLE_SETTINGS_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		if (initialTab && leaf.view instanceof CrucibleSettingsView) leaf.view.openToTab(initialTab);
	}

	/**
	 * WP-9: the one entry point a caller outside settings.ts/main.ts uses to open Crucible
	 * settings landed on a specific tab (first consumer: the search modal's rerank
	 * Configure… link). Deliberately reuses the two "open settings" paths that already exist
	 * rather than inventing a third: if the workspace-tab settings view (`Open settings in a
	 * tab`, activateSettingsView()) is already open, deep-link that leaf; otherwise fall back
	 * to the ribbon icon's native-settings-modal path (`app.setting.open()` +
	 * `openTabById`), deep-linking the single registered `settingTab` instance before it's
	 * shown.
	 */
	openSettingsToTab(tab: CrucibleSettingsTab): void {
		const existing = this.app.workspace.getLeavesOfType(CRUCIBLE_SETTINGS_VIEW_TYPE);
		if (existing.length > 0) {
			void this.activateSettingsView(tab);
			return;
		}
		this.settingTab.openToTab(tab);
		this.app.setting.open();
		this.app.setting.openTabById(this.manifest.id);
	}

	async activateIngestionDashboardView() {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(INGESTION_DASHBOARD_VIEW_TYPE);
		const leaf = existing[0] ?? workspace.getLeaf('tab');
		if (!existing.length) {
			await leaf.setViewState({ type: INGESTION_DASHBOARD_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	async activateSourceEvalDashboardView() {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(SOURCE_EVAL_DASHBOARD_VIEW_TYPE);
		const leaf = existing[0] ?? workspace.getLeaf('tab');
		if (!existing.length) {
			await leaf.setViewState({ type: SOURCE_EVAL_DASHBOARD_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	openDayPicker() {
		openDayPicker(this);
	}

	openWeekPicker() {
		openWeekPicker(this);
	}

	openMonthPicker() {
		openMonthPicker(this);
	}

	async handleFileCreate(file: TAbstractFile) {
		if (this.isMaterializing || !(file instanceof TFile) || file.extension !== 'md') return;

		// vf-1: auto-localize scheduling on create moved to a listener registered inside
		// onLayoutReady (see the comment there) so Obsidian's startup create-replay never
		// reaches it. Don't re-add a `this.autoLocalizeScheduler.schedule(file, 'create')`
		// call here — that's exactly the regression this fix removed.

		// CRITICAL: Only proceed if the file is truly empty to avoid overwriting existing notes on startup
		if (file.stat.size > 0) return;

		const parentPath = file.parent?.path || '';
		const fileName = file.basename;

		if (await handlePeriodFileCreate(this, file, parentPath, fileName, 'daily')) return;
		if (await handlePeriodFileCreate(this, file, parentPath, fileName, 'weekly')) return;
		if (await handlePeriodFileCreate(this, file, parentPath, fileName, 'monthly')) return;

		const mapping = this.settings.folderTemplates.find(ft => ft.folder === parentPath);
		if (mapping && mapping.template) {
			this.isMaterializing = true;
			try {
				const templateFile = this.app.vault.getAbstractFileByPath(mapping.template);
				if (templateFile instanceof TFile) {
					const templateContent = await this.app.vault.read(templateFile);
					const content = await applyTemplateString(templateContent, window.moment(), fileName);
					await this.app.vault.modify(file, content);
				}
			} catch (e) {
				new Notice(`Error applying folder template: ${(e as Error).message}`);
			} finally {
				this.isMaterializing = false;
			}
		}
	}
}
