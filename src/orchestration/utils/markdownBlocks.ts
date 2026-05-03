export function blockMarkers(key: string): { start: string; end: string } {
	return {
		start: `<!-- orchestration:${key}:start -->`,
		end: `<!-- orchestration:${key}:end -->`,
	};
}

export function replaceMarkedBlock(
	content: string,
	key: string,
	body: string,
	fallbackHeading?: string,
): string {
	const { start, end } = blockMarkers(key);
	const startIdx = content.indexOf(start);
	const endIdx = content.indexOf(end);

	if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
		const before = content.slice(0, startIdx + start.length);
		const after = content.slice(endIdx);
		return `${before}\n\n${body.trim()}\n\n${after}`;
	}

	if (!fallbackHeading) {
		return content;
	}

	const trimmed = content.replace(/\s+$/, '');
	const block = `\n\n## ${fallbackHeading}\n\n${start}\n\n${body.trim()}\n\n${end}\n`;
	return `${trimmed}${block}`;
}
