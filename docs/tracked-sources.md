# Tracked Sources

Crucible tracks YouTube channels and blog feeds from markdown registry notes. The tracker commands read those tables, fetch RSS feeds, compare items against vault metadata, and write intake notes under `_crucible/orchestration/...`.

## YouTube Channels

The YouTube tracker reads the configured channels note. If the note does not exist, the tracker creates an example registry and stops so you can fill it in.

Required columns:

| Column | Required | Values |
|---|---:|---|
| `Channel` | Yes | Display name used in intake headings. |
| `ID` | Yes | YouTube channel ID beginning with `UC`. |

Optional columns:

| Column | Values |
|---|---|
| `Tags` | Comma-separated tags. Empty is allowed. |
| `Priority` | `high`, `normal`, `low`, `skip`, or `ignore`. Empty defaults to `normal`. `skip` and `ignore` exclude the row. |

Example:

```markdown
| Channel | ID | Tags | Priority |
|---------|----|------|----------|
| Example Name | UCxxxxxxxxxxxxxxxxxxxxxx | ai, research | normal |
```

The tracker fetches `https://www.youtube.com/feeds/videos.xml?channel_id=<ID>`. Rows without a channel name, without an ID, or with an ID that does not start with `UC` are ignored.

## Tracked Blogs

The Blogs tracker reads the configured blogs note. If the note does not exist, the tracker creates an example registry and stops so you can fill it in.

Required columns:

| Column | Required | Values |
|---|---:|---|
| `Name` | Yes | Display name used in intake headings and metadata notes. |
| `Link` | Yes | RSS/Atom feed URL. Raw URL, markdown link, and `<angle-bracket>` URL forms are accepted. |
| `Method` | Yes | `RSS`. Other values are reported as skipped rows. |

Optional columns:

| Column | Values |
|---|---|
| `Tags` | Comma-separated tags. Empty is allowed. |
| `Priority` | `high`, `normal`, `low`, `skip`, or `ignore`. Empty defaults to `normal`. `skip` and `ignore` exclude the row. |
| `Canon` | `auto`, `substack`, `strip-params`, or `keep-params`. Empty defaults to `auto`. |
| `Body` | `auto`, `full`, or `snippet`. Empty defaults to `auto`. |

Example:

```markdown
| Name | Link | Method | Tags | Priority | Canon | Body |
|------|------|--------|------|----------|-------|------|
| Example Blog | https://example.com/feed.xml | RSS | research | normal | auto | auto |
```

Invalid blog rows do not fail the whole run. They are written into the intake note under `Skipped registry rows` with the reason.

## Seen-Item Detection

YouTube runs mark videos seen from:

- `yt-video-id` in note frontmatter
- YouTube video URLs in a note's `source` field
- `yt-video-ids` in intake notes when diff mode is enabled

Blog runs mark posts seen from:

- `post-id` in note frontmatter
- canonicalized `source` URLs
- `post-ids` in intake notes when diff mode is enabled

Tracker intake folders and orchestration queue folders are skipped during normal vault scans so intake files do not accidentally count as captured notes unless diff mode explicitly uses intake IDs.

## Canon and Body Behavior

`Canon` controls how a blog post URL becomes a stable `post-id`:

- `auto`: detect known platforms such as Substack and otherwise strip only known tracking params.
- `substack`: force Substack-style `/p/<slug>` canonicalization.
- `strip-params`: drop all query params and hash.
- `keep-params`: keep query params except the hash and trailing slash cleanup.

Use `keep-params` when a site uses a query parameter as the actual article ID.

`Body` controls whether fetched post bodies become ingestable metadata notes:

- `auto`: use full body only when a dedicated content element exists.
- `full`: trust any feed body or summary element.
- `snippet`: never ingest the body; keep metadata/read tracking only.

Blog metadata notes are written under the configured blog metadata root and include `source`, `post-id`, `blog`, authors, published date, word count, categories, kind, body availability, and fetch metadata.
