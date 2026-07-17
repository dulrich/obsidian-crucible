import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-image-metadata-tests');
const outfile = path.join(outdir, 'imageMetadata.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/orchestration/utils/imageMetadata.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: `
					export class TFile {
						constructor(path) {
							this.path = path;
							this.name = path.split('/').pop();
							this.extension = this.name.includes('.') ? this.name.split('.').pop() : '';
						}
					}
					export class TFolder {
						constructor(path) {
							this.path = path;
							this.name = path.split('/').pop();
						}
					}
					globalThis.__ObsTFile = TFile;
					globalThis.__ObsTFolder = TFolder;
					export function normalizePath(path) {
						return String(path).replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/^\\//, '').replace(/\\/$/, '');
					}
					export const Platform = { isMacOS: false };
					export const moment = {};
				`,
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const {
	addImageMetadataSidecarSource,
	hasCurrentImageMetadataSidecar,
	localizedImageInfo,
	writeImageMetadataSidecar,
} = await import(pathToFileURL(outfile));

function createFakeApp() {
	const files = new Map();
	const folders = new Set();
	const TFileStub = globalThis.__ObsTFile;
	const TFolderStub = globalThis.__ObsTFolder;
	const app = {
		vault: {
			getAbstractFileByPath(filePath) {
				if (files.has(filePath)) return new TFileStub(filePath);
				if (folders.has(filePath)) return new TFolderStub(filePath);
				return null;
			},
			async createFolder(folderPath) {
				folders.add(folderPath);
			},
			async create(filePath, content) {
				files.set(filePath, content);
				return new TFileStub(filePath);
			},
			async modify(file, content) {
				files.set(file.path, content);
			},
			async read(file) {
				return files.get(file.path) ?? '';
			},
			getMarkdownFiles() {
				return Array.from(files.keys()).filter(p => p.endsWith('.md')).map(p => new TFileStub(p));
			},
		},
		metadataCache: {
			// Always-fresh cache derived from the file map, so updateFrontmatter's
			// write-consistency barrier takes its fast path in these tests.
			getFileCache(file) {
				const content = files.get(file.path) ?? '';
				const m = /^---\n[\s\S]*?\n---/.exec(content);
				if (!m) return {};
				const frontmatter = {};
				for (const line of m[0].split('\n').slice(1, -1)) {
					const key = /^(\S[^:]*):/.exec(line);
					if (key) frontmatter[key[1].trim()] = null;
				}
				return { frontmatter, frontmatterPosition: { start: { offset: 0 }, end: { offset: m[0].length } } };
			},
			on() { return {}; },
			offref() {},
		},
		fileManager: {
			async processFrontMatter(file, fn) {
				const content = files.get(file.path) ?? '';
				const match = /^---\n([\s\S]*?)\n---\n?/.exec(content);
				const fm = {};
				if (match) {
					const lines = match[1].split('\n');
					let activeList = null;
					for (const line of lines) {
						const scalar = /^([^:]+):\s*(.*)$/.exec(line);
						if (scalar) {
							activeList = null;
							const [, key, value] = scalar;
							if (value === '') {
								fm[key] = [];
								activeList = key;
							} else {
								fm[key] = value.replace(/^"|"$/g, '');
							}
							continue;
						}
						const item = /^\s+-\s+(.*)$/.exec(line);
						if (item && activeList) fm[activeList].push(item[1].replace(/^"|"$/g, ''));
					}
				}
				fn(fm);
				const yaml = Object.entries(fm).flatMap(([key, value]) => {
					if (Array.isArray(value)) return [key + ':', ...value.map(v => '  - "' + v + '"')];
					return [key + ': "' + value + '"'];
				}).join('\n');
				const body = match ? content.slice(match[0].length) : '';
				files.set(file.path, `---\n${yaml}\n---\n${body}`);
			},
		},
		__files: files,
	};
	return app;
}

test('localizedImageInfo derives MD5 sidecar path', () => {
	const info = localizedImageInfo('notes/_attachments/a/0123456789abcdef0123456789abcdef_MD5.webp');

	assert.equal(info?.md5, '0123456789abcdef0123456789abcdef');
	assert.equal(info?.ext, 'webp');
	assert.equal(info?.sidecarPath, 'notes/_attachments/a/0123456789abcdef0123456789abcdef_MD5.md');
	assert.equal(localizedImageInfo('notes/_attachments/a/image.webp'), null);
});

test('writeImageMetadataSidecar writes current schema note and merges source paths', async () => {
	const app = createFakeApp();
	const image = localizedImageInfo('notes/_attachments/a/0123456789abcdef0123456789abcdef_MD5.png');

	await writeImageMetadataSidecar(app, {
		image,
		sourceNotePath: 'notes/source.md',
		providerModel: { providerId: 'openai', modelId: 'gpt-vision' },
		result: {
			description: 'A chart with visible labels.',
			extractedText: 'Revenue\\n2026',
			rawText: '{}',
			finishReason: 'stop',
		},
		schemaVersion: 1,
	});

	const content = app.__files.get(image.sidecarPath);
	assert.match(content, /image-metadata-schema: 1/);
	assert.match(content, /image-metadata-provider: "openai"/);
	assert.match(content, /# Description\n\nA chart with visible labels\./);
	assert.match(content, /# Extracted text\n\nRevenue\\n2026/);
	assert.equal(await hasCurrentImageMetadataSidecar(app, image.sidecarPath, 1), true);

	await addImageMetadataSidecarSource(app, image.sidecarPath, 'notes/other.md');
	await addImageMetadataSidecarSource(app, image.sidecarPath, 'notes/source.md');
	const updated = app.__files.get(image.sidecarPath);
	assert.match(updated, /source-note-paths:\n {2}- "notes\/other\.md"\n {2}- "notes\/source\.md"/);
});
