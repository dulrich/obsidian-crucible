/**
 * Markdown section helpers used by capture targeting and orchestration
 * workflows. A "section" is the range starting on a heading line (e.g. `## My
 * heading`) and running until the next heading at the same or shallower level,
 * a horizontal rule, or end of file. Sub-headings stay inside their parent.
 */

export interface SectionRange {
	/** Index (in `lines`) of the heading line itself. */
	headerIndex: number;
	/** Index of the first line *after* the section ends. */
	endIndex: number;
	/** Heading level (count of leading `#`s); 0 if `header` had none. */
	level: number;
}

export type SectionInsertMode = 'append' | 'prepend' | 'replace';

const HEADER_PREFIX = /^(#+)\s/;

export function findSectionRange(content: string, header: string): SectionRange | null {
	const headerTrimmed = header.trim();
	if (!headerTrimmed) return null;

	const lines = content.split('\n');
	const headerIndex = lines.findIndex(l => l.trim() === headerTrimmed);
	if (headerIndex === -1) return null;

	const levelMatch = headerTrimmed.match(/^(#+)/);
	const level = levelMatch ? levelMatch[1]!.length : 0;

	let endIndex = lines.length;
	for (let i = headerIndex + 1; i < lines.length; i++) {
		const trimmed = (lines[i] ?? '').trim();
		const headMatch = trimmed.match(HEADER_PREFIX);
		// A heading terminates the section when it's at the same or shallower
		// level. If the supplied header had no level (level === 0) any heading
		// terminates the section — the caller is using a non-heading anchor.
		if (headMatch && (level === 0 || headMatch[1]!.length <= level)) { endIndex = i; break; }
		if (trimmed === '---') { endIndex = i; break; }
	}

	return { headerIndex, endIndex, level };
}

export function isSectionEmpty(content: string, header: string): boolean {
	const range = findSectionRange(content, header);
	if (!range) return true;
	const lines = content.split('\n');
	for (let i = range.headerIndex + 1; i < range.endIndex; i++) {
		if ((lines[i] ?? '').trim() !== '') return false;
	}
	return true;
}

/**
 * Insert `payload` into the section anchored by `header`. The payload is
 * spliced as a single entry — internal `\n`s are preserved, and the caller
 * controls any blank-line padding by including it in `payload`.
 *
 * If the section is missing, it is appended to the end of the document with a
 * blank line between header and body.
 */
export function insertIntoSection(
	content: string,
	header: string,
	payload: string,
	mode: SectionInsertMode,
): string {
	const headerTrimmed = header.trim();
	const range = findSectionRange(content, headerTrimmed);

	if (!range) {
		const separator = content.trim() ? '\n\n' : '';
		const headerPart = headerTrimmed ? `${headerTrimmed}\n\n` : '';
		return `${content.trimEnd()}${separator}${headerPart}${payload}`;
	}

	const lines = content.split('\n');
	const { headerIndex, endIndex } = range;

	if (mode === 'replace') {
		lines.splice(headerIndex + 1, endIndex - (headerIndex + 1), payload);
	} else if (mode === 'prepend') {
		lines.splice(headerIndex + 1, 0, payload);
	} else {
		// append: after the last non-blank line in the section, or right after
		// the heading if the section currently has no content.
		let insertIndex = headerIndex + 1;
		for (let i = endIndex - 1; i > headerIndex; i--) {
			if ((lines[i] ?? '').trim() !== '') { insertIndex = i + 1; break; }
		}
		lines.splice(insertIndex, 0, payload);
	}

	return lines.join('\n');
}
