You are reviewing and then implementing the first deterministic orchestrator inside the Crucible Obsidian plugin.

I want you to grill me on implementation details before coding, then implement the smallest useful version.

Context:

Crucible is an Obsidian plugin written in TypeScript. It already has or will have an API-call-based Transcript Refiner workflow. I want to add a vault-native orchestrator, but the orchestrator itself should not be an LLM agent. It should be deterministic glue code: scan, enqueue, route, run, validate, update job status.

The orchestration substrate should live inside the Obsidian vault as Markdown/YAML, not in an external database or separate system.

Core idea:

* Jobs are Obsidian-flavored Markdown files.
* Job metadata lives in YAML frontmatter.
* Jobs move through queue folders:

  * `_system/orchestration/queue/inbox/`
  * `_system/orchestration/queue/running/`
  * `_system/orchestration/queue/done/`
  * `_system/orchestration/queue/failed/`
* The plugin exposes commands:

  * `Crucible: Orchestrator scan`
  * `Crucible: Orchestrator run next`
  * `Crucible: Orchestrator enqueue daily brief lite`
  * `Crucible: Orchestrator enqueue YouTube tracker`
* Optional later: interval-based scan, but do not make the first implementation over-eager.

Round-one workflows:

1. Daily Brief Lite

Purpose:

* Update today’s daily note with:

  * USD/MXN exchange rate
  * EUR/MXN exchange rate
  * weather for:

    * Guadalajara, MX
    * Mount Vernon, WA
    * Bolzano, IT

Constraints:

* No LLM needed.
* Update only a marked block in today’s daily note.
* Do not rewrite unrelated content.
* If a lookup fails, write a clear failure line instead of silently omitting it.
* Use a fenced marker block:

```md
## Daily Brief: External Context

<!-- orchestration:daily-brief-lite:start -->

...

<!-- orchestration:daily-brief-lite:end -->
```

2. YouTube Subscription Tracker

Purpose:

* Read a channel registry from `_system/youtube/channels.yaml`.
* Fetch YouTube RSS feeds by channel ID:

  * `https://www.youtube.com/feeds/videos.xml?channel_id=UC...`
* Extract recent videos.
* Scan the vault for already-captured YouTube video IDs.
* Write a daily intake note listing unseen videos.

Constraints:

* No YouTube Data API for v1.
* No LLM needed.
* Do not create one note per video yet.
* Use video IDs, not titles, for deduplication.
* Support these URL patterns when scanning existing vault notes:

  * `youtube.com/watch?v=VIDEO_ID`
  * `youtu.be/VIDEO_ID`
  * `youtube.com/shorts/VIDEO_ID`
  * `youtube_video_id: VIDEO_ID`

Output path:

* `_system/youtube/new-videos/YYYY-MM-DD.md`

3. Transcript Refiner

Purpose:

* Integrate later with the existing Transcript Refiner workflow.
* For now, create the orchestration interface and a stub worker that throws a clear “not wired yet” error unless the existing service is already present.

Constraints:

* The orchestrator should route to the existing workflow.
* It should not reimplement transcript refinement logic.
* Trigger can later scan for `transcript_status: raw`.

Implementation goal:

Build the smallest useful version inside the repo.

Suggested file structure:

```text
src/orchestration/
  types.ts
  Orchestrator.ts
  JobStore.ts

  workflows/
    DailyBriefLiteWorkflow.ts
    YoutubeTrackerWorkflow.ts
    TranscriptRefinerWorkflow.ts

  utils/
    markdownBlocks.ts
    youtube.ts
    dates.ts
```

Internal TypeScript model:

```ts
export type JobStatus = "queued" | "running" | "done" | "failed";

export type JobType =
  | "daily_brief_lite"
  | "youtube_tracker"
  | "transcript_refine";

export interface OrchestrationJob {
  id: string;
  type: JobType;
  status: JobStatus;
  priority: "low" | "normal" | "high";
  created: string;
  updated?: string;
  inputPaths: string[];
  outputPaths: string[];
  requiresReview: boolean;
  params?: Record<string, unknown>;
  error?: string;
}
```

Important implementation details:

* Use Obsidian `Vault.process()` for safe read-modify-write updates.
* Use `requestUrl()` for HTTP requests.
* Use `registerEvent()` and `registerInterval()` only if needed, and avoid aggressive background scanning.
* Add commands in the plugin `onload()`.
* Prefer deterministic behavior and explicit errors.
* Do not add a dashboard.
* Do not add an LLM classifier.
* Do not add a generalized agent planner.
* Do not introduce a database.
* Keep this vault-native and inspectable.

Questions you should grill me on before implementation:

1. What is the exact daily note path format?

   * Assumption: `daily/day/YYYY-MM-DD.md`

2. Should the daily note be created if missing?

   * My preferred v1 default: yes, create it with minimal heading.

3. What timezone should define “today”?

   * Assumption: `America/Mexico_City`

4. What HTTP sources should be used for weather and FX?

   * For v1, pick simple public endpoints or make them configurable.
   * If using APIs that may be unstable, wrap failures clearly.

5. Where should the YouTube channel registry live?

   * Assumption: `_system/youtube/channels.yaml`

6. What should the initial `channels.yaml` schema be?

   * Proposed:

```yaml
channels:
  - name: Example Channel
    channel_id: UCxxxxxxxxxxxxxxxxxxxxxx
    category: informational
    tags: [ai, research]
    priority: normal
    capture_policy: surface_only
```

7. Should YouTube tracker scan the whole vault or configured folders?

   * Preferred v1: whole vault except `_system/orchestration/queue/`, with a later setting for include/exclude paths.

8. Should jobs be manually run only, or should the plugin run queued jobs automatically?

   * Preferred v1: manual `run next`; no automatic execution until stable.

9. What should happen if a job fails?

   * Move to `failed/`, preserve error in frontmatter, keep the body.

10. Should done/failed jobs be archived by month?

* Preferred v1: not yet. Keep folder flat until volume justifies monthly subfolders.

After asking these questions, make reasonable assumptions and implement.

Definition of done:

* TypeScript compiles.
* Commands are registered.
* `_system/orchestration` folders are created as needed.
* Daily Brief Lite can enqueue and run.
* YouTube Tracker can enqueue and run with RSS.
* Job files move from `inbox` → `running` → `done` or `failed`.
* Daily Brief Lite only replaces its marked block.
* YouTube Tracker writes a daily intake note.
* Transcript Refiner workflow exists as a stub or delegates to existing implementation if found.
* Provide a summary of changed files and any assumptions.

