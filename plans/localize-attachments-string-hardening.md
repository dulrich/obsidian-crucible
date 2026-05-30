# Localize attachments string hardening

> Part 5 of 6 of the architectural cruft sweep. Independent.
> This is the ONLY unit with real behavior risk — the existing code is already fragile. Add edge-case tests.

## Context

`src/localizeAttachments.ts` (651 lines) downloads/localizes remote attachments and rewrites markdown
image references. It uses naive substring replacement and unguarded numeric handling. Commit 4320fcf
("cleanup alt text that broke on numeric edge cases") confirms a real regression already landed here.

## Verified problem areas (re-read before starting)

- Naive replacement: `for (const r of replacements) updated = updated.split(r.from).join(r.to);` —
  substring (not anchored) replacement; numeric/substring collisions corrupt unrelated text.
- Regexes near top: `MD5_NAME_RE`, `REMOTE_MD_IMAGE_RE`, `DATA_URI_IMAGE_RE` — and `(... .match(RE) || []).length`
  placeholder counting that depends on match success.
- Quality clamp `Math.min(100, Math.max(30, quality)) / 100` — returns `NaN` if `quality` is `NaN`/undefined.
- MD5 byte loop with `>> 2` / `% 4` indexing — no bounds handling for empty/huge inputs.

## Target

- Replace substring `split(from).join(to)` with **anchored, escaped** replacements, or a single pass over
  the matched markdown-image ranges (using the existing image regexes) so a replacement can never hit an
  unintended substring (e.g. numeric alt text like `![alt 2024-01-15]`, or numeric-heavy filenames).
- Guard the numeric paths: clamp against `NaN`/undefined for the quality parameter; bounds-check the MD5
  byte loop for empty input.
- Extract the alt-text / markdown-image transforms into small **pure functions** so they're testable in
  isolation.
- Add focused unit-style checks for the numeric edge cases that previously broke (numeric alt text,
  numeric filenames, empty input, NaN quality). This is the one unit where locking behavior down with
  tests is worth it.

## Steps

1. Pull the alt-text/image-ref rewrite into pure functions taking `(content, replacements)` and returning
   the rewritten string, with anchored/range-based replacement.
2. Harden the numeric paths (quality clamp, MD5 bounds).
3. Wire the pure functions back into the localize flow; behavior for the normal path must be unchanged.
4. Add edge-case tests (numeric alt, numeric filename, empty, NaN quality).

## Guardrails

- No file over 1000 lines (this one is already 651; keep extractions small).
- Normal-path behavior unchanged — only the broken edge cases change (they stop corrupting output).

## Verification

- `npm run build` clean; `npm run lint` clean; new edge-case checks pass.
- Run `lint-localize-attachments` on a note containing numeric alt text and numeric-heavy filenames;
  confirm no corruption and that `_MD5` names are stable across runs.
