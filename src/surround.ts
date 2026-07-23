import type CruciblePlugin from './main';
import type { Surround } from './types';

/**
 * Surround switch — the plugin half of the N1 Console theme.
 *
 * Obsidian has no native third light/dark mode, so the three-way surround
 * (dark / med / light) is driven by the plugin: it writes `data-surround` onto
 * <body>, and the companion theme (theme/theme.css) keys every token off
 * `body[data-surround]`. Theme + plugin are a matched set — the theme is inert
 * without this attribute, and this attribute is cosmetic without the theme.
 *
 * The theme also sets `color-scheme` per surround, so native widgets render
 * correctly regardless of Obsidian's own base light/dark setting — which is why
 * there is (deliberately) no fragile internal-API call here to flip that base.
 */

export const SURROUNDS: readonly Surround[] = ['dark', 'med', 'light'] as const;

const SURROUND_LABELS: Record<Surround, string> = {
	dark: 'Dark',
	med: 'Med',
	light: 'Light',
};

export function surroundLabel(s: Surround): string {
	return SURROUND_LABELS[s];
}

/**
 * Write the surround onto <body>. Safe to call before workspace layout-ready —
 * `document.body` exists at plugin `onload`, and applying it there (rather than
 * on layout-ready) is what makes startup flash-free once the theme CSS is loaded.
 */
export function applySurround(s: Surround): void {
	document.body.dataset.surround = s;
}

/** The next surround in dark → med → light → dark order (for the cycle command). */
export function nextSurround(current: Surround): Surround {
	const i = SURROUNDS.indexOf(current);
	return SURROUNDS[(i + 1) % SURROUNDS.length] ?? 'med';
}

/**
 * The single mutation chokepoint: apply to the DOM and persist to settings.
 * Used by both the commands and the settings dropdown.
 */
export async function setSurround(plugin: CruciblePlugin, s: Surround): Promise<void> {
	plugin.settings.surround = s;
	applySurround(s);
	await plugin.saveSettings();
}
