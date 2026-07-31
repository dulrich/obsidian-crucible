# X post-metadata ingestion — oEmbed pipeline (canonicalize → discover → fetch → materialize)

*Recommended model/effort — Claude: Sonnet/medium workers for XM1–XM4, orchestrator (Fable)
closes XM5 direct; Codex: Terra/medium workers, Sol/medium orchestrator.*

**Repo plan (canonical, first implementation step): `plans/x-post-metadata-ingestion.md`,
registered as `- "[[x-post-metadata-ingestion]]"` in `INITIATIVE.md` `pending-plans`,
committed docs-only before any source edit. WP prefix `xm`.**

## Context

A clipped page (e.g. a Digg discussion) can link an X status whose content is absent from
the clip. X's official oEmbed endpoint (`https://publish.x.com/oembed?url=…&omit_script=true&dnt=true`)
returns author, date, and full post HTML **without auth** — confirmed live against status
`2078296458122645635` (user research: `references/x-post-metadata-ingestion-findings.md`).
This plan materializes X posts as local metadata notes, following the YouTube/blog
metadata patterns. Presentation (embeds/cards/hover) is explicitly out of scope.

Grounding (three Explore reports, current master `ac60a00`) — corrections to the findings doc:
- The live queue backend is **`DbJobBackend`** (sole `createBackend` arm, `Orchestrator.ts:94-100`); `FileJobBackend` doesn't exist.
- **Zero x.com/twitter.com handling exists anywhere** in `src/`. Both canonicalizers are
  independent: `canonicalizeUrl` (`utils/urlCanonicalize.ts:35`, YT+arXiv only) and
  `postIdFromUrl` (`utils/blogs.ts:390`, Substack only). X `?t=`/`?s=` params are not in
  the tracking denylist → variant URLs mint duplicate link-registry records today.
- The link registry (`_crucible/link_registry`, one md note per canonical URL,
  `LinkScanWorkflow.ts:127-148`) has **no read API**; `state` is written-but-never-read
  (free to own); `url/canonical_url/domain/source_notes/last_seen` are rewritten every
  scan → new data must live in new keys. `link_scan` is manual-only, no dedupe key.
- The closest materializer exemplar is **blogs**: `ensureBlogMetadataNote`
  (`utils/blogsApi.ts:68`) — `withResourceLock('blog-post', id, …)`, `htmlToMarkdown`
  (already imported there; exported by obsidian), content compare. Path/probe exemplar is
  **YouTube**: `ensureMetadataNote` (`utils/youtubeApi.ts:408`), one-level child-folder
  probe by `<id>.md` (`findExistingMetadataNote` `:336-345`), `requestUrl({throw:false})`
  status-classification chokepoint (`requestYoutubeApi` `:98-133`), breaker via
  `serviceHealth.ts` (lazy by string id; `services:[…]` in job config).
- `tests/fixtures/` does not exist; the oEmbed sample `json.json` is NOT in the repo.
- Dashboard section = 4 mechanical edits (SectionId union, SCAN/FAST set, `renderSection`
  switch, `route()` dirty-marking) + the **fixed frontmatter-signature key list at
  `ingestionDashboard.ts:397`** which new keys must join or meta events never fire.

## Decisions locked (user, this session)

1. **Full ingestion pipeline** this sprint: canonicalization + oEmbed client + fetch
   workflow + live discovery on the clipper inbox + link-registry backfill + dashboard
   section. Presentation deferred.
2. **Durable tombstone notes** for deleted/private/suspended posts (`state: unavailable`,
   no body). Transient failures (429/5xx/network) defer/retry, never tombstone.
3. **Snapshot semantics**: note exists → `exists`, no refetch (YT model). Manual refresh
   is a later WP.
4. **Stamp source notes**: write an `x-metadata` frontmatter **list** of wikilinks on each
   source note (the `yt-metadata` pattern, pluralized — one clip can cite several
   statuses), via `updateFrontmatter` under the note lock.

## Summary

