// Pure (DOM-free) formatting and markdown-link parsing shared by the dashboard's
// render cells. No vault access — strings in, strings out.

const MD_LINK_RE = /^\s*\[([^\]]+)\]\(\s*<?([^)\s<>]+)>?\s*(?:"[^"]*"|'[^']*')?\s*\)\s*$/;

export function parseMarkdownLink(raw: string): { label: string; url: string } | null {
	if (!raw) return null;
	const m = raw.match(MD_LINK_RE);
	if (!m) return null;
	const label = (m[1] ?? '').trim();
	const url = (m[2] ?? '').trim();
	if (!label || !url) return null;
	return { label, url };
}

export function displayLabel(raw: string): string {
	return parseMarkdownLink(raw)?.label ?? raw;
}

// Ignored blog IDs are canonical URLs (postIdFromUrl), so link them directly;
// any non-URL value renders as plain text.
export function blogIgnoreUrl(id: string): string | null {
	return /^https?:\/\//i.test(id) ? id : null;
}

export function formatDate(epochMs: number): string {
	if (!epochMs) return '';
	const d = new Date(epochMs);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

export function formatDateTime(epochMs: number): string {
	if (!epochMs) return '';
	const d = new Date(epochMs);
	const date = formatDate(epochMs);
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	return `${date} ${hh}:${mm}`;
}

export function formatRelativeTime(epochMs: number): string {
	if (!epochMs) return '';
	const diff = Date.now() - epochMs;
	if (diff < 0) return 'just now';
	const sec = Math.floor(diff / 1000);
	if (sec < 60) return 'just now';
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const days = Math.floor(hr / 24);
	return `${days}d ago`;
}

// Builds the "last run X ago" header label from a list of ISO timestamps.
export function lastRunLabel(runAts: string[]): string {
	const latest = Math.max(0, ...runAts.map(r => Date.parse(r) || 0));
	if (!latest) return '';
	return `last run ${formatRelativeTime(latest)}`;
}

// Formats a duration in seconds as clock time (M:SS, or H:MM:SS past an hour).
// Returns "--" when unknown.
export function formatDuration(seconds: number | null): string {
	if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '--';
	const total = Math.floor(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => String(n).padStart(2, '0');
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function ratio(n: number, d: number): number {
	return d > 0 ? n / d : 0;
}

export function countWithPct(n: number, d: number): string {
	return d > 0 ? `${n} (${Math.round((n / d) * 100)}%)` : String(n);
}

export function formatPct(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return '--';
	return `${Math.round(value * 100)}%`;
}
