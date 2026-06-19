# README and Docs Refresh Plan

## Summary
Update the docs as a user-facing documentation pass, not an implementation change. The README should become a concise product overview with links into `docs/`, while detailed behavior moves into focused guide pages.

Current README staleness to address:
- Missing command reference for Materialize, Lint, Files, Ingestion, Orchestrations, Search, and dynamic Shortcuts/Captures/Chains/Agents.
- Missing newer surfaces: ingestion dashboard, YouTube/blog trackers, attachment localization/repair, search companion/indexing, command visibility, command palette hints, queue/autorun behavior.
- Existing features are too terse for setup-heavy workflows like AI providers, agents, chains, captures, trackers, search, and localize attachments.
- Installation still says Community Plugins "Pending"; keep that only if still true, otherwise replace with local build/install instructions.

## Key Changes
- Rewrite `README.md` as:
  - short description and "what Crucible replaces"
  - high-level feature map grouped by Materialize, Capture/Chains/Agents, Lint/Localize, Orchestration/Ingestion, Search, Settings/Commands
  - quick install/build notes
  - "Start here" links to `docs/index.md`
  - compatibility note that `main.js`, `manifest.json`, and `styles.css` are the Obsidian artifacts

- Add `docs/index.md` as the documentation hub linking to:
  - `docs/commands.md`
  - `docs/materialize-and-templates.md`
  - `docs/captures-chains-agents.md`
  - `docs/lint-and-localize.md`
  - `docs/orchestration.md`
  - `docs/tracked-sources.md`
  - `docs/ingestion-dashboard.md`
  - existing `docs/search-companion.md`

- Add `docs/commands.md` with the current command inventory:
  - Static groups: Materialize, Lint, Other, Ingestion, Orchestrations, Search.
  - Dynamic groups: `Shortcut: <name>`, `Capture: <name>`, `Chain: <name>`, `Agent: <name>`.
  - Note command visibility toggles, queueable commands, and that mutating chain steps can take a note lock.

- Add `docs/tracked-sources.md` for Tracked Blogs and YouTube:
  - YouTube registry table: required `Channel`, `ID`; optional `Tags`, `Priority`.
  - YouTube values: `ID` must be a `UC...` channel ID; `Tags` comma-separated; `Priority` accepts `high`, `normal`, `low`, with `skip`/`ignore` excluding a row.
  - Blog registry table: required `Name`, `Link`, `Method`; optional `Tags`, `Priority`, `Canon`, `Body`.
  - Blog values: `Method` currently only supports `RSS`; `Priority` accepts `high`, `normal`, `low`, with `skip`/`ignore` excluding a row; `Canon` accepts `auto`, `substack`, `strip-params`, `keep-params`; `Body` accepts `auto`, `full`, `snippet`.
  - Document that blog links may be raw URLs, markdown links, or angle-bracket URLs, and invalid/unsupported blog rows appear as skipped rows in intake notes.

- Add non-obvious user-facing behavior notes where they belong:
  - `Lint: localize attachments` is separate from `Lint: all`.
  - Localized files use deterministic content MD5 names and empty markdown alt text intentionally.
  - Data URI image placeholders are stripped during image localization.
  - Tracker diff mode uses frontmatter IDs and intake notes to decide what is already seen.
  - Blog canonicalization is platform-aware; unknown query params are preserved unless configured otherwise.
  - YouTube metadata enrichment is queued and rate-limited; notes need `yt-video-id` and missing `yt-metadata`.
  - Orphaned attachment cleanup keys off `_MD5` filenames and resolved note links.

## Public Interfaces
No TypeScript APIs, settings schema, or runtime behavior should change. This is a documentation-only update.

The only public-facing additions are new Markdown docs and README links. Existing `docs/search-companion.md` should remain, with only link/title normalization if needed.

## Test Plan
- Run markdown sanity checks manually by verifying all README and `docs/index.md` links point to existing files.
- Run `rg -n "TODO|Pending|open.er-api|Daily Notes|Templater|QuickAdd|Shell Commands" README.md docs` after editing to catch stale copy.
- Run the mandatory cleanup loop before reporting implementation complete:
  - `npm run lint`
  - `npx tsc -noEmit -skipLibCheck`
  - `node esbuild.config.mjs production`
- Confirm all commands exit with code 0.

## Assumptions
- Use concise user docs, not exhaustive developer internals.
- Keep docs source-of-truth aligned with current code, especially command names and tracker table values.
- If implementation is approved while still in Plan Mode, first write this plan to `plans/readme-docs-refresh.md` before making docs changes.
