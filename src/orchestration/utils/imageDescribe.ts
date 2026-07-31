/**
 * WP-3's shared describe core (`docs/multimodal-image-search.md` Decision 3): the one place
 * that turns a localized `_MD5` image into a stored `ImageDescriptionRecord`. Both
 * `image_describe_note` (one note, its embedded images) and `image_describe_batch` (a backfill
 * slice of referenced image paths) drive the same loop here, so the skip/lock/transcode/two-pass
 * contract lives in exactly one place.
 *
 * Takes **no note lock, ever** — every write here targets `plugin.imageDescriptions` (a plugin
 * data file outside the vault's note tree), never a note. Cross-note/cross-batch dedup on the
 * same image is instead serialized under the `image::<md5>` resource lock
 * (`NoteLockManager.withResourceLock`, the `yt-video::<id>` exemplar in `utils/youtubeApi.ts`),
 * so two jobs racing the same embedded image never issue two model calls for it.
 */

import { TFile } from 'obsidian';
import type CruciblePlugin from '../../main';
import { providerModality, type CrucibleSettings, type Provider } from '../../types';
import { needsVisionTranscode, extractSvgText } from '../../search/imageTranscode';
import { classifyFailure, type ImageDescriptionStore } from '../../search/imageDescriptionStore';
import { logWarn } from '../../log';
import type { ServiceFailureKind } from '../serviceHealth';
import { imageMimeType, localizedImageInfo, extractMetadataSections, type LocalizedImageInfo } from './imageMetadata';
import { withTimeout } from '../../providers/shared';

// thq WP-4 (B-1): `withTimeout` moved to `providers/shared.ts` so `providers.ts` (a low-level
// module every completion-class caller depends on) doesn't have to reach up into this
// orchestration-domain, image-description-specific file to reuse it — see that file's doc comment
// for the full reasoning. Re-exported under its original name so existing imports/tests
// (`tests/imageDescribe.test.mjs`) that pull `withTimeout` off this module's bundle keep working
// unchanged, and so the transcode wrap just below (still local to this file) reads the same as
// before.
export { withTimeout };

// rsp-wp1 Part B: photos currently inflate to ~25MB PNGs on transcode (a raw decode+re-encode at
// native resolution), raising prefill cost for every vision pass. 1568px is comfortably above
// what current vision models extract further detail from at, and only ever shrinks — a source
// already under the cap passes through untouched.
//
// This duplicates `transcodeToPng`'s small createImageBitmap/OffscreenCanvas shape (see
// `../../search/imageTranscode.ts`) rather than adding a parameter to it: this work package's
// hard constraints forbid touching anything under `src/search/`, so the downscale-then-encode
// step lives here instead, as `transcodeToPngDownscaled` below.
export const IMAGE_DESCRIBE_MAX_LONG_EDGE_PX = 1568;

/** Files per `image_describe_batch` job — the `SEARCH_REBUILD_BATCH_FILES` precedent applied to
 * the image backfill: ~4,751 unique referenced images / 100 gives ~48 job files, not 4,751. */
export const IMAGE_DESCRIBE_BATCH_IMAGES = 100;

/** Enqueues between macrotask yields, so a full backfill fan-out can't freeze the UI thread. */
export const IMAGE_DESCRIBE_ENQUEUE_YIELD_EVERY = 10;

// idh-WP-1 hardening (`plans/image-describe-hardening-ux.md` WP-1): observed live, a temp-0
// repetition loop generated to the 32k context ceiling — `extraction=597888ms`, a 76k/94k-char
// degenerate record. Every provider pass and the transcode step now get a bounded worst case.
/** Per provider pass (narrative or extraction). `requestUrl` is not abortable — see `withTimeout`. */
export const IMAGE_DESCRIBE_PASS_TIMEOUT_MS = 120_000;
/** `transcodeToPng`, an in-renderer `OffscreenCanvas` conversion — much cheaper than a model call. */
export const IMAGE_DESCRIBE_TRANSCODE_TIMEOUT_MS = 30_000;
/** `pruneDegenerate` threshold: a vision record's `extraction` longer than this is the on-disk
 * trace of a runaway generation, self-healed by the backfill on every run. */
