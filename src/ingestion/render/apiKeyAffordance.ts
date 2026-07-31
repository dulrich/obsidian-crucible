import type CruciblePlugin from '../../main';
import { YOUTUBE_DATA_API_SECRET_KEY } from '../../orchestration/utils/youtubeApi';

// Shared "YouTube Data API key missing" affordance — WP-VF-3, the config-gap
// counterpart to the search rerank row (src/search/SearchModal.ts:94-114,
// rerankUnavailableReason). A missing key is a config gap, not an error state:
// no status pill, muted hint copy + a SEPARATE Configure… button (a disabled
// button swallows clicks, so the click affordance can't live on the disabled
// action it explains). Render targets: the channel control center (per-row
// Enrich/Re-enrich + "Enrich all"), the Uncaptured videos auto-enqueue control,
// and the "Auto-enqueue YouTube metadata" settings toggle.

// The deep link (`openSettingsToTab('orchestrator')` / `CrucibleSettingTab.
// openToTab`) is tab-level only — it closes any open detail editor rather than
// landing on the YouTube tracker workflow's own edit view where the key field
// lives — so the copy names the click path instead of promising a precise
// landing spot.
export const YOUTUBE_API_KEY_MISSING_HINT = 'Missing API key — Orchestrate → YouTube tracker';

/**
 * Pure detector, mirroring `rerankUnavailableReason` (SearchModal.ts): sync,
 * testable without a live plugin/registry. Callers pass the boolean result of
 * `plugin.secretRegistry.isRegistered(YOUTUBE_DATA_API_SECRET_KEY)` rather than
 * the registry itself so this stays a pure function.
 */
export function youtubeApiKeyMissing(hasKey: boolean): boolean {
	return !hasKey;
}

// Convenience wrapper for render sites holding a plugin reference — the one
// place the (still synchronous) secretRegistry check happens, so call sites
// don't each repeat the YOUTUBE_DATA_API_SECRET_KEY import.
export function isYoutubeApiKeyRegistered(plugin: CruciblePlugin): boolean {
	return plugin.secretRegistry.isRegistered(YOUTUBE_DATA_API_SECRET_KEY);
}

/**
 * Appends the muted hint span + a Configure… button into `container`. Does
 * NOT clear `container` itself — callers own that container's lifecycle
 * (a static heading slot synced on every render pass, or a per-render body
 * row torn down and rebuilt with the rest of the section), so this composes
 * with either shape. `onConfigure` is supplied by the caller because the
 * available deep-link surface differs: dashboard sections go through
 * `plugin.openSettingsToTab('orchestrator')`, while a settings-tab renderer
 * already holding a `CrucibleSettingTab` calls `tab.openToTab('orchestrator')`
 * directly.
 */
export function renderApiKeyAffordance(
	container: HTMLElement,
	onConfigure: () => void,
	hint: string = YOUTUBE_API_KEY_MISSING_HINT,
): void {
	container.createSpan({ cls: 'crucible-apikey-hint', text: hint });
	const configureButton = container.createEl('button', { cls: 'crucible-apikey-configure', text: 'Configure…' });
	configureButton.onclick = () => onConfigure();
}
