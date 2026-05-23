# Plan: Lint command writes YT/blog IDs to frontmatter + consolidate extractors

## Context

The `Crucible: Lint all` command (`src/lint.ts` → `Linter.lintFile`) currently
fills in standard frontmatter (`created`, `title`, `modified`, `word-count`,
plus template-driven inserts) but does *not* derive a YouTube video ID or blog
post ID from the note's content. Two of the workflows already derive these
IDs:

- `extractVideoIdFromUrl` — `src/orchestration/utils/youtube.ts:26`
- `postIdFromUrl` — `src/orchestration/utils/blogs.ts:186`

But `canonicalizeUrl` in `src/orchestration/utils/urlCanonicalize.ts:52-74,143`
re-implements YT video ID parsing inline, and `LinkScanWorkflow.ts:102,135`
uses that path to write a third frontmatter key (`yt-video-id`) — so YT
extraction has two source-of-truth paths.

The user wants:

1. The Lint command to call the canonical extractors and write `yt-video-id`
   and `post-id` into the note's frontmatter (only if a value is found).
2. The YT extractor duplication consolidated to a single function.
3. Frontmatter key naming standardized to **kebab-case** going forward:
   `yt-video-id` / `yt-video-ids` / `post-id` / `post-ids`. Existing notes
   with snake_case keys will be migrated by a new vault-wide rename command,
   not by this task's lint pass.
4. A new command `Lint: Update property in vault` that prompts for an old
   property name and a new property name, then rewrites every note's
   frontmatter accordingly. This is the migration tool for the kebab-case
   transition (and any future rename).

## Scope

In scope:

- Extend `Linter.lintFile` to populate `yt-video-id` and `post-id` from body
  content.
- Consolidate YT extraction so a single function owns the regex set.
- Switch tracker writers/readers from snake_case to kebab-case keys.
- Add the `Lint: Update property in vault` command.

Out of scope:

- Auto-migration of existing notes — handled manually via the new rename
  command.
- Any change to body-URL parsing for hosts other than YouTube and the blog
  sources already tracked.
- Reconciling `extractLinkUrl` (markdown-link unwrap) — already shared.

## Approach

### Part A — Consolidate YT extraction

Refactor `canonicalizeUrl` (`src/orchestration/utils/urlCanonicalize.ts`) so
that its YT video ID extraction delegates to `extractVideoIdFromUrl` in
`utils/youtube.ts`. `canonicalizeUrl` retains its URL-rewriting
responsibilities (host normalization, channel-handle canonicalization,
`/shorts/` → `/watch?v=`, tracking-param strip) — only the ID-extraction
step is shared.

The regex set in `youtube.ts` (`URL_PATTERNS`, currently `watch?v=`,
`youtu.be/`, `/shorts/`) becomes the single source of truth.

Risk to verify before swapping: `canonicalizeUrl` today uses `new URL(...)`
parsing, which is more tolerant of unusual query-param ordering (e.g.
`?si=xxx&v=abc`). Confirm `extractVideoIdFromUrl` matches every URL shape
`canonicalizeUrl` currently handles. If a gap exists, extend
`extractVideoIdFromUrl` (try `URL`-parsing for the `v=` query case first,
regex fallback second) rather than leaving the duplication in place.

### Part B — Extend `Linter.lintFile` (frontmatter-only)

**Important constraint (user-confirmed): the lint additions only read from
the note's frontmatter — never the body.** The relevant YT/blog ID is
metadata about the note, derived from the note's existing frontmatter URL
field (typically `source`). Do not scan the body, do not parse YT embed
lines, do not use `YT_EMBED_RE` for this feature.

In `src/lint.ts`, inside the `updateFrontmatter` callback (around lines
183-192):

1. Read the URL from the frontmatter. Primary key: `source`. If reading more
   than one URL-typed key turns out to be desirable, the candidate list can
   be widened at implementation time — start with `source`.
2. **YT video id**: call `extractVideoIdFromUrl(source)`. If it returns a
   value, write `yt-video-id` via `upsertFrontmatterPropertyIfEmpty` (don't
   clobber a manually set value). If `null`, no-op — do not delete an
   existing key.
