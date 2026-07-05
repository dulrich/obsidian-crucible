export interface ControlPartition {
	total: number;
	ingested: number;
	ignored: number;
	uncaptured: number;
}

export function partitionControlUniverse(universe: Set<string>, ignored: Set<string>, captured: Set<string>): ControlPartition {
	let ignoredCount = 0;
	let ingested = 0;
	for (const id of universe) {
		if (ignored.has(id)) ignoredCount++;
		else if (captured.has(id)) ingested++;
	}
	return {
		total: universe.size,
		ingested,
		ignored: ignoredCount,
		uncaptured: Math.max(0, universe.size - ingested - ignoredCount),
	};
}
