import type { App, TFile } from 'obsidian';
import { Notice, setIcon } from 'obsidian';
import type CruciblePlugin from '../../main';
import {
	addIgnoredBlogId,
	addIgnoredVideoId,
	removeIgnoredBlogId,
	removeIgnoredVideoId,
} from '../../orchestration/utils/ignoredIds';
import { ENRICHMENT_JOB_TYPE } from '../../orchestration/jobTypeConfig';
import { markSelfRefreshedForEcho } from './echoSuppress';
import { parseMarkdownLink } from './format';
import type { DashboardHost, IntakeKind, SectionId, TableStateContext, UncapturedVideoRow } from './types';

// Stateless table-cell renderers (no vault access). Each appends into the given
// <td>; an external anchor opens in a new tab with rel=noopener.

export function renderExternalLink(td: HTMLElement, url: string, label: string): void {
	const a = td.createEl('a', { text: label, href: url });
	a.setAttr('target', '_blank');
	a.setAttr('rel', 'noopener');
	// WP-IC1: a trailing glyph marks every one of this helper's call sites as an
	// external destination (read/watch links, channel/author links elsewhere all use
	// their own renderers) — 12px, inherits the anchor's color via currentColor, and
	// stays un-underlined via the dedicated class even if the anchor itself is styled
	// with an underline.
	const icon = a.createSpan({ cls: 'crucible-external-link-icon' });
	setIcon(icon, 'external-link');
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

// CC-11 icon-label button: a lucide glyph plus the visible label text, appended
// straight into `td` (same "icon then span" shape as the Export JSONL button in
// sourceEvalDashboard.ts). Used for the intake action cell's Ingest (`import`) and
// Enrich (`sparkles`) actions. Creation only — `onClickWiring` receives the button
// so the caller attaches its own click handler exactly as before; this helper does
// not touch click behavior, disable-on-click, or any refresh sequencing.
export function renderIconLabelButton(
	td: HTMLElement,
	iconName: string,
	label: string,
	onClickWiring: (btn: HTMLButtonElement) => void,
): void {
	const btn = td.createEl('button');
	setIcon(btn, iconName);
	btn.createSpan({ text: ` ${label}` });
	onClickWiring(btn);
}

/**
 * The Uncaptured Videos "Enriched?" cell.
 *
 * `inFlight` is passed in rather than looked up here (thq WP-8): the queue is durable
 * now, so a per-row status lookup would be a per-row query on a table that already
 * computed the whole map once for its repaint signature. Passing it also keeps this
 * function synchronous, which the column renderer requires.
 *
 * The Enrich click goes through `enqueueAndRun` — the same path the "captures without
 * metadata" section uses — so a manual click drains immediately regardless of the
 * auto-run gate, and a duplicate collapses onto the existing job (the backend's dedupe)
 * instead of being rejected outright as the memory queue's `enqueue` did.
 */
export function renderEnrichedCell(
	td: HTMLElement,
	plugin: CruciblePlugin,
	row: UncapturedVideoRow,
	inFlight: 'queued' | 'running' | null,
): void {
	if (row.enrichmentFile) {
		renderFileLink(plugin.app, td, row.enrichmentFile, 'metadata');
		return;
	}
	if (inFlight) {
		td.setText(inFlight === 'running' ? 'enriching…' : 'queued');
		return;
	}
	renderIconLabelButton(td, 'sparkles', 'Enrich', btn => {
		btn.addEventListener('click', () => {
			void (async () => {
				const runner = plugin.orchestrationAutoRunner;
				if (!runner) {
					new Notice('Enrichment service not available.');
					return;
				}
				btn.disabled = true;
				const job = await runner.enqueueAndRun(ENRICHMENT_JOB_TYPE, {
					videoId: row.videoId,
					title: row.title,
					channelName: row.channelName,
				}, { priority: 'high', lane: 'user' });
				if (job) btn.setText('Queued');
				else btn.disabled = false;
			})();
		});
	});
}

// Adds the id to the ignored note, then refreshes the source list (the row drops out
// as it is now "seen") and the matching ignored section — both immediately, so the
// action feels instant. That same write also fires a vault/metadataCache event the
// dashboard's own listener would otherwise use to schedule a second, redundant
// refresh of these exact two sections a moment later (the "Ignore flashes twice"
// bug); `markSelfRefreshedForEcho` tells that listener to skip the echo it already
// knows is stale by the time it would run. See echoSuppress.ts.
export function renderIgnoreButton(
	td: HTMLElement,
	host: DashboardHost,
	kind: IntakeKind,
	id: string,
	ownSectionId: SectionId,
	companionSectionId: SectionId,
	ctx: TableStateContext,
): void {
	// WP-IC1: icon-only, warning-tier (reversible, not destructive — no mod-warning).
	const btn = td.createEl('button', { cls: 'crucible-intake-warn-btn' });
	setIcon(btn, 'eye-off');
	btn.setAttr('aria-label', 'Ignore');
	btn.setAttr('title', 'Ignore');
	btn.addEventListener('click', () => {
		void (async () => {
			btn.disabled = true;
			try {
				if (kind === 'youtube') await addIgnoredVideoId(host.app, id);
				else await addIgnoredBlogId(host.app, id);
			} catch (e) {
				new Notice(`Failed to ignore: ${e instanceof Error ? e.message : String(e)}`);
				btn.disabled = false;
				return;
			}
			markSelfRefreshedForEcho(ownSectionId);
			markSelfRefreshedForEcho(companionSectionId);
			void ctx.refresh();
			void host.refresh(companionSectionId);
		})();
	});
}

// Removes the id from the ignored note, then refreshes this section and the matching
// uncaptured section (where the item may reappear) — same immediate-refresh-plus-
// echo-suppression shape as renderIgnoreButton above.
export function renderUnignoreButton(
	td: HTMLElement,
	host: DashboardHost,
	kind: IntakeKind,
	id: string,
	ownSectionId: SectionId,
	companionSectionId: SectionId,
	ctx: TableStateContext,
): void {
	// WP-IC1: icon-only, warning-tier — same treatment as renderIgnoreButton above.
	const btn = td.createEl('button', { cls: 'crucible-intake-warn-btn' });
	setIcon(btn, 'eye');
	btn.setAttr('aria-label', 'Un-ignore');
	btn.setAttr('title', 'Un-ignore');
	btn.addEventListener('click', () => {
		void (async () => {
			btn.disabled = true;
			try {
				if (kind === 'youtube') await removeIgnoredVideoId(host.app, id);
				else await removeIgnoredBlogId(host.app, id);
			} catch (e) {
				new Notice(`Failed to un-ignore: ${e instanceof Error ? e.message : String(e)}`);
				btn.disabled = false;
				return;
			}
			markSelfRefreshedForEcho(ownSectionId);
			markSelfRefreshedForEcho(companionSectionId);
			void ctx.refresh();
			void host.refresh(companionSectionId);
		})();
	});
}
