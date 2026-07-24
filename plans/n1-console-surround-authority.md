# N1 Console — make the surround the sole authority over Obsidian's look

*Recommended model/effort — Claude: Sonnet/medium for all three WPs (Opus orchestrator reviews + commits); Codex: Terra/medium for all three (Sol orchestrator).*

## Context

The N1 Console theme (`theme/`) landed usable but only fully correct at **Med surround with a
Dark base theme**. The user reports: tab-bar values wrong at light/dark, and Obsidian's own
controls (buttons, text inputs, selects) taking colours from Obsidian's base light/dark
setting rather than from the surround — "very wrong" on the opposite pairing, "a bit off" on
(Dark base, Dark surround). Separately, the Obsidian accent should be an N1-matched but
**muted** orange, because Obsidian spends the accent on links, toggles and highlights where
the full signal orange is too loud; the user's eyeballed value on Med surround is
RGB 186,107,54 (`#ba6b36`).

**Root cause (confirmed by disassembling `/opt/Obsidian/resources/obsidian.asar` → `app.css`).**
`theme.css`'s Obsidian semantic adapter (block 2) is written at plain `body` — CSS specificity
**(0,0,1)**. Obsidian's `app.css` declares **55 variables** under `.theme-dark` / `.theme-light`
— specificity **(0,1,0)** — which beats it outright, regardless of load order. So a large slice
of the adapter has never taken effect:

| Category | Vars captured by `.theme-*` | Visible symptom |
|---|---|---|
| Mono ramp | `--color-base-00 … -100` (12) | The whole `--color-base-*` mapping in block 2 is **dead**; every unmapped derivation falls back to Obsidian greys |
| Controls (dark base only) | `--interactive-normal` → `--color-base-30` (`#363636`), `--interactive-hover`, `--background-modifier-form-field` → `#2a2a2a` | Buttons/inputs/selects render Obsidian-dark on every surround |
| Accent (dark base only) | `--interactive-accent`, `--interactive-accent-hover`, `--text-accent` | Accent mapping dead under dark base, alive under light base — the asymmetry the user saw |
| Tab bar / titlebar | `--background-secondary-alt` → `#363636` (dark) / `#fcfcfc` (light); it feeds `--titlebar-background-focused` | **Exactly the reported tab-bar defect** |
| Overlays | `--mono-rgb-0` / `--mono-rgb-100` (15 `rgba()` consumers: hover, scrollbars, indent guides, swatch shadow) | Black overlays on a dark surround under light base, and vice-versa — invisible or muddy |
| Depth | `--input-shadow`, `--input-shadow-hover`, `--shadow-edges/-xs/-s/-l`, `--background-modifier-box-shadow`, `--background-modifier-cover` | Light-base inputs get a dark 1px inset ring; dark-base inputs get a white inset highlight — wrong on the opposite surround |
| Blend | `--highlight-mix-blend-mode` (`lighten`/`darken`) | Callout/table highlights vanish on the mismatched pairing |
| Palette | `--color-red/orange/yellow/green/cyan/blue/purple/pink` + `-rgb` (16) | Callouts, tags, graph nodes, syntax follow the base theme not the surround |

**Accent, separately.** `app.js`'s `setAccentColor` writes `--accent-h/-s/-l` (and sometimes
`--text-on-accent`) as an **inline style on `<body>`**, which beats every stylesheet rule. The
user's vault has `accentColor: "#ba6b36"` set in `appearance.json`, so today the accent comes
from that manual setting, not from the theme, and cannot vary per surround.

**What CSS genuinely cannot reach.** A handful of surfaces branch on the `theme-dark` class in
**JavaScript**, not CSS: `.theme-dark .mermaid > svg { filter: invert(…) }`, the PDF
`mod-themed` invert filters, embedded tweets (`theme=dark` in the iframe URL), and any
third-party plugin calling `isDarkMode()` (`document.body.hasClass('theme-dark')`). Those can
only be fixed by making the base theme agree with the surround — which is why WP-1 exists.

Intended outcome: **the surround is the single authority**; Obsidian's base light/dark setting
becomes an implementation detail the plugin keeps in sync, and all nine (base × surround)
pairings collapse to three correct looks.

## Decisions locked

