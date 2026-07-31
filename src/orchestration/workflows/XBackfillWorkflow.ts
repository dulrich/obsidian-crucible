import { TFile, normalizePath } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { extractXStatusFromUrl } from '../utils/xPost';
import { findExistingXMetadataNote, xMetadataRoot } from '../utils/xApi';

// Spacing for the enqueue burst — same shape as YoutubeChannelEnrichSweepWorkflow
// and XPostDiscoverWorkflow: each enqueue writes a row and kicks the drain, so a
// registry with many undiscovered statuses shouldn't stampede it.
const ENQUEUE_CHUNK = 10;
const ENQUEUE_CHUNK_PAUSE_MS = 200;
const DEFAULT_LINK_REGISTRY_ROOT = '_crucible/link_registry';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface AggregateStatus {
	/** First record's canonical/url value wins — later records citing the same
	 * status only contribute their source notes. */
	url: string;
	sourcePaths: Set<string>;
}

/**
 * Registry-only backfill: walks `orchestrationLinkRegistryRoot` for link-record
 * notes carrying an X status (`x-status-id`, falling back to `canonical_url` via
 * `xPost.ts`), skips anything already materialized (or tombstoned — the probe
 * doesn't distinguish), and enqueues one `x_metadata_fetch` per undiscovered
 * status, unioning `sourcePaths` when several records cite the same status.
 *
 * Mirrors `XPostDiscoverWorkflow`'s split — this fans out, `XMetadataFetchWorkflow`
 * does the actual fetch — and `YoutubeChannelEnrichSweepWorkflow`'s enqueue pacing.
 * Deliberately registry-only: `link_scan` is manual, so backfill coverage is
 * bounded by what the user has already scanned; the `x-discover-on-clip` founding
 * trigger covers newly clipped notes going forward. There is no link-registry read
 * API (per the plan's grounding notes), so this is a prefix walk over
 * `vault.getMarkdownFiles()`, not a dedicated index lookup.
 */
export class XBackfillWorkflow implements Workflow {
	async run(_job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const app = plugin.app;
		const registryRoot = normalizePath(plugin.settings.orchestrationLinkRegistryRoot || DEFAULT_LINK_REGISTRY_ROOT);
		const prefix = `${registryRoot}/`;

		let recordsScanned = 0;
		let droppedSourceLinks = 0;
		const aggregate = new Map<string, AggregateStatus>();

		for (const file of app.vault.getMarkdownFiles()) {
			ctx.throwIfAborted();
			if (!file.path.startsWith(prefix)) continue;
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm || fm['type'] !== 'link-record') continue;
			recordsScanned++;

			const statusId = resolveStatusId(fm);
			if (!statusId) continue;

			let entry = aggregate.get(statusId);
			if (!entry) {
				entry = { url: resolveUrl(fm, statusId), sourcePaths: new Set<string>() };
				aggregate.set(statusId, entry);
			}

			const { paths, dropped } = resolveSourcePaths(app, file, fm['source_notes']);
			droppedSourceLinks += dropped;
			for (const p of paths) entry.sourcePaths.add(p);
		}

		const statusesFound = aggregate.size;
		const root = xMetadataRoot(plugin);
		let alreadyMaterialized = 0;
		let enqueued = 0;
		let pendingInChunk = 0;

		for (const [statusId, entry] of aggregate) {
			// Per-status: this loop can fan out into hundreds of enqueues on a big
			// registry, and stopping it is the checkpoint that matters — statuses
			// already enqueued stay queued.
			ctx.throwIfAborted();
			const existing = await findExistingXMetadataNote(app, root, statusId);
			if (existing) {
				alreadyMaterialized++;
				continue;
			}
			await plugin.orchestrator.enqueue(
				'x_metadata_fetch',
				{ statusId, url: entry.url, sourcePaths: Array.from(entry.sourcePaths) },
				{ lane: 'background' },
			);
			enqueued++;
			if (++pendingInChunk >= ENQUEUE_CHUNK) {
				pendingInChunk = 0;
				await sleep(ENQUEUE_CHUNK_PAUSE_MS);
			}
		}

		return {
			status: 'done',
			notes: `Scanned ${recordsScanned} link-registry record(s): ${statusesFound} X status(es) found, `
				+ `${alreadyMaterialized} already materialized, ${enqueued} enqueued, `
				+ `${droppedSourceLinks} source link(s) dropped.`,
		};
	}
}

/** `x-status-id` (non-empty string) first, else derived from `canonical_url`
 * via `extractXStatusFromUrl`. Empty string means "no X status on this record". */
function resolveStatusId(fm: Record<string, unknown>): string {
	const direct = fm['x-status-id'];
	if (typeof direct === 'string' && direct.trim()) return direct.trim();
	const canonicalUrl = fm['canonical_url'];
	if (typeof canonicalUrl === 'string' && canonicalUrl) {
		const ref = extractXStatusFromUrl(canonicalUrl);
		if (ref) return ref.statusId;
	}
	return '';
}

function resolveUrl(fm: Record<string, unknown>, statusId: string): string {
	const canonicalUrl = fm['canonical_url'];
	if (typeof canonicalUrl === 'string' && canonicalUrl) return canonicalUrl;
	const url = fm['url'];
	if (typeof url === 'string' && url) return url;
	return `https://x.com/i/web/status/${statusId}`;
}

interface SourcePathResolution {
	paths: string[];
	dropped: number;
}

/** `source_notes` is normally an array of `[[<path-without-.md>]]` wikilinks
 * (`LinkScanWorkflow`'s shape); tolerate a legacy single string too. */
function wikilinksFromSourceNotes(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
	if (typeof value === 'string' && value) return [value];
	return [];
}

/**
 * Strips wikilink brackets, appends `.md`, and probes `getAbstractFileByPath`;
 * falls back to `getFirstLinkpathDest` (shorthand-link resolution relative to the
 * registry record) when the direct probe misses. Unresolvable entries are
 * dropped silently and counted — a link record can outlive the note it cites.
 */
function resolveSourcePaths(app: WorkflowContext['plugin']['app'], recordFile: TFile, sourceNotes: unknown): SourcePathResolution {
	const paths: string[] = [];
	let dropped = 0;
	for (const raw of wikilinksFromSourceNotes(sourceNotes)) {
		const linkpath = stripWikilink(raw);
		if (!linkpath) {
			dropped++;
			continue;
		}
		const directPath = linkpath.endsWith('.md') ? linkpath : `${linkpath}.md`;
		const direct = app.vault.getAbstractFileByPath(normalizePath(directPath));
		if (direct instanceof TFile) {
			paths.push(direct.path);
			continue;
		}
		const dest = app.metadataCache.getFirstLinkpathDest(linkpath, recordFile.path);
		if (dest instanceof TFile) {
			paths.push(dest.path);
			continue;
		}
		dropped++;
	}
	return { paths, dropped };
}

/** `[[path|alias]]` / `[[path#heading]]` → `path`; a bare (unbracketed) legacy
 * string passes through unchanged. */
function stripWikilink(raw: string): string {
	const trimmed = raw.trim().replace(/^\[\[/, '').replace(/\]\]$/, '');
	return trimmed.split('|')[0]?.split('#')[0]?.trim() ?? '';
}
