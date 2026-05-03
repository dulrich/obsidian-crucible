# Orchestrator — Link Registry (Plan 5)

## Context

The YouTube tracker (plan 3) intentionally only deduped against `youtube-id` and `source` frontmatter, deferring body-URL discovery to a future "Recommended/Linked Content" worker. This plan IS that worker, generalized: a vault-wide scanner that extracts every external URL, canonicalizes it, and creates one link-record note per canonical URL under `_crucible/link_registry/` (configurable). Records carry state (pending/ingested/rejected/ignored/broken/duplicate), provenance (`source_notes` wikilinks), and a `tracked_source` flag for URLs that look like ongoing sources (YouTube channels in v1; arXiv author / GitHub / RSS / podcast / Substack deferred).

Single new orchestrator workflow: `link_scan`. Same pattern as `daily_brief_lite` / `youtube_tracker` / `transcript_refine`.

**Depends on:** Plan 1 (core).

## Decisions locked in

| Topic | Decision |
|---|---|
| v1 surface | Discovery + record only. No promotion command, no state-change commands. State edits via YAML / Bases. |
| Scan scope | Whole vault except a configurable exclusion list. Setting `orchestrationLinkScanExclusions: string[]` (default `["_crucible"]`); user adds more. |
| YouTube integration | Link records for YouTube watch URLs include `youtube-id: VIDEO_ID` in frontmatter. The existing youtube_tracker auto-dedupes against them — no changes needed there. |
| Tracked sources storage (deferred) | Single configurable **note** containing a markdown table with columns `Base URL | Description | Date Added`. Setting `orchestrationTrackedSourcesNote` (default `Sources/Tracked Sources.md`). v1 only adds the setting and documents the format; promote command in v2. |
| Tracked-source candidate detection (v1) | Only YouTube channel / handle / user / c URLs flagged as candidates. Other patterns deferred. |
| `tracked_source` model | Three-value enum on the link record: `false | candidate | promoted`. Promotion (v2) appends a row to the tracked-sources note and sets `tracked_source: promoted` + `tracked_source_note` wikilink. |
| Filename strategy | Human-readable slug from canonical URL; collision suffix `-XXXX` if needed. |

## `link-record` schema (v1)

```yaml
---
type: link-record
url: "https://example.com/article"
canonical_url: "https://example.com/article"
domain: "example.com"

state: pending
# pending | ingested | rejected | ignored | broken | duplicate

source_notes:
  - "[[Clippings/2026-05-02 Some Note]]"

first_seen: 2026-05-02
last_seen: 2026-05-02

discovery_method: scan
# scan | manual

tracked_source: false
# false | candidate | promoted
tracked_source_type: null
# youtube-channel (more later)
tracked_source_note: null

referred_material: null
decision_reason: null

# YouTube-specific: lets the existing youtube_tracker workflow auto-dedupe
youtube-id: null
---
```

**Auto-managed fields** (overwritten on every scan): `last_seen`, `source_notes` (merged with existing), `domain`, `canonical_url`, `url`, `youtube-id` (set if YouTube watch URL detected and currently null/empty), `tracked_source_type` (only when promoting `false`→`candidate`).

**User-owned fields** (preserved on re-scan if already set): `state`, `decision_reason`, `referred_material`, `tracked_source` (only the transitions `false`→`candidate` are auto; `candidate`→`promoted` and any → `rejected`/etc. are user-only), `tracked_source_note`, `first_seen` (only set on first creation).

## Tracked-sources note format (documented; written by v2 promote)

```md
| Base URL | Description | Date Added |
|----------|-------------|------------|
| https://www.youtube.com/@DrJonathanTam | Dr Jonathan Tam (YouTube channel) | 2026-05-02 |
```

Reuse the existing `parseTable` utility (`src/orchestration/utils/markdownTable.ts`) when the v2 promote command lands.

## Folder layout

```
_crucible/link_registry/
  youtube.com__watch__abc123.md
  arxiv.org__abs__2501.12345.md
  github.com__owner__repo.md
```

Filename derivation (from canonical URL):
- Drop scheme.
- Lowercase the result.
- Replace `/`, `?`, `&`, `=` with `__`.
- Strip everything outside `[A-Za-z0-9._\-@]` (keep `@` for YouTube handles, `.` for hostnames, `-` and `_` for slugs).
- Truncate at 100 chars. If truncation occurs OR a file already exists at that path with a different `canonical_url` in frontmatter, append `-XXXX` (4-char hex hash of the canonical URL).

## Canonicalization (v1, conservative)

