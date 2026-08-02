import type { App, TFile } from 'obsidian';
import { Notice, setIcon } from 'obsidian';
import {
	addIgnoredBlogId,
	addIgnoredVideoId,
} from '../../orchestration/utils/ignoredIds';
import { ENRICHMENT_JOB_TYPE } from '../../orchestration/jobTypeConfig';
import { markSelfRefreshedForEcho } from './echoSuppress';
import { parseMarkdownLink } from './format';
import type { DashboardHost, IntakeKind, SectionId, TableStateContext } from './types';

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

// --- WP-DP1: uniform icon-only intake action button ---
//
// The single primitive every intake row action (external/meta/command/skip, all
// four sections) is expressed through. `onClick` receives the button itself so a
// caller can disable it for the duration of its own async work without a second DOM
// query. `disabled` renders the
// "muted, never absent" treatment (rule 1: a deactivated action stays in the row,
// explained by `title`, instead of being omitted) and — when set — `onClick` is
// simply never wired, so a disabled button can never fire stale logic.
export interface IconButtonOptions {
	ariaLabel: string;
	title: string;
	cls?: string;
	disabled?: boolean;
	onClick?: (btn: HTMLButtonElement) => void;
}

export function renderIconButton(td: HTMLElement, icon: string, opts: IconButtonOptions): HTMLButtonElement {
	const btn = td.createEl('button', { cls: 'crucible-intake-icon-btn' });
	if (opts.cls) btn.addClass(opts.cls);
	setIcon(btn, icon);
	btn.setAttr('aria-label', opts.ariaLabel);
	btn.setAttr('title', opts.title);
	if (opts.disabled) {
		btn.disabled = true;
		btn.addClass('is-muted');
	} else if (opts.onClick) {
		const handler = opts.onClick;
		btn.addEventListener('click', () => handler(btn));
	}
	return btn;
}

// Slot 1 (external Read/Watch). WP-DP1's design table makes this icon-only +
// `window.open` (the same pattern as src/internalCommands.ts's external-open
// command) rather than renderExternalLink's labeled anchor — a deliberate, scoped
// exception to "never icon-only for an external destination" (root AGENTS.md) for
// this uniform 4-slot action-cell language. `title` carries the destination since
// the button itself carries no visible label. renderExternalLink is untouched and
// still used where that rule applies (controlCenters.ts).
export function renderExternalIconButton(td: HTMLElement, url: string | null, ariaLabel: string): void {
	if (!url) {
		renderIconButton(td, 'external-link', { ariaLabel, title: 'No URL available', disabled: true });
		return;
	}
	renderIconButton(td, 'external-link', {
		ariaLabel,
		title: url,
		onClick: () => window.open(url, '_blank', 'noopener'),
	});
}

// Slot 2 (meta, in-tool nav). Shared by both Posts sections and by Videos sections
// wherever they don't need the extra enriching/queued branch (Ignored Videos, and
// Uncaptured Videos once the enrichment file exists — see uncapturedVideos.ts for
// its 3-branch inline version covering the in-flight case).
export function renderMetaIconButton(td: HTMLElement, app: App, file: TFile | null, mutedTitle: string): void {
	if (!file) {
		renderIconButton(td, 'file-text', { ariaLabel: 'Metadata', title: mutedTitle, disabled: true });
		return;
	}
	renderIconButton(td, 'file-text', {
		ariaLabel: 'Metadata',
		title: 'Metadata',
		onClick: () => { void app.workspace.openLinkText(file.path, '', false); },
	});
}

// Shared by renderClipButton/renderEnrichButton below: once the primary action
// succeeds, an Uncaptured-section click only needs its own list to refresh (the row
// disappears once captured/enriched). An Ignored-section click un-ignores first
// (`opts.beforeRun`), so success also needs the companion Uncaptured list to pick the
// item back up — same dual-refresh-plus-echo-suppression shape renderIgnoreButton/
// the old renderUnignoreButton used for the Ignore/Un-ignore pair.
interface PrimaryActionOpts {
	beforeRun?: () => Promise<void>;
	ownSectionId?: SectionId;
	companionSectionId?: SectionId;
}

function dispatchPrimaryActionRefresh(host: DashboardHost, ctx: TableStateContext, opts?: PrimaryActionOpts): void {
	if (opts && opts.ownSectionId && opts.companionSectionId) {
		markSelfRefreshedForEcho(opts.ownSectionId);
		markSelfRefreshedForEcho(opts.companionSectionId);
		void ctx.refresh();
		void host.refresh(opts.companionSectionId);
	} else {
		void ctx.refresh();
	}
}

