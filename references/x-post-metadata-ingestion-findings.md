# X post metadata ingestion findings

> Research note only. Planning and implementation are intentionally deferred while Crucible is mid-sprint on unrelated work.

## Context

A clipped Digg discussion can contain a link to an X status whose original post is not present in the Digg page DOM. The motivating example is:

<https://x.com/PandaAshwinee/status/2078296458122645635>

Fetching the ordinary `x.com` page returns a client-side shell, but X's official oEmbed endpoint returns the post's useful metadata and HTML without requiring an authenticated X session. The durable problem is therefore:

1. discover supported post links;
2. resolve and materialize their metadata in the vault;
3. associate that materialized post with its source notes;
4. decide separately how Obsidian should present it inline, as an embed, or on hover.

## Confirmed official oEmbed behavior

This request succeeded for the sample post:

```text
https://publish.x.com/oembed?url=https%3A%2F%2Fx.com%2FPandaAshwinee%2Fstatus%2F2078296458122645635&omit_script=true&dnt=true
```

The downloaded response was inspected successfully. It contains:

- provider `X`;
- oEmbed type `rich`, version `1.0`;
- author `Ashwinee Panda`;
- author URL `https://x.com/PandaAshwinee`;
- the canonical status link and numeric status ID;
- the complete post text, including “absurdly information-dense” and “rate-adjacent”;
- the publication date, July 18, 2026;
- no injected script when `omit_script=true` is supplied.

Firefox downloaded the response as `json.json`; the apparent terminal truncation at `omit_script=t` was only display truncation. An implementation can request the endpoint directly and consume the JSON response.

The downloaded response should later be copied into the plugin as a stable test fixture, for example:

```text
tests/fixtures/x-oembed-panda.json
```

Tests should not depend on the current vault-root `json.json`.

## Architectural conclusion

Metadata ingestion should precede presentation:

```text
Clipping create/edit ─────┐
Link-registry backfill ───┼─> canonical X status ─> x_metadata_fetch
Manual refresh later ─────┘                              |
                                                         v
                                  _x_metadata/<handle>/<status-id>.md
```

This follows the existing YouTube metadata pattern while keeping embed, inline, and hover UX decisions out of the ingestion layer.

## Existing Crucible seams to reuse

### YouTube metadata ingestion

`src/orchestration/utils/youtubeApi.ts` already provides the closest reusable pattern:

- `ensureMetadataNote()` performs fetch-on-miss materialization;
- a resource lock prevents concurrent work on the same remote object;
- `ingestYoutubeVideoMetadata()` separately associates the metadata with the source note;
- notes live under `_yt_metadata/<channel>/<video>.md`.

The X implementation should reuse the structure, not couple itself to YouTube-specific parsing or schemas.

### Settled note scheduling

`src/autoLocalizeScheduler.ts` already handles vault create/edit events by:

- coalescing rapid events;
- waiting for the file to settle;
- resolving the file again before work begins;
- respecting note locks.

An X-link discovery trigger should follow this scheduling behavior rather than fetching directly in an Obsidian vault event callback.

### Link registry

`src/orchestration/workflows/LinkScanWorkflow.ts` records one entry per canonical URL with fields including:

- `url`;
- `canonical_url`;
- `domain`;
- `source_notes`;
- `first_seen`;
- `last_seen`;
- `discovery_method`;
- `state`.

`_crucible/link_registry` is therefore the natural source for a backfill. Live clipping and registry backfill should share URL extraction, canonicalization, status-ID parsing, and job deduplication.

### Job infrastructure

Likely integration points include:

- `src/main.ts`;
- `src/orchestration/jobTypeConfig.ts`;
- `src/orchestration/FileJobBackend.ts`;
- `src/orchestration/workflows/YoutubeMetadataFetchWorkflow.ts`;
- `src/orchestration/TriggerRegistry.ts`.

The new work should be an orchestrated job type and use the ingestion event bus, rather than performing network and vault writes directly from a trigger.

## Proposed provider boundary

A small provider contract would leave room for other supported sites without turning the initial work into a general-purpose embed framework:

```ts
interface MetadataProvider {
  id: string;
  match(url: URL): boolean;
  canonicalize(url: URL): CanonicalPost;
  fetch(post: CanonicalPost): Promise<FetchedPost>;
  materialize(post: FetchedPost): Promise<MetadataDocument>;
}
```