- Reject anything that isn't `http://` or `https://`. (Skip `mailto:`, `obsidian://`, etc.)
- Lowercase scheme + host.
- Strip fragment (`#anchor`). Documented limitation: GitHub line refs `#L123` lost; acceptable for v1.
- Remove tracking params: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `fbclid`, `gclid`, `ref`, `ref_src`, `mc_cid`, `mc_eid`.
- Keep all other query params in their original order.
- Strip trailing slash from non-root paths.
- Site-specific normalization:
  - `youtu.be/X` → `https://www.youtube.com/watch?v=X`
  - `youtube.com/shorts/X` → `https://www.youtube.com/watch?v=X`
  - `youtube.com/watch?v=X&list=...&t=...` → `https://www.youtube.com/watch?v=X` (drop everything but `v`)
  - `arxiv.org/pdf/X` and `arxiv.org/pdf/X.pdf` → `https://arxiv.org/abs/X`
- GitHub repo-root canonicalization (`/owner/repo/...` → `/owner/repo`) deferred.

## Tracked-source candidate detection (v1)

A canonical URL counts as a YouTube channel candidate if its host is `youtube.com` (or `www.youtube.com`) AND its path matches one of:
- `/@handle`
- `/c/CName`
- `/user/UName`
- `/channel/UC...`

When detected, set on the link record:
- `tracked_source: candidate` (only if currently `false`; never demote `promoted`/`rejected` etc.)
- `tracked_source_type: youtube-channel`

## Files to add

```
src/orchestration/utils/urlExtract.ts
src/orchestration/utils/urlCanonicalize.ts
src/orchestration/workflows/LinkScanWorkflow.ts
```

## Files to modify

- `src/types.ts` — three new settings keys + defaults:
  - `orchestrationLinkRegistryRoot: string` (default `_crucible/link_registry`)
  - `orchestrationLinkScanExclusions: string[]` (default `["_crucible"]`)
  - `orchestrationTrackedSourcesNote: string` (default `Sources/Tracked Sources.md`; setting only — unused by v1 logic)
- `src/orchestration/types.ts` — add `'link_scan'` to `JobType`.
- `src/settings.ts` — three new fields under the Orchestrator tab (text + textarea + file-suggest).
- `src/main.ts` — register workflow + add `orchestrator-enqueue-link-scan` command.

## Implementation details

### `src/orchestration/utils/urlExtract.ts`

```ts
export interface ExtractedUrl {
  raw: string;
  context?: string; // optional: line snippet, used only for debug
}

export function extractUrls(content: string): ExtractedUrl[];
```

