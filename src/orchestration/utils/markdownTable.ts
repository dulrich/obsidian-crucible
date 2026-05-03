export function parseTable(content: string, expectedHeaders: readonly string[]): Array<Record<string, string>> {
	const lines = content.split(/\r?\n/);
	const lowerExpected = expectedHeaders.map(h => h.toLowerCase());

	let headerIdx = -1;
	let headers: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const cells = splitRow(lines[i] ?? '');
		if (cells.length < lowerExpected.length) continue;
		const lowered = cells.map(c => c.toLowerCase());
		if (lowered[0] === lowerExpected[0]) {
			headers = cells;
			headerIdx = i;
			break;
		}
	}

	if (headerIdx === -1) return [];

	const delimiterLine = lines[headerIdx + 1] ?? '';
	if (!isDelimiterRow(delimiterLine)) return [];

	const rows: Array<Record<string, string>> = [];
	for (let i = headerIdx + 2; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (!line.trim().startsWith('|')) break;
		const cells = splitRow(line);
		if (cells.length === 0 || !cells[0]) break;
		const row: Record<string, string> = {};
		for (let h = 0; h < headers.length; h++) {
			const key = headers[h];
			if (!key) continue;
			row[key] = cells[h] ?? '';
		}
		rows.push(row);
	}

	return rows;
}

function splitRow(line: string): string[] {
	const trimmed = line.trim();
	if (!trimmed.startsWith('|')) return [];
	const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
	return inner.split('|').map(c => c.trim());
}

function isDelimiterRow(line: string): boolean {
	const cells = splitRow(line);
	if (cells.length === 0) return false;
	return cells.every(c => /^:?-+:?$/.test(c));
}
