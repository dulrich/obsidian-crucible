export interface FolderTemplate {
	folder: string;
	template: string;
}

export type ExclusionScope = 'lint' | 'search' | 'localize';

export interface ExcludedFolder {
	folder: string;
	lint: boolean;
	search: boolean;
	// Exclude from attachment localization (manual, folder/vault, and auto-localize).
	// Separate from `lint` so a folder of external images can be linted for
	// frontmatter without its images being pulled local.
	localize: boolean;
}

export interface Shortcut {
	name: string;
	file: string;
}

export type CaptureTarget = 'daily' | 'weekly' | 'monthly' | 'selected' | 'active';
export type CaptureSource = 'dialog' | 'line' | 'line-fallback' | 'selection' | 'selection-fallback';
export type CaptureTargetSectionMode = 'fixed' | 'source';
export type CaptureWriteMode = 'append' | 'prepend' | 'replace';

export type LocalizeMediaType = 'images' | 'audio' | 'video' | 'pdf';
export type ImageConvertFormat = 'jpeg' | 'webp';

export const OBSIDIAN_NATIVE_EMBED_FORMATS: Record<LocalizeMediaType, string[]> = {
	images: ['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'],
	audio: ['flac', 'm4a', 'mp3', 'ogg', 'wav', 'webm', '3gp'],
	video: ['mkv', 'mov', 'mp4', 'ogv', 'webm'],
	pdf: ['pdf'],
};

export interface Capture {
	name: string;
	targetType: CaptureTarget;
	source: CaptureSource;
	file: string;
	targetSectionMode?: CaptureTargetSectionMode;
	targetSection: string;
	content: string;
	writeMode: CaptureWriteMode;
}

export type ToCPosition = 'bottom-right' | 'bottom-left' | 'top-left' | 'top-right';
export type ToCCollapseBehavior = 'manual' | 'click' | 'blur';

export type CrucibleCommandPaletteFilterMode = 'whitelist' | 'blacklist';
export type CrucibleCommandPaletteHintCharsetMode = 'all-ascii' | 'alphanumeric-whitelist';
export type CrucibleFileOpenIgnoredFolderMode = 'include' | 'derank' | 'hide';
export type SourceEvalBudgetPeriod = 'week' | 'month';

import { Hotkey, Command } from 'obsidian';
import { Currency } from './orchestration/utils/fx';
import { GeoResult } from './orchestration/utils/weather';
import type { JobType } from './orchestration/types';
import type { JobTypeControlsMap } from './orchestration/autorunGate';

declare module 'obsidian' {
	interface App {
		// Optional: an undocumented API whose presence and shape vary across Obsidian
		// versions — accessed only through the SecretRegistry facade, which guards it.
		secretStorage?: SecretStorage;
		plugins: {
			enabledPlugins: Set<string>;
			disablePlugin(id: string): Promise<void>;
			enablePlugin(id: string): Promise<void>;
		};
		setting: {
			open(): void;
			openTabById(id: string): void;
		};
		commands: {
			listCommands(): Command[];
			executeCommandById(id: string): void;
			commands: Record<string, Command>;
		};
		hotkeyManager: {
			getHotkeys(id: string): Hotkey[];
		};
	}
	interface MetadataCache {
		isUserIgnored(path: string): boolean;
	}
	interface Vault {
		// Undocumented but long-stable config accessors. Optional + presence-guarded at
		// the call site, the way App.secretStorage is.
		getConfig?(key: string): unknown;
		setConfig?(key: string, value: unknown): void;
	}
}

// The methods may be sync or Promise-returning depending on the Obsidian version;
// callers `await` the results so both shapes work.
export interface SecretStorage {
	setSecret(key: string, value: string): void | Promise<void>;
	getSecret(key: string): string | null | Promise<string | null>;
	listSecrets(): string[] | Promise<string[]>;
}

export interface CommandArgSchema {
	id: string;
	name: string;
	type: 'text' | 'textarea' | 'dropdown' | 'file' | 'folder';
	description?: string;
	options?: Record<string, string>;
}

