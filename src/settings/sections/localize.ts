/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting, Notice } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { ImageConvertFormat, LocalizeMediaType, OBSIDIAN_NATIVE_EMBED_FORMATS } from "../../types";
import { bindToggle, bindText, bindNumber, bindDropdown } from "../bind";

function getLocalizeFlag(tab: CrucibleSettingTab, type: LocalizeMediaType, kind: 'attached' | 'pasted'): boolean {
	const s = tab.plugin.settings;
	if (type === 'images') return kind === 'attached' ? s.localizeAttachmentsImagesProcessAttached : s.localizeAttachmentsImagesProcessPasted;
	if (type === 'audio') return kind === 'attached' ? s.localizeAttachmentsAudioProcessAttached : s.localizeAttachmentsAudioProcessPasted;
	if (type === 'video') return kind === 'attached' ? s.localizeAttachmentsVideoProcessAttached : s.localizeAttachmentsVideoProcessPasted;
	return kind === 'attached' ? s.localizeAttachmentsPdfProcessAttached : s.localizeAttachmentsPdfProcessPasted;
}

function setLocalizeFlag(tab: CrucibleSettingTab, type: LocalizeMediaType, kind: 'attached' | 'pasted', value: boolean): void {
	const s = tab.plugin.settings;
	if (type === 'images') { if (kind === 'attached') s.localizeAttachmentsImagesProcessAttached = value; else s.localizeAttachmentsImagesProcessPasted = value; return; }
	if (type === 'audio') { if (kind === 'attached') s.localizeAttachmentsAudioProcessAttached = value; else s.localizeAttachmentsAudioProcessPasted = value; return; }
	if (type === 'video') { if (kind === 'attached') s.localizeAttachmentsVideoProcessAttached = value; else s.localizeAttachmentsVideoProcessPasted = value; return; }
	if (kind === 'attached') s.localizeAttachmentsPdfProcessAttached = value; else s.localizeAttachmentsPdfProcessPasted = value;
}

function getLocalizeWhitelist(tab: CrucibleSettingTab, type: LocalizeMediaType): string[] {
	const s = tab.plugin.settings;
	if (type === 'images') return s.localizeAttachmentsImagesWhitelist;
	if (type === 'audio') return s.localizeAttachmentsAudioWhitelist;
	if (type === 'video') return s.localizeAttachmentsVideoWhitelist;
	return s.localizeAttachmentsPdfWhitelist;
}

export function renderLocalizeAttachmentsSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();
	containerEl.createEl('hr');
	new Setting(containerEl).setName('Localize attachments').setHeading();
	containerEl.createEl('p', { text: 'Standalone Lint command (not part of Lint: all). Downloads remote media, moves local attachments into a per-note folder, and optionally converts images.' });

	new Setting(containerEl).setName('Automatic triggers').setHeading();
	const triggerGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	bindToggle(triggerGroup, { name: 'On note create', desc: 'Run localize when a Markdown note is created with content.', get: () => s.localizeAttachmentsTriggerOnCreate, set: (v) => { s.localizeAttachmentsTriggerOnCreate = v; } }, save);
	triggerGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindToggle(triggerGroup, { name: 'On note edit', desc: 'Debounced run on modify (3s).', get: () => s.localizeAttachmentsTriggerOnEdit, set: (v) => { s.localizeAttachmentsTriggerOnEdit = v; } }, save);
	triggerGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindToggle(triggerGroup, { name: 'On paste', desc: 'Intercept pasted media and route into the attachment folder.', get: () => s.localizeAttachmentsTriggerOnPaste, set: (v) => { s.localizeAttachmentsTriggerOnPaste = v; } }, save);

	new Setting(containerEl).setName('Media types').setHeading();
	const renderTypeGroup = (type: LocalizeMediaType, label: string) => {
		new Setting(containerEl).setName(label).setHeading();
		const g = containerEl.createDiv({ cls: 'crucible-settings-group' });
		const getWhitelist = () => getLocalizeWhitelist(tab, type);

		bindToggle(g, { name: 'Handle when attached or remote', get: () => getLocalizeFlag(tab, type, 'attached'), set: (v) => { setLocalizeFlag(tab, type, 'attached', v); } }, save);
		g.createEl('hr', { cls: 'crucible-row-divider' });
		bindToggle(g, { name: 'Handle when pasted', get: () => getLocalizeFlag(tab, type, 'pasted'), set: (v) => { setLocalizeFlag(tab, type, 'pasted', v); } }, save);
		g.createEl('hr', { cls: 'crucible-row-divider' });
		const wlSetting = new Setting(g).setName('Allowed extensions').setDesc('Only extensions checked here are eligible.');
		const grid = wlSetting.controlEl.createDiv({ cls: 'crucible-checkbox-grid' });
		for (const ext of OBSIDIAN_NATIVE_EMBED_FORMATS[type]) {
			const itemLabel = grid.createEl('label', { cls: 'crucible-checkbox-grid-item' });
			const cb = itemLabel.createEl('input', { type: 'checkbox' });
			cb.checked = getWhitelist().includes(ext);
			itemLabel.createSpan({ text: ext });
			cb.addEventListener('change', () => {
				void (async () => {
					const list = getWhitelist();
					const has = list.includes(ext);
					if (cb.checked && !has) list.push(ext);
					else if (!cb.checked && has) list.splice(list.indexOf(ext), 1);
					list.sort();
					await tab.plugin.saveSettings();
				})();
			});
		}
	};
	renderTypeGroup('images', 'Images');
	renderTypeGroup('audio', 'Audio');
	renderTypeGroup('video', 'Video');
	renderTypeGroup('pdf', 'PDF');

	new Setting(containerEl).setName('Image conversion').setHeading();
	const conv = containerEl.createDiv({ cls: 'crucible-settings-group' });
	bindToggle(conv, { name: 'Convert attached images', get: () => s.localizeAttachmentsConvertAttachedImages, set: (v) => { s.localizeAttachmentsConvertAttachedImages = v; }, after: () => tab.display() }, save);
	if (s.localizeAttachmentsConvertAttachedImages) {
		conv.createEl('hr', { cls: 'crucible-row-divider' });
		bindDropdown(conv, { name: 'Attached: target format', options: { webp: 'WebP', jpeg: 'JPEG' }, get: () => s.localizeAttachmentsAttachedImageFormat, set: (v) => { s.localizeAttachmentsAttachedImageFormat = v as ImageConvertFormat; } }, save);
		conv.createEl('hr', { cls: 'crucible-row-divider' });
		bindNumber(conv, { name: 'Attached: quality (30–100)', min: 30, max: 100, step: 1, width: 'pi-width-half', get: () => String(s.localizeAttachmentsAttachedImageQuality), set: (v) => { s.localizeAttachmentsAttachedImageQuality = Math.min(100, Math.max(30, parseInt(v) || 85)); } }, save);
	}
	conv.createEl('hr', { cls: 'crucible-row-divider' });
	bindToggle(conv, { name: 'Convert pasted images', get: () => s.localizeAttachmentsConvertPastedImages, set: (v) => { s.localizeAttachmentsConvertPastedImages = v; }, after: () => tab.display() }, save);
	if (s.localizeAttachmentsConvertPastedImages) {
		conv.createEl('hr', { cls: 'crucible-row-divider' });
		bindDropdown(conv, { name: 'Pasted: target format', options: { webp: 'WebP', jpeg: 'JPEG' }, get: () => s.localizeAttachmentsPastedImageFormat, set: (v) => { s.localizeAttachmentsPastedImageFormat = v as ImageConvertFormat; } }, save);
		conv.createEl('hr', { cls: 'crucible-row-divider' });
		bindNumber(conv, { name: 'Pasted: quality (30–100)', min: 30, max: 100, step: 1, width: 'pi-width-half', get: () => String(s.localizeAttachmentsPastedImageQuality), set: (v) => { s.localizeAttachmentsPastedImageQuality = Math.min(100, Math.max(30, parseInt(v) || 80)); } }, save);
	}

	new Setting(containerEl).setName('Storage').setHeading();
	const store = containerEl.createDiv({ cls: 'crucible-settings-group' });
	bindText(store, { name: 'Attachment folder template', desc: 'Tokens: {{folder}}, {{slug}}, {{name}}, {{date}}, {{datetime:FMT}}.', placeholder: '{{folder}}/_attachments/{{slug}}', width: 'pi-width-wide', get: () => s.localizeAttachmentsFolderTemplate, set: (v) => { s.localizeAttachmentsFolderTemplate = v; } }, save);
	store.createEl('hr', { cls: 'crucible-row-divider' });
	bindText(store, { name: 'Attachment name template', desc: 'Tokens: {{md5}}, {{ext}}, {{original}}, {{name}}, {{slug}}.', placeholder: '{{md5}}_MD5.{{ext}}', width: 'pi-width-wide', get: () => s.localizeAttachmentsNameTemplate, set: (v) => { s.localizeAttachmentsNameTemplate = v; } }, save);
	store.createEl('hr', { cls: 'crucible-row-divider' });
	bindToggle(store, { name: 'Follow note lifecycle', desc: 'Rename, move, or delete the attachment folder when the note is renamed, moved, or deleted.', get: () => s.localizeAttachmentsFollowNoteLifecycle, set: (v) => { s.localizeAttachmentsFollowNoteLifecycle = v; } }, save);
	store.createEl('hr', { cls: 'crucible-row-divider' });
	bindToggle(store, { name: 'Debug mode', desc: 'Log each note\'s attachment matches and per-image decisions to _crucible/debug.md (shared with Chain debug).', get: () => s.localizeAttachmentsDebugMode, set: (v) => { s.localizeAttachmentsDebugMode = v; } }, save);

	const actions = containerEl.createDiv({ cls: 'crucible-settings-group' });
	new Setting(actions).setName('Run now').addButton(bt => bt.setButtonText('Localize this note').onClick(async () => { const f = tab.app.workspace.getActiveFile(); if (f && f.extension === 'md') await tab.plugin.attachmentLocalizer.localizeNote(f); else new Notice('Open a Markdown note first'); })).addButton(bt => bt.setButtonText('Localize vault').setWarning().onClick(async () => { await tab.plugin.attachmentLocalizer.localizeVault(); }));
}