// Slot 3 (posts): Clip — replaces the old label+icon Ingest button. `blockedTitle`
// (blogsApi.ts's blogClipBlockedTitle, or a section-computed degrade override) drives
// the muted/disabled state per "muted, never absent": non-null skips wiring a click
// handler entirely, so a blocked button can't fire. `opts.beforeRun` is the
// Ignored-section un-ignore pre-step (rule 4) — awaited before `run`, so a failure
// after un-ignore still leaves the id un-ignored (the row simply reappears in
// Uncaptured Posts on refresh instead of being clipped).
//
// `run` (the actual `runBlogIngestCommand` call + its own status-specific Notice) is
// supplied by the caller rather than called directly from here: cells.ts stays free
// of a build-graph dependency on blogsApi.ts (which pulls in `htmlToMarkdown`/
// `parseYaml` — several test harnesses that bundle cells.ts via a minimal obsidian
// stub, e.g. tests/queueMonitorJobDetail.test.mjs, don't provide those exports).
// `run` returns `true` on success (triggers the post-success refresh dispatch) or
// `false` on a handled failure (caller already showed its own Notice; the button just
// re-enables) — an unexpected throw from `run`/`opts.beforeRun` is caught here with a
// generic Notice and also re-enables.
export function renderClipButton(
	td: HTMLElement,
	host: DashboardHost,
	blockedTitle: string | null,
	ctx: TableStateContext,
	run: (btn: HTMLButtonElement) => Promise<boolean>,
	opts?: PrimaryActionOpts,
): void {
	if (blockedTitle) {
		renderIconButton(td, 'download', { ariaLabel: 'Clip', title: blockedTitle, disabled: true });
		return;
	}
	renderIconButton(td, 'download', {
		ariaLabel: 'Clip',
		title: 'Clip',
		onClick: btn => {
			void (async () => {
				btn.disabled = true;
				let ok: boolean;
				try {
					if (opts?.beforeRun) await opts.beforeRun();
					ok = await run(btn);
				} catch (e) {
					new Notice(`Clip failed: ${e instanceof Error ? e.message : String(e)}`);
					btn.disabled = false;
					return;
				}
				if (!ok) {
					btn.disabled = false;
					return;
				}
				dispatchPrimaryActionRefresh(host, ctx, opts);
			})();
		},
	});
}

// Slot 3 (videos): Enrich — same shape as renderClipButton above, including the
// Ignored-section un-ignore pre-step. The click goes through `enqueueAndRun` — the
// same path the "captures without metadata" section uses — so a manual click drains
// immediately regardless of the auto-run gate, and a duplicate collapses onto the
// existing job (the backend's dedupe) instead of being rejected outright.
export function renderEnrichButton(
	td: HTMLElement,
	host: DashboardHost,
	params: { videoId: string; title: string; channelName: string },
	blockedTitle: string | null,
	ctx: TableStateContext,
	opts?: PrimaryActionOpts,
): void {
	if (blockedTitle) {
		renderIconButton(td, 'sparkles', { ariaLabel: 'Enrich', title: blockedTitle, disabled: true });
		return;
	}
	renderIconButton(td, 'sparkles', {
		ariaLabel: 'Enrich',
		title: 'Enrich',
		onClick: btn => {
			void (async () => {
				btn.disabled = true;
				try {
					if (opts?.beforeRun) await opts.beforeRun();
					const runner = host.plugin.orchestrationAutoRunner;
					if (!runner) {
						new Notice('Enrichment service not available.');
						btn.disabled = false;
						return;
					}
					const job = await runner.enqueueAndRun(ENRICHMENT_JOB_TYPE, params, { priority: 'high', lane: 'user' });
					if (!job) {
						btn.disabled = false;
						return;
					}
				} catch (e) {
					new Notice(`Enrich failed: ${e instanceof Error ? e.message : String(e)}`);
					btn.disabled = false;
					return;
				}
				dispatchPrimaryActionRefresh(host, ctx, opts);
			})();
		},
	});
}

// Slot 4 (Skip — Uncaptured sections only; WP-DP1 rule 4: Ignored sections have no
// Skip button). Reversible, warn-hue (never mod-warning), same write path and
// dual-refresh/echo-suppression shape as renderIgnoreButton below, whose eye-off/
// "Ignore" treatment stays in place for its one remaining caller
// (youtubeWithoutMetadata.ts — out of WP-DP1 scope, still referencing it).
export function renderSkipButton(
	td: HTMLElement,
	host: DashboardHost,
	kind: IntakeKind,
	id: string,
	ownSectionId: SectionId,
	companionSectionId: SectionId,
	ctx: TableStateContext,
): void {
	renderIconButton(td, 'circle-x', {
		ariaLabel: 'Skip',
		title: 'Skip',
		cls: 'crucible-intake-warn-btn',
		onClick: btn => {
			void (async () => {
				btn.disabled = true;
				try {
					if (kind === 'youtube') await addIgnoredVideoId(host.app, id);
					else await addIgnoredBlogId(host.app, id);
				} catch (e) {
					new Notice(`Failed to skip: ${e instanceof Error ? e.message : String(e)}`);
					btn.disabled = false;
					return;
				}
				markSelfRefreshedForEcho(ownSectionId);
				markSelfRefreshedForEcho(companionSectionId);
				void ctx.refresh();
				void host.refresh(companionSectionId);
			})();
		},
	});
}

// Adds the id to the ignored note, then refreshes the source list (the row drops out
// as it is now "seen") and the matching ignored section — both immediately, so the
// action feels instant. That same write also fires a vault/metadataCache event the
// dashboard's own listener would otherwise use to schedule a second, redundant
// refresh of these exact two sections a moment later (the "Ignore flashes twice"
// bug); `markSelfRefreshedForEcho` tells that listener to skip the echo it already
// knows is stale by the time it would run. See echoSuppress.ts.
//
// WP-DP1: kept only for youtubeWithoutMetadata.ts (out of scope for this WP) — the
// four sections covered here (Uncaptured/Ignored Posts/Videos) now use
// renderSkipButton above instead.
export function renderIgnoreButton(
	td: HTMLElement,
	host: DashboardHost,
	kind: IntakeKind,
	id: string,
	ownSectionId: SectionId,
	companionSectionId: SectionId,
	ctx: TableStateContext,
): void {
	// icon-only, warning-tier (reversible, not destructive — no mod-warning).
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
