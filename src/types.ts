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
import { SEARCH_QUERY_LOG_DEFAULT_MAX_ENTRIES } from './search/queryLog';

declare module 'obsidian' {
	interface App {
		// Optional: an undocumented API whose presence and shape vary across Obsidian
		// versions — accessed only through the SecretRegistry facade, which guards it.
		secretStorage?: SecretStorage;
		// Undocumented internal registry of view types by extension, absent from
		// obsidian.d.ts. Presence-guarded in src/fileTypes.ts the same way secretStorage
		// is guarded above — never accessed unconditionally.
		viewRegistry?: {
			typeByExtension?: Record<string, string>;
		};
		plugins: {
			enabledPlugins: Set<string>;
			disablePlugin(id: string): Promise<void>;
			enablePlugin(id: string): Promise<void>;
			// Undocumented instance map keyed by plugin id, absent from obsidian.d.ts.
			// Used only to reach the Dataview plugin's index for a non-destructive
			// revision-bump refresh (see refreshDataviewViews in lint.ts) —
			// every property below `plugins` itself is optional and guarded at the call
			// site, the same way secretStorage is guarded above.
			plugins?: Record<string, { index?: { touch?: () => void } } | undefined>;
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
	// The server's own echoed `model` field for this response (LM Studio/OpenAI-compatible
	// `/v1/embeddings` and ollama `/api/embed` both include one) — not necessarily identical to
	// the requested model id, since a server may resolve an alias or serve a dated revision.
	// Populated opportunistically by each HTTP client; ProviderManager.embed() warns (once per
	// session, never throws) on disagreement rather than failing the call, since legitimate
	// resolution is common and this is a diagnostic signal, not a guard.
	servedModel?: string;
}

// Normalized answer to "what did the server actually load?" — see
// HttpProviderClient.describeModel (src/providers/shared.ts). `precision` is the portable part:
// WP-3 folds it into a persisted vector-space key, so two runtimes serving byte-identical weights
// must normalize to the identical `precision` token (see normalizePrecision in
// src/providers/shared.ts) or an index would needlessly split into two "spaces". `fingerprint` is
// the strongest host-specific identity a runtime can offer (ollama's weights-blob digest, LM
// Studio's quant-bearing served id, Infinity's backend name) and is evidence for diagnosis only —
// deliberately excluded from the key, because keying on a host-specific hash would force a
// re-embed every time identical weights moved between hosts. Any field may be `undefined`: a
// runtime that cannot self-report precision (Infinity today) legitimately returns
// `precision: undefined`, and that must stay a clean unknown rather than a guess.
export interface ProviderModelDescription {
	servedModel?: string;
	precision?: string;
	fingerprint?: string;
}

export interface ProviderImageExtractionResult {
	description: string;
	extractedText: string;
	rawText: string;
	finishReason: ProviderFinishReason;
	rawFinishReason?: string;
}

// A single scored document from a `rerank()` call. `index` is the position of the document in
// the *request's* `documents` array, not the position of this entry within `results` — a
// cross-encoder rerank response is not guaranteed to preserve request order (Infinity's
// `/rerank` typically returns results sorted by relevance-score descending), so callers must
// always resolve a document by `index`, never by its position in the `results` array.
export interface ProviderRerankResultItem {
	index: number;
	relevanceScore: number;
}

export interface ProviderRerankResult {
	results: ProviderRerankResultItem[];
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
	/**
	 * Manual numeric-precision tag for the vector-space id, used *only* when the runtime cannot
	 * report its own — a fallback, never the primary mechanism (see `ProviderModelDescription`).
	 *
	 * This is not a niche case: Infinity's `/v1/models` exposes no dtype at all, and vLLM, TEI and
	 * plain llama.cpp servers commonly do not either, so on many installs this is the only way the
	 * space id can distinguish an fp32 index from a Q4 one. A probed precision always wins over
	 * this; leaving it empty preserves today's behaviour exactly (the space id degrades to the
	 * bare model id, and nothing re-embeds).
	 *
	 * Normalized through `normalizePrecision` before use, so `Q4_K_M` typed here and `q4_k_m`
	 * probed from another runtime are one space rather than two.
	 */
	embeddingVariant?: string;
	/**
	 * The portable identity to key the vector space on, replacing `id` in the space-key
	 * derivation when set — never sent to the provider (the request field always carries the
	 * served id verbatim, exactly as `id` does today).
	 *
	 * Exists because `id` is sometimes not a model identity at all: a llama-server (or vLLM)
	 * container commonly serves a **container-internal mount path**
	 * (`/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf`), which is host- and mount-specific —
	 * moving the compose mount, or switching to a container that mounts the same weights from a
	 * different path, would silently produce a different space key and force a full re-embed for
	 * no reason. Setting this field states the portable identity explicitly rather than inferring
	 * one from a string that was never meant to carry it.
	 *
	 * Precedence in `SearchManager.activeEmbeddingSpaceId`: an explicit, non-blank value here wins
	 * over everything, including the path-basename normalization applied to a path-shaped `id`
	 * (see `isPathShapedModelId`/`normalizePathShapedModelId` in `search/types.ts`); leaving it
	 * empty reproduces today's key byte-for-byte, which is the no-re-embed guarantee.
	 */
	embeddingSpaceId?: string;
}

// Note the asymmetry with HttpProviderClient's optional-capability methods: those describe what a
// provider *kind* can do (does this client implement rerank()?), while these describe what a
// specific configured model is *for*. Both are needed — an openai-compatible provider implements
// rerank(), but only a cross-encoder model should be offered as the reranker, and offering a
// bi-encoder like bge-m3 there (or a cross-encoder as the embedding model) produces silent
// nonsense rather than an error. A model with no capabilities set is treated as chat-only; see
// modelHasCapability in settings/sections/ai.ts.
export type ProviderModelCapability = 'chat' | 'embedding' | 'image-extraction' | 'rerank';

// A single entry from a provider's model-list endpoint (WP-C — see
// plans/queue-control-model-probing-vault-isolation.md). This is what a server *reports*, kept
// deliberately separate from `ProviderModel`: nothing here is ever written into
// `ProviderModel.capabilities` / `embeddingDimensions` / `embeddingVariant` by the probing layer
// itself — per D2, only an explicit user Accept action (WP-D, settings UI) may copy a value across.
// Fields are uneven on purpose, matching how uneven the underlying list endpoints are (see the
// per-kind table in the WP-C plan section): most entries will have only `id` populated, and that is
// the correct, honest result for a kind like plain OpenAI (ids only) rather than a reason to guess.
//
// `quantization` is the server's raw reported string (e.g. "F16", "Q4_K_M") — deliberately NOT run
// through `normalizePrecision`. That normalizer exists to produce a *persisted, comparable* key
// (`ProviderModel.embeddingVariant`); this catalog is surfaced-but-unapplied data a user reviews
// before accepting, and showing them the server's own casing ("LM Studio reports: embeddings, F16")
// is more legible than a lowercased token they never typed.
//
// `looksLikeCrossEncoder` carries the same warn-never-block suspicion as
// `providers/shared.ts`'s `looksLikeCrossEncoder()` heuristic — the catalog may record it, but
// nothing may gate on it (see that function's doc comment for why the distinction is undecidable
// from server metadata alone).
export interface ProviderCatalogModel {
	id: string;
	// openai-compatible (LM Studio native `/api/v0/models`)
	type?: string;
	arch?: string;
	quantization?: string;
	// openai / openai-compatible fallback (`/models`)
	ownedBy?: string;
	// openrouter (`/models`) — rich metadata, currently unread anywhere else in the codebase
	contextLength?: number;
	inputModalities?: string[];
	supportedParameters?: string[];
	// openrouter (`/models` and `/embeddings/models`, WP-2): the server's own display name
	// ("OpenAI: Text Embedding Ada 002") — dropped nowhere else, so a UI wanting a human label
	// instead of a raw id reads it from here rather than guessing one from the id.
	displayName?: string;
	// openrouter `architecture.output_modalities` (WP-2): the embeddings-listing leg's entries
	// report `["embeddings"]` here, which is the only signal that distinguishes an embedding
	// model from a chat model on OpenRouter (chat entries have no `output_modalities` at all, or
	// report `["text"]`). See modelCapabilities.ts inferCapabilities for the consuming side.
	outputModalities?: string[];
	// ollama (`/api/tags` + `/api/show`). Named `serverCapabilities`, deliberately NOT
	// `capabilities` — that name is `ProviderModel.capabilities` above, the D2-protected field this
	// whole probe layer must never write. Keeping the names visibly distinct is a small guardrail
	// against a future edit mistaking "the server's own capability tags" for "the app's applied
	// capability list."
	serverCapabilities?: string[];
	embeddingLength?: number;
	looksLikeCrossEncoder?: boolean;
}

// Persisted catalog cache for a provider, following the currency/geocode precedent exactly
// (`CurrencyCache` above): stamped at fetch time, no TTL, invalidated only by an explicit
// Clear-cache action. Populated by `ProviderManager.listModels()`; the settings UI (WP-D) is the
// only writer that stores it onto `Provider.modelCatalog` and the only place a fetched entry may
// be copied into a `ProviderModel`.
export interface ProviderModelCatalog {
	fetchedAt: string;
	models: ProviderCatalogModel[];
}

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
	// Session-cached model list from the provider's own list endpoint (WP-C). See
	// ProviderModelCatalog's doc comment for the D2 boundary this field sits behind.
	modelCatalog?: ProviderModelCatalog;
	// rsp-wp1: caps in-flight completion-class requests (chat/completions, incl. vision passes —
	// NOT embed/rerank, a different model/latency class) for this provider id, gated at the
	// ProviderManager chokepoint (src/providers.ts). Absent, zero or negative resolves to the
	// default: 1 for local providers (openai-compatible), unlimited otherwise — see
	// resolveProviderConcurrencyLimit. An explicit positive value always overrides the default.
	maxConcurrentRequests?: number;
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
	// Per-step on/off switches for the `Lint: all` pipeline (src/lint.ts LINT_STEPS).
	// Absent key = enabled — keeps a vault that never opens the Lint pipeline panel linting
	// byte-identically to before this setting existed.
	lintStepEnabled: Record<string, boolean>;
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
	// Age-based retention for the SQLite job store's terminal rows (done/failed/
	// cancelled), in days. `pruneTerminal` (src/orchestration/db/SqliteJobStore.ts)
	// deletes settled rows older than this; blank/0 = keep forever. Not yet wired to
	// any caller — WP-5 (storage layer) ships the setting + store method, WP-6/7 wire
	// the periodic prune.
	orchestrationJobRetentionDays: number;
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
	/**
	 * WP-5: milliseconds an interactive search waits before giving up. Health probes keep the
	 * client's own hardcoded 5s default. Separate from `SEARCH_SERVICE_INDEX_TIMEOUT_MS` (60s,
	 * hardcoded — reset/upsert/delete/fileStates) per the two-timeout law in
	 * `src/search/AGENTS.md`: this setting only ever threads into the interactive budget, never
	 * the indexing one. `SearchServiceClient.search()` also derives the companion's own
	 * cooperative per-request deadline from this value (~80% of it), so raising or lowering it
	 * moves both budgets together in the documented relationship.
	 */
	searchQueryTimeoutMs: number;
	// Which file types the search indexer ingests. Independent of
	// crucibleFileOpenPaletteExtensions (the palette's "what can I open" set) — this is
	// "what can FTS5 chunk", restricted in the UI to text-extractable categories.
	// Defaults to exactly today's hardcoded SEARCH_EXTENSIONS so upgrade is a no-op.
	searchIndexExtensions: string[];
	// WP-6: client-side link-adjacency boost applied to the companion's SearchResponse in
	// SearchManager.search (src/search/linkGraph.ts) — the GBrain graph idea running on
	// Obsidian's own metadataCache instead of a new edge store. Disabled means graph
	// construction is skipped entirely, not built-then-multiplied-by-zero.
	searchLinkBoostEnabled: boolean;
	searchLinkBoostWeight: number;
	// WP-5: reranking is a deliberate, explicitly-invoked action on the search modal — never a
	// type-ahead pipeline stage. Disabled by default, and the modal hides the Rerank button
	// entirely (not just disables it) until both a model is picked and this is on, so an
	// unconfigured reranker never surfaces as an error.
	searchRerankEnabled: boolean;
	searchRerankModel?: ProviderModelRef;
	// How many of the current (already-fused) top results get sent to the reranker. Bounds the
	// cost of an explicit rerank click — not a type-ahead concern, but still not "rerank all 200
	// results" by default.
	searchRerankTopN: number;
	// Passive vault-search query logging (src/search/queryLog.ts): records each executed search
	// and which result was opened, into a bounded JSON file in the plugin's own data directory.
	// Local only, never networked, never in the vault's note tree — see that file's header for
	// the four rules (no abandoned-search inference chief among them).
	searchQueryLogEnabled: boolean;
	// The bound. Oldest entries are dropped first; clamped to [10, 5000] on read.
	searchQueryLogMaxEntries: number;
	// clsl-WP-3: destructive-action confirmation framework (src/settings/destructiveActions.ts).
	// Resolution order per action id: destructiveConfirmAction[id] -> destructiveConfirmTier[tier]
	// -> destructiveConfirmGlobal. Absent = inherit the next level up; the global default is true
	// (confirm), so an empty vault-fresh settings object confirms every registered destructive
	// action except the one entry seeded default-suppressed below (job-cancel).
	destructiveConfirmGlobal: boolean;
	destructiveConfirmTier: Record<string, boolean>;
	destructiveConfirmAction: Record<string, boolean>;
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
	lintStepEnabled: {},
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
	orchestrationJobRetentionDays: 30,
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
	// WP-2 measured ground truth (clsl-wp2-search-latency-2026-07-29): server-side work is
	// <=1.4s worst case even on a pathological 15-term query, so this budget mostly absorbs
	// queuing behind the companion's own indexing work, not search cost itself.
	searchQueryTimeoutMs: 4000,
	searchIndexExtensions: ['md', 'qmd', 'txt'],
	searchLinkBoostEnabled: true,
	// weight / (LINK_BOOST_RRF_K + linkRank): at rank 1 that's ~0.00082, which against the
	// tightest realistic gap between adjacent top ranks (~0.00026, see linkGraph.ts) climbs
	// a maximally-linked result ~3 positions — meaningful without being able to leapfrog a
	// typical ~12-result list. See tests/linkGraph.test.mjs and the WP-6 report for the
	// worked arithmetic.
	searchLinkBoostWeight: 0.05,
	searchRerankEnabled: false,
	searchRerankTopN: 30,
	// On by default: this is the substrate that lets a ranking change be validated against real
	// usage instead of hand-authored queries, and a log that only starts accumulating once
	// someone remembers to switch it on has no history when it is finally needed. It stays
	// local, bounded, content-free (paths and query text only — no snippets), and the toggle
	// plus "Search: clear query log" are both one step away.
	searchQueryLogEnabled: true,
	searchQueryLogMaxEntries: SEARCH_QUERY_LOG_DEFAULT_MAX_ENTRIES,
	destructiveConfirmGlobal: true,
	destructiveConfirmTier: {},
	// job-cancel is the one registered action that ships default-suppressed, preserving the
	// documented single-row-cancel policy (queueMonitor.ts:159-162) — everything else inherits
	// the tier/global default of "confirm".
	destructiveConfirmAction: { 'job-cancel': false },
}
