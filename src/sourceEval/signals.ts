import { App, TFile, TFolder } from 'obsidian';
import type { EvalLabel, ObservationSignalMap } from './types';

export function parseEvalLabel(fm: Record<string, unknown> | undefined | null): EvalLabel | null {
	if (!fm) return null;
	const importance = parseImportance(fm['eval-importance']);
	const urgent = fm['eval-urgent'] === true;
	const rated = typeof fm['eval-rated'] === 'string' && fm['eval-rated'].trim()
		? fm['eval-rated'].trim()
		: null;
	const tags = parseEvalTags(fm['eval-tags']);

	if (importance === null && !urgent && !rated && tags.length === 0) return null;
	return { importance, urgent, rated, tags };
}

export async function scanObservationSignals(app: App, monthlyFolder: string): Promise<ObservationSignalMap> {
	const root = app.vault.getAbstractFileByPath(monthlyFolder);
	const files = root instanceof TFolder ? Array.from(walkMarkdown(root)) : [];
	const byNote = new Map<string, { months: Set<string>; quotes: number }>();

	for (const file of files) {
		const cache = app.metadataCache.getFileCache(file);
		const headings = cache?.headings ?? [];
		const observations = headings.find(h => h.level === 1 && h.heading.trim() === 'Observations');
		if (!observations) continue;

		const content = await app.vault.read(file);
		const start = observations.position.end.offset;
		const next = headings.find(h =>
			h.position.start.offset > observations.position.start.offset &&
			h.level <= observations.level
		);
		const section = content.slice(start, next?.position.start.offset ?? content.length);
		parseObservationSection(app, file, section, byNote);
	}

	const out: ObservationSignalMap = new Map();
	for (const [notePath, value] of byNote) {
		out.set(notePath, { months: value.months.size, quotes: value.quotes });
	}
	return out;
}

function parseObservationSection(
	app: App,
	sourceFile: TFile,
	section: string,
	out: Map<string, { months: Set<string>; quotes: number }>,
): void {
	let currentNotePath: string | null = null;
	for (const line of section.split('\n')) {
		if (/^(?: {2,}|\t+)[-*+]\s+/.test(line)) {
			if (!currentNotePath) continue;
			const signal = out.get(currentNotePath);
			if (signal) signal.quotes++;
			continue;
		}

		const topBullet = line.match(/^[-*+]\s+(.+)$/);
		if (!topBullet) continue;
		const linkpath = firstWikiLinkPath(topBullet[1] ?? '');
		if (!linkpath) {
			currentNotePath = null;
			continue;
		}
		const dest = app.metadataCache.getFirstLinkpathDest(linkpath, sourceFile.path);
		if (!(dest instanceof TFile)) {
			currentNotePath = null;
			continue;
		}
		currentNotePath = dest.path;
		let signal = out.get(currentNotePath);
		if (!signal) {
			signal = { months: new Set(), quotes: 0 };
			out.set(currentNotePath, signal);
		}
		signal.months.add(sourceFile.basename);
	}
}

function firstWikiLinkPath(text: string): string {
	const match = text.match(/\[\[([^\]]+)\]\]/);
	const inner = match?.[1]?.trim();
	if (!inner) return '';
	return inner.split('|')[0]?.split('#')[0]?.trim() ?? '';
}

function parseImportance(value: unknown): number | null {
	const n = typeof value === 'number'
		? value
		: typeof value === 'string'
			? Number(value.trim())
			: NaN;
	if (!Number.isFinite(n) || n < 0 || n > 5) return null;
	return n;
}

function parseEvalTags(value: unknown): string[] {
	const raw = Array.isArray(value)
		? value
		: typeof value === 'string'
			? value.split(',')
			: [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (typeof item !== 'string') continue;
		const tag = item.trim().replace(/^#/, '');
		if (tag) seen.add(tag);
	}
	return Array.from(seen);
}

function* walkMarkdown(folder: TFolder): Generator<TFile> {
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === 'md') yield child;
		if (child instanceof TFolder) yield* walkMarkdown(child);
	}
}
