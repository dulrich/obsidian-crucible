import { App, Plugin, TFile, MarkdownView, Notice, debounce, TAbstractFile, Modal, TFolder, Editor, normalizePath } from 'obsidian';
import { CrucibleSettingTab } from "./settings";
import { CrucibleSettings, DEFAULT_SETTINGS, Capture, CommandArgSchema, Provider, providerModality } from "./types";
import { Materializer } from "./materialize";
import { Linter } from "./lint";
import { AttachmentLocalizer } from "./localizeAttachments";
import { CaptureExecutionContext, CaptureManager, TextInputModal } from "./captures";
import { ChainCommandOptions, ChainManager, chainStepResult } from "./chains";
import { ProviderManager } from "./providers";
import { AgentManager, agentCommandId } from "./agents";
import { TableOfContentsUI } from "./toc";
import { applyTemplateString, ensureFolder, FRONTMATTER_REGEX } from './utils';
import { MoveFileFolderPickerModal, normalizeFolderPath } from './folderPicker';
import { PeriodId, getCurrentPeriodAssetFolder, getPeriodConfig, periodDisabledMessage } from './periods';
import { normalizeFrontmatterPropertyName, parseTagList, updateFrontmatter, upsertFrontmatterProperty, upsertFrontmatterTags, withMaterializing } from './frontmatter';
import { JobStore } from './orchestration/JobStore';
import { Orchestrator } from './orchestration/Orchestrator';
import { DailyBriefLiteWorkflow } from './orchestration/workflows/DailyBriefLiteWorkflow';
import { TranscriptRefinerWorkflow } from './orchestration/workflows/TranscriptRefinerWorkflow';
import {
	BlogsTrackerConsolidateWorkflow,
	BlogsTrackerWorkflow,
	YoutubeTrackerConsolidateWorkflow,
	YoutubeTrackerWorkflow,
} from './orchestration/workflows/FeedTrackerWorkflow';
import { ingestYoutubeVideoMetadata, isYtMetadataLinked } from './orchestration/utils/youtubeApi';
import { LinkScanWorkflow } from './orchestration/workflows/LinkScanWorkflow';
import { YoutubeMetadataFetchWorkflow } from './orchestration/workflows/YoutubeMetadataFetchWorkflow';
import { CrucibleSettingsView, CRUCIBLE_SETTINGS_VIEW_TYPE } from './settingsView';
import { IngestionDashboardView, INGESTION_DASHBOARD_VIEW_TYPE } from './ingestionDashboardView';
import { IngestionEventBus } from './orchestration/events';
import { NoteLockManager } from './orchestration/NoteLockManager';
import { NoteLockOverlay } from './noteLockOverlay';
import { EnrichmentQueueAdapter } from './orchestration/EnrichmentQueueAdapter';
import { commandRunJobConfig, imageMetadataJobConfig, searchBatchJobConfig, searchFileJobConfig, searchRebuildJobConfig, searchSweepJobConfig, transcriptRefineJobConfig, youtubeMetadataJobConfig } from './orchestration/jobTypeConfig';
import { CommandRunWorkflow } from './orchestration/workflows/CommandRunWorkflow';
import { ImageMetadataExtractWorkflow } from './orchestration/workflows/ImageMetadataExtractWorkflow';
import { OrchestrationAutoRunner } from './orchestration/OrchestrationAutoRunner';
import { TriggerRegistry } from './orchestration/TriggerRegistry';
import { registerStaticCommands } from './commands';
import { SearchManager } from './search/SearchManager';
import { SearchIndexCoordinator } from './search/SearchIndexCoordinator';
import { SearchDeletePathWorkflow, SearchRebuildWorkflow, SearchSweepWorkflow, SearchUpsertBatchWorkflow, SearchUpsertFileWorkflow } from './orchestration/workflows/SearchIndexWorkflow';
import { migrateExcludedFolders } from './exclusions';
import { localizedImageInfo } from './orchestration/utils/imageMetadata';
import { logError } from './log';

export type CrucibleCommandGroup =
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
}

type CrucibleCommandRunner = () => Promise<unknown>;

type AutoLocalizeSource = 'create' | 'edit';

interface AutoLocalizeState {
	path: string;
	sources: Set<AutoLocalizeSource>;
	firstScheduledAt: number;
	attempts: number;
	timer: ReturnType<typeof setTimeout> | null;
}

const AUTO_LOCALIZE_CREATE_DELAY_MS = 2500;
const AUTO_LOCALIZE_EDIT_DELAY_MS = 3000;
const AUTO_LOCALIZE_RETRY_DELAY_MS = 1000;
const AUTO_LOCALIZE_MAX_AGE_MS = 15000;

