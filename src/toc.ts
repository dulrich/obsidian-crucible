import { App, MarkdownView, setIcon } from 'obsidian';
import { ToCPosition } from './types';

export class TableOfContentsUI {
	app: App;
	view: MarkdownView;
	position: ToCPosition;
	containerEl: HTMLElement | null = null;
	isCollapsed: boolean = true;

	constructor(app: App, view: MarkdownView, position: ToCPosition) {
		this.app = app;
		this.view = view;
		this.position = position;
	}

	load() {
		const leafEl = this.view.containerEl;
		this.containerEl = leafEl.createDiv({ cls: `personal-internet-toc-container pos-${this.position} is-collapsed` });
		this.render();
	}

	unload() {
		if (this.containerEl) {
			this.containerEl.remove();
			this.containerEl = null;
		}
	}

	render() {
		if (!this.containerEl) return;
		this.containerEl.empty();

		const contentEl = this.containerEl.createDiv({ cls: 'personal-internet-toc-content' });
		
		const file = this.view.file;
		if (file) {
			const cache = this.app.metadataCache.getFileCache(file);
			const headings = cache?.headings || [];

			headings.forEach(heading => {
				const item = contentEl.createDiv({ 
					cls: `personal-internet-toc-item level-${heading.level}`,
					text: heading.heading 
				});
				item.onclick = () => {
					this.view.setEphemeralState({ line: heading.position.start.line });
				};
			});
		}

		const footer = this.containerEl.createDiv({ cls: 'personal-internet-toc-footer' });
		const title = footer.createDiv({ cls: 'personal-internet-toc-footer-title' });
		setIcon(title, 'menu');
		title.createSpan({ text: 'Table of Contents' });

		const chevron = footer.createDiv({ cls: 'personal-internet-toc-chevron' });
		setIcon(chevron, this.isCollapsed ? 'chevron-down' : 'chevron-up');

		footer.onclick = () => {
			this.isCollapsed = !this.isCollapsed;
			this.containerEl?.toggleClass('is-collapsed', this.isCollapsed);
			this.render();
		};
	}
}
