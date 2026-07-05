# TN Review Remediation Orchestration

## Summary

- Execute the remediation in ordered waves from `plans/tn-review-remediation-2026-07-04.md`.
- Treat WP1 and WP2 as blockers; finish them first because later cleanup depends on their boundaries.
- Keep WP12 deferred by default: do not remove bullet-comment metadata emission/parsing until the owner explicitly decides.
- Before implementation begins, remind the user to run `npm run dev` in a separate terminal for Obsidian hot reload.

## Implementation Order

- Wave 1: WP1, WP2.
  - WP1: extract trigger UI from `src/settings/sections/automate.ts` into `triggers.ts`; extract shared guard-condition fields into `guardConditionFields.ts`.
  - WP2: add optional `FeedSource` hooks for item suffix rendering and metadata persistence; remove blog-specific casts/branches from `FeedTrackerWorkflow`.

- Wave 2: WP3, WP5, WP7, WP8, WP11.
  - WP3: create canonical lane helpers in `src/orchestration/lanes.ts`; update file/memory backends and `JobStore`.
  - WP5: extract `AutoLocalizeScheduler` with injected dependencies; update tests to import scheduler directly instead of bundling `main.ts`.
  - WP7: widen source-eval plugin parameters to `CruciblePlugin` and delete Pick-then-cast boundaries.
  - WP8: add narrow `TableStateContext`; remove `asSectionContext`.
  - WP11: migrate all internal-command registrations to `{ schema: [...] }`; remove the array/options union.

- Wave 3: WP4, WP6, WP9, WP10.
  - WP4: add shared control-center rendering and row-computation helpers for blogs/channels while preserving existing filters and columns.
  - WP6: consolidate helpers into fixed homes: `vaultWalk.ts`, `frontmatterValues.ts`, `ingestion/render/format.ts`, and `sourceEval/metrics.ts`.
  - WP9: remove read-path `channelId` value-kind inference; only use `youtube-channel` as an initial UI default when a newly typed property is `channelId` and no value kind exists.
  - WP10: build blog metadata-note indexes once per run and thread them through tracker persistence and uncaptured-row computation, keeping fallback lookup for cache misses.

## API / Type Changes

- `FeedSource<Entry, Item>` gains optional `itemBulletSuffix` and `persistItemMetadata` hooks.
- `ChainManager.registerInternalCommand` accepts only `ChainCommandOptions`; legacy bare schema arrays are removed.
- `SectionContext` extends new `TableStateContext`; sortable table APIs accept `TableStateContext`.
- New internal modules: trigger settings, guard-condition fields, lane helpers, auto-localize scheduler, shared frontmatter/value/format helpers.
- No user-facing command IDs or settings schema changes are intended.

## Test Plan

- Run focused tests after relevant waves: `blogsEnrichment`, `feedSeenSet`, `autoLocalizeScheduler`, `sourceEvalExport`, `guardEval`, `chainCycle`, and `metadataTriggerActions`.
- Add or update tests where behavior changes: scheduler import boundary, FeedSource hooks, lane helper reuse, `channelId` default behavior, metadata-note indexing.
- Final mandatory cleanup loop, sequentially:
  - `npm run lint`
  - `npx tsc -noEmit -skipLibCheck`
  - `node esbuild.config.mjs production`
- All commands must exit 0 before reporting completion.

## Assumptions

- WP12 is deferred; `buildBlogBulletSuffix` and `parseBlogBulletMeta` remain unchanged.
- Current repo drift is minimal: the remediation plan file is untracked, and target extracted modules do not yet exist.
- Preserve the plan's listed positives: guard-eval unification, trigger registry boundary, thin workflows, sweep chunking, presence-based blog body detection, and OpenAI-compatible provider folding.
