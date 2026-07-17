import { App, TFile, normalizePath } from 'obsidian';
import { FRONTMATTER_REGEX, ensureFolder } from '../../utils';
import { updateFrontmatter } from '../../frontmatter';
import { yamlString } from '../../frontmatterValues';
import type { ProviderImageExtractionResult, ProviderModelRef } from '../../types';

export const IMAGE_METADATA_SCHEMA_VERSION = 1;

export interface LocalizedImageInfo {
	path: string;
	md5: string;
	ext: string;
	sidecarPath: string;
}

export interface ImageMetadataWriteInput {
	image: LocalizedImageInfo;
	sourceNotePath?: string;
	providerModel: ProviderModelRef;
	result: ProviderImageExtractionResult;
	schemaVersion?: number;
}

export function localizedImageInfo(path: string): LocalizedImageInfo | null {
	const normalized = normalizePath(path);
	const name = normalized.split('/').pop() ?? '';
	const match = name.match(/([a-f0-9]{32})_MD5\.([A-Za-z0-9]+)$/i);
	if (!match?.[1] || !match?.[2]) return null;
	const sidecarPath = normalized.replace(/\.[^/.]+$/, '.md');
	return {
		path: normalized,
		md5: match[1].toLowerCase(),
		ext: match[2].toLowerCase(),
		sidecarPath,
	};
}

export function imageMimeType(ext: string): string {
	switch (ext.toLowerCase()) {
		case 'avif': return 'image/avif';
		case 'bmp': return 'image/bmp';
		case 'gif': return 'image/gif';
		case 'jpg':
		case 'jpeg': return 'image/jpeg';
		case 'png': return 'image/png';
		case 'svg': return 'image/svg+xml';
		case 'webp': return 'image/webp';
		default: return `image/${ext.toLowerCase()}`;
	}
}

export async function hasCurrentImageMetadataSidecar(app: App, sidecarPath: string, schemaVersion: number): Promise<boolean> {
	const file = app.vault.getAbstractFileByPath(sidecarPath);
	if (!(file instanceof TFile)) return false;
	const content = await app.vault.read(file);
	return frontmatterNumber(content, 'image-metadata-schema') === schemaVersion;
}

export async function addImageMetadataSidecarSource(app: App, sidecarPath: string, sourceNotePath: string | undefined): Promise<void> {
	if (!sourceNotePath) return;
	const file = app.vault.getAbstractFileByPath(sidecarPath);
	if (!(file instanceof TFile)) return;
	await updateFrontmatter(app, file, frontmatter => {
		const existingValue = frontmatter['source-note-paths'];
		const existing = Array.isArray(existingValue)
			? existingValue.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
			: [];
		const next = new Set(existing);
		next.add(sourceNotePath);
		frontmatter['source-note-paths'] = Array.from(next).sort();
	});
}

export async function findReusableImageMetadataSidecar(app: App, image: LocalizedImageInfo, schemaVersion: number): Promise<TFile | null> {
	for (const file of app.vault.getMarkdownFiles()) {
		if (file.path === image.sidecarPath) continue;
		if (!file.name.includes(`${image.md5}_MD5`)) continue;
		const content = await app.vault.read(file);
		if (frontmatterNumber(content, 'image-metadata-schema') === schemaVersion && frontmatterString(content, 'image-md5') === image.md5) {
			return file;
		}
	}
	return null;
}

export async function copyImageMetadataSidecar(app: App, image: LocalizedImageInfo, reusable: TFile, input: Omit<ImageMetadataWriteInput, 'result'>): Promise<void> {
	const content = await app.vault.read(reusable);
	const extracted = extractMetadataSections(content);
	await writeImageMetadataSidecar(app, {
		...input,
		image,
		result: {
			description: extracted.description,
			extractedText: extracted.extractedText,
			rawText: '',
			finishReason: 'stop',
		},
	});
}

export async function writeImageMetadataSidecar(app: App, input: ImageMetadataWriteInput): Promise<void> {
	const folder = input.image.sidecarPath.split('/').slice(0, -1).join('/');
	if (folder) await ensureFolder(app, folder);
	const existing = app.vault.getAbstractFileByPath(input.image.sidecarPath);
	const sourceNotePaths = existing instanceof TFile
		? mergeSourceNotePaths(await app.vault.read(existing), input.sourceNotePath)
		: mergeSourceNotePaths('', input.sourceNotePath);
	const content = buildImageMetadataContent(input, sourceNotePaths);
	if (existing instanceof TFile) await app.vault.modify(existing, content);
	else await app.vault.create(input.image.sidecarPath, content);
}

function buildImageMetadataContent(input: ImageMetadataWriteInput, sourceNotePaths: string[]): string {
	const schemaVersion = input.schemaVersion ?? IMAGE_METADATA_SCHEMA_VERSION;
	return [
		'---',
		`resource: ${yamlString(input.image.path)}`,
		`image-md5: ${yamlString(input.image.md5)}`,
		`image-extension: ${yamlString(input.image.ext)}`,
		`image-metadata-schema: ${schemaVersion}`,
		`image-metadata-provider: ${yamlString(input.providerModel.providerId)}`,
		`image-metadata-model: ${yamlString(input.providerModel.modelId)}`,
		`image-metadata-extracted: ${yamlString(new Date().toISOString())}`,
		'source-note-paths:',
		...sourceNotePaths.map(path => `  - ${yamlString(path)}`),
		'---',
		'',
		'# Description',
		'',
		input.result.description.trim(),
		'',
		'# Extracted text',
		'',
		input.result.extractedText.trim(),
		'',
	].join('\n');
}

function mergeSourceNotePaths(content: string, sourceNotePath: string | undefined): string[] {
	const paths = new Set<string>();
	const fm = frontmatterBody(content);
	if (fm) {
		const listMatch = fm.match(/^source-note-paths:\s*\n((?:\s+-\s+.*\n?)*)/m);
		const listBody = listMatch?.[1] ?? '';
		for (const line of listBody.split(/\r?\n/)) {
			const value = line.replace(/^\s+-\s+/, '').trim();
			if (value) paths.add(unquoteYamlString(value));
		}
	}
	if (sourceNotePath) paths.add(sourceNotePath);
	return Array.from(paths).sort();
}

function extractMetadataSections(content: string): { description: string; extractedText: string } {
	return {
		description: extractSection(content, 'Description'),
		extractedText: extractSection(content, 'Extracted text'),
	};
}

function extractSection(content: string, heading: string): string {
	const re = new RegExp(`^# ${escapeRegex(heading)}\\s*\\n([\\s\\S]*?)(?=\\n# |\\s*$)`, 'm');
	return re.exec(content)?.[1]?.trim() ?? '';
}

function frontmatterBody(content: string): string | null {
	return FRONTMATTER_REGEX.exec(content)?.[1] ?? null;
}

function frontmatterNumber(content: string, key: string): number | undefined {
	const raw = frontmatterScalar(content, key);
	const n = raw === undefined ? NaN : Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

function frontmatterString(content: string, key: string): string | undefined {
	const raw = frontmatterScalar(content, key);
	return raw === undefined ? undefined : unquoteYamlString(raw);
}

function frontmatterScalar(content: string, key: string): string | undefined {
	const fm = frontmatterBody(content);
	if (!fm) return undefined;
	const match = new RegExp(`^${escapeRegex(key)}:\\s*(.*)$`, 'm').exec(fm);
	return match?.[1]?.trim();
}

function unquoteYamlString(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			return typeof parsed === 'string' ? parsed : trimmed;
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