New leaf `xPost.ts` owns X URL parsing/canonical identity (statusId); `xApi.ts` owns the
oEmbed client + note materializer (tombstones included) behind a new `x-oembed` breaker;
two new job types split discovery from fetching (`x_post_discover` per note,
`x_metadata_fetch` per status, dedupe `status:<id>`); a founding trigger on the clipper
inbox and a registry backfill job feed the same fetch job; a dashboard section gives
visibility + per-row Fetch + backfill button. Notes land at
`_x_metadata/<author-handle>/<statusId>.md`.

## Key Changes

**WP-XM1 — X URL contract + oEmbed client + materializer.**
*~0.55 kSLOC · ~230k tokens (calibration-padded) · ~18 min wall · mid (Claude
Sonnet/medium; Codex Terra/medium) · Claude: subagent (~70% saving); Codex: subagent (~50%)*
- New `src/orchestration/utils/xPost.ts` (dependency-light leaf, the "single X status-ID
  home" analog of `utils/youtube.ts`): `extractXStatusFromUrl(raw)` →
  `{ handle: string | null, statusId: string } | null`. Accepts `x.com`, `twitter.com`,
  `www.`/`mobile.` variants, paths `/<handle>/status/<digits>` and `/i/web/status/<digits>`
  (handle null). Canonical form `https://x.com/<handle>/status/<id>` (or `/i/web/status/<id>`),
  **all query params dropped** for status links. Identity = numeric statusId.
- Wire into `canonicalizeUrl` (`utils/urlCanonicalize.ts`): new X-hosts branch delegating
  to `xPost.ts` (mirror the YT delegation), add optional `xStatusId` to `CanonicalizedUrl`;
  `LinkScanWorkflow` writes `x-status-id` on link records (fill-if-empty, beside
  `yt-video-id`). Fixes the `?t=`/`?s=` duplicate-record bug.
- New `src/orchestration/utils/xApi.ts` modeled on `youtubeApi.ts`/`blogsApi.ts`:
  - `requestXOembed(canonicalUrl)` via `requestUrl({ url, method:'GET', throw:false })`
    against `https://publish.x.com/oembed?url=<enc>&omit_script=true&dnt=true`.
    Classification **by type**: 404/403 → `XPostUnavailableError` (permanent, carries
    reason `deleted-or-private`); 429 → `XApiUnavailableError('rate-limited', retryAfterMs
    from headers)`; ≥500 → `'server-error'`; network throw → `'refused'`.
  - New breaker id `SERVICE_X_OEMBED = 'x-oembed'` in `serviceHealth.ts` (lazy-created).
    **Unavailable posts never open the breaker** (per-post outcome, not infra) — mirror of
    the no-api-key rule, orchestration `AGENTS.md:43`.
  - `ensureXMetadataNote(plugin, statusId, canonicalUrl)` →
    `withResourceLock('x-post', statusId, 'x-metadata-ensure', …)`; probe
    `findExistingXMetadataNote` (one-level child-folder probe by `<statusId>.md`, YT
    shape) → `exists`; miss → fetch → `vault.create` at
    `<root>/<slugified-author-handle>/<statusId>.md`; unavailable →
    tombstone at `<root>/_unavailable/<statusId>.md`. Result union
    `created | exists | tombstoned | …` (constructed, never spread).
  - Frontmatter (hand-built YAML, YT style): `status-id`, `url`, `author`,
    `author-handle`, `author-url`, `published`, `oembed-type`, `oembed-version`,
    `state: ok | unavailable`, `unavailable-reason` (tombstone only), `fetched_at`,
    `source_command: x-fetch-post-metadata`. Body: `htmlToMarkdown(oembed.html)` with a
    pre-pass stripping any `<script>` (belt-and-braces over `omit_script=true`); never
    persist script/iframe machinery. Empty body for tombstones.
- New setting `orchestrationXMetadataRoot` default `'_x_metadata'` (`types.ts` decl +
  `DEFAULT_SETTINGS`; UI lands in XM4).
- Fixture `tests/fixtures/x-oembed-panda.json`: **the orchestrator fetches the live
  oEmbed response at dispatch time and places it in the worktree** (worker treats it as
  read-only input; tests read from disk, per the findings doc's instruction not to depend
  on any vault-root `json.json`).
- Tests: canonicalization matrix (x/twitter/mobile/query variants → one identity — the
  findings doc's acceptance items 1–2), oEmbed classification via the
  `globalThis.__respond`-style `requestUrl` stub (exemplar
  `tests/youtubeWorkflowServiceHealth.test.mjs`), materializer create/exists/tombstone
  idempotency, assert the note body contains "absurdly information-dense" and
  "rate-adjacent" and contains no `<script`.
Files: `src/orchestration/utils/{xPost,xApi}.ts` (new), `utils/urlCanonicalize.ts`,
`workflows/LinkScanWorkflow.ts` (key add only), `serviceHealth.ts` (constant),
`src/types.ts`, tests + fixture. NOT in scope: `postIdFromUrl`/lint derive-source-ids,
job types, UI.

**WP-XM2 — job types + workflows + source-note stamping + registration.**
*~0.45 kSLOC · ~220k tokens · ~17 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent*
- `JobType` union (`orchestration/types.ts:10-31`) += `x_metadata_fetch`,
  `x_post_discover`.
- `XMetadataFetchWorkflow` (params `{ statusId, url, sourcePaths?: string[] }`, no
  constructor deps, all via `ctx.plugin`): `ensureXMetadataNote` → on
  created/exists/tombstoned, for each sourcePath stamp the `x-metadata` frontmatter
  list (append `[[<path sans .md>]]` if missing) via `updateFrontmatter` inside
  `withLock(sourcePath, 'x-metadata')`. **Sequencing rule: ensure (resource lock)
  completes and releases BEFORE any note lock is taken — never nest note-lock inside
  resource-lock** (root `AGENTS.md` lock-ordering quirk). Results constructed per
  variant: done (+`outputPaths:[metadataPath]`); `XApiUnavailableError` → deferred +
  `serviceUnhealthy: { service: 'x-oembed', … }` (+`retryAfterMs`); bad params → failed
  with `error`. Tombstone = **done** (notes `unavailable: <reason>`) — a durable record
  is a successful materialization; backfill/discover skip it via the probe.
- New bus event `x-metadata-enriched: { statusId, metadataFile: TFile, sourceFiles?: TFile[] }`
  (`orchestration/events.ts`), emitted by the **workflow** on done with a real resolved
  TFile (guards mirror `emitEnriched`, `YoutubeMetadataFetchWorkflow.ts:73-93`; per
  AGENTS rule the queue never carries per-type events).
- `XPostDiscoverWorkflow` (params `{ targetPath }`): `cachedRead` → `extractUrls` →
  canonicalize → for each X status not already materialized (probe), enqueue
  `x_metadata_fetch { statusId, url, sourcePaths:[targetPath] }`; `ctx.throwIfAborted()`
  per item, paced enqueue (sweep exemplar `YoutubeChannelEnrichSweepWorkflow.ts:54-57`).
- `jobTypeConfig.ts`: `xMetadataFetchJobConfig` — `persistence:'db'`, dedupeKey
  `status:<statusId>`, `terminalRetentionMs: 60_000`, `minIntervalMs: 1000` (politeness;
  unauthenticated endpoint), `services: [SERVICE_X_OEMBED]`, `maxParallel: 1`.
  `xPostDiscoverJobConfig` — `durableJobConfig(p => note:<targetPath>)`, no services.
- Registration in `main.ts` `registerJobTypes()` **inside the existing single try/catch**
  (`main.ts:788-810`; orchestration `AGENTS.md:25`). `TRIGGER_WORKFLOW_LABELS`
  (`settings/sections/triggers.ts:16-23`) += both; `ROUTINE_NOTICE_JOB_TYPES`
  (`orchestrationQueue.ts:16-34`) += `x_metadata_fetch`. No `isWorkflowEnabled` case
  (enabled-by-default, like most types). `feedSeenExtraSkipPrefixes`
  (`utils/feedIntake.ts:122-128`) += the X metadata root for both source kinds
  (metadata notes are not captures — `AGENTS.md:49` treatment for a third root).
- Tests: workflow suite on the esbuild-bundle + `requestUrl` global-responder pattern
  (done/deferred/tombstone/stamping paths), dedupe-key units, discover
  extraction+skip+enqueue, event-emission guard, structural pin: no `...result` spread.
Files: `orchestration/types.ts`, `workflows/{XMetadataFetchWorkflow,XPostDiscoverWorkflow}.ts`
(new), `jobTypeConfig.ts`, `events.ts`, `main.ts` (registration lines only),
`settings/sections/{triggers,orchestrationQueue}.ts` (list entries only),
`utils/feedIntake.ts`, tests. NOT in scope: triggers, backfill, dashboard, settings UI.

**WP-XM3 — live discovery trigger + registry backfill + commands.**
*~0.35 kSLOC · ~190k tokens · ~15 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent*
- Founding trigger `x-discover-on-clip` added to the founding list (`main.ts:461-495`):
  events `create` + `modify`, sync guard = markdown file whose path is under
  `settings.ingestionClipperInboxFolder` (prefix match) AND new setting
  `ingestionXAutoDiscoverEnabled` (default **false**; source-enable axis — per-type
  autorun remains the separate execution axis). Trigger returns
  `{ type:'x_post_discover', params:{ targetPath } }` descriptors — TriggerRegistry
  already supplies debounce, path re-resolution, note-lock/materializing bail, and
  enqueue-only semantics; no inline network or reads in the handler.
- `XBackfillWorkflow` (`x_metadata_backfill`; fixed dedupe key `'x-metadata-backfill'`,
  no services — the `image-describe-backfill` config shape, `jobTypeConfig.ts:248-256`):
  walk vault files under `orchestrationLinkRegistryRoot`, frontmatter
  `type === 'link-record'`, status from `x-status-id` key or `canonical_url` via
  `xPost.ts`; skip already-materialized via the probe; map record `source_notes`
  wikilinks → existing note paths for `sourcePaths`; enqueue `x_metadata_fetch` paced
  (chunk 10 / 200 ms), `throwIfAborted` per item; counts in `result.notes`. (Registry-only
  by design: `link_scan` is manual, so backfill coverage = what the user has scanned;
  the trigger covers new clips. Documented in the settings copy.)
- Commands (`registerCrucibleCommand`, group `'Orchestrations'`):
  `orchestrator-enqueue-x-backfill` (palette → `enqueueAndRun` high/user), and
  `x-discover-post-links` — **also registered as a chain internal command** taking
  optional `targetFile` (awaited, boolean-returning; the chain-step quirk in root
  `AGENTS.md`) that enqueues discover for the target/active note.
- `JobType` union += `x_metadata_backfill`; registration line inside the try/catch;
  `TRIGGER_WORKFLOW_LABELS` entry.
- Tests: trigger guard/seed units (adapter-level), backfill selection/skip/pacing with a
  fake vault, command internal-registration structural pin.
Files: `main.ts` (trigger block + command registration), `workflows/XBackfillWorkflow.ts`
(new; or co-located with discover), `jobTypeConfig.ts` (one config), `commands.ts`,
`internalCommands.ts`, `orchestration/types.ts` (one member), `src/types.ts` (setting
decl/default), tests. NOT in scope: dashboard, settings UI panels.

**WP-XM4 — dashboard section + settings UI.**
*~0.35 kSLOC · ~190k tokens · ~15 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent*
- New section `xPosts` ("X posts"), factory-shaped (`createXPostsSection(host)`, exemplar
  `missingAttachments.ts`): rows = X statuses from the link registry ∪ materialized
  `_x_metadata` notes; columns: status id, author (when materialized), state
  (materialized / unavailable / pending), source-note count; per-row Fetch button
  (`enqueueAndRun('x_metadata_fetch', …, high/user)`); heading button "Backfill from
  registry". Pills per fleet taxonomy: `pending`/counts neutral (`is-muted`);
  `unavailable` a warn status pill (it is a semantic state); compute rows before DOM;
  `rowKey` = statusId; signature via `computeRowSignature`.
- Wiring (the 4 mechanical edits + signature key): `SectionId` union
  (`ingestion/render/types.ts:8-23`); **`SCAN_SECTIONS`** (`ingestionDashboard.ts:68-71`);
  constructor + `mount()` `buildSection` + `refreshAll()` + `renderSection()` switch
  case; `route()` prefix for `orchestrationXMetadataRoot` → `markDirty('xPosts')`
  (exemplar `:300-303`); frontmatter signature list at `:397` += `fm['x-metadata']`,
  `fm['x-status-id']`; bus `x-metadata-enriched` → `markDirty('xPosts')` (exemplar
  `:374`).
- Settings UI (`settings/sections/orchestrationIngestion.ts`): X metadata root input
  (`.pi-width-normal`, FolderSuggest), "Auto-discover X links in clipper inbox" toggle
  (binds `ingestionXAutoDiscoverEnabled`; copy notes backfill covers only scanned
  registry records). Queue Configuration rows appear automatically
  (`queueControls.ts:44` iterates registered types). Queue Monitor title switch case for
  `x_metadata_fetch` (`queueMonitor.ts:141`).
- Obsidian semantic vars only; no `--n1-*`; destructive controls: none (no deletes in v1).
- Tests: row-compute units (registry+notes merge, states), structural pins for the
  signature-list and route additions.
Files: `ingestion/sections/xPosts.ts` (new), `ingestion/data/xPosts.ts` (new, pure
row-compute), `ingestion/render/types.ts`, `ingestionDashboard.ts`,
`settings/sections/orchestrationIngestion.ts`, `ingestion/sections/queueMonitor.ts`
(one case), `styles.css` (minimal), tests.

**WP-XM5 — docs close (orchestrator-direct).**
*~0.05 kSLOC docs · ~30k tokens · ~5 min wall · top (orchestrator) · Claude: direct
(must-direct: integration/gates/commit duty); Codex: direct (same)*
- `src/orchestration/AGENTS.md`: quirk entries — statusId is the X identity and dedupe
  base; discover/fetch split; tombstone-as-done semantics; `x-oembed` breaker never
  opened by unavailable posts; `x-metadata` stamping order (ensure before note lock).
  Root `AGENTS.md` quirks-index line touch-up.
- Plan completion note; deregister from `pending-plans`; ledger actuals per WP; hand the
  user a live-validation checklist (clip with an X link → note appears + stamp; backfill;
  tombstone on a dead status; Queue Config rows).

## Public Interfaces

- Job types: `x_metadata_fetch`, `x_post_discover`, `x_metadata_backfill`.
- Bus event: `x-metadata-enriched`.
- Settings: `orchestrationXMetadataRoot` (`'_x_metadata'`), `ingestionXAutoDiscoverEnabled`
  (false).
- Frontmatter: metadata-note schema above; source notes gain `x-metadata` (list of
  wikilinks); link records gain `x-status-id`.
- Breaker id: `'x-oembed'`. Resource lock: `x-post::<statusId>`.
- Commands: `orchestrator-enqueue-x-backfill`, `x-discover-post-links` (internal too).

## Execution

Wave 1: XM1 (everything imports it). Wave 2: XM2. Wave 3: XM3 ∥ XM4 (disjoint files —
XM3 owns `main.ts`/`commands.ts`, XM4 owns dashboard/settings). XM5 orchestrator-direct.
One worker worktree per WP branched from local master tip; workers never commit; the
orchestrator copies the report out FIRST, reviews the full diff, re-runs all six gates
verbatim, commits `(subagent xm-N)`, rebases, ff-merges. **Ask the user which subagents
to spawn before each wave.** Token bands already include the ~150–160% calibration pad
measured on this repo's Sonnet briefs.

## Test Plan / Verification

Per landing, the six gates verbatim: `npm run lint`; `npx tsc -noEmit -skipLibCheck`;
`npm test` (floor **1390/109**, count only grows); `node esbuild.config.mjs production`;
`grep -rna --include='*.ts' "console\." src/` → only `src/log.ts`; per touched file
`file` reports text + `LC_ALL=C grep -caP '\0'` exits 1. Acceptance (findings doc §Initial
acceptance test, status `2078296458122645635`): x/twitter/query variants → one identity;
concurrent dedupe; fixture-driven fetch; no script persisted; deterministic `_x_metadata`
path + frontmatter; body contains the two probe phrases; rerun → no duplicate; backfill
converges on the same note. Live validation (user, `npm run dev` hot-reload): checklist in
XM5.

## Critical Files

`src/orchestration/utils/{xPost,xApi}.ts` (new), `utils/urlCanonicalize.ts`,
`workflows/{XMetadataFetchWorkflow,XPostDiscoverWorkflow,XBackfillWorkflow}.ts` (new),
`jobTypeConfig.ts`, `orchestration/types.ts`, `events.ts`, `serviceHealth.ts`,
`main.ts`, `src/types.ts`, `ingestionDashboard.ts`, `ingestion/sections/xPosts.ts` (new),
`settings/sections/orchestrationIngestion.ts`, `tests/fixtures/x-oembed-panda.json` (new).

## Assumptions

- oEmbed remains keyless and CORS-irrelevant under `requestUrl` (Electron main-process
  request); rate limits are handled by breaker + `minIntervalMs`, not backoff config.
- `omit_script=true` is honored; the `<script>` strip is defense in depth.
- No lint `derive-source-ids` change (no `x-status-id` singular derivation on ordinary
  notes) in v1 — the identity lives on metadata notes and link records only.
- Thread/quote/reply reconstruction, media localization of post images, refresh command,
  and presentation UX are explicit non-goals (findings doc §Non-goals).
- The user may enable the auto-discover trigger after live validation; it ships
  default-off.

**Total ≈ 1.75 kSLOC, ~830k raw tokens; ~720k Claude-path / ~525k Codex-path
Opus/Sol-equivalent tokens.**

## Completion (2026-07-31)

Implemented and landed on master, one commit per WP, all subagent-executed (Sonnet)
except XM5 (orchestrator-direct):

- **XM1** `e3ef027` — xPost.ts/xApi.ts, canonicalizeUrl X branch, `x-status-id` on link
  records, `SERVICE_X_OEMBED`, `orchestrationXMetadataRoot`. Tests 1432/111.
- **XM2** `0c9f3ab` — `x_metadata_fetch`/`x_post_discover` workflows, `x-metadata` list
  stamping (ensure-then-stamp lock order), `x-metadata-enriched` event, configs +
  registration, feed seen-set skip prefixes. Tests 1459/115.
- **XM3** `a40394f` — `x-discover-on-clip` founding trigger (pure guard helper),
  `XBackfillWorkflow` (`x_metadata_backfill`), palette + chain-internal commands,
  `ingestionXAutoDiscoverEnabled` (default off). Tests 1489/118.
- **XM4** `0d0b363` — X posts dashboard section (pending-first keyed table, per-row
  Fetch, Backfill button), settings UI (folder + auto-discover toggle), queue-monitor
  titles. Tests 1522/121.
- **XM5** — this note + quirk entries in `src/orchestration/AGENTS.md` and the root
  quirks index; `pending-plans` deregistered.

Deviation from the Execution section: Wave 3 ran **sequentially XM3 → XM4** (not
parallel) — XM4's Backfill button needs XM3's `x_metadata_backfill` union member and
its settings toggle binds XM3's `ingestionXAutoDiscoverEnabled` declaration, so the
plan's disjoint-files claim didn't hold at the type level. Actuals: ~630k worker tokens
vs ~830k raw estimate (XM1 190k/230k, XM2 247k/220k, XM3 191k/190k, XM4 191k/190k).

Deferred by design (unchanged): presentation UX, thread/quote reconstruction, media
localization of post images, manual refresh command, lint derive-source-ids for X.
