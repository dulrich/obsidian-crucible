import { Notice } from 'obsidian';
import type CruciblePlugin from '../main';
import type { JobType } from './types';

export function shouldShowRoutineJobNotice(plugin: CruciblePlugin, type: JobType): boolean {
	return plugin.settings.orchestrationRoutineNoticesEnabled?.[type] === true;
}

export function routineJobNotice(plugin: CruciblePlugin, type: JobType, message: string): void {
	if (shouldShowRoutineJobNotice(plugin, type)) new Notice(message);
}
