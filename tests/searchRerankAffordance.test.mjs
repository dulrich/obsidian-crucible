// WP-9: the rerank button used to be null (not merely hidden) whenever no reranker was
// configured — VaultSearchModal.onOpen only built the row `if (searchRerankEnabled &&
// searchRerankModel)`. That made the feature undiscoverable. The fix renders the row and a
// disabled button unconditionally, with an explanation (reusing SearchManager.rerank()'s own
// guard copy) and a Configure… link that deep-links Crucible's settings to the Orchestrate tab.
//
// `rerankUnavailableReason` (the copy-selection logic) is a pure function exported from
// SearchModal.ts, so it's bundled and tested directly the same way formatScore/formatAttribution
// already are in searchModalFormat.test.mjs.
//
// The settings deep-link plumbing (CrucibleSettingTab.openToTab, CruciblePlugin.
// openSettingsToTab, CrucibleSettingsView.openToTab) can't be reached the same way: settings.ts
// extends the real Obsidian PluginSettingTab and pulls in the entire settings/sections/** render
// tree (each importing further real Obsidian values), so stubbing "obsidian" enough to bundle it
// is disproportionate to one method — the same call this repo already made for
// suggesters.ts/folderPicker.ts in tests/settingsPickerRanking.test.mjs. Per the brief, that
// plumbing is covered here as STRUCTURAL (source-text) assertions instead, following the
// precedent in that file.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-rerank-affordance-tests');
const outfile = path.join(outdir, 'SearchModal.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/SearchModal.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: `
					export class App {}
					export class Modal { constructor() {} }
					export class Notice { constructor() {} }
					export class TFile {}
					export function debounce(fn) { return fn; }
					export function setIcon() {}
				`,
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { rerankUnavailableReason } = await import(pathToFileURL(outfile));

test('rerankUnavailableReason: disabled reranking wins even when a model is also set', () => {
	assert.equal(
		rerankUnavailableReason(false, true),
		'Reranking is disabled. Enable it in Settings → Orchestrate → Search.',
	);
});

test('rerankUnavailableReason: enabled but no model configured reports the model-specific copy', () => {
	assert.equal(
		rerankUnavailableReason(true, false),
		'No reranker model configured in Settings → Orchestrate → Search.',
	);
});

test('rerankUnavailableReason: disabled AND no model still reports the disabled copy (checked first)', () => {
	assert.equal(
		rerankUnavailableReason(false, false),
		'Reranking is disabled. Enable it in Settings → Orchestrate → Search.',
	);
});

test('rerankUnavailableReason: fully configured returns null (row renders with no hint/Configure link)', () => {
	assert.equal(rerankUnavailableReason(true, true), null);
});

/* ------------------------------------------------------------------------- structural */

const searchModalSrc = readFileSync('src/search/SearchModal.ts', 'utf8');
const settingsSrc = readFileSync('src/settings.ts', 'utf8');
const settingsViewSrc = readFileSync('src/settingsView.ts', 'utf8');
const mainSrc = readFileSync('src/main.ts', 'utf8');

test('STRUCTURAL: the rerank row always renders — no `if` gate around row/button creation', () => {
	const onOpenStart = searchModalSrc.indexOf('onOpen(): void {');
	const onOpenEnd = searchModalSrc.indexOf('\n\tonClose(): void {', onOpenStart);
	const onOpenBody = searchModalSrc.slice(onOpenStart, onOpenEnd);
	assert.ok(onOpenBody.includes("createDiv({ cls: 'crucible-search-rerank-row' })"), 'rerank row must be created unconditionally in onOpen');
	assert.ok(!onOpenBody.includes('searchRerankEnabled && this.plugin.settings.searchRerankModel'), 'the old hide-entirely condition around the whole row must be gone');
	assert.ok(onOpenBody.includes('rerankUnavailableReason('), 'onOpen must consult rerankUnavailableReason to decide whether to show the hint/Configure link');
});

test('STRUCTURAL: the Configure… link closes the modal and deep-links the orchestrator settings tab', () => {
	const idx = searchModalSrc.indexOf("text: 'Configure…'");
	assert.ok(idx >= 0, 'Configure… button not found');
	const onclickStart = searchModalSrc.indexOf('.onclick = () => {', idx);
	const onclickEnd = searchModalSrc.indexOf('};', onclickStart);
	const body = searchModalSrc.slice(onclickStart, onclickEnd);
	assert.ok(body.includes('this.close()'), 'Configure… must close the search modal before navigating away');
	assert.ok(/openSettingsToTab\(\s*['"]orchestrator['"]\s*\)/.test(body), "Configure… must deep-link to the 'orchestrator' tab, where rerank settings live");
});

test('STRUCTURAL: rerankConfigured gates every place that would otherwise re-enable the button', () => {
	assert.ok(/updateRerankAvailability\(\): void \{[^}]*rerankConfigured/.test(searchModalSrc), 'updateRerankAvailability must check rerankConfigured');
	assert.ok(/setRerankPending\(pending: boolean\): void \{[^}]*rerankConfigured/.test(searchModalSrc), 'setRerankPending must check rerankConfigured');
	assert.ok(/private async runRerank\(\): Promise<void> \{\s*if \([^)]*rerankConfigured/.test(searchModalSrc), 'runRerank must bail when rerankConfigured is false');
});

test('STRUCTURAL: CrucibleSettingTab exposes a public openToTab deep-link and the orchestrator tab id is unchanged', () => {
	assert.match(settingsSrc, /export type CrucibleSettingsTab = [^;]*'orchestrator'/, 'orchestrator tab id must still be in the exported union');
	const methodStart = settingsSrc.indexOf('openToTab(tab: CrucibleSettingsTab): void {');
	assert.ok(methodStart >= 0, 'CrucibleSettingTab.openToTab not found');
	const methodEnd = settingsSrc.indexOf('\n\t}', methodStart);
	const body = settingsSrc.slice(methodStart, methodEnd);
	assert.ok(body.includes('this.activeTab = tab'), 'openToTab must set activeTab');
	assert.ok(body.includes('this.resetEditingState()'), 'openToTab must drop any in-progress detail-editor state, like the tab buttons do');
	assert.ok(/containerEl\.isConnected/.test(body), 'openToTab must only re-render when this instance is currently attached to the DOM');
});

test('STRUCTURAL: CrucibleSettingsView.openToTab delegates to its own settingTab instance', () => {
	assert.match(settingsViewSrc, /openToTab\(tab: CrucibleSettingsTab\): void \{\s*this\.settingTab\?\.openToTab\(tab\)/, 'CrucibleSettingsView.openToTab must delegate to settingTab.openToTab');
});

test('STRUCTURAL: openSettingsToTab reuses both existing open-settings paths rather than adding a third', () => {
	const methodStart = mainSrc.indexOf('openSettingsToTab(tab: CrucibleSettingsTab): void {');
	assert.ok(methodStart >= 0, 'CruciblePlugin.openSettingsToTab not found');
	const methodEnd = mainSrc.indexOf('\n\t}', methodStart);
	const body = mainSrc.slice(methodStart, methodEnd);
	assert.ok(body.includes('CRUCIBLE_SETTINGS_VIEW_TYPE'), 'must check the workspace-tab settings view surface');
	assert.ok(body.includes('this.activateSettingsView(tab)'), 'must deep-link the workspace-tab view when it is already open');
	assert.ok(body.includes('this.settingTab.openToTab(tab)'), 'must deep-link the single registered native-modal settingTab instance');
	assert.ok(body.includes('this.app.setting.open()') && body.includes('this.app.setting.openTabById(this.manifest.id)'), 'must fall back to the same ribbon-icon native-modal path already in onload');
});

test('STRUCTURAL: activateSettingsView accepts an optional initial tab and applies it to the revealed leaf\'s view', () => {
	const methodStart = mainSrc.indexOf('async activateSettingsView(initialTab?: CrucibleSettingsTab)');
	assert.ok(methodStart >= 0, 'activateSettingsView must accept an optional initialTab param');
	const methodEnd = mainSrc.indexOf('\n\t}', methodStart);
	const body = mainSrc.slice(methodStart, methodEnd);
	assert.ok(/leaf\.view instanceof CrucibleSettingsView/.test(body), 'must narrow to CrucibleSettingsView before calling its openToTab');
	assert.ok(body.includes('leaf.view.openToTab(initialTab)'), 'must apply the initial tab to the revealed leaf');
});
