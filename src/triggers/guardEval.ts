import type { CachedMetadata } from 'obsidian';
import type { GuardCondition } from '../types';

// The inputs a synchronous guard condition is evaluated against: the file's
// frontmatter and its resolved tag list. Shared by the chain guard step
// (ChainManager.evaluateGuard) and the user-trigger adapter so both apply identical
// condition semantics.
export interface GuardEvalTags {
	fm: Record<string, unknown>;
	tags: string[];
}

function normalizeTag(tag: string): string {
	return tag.replace(/^#/, '');
}

// Compare a frontmatter value as a string. Objects/arrays don't have a meaningful
// scalar form for an equality guard, so they compare as empty (never equal to a value).
function scalarString(v: unknown): string {
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
	return '';
}

function scalarStrings(v: unknown): string[] {
	if (Array.isArray(v)) return v.map(item => scalarString(item)).filter(Boolean);
	const scalar = scalarString(v);
	return scalar ? [scalar] : [];
}

function nonBlankSet(values: string[] | undefined): Set<string> {
	return new Set((values ?? []).map(v => v.trim()).filter(Boolean));
}

// Frontmatter tags (array or single string) plus inline body tags, all `#`-stripped.
export function collectTags(cache: CachedMetadata | null | undefined): string[] {
	const tags: string[] = [];
	const rawTags: unknown = cache?.frontmatter?.tags;
	if (Array.isArray(rawTags)) {
		tags.push(...rawTags.map((t: string) => normalizeTag(String(t))));
	} else if (typeof rawTags === 'string') {
		tags.push(normalizeTag(rawTags));
	}
	if (cache?.tags) {
		cache.tags.forEach(t => tags.push(normalizeTag(t.tag)));
	}
	return tags;
}

export function guardContext(cache: CachedMetadata | null | undefined): GuardEvalTags {
	return { fm: (cache?.frontmatter ?? {}) as Record<string, unknown>, tags: collectTags(cache) };
}

// Evaluate a single frontmatter/tag-sourced (synchronous) guard condition.
// `word-count-*` is content-sourced (async) and is NOT handled here — it returns true
// so a sync caller never blocks on it; the chain guard path evaluates it separately.
export function evaluateSyncGuard(condition: GuardCondition, ctx: GuardEvalTags): boolean {
	const { fm, tags } = ctx;
	switch (condition.type) {
		case 'has-tag':
			return condition.tag ? tags.includes(normalizeTag(condition.tag)) : false;
		case 'not-has-tag':
			return condition.tag ? !tags.includes(normalizeTag(condition.tag)) : true;
		case 'has-property':
			return condition.property ? condition.property in fm : false;
		case 'not-has-property':
			return condition.property ? !(condition.property in fm) : true;
		case 'property-equals':
			return condition.property ? scalarString(fm[condition.property]) === (condition.value ?? '') : false;
		case 'property-in-set': {
			if (!condition.property) return false;
			const accepted = nonBlankSet(condition.values);
			if (accepted.size === 0) return false;
			return scalarStrings(fm[condition.property]).some(value => accepted.has(value));
		}
		case 'property-lt':
		case 'property-gt': {
			if (!condition.property) return false;
			const lhs = Number(fm[condition.property]);
			const rhs = Number(condition.value);
			if (!Number.isFinite(lhs) || !Number.isFinite(rhs)) return false;
			return condition.type === 'property-lt' ? lhs < rhs : lhs > rhs;
		}
		default:
			return true;
	}
}

// Combine a list of sync conditions with AND ('all') or OR ('any'). Empty list passes.
export function evaluateSyncGuards(
	conditions: GuardCondition[],
	ctx: GuardEvalTags,
	mode: 'all' | 'any' = 'all',
): boolean {
	if (conditions.length === 0) return true;
	return mode === 'any'
		? conditions.some(c => evaluateSyncGuard(c, ctx))
		: conditions.every(c => evaluateSyncGuard(c, ctx));
}
