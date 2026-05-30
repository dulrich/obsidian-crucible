import { parseMarkdownLink } from './format';

// Stateless table-cell renderers (no vault access). Each appends into the given
// <td>; an external anchor opens in a new tab with rel=noopener.

export function renderExternalLink(td: HTMLElement, url: string, label: string): void {
	const a = td.createEl('a', { text: label, href: url });
	a.setAttr('target', '_blank');
	a.setAttr('rel', 'noopener');
}

export function renderChannelLink(td: HTMLElement, channelId: string, name: string): void {
	const md = parseMarkdownLink(name);
	const href = md?.url ?? `https://www.youtube.com/channel/${channelId}`;
	const label = md?.label ?? name;
	const a = td.createEl('a', { text: label, href });
	a.setAttr('target', '_blank');
	a.setAttr('rel', 'noopener');
}

export function renderAuthorCell(td: HTMLElement, name: string): void {
	const md = parseMarkdownLink(name);
	if (md) {
		const a = td.createEl('a', { text: md.label, href: md.url });
		a.setAttr('target', '_blank');
		a.setAttr('rel', 'noopener');
	} else {
		td.setText(name);
	}
}

export function renderIgnoredIdCell(td: HTMLElement, id: string, href: string | null): void {
	if (href) {
		const a = td.createEl('a', { text: id, href });
		a.setAttr('target', '_blank');
		a.setAttr('rel', 'noopener');
	} else {
		td.setText(id);
	}
}
