import { normalizePath } from 'obsidian';

export interface LocalizedImageInfo {
	path: string;
	md5: string;
	ext: string;
	/**
	 * Legacy sidecar path convention (`<md5>_MD5.md` beside the image). Nothing writes here
	 * any more (WP-3 retired the sidecar pipeline — see `imageDescribe.ts`'s legacy import
	 * sweep), but the field stays because it is a pure derivation of `path` and the sweep
	 * still needs to recognize the old naming to import and trash it.
	 */
	sidecarPath: string;
}

export function localizedImageInfo(path: string): LocalizedImageInfo | null {
	const normalized = normalizePath(path);
	const name = normalized.split('/').pop() ?? '';
	const match = name.match(/([a-f0-9]{32})_MD5\.([A-Za-z0-9]+)$/i);
	if (!match?.[1] || !match?.[2]) return null;
	const sidecarPath = normalized.replace(/\.[^/.]+$/, '.md');
	return {
		path: normalized,
		md5: match[1].toLowerCase(),
		ext: match[2].toLowerCase(),
		sidecarPath,
	};
}

export function imageMimeType(ext: string): string {
	switch (ext.toLowerCase()) {
		case 'avif': return 'image/avif';
		case 'bmp': return 'image/bmp';
		case 'gif': return 'image/gif';
		case 'jpg':
		case 'jpeg': return 'image/jpeg';
		case 'png': return 'image/png';
		case 'svg': return 'image/svg+xml';
		case 'webp': return 'image/webp';
		default: return `image/${ext.toLowerCase()}`;
	}
}

/**
 * Pulls the `# Description` / `# Extracted text` bodies out of a legacy
 * `image_metadata_extract` sidecar note. Exported for `imageDescribe.ts`'s one-time import
 * sweep (`docs/multimodal-image-search.md` Decision 5: repurpose + migrate rather than drop
 * silently) — sidecar content becomes the `narrative`/`extraction` halves of an
 * `ImageDescriptionRecord` with `kind: 'imported'`.
 */
export function extractMetadataSections(content: string): { description: string; extractedText: string } {
	return {
		description: extractSection(content, 'Description'),
		extractedText: extractSection(content, 'Extracted text'),
	};
}

function extractSection(content: string, heading: string): string {
	const re = new RegExp(`^# ${escapeRegex(heading)}\\s*\\n([\\s\\S]*?)(?=\\n# |\\s*$)`, 'm');
	return re.exec(content)?.[1]?.trim() ?? '';
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
