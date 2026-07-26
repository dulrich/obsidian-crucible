import { App, EventRef, TFile } from 'obsidian';
// Namespace import (rather than named `{ parseYaml, stringifyYaml }`) deliberately: these
// two are only reached by the content-splice repair path below, which most callers never
// exercise, and a handful of unrelated test suites bundle this file transitively through
// `updateFrontmatter` against a minimal hand-rolled `obsidian` stub that doesn't declare
// every real export. A named import would fail those bundles at build time even though
// they never call the repair path; a namespace import defers the lookup to call time.
import * as ObsidianAPI from 'obsidian';
import { FRONTMATTER_REGEX } from './utils';
import { logError, logWarn } from './log';

type FrontmatterRecord = Record<string, unknown>;

export const FRONTMATTER_CACHE_BARRIER_TIMEOUT_MS = 2000;

export async function withMaterializing<T>(setMaterializing: (state: boolean) => void, action: () => Promise<T>): Promise<T> {
	setMaterializing(true);
	try {
		return await action();
	} finally {
		setMaterializing(false);
	}
}

// All frontmatter writes go through here. `fileManager.processFrontMatter` merges the
// callback's mutations against the metadata cache's view of the file; when the cache
// hasn't re-indexed the current bytes (post-rename + rapid edit, e.g. the Ingest-as-News
// chain), the merge lands on the wrong byte range and values are silently lost. Mirror of
// the read-side barrier in TriggerRegistry.waitForConsistentCache: when the cache is
// stale, wait (bounded) for the file's next `metadataCache.on('changed')` before writing.
// See the processFrontMatter quirk in AGENTS.md.
export async function updateFrontmatter(
	app: App,
	file: TFile,
	update: (fm: FrontmatterRecord) => void,
	cacheBarrierTimeoutMs = FRONTMATTER_CACHE_BARRIER_TIMEOUT_MS,
): Promise<void> {
	const fresh = await waitForFreshFrontmatterCache(app, file, cacheBarrierTimeoutMs);
	if (fresh) {
		await app.fileManager.processFrontMatter(file, update);
		return;
	}
	logWarn(`frontmatter cache still stale after ${cacheBarrierTimeoutMs}ms; writing anyway (${file.path})`);
	const mutated = new Map<string, unknown>();
	await app.fileManager.processFrontMatter(file, (fm: FrontmatterRecord) => {
		const before = new Map(Object.entries(fm));
		update(fm);
		for (const key of Object.keys(fm)) {
			if (!before.has(key) || before.get(key) !== fm[key]) mutated.set(key, fm[key]);
		}
	});
	if (mutated.size === 0) return;
	const content = await app.vault.read(file);
	const block = content.match(FRONTMATTER_REGEX)?.[1] ?? '';
	const lost = Array.from(mutated).filter(([key, value]) => !frontmatterValueLanded(block, key, value));
	if (lost.length === 0) return;

	// The merge above was computed against a base object the stale cache supplied, so
	// under sustained churn (e.g. a few-thousand-file bulk move keeping the cache stale
	// past the barrier window) the mutation can be silently absent from what actually
	// landed on disk. Repair by re-reading the file's real current bytes, locating the
	// frontmatter block from the raw `---` delimiters (never the cache's
	// frontmatterPosition), applying the same mutator to what's actually there, and
	// splicing the result back in by index — never `String.replace(block, …)`, which
	// can corrupt an empty/odd block. This repairs every updateFrontmatter caller once,
	// at the one chokepoint, rather than each call site re-verifying for itself.
	logWarn(`frontmatter write lost under stale cache for keys [${lost.map(([key]) => key).join(', ')}] `
		+ `(${file.path}); repairing via content-based splice`);
	await repairFrontmatterViaContentSplice(app, file, update);

	const repairedContent = await app.vault.read(file);
	const repairedBlock = repairedContent.match(FRONTMATTER_REGEX)?.[1] ?? '';
	const stillLost = Array.from(mutated).filter(([key, value]) => !frontmatterValueLanded(repairedBlock, key, value));
	if (stillLost.length > 0) {
		logError(`frontmatter write still lost after content-splice repair for keys `
			+ `[${stillLost.map(([key]) => key).join(', ')}] (${file.path})`);
	}
}

