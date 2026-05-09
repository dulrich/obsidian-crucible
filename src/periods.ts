import { moment, normalizePath } from 'obsidian';
import { CrucibleSettings } from './types';

export type PeriodId = 'daily' | 'weekly' | 'monthly';

export type StringSettingKey =
	| 'dailyFolder'
	| 'weeklyFolder'
	| 'monthlyFolder'
	| 'dailyTemplate'
	| 'weeklyTemplate'
	| 'monthlyTemplate';

export type BooleanSettingKey =
	| 'dailyEnabled'
	| 'weeklyEnabled'
	| 'monthlyEnabled'
	| 'dailyCreateAssetFolder'
	| 'weeklyCreateAssetFolder'
	| 'monthlyCreateAssetFolder'
	| 'moveFilePinDailyFolder'
	| 'moveFilePinWeeklyFolder'
	| 'moveFilePinMonthlyFolder';

export interface PeriodMeta {
	id: PeriodId;
	label: string;
	lowerLabel: string;
	dateFormat: string;
	exampleFolder: string;
	exampleTemplate: string;
	folderKey: StringSettingKey;
	templateKey: StringSettingKey;
	enabledKey: BooleanSettingKey;
	assetFolderKey: BooleanSettingKey;
	movePinKey: BooleanSettingKey;
}

export interface PeriodConfig extends PeriodMeta {
	enabled: boolean;
	folder: string;
	template: string;
	createAssetFolder: boolean;
	pinInMovePicker: boolean;
}

export const PERIOD_IDS: PeriodId[] = ['daily', 'weekly', 'monthly'];

const PERIOD_META: Record<PeriodId, PeriodMeta> = {
	daily: {
		id: 'daily',
		label: 'Daily',
		lowerLabel: 'daily',
		dateFormat: 'YYYY-MM-DD',
		exampleFolder: 'daily/day',
		exampleTemplate: 'templates/daily.md',
		folderKey: 'dailyFolder',
		templateKey: 'dailyTemplate',
		enabledKey: 'dailyEnabled',
		assetFolderKey: 'dailyCreateAssetFolder',
		movePinKey: 'moveFilePinDailyFolder',
	},
	weekly: {
		id: 'weekly',
		label: 'Weekly',
		lowerLabel: 'weekly',
		dateFormat: 'GGGG-[W]WW',
		exampleFolder: 'daily/week',
		exampleTemplate: 'templates/weekly.md',
		folderKey: 'weeklyFolder',
		templateKey: 'weeklyTemplate',
		enabledKey: 'weeklyEnabled',
		assetFolderKey: 'weeklyCreateAssetFolder',
		movePinKey: 'moveFilePinWeeklyFolder',
	},
	monthly: {
		id: 'monthly',
		label: 'Monthly',
		lowerLabel: 'monthly',
		dateFormat: 'YYYY-MM',
		exampleFolder: 'daily/month',
		exampleTemplate: 'templates/monthly.md',
		folderKey: 'monthlyFolder',
		templateKey: 'monthlyTemplate',
		enabledKey: 'monthlyEnabled',
		assetFolderKey: 'monthlyCreateAssetFolder',
		movePinKey: 'moveFilePinMonthlyFolder',
	},
};

export function getPeriodMeta(period: PeriodId): PeriodMeta {
	return PERIOD_META[period];
}

export function getPeriodConfig(settings: CrucibleSettings, period: PeriodId): PeriodConfig {
	const meta = getPeriodMeta(period);
	return {
		...meta,
		enabled: Boolean(settings[meta.enabledKey]),
		folder: String(settings[meta.folderKey] ?? ''),
		template: String(settings[meta.templateKey] ?? ''),
		createAssetFolder: Boolean(settings[meta.assetFolderKey]),
		pinInMovePicker: Boolean(settings[meta.movePinKey]),
	};
}

export function getPeriodConfigByTarget(targetType: string, settings: CrucibleSettings): PeriodConfig | null {
	if (targetType === 'daily' || targetType === 'weekly' || targetType === 'monthly') {
		return getPeriodConfig(settings, targetType);
	}
	return null;
}

export function isPeriodEnabled(settings: CrucibleSettings, period: PeriodId): boolean {
	return getPeriodConfig(settings, period).enabled;
}

export function getCurrentPeriodAssetFolder(
	settings: CrucibleSettings,
	period: PeriodId,
	date: moment.Moment = window.moment(),
): string {
	const config = getPeriodConfig(settings, period);
	return normalizePath(`${config.folder}/${date.format(config.dateFormat)}`);
}

export function periodDisabledMessage(period: PeriodId): string {
	return `${getPeriodMeta(period).label} feature is disabled in settings.`;
}
