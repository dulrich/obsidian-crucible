import { TFile } from 'obsidian';
import { updateFrontmatter } from '../../frontmatter';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import {
	XApiUnavailableError,
	XEnsureResult,
	ensureXMetadataNote,
	xMetadataRoot,
	xOembedDeferredResult,
} from '../utils/xApi';
import { canonicalXStatusUrl } from '../utils/xPost';

// Per-status job: ensureXMetadataNote (find-or-fetch-create, under the
// `x-post::<id>` resource lock) does the materialization, and — when the job
// carries `sourcePaths` — this workflow then stamps each source note's
// `x-metadata` frontmatter list with a wikilink to the result. Modeled on
// YoutubeMetadataFetchWorkflow: no constructor, everything reached via
// `ctx.plugin`.
//
// Lock ordering (root AGENTS.md): note lock BEFORE resource lock, never the
// reverse. `ensureXMetadataNote` takes the resource lock and its promise has
// fully resolved — releasing it — before any note lock below is acquired.
// Stamping is sequential after that await, never nested inside it.
export class XMetadataFetchWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const params = job.params ?? {};
		const statusId = typeof params.statusId === 'string' ? params.statusId.trim() : '';
		if (!statusId) {
			return { status: 'failed', error: 'Missing params.statusId' };
		}
		const url = typeof params.url === 'string' && params.url
			? params.url
			: canonicalXStatusUrl(null, statusId);
		const sourcePaths = dedupeSourcePaths(params.sourcePaths);

		let ensured: XEnsureResult;
		try {
			ensured = await ensureXMetadataNote(plugin, statusId, url);
		} catch (e) {
			// The oEmbed endpoint itself is down/throttled — a service-level
			// deferral, not a per-job failure. See XApiUnavailableError's class doc.
			if (e instanceof XApiUnavailableError) return xOembedDeferredResult(e);
			throw e;
		}

		if (ensured.status === 'invalid') {
			return { status: 'failed', error: `Invalid statusId: ${statusId}` };
		}

		ctx.throwIfAborted();
		const stamp = await stampSourceNotes(plugin, ensured.metadataPath, sourcePaths);

		const unavailablePrefix = `${xMetadataRoot(plugin)}/_unavailable/`;
		const isUnavailablePath = ensured.metadataPath.startsWith(unavailablePrefix);
		let notes = outcomeNotes(ensured.status, statusId, isUnavailablePath);
		if (sourcePaths.length > 0) {
			notes += ` Stamped ${stamp.stamped} source note(s)`
				+ `${stamp.skipped ? `, skipped ${stamp.skipped} non-file path(s)` : ''}.`;
		}

		const result: WorkflowResult = { status: 'done', outputPaths: [ensured.metadataPath], notes };
		return this.emitEnriched(plugin, result, statusId, stamp.sourceFiles);
	}

	/**
	 * Emits `x-metadata-enriched` for a successful (`done`) run once the metadata
	 * path resolves to a real `TFile` — mirror of `YoutubeMetadataFetchWorkflow
	 * .emitEnriched`'s guards. Fires for tombstoned outcomes too: `done` already
	 * covers created/exists/tombstoned alike (a durable record, dead or alive, is
	 * a successful materialization), and the dashboard wants to know either way.
	 */
	private emitEnriched(
		plugin: WorkflowContext['plugin'],
		result: WorkflowResult,
		statusId: string,
		sourceFiles: TFile[],
	): WorkflowResult {
		if (result.status !== 'done') return result;
		const bus = plugin.ingestionEvents;
		if (!bus) return result;
		const metadataPath = result.outputPaths?.[0];
		if (!metadataPath) return result;
		const metadataFile = plugin.app.vault.getAbstractFileByPath(metadataPath);
		if (!(metadataFile instanceof TFile)) return result;
		bus.emit('x-metadata-enriched', {
			statusId,
			metadataFile,
			sourceFiles: sourceFiles.length > 0 ? sourceFiles : undefined,
		});
		return result;
	}
}

function dedupeSourcePaths(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string' || !item) continue;
		if (seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out;
}

function outcomeNotes(status: 'created' | 'exists' | 'tombstoned', statusId: string, isUnavailablePath: boolean): string {
	if (status === 'tombstoned') return `Post unavailable — tombstoned ${statusId}`;
	if (status === 'exists') {
		return isUnavailablePath
			? `Post unavailable — already tombstoned ${statusId}`
			: `Linked existing metadata for ${statusId}`;
	}
	return `Created metadata for ${statusId}`;
}

interface StampSummary {
	stamped: number;
	skipped: number;
	sourceFiles: TFile[];
}

/**
 * Stamps each real source note with an `x-metadata` frontmatter list entry
 * pointing at the metadata note — mirror of `linkMetadataToNote`'s wikilink
 * format (`youtubeApi.ts`), but list-append rather than single-value, since one
 * clip can cite several statuses. Non-`TFile` paths are skipped silently and
 * counted, never thrown on: the caller may pass a path that was valid at
 * enqueue time and has since moved/vanished.
 */
async function stampSourceNotes(
	plugin: WorkflowContext['plugin'],
	metadataPath: string,
	sourcePaths: string[],
): Promise<StampSummary> {
	const link = `[[${stripMdExt(metadataPath)}]]`;
	let stamped = 0;
	let skipped = 0;
	const sourceFiles: TFile[] = [];
	for (const path of sourcePaths) {
		const file = plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			skipped++;
			continue;
		}
		sourceFiles.push(file);
		await plugin.noteLocks.withLock(file.path, 'x-metadata', () =>
			updateFrontmatter(plugin.app, file, fm => {
				appendXMetadataLink(fm, link);
			}),
		);
		stamped++;
	}
	return { stamped, skipped, sourceFiles };
}

/**
 * Idempotent list-append: absent/empty → `[link]`; a non-empty string other
 * than `link` itself coerces to `[old, link]` (preserving the old value); an
 * array appends `link` only when not already present (string compare). A
 * legacy scalar that already equals `link` collapses to `[link]` rather than
 * duplicating it — the one case a blind `[old, link]` coercion would double up.
 */
function appendXMetadataLink(fm: Record<string, unknown>, link: string): void {
	const existing = fm['x-metadata'];
	if (Array.isArray(existing)) {
		if (!existing.some(v => v === link)) existing.push(link);
		fm['x-metadata'] = existing;
		return;
	}
	if (typeof existing === 'string' && existing) {
		fm['x-metadata'] = existing === link ? [link] : [existing, link];
		return;
	}
	fm['x-metadata'] = [link];
}

function stripMdExt(path: string): string {
	return path.endsWith('.md') ? path.slice(0, -3) : path;
}
