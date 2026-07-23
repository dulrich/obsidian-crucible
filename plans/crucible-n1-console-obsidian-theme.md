# Crucible N1 Console Obsidian Theme

*Recommended model/effort — Claude: Sonnet/medium overall (Sonnet/high for the plugin surround switch); Codex: Terra/medium overall (Terra/high for the switch). No frontier tier required — this is well-scoped CSS + a small lifecycle-integrated plugin module against a settled token spec.*

## Context

Crucible should present under the **N1 Applied** identity, using the operational branch of
that identity's design system — **N1 Console**. That design system is the (mid-rename)
descendant of the Signalworks token architecture (`7als_art_direction/packages/signalworks`),
whose defining trait is a **three-way surround** — dark / med / light — selected via
`data-surround` on the document root, with **Med** as the default (a symmetric surface stack,
not a binary light/dark flip). We want that look and that switch inside Obsidian.

The friction this plan resolves: **Obsidian has no native three-state surround.** A theme only
sees Obsidian's binary `.theme-dark` / `.theme-light`, and only one theme is active at a time.
So the design system's third axis has to come from somewhere Obsidian can't provide it — and
that somewhere is the Crucible **plugin**, which can write `document.body.dataset.surround` at
runtime and persist it. The plugin↔theme coupling is the enabling mechanism, not an obstacle.

A second enabler, confirmed by inspection: Crucible's own `styles.css` already consumes
Obsidian **semantic** variables (`--background-primary`, `--text-normal`, `--text-muted`,
`--interactive-accent`, `--font-monospace`, …). A companion theme that maps N1 surround tokens
→ those Obsidian variables restyles **all of Crucible's plugin UI for free** — no N1-specific
classes need to be added to any plugin view.

## Decisions locked

Confirmed with the user this session:

1. **Placement:** the theme lives **in the `obsidian-crucible` repo**, co-versioned with the
   plugin, in a top-level `theme/` build target. The surround switch requires plugin JS, so
   plugin + theme are a matched set; one repo keeps the token CSS and the switching logic in
   lockstep. It does **not** live in `admin-n1applied` (business/brand admin, not a code home)
   nor in the design-system source repo.
2. **Surround delivery:** **one theme** carrying all three surrounds keyed off
   `body[data-surround="dark|med|light"]`, with the **Crucible plugin owning the switch**
   (command + settings segmented control, persisted, applied on load). Not three separate
   themes; not toggleable snippets.
3. **Variant scope:** ship the **Console** surround theme + switch now; **architect the token
   layer so an Editorial reading-surface variant drops in later** without rework. Console vs
   Editorial is a *scope split inside one theme* (chrome/panels vs the note reading/editing
   surface), not two theme artifacts.

Additional context the user supplied: `admin-n1applied` is a business/brand admin repo, not the
design-system home; the design system is **mid-rename** (Claude Design session ID
`b5cc64ca-f241-472b-a2f8-e4edf4652370`). Consequence for this plan: **do not hard-couple to the
in-flux N1 token names.** Vendor a *snapshot* of the surround/accent/status tokens into the
theme and map them through a thin Obsidian-variable adapter layer, so a later token rename is a
one-file re-vendor, not a theme rewrite (see WP-3).

## Summary

Add a `theme/` build target to the Crucible repo producing an Obsidian theme
(`theme.css` + `manifest.json`) that (a) vendors a snapshot of the N1/Signalworks surround,
accent, and status tokens, and (b) maps them onto Obsidian's semantic CSS variables under
`body[data-surround="dark|med|light"]`, so both core Obsidian chrome and Crucible's own UI take
the N1 Console look. Add a small plugin module (`src/surround.ts`) that owns the third axis:
a grouped command and a settings segmented control (Dark / Med / Light) that write and persist
`body.dataset.surround`, sync Obsidian's base light/dark scheme to match (so any CSS we don't
override stays coherent), and apply the stored value on `onLayoutReady` (no flash). Structure
the token layer with an explicit chrome-vs-reading scope seam and an `--editorial-*` layer stub
so the Editorial variant is a later drop-in. Vendor-sync, stylelint coverage, an AGENTS.md Quirk,
and a UI verification packet round it out.

## Key Changes