export const IMAGE_DESCRIBE_DEGENERATE_MAX_EXTRACTION_CHARS = 20_000;
/** Truncation length for a stored `failure` message — enough to diagnose, not enough for a
 * pathological error (e.g. one embedding a chunk of the runaway output itself) to bloat the store. */
const FAILURE_MESSAGE_MAX_CHARS = 500;

// idh-WP-2 hardening (`plans/queue-image-dataview-dashboard-fixes.md` WP-2): the live incident
// this section fixes — a dead local inference router failed every remaining image in a batch
// (dozens per second), each earning a durable `kind: 'failed'` skip-forever record, and 954 more
// were `withTimeout` timeouts cascading from one abandoned generation that kept the server busy
// (requestUrl cannot cancel it — see `withTimeout`'s doc). 1030 of 1039 failed records were infra
// casualties, not poison images. `IMAGE_DESCRIBE_BATCH_IMAGES` (up to 100) makes this expensive:
// left unchecked, one outage writes up to 100 bogus skip-forever records per batch, ~48 times over
// a full backfill.
/** Electron `requestUrl` error text for a dead/unreachable local inference router — "nothing is
 * listening", the one connection-class shape observed live (`ERR_CONNECTION_REFUSED`/`_RESET`,
 * `ERR_NETWORK_CHANGED`). On a match, `describeOneImage` writes **no record at all** (unlike a
 * timeout, a connection refusal carries zero information about *this* image) and the whole batch
 * aborts via `ImageDescribeInfraAbort` — the router being down says nothing about the untried
 * images, and hammering it once per remaining image only wastes wall-clock before the same abort. */
const CONNECTION_CLASS_ERROR_RE = /net::ERR_(?:CONNECTION_REFUSED|CONNECTION_RESET|NETWORK_CHANGED)/;

function isConnectionClassError(message: string): boolean {
	return CONNECTION_CLASS_ERROR_RE.test(message);
}

/** Matches any `withTimeout` failure label (`... timed out after <n>ms`) — narrative pass,
 * extraction pass, or transcode. Used only for the consecutive-timeout breaker below;
 * `classifyFailure` (broader — also matches `net::ERR_*`) is the transient/permanent taxonomy. */
const TIMEOUT_FAILURE_RE = /timed out after \d+ms/;

function isTimeoutFailureMessage(message: string): boolean {
	return TIMEOUT_FAILURE_RE.test(message);
}

/** 3 consecutive provider-call timeouts abort the batch: a `withTimeout` timeout means the
 * request was abandoned, not cancelled (`requestUrl` takes no signal), so an abandoned generation
 * keeps the server busy and every subsequent request queues into its own timeout — three in a row
 * is "the server is wedged," not "three unlucky images." A success (or a non-timeout failure —
 * either proves the server answered) resets the counter; see `describeMd5Images`. */
export const IMAGE_DESCRIBE_CONSECUTIVE_TIMEOUT_LIMIT = 3;

/**
 * Thrown by `describeOneImage` on a connection-class error to unwind `describeMd5Images`'s loop
 * without writing a failed record for the image that triggered it (or attempting any of the
 * images after it). Not a normal `ImageOutcome` — the whole point is that this image's outcome is
 * unknown, not `'failed'`.
 */
export class ImageDescribeInfraAbort extends Error {
	constructor(message: string, public readonly kind: ServiceFailureKind) {
		super(message);
		this.name = 'ImageDescribeInfraAbort';
	}
}

export class ImageDescribeConfigError extends Error {}

/**
 * Pure dimension math for the downscale cap: shrink-only, aspect-preserved. Split out from
 * `transcodeToPngDownscaled` so it's testable under plain `node --test` without a DOM (same split
 * `needsVisionTranscode`/`transcodeToPng` already draw in `../../search/imageTranscode.ts`).
 * A source already at or under `maxLongEdge` (or with a non-positive edge) passes through
 * unchanged — this must never *grow* a smaller image.
 */