1. **The plugin always aligns Obsidian's base theme to the surround** — no opt-out setting.
   `dark`/`med` → `obsidian` (dark), `light` → `moonstone` (light). This also fixes the
   JS-driven surfaces above. (User answer: "Always align (no setting)".) `theme.css` still
   gets the specificity fix — Med surround maps to a dark base whose greys (`#1e1e1e`…) are
   nothing like Med's (`#3a3a3b`…), so alignment alone fixes nothing.
2. **The theme owns the accent with `!important`** on `--accent-h/-s/-l` and
   `--text-on-accent`, so it beats Obsidian's inline style. Consequence, to be documented:
   Settings → Appearance → **Accent color becomes inert** while this theme is active. This is
   correct — the accent must vary per surround, which the picker cannot express.
3. **Semantic palette adopts Obsidian's own dark/light pair, hoisted per surround** — Dark and
   Med surrounds take Obsidian's dark values, Light surround takes the light values, both moved
   into `--n1-*` tokens so the *surround* decides. No new design decisions; refine to true N1
   hues in a later pass.
4. Architecture is preserved: **block 1 = per-surround `--n1-*` tokens only; block 2 = the
   surround-independent adapter.** Every new value is a token in block 1 consumed by block 2, so
   re-vendoring stays a one-file, three-block edit (`theme/README.md` contract).

## Summary

Two coordinated changes. `src/surround.ts` gains base-theme alignment so `theme-dark`/
`theme-light` always match the surround's polarity. `theme/theme.css` bumps its adapter selector
from `body` (0,0,1) to `body.theme-dark, body.theme-light` (0,1,1) so it outranks Obsidian's
`.theme-*` blocks, and extends the `--n1-*` token layer with everything those blocks were
holding: the mono ramp already mapped but never winning, plus `color-scheme`, `--mono-rgb-*`,
the blend mode, the four shadow scales, the input shadows, the 8-colour palette, and a new
**muted UI accent** (`--n1-accent-ui-*`, `hsl(24 55% 47%)` = `#ba6b36` on Med) kept distinct
from the vendored brand `--n1-accent` signal orange. Then docs.

## Key Changes

**WP-1 — Plugin: base-theme alignment (~0.05 kSLOC touched, ~70k tokens, ~8 min wall).**
Make `applySurround` also set Obsidian's base theme, so the two axes can never disagree.
Files: `src/surround.ts`, `src/types.ts`, `src/main.ts`, `src/settings/sections/configure.ts`.
*Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: Claude subagent (dispatch
62k vs 70k direct — a wash by tokens, taken for the diff review and orchestrator headroom);
Codex subagent (55k vs 70k, 21% saving).*

- Add `applySurround(app: App, s: Surround)` — the `app` parameter is new; update all three
  call sites (`main.ts:134` onload, `configure.ts:23` `after:`, `surround.ts setSurround`).
- Inside, after writing `document.body.dataset.surround`, call a new `alignBaseTheme(app, s)`:
  `const want = s === 'light' ? 'moonstone' : 'obsidian'`, and **only** call
  `app.vault.setConfig('theme', want)` when `app.vault.getConfig('theme') !== want`. The
  no-op guard matters — `setConfig` triggers Obsidian's `onConfigChanged` → `updateTheme()`,
  which toggles the body classes behind a 200 ms CSS-transition suppression; firing it on every
  startup would cost a needless config write and a flash.
- `getConfig`/`setConfig` are undocumented, so add them to the existing
  `declare module 'obsidian'` block in `src/types.ts:63` (the established pattern there —
  see `App.secretStorage`, `App.commands`), on `interface Vault`, and guard the call with a
  presence check the way `SecretRegistry` guards `secretStorage`.
- Setting `theme` explicitly means a user on `"system"` is taken off system-following. That is
  intended and must be called out in the surround setting's description text in
  `configure.ts` and in the README.

**WP-2 — theme.css: surround-owned token layer + specificity fix (~0.25 kSLOC touched, ~140k tokens, ~12 min wall).**
Extend block 1 with the tokens Obsidian was withholding, bump block 2's selector so the adapter
finally wins, and add the ~25 new mappings. Files: `theme/theme.css` only.
*Model: mid (Claude Sonnet/medium; Codex Terra/medium) — mechanical transcription of values
already extracted below, against a fixed architecture. Execution: Claude subagent (104k vs 140k,
26% saving); Codex subagent (90k vs 140k, 36% saving).*

