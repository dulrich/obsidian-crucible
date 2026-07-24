# Crucible N1 Console — Obsidian theme

The operational (**Console**) surface of the **N1 Applied** identity, as an Obsidian
theme. It renders both Obsidian's own chrome and the Crucible plugin's UI in the N1
Console look, with a three-way **surround** — dark / med / light.

This theme is a **matched set with the Crucible plugin**, not a standalone theme:

- Obsidian has no native third light/dark mode. The surround is driven by the plugin,
  which writes `data-surround` onto `<body>`; `theme.css` keys every token off
  `body[data-surround="dark|med|light"]`. **Med** is the default.
- The plugin owns the switch: the **Appearance** command group (`Set surround: …`,
  `Cycle surround`) and the **Surround** dropdown in *Crucible → Settings → Configure*.
  Without the plugin the attribute is never set, so the theme just renders Med.

## Install (dev)

```bash
theme/install.sh /path/to/Vault
```

Symlinks this folder into `<Vault>/.obsidian/themes/Crucible N1 Console/`. Then enable it
in **Settings → Appearance → Themes → "Crucible N1 Console"**, and pick a surround from
*Crucible → Settings → Configure → Appearance* (or bind a hotkey to `Cycle surround`).

## How it's built

`theme.css` is one file Obsidian loads, in three parts:

