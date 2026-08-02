import { normalizePath } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { todayInTz } from '../utils/dates';
import { ensureFolder } from '../../utils';
import { extractUrls } from '../utils/urlExtract';
import { canonicalizeUrl } from '../utils/urlCanonicalize';
import { AggregateEntry, applyLinkToRegistry, isExcluded, normalizeExclusions, wikilinkFor } from '../utils/linkRegistry';

/** WP-J1: same "every Nth item, plus the final one" convention `SearchManager.indexFiles`
 * uses for its own `onProgress` (`SEARCH_PROGRESS_EVERY_FILES` = 10) — fast enough to keep
 * the queue monitor's Progress cell current on a large vault scan, coarse enough that the
 * per-item store write (cheap, but still one indexed UPDATE) doesn't fire on every file. */
const LINK_SCAN_PROGRESS_EVERY_FILES = 10;

/** Pure gate for "should this iteration report progress" — always true on the last item
 * (so a scan/registry pass never ends on a stale count) or every `every`th one. Exported
 * for unit tests since `LinkScanWorkflow.run` itself needs a real vault to exercise. */
export function shouldReportLinkScanProgress(index: number, total: number, every = LINK_SCAN_PROGRESS_EVERY_FILES): boolean {
	if (total <= 0) return false;
	return index === total || index % every === 0;
}

/** Message shape for the vault-wide read pass. Exported for unit tests (pure/pinned). */
export function formatLinkScanScanProgress(scanned: number, total: number): string {
	return `scan ${scanned} / ${total} notes`;
}

/** Message shape for the registry write pass. Exported for unit tests (pure/pinned). */
export function formatLinkScanRegistryProgress(processed: number, total: number): string {
	return `registry ${processed} / ${total} records`;
}

export class LinkScanWorkflow implements Workflow {
	// Two loops, both instrumented: a vault-wide read pass and a registry write pass.
	// The read pass is pure aggregation into a local Map, so stopping in it costs
	// nothing beyond the reads already done; the write pass creates/updates one
	// link-record note per URL, and each is independent, so a partial pass is a
	// consistent vault that the next run simply completes.
	async run(_job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const app = plugin.app;
		const settings = plugin.settings;

		const registryRoot = normalizePath(settings.orchestrationLinkRegistryRoot);
		const exclusions = normalizeExclusions(settings.orchestrationLinkScanExclusions, registryRoot);
		const today = todayInTz(settings.orchestrationTimezone);

		await ensureFolder(app, registryRoot);

		const aggregate = new Map<string, AggregateEntry>();
		let scannedNotes = 0;

		const files = app.vault.getMarkdownFiles();
		let filesSeen = 0;
		for (const file of files) {
			ctx.throwIfAborted();
			filesSeen++;
			if (shouldReportLinkScanProgress(filesSeen, files.length)) {
				ctx.reportProgress(formatLinkScanScanProgress(filesSeen, files.length));
			}
			if (isExcluded(file.path, exclusions)) continue;
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			if (fm && fm['type'] === 'link-record') continue;

			scannedNotes++;
			const content = await app.vault.cachedRead(file);
			const urls = extractUrls(content);
			if (urls.length === 0) continue;

			const wikilink = wikilinkFor(file.path);

			for (const u of urls) {
				const canon = canonicalizeUrl(u.raw);
				if (!canon) continue;
				let entry = aggregate.get(canon.canonical);
				if (!entry) {
					entry = { canon, sourceWikilinks: new Set<string>() };
					aggregate.set(canon.canonical, entry);
				}
				entry.sourceWikilinks.add(wikilink);
			}
		}

		let created = 0;
		let updated = 0;
		let candidatesFlagged = 0;
		const outputPaths: string[] = [];

		const totalEntries = aggregate.size;
		let entriesProcessed = 0;
		for (const entry of aggregate.values()) {
			ctx.throwIfAborted();
			const result = await applyLinkToRegistry(plugin, registryRoot, today, entry);
			if (result.created) created++;
			else updated++;
			if (result.candidateFlagged) candidatesFlagged++;
			outputPaths.push(result.path);
			entriesProcessed++;
			if (shouldReportLinkScanProgress(entriesProcessed, totalEntries)) {
				ctx.reportProgress(formatLinkScanRegistryProgress(entriesProcessed, totalEntries));
			}
		}

		const notes =
			`Scanned ${scannedNotes} notes; touched ${aggregate.size} records ` +
			`(${created} new, ${updated} updated); ${candidatesFlagged} tracked-source candidates flagged.`;

		return {
			status: 'done',
			outputPaths,
			notes,
		};
	}
}
