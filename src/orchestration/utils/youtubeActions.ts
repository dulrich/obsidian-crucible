export function youtubeVideoIdFromFrontmatter(fm: Record<string, unknown> | undefined): string {
	if (!fm) return '';
	return coerceVideoIdLike(fm.videoId) || coerceVideoIdLike(fm['yt-video-id']);
}

export function youtubeVideoIdFromArgsOrFrontmatter(
	args: Record<string, string>,
	fm: Record<string, unknown> | undefined,
): string {
	return coerceVideoIdLike(args.videoId) || youtubeVideoIdFromFrontmatter(fm);
}

export function youtubeWatchUrlFromFrontmatter(fm: Record<string, unknown> | undefined): string {
	const url = typeof fm?.url === 'string' ? fm.url.trim() : '';
	if (url) return url;
	const videoId = youtubeVideoIdFromFrontmatter(fm);
	return videoId ? `https://www.youtube.com/watch?v=${videoId}` : '';
}

export function youtubeWatchUrlFromArgsOrFrontmatter(
	args: Record<string, string>,
	fm: Record<string, unknown> | undefined,
): string {
	const url = args.url?.trim();
	return url || youtubeWatchUrlFromFrontmatter(fm);
}

function coerceVideoIdLike(value: unknown): string {
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number') return String(value).trim();
	if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === 'string' && item.trim()) return item.trim();
		}
	}
	return '';
}
