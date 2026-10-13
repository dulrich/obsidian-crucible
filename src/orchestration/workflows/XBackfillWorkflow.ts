import { TFile, normalizePath } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import type { LinkRecord } from '../db/LinkRegistryStore';
import { findExistingXMetadataNote, xMetadataRoot } from '../utils/xApi';

// Spacing for the enqueue burst — same shape as YoutubeChannelEnrichSweepWorkflow
// and XPostDiscoverWorkflow: each enqueue writes a row and kicks the drain, so a
// registry with many undiscovered statuses shouldn't stampede it.
const ENQUEUE_CHUNK = 10;
const ENQUEUE_CHUNK_PAUSE_MS = 200;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface AggregateStatus {
	/** First record's canonical/url value wins — later records citing the same
	 * status only contribute their source notes. */
	url: string;
	sourcePaths: Set<string>;
}

/**
 * Registry-only backfill: reads every `link_records` row carrying an X status id
 * (`LinkRegistryStore.listWithXStatus`, index-backed — the writer fills `x_status_id`
 * from `canonicalizeUrl` for every X status URL), skips anything already materialized (or tombstoned — the probe
 * doesn't distinguish), and enqueues one `x_metadata_fetch` per undiscovered
 * status, unioning `sourcePaths` when several records cite the same status.
 *
 * Mirrors `XPostDiscoverWorkflow`'s split — this fans out, `XMetadataFetchWorkflow`
 * does the actual fetch — and `YoutubeChannelEnrichSweepWorkflow`'s enqueue pacing.
 * Deliberately registry-only: `link_scan` is manual, so backfill coverage is
 * bounded by what the user has already scanned; the `x-discover-on-clip` founding
 * trigger covers newly clipped notes going forward.
 */
export class XBackfillWorkflow implements Workflow {
	async run(_job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const app = plugin.app;
		// Throws SqliteUnavailableError when the DB is unavailable — the run fails
		// visibly; there is no fallback to the legacy vault folder.
		const registry = plugin.orchestrator.linkRegistry();
		const recordsScanned = registry.count();
		let droppedSourceLinks = 0;
		const aggregate = new Map<string, AggregateStatus>();

		for (const record of registry.listWithXStatus()) {
			ctx.throwIfAborted();
			const statusId = (record.xStatusId ?? '').trim();
			if (!statusId) continue;

			let entry = aggregate.get(statusId);
			if (!entry) {
				entry = { url: resolveUrl(record, statusId), sourcePaths: new Set<string>() };
				aggregate.set(statusId, entry);
			}

			const { paths, dropped } = resolveSourcePaths(app, record.sourceNotes);
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

function resolveUrl(record: LinkRecord, statusId: string): string {
	if (record.canonicalUrl) return record.canonicalUrl;
	if (record.url) return record.url;
	return `https://x.com/i/web/status/${statusId}`;
}

interface SourcePathResolution {
	paths: string[];
	dropped: number;
}

/**
 * Strips wikilink brackets, appends `.md`, and probes `getAbstractFileByPath`;
 * falls back to `getFirstLinkpathDest` (shorthand-link resolution from the vault
 * root — records are no longer vault notes) when the direct probe misses. Unresolvable entries are
 * dropped silently and counted — a link record can outlive the note it cites.
 */
function resolveSourcePaths(app: WorkflowContext['plugin']['app'], sourceNotes: readonly string[]): SourcePathResolution {
	const paths: string[] = [];
	let dropped = 0;
	for (const raw of sourceNotes) {
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
		const dest = app.metadataCache.getFirstLinkpathDest(linkpath, '');
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
