import type { App } from 'obsidian';
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
 * The plugin also owns Obsidian's base light/dark theme, keeping it aligned to
 * the surround (`alignBaseTheme`). This is NOT what makes the theme's variable
 * mapping win — `theme.css` handles that on its own by scoping its adapter to
 * `body.theme-dark, body.theme-light`, which outranks the `.theme-dark` /
 * `.theme-light` blocks in Obsidian's `app.css`. Do not drop that scoping on the
 * assumption that alignment covers it; the two fix different problems.
 *
 * Alignment exists for the surfaces CSS cannot reach at all — the ones that
 * branch on the `theme-dark` class in JavaScript rather than in CSS: mermaid's
 * `filter: invert()`, the PDF viewer's `mod-themed` inversion, embedded tweets'
 * `theme=dark` iframe param, and any third-party plugin calling `isDarkMode()`.
 * Only flipping Obsidian's own base theme reaches those.
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
 * Align Obsidian's base light/dark theme to the surround's polarity. Dark and
 * Med surrounds take Obsidian's dark base (`obsidian`); Light takes the light
 * base (`moonstone`).
 *
 * `getConfig`/`setConfig` are undocumented Obsidian APIs — real and long-stable,
 * but absent from the `obsidian` type definitions, so presence-guard the same
 * way `SecretRegistry` guards `app.secretStorage`: if either is missing, do
 * nothing and let the surround attribute apply on its own (today's behaviour).
 * The no-op guard on the value itself is load-bearing, not an optimisation —
 * `setConfig` fires Obsidian's `updateTheme()` (body-class toggle behind a
 * ~200ms CSS-transition suppression) and a config write, so calling it
 * unconditionally on every `onload` would cost a needless disk write and a
 * visible flash even when the base theme already agrees.
 */
function alignBaseTheme(app: App, s: Surround): void {
	if (!app.vault.getConfig || !app.vault.setConfig) return;
	const want = s === 'light' ? 'moonstone' : 'obsidian';
	if (app.vault.getConfig('theme') !== want) {
		app.vault.setConfig('theme', want);
	}
}

/**
 * Write the surround onto <body> and align Obsidian's base theme to it. Safe
 * to call before workspace layout-ready — `document.body` exists at plugin
 * `onload`, and applying it there (rather than on layout-ready) is what makes
 * startup flash-free once the theme CSS is loaded.
 */
export function applySurround(app: App, s: Surround): void {
	document.body.dataset.surround = s;
	alignBaseTheme(app, s);
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
	applySurround(plugin.app, s);
	await plugin.saveSettings();
}