export type GuardConditionType =
	| 'has-tag'
	| 'not-has-tag'
	| 'has-property'
	| 'not-has-property'
	| 'property-equals'
	| 'property-in-set'
	| 'property-lt'      // numeric: Number(frontmatter[property]) < Number(value)
	| 'property-gt'      // numeric: Number(frontmatter[property]) > Number(value)
	| 'word-count-lt'    // numeric: note body word count < Number(value) (async, content-sourced)
	| 'word-count-gt';   // numeric: note body word count > Number(value) (async, content-sourced)

// The frontmatter-sourced guard types: synchronously evaluable from the metadata
// cache. Used by the trigger engine (whose guard is sync); `word-count-*` is only
// valid as a chain guard step, where evaluation is async and can read content.
export const SYNC_GUARD_CONDITION_TYPES: GuardConditionType[] = [
	'has-tag', 'not-has-tag', 'has-property', 'not-has-property', 'property-equals', 'property-in-set', 'property-lt', 'property-gt',
];

export type GuardConditionValueKind = 'text' | 'tag' | 'file' | 'folder' | 'youtube-channel';

export interface GuardCondition {
	type: GuardConditionType;
	tag?: string;
	property?: string;
	value?: string;
	values?: string[];
	valueKind?: GuardConditionValueKind;
}

export interface ChainStep {
	commandId: string;
	stepType?: 'command' | 'guard';
	keepGoing: boolean;
	args: Record<string, string>;
	guardCondition?: GuardCondition;
	captureIntermediate?: boolean;
}

export interface Chain {
	name: string;
	steps: ChainStep[];
	variables?: Record<string, string>;
	debugMode?: boolean;
	debugLogPath?: string;
	// Whether running the chain mutates its target note. Defaults to true (omitted ===
	// mutating). A non-mutating chain (e.g. one that only opens a view/dashboard) skips
	// the per-note lock so it doesn't gray out / serialize against the note.
	mutating?: boolean;
}

// A user-configurable if-this-then-that rule. Adapted into an OrchestrationTrigger at
// registration time (see TriggerRegistry.setUserTriggers); like all triggers it only
// enqueues jobs, inheriting queue dedupe / pacing / timeout / note-lock semantics.
export type TriggerEvent = 'create' | 'modify' | 'rename' | 'metadata-changed' | 'youtube-metadata-enriched';

export interface TriggerScope {
	// Path prefix the file must sit under to qualify, e.g. "Clippings". Empty = whole vault.
	folder?: string;
	// Whether files in nested subfolders qualify. Default true.
	includeSubfolders?: boolean;
}

export type TriggerAction =
	| { kind: 'chain'; chainName: string }
	| { kind: 'workflow'; jobType: JobType; params?: Record<string, string> }
	| { kind: 'command'; commandId: string; args?: Record<string, string> };

export interface TriggerDef {
	id: string;
	name: string;
	enabled: boolean;
	on: { event: TriggerEvent } | { events: TriggerEvent[] } | { everyMinutes: number };
	scope?: TriggerScope;
	// Evaluated against the file's frontmatter/tags. word-count-* types are not allowed
	// here (the trigger guard is sync); use a chain guard step for those.
	conditions: GuardCondition[];
	conditionMode?: 'all' | 'any'; // default 'all' (AND)
	action: TriggerAction;
}

export interface AgentResult {
	response: string;
	model: string;
	provider: string;
	finishReason?: ProviderFinishReason;
	rawFinishReason?: string;
}

export type ProviderModality = 'api' | 'cli';

export type ProviderFinishReason =
	| 'stop'
	| 'length'
	| 'content_filter'
	| 'tool_calls'
	| 'error'
	| 'unknown'
	| 'other';

export interface ProviderCompletionResult {
	text: string;
	finishReason: ProviderFinishReason;
	rawFinishReason?: string;
}

export interface ProviderEmbeddingResult {
	embeddings: number[][];
	dimensions?: number;
}

export interface ProviderImageExtractionResult {
	description: string;
	extractedText: string;
	rawText: string;
	finishReason: ProviderFinishReason;
	rawFinishReason?: string;
}

