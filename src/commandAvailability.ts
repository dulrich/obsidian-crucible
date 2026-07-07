import type { CrucibleCommandEntry } from './main';

export function commandAvailabilityHelp(command: Pick<CrucibleCommandEntry, 'availabilityHelp'>): string | null {
	return command.availabilityHelp?.() ?? null;
}

export function featureDisabledCommandIds(commands: Pick<CrucibleCommandEntry, 'id' | 'availabilityHelp'>[]): string[] {
	return commands
		.filter(command => commandAvailabilityHelp(command) !== null)
		.map(command => command.id);
}

export function featureDisabledCommandExcludeIds(
	commands: Pick<CrucibleCommandEntry, 'id' | 'availabilityHelp'>[],
	pluginId: string,
): string[] {
	return featureDisabledCommandIds(commands)
		.flatMap(id => [id, `${pluginId}:${id}`, `crucible:${id}`]);
}

export function mergeCommandExcludeIds(...groups: string[][]): string[] {
	const seen = new Set<string>();
	for (const group of groups) {
		for (const id of group) seen.add(id);
	}
	return Array.from(seen);
}
