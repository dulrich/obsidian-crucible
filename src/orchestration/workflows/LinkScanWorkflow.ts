import { TFile, normalizePath } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { todayInTz } from '../utils/dates';
import { ensureFolder } from '../../utils';
import { updateFrontmatter } from '../../frontmatter';
import { extractUrls } from '../utils/urlExtract';
import { CanonicalizedUrl, canonicalizeUrl, shortHash } from '../utils/urlCanonicalize';

interface AggregateEntry {
	canon: CanonicalizedUrl;
	sourceWikilinks: Set<string>;
}

export class LinkScanWorkflow implements Workflow {
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

		for (const file of app.vault.getMarkdownFiles()) {
			if (isExcluded(file.path, exclusions)) continue;
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			if (fm && fm['type'] === 'link-record') continue;

			scannedNotes++;
			const content = await app.vault.cachedRead(file);
			const urls = extractUrls(content);
			if (urls.length === 0) continue;

			const wikilink = `[[${stripMdExt(file.path)}]]`;

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

		for (const entry of aggregate.values()) {
			const result = await this.applyToRegistry(plugin, registryRoot, today, entry);
			if (result.created) created++;
			else updated++;
			if (result.candidateFlagged) candidatesFlagged++;
			outputPaths.push(result.path);
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

	private async applyToRegistry(
		plugin: WorkflowContext['plugin'],
		root: string,
		today: string,
		entry: AggregateEntry,
	): Promise<{ path: string; created: boolean; candidateFlagged: boolean }> {
		const app = plugin.app;
		const targetPath = await this.resolveTargetPath(app, root, entry.canon);

		const existing = app.vault.getAbstractFileByPath(targetPath);
		if (existing instanceof TFile) {
			let candidateFlagged = false;
			await updateFrontmatter(app, existing, (fm) => {
				const merged = mergeSourceNotes(fm['source_notes'], entry.sourceWikilinks);
				fm['type'] = 'link-record';
				fm['url'] = entry.canon.url;
				fm['canonical_url'] = entry.canon.canonical;
				fm['domain'] = entry.canon.domain;
				fm['source_notes'] = merged;
				if (typeof fm['first_seen'] !== 'string' || !fm['first_seen']) fm['first_seen'] = today;
				fm['last_seen'] = today;
				if (typeof fm['state'] !== 'string' || !fm['state']) fm['state'] = 'pending';
				if (typeof fm['discovery_method'] !== 'string' || !fm['discovery_method']) fm['discovery_method'] = 'scan';
				ensureNullableKeys(fm);
				if (entry.canon.youtubeVideoId) {
					const current = fm['yt-video-id'];
					if (typeof current !== 'string' || !current) fm['yt-video-id'] = entry.canon.youtubeVideoId;
				}
				if (entry.canon.trackedSource) {
					if (fm['tracked_source'] === false || fm['tracked_source'] === undefined || fm['tracked_source'] === null) {
						fm['tracked_source'] = 'candidate';
						fm['tracked_source_type'] = entry.canon.trackedSource.type;
						candidateFlagged = true;
					}
				}
			});
			return { path: targetPath, created: false, candidateFlagged };
		}

		const stub = `# Link: ${entry.canon.url}\n\n## Notes\n`;
		const file = await app.vault.create(targetPath, stub);
		let candidateFlagged = false;
		await updateFrontmatter(app, file, (fm) => {
			fm['type'] = 'link-record';
			fm['url'] = entry.canon.url;
			fm['canonical_url'] = entry.canon.canonical;
			fm['domain'] = entry.canon.domain;
			fm['state'] = 'pending';
			fm['source_notes'] = Array.from(entry.sourceWikilinks);
			fm['first_seen'] = today;
			fm['last_seen'] = today;
			fm['discovery_method'] = 'scan';
			fm['tracked_source'] = false;
			fm['tracked_source_type'] = null;
			fm['tracked_source_note'] = null;
			fm['referred_material'] = null;
			fm['decision_reason'] = null;
			fm['yt-video-id'] = entry.canon.youtubeVideoId ?? null;
			if (entry.canon.trackedSource) {
				fm['tracked_source'] = 'candidate';
				fm['tracked_source_type'] = entry.canon.trackedSource.type;
				candidateFlagged = true;
			}
		});
		return { path: targetPath, created: true, candidateFlagged };
	}

	private async resolveTargetPath(
		app: WorkflowContext['plugin']['app'],
		root: string,
		canon: CanonicalizedUrl,
	): Promise<string> {
		const baseSlug = canon.filename;
		let candidate = `${root}/${baseSlug}.md`;
		const existing = app.vault.getAbstractFileByPath(candidate);
		if (!(existing instanceof TFile)) return candidate;

		const fm = app.metadataCache.getFileCache(existing)?.frontmatter;
		const existingCanonical = typeof fm?.['canonical_url'] === 'string' ? fm['canonical_url'] : '';
		if (existingCanonical === canon.canonical) return candidate;

		const suffix = shortHash(canon.canonical);
		candidate = `${root}/${baseSlug}-${suffix}.md`;
		return candidate;
	}
}

function normalizeExclusions(raw: string[], registryRoot: string): string[] {
	const out = new Set<string>();
	for (const item of raw) {
		const trimmed = item.trim().replace(/\/+$/, '');
		if (trimmed) out.add(trimmed);
	}
	out.add(registryRoot.replace(/\/+$/, ''));
	return Array.from(out);
}

function isExcluded(path: string, exclusions: string[]): boolean {
	for (const excl of exclusions) {
		if (path === excl) return true;
		if (path.startsWith(`${excl}/`)) return true;
	}
	return false;
}

function stripMdExt(path: string): string {
	return path.endsWith('.md') ? path.slice(0, -3) : path;
}

function mergeSourceNotes(existing: unknown, additions: Set<string>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	if (Array.isArray(existing)) {
		for (const v of existing) {
			if (typeof v === 'string' && v.trim() && !seen.has(v)) {
				seen.add(v);
				out.push(v);
			}
		}
	} else if (typeof existing === 'string' && existing.trim()) {
		seen.add(existing);
		out.push(existing);
	}
	for (const v of additions) {
		if (!seen.has(v)) {
			seen.add(v);
			out.push(v);
		}
	}
	return out;
}

function ensureNullableKeys(fm: Record<string, unknown>): void {
	const nullable = ['tracked_source_note', 'referred_material', 'decision_reason'];
	for (const key of nullable) {
		if (!(key in fm)) fm[key] = null;
	}
	if (!('tracked_source' in fm)) fm['tracked_source'] = false;
	if (!('tracked_source_type' in fm)) fm['tracked_source_type'] = null;
	if (!('yt-video-id' in fm)) fm['yt-video-id'] = null;
}