export default class CruciblePlugin extends Plugin {
	settings: CrucibleSettings;
	linter: Linter;
	attachmentLocalizer: AttachmentLocalizer;
	commandRegistry: CrucibleCommandEntry[] = [];
	private commandRunners = new Map<string, CrucibleCommandRunner>();
	private isMaterializing = false;
	private materializer: Materializer;
	private captureManager: CaptureManager;
	chainManager: ChainManager;
	providerManager: ProviderManager;
	agentManager: AgentManager;
	jobStore: JobStore;
	orchestrator: Orchestrator;
	ingestionEvents: IngestionEventBus;
	noteLocks: NoteLockManager;
	private noteLockOverlay: NoteLockOverlay;
	enrichmentQueue: EnrichmentQueueAdapter;
	searchManager: SearchManager;
	searchIndexCoordinator: SearchIndexCoordinator;
	orchestrationAutoRunner: OrchestrationAutoRunner;
	triggers: TriggerRegistry;
	private tocComponent: TableOfContentsUI | null = null;
	// Chain-internal command ids registered for each "Chain: X" command, so a chain
	// can be used as an (awaited, target-file-aware) step inside another chain.
	// Cleared and rebuilt on every registerChains() so renames/deletes don't leak.
	private registeredChainInternalIds = new Set<string>();
	private autoLocalizeTimers = new Map<string, AutoLocalizeState>();

	async onload() {
		await this.loadSettings();

		this.ingestionEvents = new IngestionEventBus();
		this.noteLocks = new NoteLockManager(this.ingestionEvents);
		this.materializer = new Materializer(this.app, this.settings, (state: boolean) => { this.isMaterializing = state; });
		this.linter = new Linter(this.app, this.settings, (state: boolean) => { this.isMaterializing = state; }, this.noteLocks);
		this.attachmentLocalizer = new AttachmentLocalizer(
			this.app,
			this.settings,
			this.linter,
			(state: boolean) => { this.isMaterializing = state; },
			this.noteLocks,
			(imagePath, sourceNotePath) => this.enqueueImageMetadataExtraction(imagePath, sourceNotePath),
		);
		this.captureManager = new CaptureManager(this.app, this.settings, (state: boolean) => { this.isMaterializing = state; });
		this.chainManager = new ChainManager(this.app, this.noteLocks);
		this.providerManager = new ProviderManager(this.app);
		this.searchManager = new SearchManager(this.app, this.settings, this.providerManager);
		this.searchIndexCoordinator = new SearchIndexCoordinator(this, () => this.isMaterializing);
		this.agentManager = new AgentManager(this.app, this.settings, this.chainManager, this.providerManager);
		this.jobStore = new JobStore(this);
		this.orchestrator = new Orchestrator(this, this.jobStore);
		this.orchestrator.register('daily_brief_lite', new DailyBriefLiteWorkflow());
		this.orchestrator.register('transcript_refine', new TranscriptRefinerWorkflow(), transcriptRefineJobConfig());
		this.orchestrator.register('youtube_tracker', new YoutubeTrackerWorkflow());
		this.orchestrator.register('youtube_tracker_consolidate', new YoutubeTrackerConsolidateWorkflow());
		this.orchestrator.register('blogs_tracker', new BlogsTrackerWorkflow());
		this.orchestrator.register('blogs_tracker_consolidate', new BlogsTrackerConsolidateWorkflow());
		this.orchestrator.register('link_scan', new LinkScanWorkflow());
		this.orchestrator.register('youtube_metadata_fetch', new YoutubeMetadataFetchWorkflow(), youtubeMetadataJobConfig(this));
		this.orchestrator.register('command_run', new CommandRunWorkflow(), commandRunJobConfig());
		this.orchestrator.register('image_metadata_extract', new ImageMetadataExtractWorkflow(), imageMetadataJobConfig());
		this.orchestrator.register('search_rebuild', new SearchRebuildWorkflow(), searchRebuildJobConfig());
		this.orchestrator.register('search_upsert_file', new SearchUpsertFileWorkflow(), searchFileJobConfig());
		this.orchestrator.register('search_upsert_batch', new SearchUpsertBatchWorkflow(), searchBatchJobConfig());
		this.orchestrator.register('search_delete_path', new SearchDeletePathWorkflow(), searchFileJobConfig());
		this.orchestrator.register('search_sweep', new SearchSweepWorkflow(), searchSweepJobConfig());
		this.enrichmentQueue = new EnrichmentQueueAdapter(this);
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
		this.triggers.start();

		this.registerInternalCommands();
		this.registerAgents();
		this.registerChains();

		this.registerView(CRUCIBLE_SETTINGS_VIEW_TYPE, (leaf) => new CrucibleSettingsView(leaf, this));
		this.registerView(INGESTION_DASHBOARD_VIEW_TYPE, (leaf) => new IngestionDashboardView(leaf, this));
		this.registerEvent(this.app.metadataCache.on('resolved', () => {
			this.searchIndexCoordinator.markMetadataResolved();
		}));
		this.app.workspace.onLayoutReady(() => {
			this.searchIndexCoordinator.markLayoutReady();
			void this.orchestrator.scan({ notify: false });
		});

		this.addRibbonIcon('anvil', 'Crucible settings', () => {
			this.app.setting.open();
			this.app.setting.openTabById(this.manifest.id);
		});

		// --- Commands ---
		registerStaticCommands(this);

		// --- Events ---
		this.registerEvent(this.app.vault.on('create', (file) => {
			void this.handleFileCreate(file);
			this.searchIndexCoordinator.handleCreate(file);
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

		this.register(() => this.clearAutoLocalizeTimers());
		this.register(() => this.searchIndexCoordinator.dispose());

		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file instanceof TFile && file.extension === 'md') {
				debouncedLint(file);
				this.scheduleAutoLocalize(file, 'edit');
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
				this.moveAutoLocalizeTimer(oldPath, file.path);
				void this.attachmentLocalizer.onNoteRename(file, oldPath);
			}
			this.searchIndexCoordinator.handleRename(file, oldPath);
		}));