export type ProviderKind =
	| 'openai'
	| 'anthropic'
	| 'google'
	| 'openrouter'
	| 'ollama'
	| 'openai-compatible'
	| 'gemini-cli'
	| 'claude-cli'
	| 'codex-cli'
	| 'opencode-cli';

export const API_PROVIDER_KINDS: ProviderKind[] = ['openai', 'anthropic', 'google', 'openrouter', 'ollama', 'openai-compatible'];
export const CLI_PROVIDER_KINDS: ProviderKind[] = ['gemini-cli', 'claude-cli', 'codex-cli', 'opencode-cli'];

export function providerModality(kind: ProviderKind): ProviderModality {
	return CLI_PROVIDER_KINDS.includes(kind) ? 'cli' : 'api';
}

export interface ProviderModel {
	id: string;
	label: string;
	capabilities?: ProviderModelCapability[];
	embeddingDimensions?: number;
}

export type ProviderModelCapability = 'chat' | 'embedding' | 'image-extraction';

export interface Provider {
	id: string;
	name: string;
	kind: ProviderKind;
	models: ProviderModel[];
	// API kinds
	baseUrl?: string;
	// CLI kinds
	command?: string;
	extraArgs?: string;
	cwd?: string;
	timeoutSeconds?: number;
	cliRunArtifactsEnabled?: boolean;
	cliRunDirectory?: string;
}

export interface FxPair {
	base: string;
	quote: string;
	label: string;
}

export interface WeatherLocation {
	label: string;
	lat: number;
	lon: number;
}

export interface CurrencyCache {
	fetchedAt: string;
	currencies: Currency[];
}

export interface GeocodeCacheEntry {
	fetchedAt: string;
	results: GeoResult[];
}

export type AgentPromptSource = 'text' | 'file';

export type AgentBindingMode = 'pinned' | 'constrained' | 'runtime';

export type AgentExecutionMode = 'read-only' | 'edit' | 'unrestricted';

export interface ProviderModelRef {
	providerId: string;
	modelId: string;
}

export interface AgentModelBinding {
	mode: AgentBindingMode;
	pinned?: ProviderModelRef;
	allow?: ProviderModelRef[];
}

export interface Agent {
	id: string;
	name: string;
	modelBinding: AgentModelBinding;
	systemPromptSource: AgentPromptSource;
	systemPromptText: string;
	systemPromptFile: string;
	userPromptSource: AgentPromptSource;
	userPromptText: string;
	userPromptFile: string;
	executionMode: AgentExecutionMode;
	requireNormalFinishReason: boolean;
}

/** Surround tone for the N1 Console theme (Obsidian has no native third mode, so
 *  the plugin drives it via body[data-surround]). Med is the default. */
export type Surround = 'dark' | 'med' | 'light';

