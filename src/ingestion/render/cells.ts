import type { App, TFile } from 'obsidian';
import { Notice } from 'obsidian';
import type CruciblePlugin from '../../main';
import {
	addIgnoredBlogId,
	addIgnoredVideoId,
	removeIgnoredBlogId,
	removeIgnoredVideoId,
} from '../../orchestration/utils/ignoredIds';
import { parseMarkdownLink } from './format';
import type { IntakeKind, TableStateContext, UncapturedVideoRow } from './types';

// Stateless table-cell renderers (no vault access). Each appends into the given
// <td>; an external anchor opens in a new tab with rel=noopener.

export function renderExternalLink(td: HTMLElement, url: string, label: string): void {
	const a = td.createEl('a', { text: label, href: url });
	a.setAttr('target', '_blank');
	a.setAttr('rel', 'noopener');
}

export function renderChannelLink(td: HTMLElement, channelId: string, name: string): void {
	const md = parseMarkdownLink(name);
	const href = md?.url ?? `https://www.youtube.com/channel/${channelId}`;
	const label = md?.label ?? name;
	const a = td.createEl('a', { text: label, href });
	a.setAttr('target', '_blank');
	a.setAttr('rel', 'noopener');
}

export function renderAuthorCell(td: HTMLElement, name: string): void {
	const md = parseMarkdownLink(name);
	if (md) {
		const a = td.createEl('a', { text: md.label, href: md.url });
		a.setAttr('target', '_blank');
		a.setAttr('rel', 'noopener');
	} else {
		td.setText(name);
	}
}

export function renderIgnoredIdCell(td: HTMLElement, id: string, href: string | null): void {
	if (href) {
		const a = td.createEl('a', { text: id, href });
		a.setAttr('target', '_blank');
		a.setAttr('rel', 'noopener');
	} else {
		td.setText(id);
	}
}

// Vault-aware cell/button helpers shared across multiple sections (moved here
// from ingestionDashboard.ts during the WP-D2 decomposition).

export function renderFileLink(app: App, td: HTMLElement, file: TFile, label?: string): void {
	const a = td.createEl('a', { text: label ?? file.basename, href: '#' });
	a.addEventListener('click', evt => {
		evt.preventDefault();
		void app.workspace.openLinkText(file.path, '', false);
	});
}

export function renderOpenButton(app: App, td: HTMLElement, file: TFile): void {
	const btn = td.createEl('button', { text: 'Open' });
	btn.addEventListener('click', () => {
		void app.workspace.openLinkText(file.path, '', false);
	});
}

export function renderEnrichedCell(td: HTMLElement, plugin: CruciblePlugin, row: UncapturedVideoRow): void {
	if (row.enrichmentFile) {
		renderFileLink(plugin.app, td, row.enrichmentFile, 'metadata');
		return;
	}
	const queue = plugin.enrichmentQueue;
	const entry = queue?.getEntry(row.videoId) ?? null;
	if (entry && (entry.status === 'pending' || entry.status === 'running')) {
		td.setText(entry.status === 'running' ? 'enriching…' : 'queued');
		return;
	}
	const btn = td.createEl('button', { text: 'Enrich' });
	btn.addEventListener('click', () => {
		if (!queue) {
			new Notice('Enrichment service not available.');
			return;
		}
		const ok = queue.enqueue({
			videoId: row.videoId,
			title: row.title,
			channelName: row.channelName,
		});
		if (!ok) new Notice('Already queued or in progress.');
	});
}

// Adds the id to the ignored note, then refreshes the source list (the row
// drops out as it is now "seen") and the matching ignored section.
export function renderIgnoreButton(
	td: HTMLElement,
	app: App,
	kind: IntakeKind,
	id: string,
	ctx: TableStateContext,
	onIgnored: () => void,
): void {
	const btn = td.createEl('button', { text: 'Ignore' });
	btn.addEventListener('click', () => {
		void (async () => {
			btn.disabled = true;
			try {
				if (kind === 'youtube') await addIgnoredVideoId(app, id);
				else await addIgnoredBlogId(app, id);
			} catch (e) {
				new Notice(`Failed to ignore: ${e instanceof Error ? e.message : String(e)}`);
				btn.disabled = false;
				return;
			}
			void ctx.refresh();
			onIgnored();
		})();
	});
}

// Removes the id from the ignored note, then refreshes this section and the
// matching uncaptured section (where the item may reappear).
export function renderUnignoreButton(
	td: HTMLElement,
	app: App,
	kind: IntakeKind,
	id: string,
	ctx: TableStateContext,
	onUnignored: () => void,
): void {
	const btn = td.createEl('button', { text: 'Un-ignore' });
	btn.addEventListener('click', () => {
		void (async () => {
			btn.disabled = true;
			try {
				if (kind === 'youtube') await removeIgnoredVideoId(app, id);
				else await removeIgnoredBlogId(app, id);
			} catch (e) {
				new Notice(`Failed to un-ignore: ${e instanceof Error ? e.message : String(e)}`);
				btn.disabled = false;
				return;
			}
			void ctx.refresh();
			onUnignored();
		})();
	});
}
