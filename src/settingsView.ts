import { ItemView, WorkspaceLeaf, IconName } from 'obsidian';
import CruciblePlugin from './main';
import { CrucibleSettingTab } from './settings';

export const CRUCIBLE_SETTINGS_VIEW_TYPE = 'crucible-settings-view';

export class CrucibleSettingsView extends ItemView {
	private plugin: CruciblePlugin;
	private settingTab: CrucibleSettingTab | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: CruciblePlugin) {
		super(leaf);
		this.plugin = plugin;
		this.icon = 'anvil';
		this.navigation = true;
	}

	getViewType(): string { return CRUCIBLE_SETTINGS_VIEW_TYPE; }
	getDisplayText(): string { return 'Crucible settings'; }
	getIcon(): IconName { return 'anvil'; }

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		// Mark as a Crucible scroll host so settings.ts can find this scroll
		// container the same way it finds .vertical-tab-content in the modal.
		contentEl.classList.add('crucible-settings-host');

		const tab = new CrucibleSettingTab(this.app, this.plugin);
		tab.containerEl = contentEl;
		this.settingTab = tab;
		tab.display();
	}

	async onClose(): Promise<void> {
		if (this.settingTab) {
			this.settingTab.hide();
			this.settingTab = null;
		}
		this.contentEl.empty();
	}
}