export interface CrucibleSettings {
	// Appearance
	surround: Surround;
	dailyFolder: string;
	weeklyFolder: string;
	monthlyFolder: string;
	dailyEnabled: boolean;
	weeklyEnabled: boolean;
	monthlyEnabled: boolean;
	dailyCreateAssetFolder: boolean;
	weeklyCreateAssetFolder: boolean;
	monthlyCreateAssetFolder: boolean;
	moveFilePinDailyFolder: boolean;
	moveFilePinWeeklyFolder: boolean;
	moveFilePinMonthlyFolder: boolean;
	moveFilePinnedFolders: string[];
	dailyTemplate: string;
	weeklyTemplate: string;
	monthlyTemplate: string;
	folderTemplates: FolderTemplate[];
	// Lint Settings
	lintFrontmatterInsert: string;
	lintYamlKeyPriority: string[];
	excludedFolders: ExcludedFolder[];
	lintCreatedKey: string;
	lintModifiedKey: string;
	lintBlankLineAfterYaml: boolean;
	lintOnSave: boolean;
	// Lint: Localize Attachments
	localizeAttachmentsTriggerOnCreate: boolean;
	localizeAttachmentsTriggerOnEdit: boolean;
	localizeAttachmentsTriggerOnPaste: boolean;
	localizeAttachmentsImagesProcessAttached: boolean;
	localizeAttachmentsImagesProcessPasted: boolean;
	localizeAttachmentsImagesWhitelist: string[];
	localizeAttachmentsAudioProcessAttached: boolean;
	localizeAttachmentsAudioProcessPasted: boolean;
	localizeAttachmentsAudioWhitelist: string[];
	localizeAttachmentsVideoProcessAttached: boolean;
	localizeAttachmentsVideoProcessPasted: boolean;
	localizeAttachmentsVideoWhitelist: string[];
	localizeAttachmentsPdfProcessAttached: boolean;
	localizeAttachmentsPdfProcessPasted: boolean;
	localizeAttachmentsPdfWhitelist: string[];
	localizeAttachmentsConvertAttachedImages: boolean;
	localizeAttachmentsAttachedImageFormat: ImageConvertFormat;
	localizeAttachmentsAttachedImageQuality: number;
	localizeAttachmentsConvertPastedImages: boolean;
	localizeAttachmentsPastedImageFormat: ImageConvertFormat;
	localizeAttachmentsPastedImageQuality: number;
	localizeAttachmentsFolderTemplate: string;
	localizeAttachmentsNameTemplate: string;
	localizeAttachmentsFollowNoteLifecycle: boolean;
	localizeAttachmentsDebugMode: boolean;
	imageMetadataExtractionEnabled: boolean;
	imageMetadataExtractionModel?: ProviderModelRef;
	imageMetadataExtractionSchemaVersion: number;
	// Shortcuts
	shortcuts: Shortcut[];
	// Captures
	captures: Capture[];
	// Chains
	chains: Chain[];
	// Triggers (user-configured if-this-then-that rules; run a chain or enqueue a workflow)
	triggers: TriggerDef[];
	// LLM providers (connection + model)
	providers: Provider[];
	// Names (never values) of secrets the plugin has stored in Obsidian's secret
	// store. Used to detect when a key the user saved vanishes out-of-band (e.g. an
	// Obsidian update resets the store). Grown by observation on reconcile.
	storedSecretKeys: string[];
	// Agents (provider + prompts, callable from chains)
	agents: Agent[];
	// ToC
	showToC: boolean;
	tocPosition: ToCPosition;
	tocCollapseBehavior: ToCCollapseBehavior;
	// Commands
	hiddenCommands: string[];
	hiddenFromChainSearch: string[];
	// Crucible Command Palette (optional replacement palette)
	crucibleCommandPaletteEnabled: boolean;
	crucibleCommandPalettePinned: string[];
	crucibleCommandPaletteFilterMode: CrucibleCommandPaletteFilterMode;
	crucibleCommandPaletteWhitelist: string[];
	crucibleCommandPaletteBlacklist: string[];
	crucibleCommandPaletteShowHotkeys: boolean;
	crucibleCommandPaletteShowUniqueString: boolean;
	// Fuzzy-hint tuning (charset, fallback, weighting)
	crucibleCommandPaletteHintCharsetMode: CrucibleCommandPaletteHintCharsetMode;
	crucibleCommandPaletteHintWhitelist: string;
	crucibleCommandPaletteHintFallbackTopMatch: boolean;
	crucibleCommandPaletteHintMaxLen: number;
	crucibleCommandPaletteHintPrefixPenalty: number;
	crucibleCommandPaletteHintPositionBias: number;
	// Crucible File-open Palette (optional Quick Switcher replacement)
	crucibleFileOpenPaletteEnabled: boolean;
	crucibleFileOpenPaletteIgnoredFolderMode: CrucibleFileOpenIgnoredFolderMode;
	crucibleFileOpenPaletteCreateMissing: boolean;
	crucibleFileOpenPaletteExtensions: string[];
	// Orchestrator
	orchestrationEnabled: boolean;
	orchestrationQueueRoot: string;
	orchestrationTimezone: string;
	// Queue-wide panic switch (default true) and the single master over all
	// auto-draining. Off stops every type while preserving the per-type auto-run
	// flags underneath, so re-enabling restores the exact prior configuration. Manual
	// Run/enqueue still executes.
	orchestrationQueueEnabled: boolean;
	// Per-job-type queue controls, keyed by JobType. `autoRun` is the per-type
	// EXECUTION (drain) gate: a type auto-drains only when the queue is Enabled AND
	// its `autoRun` is true (unset ⇒ idle, opt-in), uniform for file and memory
	// types. `minIntervalMsOverride` overrides the type's configured cooloff between
	// job starts. Manual "Run"/per-job Run/enqueue-and-run bypasses the auto-run gate.
	orchestrationJobTypeControls: JobTypeControlsMap;
	// Global cap on total in-flight jobs across all types when draining.
	orchestrationMaxConcurrent: number;
	// Per-job execution timeout for the autorun drain; 0 disables. A hung workflow
	// fails fast instead of waiting for the hour-long stale-running backstop.
	orchestrationAutorunTimeoutSeconds: number;
	// Workflow: daily_brief_lite
	orchestrationDailyBriefEnabled: boolean;
	orchestrationDailyBriefTargetSection: string;
	orchestrationDailyBriefFxPairs: FxPair[];
	orchestrationDailyBriefWeatherLocations: WeatherLocation[];
	orchestrationDailyBriefCurrencyCache?: CurrencyCache;
	orchestrationDailyBriefGeocodeCache: Record<string, GeocodeCacheEntry>;
	// Workflow: youtube_tracker
	orchestrationYoutubeTrackerEnabled: boolean;
	orchestrationYoutubeChannelsNote: string;
	orchestrationYoutubeTrackerDiffMode: boolean;
	orchestrationYoutubeTrackerWriteEmptyRuns: boolean;
	orchestrationYoutubeMetadataRoot: string;
	// Channel metadata enrichment (about.md per channel)
	orchestrationYoutubeChannelEnrichEnabled: boolean;
	orchestrationYoutubeChannelEnrichIntervalMinutes: number;
	orchestrationYoutubeChannelEnrichMaxAgeDays: number;
	// Workflow: blogs_tracker
	orchestrationBlogsTrackerEnabled: boolean;
	orchestrationBlogsNote: string;
	orchestrationBlogsTrackerDiffMode: boolean;
	orchestrationBlogsTrackerWriteEmptyRuns: boolean;
	orchestrationBlogsMetadataRoot: string;
	orchestrationBlogsIngestCommandId: string;
	// Workflow: link_scan
	orchestrationLinkScanEnabled: boolean;
	orchestrationLinkRegistryRoot: string;
	orchestrationLinkScanExclusions: string[];
	orchestrationTrackedSourcesNote: string;
	// Workflow: transcript_refine
	orchestrationTranscriptRefineEnabled: boolean;
	orchestrationTranscriptRefineChainName: string;
	// Triggers (TriggerRegistry): per-trigger enable overrides keyed by trigger id.
	// Absent key = the trigger's registered default. Schedule intervals: 0 = off.
	orchestrationTriggersEnabled: Record<string, boolean>;
	orchestrationRoutineNoticesEnabled: Record<string, boolean>;
	orchestrationYoutubeTrackerIntervalMinutes: number;
	orchestrationBlogsTrackerIntervalMinutes: number;
	// Ingestion Dashboard
	ingestionClipperInboxFolder: string;
	ingestionYoutubeEnrichRateLimitSeconds: number;
	// Auto-ENQUEUE enrichment (source): automatically create youtube_metadata_fetch
	// jobs — gates both the capture event trigger and the Uncaptured Videos
	// auto-source. Orthogonal to draining (the per-type auto-run gate governs that).
	ingestionYoutubeAutoEnqueueEnabled: boolean;
	// Per-type worker count for the youtube_metadata_fetch memory queue.
	orchestrationYoutubeMetadataMaxParallel: number;
	ingestionReadingWpm: number;
	// Source Eval Dashboard
	sourceEvalEnabled: boolean;
	sourceEvalReadingBudgetWords: number;
	sourceEvalBudgetPeriod: SourceEvalBudgetPeriod;
	sourceEvalRecencyHalfLifeDays: number;
	sourceEvalLookbackDays: number;
	sourceEvalExportFolder: string;
	// Search
	searchEnabled: boolean;
	searchServiceUrl: string;
	searchVaultId: string;
	searchSemanticEnabled: boolean;
	searchEmbeddingModel?: ProviderModelRef;
	searchChunkMaxChars: number;
	searchChunkOverlapChars: number;
	searchIndexBatchSize: number;
	searchIndexDebounceMs: number;
	searchResultLimit: number;
}