Approach:
- First strip code fences (` ```...``` ` and `~~~...~~~`) and inline code spans (single `` ` ``) so we don't pick up URLs from code samples.
- Then strip Obsidian wikilinks (`[[...]]`) — internal references, never external.
- Then run two regexes in order:
  1. Markdown link: `\[(?:[^\]]*)\]\((https?:\/\/[^\s)]+)\)` — captures the URL only.
  2. Bare URL: `\b(https?:\/\/[^\s<>"'`)\]]+)` — applied to text not already matched by #1.
- Trim trailing punctuation (`.`, `,`, `;`, `:`, `)`, `]`, `'`, `"`) from each matched URL.
- Dedupe within a single note (set of raw URLs) before returning.

### `src/orchestration/utils/urlCanonicalize.ts`

```ts
export interface CanonicalizedUrl {
  url: string;          // the raw input, trimmed
  canonical: string;    // canonical URL string
  domain: string;       // lowercased host (no www. stripping in v1)
  filename: string;     // slug for the .md file (no extension)
  youtubeVideoId?: string;
  trackedSource?: { type: 'youtube-channel'; canonical: string };
}

export function canonicalizeUrl(raw: string): CanonicalizedUrl | null;
```

- Use `new URL(raw)`. On parse error, return `null`.
- Reject non-http(s).
- Apply the canonicalization rules listed above.
- Detect YouTube watch → set `youtubeVideoId`.
- Detect YouTube channel pattern → set `trackedSource`.
- Compute filename slug per the rules above.

Helper: `slugForCanonical(canonical: string): string` exported for testing.

### `src/orchestration/workflows/LinkScanWorkflow.ts`

```ts
export class LinkScanWorkflow implements Workflow {
  async run(job, ctx) { ... }
}
```

Steps:

1. **Resolve exclusions and registry root** from settings.
2. **Iterate vault markdown files.** For each `file` in `app.vault.getMarkdownFiles()`:
   - Skip if `file.path` starts with any exclusion prefix OR equals/starts-with the link-registry root.
   - Skip if frontmatter `type === 'link-record'` (don't scan our own records).
   - Read file content (use `cachedRead` for performance).
   - Extract URLs via `extractUrls`.
   - Canonicalize each. Group raw URLs by canonical key (so multiple `?utm=` variants merge).
3. **Build aggregate map** `canonical → { canon, sourceWikilinks: Set<string> }`. Wikilink format: `[[${file.path.replace(/\.md$/, '')}]]`.
4. **Apply to registry.** For each `(canonical, info)`:
   - Compute `targetPath = ${root}/${canon.filename}.md`.
   - If file exists:
     - Read its frontmatter via `metadataCache`. Confirm `type === 'link-record'` and `canonical_url === canonical`. If `canonical_url` differs (collision), reslug with hash suffix and retry.
     - Update via `processFrontMatter`: refresh `last_seen`; merge `source_notes` (preserving order, dedupe by string); refresh `domain`, `canonical_url`, `url`; set `youtube-id` if currently null/empty AND we have one; transition `tracked_source: false → candidate` if applicable; do NOT touch `state`, `referred_material`, `decision_reason`, `tracked_source_note`, `first_seen`.
   - If file does not exist:
     - Create with full frontmatter via `vault.create` + `processFrontMatter`.
     - Body is a minimal stub: `# Link: ${url}\n\n## Notes\n`.
5. **Return `WorkflowResult`** with `outputPaths` = list of created/updated record paths and `notes` like `Scanned 142 notes; touched 87 records (38 new, 49 updated); 4 candidates flagged.`

Design notes:
- All file writes go through `processFrontMatter` (safe YAML mutation).
- We do NOT delete records that are no longer referenced anywhere — they persist with their last `last_seen`. (Garbage collection deferred.)
- For very large vaults, the entire scan happens in-memory; rough sizing: 10,000 notes × avg 5 URLs = 50,000 URLs is fine. If we ever need to chunk, `runNext` is already sync per-job so we'd just split into multiple jobs.

### Settings additions (`src/settings.ts`)

In `renderOrchestrationSettings`, after the YouTube channels note field, add a "Link registry" subsection:

- Text: `Link registry root` → `orchestrationLinkRegistryRoot`.
- Textarea: `Scan exclusions` (one path per line) → `orchestrationLinkScanExclusions`. Same pattern as the existing `lintIgnoredFolders` textarea.
- File suggest: `Tracked sources note` → `orchestrationTrackedSourcesNote`. Annotated with "(unused in v1; will hold promoted tracked sources)".

### Command (`src/main.ts`)

```ts
this.addCommand({
  id: 'orchestrator-enqueue-link-scan',
  name: 'Orchestrator: enqueue link scan',
  callback: () => { void this.orchestrator.enqueue('link_scan'); },
});
```

And register the workflow next to the other three:
```ts
this.orchestrator.register('link_scan', new LinkScanWorkflow());
```

## Verification

1. `npm run build` clean.
2. **Fresh scan, two URLs:** drop a clipping with two markdown links into `Clippings/`. Enqueue + run → two records appear in `_crucible/link_registry/`, both `state: pending`, `source_notes` contains the wikilink, `first_seen` and `last_seen` set to today.
3. **Re-scan adds a third link:** add a third URL to the same clipping. Re-run → the original two records keep their `first_seen`; their `last_seen` refreshes; the third record is created.
4. **User edits preserved:** in one record, manually set `state: ingested` and `referred_material: "[[Sources/Foo]]"`. Re-run → those fields remain. `last_seen` and `source_notes` may still update.
5. **Canonicalization merge:** include both `https://example.com/article?utm_source=newsletter` and `https://example.com/article` in a note. Re-run → ONE record, `canonical_url` = `https://example.com/article`.
6. **Source note merge:** reference the same URL from two different notes. Re-run → ONE record with both wikilinks in `source_notes`.
7. **YouTube watch URL:** include `https://youtu.be/dQw4w9WgXcQ` somewhere. Re-run → record at `_crucible/link_registry/youtube.com__watch__v_dQw4w9WgXcQ.md` (or similar slug) with `canonical_url: https://www.youtube.com/watch?v=dQw4w9WgXcQ` and `youtube-id: dQw4w9WgXcQ`.
8. **YouTube tracker integration:** with the record from #7 in place, run the YouTube tracker (with a channel that uploaded that video). Confirm the video does NOT appear in the new-videos intake (deduped via the registry's `youtube-id`).
9. **Tracked-source candidate:** include `https://www.youtube.com/@SomeHandle` in a note. Re-run → record has `tracked_source: candidate` and `tracked_source_type: youtube-channel`.
10. **Excluded folder:** add a clipping under `_crucible/test/` with a URL. Re-run → no record created (default exclusion).
11. **Self-exclusion:** records under `_crucible/link_registry/` are not themselves scanned (no infinite loop adding their own `url:` value).
12. **Code-fence safety:** include `` `https://example.com/in-code` `` in a note (inline-code). Re-run → no record for that URL.
13. **Wikilink ignored:** include `[[Sources/Foo]]` in a note. Re-run → no link record (internal reference).

## Out of scope (deferred)

- `Promote tracked-source candidate` command (v2). Will append a row to the tracked-sources note and update the link record's `tracked_source: promoted` + `tracked_source_note`.
- State-change commands (`Mark as ingested/rejected/ignored`).
- arXiv author / category, GitHub repo, RSS / podcast feed candidate detection.
- YouTube handle → channel ID resolution.
- GitHub repo-root canonicalization.
- Garbage collection of records whose `source_notes` become empty.
- Spider / crawler that fetches the URL, classifies content, and proposes ingestion.
- Bases templates (document the recommended filters in the README later).
