import { App, TFolder, moment } from 'obsidian';

export const FRONTMATTER_REGEX = new RegExp('^[\\uFEFF]?---\\s*[^\\S\\r\\n]*[\\r\\n]+([\\s\\S]*?)[\\r\\n]+---[^\\S\\r\\n]*([\\r\\n]*)');

export async function ensureFolder(app: App, path: string): Promise<void> {
	const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/, '');
	const parts = normalizedPath.split('/');
	let currentPath = '';

	for (const part of parts) {
		currentPath = currentPath ? `${currentPath}/${part}` : part;
		const folder = app.vault.getAbstractFileByPath(currentPath);
		if (!(folder instanceof TFolder)) {
			await app.vault.createFolder(currentPath);
		}
	}
}

export async function applyTemplateString(
	template: string,
	date: moment.Moment,
	fileName: string,
	value: string = '',
	extraTokens: Record<string, string> = {},
): Promise<string> {
	const now = window.moment();
	let content = template;

	const replaceTokens = (text: string) => {
		let result = text;
		result = result.replace(/{{datetime:(.*?)}}/g, (_match, format: string) => date.format(format));
		result = result.replace(/{{date}}/g, date.format('YYYY-MM-DD'));
		result = result.replace(/{{time}}/g, date.format('HH:mm'));
		result = result.replace(/{{today}}/g, now.format('YYYY-MM-DD'));
		result = result.replace(/{{now}}/g, now.format('YYYY-MM-DDTHH:mm:ss'));
		result = result.replace(/{{value}}/g, value);
		return result;
	};

	content = replaceTokens(content);
	content = content.replace(/{{title}}/g, fileName);
	for (const [token, tokenValue] of Object.entries(extraTokens)) {
		content = content.replace(new RegExp(`{{${escapeRegExp(token)}}}`, 'g'), tokenValue);
	}
	return content;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function slugify(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export interface AttachmentTemplateContext {
	noteBasename: string;
	noteFolderPath: string;
	originalName: string;
	ext: string;
	md5?: string;
}

export function applyAttachmentTemplate(template: string, ctx: AttachmentTemplateContext): string {
	const now = window.moment();
	const tokens: Record<string, string> = {
		folder: ctx.noteFolderPath,
		slug: slugify(ctx.noteBasename),
		name: ctx.noteBasename,
		title: ctx.noteBasename,
		ext: ctx.ext,
		original: ctx.originalName,
		md5: ctx.md5 ?? '',
		date: now.format('YYYY-MM-DD'),
		time: now.format('HH:mm'),
		today: now.format('YYYY-MM-DD'),
		now: now.format('YYYY-MM-DDTHH:mm:ss'),
	};
	let result = template.replace(/{{datetime:(.*?)}}/g, (_m, fmt: string) => now.format(fmt));
	for (const [token, value] of Object.entries(tokens)) {
		result = result.replace(new RegExp(`{{${escapeRegExp(token)}}}`, 'g'), value);
	}
	return result;
}