export const DEFAULT_SETTINGS: CrucibleSettings = {
	surround: 'med',
	dailyFolder: 'daily/day',
	weeklyFolder: 'daily/week',
	monthlyFolder: 'daily/month',
	dailyEnabled: true,
	weeklyEnabled: true,
	monthlyEnabled: true,
	dailyCreateAssetFolder: true,
	weeklyCreateAssetFolder: false,
	monthlyCreateAssetFolder: false,
	moveFilePinDailyFolder: true,
	moveFilePinWeeklyFolder: true,
	moveFilePinMonthlyFolder: true,
	moveFilePinnedFolders: [],
	dailyTemplate: '',
	weeklyTemplate: '',
	monthlyTemplate: '',
	folderTemplates: [],
	lintFrontmatterInsert: '',
	lintYamlKeyPriority: ['title', 'created', 'updated', 'word-count'],
	excludedFolders: [{ folder: '_crucible', lint: false, search: true, localize: false }],
	lintCreatedKey: 'created',
	lintModifiedKey: 'updated',
	lintBlankLineAfterYaml: true,
	lintOnSave: false,
	localizeAttachmentsTriggerOnCreate: false,
	localizeAttachmentsTriggerOnEdit: false,
	localizeAttachmentsTriggerOnPaste: false,
	localizeAttachmentsImagesProcessAttached: true,
	localizeAttachmentsImagesProcessPasted: true,
	localizeAttachmentsImagesWhitelist: ['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'],
	localizeAttachmentsAudioProcessAttached: false,
	localizeAttachmentsAudioProcessPasted: false,
	localizeAttachmentsAudioWhitelist: ['flac', 'm4a', 'mp3', 'ogg', 'wav', 'webm', '3gp'],
	localizeAttachmentsVideoProcessAttached: false,
	localizeAttachmentsVideoProcessPasted: false,
	localizeAttachmentsVideoWhitelist: ['mkv', 'mov', 'mp4', 'ogv', 'webm'],
	localizeAttachmentsPdfProcessAttached: false,
	localizeAttachmentsPdfProcessPasted: false,
	localizeAttachmentsPdfWhitelist: ['pdf'],
	localizeAttachmentsConvertAttachedImages: false,
	localizeAttachmentsAttachedImageFormat: 'webp',
	localizeAttachmentsAttachedImageQuality: 85,
	localizeAttachmentsConvertPastedImages: true,
	localizeAttachmentsPastedImageFormat: 'webp',
	localizeAttachmentsPastedImageQuality: 80,
	localizeAttachmentsFolderTemplate: '{{folder}}/_attachments/{{slug}}',
	localizeAttachmentsNameTemplate: '{{md5}}_MD5.{{ext}}',
	localizeAttachmentsFollowNoteLifecycle: true,
	localizeAttachmentsDebugMode: false,
	imageMetadataExtractionEnabled: false,
	imageMetadataExtractionSchemaVersion: 1,
	shortcuts: [],
	captures: [],
	chains: [],
	triggers: [],
	providers: [],
	storedSecretKeys: [],
	agents: [],
	showToC: true,
	tocPosition: 'bottom-right',
	tocCollapseBehavior: 'manual',
	hiddenCommands: [],
	hiddenFromChainSearch: [],
	crucibleCommandPaletteEnabled: false,
	crucibleCommandPalettePinned: [],
	crucibleCommandPaletteFilterMode: 'blacklist',
	crucibleCommandPaletteWhitelist: [],
	crucibleCommandPaletteBlacklist: [],
	crucibleCommandPaletteShowHotkeys: true,
	crucibleCommandPaletteShowUniqueString: false,
	crucibleCommandPaletteHintCharsetMode: 'alphanumeric-whitelist',
	crucibleCommandPaletteHintWhitelist: '.',
	crucibleCommandPaletteHintFallbackTopMatch: true,
	crucibleCommandPaletteHintMaxLen: 6,
	crucibleCommandPaletteHintPrefixPenalty: 1,
	crucibleCommandPaletteHintPositionBias: 0,
	crucibleFileOpenPaletteEnabled: false,
	crucibleFileOpenPaletteIgnoredFolderMode: 'derank',
	crucibleFileOpenPaletteCreateMissing: false,
	crucibleFileOpenPaletteExtensions: [],
	orchestrationEnabled: true,
	orchestrationQueueRoot: '_crucible/orchestration/queue',
	orchestrationTimezone: 'America/Mexico_City',
	orchestrationQueueEnabled: true,
	orchestrationJobTypeControls: {},
	orchestrationMaxConcurrent: 3,
	orchestrationAutorunTimeoutSeconds: 600,
	orchestrationDailyBriefEnabled: true,
	orchestrationDailyBriefTargetSection: 'Daily Brief: External Context',
	orchestrationDailyBriefFxPairs: [
		{ base: 'USD', quote: 'MXN', label: 'USD → MXN' },
		{ base: 'EUR', quote: 'MXN', label: 'EUR → MXN' },
	],
	orchestrationDailyBriefWeatherLocations: [
		{ label: 'Guadalajara, MX', lat: 20.6597, lon: -103.3496 },
		{ label: 'Mt Vernon, WA', lat: 48.4201, lon: -122.3346 },
		{ label: 'Bolzano, IT', lat: 46.4983, lon: 11.3548 },
	],
	orchestrationDailyBriefGeocodeCache: {},
	orchestrationYoutubeTrackerEnabled: true,
	orchestrationYoutubeChannelsNote: '_system/youtube/Channels.md',
	orchestrationYoutubeTrackerDiffMode: true,
	orchestrationYoutubeTrackerWriteEmptyRuns: false,
	orchestrationYoutubeMetadataRoot: '_yt_metadata',
	orchestrationYoutubeChannelEnrichEnabled: false,
	orchestrationYoutubeChannelEnrichIntervalMinutes: 0,
	orchestrationYoutubeChannelEnrichMaxAgeDays: 30,
	orchestrationBlogsTrackerEnabled: true,
	orchestrationBlogsNote: '_system/blogs/Blogs.md',
	orchestrationBlogsTrackerDiffMode: true,
	orchestrationBlogsTrackerWriteEmptyRuns: false,
	orchestrationBlogsMetadataRoot: '_blog_metadata',
	orchestrationBlogsIngestCommandId: '',
	orchestrationLinkScanEnabled: true,
	orchestrationLinkRegistryRoot: '_crucible/link_registry',
	orchestrationLinkScanExclusions: ['_crucible'],
	orchestrationTrackedSourcesNote: 'Sources/Tracked Sources.md',
	orchestrationTranscriptRefineEnabled: true,
	orchestrationTranscriptRefineChainName: 'Refine Transcript',
	orchestrationTriggersEnabled: {},
	orchestrationRoutineNoticesEnabled: {},
	orchestrationYoutubeTrackerIntervalMinutes: 0,
	orchestrationBlogsTrackerIntervalMinutes: 0,
	ingestionClipperInboxFolder: '_clippings/inbox',
	ingestionYoutubeEnrichRateLimitSeconds: 2,
	ingestionYoutubeAutoEnqueueEnabled: false,
	orchestrationYoutubeMetadataMaxParallel: 1,
	ingestionReadingWpm: 250,
	sourceEvalEnabled: true,
	sourceEvalReadingBudgetWords: 50000,
	sourceEvalBudgetPeriod: 'week',
	sourceEvalRecencyHalfLifeDays: 90,
	sourceEvalLookbackDays: 180,
	sourceEvalExportFolder: '_crucible/source_eval',
	searchEnabled: true,
	searchServiceUrl: 'http://127.0.0.1:4801',
	searchVaultId: 'default',
	searchSemanticEnabled: false,
	searchChunkMaxChars: 1800,
	searchChunkOverlapChars: 200,
	searchIndexBatchSize: 24,
	searchIndexDebounceMs: 5000,
	searchResultLimit: 12,
}
