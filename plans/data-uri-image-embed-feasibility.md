# Feasibility: embedding external images as inline `data:` URIs (Obsidian/OFM)

*Research deliverable for WP-1 of the 2026-07-17 bugfix sprint. The question: instead
of leaving external images as remote refs (the `localize`-exclusion path we shipped),
could Crucible embed them inline as base64 `data:` URIs so the note is self-contained
without pulling files into an attachment folder?*

## Short answer

**Technically possible for small images in reading view; not recommended as a
localization strategy.** The shipped `localize` per-folder exclusion is the correct
mechanism for "lint frontmatter but leave external images alone." Do **not** build
data-URI embedding this sprint; revisit only for a narrow, explicitly-scoped
"tiny inline icon" case if one ever arises.

## What Obsidian/OFM actually supports

- **Standard Markdown image syntax** `` uses a normal
  `<img src>`. Data URIs are a valid image source, so **reading view renders them**
  (spot-check on the target Obsidian version before relying on it — behavior has
  historically varied and some builds have restricted non-`app://`/`https` sources).
- **Wiki embeds** `![[…]]` resolve only against **vault files**, never a `data:`
  string. So the vault-native embed syntax cannot carry a data URI at all.
- **OFM adds nothing here** — Obsidian Flavored Markdown extends links/embeds/
  callouts, not image source schemes. There is no first-class "inline image blob".

## Why it's a poor fit for localization

- **Live Preview / edit mode is the dealbreaker.** The base64 payload sits inline in
  the source line. For anything beyond a few KB the line becomes enormous, the editor
  can lag or stutter on that note, and cursor/selection behavior gets awkward — the
  "strange UI experience in edit mode" flagged when this was raised.
- **File bloat + tooling breakage.** Base64 inflates bytes ~33%. Multi-KB/MB images
  inline balloon the `.md` file, pollute search indexing, wreck diffs, and slow any
  full-vault scan (lint, search, localize itself).
- **No round-trip.** Once inlined there is no attachment file to re-point, dedupe by
  content hash (`_MD5` naming), or repair — Crucible's existing localize/repair
  machinery operates on files, not embedded blobs.

## What we did instead (and why it's sufficient)

The `localize` exclusion scope leaves remote `![](https://…)` refs exactly as-authored
in the excluded folder while still linting frontmatter — meeting the actual goal
(external images stay external, no local pull) without any of the above costs.

## If ever revisited

Scope it to **small images only** with a hard byte ceiling (e.g. ≤ 8–16 KB), gate it
behind an explicit opt-in distinct from localization, and verify reading- and edit-mode
rendering on the shipping Obsidian version first. Not warranted on current evidence.