1. **Block 2 selector**: `body` → `body.theme-dark, body.theme-light` — specificity (0,1,1),
   which beats `.theme-dark`/`.theme-light` (0,1,0). Leave block 1's selectors alone: they
   define only `--n1-*`, which `app.css` never declares, so (0,0,1) suffices there and the
   "no plugin loaded → Med" fallback keeps working. Block 2 sits after block 1 in the file, so
   the two (0,1,1) blocks never collide — they define disjoint variable sets by construction.
2. **Move `color-scheme` out of block 1** into block 2 as `color-scheme: var(--n1-color-scheme)`,
   adding `--n1-color-scheme: dark|dark|light` to the three token blocks. Today `color-scheme`
   sits in block 1 where the Med default (`body`, 0,0,1) loses to `.theme-*`. This also keeps
   the `select, .dropdown { border: 1px ButtonBorder solid }` system colour on the surround.
3. **New per-surround `--n1-*` tokens** (Dark / Med / Light). Values for dark+med are Obsidian's
   `.theme-dark` set, for light its `.theme-light` set — verbatim, so nothing regresses:
   - `--n1-mono-rgb-0` / `--n1-mono-rgb-100`: `0,0,0` / `255,255,255` for dark+med; inverted for light.
   - `--n1-blend-mode`: `lighten` (dark, med) / `darken` (light).
   - `--n1-input-shadow`, `--n1-input-shadow-hover`, `--n1-shadow-edges`, `--n1-shadow-xs`,
     `--n1-shadow-s`, `--n1-shadow-l`, `--n1-box-shadow`, `--n1-cover` — copy the matching
     `.theme-dark` / `.theme-light` declarations out of `app.css`.
   - Palette ×8 with `-rgb` twins: `--n1-red`, `--n1-orange`, `--n1-yellow`, `--n1-green`,
     `--n1-cyan`, `--n1-blue`, `--n1-purple`, `--n1-pink`.
   - `--n1-canvas-color` (`126,126,126` on dark/med) — `app.css` sets it at `body.theme-dark`, (0,1,1), so it needs an equal-or-higher-specificity override.
