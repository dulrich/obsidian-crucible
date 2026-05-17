import { App, TFolder, moment } from 'obsidian';

export const FRONTMATTER_REGEX = /^[\uFEFF]?---\s*[^\S\r\n]*[\r\n]+([\s\S]*?)[\r\n]+---[^\S\r\n]*([\r\n]*)/;

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
