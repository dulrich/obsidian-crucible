import { App, TFile } from 'obsidian';

type FrontmatterRecord = Record<string, unknown>;

export async function withMaterializing<T>(setMaterializing: (state: boolean) => void, action: () => Promise<T>): Promise<T> {
	setMaterializing(true);
	try {
		return await action();
	} finally {
		setMaterializing(false);
	}
}

export async function updateFrontmatter(app: App, file: TFile, update: (fm: FrontmatterRecord) => void): Promise<void> {
	await app.fileManager.processFrontMatter(file, update);
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