**WP-1 — Theme scaffold + N1 Console surround token layer (~0.7 kSLOC touched, ~260k tokens).**
Create `theme/theme.css` + `theme/manifest.json` (Community-Theme-submission-ready manifest:
`name`, `version`, `minAppVersion`, `author`, `authorUrl`). Vendor a snapshot of the surround
tokens (dark/med/light from `packages/signalworks/css/tokens/surrounds.css`) plus accents and
status into `theme/tokens/` as plain CSS custom properties. In `theme.css`, define the three
surrounds as `body[data-surround="dark"|"med"|"light"]` blocks (Med also the bare-`body`
default, mirroring the source's `:root` default), and **map each N1 token onto the Obsidian
semantic variable it drives** — `--background-primary`/`--background-secondary`/
`--background-secondary-alt` ← `--bg`/`--panel`/`--inset`; `--text-normal`/`--text-muted`/
`--text-faint` ← `--text`/`--muted`/`--text-faint`; `--interactive-accent`/`--text-accent` ←
signal-orange accent; `--background-modifier-border` ← `--line`; monospace metadata via
`--font-monospace`. Include a `theme/install.sh` that symlinks `theme/` into
`<vault>/.obsidian/themes/crucible-n1-console/` (mirroring the plugin's own vault-symlink dev
loop). *Files: `theme/theme.css`, `theme/manifest.json`, `theme/tokens/*.css`,
`theme/install.sh`. Model: mid (Claude Sonnet/medium — CSS against a clear token spec, with
care on the Obsidian-variable mapping and WCAG contrast per the source's AA notes; Codex
Terra/medium). Execution: Claude subagent (isolatable CSS once the `data-surround` attribute
name is fixed as the seam; 40% saving, ~156k normalized); Codex subagent (50% saving, ~130k
normalized). The design-review/contrast pass stays orchestrator-direct.*

**WP-2 — Plugin surround switch: command + settings control + mode sync + no-flash
(~0.4 kSLOC touched, ~200k tokens).** New `src/surround.ts`: read/write
`document.body.dataset.surround`, persist to a new `surround: 'dark'|'med'|'light'` setting
(default `'med'`), and **sync Obsidian's base color scheme** to match (dark+med → dark base,
light → light base) so core UI we don't override stays coherent. Register a grouped command via
`this.registerCrucibleCommand({ ..., group })` — **not** `addCommand` (per the command-registry
Quirk) — cycling/among surrounds, and register it as an internal command taking an optional
`targetFile` if it should be chain-usable (likely not — it's global, so plain command is fine).
Add a settings segmented control (Dark / Med / Light, the SurroundControl glyph pattern) to the
Settings tab. Apply the stored surround on `onLayoutReady` in `main.ts` (before first meaningful
paint, to avoid a flash). *Files: `src/surround.ts` (new), `src/main.ts` (lifecycle +
command registration), `src/settings.ts` or a settings section (segmented control),
`src/types.ts` (`surround` in settings + `DEFAULT_SETTINGS`). Model: mid, high effort (Claude
Sonnet/high — small but touches the plugin lifecycle seam and must respect the command-registry
and no-flash quirks; Codex Terra/high). Execution: Claude direct (must-direct: main.ts lifecycle
+ settings seam, and tiny ≤200k); Codex direct (same).*

**WP-3 — Editorial seams, vendor-sync, gates, docs, Quirk (~0.3 kSLOC touched, ~120k tokens).**
Establish the Console-vs-Editorial scope convention in `theme.css` with commented section
banners: **Console scope** = workspace chrome, sidebars, ribbons, plugin panels
(default/global); **Editorial scope** = the note surface (`.markdown-preview-view`,
`.markdown-source-view .cm-editor`). Add an `--editorial-*` token layer **stub** (reading
measure, prose type scale, heading rhythm) documented as "populated when the Editorial variant
lands," so introducing it later is additive. Document the vendor-sync (how the token snapshot is
pulled from the design-system source — a short `theme/README.md` + a make/npm target or note,
mirroring the signalworks `install.sh` vendoring pattern) so a token rename is a one-file
re-vendor. Extend the existing **stylelint** config to cover `theme/**/*.css`. Add an AGENTS.md
**Quirk** entry documenting the whole model (three-way surround via plugin-set `data-surround`,
the Obsidian-variable adapter mapping, why it's a plugin+theme matched set, and the mid-rename
snapshot caveat). *Files: `theme/theme.css` (scope banners + `--editorial-*` stub),
`theme/README.md`, `.stylelintrc*`/lint config, `package.json` (lint glob / vendor-sync
target), `AGENTS.md` (Quirk). Model: mid→mechanical (Claude Sonnet/low; Codex Terra/low or
Luna). Execution: Claude direct (tiny ≤200k, and it edits shared files — AGENTS.md, lint
config); Codex direct (same).*

## Public Interfaces

- **New setting:** `surround: 'dark' | 'med' | 'light'` (default `'med'`) in `CrucibleSettings`
  / `DEFAULT_SETTINGS` (`src/types.ts`).
- **New command:** a grouped Crucible command to cycle/select surround (group TBD — likely a
  new `'Appearance'` group needing a `CrucibleCommandGroup` union member + `GROUP_ORDER` entry
  per the command-registry Quirk, or fold into an existing group).
- **New runtime contract (the seam):** `document.body.dataset.surround ∈ {dark,med,light}`.
  This attribute name is the contract between WP-2 (plugin writes it) and WP-1 (theme reads it);
  fix it first.
- **New artifact type in the repo:** `theme/` producing `theme.css` + `manifest.json` — an
  Obsidian *theme*, distinct from the plugin's `main.js`/`manifest.json`/`styles.css` set. Not
  bundled by esbuild; shipped/symlinked as raw CSS.