4. **Muted UI accent**, kept separate from the vendored brand `--n1-accent` (which stays
   `#ff8a3d` as the design-system snapshot value and is no longer consumed by the adapter —
   document that in the README mapping notes so re-vendoring doesn't "fix" it back):

   | Surround | `--n1-accent-ui-h / -s / -l` | hex | rationale |
   |---|---|---|---|
   | dark | `24 / 58% / 52%` | `#cc763e` | a touch brighter — links must read on `#0e0e10` |
   | med  | `24 / 55% / 47%` | `#ba6b36` | the user's eyeballed value |
   | light| `24 / 72% / 40%` | `#af571d` | darker/denser for link contrast on `#f4f4f5` |

   All three take `--n1-on-accent-ui: #fff` (L 40–52% orange carries white). These are a
   *starting point* — one-line edits per surround once seen in situ.
5. **New block-2 mappings**: `--mono-rgb-0/-100`, `--highlight-mix-blend-mode`,
   `--input-shadow`, `--input-shadow-hover`, `--shadow-edges/-xs/-s/-l`,
   `--background-modifier-box-shadow`, `--background-modifier-cover`, the 8 palette colours
   + 8 `-rgb` twins, `--canvas-color`. Leave `--color-accent`, `--color-accent-1/-2` and
   `--color-accent-hsl` **derived** — `app.css` computes them from `--accent-h/-s/-l`, which
   the theme now owns, so they follow for free.
6. **Accent with `!important`** — exactly four declarations, no more:
   `--accent-h: var(--n1-accent-ui-h) !important`, likewise `-s`/`-l`, and
   `--text-on-accent: var(--n1-on-accent-ui) !important`. These are the only properties
   `setAccentColor` writes inline. `--interactive-accent`/`-hover`/`--text-accent`/
   `--text-accent-hover` are **not** set inline, so they map normally (no `!important`) —
   point them at `--n1-accent-ui` / `--n1-accent-ui-hover`.
7. **Dropdown chevron, belt-and-suspenders.** `app.css` has `.dropdown` with a black-stroke
   inline-SVG `background-image` and `.theme-dark .dropdown` (0,2,0) with a white-stroke one.
   With WP-1 the base always matches the surround, so this self-corrects — but add explicit
   `body[data-surround="dark"] .dropdown, body[data-surround="med"] .dropdown` (white stroke)
   and `body[data-surround="light"] .dropdown` (black stroke) at (0,2,1) so the surround owns
   it even if alignment is ever bypassed. Copy the two data-URIs verbatim from `app.css`.
8. Do **not** touch block 3 (Editorial stub) — it stays an empty, purely-additive placeholder.

**WP-3 — Docs: README provenance + AGENTS.md quirk (~0.1 kSLOC touched, ~55k tokens, ~5 min wall).**
Record the specificity law, the base-theme coupling, and the accent seizure, so none of it gets
"simplified" back. Files: `theme/README.md`, `AGENTS.md` (`CLAUDE.md` is a symlink — never a
second file).
*Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: Claude subagent (53k vs 55k —
a wash, taken for review + headroom); Codex subagent (47.5k vs 55k, 14% saving).*

- `theme/README.md`: new **"Why the adapter is `body.theme-dark, body.theme-light`"** section
  (the (0,1,1) > (0,1,0) rule and the 55-variable list by category); the base-theme alignment
  contract and the fact that it takes a `"system"` user off system-following; **"Accent color
  is owned by the theme"** — the Appearance picker is inert, change the three
  `--n1-accent-ui-*` triples instead; update the mapping notes for `--n1-accent` (brand,
  unconsumed) vs `--n1-accent-ui` (drives Obsidian); update **Known gaps** to the real
  residue — third-party plugins that read `isDarkMode()` still see only two states.
- `AGENTS.md`: extend the existing N1-Console quirk (currently the last entry, whose point (4)
  says there is *deliberately no* internal-API call to flip the base — **that decision is now
  reversed and the text must be corrected, not merely appended to**). New sub-points: the
  specificity law and why a plain-`body` adapter silently loses; `applySurround` now owns both
  axes and `vault.setConfig('theme', …)` is a deliberate, guarded internal-API call; the four
  `!important` accent declarations and why exactly four; per-surround tokens must live in block 1
  and be *referenced* from block 2 — never inline a per-surround literal into the adapter, or
  the two (0,1,1) blocks start fighting on source order.

## Public Interfaces

- `applySurround(s: Surround)` → **`applySurround(app: App, s: Surround)`** (breaking, 3 call sites).
- New internal `alignBaseTheme(app: App, s: Surround): void` in `src/surround.ts`.
- `declare module 'obsidian'` in `src/types.ts` gains `interface Vault { getConfig?(k: string): unknown; setConfig?(k: string, v: unknown): void }`.
- New CSS custom properties, all under the existing `--n1-*` namespace: `--n1-color-scheme`,
  `--n1-mono-rgb-0/-100`, `--n1-blend-mode`, `--n1-input-shadow(-hover)`,
  `--n1-shadow-edges/-xs/-s/-l`, `--n1-box-shadow`, `--n1-cover`, `--n1-canvas-color`,
  `--n1-accent-ui(-h/-s/-l/-hover)`, `--n1-on-accent-ui`, and the 8 palette pairs.
- No settings-schema change; `settings.surround` keeps its shape and default (`'med'`).

## Execution

Sequential, one commit per WP. **WP-1 → WP-2 → WP-3.** WP-1 first because WP-2's design assumes
the base theme always matches the surround's polarity (it is what lets the chevron/mermaid/PDF
paths be belt-and-suspenders rather than load-bearing). WP-3 last because it documents the
final shape of both.

All three dispatch to workers on self-contained execution briefs. **Ask the user which subagents
to spawn before dispatching.** WP-2's brief must carry the extracted `app.css` values verbatim
(shadow strings, palette hexes, the two chevron data-URIs) — the worker must not need to open
the asar. Regenerate them if needed with:

```bash
node -e "const fs=require('fs'),b=fs.readFileSync('/opt/Obsidian/resources/obsidian.asar'),h=b.readUInt32LE(12),o=Math.ceil((16+h)/4)*4;fs.writeFileSync('/tmp/app.css',b.slice(o,o+600413))"
```