The first implementation should support X only:

- accept `x.com` and `twitter.com` status links;
- normalize host, handle, query parameters, and status ID;
- use the numeric status ID as the stable identity;
- call the official oEmbed endpoint with `omit_script=true` and `dnt=true`;
- model unavailable, private, deleted, rate-limited, malformed, and network failures explicitly;
- never persist or execute the returned script or iframe machinery;
- avoid unofficial scraping fallbacks unless future evidence justifies them.

## Metadata note materialization

Candidate path:

```text
_x_metadata/<handle>/<status-id>.md
```

The schema should be settled during planning, but likely frontmatter includes:

- a metadata-note type discriminator;
- canonical source URL;
- status ID;
- provider;
- author display name, handle, and URL;
- published and fetched timestamps;
- oEmbed type and version;
- ingestion or failure state where applicable.

The body can use Obsidian's public native HTML conversion:

```ts
htmlToMarkdown(oembed.html)
```

The public declaration in `node_modules/obsidian/obsidian.d.ts` accepts a `string`, `HTMLElement`, `Document`, or `DocumentFragment`. Prefer the native conversion first and apply only small, deterministic cleanup afterward if fixtures show it is necessary.

## Job identity and concurrency

Deduplication should be per status ID, not per clipping or link occurrence. A resource key such as:

```text
x-post::<status-id>
```

would allow live clipping, registry backfill, and a future manual refresh to converge safely on one metadata note.

Keep discovery and fetching as separate operations:

1. A settled-note scanner extracts supported links and enqueues one job per canonical status.
2. `x_metadata_fetch` resolves and materializes one canonical post.

## Source-note association

The association mechanism is not yet decided. A conservative initial approach is:

- leave clipping bodies unchanged;
- retain source-note provenance in the existing link registry;
- let each link record point to the metadata note, or use a deterministic URL-to-note mapping;
- consider a direct `x-metadata` source-note property later if queries or presentation require it.

Avoid establishing two competing sources of truth in the first version.

## Live trigger and backfill

For live capture:

- scope the trigger to the configured Clippings folder;
- react to create and, optionally, edit;
- wait for the note to settle;
- extract every supported X/Twitter status URL;
- enqueue one job per canonical status ID;
- do no inline network fetch in the vault event handler.

For backfill:

- walk existing link-registry records;
- select canonical X/Twitter status URLs;
- skip already materialized posts unless refresh was requested;
- enqueue the same `x_metadata_fetch` job used by live capture;
- expose cancellation, progress, and partial-completion behavior consistent with other bulk jobs.

## Presentation is a separate design problem

Once the metadata exists locally, possible UX includes:

- native `![[...]]` transclusion;
- a right-click link command to reveal or insert the local post;
- a rendered link card;
- hover preview;
- explicit refresh or removal actions.

These can be planned independently. The first presentation choice should not dictate the ingestion schema.

## Questions for planning

- Should deleted/private posts produce a durable tombstone note or only a failed job?
- What retry and backoff policy should apply to transient failures or rate limits?
- Is metadata an immutable capture-time snapshot, refreshable cache, or both?
- On refresh, is the generated body replaced wholesale or reconciled with user edits?
- How should author renames, changed post HTML, and deleted media be represented?
- Is remote media localization part of this job or a later existing-localizer pass?
- Should provider canonicalization live inside link scanning or in a shared URL layer?
- Is the Clippings-folder trigger always on, configurable, or enabled per job profile?
- Should metadata-note association live only in the link registry or also on source notes?

## Initial acceptance test

Using status `2078296458122645635`:

1. recognize both `x.com` and `twitter.com` variants;
2. canonicalize tracking/query variants to one identity;
3. deduplicate concurrent requests;
4. fetch successfully through official oEmbed;
5. persist no script;
6. write the deterministic `_x_metadata` path;
7. write the expected frontmatter;
8. produce a Markdown body containing “absurdly information-dense” and “rate-adjacent”;
9. rerun without creating a duplicate note;
10. backfill from the link registry to the same note.

## Non-goals for the first work package

- a general web-embed framework;
- loading third-party JavaScript in Obsidian;
- X authentication or paid API integration;
- reconstructing reply, quote-post, or full thread trees;
- final embed/card/hover styling;
- replacing the existing link registry;
- modifying the current unrelated sprint.