// Fallback write path for updateFrontmatter's stale-cache-timeout case. Re-reads the
// file's actual current bytes (rather than trusting anything the metadata cache
// reported), locates the frontmatter block by parsing the raw `---` delimiters, parses
// it, applies `update` to that real object, and splices the serialized result back into
// the content by index. This never touches `frontmatterPosition` and never does a
// substring `String.replace` of the block text (which can corrupt an empty/odd block) —
// the splice points come from the regex match's own span on the freshly-read content.
async function repairFrontmatterViaContentSplice(
	app: App,
	file: TFile,
	update: (fm: FrontmatterRecord) => void,
): Promise<void> {
	await app.vault.process(file, (raw: string) => {
		const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
		const m = raw.match(FRONTMATTER_REGEX);
		if (!m) {
			const fm: FrontmatterRecord = {};
			update(fm);
			const serialized = ObsidianAPI.stringifyYaml(fm).replace(/\n$/, '');
			const body = bom ? raw.slice(1) : raw;
			return `${bom}---\n${serialized}\n---\n\n${body}`;
		}

		const parsed: unknown = ObsidianAPI.parseYaml(m[1] ?? '');
		const fm: FrontmatterRecord = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
			? (parsed as FrontmatterRecord)
			: {};
		update(fm);

		const trailingNewlines = m[2] ?? '';
		const closeEnd = m[0].slice(0, m[0].length - trailingNewlines.length).replace(/[^\S\r\n]+$/, '').length;
		const start = m.index ?? 0;
		const before = raw.slice(0, start);
		const rest = raw.slice(start + closeEnd);
		const serialized = ObsidianAPI.stringifyYaml(fm).replace(/\n$/, '');
		return `${before}${bom}---\n${serialized}\n---${rest}`;
	});
}

