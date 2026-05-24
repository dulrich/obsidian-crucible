import { ItemView, WorkspaceLeaf, IconName } from 'obsidian';
import CruciblePlugin from './main';
import { IngestionDashboardUI } from './ingestionDashboard';

export const INGESTION_DASHBOARD_VIEW_TYPE = 'crucible-ingestion-dashboard';

export class IngestionDashboardView extends ItemView {
	private plugin: CruciblePlugin;
	private ui: IngestionDashboardUI | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: CruciblePlugin) {
		super(leaf);
		this.plugin = plugin;
		this.icon = 'inbox';
		this.navigation = true;
	}

	getViewType(): string { return INGESTION_DASHBOARD_VIEW_TYPE; }
	getDisplayText(): string { return 'Ingestion dashboard'; }
	getIcon(): IconName { return 'inbox'; }

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('crucible-ingestion-dashboard');
		this.ui = new IngestionDashboardUI(this.plugin, contentEl);
		this.ui.mount();
	}

	async onClose(): Promise<void> {
		if (this.ui) {
			this.ui.unmount();
			this.ui = null;
		}
		this.contentEl.empty();
	}
}