## Execution

Ordering: **fix the `data-surround` attribute contract first** (one line of agreement), then
WP-1 and WP-2 can proceed in parallel — WP-1 is the CSS side, WP-2 the JS side, and they meet
only at that attribute. WP-3 depends on both (it adds scope banners to the WP-1 file and
documents the WP-2 behavior). WP-1 is cleanly dispatchable to a worker (Claude or Codex, ~40–50%
saving); WP-2 and WP-3 stay orchestrator-direct (tiny, and they touch the plugin lifecycle /
shared repo files). **Per the hard rule, confirm with the user which implementation subagents to
spawn before dispatching WP-1.** Verification and the contrast/design-review pass stay direct.

## Test Plan / Verification

Gates are the repo's mandatory Full Cleanup Loop (run sequentially, output visible):

1. `npm run lint` — ESLint (TS) **and** Stylelint. WP-3 extends the Stylelint glob to
   `theme/**/*.css`; all errors resolved.
2. `npx tsc -noEmit -skipLibCheck` — zero TS errors (WP-2 adds typed settings + module).
3. `node esbuild.config.mjs production` — bundles clean, `main.js` updated (WP-2's plugin code
   compiles into the bundle; `theme/` is **not** bundled).
4. All processes exit 0.

**UI verification packet (theme + surround are UI-observable — hand back a rerun packet per the
Debugging Protocol rather than inspecting Obsidian internals):**
- *Applied:* build + `theme/install.sh` symlinked, plugin reloaded.
- *Steps:* Appearance → select "Crucible N1 Console" theme; run the surround command / toggle the
  settings segmented control through Dark → Med → Light.
- *Expected:* the whole vault (chrome + Crucible panels) reskins to each surround instantly;
  Med is the default on first load; the choice persists across reload (no flash of the wrong
  surround on startup); Obsidian's base light/dark tracks the surround; monospace metadata and
  signal-orange accent read correctly; body text meets AA contrast on each surround's panel.
- *Report back:* per-surround screenshot of the workspace + a Crucible settings/dashboard panel,
  and confirmation the startup flash is absent.

## Critical Files

- `theme/theme.css`, `theme/manifest.json`, `theme/tokens/*.css` — the new theme (WP-1).
- `packages/signalworks/css/tokens/surrounds.css` (+ `accents.css`, `status.css`) in
  `7als_art_direction` — the **vendor source** for the token snapshot (read, don't depend on).
- `src/surround.ts` (new), `src/main.ts` (lifecycle + command registration), `src/types.ts`
  (settings), settings tab (segmented control) — the switch (WP-2).
- `src/main.ts` `registerCrucibleCommand` + `CrucibleCommandGroup` union, `src/settings.ts`
  `GROUP_ORDER` — command-registry integration points (per Quirk).
- `styles.css` — **not edited**, but the reason the plugin UI reskins for free (it consumes
  Obsidian semantic vars); confirm no hardcoded colors sneak the mapping.
- `.stylelintrc*` / `package.json` (lint glob), `AGENTS.md` (Quirk) — WP-3.

## Assumptions

- **Distribution:** primarily David's own vault initially; the `manifest.json` is authored
  submission-ready (cheap) but **Community Themes submission is out of scope** for this plan.
  Flag if public submission is intended now — it adds screenshot/compat/broad-theme-testing work.
- **Token source is a snapshot, not a live dependency.** Given the mid-rename, WP-1 vendors a
  copy of the current surround/accent/status values; re-vendoring on rename is a WP-3-documented
  one-file operation. If the user wants a live `install.sh`-style pull from the design-system
  repo instead, that's a small addition to WP-3.
- **Obsidian base-scheme sync** uses the app's theme/color-scheme setting to flip dark↔light to
  match the surround. If flipping it programmatically proves unreliable across Obsidian versions,
  the fallback is to define the theme's `--*` under both `.theme-dark body[data-surround]` and
  `.theme-light body[data-surround]` so the surround wins regardless of base — a WP-1 hedge.
- **Command group:** assumed a new `'Appearance'` group (or reuse of an existing one). Confirm
  the group name; it needs the union + `GROUP_ORDER` entry per the Quirk.
- **Editorial reading direction is undefined** (design system mid-rename), so WP-3 ships only the
  scope seam + token stub, not populated Editorial styling.

**Total ≈ 1.4 kSLOC, ~580k raw tokens; ~508k Claude-path / ~490k Codex-path Opus/Sol-equivalent
tokens.** (Claude path: WP-1 dispatched to Sonnet ~156k + WP-2 direct Opus 200k + WP-3 direct
Opus 120k = ~476k; +~30k orchestrator overhead ≈ 508k. Codex path: WP-1 dispatched to Terra
~130k + WP-2 direct Sol 200k + WP-3 direct Sol 120k = ~450k; +~40k overhead ≈ 490k.)
