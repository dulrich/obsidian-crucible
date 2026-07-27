/**
 * In-renderer WebP/AVIF -> PNG transcoding, and plain-text extraction from SVG markup.
 *
 * `docs/multimodal-image-search.md`'s "Transcoding" section: Crucible runs inside Obsidian's
 * Electron renderer, which decodes WebP and AVIF natively, so no dependency is needed —
 * `createImageBitmap` into an `OffscreenCanvas`, then `convertToBlob({type:'image/png'})`, done
 * entirely in memory at request time. This module never writes a file: a transcoded copy landing
 * in the vault would be a second file for the same content, outside the `_MD5` naming convention
 * and therefore invisible to the orphan-attachment scan and to re-localize idempotence.
 *
 * The decision (`needsVisionTranscode`) and the DOM-dependent renderer (`transcodeToPng`) are
 * split on purpose so the decision is testable under plain `node --test` without a DOM. This
 * module imports nothing from `obsidian`.
 *
 * SVGs are a separate, much cheaper case: an SVG is text, so `extractSvgText` pulls `<title>`,
 * `<desc>` and `<text>` (including nested `<tspan>`) content out directly, no model involved.
 */

const VISION_TRANSCODE_EXTENSIONS = new Set(['webp', 'avif']);

/** Pure; case-insensitive; accepts a bare extension with or without a leading dot. */
export function needsVisionTranscode(ext: string): boolean {
	const normalized = ext.trim().toLowerCase().replace(/^\./, '');
	return VISION_TRANSCODE_EXTENSIONS.has(normalized);
}

/**
 * Renderer-only: requires `createImageBitmap`/`OffscreenCanvas`, so it only runs inside
 * Obsidian's Electron renderer (or a browser test environment that stubs them), never under
 * plain `node --test`. Never writes a file — see the module doc.
 */
export async function transcodeToPng(bytes: ArrayBuffer, mime: string): Promise<{ bytes: ArrayBuffer; mime: 'image/png' }> {
	const blob = new Blob([bytes], { type: mime });
	const bitmap = await createImageBitmap(blob);
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('transcodeToPng: failed to acquire an OffscreenCanvas 2d context');
	ctx.drawImage(bitmap, 0, 0);
	const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
	const pngBytes = await pngBlob.arrayBuffer();
	return { bytes: pngBytes, mime: 'image/png' };
}

const SVG_TEXT_TAG_RE = /<(title|desc|text)\b[^>]*>([\s\S]*?)<\/\1>/gi;

function decodeXmlEntities(text: string): string {
	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, '\'')
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
		.replace(/&amp;/g, '&');
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * Pure. Concatenates `<title>`, `<desc>` and `<text>` (nested `<tspan>` markup inside a `<text>`
 * element is stripped, not skipped — its text content is kept) in document order, one line per
 * matched element, whitespace-collapsed. Returns `''` when nothing usable is present.
 */
export function extractSvgText(svg: string): string {
	const lines: string[] = [];
	let match: RegExpExecArray | null;
	SVG_TEXT_TAG_RE.lastIndex = 0;
	while ((match = SVG_TEXT_TAG_RE.exec(svg)) !== null) {
		const inner = match[2] ?? '';
		const withoutNestedTags = inner.replace(/<[^>]*>/g, ' ');
		const line = collapseWhitespace(decodeXmlEntities(withoutNestedTags));
		if (line) lines.push(line);
	}
	return lines.join('\n');
}
