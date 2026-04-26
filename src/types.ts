export interface FolderTemplate {
	folder: string;
	template: string;
}

export interface Shortcut {
	name: string;
	file: string;
}

export type CaptureTarget = 'daily' | 'weekly' | 'monthly' | 'selected';

export interface Capture {
	name: string;
	targetType: CaptureTarget;
	file: string;
	targetSection: string;
	content: string;
	prepend: boolean;
}

export type ToCPosition = 'bottom-right' | 'bottom-left' | 'top-left' | 'top-right';
export type ToCCollapseBehavior = 'manual' | 'click' | 'blur';

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
	// ToC
	showToC: boolean;
	tocPosition: ToCPosition;
	tocCollapseBehavior: ToCCollapseBehavior;
	// Commands
	hiddenCommands: string[];
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
	showToC: true,
	tocPosition: 'bottom-right',
	tocCollapseBehavior: 'manual',
	hiddenCommands: [],
}
