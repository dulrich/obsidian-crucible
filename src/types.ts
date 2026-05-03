export interface FolderTemplate {
	folder: string;
	template: string;
}

export interface Shortcut {
	name: string;
	file: string;
}

export type CaptureTarget = 'daily' | 'weekly' | 'monthly' | 'selected' | 'active';
export type CaptureSource = 'dialog' | 'line' | 'line-fallback' | 'selection' | 'selection-fallback';
export type CaptureWriteMode = 'append' | 'prepend' | 'replace';

export interface Capture {
	name: string;
	targetType: CaptureTarget;
	source: CaptureSource;
	file: string;
	targetSection: string;
	content: string;
	writeMode: CaptureWriteMode;
}

export type ToCPosition = 'bottom-right' | 'bottom-left' | 'top-left' | 'top-right';
export type ToCCollapseBehavior = 'manual' | 'click' | 'blur';

import { Hotkey, Command } from 'obsidian';

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
}

export interface AgentResult {
	response: string;
	model: string;
}

export type LlmProviderType = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'ollama';

export interface Provider {
	id: string;
	name: string;
	type: LlmProviderType;
	model: string;
	baseUrl?: string;
}

export type AgentPromptSource = 'text' | 'file';

export interface Agent {
	id: string;
	name: string;
	providerId: string;
	systemPromptSource: AgentPromptSource;
	systemPromptText: string;
	systemPromptFile: string;
	userPromptSource: AgentPromptSource;
	userPromptText: string;
	userPromptFile: string;
}

export interface CrucibleSettings {
	dailyFolder: string;
	weeklyFolder: string;
	monthlyFolder: string;
	dailyTemplate: string;
	weeklyTemplate: string;
	monthlyTemplate: string;
	folderTemplates: FolderTemplate[];
	// Lint Settings
	lintFrontmatterInsert: string;
	lintYamlKeyPriority: string[];
	lintIgnoredFolders: string[];
	lintCreatedKey: string;
	lintModifiedKey: string;
	lintBlankLineAfterYaml: boolean;
	lintOnSave: boolean;
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
	// Orchestrator
	orchestrationEnabled: boolean;
	orchestrationQueueRoot: string;
	orchestrationTimezone: string;
	orchestrationYoutubeChannelsNote: string;
	orchestrationLinkRegistryRoot: string;
	orchestrationLinkScanExclusions: string[];
	orchestrationTrackedSourcesNote: string;
}

export const DEFAULT_SETTINGS: CrucibleSettings = {
	dailyFolder: 'daily/day',
	weeklyFolder: 'daily/week',
	monthlyFolder: 'daily/month',
	dailyTemplate: '',
	weeklyTemplate: '',
	monthlyTemplate: '',
	folderTemplates: [],
	lintFrontmatterInsert: '',
	lintYamlKeyPriority: ['title', 'created', 'updated', 'word-count'],
	lintIgnoredFolders: [],
	lintCreatedKey: 'created',
	lintModifiedKey: 'updated',
	lintBlankLineAfterYaml: true,
	lintOnSave: false,
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
	orchestrationEnabled: true,
	orchestrationQueueRoot: '_crucible/orchestration/queue',
	orchestrationTimezone: 'America/Mexico_City',
	orchestrationYoutubeChannelsNote: '_system/youtube/Channels.md',
	orchestrationLinkRegistryRoot: '_crucible/link_registry',
	orchestrationLinkScanExclusions: ['_crucible'],
	orchestrationTrackedSourcesNote: 'Sources/Tracked Sources.md',
}