1. **N1 surround tokens** (`--n1-*`) — three `body[data-surround]` blocks. The *only*
   thing that changes per surround. Each block also sets `color-scheme` (so native
   widgets render right regardless of Obsidian's base light/dark) and the signal-orange
   accent as HSL.
2. **Obsidian semantic adapter** (Console scope) — one surround-*independent* block that
   maps each `--n1-*` onto the Obsidian variable it drives (`--background-primary`,
   `--text-normal`, `--interactive-accent`, the `--color-base-*` ramp, …). Because
   Crucible's own `styles.css` already consumes these semantic variables, the plugin UI
   reskins for free — no plugin-specific classes.
3. **Editorial scope** — a present-but-empty stub. Console currently styles the note
   surface too; when the N1 **Editorial** reading direction is defined, populate
   `--editorial-*` and scope it to `.markdown-preview-view` / `.cm-editor` there, so the
   reading experience can diverge from the operational chrome without touching part 2.

## Why the adapter selector is `body.theme-dark, body.theme-light`

Obsidian's own `app.css` declares **55 CSS custom properties** under `.theme-dark` /
`.theme-light` — specificity **(0,1,0)**. A plain-`body` adapter is only **(0,0,1)**, and
specificity beats source order regardless of which stylesheet loads last or how it's linked
in — so a `body`-scoped block 2 silently loses every one of those 55 variables to Obsidian's
own values, including the `--color-base-*` ramp it appears to map. Block 2 is therefore
scoped to `body.theme-dark, body.theme-light` — specificity **(0,1,1)**, the minimum bump
that outranks (0,1,0) — which works only because base-theme alignment (below) guarantees
`<body>` always carries one of those two classes.

Categories that were silently dead before the fix:

- **Mono ramp** — `--color-base-00` … `-100` (12 vars); every unmapped derived surface fell
  back to Obsidian's own greys.
- **Interactive / form-field vars** — `--interactive-normal`, `--interactive-hover`,
  `--background-modifier-form-field`; buttons, inputs, and selects rendered Obsidian's base
  colours on every surround instead of the theme's.
- **Tab bar / titlebar** — `--background-secondary-alt`, which feeds
  `--titlebar-background-focused`; the reported tab-bar defect.
- **Overlays** — `--mono-rgb-0` / `--mono-rgb-100`, consumed by ~15 `rgba()` rules (hover
  states, scrollbars, indent guides, swatch shadows).
- **Depth** — `--input-shadow(-hover)`, `--shadow-xs/-s/-l`,
  `--background-modifier-box-shadow`, `--background-modifier-cover`, `--canvas-color`,
  `--raised-mask-background`.
- **Blend** — `--highlight-mix-blend-mode` (`lighten`/`darken`); callout/table highlights
  vanished on the mismatched base/surround pairing.
- **Semantic palette** — the 8-colour `--color-red/orange/yellow/green/cyan/blue/purple/pink`
  set (+ `-rgb` twins); callouts, tags, graph nodes, and syntax followed the base theme, not
  the surround.

**Rule for future edits:** block 1 declares only `--n1-*` names; block 2 declares only
Obsidian names, and every value in it is a `var(--n1-*)` reference. A per-surround value is
always a new block-1 token consumed by block 2 — never a literal inlined into block 2. That
disjoint split is what lets both blocks sit at (0,1,1) without fighting each other on source
order.

## Base-theme alignment

The plugin (`applySurround` in `src/surround.ts`) sets Obsidian's own base theme to match the
surround's polarity — `obsidian` (dark) for Dark/Med surrounds, `moonstone` (light) for
Light — via the undocumented `vault.getConfig`/`setConfig` APIs, presence- and value-guarded
so a missing API or an already-correct value is a no-op.

CSS specificity alone can't cover everything: a handful of surfaces branch on the
`theme-dark` class **in JavaScript**, not CSS — mermaid's `filter: invert()`, the PDF
viewer's `mod-themed` inversion, embedded tweets' `theme=dark` iframe param, and any
third-party plugin that calls `isDarkMode()` (`document.body.hasClass('theme-dark')`). Only
flipping Obsidian's real base theme reaches those, which is why the plugin owns this axis
too rather than relying on the CSS specificity fix alone.

**User-visible consequence:** setting the `theme` config key explicitly takes a user off
Obsidian's "Adapt to system" appearance setting. Surround changes are what triggers this, not
plugin load.

## The accent is owned by the theme

**Settings → Appearance → Accent color is inert while this theme is active.** To change the
accent, edit the three `--n1-accent-ui-*` triples in block 1 (one per surround) — not the
Appearance picker.

Obsidian's `setAccentColor` (`app.js`) writes `--accent-h`, `--accent-s`, `--accent-l`, and
`--text-on-accent` as **inline styles on `<body>`**, which beat any stylesheet rule
regardless of specificity. Block 2 therefore carries exactly four `!important`
declarations — those four properties and no others — to seize them back for the surround.
Every other mapping in the file already wins on specificity alone; a broader `!important`
sweep is a bug, not a fix.

## Provenance & re-vendoring

The `--n1-*` values in `theme.css` are a **vendored snapshot** of the design system's
surround / accent / status tokens.

- **Source:** `7als_art_direction/packages/signalworks/css/tokens/{surrounds,accents,status}.css`
- **Retrieved:** 2026-07-22
- **Caveat:** the design system is **mid-rename** (→ N1 Console / Foundations / Editorial).
  When the token names/values settle, re-vendoring is a **one-file op**: update the three
  `--n1-*` `body[data-surround]` blocks in `theme.css` from the (renamed) source, keeping
  the `--n1-*` namespace and the adapter block unchanged. There is intentionally no build
  step and no duplicate token files — `theme.css` *is* the snapshot.

Mapping notes: `--bg/panel/panel-2/inset` → backgrounds + base ramp; `--line` → borders;
`--text/muted/text-faint/heading` → text + headings; status `-text` tokens →
`--text-error/-success/-warning`. The green `data-accent` family and the status
`-hue`/`-chip` tokens are not shipped yet (reserved for future callout/Editorial work).

**Two accent families, and they are not interchangeable:**

- `--n1-accent*` is the vendored **brand** signal orange (`#ff8a3d` on Dark/Med) — the
  design-system snapshot value, kept for the vendoring contract and future
  callout/Editorial work. The Obsidian adapter (block 2) does **not** consume it.
- `--n1-accent-ui*` is the **muted UI accent** that actually drives Obsidian's
  `--interactive-accent`, `--text-accent`, and (via the four `!important` declarations)
  `--accent-h/-s/-l`/`--text-on-accent` — links, toggles, selection, highlights. A future
  re-vendor must **not** "fix" the adapter back onto `--n1-accent`; that regresses the
  muted-accent decision this WP made.

The 8-colour semantic palette (`--n1-red/orange/yellow/green/cyan/blue/purple/pink` +
`-rgb` twins) is currently **Obsidian's own `.theme-dark`/`.theme-light` pair, hoisted per
surround** — Dark and Med take the `.theme-dark` values, Light takes `.theme-light`,
verbatim. This is an interim step, not N1 hues: true N1 cyan/purple/pink are not in the
vendored snapshot yet.

## Known gaps (v0.1.0)

- Third-party plugins that call `isDarkMode()` (`document.body.hasClass('theme-dark')`)
  still see only two states — Dark and Med both report "dark". There is no fix for this
  short of a fourth Obsidian base theme, which doesn't exist.
- `.is-mobile*` selectors reach specificity (0,2,0), which would outrank the (0,1,1)
  adapter. Desktop-only is an accepted assumption for this pass; mobile is unaudited.
- A few hardcoded `rgba(0, 0, 0, …)` box-shadows remain on Obsidian's native
  `.checkbox-container` and the native range-slider thumb — both live in `app.css` itself,
  not in this file, so they aren't reachable via the `--n1-*` token layer. See WP-2's
  execution report (`runs/dispatch/wp-n1-2-report.md`) for the full residue list.
  `--shadow-edges` is deliberately left unmapped: `app.css` only defines it on
  `.theme-light`, so hoisting it for Dark/Med would add a shadow Obsidian never had there.
- Community-Themes submission is out of scope; `manifest.json` is submission-shaped but
  the theme is coupled to the plugin, so it ships with Crucible rather than standalone.
