export interface FolderTemplate {
	folder: string;
	template: string;
}

export type ExclusionScope = 'lint' | 'search';

export interface ExcludedFolder {
	folder: string;
	lint: boolean;
	search: boolean;
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

import { Hotkey, Command } from 'obsidian';
import { Currency } from './orchestration/utils/fx';
import { GeoResult } from './orchestration/utils/weather';

declare module 'obsidian' {
	interface App {
		secretStorage: SecretStorage;
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
}

export interface SecretStorage {
	setSecret(key: string, value: string): void;
	getSecret(key: string): string | null;
	listSecrets(): string[];
}

export interface CommandArgSchema {
	id: string;
	name: string;
	type: 'text' | 'textarea' | 'dropdown' | 'file' | 'folder';
	description?: string;
	options?: Record<string, string>;
}

export type GuardConditionType = 'has-tag' | 'not-has-tag' | 'has-property' | 'not-has-property' | 'property-equals';

export interface GuardCondition {
	type: GuardConditionType;
	tag?: string;
	property?: string;
	value?: string;
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
	| 'gemini-cli'
	| 'claude-cli'
	| 'codex-cli'
	| 'opencode-cli';

export const API_PROVIDER_KINDS: ProviderKind[] = ['openai', 'anthropic', 'google', 'openrouter', 'ollama'];
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

export interface CrucibleSettings {
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
	// LLM providers (connection + model)
	providers: Provider[];
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
	// Orchestrator
	orchestrationEnabled: boolean;
	orchestrationQueueRoot: string;
	orchestrationTimezone: string;
	orchestrationQueueAutorunEnabled: boolean;
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
	ingestionYoutubeAutoEnrichEnabled: boolean;
	// Per-type worker count for the youtube_metadata_fetch memory queue.
	orchestrationYoutubeMetadataMaxParallel: number;
	ingestionReadingWpm: number;
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
	excludedFolders: [{ folder: '_crucible', lint: false, search: true }],
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
	providers: [],
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
	orchestrationEnabled: true,
	orchestrationQueueRoot: '_crucible/orchestration/queue',
	orchestrationTimezone: 'America/Mexico_City',
	orchestrationQueueAutorunEnabled: false,
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
	ingestionYoutubeAutoEnrichEnabled: false,
	orchestrationYoutubeMetadataMaxParallel: 1,
	ingestionReadingWpm: 250,
	searchEnabled: true,
	searchServiceUrl: 'http://127.0.0.1:8765',
	searchVaultId: 'default',
	searchSemanticEnabled: false,
	searchChunkMaxChars: 1800,
	searchChunkOverlapChars: 200,
	searchIndexBatchSize: 24,
	searchIndexDebounceMs: 5000,
	searchResultLimit: 12,
}
