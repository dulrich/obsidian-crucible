Use this as a Claude prompt:

````markdown
# Task: Design and implement a Link Registry / Referred Material tracker for Crucible + Obsidian

We need to design and implement a vault workflow for tracking external links discovered in Clippings/source notes, deciding whether each link should be ingested, rejected, ignored, or deferred, and connecting ingested links to the resulting vault note.

This should be implemented inside the Crucible plugin where appropriate, likely as a TypeScript feature with commands and/or background indexing.

## Context

The vault has source notes such as:

- `Clippings/...`
- daily notes
- manually created source notes
- eventually automated crawler outputs
- YouTube channel tracker notes
- paper/PDF/arXiv material

We want a durable, auditable system that answers:

- Where did this external link first appear?
- Which notes mention it?
- Has it already been ingested into the vault?
- Was it rejected from spidering?
- Was it manually reviewed?
- What local note represents the ingested target?
- Is this URL part of a tracked source, like a YouTube channel, RSS feed, paper source, or other periodically monitored source?

## Core concept

Create a structured **Link Registry** where each external URL has a corresponding Markdown note.

Example folder:

```text
_link_registry/
  youtube.com__watch__abc123.md
  arxiv.org__abs__2501.12345.md
  example.com__article-slug.md
````

Each registry note should contain YAML frontmatter similar to:

```yaml
---
type: link-record
url: "https://example.com/article"
canonical_url: "https://example.com/article"
domain: "example.com"

state: pending
# pending | queued | ingested | rejected | ignored | broken | duplicate

source_notes:
  - "[[Clippings/2026-05-02 Research Rabbit Hole]]"

first_seen: 2026-05-02
last_seen: 2026-05-02

discovery_method: clipping
# clipping | manual | daily-note | crawler | import | youtube-tracker | rss-tracker | other

ingestion_method: null
# manual | clipper | crawler | pdf | arxiv | youtube | rss | other

referred_material: null
# link to local note created from the target, e.g. "[[Sources/example-com-article]]"

decision_reason: null
reject_reason: null

tracked_source: false
tracked_source_note: null
tracked_source_type: null
# youtube-channel | rss-feed | website | arxiv-author | arxiv-query | github-repo | other

canonical_of: null
content_hash: null
last_checked: null
---
```

## Important distinction

Separate these concepts:

```text
source_notes
  Notes where the URL was discovered or mentioned.

url / canonical_url
  The external target.

referred_material
  The vault note that represents the ingested target content.

discovery_method
  How the URL entered the system.

ingestion_method
  How the target content became a vault note.

tracked_source
  Whether this URL points to something that should itself become a monitored source.
```

Example:

```yaml
---
type: link-record
url: "https://arxiv.org/abs/2501.12345"
source_notes:
  - "[[Clippings/2026-05-02 AI Reading List]]"
state: ingested
discovery_method: clipping
ingestion_method: arxiv
referred_material: "[[Papers/2501.12345 - Paper Title]]"
tracked_source: false
---
```

Example where the URL becomes a tracked source:

```yaml
---
type: link-record
url: "https://www.youtube.com/@DrJonathanTam"
canonical_url: "https://www.youtube.com/@DrJonathanTam"
domain: "youtube.com"

state: ingested
discovery_method: clipping
ingestion_method: manual
referred_material: "[[Sources/YouTube/Dr Jonathan Tam]]"

tracked_source: true
tracked_source_type: youtube-channel
tracked_source_note: "[[Tracking/YouTube/Dr Jonathan Tam]]"
---
```

## Tracked source mechanism

We need a mechanism for detecting links that should become **tracked sources**.

This should be similar in spirit to the existing YouTube channel ID tracker pattern.

The plugin should identify links that are not just one-off references but potentially ongoing sources, such as:

* YouTube channel URLs
* YouTube handles
* RSS feed URLs
* Substack/publication homepages
* arXiv author/search/category feeds
* GitHub repositories
* blogs or sites that publish recurring material
* podcast feeds
* documentation sites

When such a link is detected, the system should either:

1. mark the link record as `tracked_source: candidate`, or
2. create/update a corresponding tracked source note.

Suggested tracked source note structure:

```yaml
---
type: tracked-source
source_type: youtube-channel
url: "https://www.youtube.com/@DrJonathanTam"
canonical_url: "https://www.youtube.com/channel/UC..."
source_id: "UC..."
title: "Dr Jonathan Tam"
state: active
# candidate | active | paused | rejected | broken

discovered_from:
  - "[[_link_registry/youtube.com__@DrJonathanTam]]"

first_seen: 2026-05-02
last_checked: null
last_successful_check: null

