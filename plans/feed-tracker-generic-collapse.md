# Feed-tracker generic collapse (YouTube + Blogs)

> Part 2 of 6 of the architectural cruft sweep. Independent — can run standalone.
> Behavior-preserving refactor only. Generated intake notes must stay byte-shape identical.
>
> **Cross-unit coupling:** the Dashboard unit (`dashboard-split-into-repos-and-renderers.md`) imports
> `listYoutubeIntakeRuns` / `listBlogsIntakeRuns` and the `YoutubeIntakeRunStat` / `BlogsIntakeRunStat`
> types from `youtubeIntake.ts` / `blogsIntake.ts`. When collapsing those utils into `feedIntake.ts`,
> **keep those four export names stable** (re-export them from the new module). If you run AFTER the
> Dashboard unit, also update the two import lines in the dashboard's intake sections.

## Context

`src/orchestration/workflows/YoutubeTrackerWorkflow.ts` (301) and `BlogsTrackerWorkflow.ts` (325)
are **~90% structurally identical** — mechanical variable-name swaps (channel↔blog, video↔post,
`yt-video-id`↔`post-id`). The intake utilities `youtubeIntake.ts` and `blogsIntake.ts` are mirror
images too. This is ~600 lines of duplicated orchestration that drifts independently (the
`firstUrlId` vs `firstUrlAsId` pair already diverged — only the blogs one validates the URL).

## Verified duplication (re-read before starting)

Both workflow files contain matching members:
- `class XTrackerWorkflow implements Workflow` with `run(job, ctx)` (YT 34, Blogs 36) — bodies ~85 lines, near-identical.
- `createExampleRegistry` (119 / 122), `allocateIntakePath` (222 / 235) — identical.
- `class XTrackerConsolidateWorkflow extends XTrackerWorkflow` (234 / 247).
- `detectVideoIdSource` / `detectPostIdSource` (270 / 283) — differ only by FM key.
- `firstUrlId` / `firstUrlAsId` (276 / 289) — differ only by a URL-validation guard (keep the stricter one).
- `describeReason` (290 / 306), `escapeBrackets` (296 / 312) — identical verbatim.
- Constants `FEED_FETCH_CONCURRENCY = 4`, `FEED_FETCH_MIN_INTERVAL_MS = 250`, `PRIORITY_ORDER` — identical.

Intake util mirrors (`src/orchestration/utils/youtubeIntake.ts` / `blogsIntake.ts`):
- Constants `INTAKE_ROOT_*`, `QUEUE_SCAN_SKIP_PREFIX_*`, `TRACKER_GENERATED_BY_*`, `CONSOLIDATE_GENERATED_BY_*`.
- `buildXSeenIdSet`, `loadConfiguredX`, `scanXTrackerRuns`, `listXIntakeRuns`, `parseIntakeX`.
- Note: `RemoteVideo`/`RemotePost` are re-exported from the workflow files — keep those export paths stable.

## Target structure

A single generic `FeedTrackerWorkflow` parameterized by a typed source descriptor:

```ts
interface FeedSource<Entry, Item> {
  kind: 'youtube' | 'blogs';
  intakeRoot: string; trackerGeneratedBy: string; consolidateGeneratedBy: string;
  fmIdKey: string;                              // 'yt-video-id' | 'post-id'
  parseRegistry(content: string): Entry[];      // parseChannelsTable | parseBlogsTable
  fetchFeed(entry: Entry): Promise<Item[]>;     // fetchChannelFeed | fetchBlogFeed
  buildSeenIdSet / loadConfigured / scanRuns / listRuns / parseIntake;  // from intake utils
  // labels/columns for the intake note
}
```

- One `FeedTrackerWorkflow implements Workflow` + one `FeedTrackerConsolidateWorkflow` that close over a
  descriptor. Register two instances (youtube, blogs) wherever the orchestrator currently registers the
  two concrete workflows.
- Hoist the verbatim-identical helpers (`describeReason`, `escapeBrackets`, `allocateIntakePath`,
  `createExampleRegistry`, the sort/filter/`writeIntakeNote` body, `FEED_FETCH_*`, `PRIORITY_ORDER`) into
  the shared module. Unify `detectXIdSource` and `firstUrl*` into one helper parameterized by `fmIdKey`,
  keeping the stricter URL validation.
- Collapse `youtubeIntake.ts` + `blogsIntake.ts` into one `feedIntake.ts` parameterized by the descriptor
  constants (preferred), or keep two thin constant modules feeding one generic implementation. Whichever
  keeps every file under 1000 lines.

## Steps

1. Define `FeedSource<Entry, Item>` and the two descriptors (youtube, blogs).
2. Write `FeedTrackerWorkflow` / `FeedTrackerConsolidateWorkflow` from the YouTube version, replacing each
   hardcoded bit with a descriptor field.
3. Repoint orchestrator registration to the two parameterized instances.
4. Delete `BlogsTrackerWorkflow.ts` and the now-duplicate helpers from the YouTube file.
5. Collapse the intake utils; preserve the `RemoteVideo`/`RemotePost` export paths consumers rely on.

## Guardrails

- No file over 1000 lines.
- Generated intake notes and consolidate output must be shape-identical to pre-refactor.
- Reuse existing `rateLimitedAllSettled` (`utils/rateLimit.ts`) and the existing parse/fetch helpers — no new forks.

## Verification

- `npm run build` clean; `npm run lint` clean.
- Run a youtube-tracker and a blogs-tracker job end-to-end. Diff a generated intake note before vs after the
  refactor — must match. Confirm dedup still skips seen IDs and consolidate still merges runs.
