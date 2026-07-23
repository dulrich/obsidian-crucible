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
`--text/muted/text-faint/heading` → text + headings; signal orange → accent (HSL +
resolved); status `-text` tokens → `--text-error/-success/-warning`. The green
`data-accent` family and the status `-hue`/`-chip` tokens are not shipped yet (reserved
for future callout/Editorial work).

## Known gaps (v0.1.0)

- Only the semantic variables + base ramp are mapped. A handful of core surfaces that
  read raw `--color-base-*` derivations should follow (they're mapped too), but deep
  component-level polish (graphs, canvas, some embeds) is not yet audited per surround.
- Community-Themes submission is out of scope; `manifest.json` is submission-shaped but
  the theme is coupled to the plugin, so it ships with Crucible rather than standalone.