Subagents never commit; the orchestrator reviews each diff, re-runs the gates verbatim, and
commits. WP-2 is CSS-only with no runtime test, so its review must be a **careful read of the
diff against the value table above**, not a gate pass alone.

## Test Plan / Verification

Automated gates (the repo's mandatory Full Cleanup Loop — run sequentially, do not background):

```bash
npm run lint                    # eslint + stylelint; stylelint's "**/*.css" glob covers theme/theme.css
npx tsc -noEmit -skipLibCheck
node esbuild.config.mjs production
```

Manual verification in the live vault (`/home/_shared_code/second-brain/vault`, already
symlinked to `theme/` and running the plugin). Remind the user to have `npm run dev` running,
then **Reload Plugin** from the palette:

1. **Precondition** — clear `accentColor` in Settings → Appearance (reset arrow) once, to prove
   the theme's accent stands on its own; then re-set it to something garish and confirm the
   theme still wins (that is what the `!important` is for).
2. **Cycle surround** (`Cycle surround (dark → med → light)`). After each step confirm
   Settings → Appearance → Theme flipped to Dark for dark/med and Light for light, with no
   flash, and that `appearance.json` shows `"theme": "obsidian"` / `"moonstone"`.
3. Per surround, walk the previously-broken surfaces: **tab bar / titlebar strip** (focused and
   unfocused), a **settings pane** — buttons, text inputs, dropdowns/selects (chevron colour!),
   toggles, sliders, checkboxes — **scrollbars**, **indent guides**, **hover states** in the file
   explorer, a **modal** and the **command palette** (border colour), a note with a **callout**
   and **tags**, and the **graph view**.
4. **Accent**: links, an enabled toggle, active tab underline, and text selection should all be
   the muted orange, matching `#ba6b36` on Med. Report anything that still reads too loud —
   these are one-line token edits.
5. **Crucible's own UI** (`Crucible → Settings`, the Ingestion Dashboard) should follow for free
   via the semantic vars; if any panel does not, that panel is bypassing them and is a bug in
   `styles.css`, not the theme.
6. Spot-check a **mermaid diagram** and a **PDF** in each surround — these prove WP-1's
   alignment, since CSS alone cannot reach them.

If a surface is still wrong, the diagnostic is mechanical: inspect it, read the offending
computed variable, and check whether `app.css` declares that variable under `.theme-dark` /
`.theme-light`. If yes, it needs a `--n1-*` token in block 1 and a mapping in block 2.

## Critical Files

- `theme/theme.css` — the whole of WP-2; 200 lines today, ~340 after.
- `src/surround.ts` — `applySurround` / `setSurround`, the only DOM+config chokepoint.
- `src/types.ts:63` — the existing `declare module 'obsidian'` augmentation block.
- `src/main.ts:134` and `src/settings/sections/configure.ts:23` — the two other `applySurround` call sites.
- `theme/README.md`, `AGENTS.md` — WP-3.
- Reference only, not edited: `/opt/Obsidian/resources/obsidian.asar` → `app.css` (authoritative
  source for every value copied in WP-2) and `app.js` (`setAccentColor`, `updateTheme`).

## Assumptions

- Obsidian's `.theme-dark` / `.theme-light` variable blocks are stable across minor versions;
  should they move to `:root` or gain specificity, WP-2's `(0,1,1)` selector needs re-checking.
  This is a documented re-vendor trigger, not a silent failure — the symptom recurs visibly.
- `vault.getConfig`/`setConfig` are undocumented but long-stable and widely used by community
  plugins. Guarded by a presence check; a missing method degrades to "no alignment", which is
  today's behaviour.
- `.is-mobile*` selectors reach (0,2,0) and would still outrank the adapter. Desktop-only is
  assumed; mobile is out of scope for this pass.
- The three `--n1-accent-ui-*` triples are eyeballed extrapolations from the user's single Med
  data point and are expected to need one tuning round.
- Adopting Obsidian's own palette per surround is explicitly an interim step (decision 3); true
  N1 hues for cyan/purple/pink are not in the vendored snapshot.

**Total ≈ 0.4 kSLOC, ~265k raw tokens; ~219k Claude-path / ~193k Codex-path Opus/Sol-equivalent tokens.**