		this.registerEvent(this.app.vault.on('delete', (file) => {
			const pending = this.autoLocalizeTimers.get(file.path);
			if (pending?.timer) clearTimeout(pending.timer);
			this.autoLocalizeTimers.delete(file.path);
			void this.attachmentLocalizer.onNoteDelete(file.path);
			this.searchIndexCoordinator.handleDelete(file.path);
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
		this.addSettingTab(new CrucibleSettingTab(this.app, this));

		this.noteLockOverlay = new NoteLockOverlay(this);

		this.refreshToC();
	}

	onunload() {
		if (this.tocComponent) this.tocComponent.unload();
		this.noteLockOverlay?.dispose();
		this.triggers?.dispose();
		this.orchestrationAutoRunner?.dispose();
		this.enrichmentQueue?.dispose();
		this.ingestionEvents?.dispose();
	}

	activeEditor(): Editor | undefined {
		return this.app.workspace.getActiveViewOfType(MarkdownView)?.editor ?? undefined;
	}

	private scheduleAutoLocalize(
		file: TFile,
		source: AutoLocalizeSource,
		delayMs: number = source === 'create' ? AUTO_LOCALIZE_CREATE_DELAY_MS : AUTO_LOCALIZE_EDIT_DELAY_MS,
	): void {
		if (file.extension !== 'md') return;
		if (!this.autoLocalizeSourceEnabled(source)) return;

		const existing = this.autoLocalizeTimers.get(file.path);
		const state: AutoLocalizeState = existing ?? {
			path: file.path,
			sources: new Set<AutoLocalizeSource>(),
			firstScheduledAt: Date.now(),
			attempts: 0,
			timer: null,
		};
		state.path = file.path;
		state.sources.add(source);
		this.scheduleAutoLocalizeState(state, delayMs);
	}

	private scheduleAutoLocalizeState(state: AutoLocalizeState, delayMs: number): void {
		if (state.timer) clearTimeout(state.timer);
		this.autoLocalizeTimers.set(state.path, state);
		state.timer = setTimeout(() => {
			state.timer = null;
			void this.runScheduledAutoLocalize(state);
		}, delayMs);
	}

	private async runScheduledAutoLocalize(state: AutoLocalizeState): Promise<void> {
		this.autoLocalizeTimers.delete(state.path);
		if (!this.autoLocalizeSourcesEnabled(state)) return;

		const current = this.app.vault.getAbstractFileByPath(state.path);
		if (!(current instanceof TFile) || current.extension !== 'md') return;

		if (current.stat.size === 0 || this.noteLocks.isLocked(current.path) || this.isMaterializing) {
			if (Date.now() - state.firstScheduledAt <= AUTO_LOCALIZE_MAX_AGE_MS) {
				state.path = current.path;
				state.attempts += 1;
				this.scheduleAutoLocalizeState(state, AUTO_LOCALIZE_RETRY_DELAY_MS);
			}
			return;
		}

		await this.attachmentLocalizer.localizeNote(current, true);
	}

	private autoLocalizeSourceEnabled(source: AutoLocalizeSource): boolean {
		return source === 'create'
			? this.settings.localizeAttachmentsTriggerOnCreate
			: this.settings.localizeAttachmentsTriggerOnEdit;
	}

	private autoLocalizeSourcesEnabled(state: AutoLocalizeState): boolean {
		return Array.from(state.sources).some(source => this.autoLocalizeSourceEnabled(source));
	}

	private moveAutoLocalizeTimer(oldPath: string, newPath: string): void {
		const state = this.autoLocalizeTimers.get(oldPath);
		if (!state) return;
		this.autoLocalizeTimers.delete(oldPath);
		state.path = newPath;
		this.scheduleAutoLocalizeState(state, AUTO_LOCALIZE_RETRY_DELAY_MS);
	}

	private clearAutoLocalizeTimers(): void {
		for (const state of this.autoLocalizeTimers.values()) {
			if (state.timer) clearTimeout(state.timer);
		}
		this.autoLocalizeTimers.clear();
	}

	enqueueImageMetadataExtraction(imagePath: string, sourceNotePath?: string): void {
		if (!this.canEnqueueImageMetadataExtraction()) return;
		if (!localizedImageInfo(imagePath)) return;
		const inputPaths = [imagePath, sourceNotePath].filter((p): p is string => typeof p === 'string' && p.length > 0);
		void this.orchestrator.enqueue('image_metadata_extract', {
			imagePath,
			sourceNotePath,
			schemaVersion: this.settings.imageMetadataExtractionSchemaVersion,
		}, { priority: 'low', lane: 'background', inputPaths });
	}

	private canEnqueueImageMetadataExtraction(): boolean {
		if (!this.settings.imageMetadataExtractionEnabled) return false;
		const ref = this.settings.imageMetadataExtractionModel;
		if (!ref) return false;
		const provider = this.settings.providers.find(p => p.id === ref.providerId);
		if (!provider || providerModality(provider.kind) === 'cli') return false;
		const model = provider.models.find(m => m.id === ref.modelId);
		return model?.capabilities?.includes('image-extraction') === true;
	}

	// Code-defined triggers (queue-first design): each one only ENQUEUES jobs, so
	// triggered work inherits queue semantics — dedupe, pacing, timeout, note locks.
	// Settings → Orchestrate → Triggers exposes per-trigger enable toggles.
	private registerFoundingTriggers(): void {
		this.triggers.register({
			id: 'yt-metadata-on-capture',
			description: 'When a note gains a yt-video-id without a yt-metadata link, enqueue a per-note metadata fetch.',
			on: { event: 'metadata-changed' },
			enabled: () => this.settings.ingestionYoutubeAutoEnrichEnabled,
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
		mutating?: boolean;
		queueable?: boolean;
	}): void {
		// A command is queueable when a chain-internal twin exists at registration
		// time (built-ins register internals first in onload; captures/chains register
		// theirs immediately before this call).
		const queueable = opts.queueable
			?? (this.chainManager.hasInternalCommand(`${this.manifest.id}:${opts.id}`)
				|| this.chainManager.hasInternalCommand(`crucible:${opts.id}`));
		this.commandRegistry.push({ id: opts.id, name: opts.name, group: opts.group, mutating: opts.mutating ?? true, queueable });
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

	private clearCommandRegistryGroup(group: CrucibleCommandGroup): void {
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

		for (const agent of this.settings.agents) {
			if (!agent.executionMode) {
				agent.executionMode = 'read-only';
				dirty = true;
			}
			if (agent.requireNormalFinishReason === undefined) {
				agent.requireNormalFinishReason = true;
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
		const moveDailyId = 'move-current-file-to-daily-folder';
		const moveFolderId = 'move-current-file-to-folder';

		const wrapMoveResult = (moved: TFile | null) => moved ? chainStepResult(true, moved) : false;
		const moveDaily = async (_args: Record<string, string>, _prev: unknown, _editor?: Editor, targetFile?: TFile) => {
			if (!this.settings.dailyEnabled) {
				new Notice(periodDisabledMessage('daily'));
				return false;
			}
			return wrapMoveResult(await this.moveFileToFolder(getCurrentPeriodAssetFolder(this.settings, 'daily'), targetFile));
		};
		const moveFolder = async (args: Record<string, string>, _prev: unknown, _editor?: Editor, targetFile?: TFile) => {
			const folder = args.folder?.trim();
			const moved = folder
				? await this.moveFileToFolder(folder, targetFile)
				: await this.openMoveFileFolderPicker(targetFile);
			return wrapMoveResult(moved);
		};
		const moveFolderSchema: CommandArgSchema[] = [
			{
				id: 'folder',
				name: 'Destination folder',
				type: 'folder',
				description: 'Folder to move the current file into. Leave empty to show the folder picker.',
			},
		];

		for (const id of [`${prefix}:${moveDailyId}`, `crucible:${moveDailyId}`]) {
			this.chainManager.registerInternalCommand(id, moveDaily);
		}
		for (const id of [`${prefix}:${moveFolderId}`, `crucible:${moveFolderId}`]) {
			this.chainManager.registerInternalCommand(id, moveFolder, moveFolderSchema);
		}

		this.registerCrucibleCommand({
			id: moveDailyId,
			name: 'Move current file to daily folder',
			group: 'Files',
			available: () => this.app.workspace.getActiveFile() !== null,
			run: () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) return;
				if (!this.settings.dailyEnabled) {
					new Notice(periodDisabledMessage('daily'));
					return;
				}
				return this.moveFileToFolder(getCurrentPeriodAssetFolder(this.settings, 'daily'), activeFile);
			},
		});

		this.registerCrucibleCommand({
			id: moveFolderId,
			name: 'Move current file to folder...',
			group: 'Files',
			available: () => this.app.workspace.getActiveFile() !== null,
			run: () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile) return this.openMoveFileFolderPicker(activeFile);
				return null;
			},
		});
	}

	private async openMoveFileFolderPicker(targetFile?: TFile): Promise<TFile | null> {
		const file = targetFile ?? this.app.workspace.getActiveFile();
		if (!file) {
			new Notice('No active file to move.');
			return null;
		}

		return await new Promise<TFile | null>((resolve) => {
			new MoveFileFolderPickerModal(
				this.app,
				this.settings,
				async (folderPath) => {
					resolve(await this.moveFileToFolder(folderPath, file));
				},
				() => resolve(null),
			).open();
		});
	}

	private async moveFileToFolder(folderPath: string, targetFile?: TFile): Promise<TFile | null> {
		try {
			const file = targetFile ?? this.app.workspace.getActiveFile();
			if (!file) {
				new Notice('No active file to move.');
				return null;
			}

			return await this.noteLocks.withLock(file.path, 'move-file', async () => {
				const normalizedFolder = normalizeFolderPath(folderPath);
				if (!normalizedFolder) {
					new Notice('Move target folder is not configured.');
					return null;
				}

				await ensureFolder(this.app, normalizedFolder);
				const targetPath = normalizePath(`${normalizedFolder}/${file.name}`);
				if (targetPath === file.path) {
					new Notice(`Already in ${normalizedFolder}`);
					return file;
				}

				const existing = this.app.vault.getAbstractFileByPath(targetPath);
				if (existing) {
					new Notice(`Move target already exists: ${targetPath}`);
					return null;
				}

				const oldPath = file.path;
				await this.app.fileManager.renameFile(file, targetPath);
				this.noteLocks.handleRename(oldPath, targetPath);
				new Notice(`Moved to ${normalizedFolder}`);
				const moved = this.app.vault.getAbstractFileByPath(targetPath);
				return moved instanceof TFile ? moved : file;
			});
		} catch (e) {
			new Notice(`Error moving file: ${(e as Error).message}`);
			return null;
		}
	}

	registerCaptures() {
		const prefix = this.manifest.id;
		this.clearCommandRegistryGroup('Captures');
		this.settings.captures.forEach((capture, index) => {
			if (!capture.name) return;
			const id = `capture-${index}`;
			const fullId = `${prefix}:${id}`;

			// Register in ChainManager so it can handle args/responses
			this.chainManager.registerInternalCommand(fullId, async (args, _prev, editor, targetFile) => {
				const resolvedValue = args._default || await this.resolveCaptureValue(capture, editor);
				if (resolvedValue === null) return false;
				return await this.captureManager.executeCapture(
					capture,
					resolvedValue,
					targetFile,
					this.resolveCaptureContext(editor, capture, targetFile),
				);
			});

			this.registerCrucibleCommand({
				id,
				name: `Capture: ${capture.name}`,
				group: 'Captures',
				run: async () => {
					const editor = this.activeEditor();
					const value = await this.resolveCaptureValue(capture, editor);
					if (value === null) return;

					await this.captureManager.executeCapture(
						capture,
						value,
						undefined,
						this.resolveCaptureContext(editor, capture),
					);
				},
			});
		});
	}

	private async resolveCaptureValue(capture: Capture, editor?: Editor): Promise<string | null> {
		const source = capture.source || 'dialog';

		switch (source) {
			case 'line':
				if (editor) return editor.getLine(editor.getCursor().line);
				new Notice('This capture reads the current line — switch to edit mode.');
				return null;
			case 'line-fallback':
				if (editor) {
					const line = editor.getLine(editor.getCursor().line);
					if (line.trim()) return line;
				}
				return await this.promptForCaptureValue(capture);
			case 'selection': {
				if (editor) {
					const selection = editor.getSelection();
					if (selection.trim()) return selection;
				}
				const dom = window.getSelection()?.toString() ?? '';
				if (dom.trim()) return dom;
				new Notice('No text selected. Select text in the note first.');
				return null;
			}
			case 'selection-fallback': {
				if (editor) {
					const selection = editor.getSelection();
					if (selection.trim()) return selection;
				}
				const dom = window.getSelection()?.toString() ?? '';
				if (dom.trim()) return dom;
				return await this.promptForCaptureValue(capture);
			}
			case 'dialog':
			default:
				return await this.promptForCaptureValue(capture);
		}
	}

	private resolveCaptureContext(editor: Editor | undefined, capture: Capture, sourceFile?: TFile): CaptureExecutionContext {
		if ((capture.targetSectionMode ?? 'fixed') === 'source' && !editor) {
			new Notice('This capture targets the source section but no editor is active. Switch to edit mode.');
			throw new Error('Source-section capture requires an active editor');
		}
		return {
			sourceSectionHeader: editor ? findCurrentSectionHeader(editor) : null,
			sourceFile: sourceFile ?? this.app.workspace.getActiveFile(),
		};
	}

	async promptForText(title: string): Promise<string | null> {
		return new Promise((resolve) => {
			let submitted = false;
			new TextInputModal(
				this.app,
				title,
				(value) => {
					submitted = true;
					resolve(value);
				},
				() => {
					if (!submitted) resolve(null);
				},
			).open();
		});
	}

	private async promptForCaptureValue(capture: Capture): Promise<string | null> {
		return new Promise((resolve) => {
			new TextInputModal(
				this.app, 
				`Capture: ${capture.name}`, 
				(value) => {
					resolve(value);
				},
				() => { 
					this.refreshToC(); 
					resolve(null);
				}
			).open();
		});
	}

	private openCaptureDialog(capture: Capture) {
		void (async () => {
			const value = await this.promptForCaptureValue(capture);
			if (value !== null) {
				await this.captureManager.executeCapture(capture, value);
			}
		})();
	}

	private registerInternalCommands() {
		const prefix = this.manifest.id;

		// Built-in commands
		const register = (
			id: string,
			fn: (args: Record<string, string>, prev: unknown, editor?: Editor, targetFile?: TFile) => Promise<unknown>,
			schemaOrOptions?: CommandArgSchema[] | ChainCommandOptions,
		) => {
			this.chainManager.registerInternalCommand(`${prefix}:${id}`, fn, schemaOrOptions);
			this.chainManager.registerInternalCommand(`crucible:${id}`, fn, schemaOrOptions);
		};

		register('lint-note', async (_a, _p, _e, tf) => await this.linter.lintNote(tf));
		register('lint-vault', async () => await this.linter.lintVault(), { lockTarget: 'none' });
		register('word-count', async (_a, _p, _e, tf) => await this.linter.lintNote(tf));
		register('lint-cleanup-transcript', async (_a, _p, _e, tf) => await this.linter.cleanupTranscriptInFile(tf));
		register('lint-localize-attachments', async (_a, _p, _e, tf) => {
			const file = tf ?? this.app.workspace.getActiveFile();
			if (!file || file.extension !== 'md') {
				new Notice('Open a Markdown note to localize attachments');
				return false;
			}
			return await this.attachmentLocalizer.localizeNote(file);
		});
		register('lint-localize-attachments-vault', async () => await this.attachmentLocalizer.localizeVault(), { lockTarget: 'none' });
		register('lint-repair-attachments', async (_a, _p, _e, tf) => {
			const file = tf ?? this.app.workspace.getActiveFile();
			if (!file || file.extension !== 'md') {
				new Notice('Open a Markdown note to repair attachment links');
				return false;
			}
			return (await this.attachmentLocalizer.repairNote(file)) !== null;
		});
		register('lint-repair-attachments-vault', async () => await this.attachmentLocalizer.repairVault(), { lockTarget: 'none' });
		register('lint-rename-property', async (args) => await this.linter.renamePropertyInVault(
			typeof args['oldKey'] === 'string' ? args['oldKey'] : '',
			typeof args['newKey'] === 'string' ? args['newKey'] : '',
		), { lockTarget: 'none' });
		register('lint-remove-property', async (args) => await this.linter.removePropertyFromVault(
			typeof args['key'] === 'string' ? args['key'] : '',
		), { lockTarget: 'none' });
		register('youtube-fetch-video-metadata', async (_a, _p, _e, tf) => await this.fetchYoutubeMetadataForActiveNote(tf));

		register('materialize-day-today', async () => await this.materializer.materializeDay(window.moment()), { lockTarget: 'none' });
		register('materialize-week-today', async () => await this.materializer.materializeWeek(window.moment()), { lockTarget: 'none' });
		register('materialize-month-today', async () => await this.materializer.materializeMonth(window.moment()), { lockTarget: 'none' });

		// --- Sources: produce content for chain steps via {{response}} ---
		register('source:active-file', async (_a, _p, _e, tf) => {
			const file = tf ?? this.app.workspace.getActiveFile();
			if (!file) throw new Error('No active file');
			const content = await this.app.vault.read(file);
			return content.replace(FRONTMATTER_REGEX, '').trim();
		}, { mutating: false });

		register('copy-active-file', async (_a, _p, _e, tf) => {
			const file = tf ?? this.app.workspace.getActiveFile();
			if (!file) throw new Error('No active file');
			const content = await this.app.vault.read(file);
			await navigator.clipboard.writeText(content);
			new Notice('Note copied to clipboard');
			return true;
		}, { mutating: false });

		register('source:selection', async (_args, _prev, editor) => {
			if (editor) return editor.getSelection();
			const dom = window.getSelection()?.toString() ?? '';
			if (!dom) throw new Error('No text selected. Select text in the note first.');
			return dom;
		}, { mutating: false, lockTarget: 'none' });

		register('source:input', async (args) => {
			const title = args.title || 'Input';
			return await new Promise<string | false>((resolve) => {
				let submitted = false;
				new TextInputModal(
					this.app,
					title,
					(value) => { submitted = true; resolve(value); },
					() => { if (!submitted) resolve(false); }
				).open();
			});
		}, {
			mutating: false,
			lockTarget: 'none',
			schema: [{ id: 'title', name: 'Title', type: 'text', description: 'Heading shown above the input box.' }],
		});
		
		register('mark-as-forwarded', async (_args, _prev, editor) => {
			if (!editor) throw new Error('mark-as-forwarded requires edit mode');
			const cursor = editor.getCursor();
			const lineNum = cursor.line;
			const line = editor.getLine(lineNum);
			const checkboxRegex = /^(\s*[-*+]\s+\[) (\]\s+.*)$/;
			if (checkboxRegex.test(line)) {
				const newLine = line.replace(checkboxRegex, '$1>$2');
				editor.setLine(lineNum, newLine);
				editor.setCursor(cursor);
				return true;
			}
			return false;
		});

		register('upsert-tags', async (args, _p, _e, tf) => {
			return await this.upsertActiveFileTags(args.tags || '', tf);
		}, [
			{ id: 'tags', name: 'Tags', type: 'textarea', description: 'Tags to add to the active note frontmatter. Use commas, spaces, or one per line. Leading # is optional.' }
		]);

		register('upsert-property', async (args, _p, _e, tf) => {
			return await this.upsertActiveFileProperty(args.property || '', args.value || '', tf);
		}, [
			{ id: 'property', name: 'Property', type: 'text', description: 'Frontmatter property name to create or update on the active note.' },
			{ id: 'value', name: 'Value', type: 'textarea', description: 'Value to write to the property. Supports {{response}} from the previous chain step.' }
		]);

		register('copy-note-to-folder', async (args, _p, _e, tf) => {
			const file = tf ?? this.app.workspace.getActiveFile();
			if (!file) throw new Error('No active file');
			const folder = args.folder?.trim();
			if (!folder) throw new Error('No destination folder specified');
			if (!this.app.vault.getFolderByPath(folder)) await this.app.vault.createFolder(folder);
			const destPath = `${folder}/${file.name}`;
			const exists = this.app.vault.getFileByPath(destPath);
			if (exists) { new Notice(`Copy already exists: ${destPath}`); return destPath; }
			const content = await this.app.vault.read(file);
			await this.app.vault.create(destPath, content);
			new Notice(`Copied to ${destPath}`);
			return destPath;
		}, [
			{ id: 'folder', name: 'Destination folder', type: 'folder', description: 'Vault folder to copy the current note into.' }
		]);

		register('replace-note-body', async (args, prev, _e, tf) => {
			const file = tf ?? this.app.workspace.getActiveFile();
			if (!file || file.extension !== 'md') throw new Error('No active Markdown file');
			const replacement = args.content || (typeof prev === 'string' ? prev : '');
			if (!replacement) throw new Error('No replacement content provided');
			const existing = await this.app.vault.read(file);
			const fmMatch = existing.match(/^---\n[\s\S]*?\n---\n/);
			const frontmatter = fmMatch ? fmMatch[0] : '';
			await withMaterializing(state => { this.isMaterializing = state; }, async () => {
				await this.app.vault.modify(file, frontmatter + replacement);
			});
			new Notice('Note body replaced');
			return true;
		}, [
			{ id: 'content', name: 'Content', type: 'textarea', description: 'New body for the note. If empty, uses {{response}} from the previous step.' }
		]);

		register('capture', async (args, _prev, editor, tf) => {
			const name = args.name;
			const manualValue = args.value;
			const capture = this.settings.captures.find(c => c.name === name);
			if (capture) {
				const resolvedValue = manualValue || await this.resolveCaptureValue(capture, editor);
				if (resolvedValue === null) return false;
				return await this.captureManager.executeCapture(
					capture,
					resolvedValue,
					tf,
					this.resolveCaptureContext(editor, capture, tf),
				);
			}
			new Notice(`Capture not found: ${name}`);
			return false;
		}, [
			{ id: 'name', name: 'Capture name', type: 'text', description: 'Name of the capture workflow to trigger.' },
			{ id: 'value', name: 'Content', type: 'textarea', description: 'Optional content. If omitted, will prompt or use source.' }
		]);
	}

	private async upsertActiveFileTags(tagsInput: string, targetFile?: TFile): Promise<boolean> {
		const file = targetFile ?? this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') throw new Error('No active Markdown file');

		const newTags = parseTagList(tagsInput);
		if (newTags.length === 0) throw new Error('No tags provided');

		await withMaterializing(state => { this.isMaterializing = state; }, async () => {
			await updateFrontmatter(this.app, file, (fm) => {
				upsertFrontmatterTags(fm, tagsInput);
			});
		});

		return true;
	}

	private async upsertActiveFileProperty(property: string, value: string, targetFile?: TFile): Promise<boolean> {
		const file = targetFile ?? this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') throw new Error('No active Markdown file');

		const propertyName = normalizeFrontmatterPropertyName(property);
		if (!propertyName) throw new Error('Property name is required');

		await withMaterializing(state => { this.isMaterializing = state; }, async () => {
			await updateFrontmatter(this.app, file, (fm) => {
				upsertFrontmatterProperty(fm, propertyName, value);
			});
		});

		return true;
	}

	// Fetches + links YouTube metadata for `targetFile` (defaults to the active
	// note). Returns whether the link was set. Used both by the standalone command
	// and as an awaited chain step — passing the chain's target file is what makes
	// it run on the right note, in order, and inside the chain's note-lock context
	// (reentrant), instead of fire-and-forget on the active note via executeCommandById.
	async fetchYoutubeMetadataForActiveNote(targetFile?: TFile): Promise<boolean> {
		const file = targetFile ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
		if (!file) {
			new Notice('No active note');
			return false;
		}
		const fm: Record<string, unknown> | undefined = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const raw: unknown = fm ? fm['yt-video-id'] : undefined;
		const videoId = coerceVideoId(raw);
		if (!videoId) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice('Active note has no yt-video-id in frontmatter');
			return false;
		}

		try {
			const result = await withMaterializing(state => { this.isMaterializing = state; }, () =>
				ingestYoutubeVideoMetadata(this, file, videoId),
			);
			switch (result.status) {
				case 'created':
					new Notice(`YouTube metadata saved: ${result.metadataPath}`);
					this.emitMetadataEnriched(videoId, result.metadataPath, file);
					return true;
				case 'exists':
					new Notice('YouTube metadata already exists; linked.');
					this.emitMetadataEnriched(videoId, result.metadataPath, file);
					return true;
				case 'no-video-id':
					// eslint-disable-next-line obsidianmd/ui/sentence-case
					new Notice('Active note has no yt-video-id in frontmatter');
					return false;
				case 'no-api-key':
					new Notice('YouTube data API key not set — configure it in settings → orchestrator → YouTube tracker');
					return false;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			new Notice(`YouTube fetch failed: ${message}`);
			return false;
		}
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

	async activateSettingsView() {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(CRUCIBLE_SETTINGS_VIEW_TYPE);
		const leaf = existing[0] ?? workspace.getLeaf('tab');
		if (!existing.length) {
			await leaf.setViewState({ type: CRUCIBLE_SETTINGS_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	private emitMetadataEnriched(videoId: string, metadataPath: string, sourceFile?: TFile): void {
		const bus = this.ingestionEvents;
		if (!bus) return;
		const file = this.app.vault.getAbstractFileByPath(metadataPath);
		if (!(file instanceof TFile)) return;
		bus.emit('metadata-enriched', { videoId, metadataFile: file, sourceFile });
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

	openDayPicker() {
		if (!this.settings.dailyEnabled) {
			new Notice(periodDisabledMessage('daily'));
			return;
		}
		new PickerModal(this.app, 'Pick a date', 'date', window.moment().format('YYYY-MM-DD'), (dateStr) => {
			void this.materializer.materializeDay(window.moment(dateStr, 'YYYY-MM-DD'));
		}).open();
	}

	openWeekPicker() {
		if (!this.settings.weeklyEnabled) {
			new Notice(periodDisabledMessage('weekly'));
			return;
		}
		new PickerModal(this.app, 'Pick a week', 'week', window.moment().format('GGGG-[W]WW'), (weekStr) => {
			void this.materializer.materializeWeek(window.moment(weekStr, 'GGGG-[W]WW'));
		}).open();
	}

	openMonthPicker() {
		if (!this.settings.monthlyEnabled) {
			new Notice(periodDisabledMessage('monthly'));
			return;
		}
		new PickerModal(this.app, 'Pick a month', 'month', window.moment().format('YYYY-MM'), (monthStr) => {
			void this.materializer.materializeMonth(window.moment(monthStr, 'YYYY-MM'));
		}).open();
	}

	async handleFileCreate(file: TAbstractFile) {
		if (this.isMaterializing || !(file instanceof TFile) || file.extension !== 'md') return;

		this.scheduleAutoLocalize(file, 'create');

		// CRITICAL: Only proceed if the file is truly empty to avoid overwriting existing notes on startup
		if (file.stat.size > 0) return;

		const parentPath = file.parent?.path || '';
		const fileName = file.basename;

		if (await this.handlePeriodFileCreate(file, parentPath, fileName, 'daily')) return;
		if (await this.handlePeriodFileCreate(file, parentPath, fileName, 'weekly')) return;
		if (await this.handlePeriodFileCreate(file, parentPath, fileName, 'monthly')) return;

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

	private async handlePeriodFileCreate(
		file: TFile,
		parentPath: string,
		fileName: string,
		period: PeriodId,
	): Promise<boolean> {
		const config = getPeriodConfig(this.settings, period);
		if (parentPath !== config.folder) return false;

		if (!config.enabled) {
			new Notice(periodDisabledMessage(period));
			return true;
		}

		const dateMatch = fileName.match(periodFileNameRegex(period));
		if (dateMatch) {
			void this.materializePeriodFromString(period, dateMatch[1]!);
		} else {
			await this.app.fileManager.trashFile(file);
			this.openPeriodPicker(period);
		}
		return true;
	}

	private async materializePeriodFromString(period: PeriodId, value: string): Promise<boolean> {
		if (period === 'daily') return await this.materializer.materializeDay(window.moment(value, 'YYYY-MM-DD'));
		if (period === 'weekly') return await this.materializer.materializeWeek(window.moment(value, 'GGGG-[W]WW'));
		return await this.materializer.materializeMonth(window.moment(value, 'YYYY-MM'));
	}

	private openPeriodPicker(period: PeriodId): void {
		if (period === 'daily') this.openDayPicker();
		else if (period === 'weekly') this.openWeekPicker();
		else this.openMonthPicker();
	}
}

function periodFileNameRegex(period: PeriodId): RegExp {
	if (period === 'daily') return /^(\d{4}-\d{2}-\d{2})$/;
	if (period === 'weekly') return /^(\d{4}-W\d{2})$/;
	return /^(\d{4}-\d{2})$/;
}

function coerceVideoId(value: unknown): string {
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number') return String(value).trim();
	if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === 'string' && item.trim()) return item.trim();
		}
	}
	return '';
}

function findCurrentSectionHeader(editor: Editor): string | null {
	for (let lineNum = editor.getCursor().line; lineNum >= 0; lineNum--) {
		const line = editor.getLine(lineNum).trim();
		if (/^#{1,6}\s+\S/.test(line)) return line;
	}
	return null;
}

class PickerModal extends Modal {
	title: string;
	type: string;
	initialValue: string;
	onSubmit: (result: string) => void;

	constructor(app: App, title: string, type: string, initialValue: string, onSubmit: (result: string) => void) {
		super(app);
		this.title = title;
		this.type = type;
		this.initialValue = initialValue;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: this.title });
		const input = contentEl.createEl('input', { type: this.type });
		input.classList.add('crucible-picker-input');
		input.value = this.initialValue;
		const submit = contentEl.createEl('button', { text: 'Submit' });
		const triggerSubmit = () => { if (input.value) { this.onSubmit(input.value); this.close(); } };
		submit.onclick = triggerSubmit;
		input.addEventListener('keydown', (e) => { if (e.key === 'Enter') triggerSubmit(); });
	}

	onClose() {
		this.contentEl.empty();
	}
}