export function clampLongEdge(width: number, height: number, maxLongEdge: number): { width: number; height: number } {
	const longEdge = Math.max(width, height);
	if (longEdge <= 0 || longEdge <= maxLongEdge) return { width, height };
	const scale = maxLongEdge / longEdge;
	return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Like `transcodeToPng` (`../../search/imageTranscode.ts`) but caps the long edge at
 * `IMAGE_DESCRIBE_MAX_LONG_EDGE_PX` before drawing — see that constant's comment for why this is
 * a local duplicate rather than a parameter added to the shared function. Renderer-only
 * (`createImageBitmap`/`OffscreenCanvas`), same as the function it mirrors.
 */
export async function transcodeToPngDownscaled(bytes: ArrayBuffer, mime: string): Promise<{ bytes: ArrayBuffer; mime: 'image/png' }> {
	const blob = new Blob([bytes], { type: mime });
	const bitmap = await createImageBitmap(blob);
	const { width, height } = clampLongEdge(bitmap.width, bitmap.height, IMAGE_DESCRIBE_MAX_LONG_EDGE_PX);
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('transcodeToPngDownscaled: failed to acquire an OffscreenCanvas 2d context');
	ctx.drawImage(bitmap, 0, 0, width, height);
	const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
	const pngBytes = await pngBlob.arrayBuffer();
	return { bytes: pngBytes, mime: 'image/png' };
}

function truncateFailureMessage(e: unknown): string {
	const message = e instanceof Error ? e.message : String(e);
	return message.length > FAILURE_MESSAGE_MAX_CHARS ? `${message.slice(0, FAILURE_MESSAGE_MAX_CHARS)}…` : message;
}

/**
 * Resolves and validates the configured image description model, exactly the checks the old
 * `ImageMetadataExtractWorkflow` ran inline — centralized here so `image_describe_note`,
 * `image_describe_backfill` and `image_describe_batch` all fail with the same message instead of
 * three near-identical hand-rolled checks drifting apart.
 */
export function resolveImageDescribeModel(plugin: CruciblePlugin): { provider: Provider; modelId: string } {
	if (!plugin.settings.imageMetadataExtractionEnabled) {
		throw new ImageDescribeConfigError('Image descriptions are disabled in settings (Crucible → Settings → Orchestrate → Image descriptions).');
	}
	const ref = plugin.settings.imageMetadataExtractionModel;
	if (!ref?.modelId) throw new ImageDescribeConfigError('No image description model configured.');
	const provider = plugin.settings.providers.find(p => p.id === ref.providerId);
	const model = provider?.models.find(m => m.id === ref.modelId);
	if (!provider || !model) throw new ImageDescribeConfigError('Configured image description model is missing.');
	if (!model.capabilities?.includes('image-extraction')) {
		throw new ImageDescribeConfigError('Configured model is not marked image-extraction capable.');
	}
	return { provider, modelId: model.id };
}

/** Pure gate mirroring `resolveImageDescribeModel` for the localize-on-write hook, which fires
 * far more often than a job resolves and must not require a `CruciblePlugin` instance to test. */
export function shouldEnqueueImageDescribe(settings: CrucibleSettings, imagePath: string): boolean {
	if (!settings.imageMetadataExtractionEnabled) return false;
	if (!localizedImageInfo(imagePath)) return false;
	const ref = settings.imageMetadataExtractionModel;
	if (!ref) return false;
	const provider = settings.providers.find(p => p.id === ref.providerId);
	if (!provider || providerModality(provider.kind) === 'cli') return false;
	const model = provider.models.find(m => m.id === ref.modelId);
	return model?.capabilities?.includes('image-extraction') === true;
}

/**
 * vf-1: the enqueue-time mirror of `describeOneImage`'s execution-time `has()` skip
 * (`plugin.imageDescriptions.has(image.md5)`, above in this file) — an image that already
 * carries a description record (successful, OR a durable `kind: 'failed'` poison-skip record;
 * both count as "has" on purpose, matching execution-time semantics) should never mint a second
 * `image_describe_note` job. Without this, every restart's create-replay re-schedules a localize
 * pass over every already-localized note, and the localizer's already-localized branch still
 * calls the enqueue hook — minting a real, redundant queue row every time, because queue dedupe
 * is active-jobs-only and a settled prior job doesn't suppress a new one.
 *
 * Deliberately **not** folded into `shouldEnqueueImageDescribe` above: that function is a cheap
 * settings/model-shape check called on every localize match, while this one needs a real store
 * lookup — keeping them separate keeps `shouldEnqueueImageDescribe`'s existing callers and
 * contract text unchanged. Takes a bare `has` predicate (not the whole `ImageDescriptionStore`)
 * so it stays a pure function testable without constructing a store or a `CruciblePlugin`; a
 * path that doesn't resolve to a `_MD5`-named image is not "already described" (`false`) — that
 * case is already excluded upstream by `shouldEnqueueImageDescribe`'s own `localizedImageInfo`
 * check, so callers should run this gate second, not instead.
 */
export function isImageAlreadyDescribed(hasDescription: (md5: string) => boolean, imagePath: string): boolean {
	const info = localizedImageInfo(imagePath);
	return info !== null && hasDescription(info.md5);
}

export interface ImageDescribeTiming {
	md5: string;
	path: string;
	skipped: boolean;
	transcodeMs?: number;
	narrativeMs?: number;
	extractionMs?: number;
	totalMs: number;
}

export interface DescribeMd5ImagesOptions {
	signal?: AbortSignal;
	/** Fired once per image after its outcome settles (described, skipped, or missing-file). */
	onTiming?: (timing: ImageDescribeTiming) => void;
}

export interface DescribeMd5ImagesResult {
	/** Newly written this run (a model call, or an SVG extraction, actually happened). */
	describedCount: number;
	/** Already had a record (`store.has(md5)`) — the cross-note/cross-batch dedup path. */
	skippedCount: number;
	/** The vault file the image path pointed at no longer exists. */
	missingCount: number;
	/** A durable `kind: 'failed'` record was written this run (provider throw, timeout, or
	 * transcode failure) — the loop continued to the next image rather than aborting the batch. */
	failedCount: number;
	/**
	 * idh-WP-2 infra breaker: set when the loop stopped early — a connection-class error (no
	 * record written for the triggering image) or `IMAGE_DESCRIBE_CONSECUTIVE_TIMEOUT_LIMIT`
	 * consecutive timeouts (records for those ARE written; they're transient-class and will
	 * re-describe). Every image after the abort point in `images` was never attempted and stays
	 * pending for a later run. Callers should surface this as a deferred/unhealthy job outcome,
	 * not a plain failure — see `ImageDescribeNoteWorkflow`/`ImageDescribeBatchWorkflow`.
	 */
	abortReason?: string;
	/** Only set alongside `abortReason` — feeds a workflow's `serviceUnhealthy.kind`. */
	abortKind?: ServiceFailureKind;
}

/**
 * Describe every unique image in `images` (by md5), writing `plugin.imageDescriptions` records.
 * Per image: `image::<md5>` resource lock → skip if already described → SVG gets a text
 * extraction (no model call) → everything else gets WebP/AVIF transcoded in-renderer if needed,
 * then two provider calls (`narrative`, `extraction` — two requests by locked decision, never a
 * merged prompt). The signal is checked between images, not mid-pass: an in-flight model call
 * cannot be aborted (Obsidian's `requestUrl` takes no signal), so the checkpoint that actually
 * stops work lives where the next image would otherwise start.
 */
export async function describeMd5Images(
	plugin: CruciblePlugin,
	provider: Provider,
	modelId: string,
	images: LocalizedImageInfo[],
	opts: DescribeMd5ImagesOptions = {},
): Promise<DescribeMd5ImagesResult> {
	await plugin.imageDescriptions.ensureLoaded();
	let describedCount = 0;
	let skippedCount = 0;
	let missingCount = 0;
	let failedCount = 0;
	// idh-WP-2 infra breaker: consecutive `withTimeout` timeouts. Only a timeout increments it (a
	// permanent failure, a skip, or a missing file proves nothing about server health either way,
	// so they leave it untouched); a described image resets it to 0 (proof the server answered).
	let consecutiveTimeouts = 0;
	let abortReason: string | undefined;
	let abortKind: ServiceFailureKind | undefined;

	for (const image of images) {
		opts.signal?.throwIfAborted();
		let outcome: ImageOutcome;
		try {
			// Sequential by design: one queue worker runs this loop, one model call in flight at a time.
			outcome = await plugin.noteLocks.withResourceLock(
				'image',
				image.md5,
				'image-describe',
				() => describeOneImage(plugin, provider, modelId, image, opts),
			);
		} catch (e) {
			if (e instanceof ImageDescribeInfraAbort) {
				logWarn('image describe: infra breaker aborted batch (connection-class error)', image.path, e.message);
				abortReason = e.message;
				abortKind = e.kind;
				break;
			}
			throw e;
		}
		if (outcome.outcome === 'described') {
			describedCount++;
			consecutiveTimeouts = 0;
		} else if (outcome.outcome === 'skipped') {
			skippedCount++;
		} else if (outcome.outcome === 'missing') {
			missingCount++;
		} else {
			failedCount++;
			if (outcome.isTimeout) {
				consecutiveTimeouts++;
				if (consecutiveTimeouts >= IMAGE_DESCRIBE_CONSECUTIVE_TIMEOUT_LIMIT) {
					abortReason = `${consecutiveTimeouts} consecutive image description timeouts — the inference server is likely `
						+ 'wedged behind an abandoned generation. Aborting the remaining images in this batch; they stay pending '
						+ 'for a later run.';
					abortKind = 'timeout';
					logWarn('image describe: infra breaker aborted batch (consecutive timeouts)', consecutiveTimeouts);
					break;
				}
			} else {
				consecutiveTimeouts = 0;
			}
		}
	}

	return {
		describedCount, skippedCount, missingCount, failedCount,
		...(abortReason !== undefined ? { abortReason } : {}),
		...(abortKind !== undefined ? { abortKind } : {}),
	};
}

type ImageOutcomeKind = 'described' | 'skipped' | 'missing' | 'failed';
interface ImageOutcome {
	outcome: ImageOutcomeKind;
	/** `outcome: 'failed'` only — whether the failure was a `withTimeout` timeout, for the
	 * consecutive-timeout breaker above. */
	isTimeout?: boolean;
}

async function describeOneImage(
	plugin: CruciblePlugin,
	provider: Provider,
	modelId: string,
	image: LocalizedImageInfo,
	opts: DescribeMd5ImagesOptions,
): Promise<ImageOutcome> {
	if (plugin.imageDescriptions.has(image.md5)) {
		opts.onTiming?.({ md5: image.md5, path: image.path, skipped: true, totalMs: 0 });
		return { outcome: 'skipped' };
	}
	const file = plugin.app.vault.getAbstractFileByPath(image.path);
	if (!(file instanceof TFile)) {
		logWarn('image describe: referenced file is missing, skipping', image.path);
		return { outcome: 'missing' };
	}

	const started = Date.now();

	// idh-WP-1 per-image failure isolation: a poison image (provider throw, timeout, transcode
	// failure — SVG text extraction is cheap/local and not expected to fail, but is covered too
	// for the same reason) must not stall or fail the whole batch. Failed file jobs move to
	// `failed/` and are never retried (`FileJobBackend.ts` header comment), so an uncaught
	// exception here would silently drop every remaining image in the batch. Writing a durable
	// `kind: 'failed'` record and returning `'failed'` keeps `has()` true for this md5 — the point
	// is that a later run skips the poison image instead of retrying it forever (until
	// `pruneDegenerate` or a future manual fix clears it).
	try {
		if (image.ext === 'svg') {
			const svgText = await plugin.app.vault.read(file);
			const extracted = extractSvgText(svgText);
			// SVG text goes in `extraction`, narrative stays empty — the WP-2 chunker contract: the
			// extraction field lands under the `Image: <name> (text)` heading, which is what a
			// transcribed-text payload is, and an empty narrative simply emits no narrative chunk.
			await plugin.imageDescriptions.put({ md5: image.md5, narrative: '', extraction: extracted, kind: 'svg-text' });
			const totalMs = Date.now() - started;
			logWarn('image describe: svg text extracted', image.path, `${totalMs}ms`);
			opts.onTiming?.({ md5: image.md5, path: image.path, skipped: false, totalMs });
			return { outcome: 'described' };
		}

		const bytes = await plugin.app.vault.readBinary(file);
		let finalBytes = bytes;
		let finalMime = imageMimeType(image.ext);
		let transcodeMs: number | undefined;
		if (needsVisionTranscode(image.ext)) {
			const transcodeStarted = Date.now();
			const transcoded = await withTimeout(transcodeToPngDownscaled(bytes, finalMime), IMAGE_DESCRIBE_TRANSCODE_TIMEOUT_MS, 'image transcode');
			finalBytes = transcoded.bytes;
			finalMime = transcoded.mime;
			transcodeMs = Date.now() - transcodeStarted;
		}

		// thq WP-4 (B-1): the per-pass timer used to be armed HERE, wrapping the whole
		// `describeImage` call — including the wait for the per-provider concurrency slot (limit 1
		// on local providers, shared with every other completion-class call). That let queue-wait
		// alone burn the 120s budget before inference even started. The timer now lives inside
		// `describeImage` itself (`providers.ts`), armed only once the slot is acquired — pass the
		// same `IMAGE_DESCRIBE_PASS_TIMEOUT_MS` constant through instead of wrapping the call here.
		const narrativeStarted = Date.now();
		const narrative = await plugin.providerManager.describeImage(
			provider, modelId, finalBytes, finalMime, 'narrative', IMAGE_DESCRIBE_PASS_TIMEOUT_MS,
		);
		const narrativeMs = Date.now() - narrativeStarted;

		const extractionStarted = Date.now();
		const extraction = await plugin.providerManager.describeImage(
			provider, modelId, finalBytes, finalMime, 'extraction', IMAGE_DESCRIBE_PASS_TIMEOUT_MS,
		);
		const extractionMs = Date.now() - extractionStarted;

		await plugin.imageDescriptions.put({
			md5: image.md5,
			narrative,
			extraction,
			kind: 'vision',
			providerId: provider.id,
			modelId,
		});

		const totalMs = Date.now() - started;
		logWarn(
			'image describe: vision pass complete', image.path,
			`transcode=${transcodeMs ?? 0}ms narrative=${narrativeMs}ms extraction=${extractionMs}ms total=${totalMs}ms`,
		);
		opts.onTiming?.({ md5: image.md5, path: image.path, skipped: false, transcodeMs, narrativeMs, extractionMs, totalMs });
		return { outcome: 'described' };
	} catch (e) {
		const failure = truncateFailureMessage(e);
		// idh-WP-2 infra breaker: a connection-class error means nothing is listening — it carries
		// zero information about THIS image, so (unlike every other failure) it does not earn a
		// skip-forever record. Rethrow to unwind describeMd5Images's loop without writing anything
		// or attempting the remaining images (the router being down won't clear between them).
		if (isConnectionClassError(failure)) {
			logWarn('image describe: connection-class failure, aborting batch without recording a failure', image.path, failure);
			throw new ImageDescribeInfraAbort(
				`Image description aborted: ${failure}. Remaining images in this batch were not attempted and stay pending.`,
				'refused',
			);
		}
		const failureClass = classifyFailure(failure);
		logWarn('image describe: failed, recording durable failure and continuing', image.path, failure, failureClass);
		await plugin.imageDescriptions.put({ md5: image.md5, narrative: '', extraction: '', kind: 'failed', failure, failureClass });
		const totalMs = Date.now() - started;
		opts.onTiming?.({ md5: image.md5, path: image.path, skipped: false, totalMs });
		return { outcome: 'failed', isTimeout: isTimeoutFailureMessage(failure) };
	}
}

/**
 * Resolve a note's embedded `_MD5` images to their `LocalizedImageInfo`, deduped by md5 (a note
 * can embed the same image twice, via wiki + markdown syntax or a genuine repeat). Reads
 * `metadataCache`'s `embeds` list directly rather than `AttachmentLocalizer.parseAttachmentRefs`
 * (an instance method on a module WP-3 does not own) — the same cache data, resolved through
 * `getFirstLinkpathDest` instead of Localize's own remote/local match classification, which this
 * caller does not need (it only wants images already on disk).
 */
export function resolveNoteImages(plugin: CruciblePlugin, file: TFile): LocalizedImageInfo[] {
	const embeds = plugin.app.metadataCache.getFileCache(file)?.embeds ?? [];
	const byMd5 = new Map<string, LocalizedImageInfo>();
	for (const embed of embeds) {
		if (!embed.link) continue;
		const dest = plugin.app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
		if (!dest) continue;
		const info = localizedImageInfo(dest.path);
		if (!info) continue;
		if (!byMd5.has(info.md5)) byMd5.set(info.md5, info);
	}
	return [...byMd5.values()];
}

/**
 * Every vault path whose target (per `metadataCache.resolvedLinks`) is one of `imagePaths`.
 * Recomputed at batch runtime rather than captured at enqueue time — paths drift between when a
 * backfill enumerates its images and when the batch actually runs (a note can move, or gain/lose
 * an embed) — so this is the authoritative "which notes need reindexing" answer, not a cache of
 * the enqueue-time answer.
 */
export function referencingNotePaths(plugin: CruciblePlugin, imagePaths: string[]): string[] {
	const targets = new Set(imagePaths);
	const notes = new Set<string>();
	const resolved = plugin.app.metadataCache.resolvedLinks;
	for (const source in resolved) {
		const linksFromSource = resolved[source];
		for (const target in linksFromSource) {
			if (targets.has(target)) {
				notes.add(source);
				break;
			}
		}
	}
	return [...notes];
}

export interface ReferencedImage {
	path: string;
	md5: string;
	ext: string;
}

/**
 * Inverts `computeOrphanedAttachmentRows`'s walk (`src/ingestion/data/orphanedAttachments.ts`):
 * same `resolvedLinks` flatten + `MD5_NAME_RE` + `classifyLocalizeMediaType` filters, but keeps
 * the *referenced* images instead of the orphaned ones. `classifyLocalizeMediaType('svg')`
 * returns `'images'` (svg is a native Obsidian embed format), so SVGs are already included here
 * without a special case.
 */
export function computeReferencedImagePaths(plugin: CruciblePlugin): ReferencedImage[] {
	const referenced = new Set<string>();
	const resolved = plugin.app.metadataCache.resolvedLinks;
	for (const source in resolved) {
		for (const target in resolved[source]) referenced.add(target);
	}

	const rows: ReferencedImage[] = [];
	for (const file of plugin.app.vault.getFiles()) {
		if (!referenced.has(file.path)) continue;
		const info = localizedImageInfo(file.path);
		if (!info) continue;
		rows.push({ path: file.path, md5: info.md5, ext: info.ext });
	}
	return rows;
}

/** `<32-hex>_MD5.md` — the legacy `image_metadata_extract` sidecar naming convention. */
const LEGACY_SIDECAR_NAME_RE = /^([a-f0-9]{32})_MD5\.md$/i;

export interface LegacySidecarImportResult {
	imported: number;
}

/**
 * One-time import of any `image_metadata_extract`-era sidecar notes (`docs/multimodal-image-search.md`
 * Decision 5: repurpose + migrate). Likely a no-op — the feature shipped default-off — but must
 * be cheap when it is: one vault scan, no per-file network or model call. Each matching sidecar's
 * Description/Extracted-text sections become a `kind: 'imported'` record keyed by the md5 in its
 * filename, then the sidecar is trashed (vault trash — the Orphaned Attachments precedent), same
 * as `Lint: repair attachment links` never hard-deletes.
 */
export async function importLegacyImageMetadataSidecars(
	plugin: CruciblePlugin,
	store: ImageDescriptionStore,
): Promise<LegacySidecarImportResult> {
	let imported = 0;
	for (const file of plugin.app.vault.getMarkdownFiles()) {
		const match = LEGACY_SIDECAR_NAME_RE.exec(file.name);
		if (!match?.[1]) continue;
		const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
		if (frontmatter?.['image-metadata-schema'] === undefined) continue;

		const md5 = match[1].toLowerCase();
		const content = await plugin.app.vault.read(file);
		const sections = extractMetadataSections(content);
		const providerId = typeof frontmatter['image-metadata-provider'] === 'string' ? frontmatter['image-metadata-provider'] : undefined;
		const modelId = typeof frontmatter['image-metadata-model'] === 'string' ? frontmatter['image-metadata-model'] : undefined;
		await store.put({
			md5,
			narrative: sections.description,
			extraction: sections.extractedText,
			kind: 'imported',
			providerId,
			modelId,
		});
		await plugin.app.fileManager.trashFile(file);
		imported++;
	}
	return { imported };
}
