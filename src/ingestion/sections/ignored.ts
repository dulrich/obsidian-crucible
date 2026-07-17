import { loadIgnoredBlogIds, loadIgnoredVideoIds } from '../../orchestration/utils/ignoredIds';
import { renderTableSection } from '../render/section';
import { renderIgnoredIdCell, renderUnignoreButton } from '../render/cells';
import { blogIgnoreUrl } from '../render/format';
import type { DashboardHost, SectionContext } from '../render/types';

// --- Section: Ignored blogs ---
export async function renderIgnoredPosts(host: DashboardHost, body: HTMLElement, ctx: SectionContext): Promise<void> {
	const rows = Array.from(await loadIgnoredBlogIds(host.app)).map(id => ({ id }));
	renderTableSection<{ id: string }>({
		body, ctx, rows,
		emptyText: 'No ignored blogs.',
		defaultSort: { column: 'id', direction: 'asc' },
		setCount: n => host.setSectionCount('ignoredPosts', n),
		columns: [
			{ key: 'id', label: 'Blog ID', sortable: true, sortKey: r => r.id.toLowerCase(), render: (r, td) => renderIgnoredIdCell(td, r.id, blogIgnoreUrl(r.id)) },
			{ key: 'unignore', label: '', render: (r, td) => renderUnignoreButton(td, host.app, 'blog', r.id, ctx, () => void host.refresh('uncapturedPosts')) },
		],
	});
}

// --- Section: Ignored videos ---
export async function renderIgnoredVideos(host: DashboardHost, body: HTMLElement, ctx: SectionContext): Promise<void> {
	const rows = Array.from(await loadIgnoredVideoIds(host.app)).map(id => ({ id }));
	renderTableSection<{ id: string }>({
		body, ctx, rows,
		emptyText: 'No ignored videos.',
		defaultSort: { column: 'id', direction: 'asc' },
		setCount: n => host.setSectionCount('ignoredVideos', n),
		columns: [
			{ key: 'id', label: 'Video ID', sortable: true, sortKey: r => r.id.toLowerCase(), render: (r, td) => renderIgnoredIdCell(td, r.id, `https://www.youtube.com/watch?v=${r.id}`) },
			{ key: 'unignore', label: '', render: (r, td) => renderUnignoreButton(td, host.app, 'youtube', r.id, ctx, () => void host.refresh('uncapturedVideos')) },
		],
	});
}