// Raw-content check that a scalar write survived; structured values (arrays, objects)
// only get a key-presence check — matching their YAML layout here isn't worth it.
function frontmatterValueLanded(block: string, key: string, value: unknown): boolean {
	const line = block.split(/\r?\n/).find(l => frontmatterLineKey(l) === key);
	if (line === undefined) return false;
	if (value === null || value === undefined) return true;
	if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return true;
	const raw = line.slice(line.indexOf(':') + 1).trim();
	return raw === String(value) || raw.replace(/^(['"])(.*)\1$/, '$2') === String(value);
}

async function waitForFreshFrontmatterCache(app: App, file: TFile, timeoutMs: number): Promise<boolean> {
	// The metadata cache only indexes markdown; processFrontMatter refuses other files anyway.
	if (file.extension !== 'md') return true;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (frontmatterCacheIsFresh(app, file, await app.vault.read(file))) return true;
		const remaining = deadline - Date.now();
		if (remaining <= 0 || !(await nextMetadataChange(app, file.path, remaining))) return false;
	}
}

function frontmatterCacheIsFresh(app: App, file: TFile, content: string): boolean {
	const cache = app.metadataCache.getFileCache(file);
	const cachedEnd = cache?.frontmatterPosition?.end?.offset;
	const m = content.match(FRONTMATTER_REGEX);
	if (!m) return cachedEnd === undefined;
	if (cachedEnd === undefined) return false;
	const trailingNewlines = m[2] ?? '';
	const closingEnd = m[0].slice(0, m[0].length - trailingNewlines.length).replace(/[^\S\r\n]+$/, '').length;
	if (cachedEnd !== closingEnd) return false;
	// Offsets can coincide across an edit; the key set catches content-level staleness.
	const cachedKeys = Object.keys((cache?.frontmatter as FrontmatterRecord | undefined) ?? {});
	const actualKeys = frontmatterBlockKeys(m[1] ?? '');
	return cachedKeys.length === actualKeys.size && cachedKeys.every(key => actualKeys.has(key));
}

// Top-level keys of a raw frontmatter block: non-indented `key:` lines (indented lines
// belong to list/block values). Quoted keys are unwrapped to match the parsed cache keys.
function frontmatterBlockKeys(block: string): Set<string> {
	const keys = new Set<string>();
	for (const line of block.split(/\r?\n/)) {
		const key = frontmatterLineKey(line);
		if (key !== null) keys.add(key);
	}
	return keys;
}

function frontmatterLineKey(line: string): string | null {
	const match = /^(\S[^:\r\n]*):(?:\s|$)/.exec(line);
	if (!match?.[1]) return null;
	const raw = match[1].trim();
	const unquoted = /^(['"])(.*)\1$/.exec(raw);
	return unquoted?.[2] ?? raw;
}

function nextMetadataChange(app: App, path: string, timeoutMs: number): Promise<boolean> {
	return new Promise(resolve => {
		let ref: EventRef | null = null;
		const settle = (changed: boolean) => {
			clearTimeout(timer);
			if (ref) app.metadataCache.offref(ref);
			ref = null;
			resolve(changed);
		};
		const timer = setTimeout(() => settle(false), timeoutMs);
		ref = app.metadataCache.on('changed', changedFile => {
			if (changedFile.path === path) settle(true);
		});
	});
}

export function normalizeFrontmatterPropertyName(property: string): string {
	return property.trim();
}

export function upsertFrontmatterProperty(fm: FrontmatterRecord, property: string, value: unknown): void {
	const key = normalizeFrontmatterPropertyName(property);
	if (!key) throw new Error('Property name is required');
	fm[key] = value;
}

export function upsertFrontmatterPropertyIfEmpty(fm: FrontmatterRecord, property: string, value: unknown): void {
	const key = normalizeFrontmatterPropertyName(property);
	if (!key) return;
	const currentValue = fm[key];
	if (currentValue === undefined || currentValue === null || currentValue === '') {
		fm[key] = value;
	}
}

export function insertFrontmatterPropertyAfter(
	fm: FrontmatterRecord,
	anchorKey: string,
	newKey: string,
	value: unknown,
): void {
	if (newKey in fm) {
		fm[newKey] = value;
		return;
	}
	if (!(anchorKey in fm)) {
		fm[newKey] = value;
		return;
	}
	const ordered: FrontmatterRecord = {};
	for (const k of Object.keys(fm)) {
		ordered[k] = fm[k];
		if (k === anchorKey) ordered[newKey] = value;
	}
	for (const k of Object.keys(fm)) delete fm[k];
	for (const k of Object.keys(ordered)) fm[k] = ordered[k];
}

export function sortFrontmatterProperties(fm: FrontmatterRecord, priority: string[]): void {
	const sortedFm: FrontmatterRecord = {};

	for (const key of priority) {
		if (key in fm) {
			sortedFm[key] = fm[key];
			delete fm[key];
		}
	}

	for (const key of Object.keys(fm)) {
		sortedFm[key] = fm[key];
		delete fm[key];
	}

	for (const key of Object.keys(sortedFm)) {
		fm[key] = sortedFm[key];
	}
}

export function parseTagList(tagsInput: string): string[] {
	const tags: string[] = [];
	const seen = new Set<string>();
	const parts = tagsInput
		.split(/[\s,]+/)
		.map(part => part.replace(/^-+/, '').trim())
		.filter(part => part.length > 0);

	for (const part of parts) {
		const tag = normalizeTagForStorage(part);
		const normalized = normalizeTagForCompare(tag);
		if (tag && !seen.has(normalized)) {
			seen.add(normalized);
			tags.push(tag);
		}
	}

	return tags;
}

export function getFrontmatterTags(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((tag): tag is string => typeof tag === 'string')
			.map(tag => tag.trim())
			.filter(tag => tag.length > 0);
	}

	if (typeof value === 'string') {
		return parseTagList(value);
	}

	return [];
}

export function upsertFrontmatterTags(fm: FrontmatterRecord, tagsInput: string): boolean {
	const newTags = parseTagList(tagsInput);
	if (newTags.length === 0) return false;

	const existingTags = getFrontmatterTags(fm.tags);
	const seen = new Set(existingTags.map(tag => normalizeTagForCompare(tag)));
	const mergedTags = [...existingTags];
	let changed = false;

	for (const tag of newTags) {
		const normalized = normalizeTagForCompare(tag);
		if (!seen.has(normalized)) {
			seen.add(normalized);
			mergedTags.push(tag);
			changed = true;
		}
	}

	if (changed || !Array.isArray(fm.tags)) {
		fm.tags = mergedTags;
		return true;
	}

	return false;
}

function normalizeTagForStorage(tag: string): string {
	return tag.trim().replace(/^#+/, '');
}

function normalizeTagForCompare(tag: string): string {
	return normalizeTagForStorage(tag).toLowerCase();
}
