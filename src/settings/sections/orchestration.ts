import { Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { CrucibleSettings } from "../../types";
import { addWarningIcon } from "../shared";
import { bindToggle } from "../bind";
import {
	renderOrchestrationQueueGlobalSettings,
	renderQueueActionsSettings,
	renderRoutineNoticesSettings,
	renderTriggersSettings,
} from "./orchestrationQueue";
import { renderOrchestrationSearchSettings } from "./orchestrationSearch";
import { renderIngestionDashboardSettings } from "./orchestrationIngestion";
import {
	renderEditBlogsTrackerWorkflow,
	renderEditDailyBriefWorkflow,
	renderEditLinkScanWorkflow,
	renderEditTranscriptRefineWorkflow,
	renderEditYoutubeTrackerWorkflow,
} from "./orchestrationWorkflows";

/**
 * WP-rem-R4 (F4 remediation): the Orchestrate settings tab's entry point. Owns the
 * `editingWorkflowId` list/edit routing and `getWorkflowMeta`/`getWorkflowWarning` (both need to
 * live where the workflow list is rendered), and calls into sibling modules split by owned panel —
 * `orchestrationQueue.ts` (global queue settings, routine notices, triggers, actions),
 * `orchestrationSearch.ts` (the Search panel), `orchestrationIngestion.ts` (the Ingestion
 * dashboard panel), and `orchestrationWorkflows.ts` (the five per-workflow editors). Panel calls
 * below run in the exact DOM order the pre-split single-function render used.
 */

interface WorkflowMeta {
	id: string;
	name: string;
	description: string;
	enabledKey: keyof CrucibleSettings;
	render: (containerEl: HTMLElement) => void;
}

function getWorkflowMeta(tab: CrucibleSettingTab): WorkflowMeta[] {
	return [
		{
			id: 'daily_brief_lite',
			name: 'Daily Brief Lite',
			description: 'Fetch FX rates and weather, then inject them into today\'s daily note.',
			enabledKey: 'orchestrationDailyBriefEnabled',
			render: (el) => renderEditDailyBriefWorkflow(tab, el),
		},
		{
			id: 'transcript_refine',
			name: 'Transcript Refine',
			description: 'Run an AI chain against a target transcript note.',
			enabledKey: 'orchestrationTranscriptRefineEnabled',
			render: (el) => renderEditTranscriptRefineWorkflow(tab, el),
		},
		{
			id: 'youtube_tracker',
			name: 'YouTube Tracker',
			description: 'Poll configured YouTube channels for new videos and create intake notes.',
			enabledKey: 'orchestrationYoutubeTrackerEnabled',
			render: (el) => renderEditYoutubeTrackerWorkflow(tab, el),
		},
		{
			id: 'blogs_tracker',
			name: 'Blogs Tracker',
			description: 'Poll configured blog RSS feeds for new posts and create intake notes.',
			enabledKey: 'orchestrationBlogsTrackerEnabled',
			render: (el) => renderEditBlogsTrackerWorkflow(tab, el),
		},
		{
			id: 'link_scan',
			name: 'Link Scan',
			description: 'Scan the vault for URLs and build a canonical link registry.',
			enabledKey: 'orchestrationLinkScanEnabled',
			render: (el) => renderEditLinkScanWorkflow(tab, el),
		},
	];
}

function getWorkflowWarning(tab: CrucibleSettingTab, workflowId: string): string | null {
	if (workflowId === 'daily_brief_lite' && !tab.plugin.settings.dailyEnabled) {
		return 'Daily is disabled; this workflow will fail with a warning until Daily is enabled.';
	}
	return null;
}

export function renderOrchestrationSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();
	const workflows = getWorkflowMeta(tab);

	if (tab.editingWorkflowId !== null) {
		const meta = workflows.find(w => w.id === tab.editingWorkflowId);
		if (meta) {
			const heading = new Setting(containerEl).setName(`Edit Workflow: ${meta.name}`).setHeading();
			const warning = getWorkflowWarning(tab, meta.id);
			if (warning) addWarningIcon(heading.nameEl, warning);
			const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
			if (warning) {
				group.createDiv({ cls: 'crucible-setting-warning', text: warning });
			}
			meta.render(group);
			return;
		}
		tab.editingWorkflowId = null;
	}

	renderOrchestrationQueueGlobalSettings(tab, containerEl);
	renderRoutineNoticesSettings(tab, containerEl);
	renderOrchestrationSearchSettings(tab, containerEl);
	renderWorkflowsListSection(tab, containerEl, workflows, save, s);
	renderTriggersSettings(tab, containerEl);
	renderQueueActionsSettings(tab, containerEl);
	renderIngestionDashboardSettings(tab, containerEl);
}

function renderWorkflowsListSection(
	tab: CrucibleSettingTab,
	containerEl: HTMLElement,
	workflows: WorkflowMeta[],
	save: () => Promise<void>,
	s: CrucibleSettings,
): void {
	new Setting(containerEl).setName('Workflows').setHeading();
	containerEl.createEl('p', { text: 'Toggle workflows on or off here. Click the pencil to edit a workflow\'s settings.' });

	const workflowsGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	workflows.forEach((meta, index) => {
		if (index > 0) workflowsGroup.createEl('hr', { cls: 'crucible-row-divider' });
		const setting = bindToggle(workflowsGroup, {
			name: meta.name,
			desc: meta.description,
			tooltip: 'Enabled',
			get: () => s[meta.enabledKey] as boolean,
			set: (v) => { (s[meta.enabledKey] as boolean) = v; },
		}, save);
		setting.addExtraButton(cb => cb.setIcon('pencil').setTooltip('Edit workflow').onClick(() => {
			tab.editingWorkflowId = meta.id;
			tab.display();
		}));
		const warning = getWorkflowWarning(tab, meta.id);
		if (warning) addWarningIcon(setting.nameEl, warning);
	});
}