3. **Blog post id**: if `extractVideoIdFromUrl(source)` returned `null` (i.e.
   the source isn't a YT URL) and `source` is a valid http(s) URL, call
   `postIdFromUrl(source)` and write `post-id` via
   `upsertFrontmatterPropertyIfEmpty`. The YT/blog branches are mutually
   exclusive — a YT URL produces only `yt-video-id`, a non-YT URL produces
   only `post-id`.
4. Both fields go through `sortFrontmatterProperties` already at line 191 —
   no extra plumbing required.
5. Both writes are **skip-when-empty**: missing/invalid `source` → no key
   added. Existing key → leave untouched.

Imports to add at top of `src/lint.ts`:

```ts
import { postIdFromUrl } from './orchestration/utils/blogs';
```

(`extractVideoIdFromUrl` is already imported at line 5. The body-scanning
constants `YT_EMBED_RE` etc. stay where they are — they're used by
`cleanupYoutubeTranscript`, not by this new logic.)

### Part C — Kebab-case keys for new writes

Change all *new* frontmatter writes to kebab-case. Existing snake_case writes
get renamed in place:

- `YoutubeTrackerWorkflow.ts`:
  - `video_ids` → `yt-video-ids` (lines 171, 197, 210, 213)
  - dedup read at line 171 reads the new key.
- `BlogsTrackerWorkflow.ts`:
  - `post_ids` → `post-ids` (lines 174, 201, 214, 215, 218)
- `LinkScanWorkflow.ts`:
  - `yt-video-id` already kebab — no change.

Existing notes with the old snake_case keys will silently fall out of dedup
until the user runs the new rename command (Part D). That's acceptable per
user direction.

### Part D — New command: `Lint: Update property in vault`

A new command registered alongside the lint commands. UX:

1. Prompt the user for the **old property name** (an input modal).
2. Prompt for the **new property name**.
3. Walk every markdown file under the vault (respecting
   `lintIgnoredFolders`), and for each note whose frontmatter contains the
   old key, move the value to the new key via `updateFrontmatter`
   (`src/frontmatter.ts`). Use the existing `withMaterializing` pattern so
   bulk edits don't trigger downstream side effects.
4. Show a final notice: `Renamed X notes`.

This command is the canonical migration path for the snake_case → kebab-case
transition and for any future key rename.

Wiring point: `src/main.ts` (command registration) and a new method on
`Linter` (e.g. `renamePropertyInVault(oldKey, newKey)`).

## Files to modify

- `src/orchestration/utils/urlCanonicalize.ts` — replace inline YT ID regex
  with delegation to `extractVideoIdFromUrl`.
- `src/orchestration/utils/youtube.ts` — possibly extend `URL_PATTERNS` if
  parity check finds gaps.
- `src/lint.ts` — add YT/blog ID writes in `lintFile`; add
  `renamePropertyInVault` method; add `postIdFromUrl` import.
- `src/main.ts` — register `Lint: Update property in vault` command.
- `src/orchestration/workflows/YoutubeTrackerWorkflow.ts` — rename
  `video_ids` → `yt-video-ids` at all read/write sites.
- `src/orchestration/workflows/BlogsTrackerWorkflow.ts` — rename `post_ids`
  → `post-ids` at all read/write sites.
- `AGENTS.md` — `## Quirks`: note the new kebab-case frontmatter convention
  for ID fields, and that `canonicalizeUrl` delegates ID extraction to
  `extractVideoIdFromUrl` (Shorts and watch URLs produce the same ID).
- `plans/lint-id-extraction-reuse.md` — supersede with link to this plan,
  or update in place.

## Verification

1. **Build**: `npm run build` cleanly compiles.
2. **YT lint write** — fixture note with `source: https://www.youtube.com/watch?v=<id>` in frontmatter:
   - Run `Crucible: Lint all` on the note.
   - Confirm `yt-video-id: <11-char id>` lands in frontmatter.
   - Confirm `post-id` is **not** added (YT branch is exclusive).
   - Re-run lint; confirm the key isn't duplicated or overwritten.
   - Run on a note with no `source` key; confirm no `yt-video-id` is added.
   - Run on a note where the body contains a YT URL but frontmatter has no
     `source`; confirm `yt-video-id` is **not** added (body must not be
     scanned).
3. **Blog lint write** — fixture note with `source: https://example.com/post/...` in frontmatter:
   - Run lint; confirm `post-id` lands in frontmatter with the canonical URL
     form produced by `postIdFromUrl`.
   - Confirm `yt-video-id` is **not** added.
   - Run on a note with no `source` key; confirm no `post-id` is added.
4. **YT extractor consolidation** — run `LinkScanWorkflow` on a note with a
   `/shorts/<id>` URL and a `watch?v=<id>` URL pointing at the same video:
   - Confirm both yield the same `yt-video-id`.
   - Confirm `canonicalizeUrl` still rewrites Shorts to `watch?v=` form.
5. **Tracker dedup with new keys** — run `YoutubeTrackerWorkflow` and
   `BlogsTrackerWorkflow` against a tracker note that already has
   `yt-video-ids` / `post-ids` populated; confirm dedup works.
6. **Rename command** — create a fixture note with `video_ids: [abc]`. Run
   `Lint: Update property in vault` with old=`video_ids`, new=`yt-video-ids`.
   Confirm the key is renamed, value preserved.
7. **Lint regression** — run `Crucible: Lint all` on the full vault; word
   count, created date, sort order remain correct.

## Open implementation question

Whether to read URL-typed frontmatter keys beyond `source` (e.g. `url`,
`link`). Start with `source` only; widen at implementation time if a
representative fixture note uses a different key.
