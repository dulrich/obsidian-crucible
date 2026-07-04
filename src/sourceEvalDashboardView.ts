import { IconName, ItemView, WorkspaceLeaf } from 'obsidian';
import CruciblePlugin from './main';
import { SourceEvalDashboardUI } from './sourceEvalDashboard';

export const SOURCE_EVAL_DASHBOARD_VIEW_TYPE = 'crucible-source-eval-dashboard';

export class SourceEvalDashboardView extends ItemView {
	private plugin: CruciblePlugin;
	private ui: SourceEvalDashboardUI | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: CruciblePlugin) {
		super(leaf);
		this.plugin = plugin;
		this.icon = 'scale';
		this.navigation = true;
	}

	getViewType(): string { return SOURCE_EVAL_DASHBOARD_VIEW_TYPE; }
	getDisplayText(): string { return 'Source eval dashboard'; }
	getIcon(): IconName { return 'scale'; }

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('crucible-source-eval-dashboard');
		this.ui = new SourceEvalDashboardUI(this.plugin, contentEl);
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
