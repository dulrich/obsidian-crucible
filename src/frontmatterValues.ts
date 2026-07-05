export function stringProp(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

export function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim();
		if (Array.isArray(value)) {
			const found = value.find((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0);
			if (typeof found === 'string') return found.trim();
		}
	}
	return null;
}

export function stringList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const out = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
		return out.length > 0 ? out : undefined;
	}
	if (typeof value === 'string' && value.trim()) return [value.trim()];
	return undefined;
}

export function numberProp(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return null;
}

export function dateProp(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function yamlString(value: string): string {
	return JSON.stringify(value);
}
