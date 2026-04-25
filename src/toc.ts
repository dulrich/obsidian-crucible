import { App, MarkdownView, setIcon } from 'obsidian';
import { ToCPosition, ToCCollapseBehavior } from './types';

export class TableOfContentsUI {
	app: App;
	view: MarkdownView;
	position: ToCPosition;
	collapseBehavior: ToCCollapseBehavior;
	containerEl: HTMLElement | null = null;
	isCollapsed: boolean = true;

	constructor(app: App, view: MarkdownView, position: ToCPosition, collapseBehavior: ToCCollapseBehavior) {
		this.app = app;
		this.view = view;
		this.position = position;
		this.collapseBehavior = collapseBehavior;
	}

	load() {
		const leafEl = this.view.containerEl;
		this.containerEl = leafEl.createDiv({ cls: `personal-internet-toc-container pos-${this.position} is-collapsed` });
		this.containerEl.setAttribute('tabindex', '-1');
		
		if (this.collapseBehavior === 'blur') {
			this.containerEl.addEventListener('focusout', (e) => {
				const relatedTarget = e.relatedTarget as Node;
				if (this.containerEl && !this.containerEl.contains(relatedTarget)) {
					this.isCollapsed = true;
					this.containerEl.addClass('is-collapsed');
					this.render();
				}
			});
		}

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
					if (this.collapseBehavior === 'click') {
						this.isCollapsed = true;
						this.containerEl?.addClass('is-collapsed');
						this.render();
					}
				};
			});
		}

		const footer = this.containerEl.createDiv({ cls: 'personal-internet-toc-footer' });
		const title = footer.createDiv({ cls: 'personal-internet-toc-footer-title' });
		setIcon(title, 'menu');
		title.createSpan({ text: 'Table of Contents' });

		const chevron = footer.createDiv({ cls: 'personal-internet-toc-chevron' });
		setIcon(chevron, this.isCollapsed ? 'chevron-down' : 'chevron-up');

		footer.onclick = (e) => {
			e.stopPropagation();
			this.isCollapsed = !this.isCollapsed;
			this.containerEl?.toggleClass('is-collapsed', this.isCollapsed);
			this.render();
			if (!this.isCollapsed && this.collapseBehavior === 'blur') {
				this.containerEl?.focus();
			}
		};
	}
}