polling_method: youtube-rss
polling_url: "https://www.youtube.com/feeds/videos.xml?channel_id=UC..."
polling_frequency: weekly
---
```

For YouTube specifically, we already have or want a mechanism like:

```bash
youtube-id https://www.youtube.com/@DrJonathanTam
```

which resolves a handle/channel URL to a `UC...` channel ID. The tracked-source mechanism should reuse or mirror this logic.

## Desired behavior

### Command 1: Scan notes for external links

Create a command such as:

```text
Crucible: Scan clippings for external links
```

Behavior:

1. scan configured folders, initially `Clippings/`
2. extract Markdown links and raw URLs
3. ignore internal Obsidian wikilinks
4. normalize/canonicalize URLs
5. create one link-record note per canonical URL
6. update existing records without overwriting user decisions
7. append source note references
8. update `first_seen` and `last_seen`
9. classify possible tracked sources

### Command 2: Review tracked source candidates

Create a command such as:

```text
Crucible: Detect tracked source candidates
```

Behavior:

1. search link-record notes with `tracked_source` missing/false/candidate
2. detect source-like URLs
3. classify `tracked_source_type`
4. optionally create tracked-source notes
5. for YouTube channels, resolve channel IDs where possible
6. avoid duplication against existing tracked-source notes

### Command 3: Mark as ingested / rejected / ignored

Create commands or UI helpers for changing state:

```text
Crucible: Mark link as ingested
Crucible: Mark link as rejected
Crucible: Mark link as ignored
Crucible: Create referred material note from link
Crucible: Create tracked source note from link
```

The important part is that these commands should update the registry note, not scatter state across unrelated clipping notes.

## Obsidian Bases integration

Bases should be treated as the human review interface, not the storage mechanism.

The actual source of truth should be Markdown/YAML notes.

Create or document suggested Bases for:

```text
Pending links
Queued links
Ingested links
Rejected links
Tracked source candidates
Active tracked sources
Broken links
Duplicate links
```

Example Base concept:

```yaml
filters:
  and:
    - type == "link-record"

views:
  - type: table
    name: Pending
    filters:
      and:
        - state == "pending"

  - type: table
    name: Tracked source candidates
    filters:
      and:
        - tracked_source == "candidate"

  - type: table
    name: Ingested
    filters:
      and:
        - state == "ingested"
```

## Canonicalization requirements

Implement conservative URL canonicalization.

Minimum:

* strip URL fragments unless meaningful
* remove common tracking params:

  * `utm_source`
  * `utm_medium`
  * `utm_campaign`
  * `utm_term`
  * `utm_content`
  * `fbclid`
  * `gclid`
* normalize trailing slash where safe
* lowercase scheme and hostname
* preserve query params that are content-identifying

Special cases:

* YouTube watch URLs should canonicalize by video ID
* YouTube channel/handle URLs should canonicalize to channel ID if resolvable
* arXiv abs/PDF links should canonicalize to arXiv ID
* GitHub repo URLs should canonicalize to owner/repo
* Substack URLs should distinguish publication homepage from individual post

## Non-goals for first pass

Do not build a full crawler yet.

First pass should focus on:

* extracting links
* maintaining registry notes
* tracking state
* identifying tracked-source candidates
* integrating with existing YouTube channel ID tracker pattern
* preserving audit trail

Crawler/spidering can come later.

## Open design questions to grill me on

Please review the design and challenge these assumptions:

1. Should each URL be a note, or should the registry be a single JSON/YAML file?
2. Should `tracked_source` be boolean, enum, or separate note type only?
3. Should tracked source notes live under `Tracking/` or inside `_link_registry/`?
4. Should `referred_material` be required before `state: ingested` is allowed?
5. Should `source_notes` store wikilinks, file paths, or both?
6. How should duplicates and canonicalization conflicts be handled?
7. Should the plugin auto-create notes or only stage candidates for review?
8. How much should be implemented as TypeScript plugin logic versus external scripts?
9. How should this interact with Obsidian Bases, Dataview, and Omnisearch?
10. What is the minimal useful first implementation?

## Expected deliverables

Please produce:

1. a critique of this design
2. a refined schema for `link-record`
3. a refined schema for `tracked-source`
4. a minimal TypeScript implementation plan
5. suggested folder layout
6. command names
7. edge cases
8. a first-pass implementation inside the repo, if feasible

```

I would push Claude especially on whether `tracked_source` should be embedded in the link record or always represented as a separate `tracked-source` note. My bias: use both. The link record should contain a pointer, but the tracked source should get its own note once promoted.
```

