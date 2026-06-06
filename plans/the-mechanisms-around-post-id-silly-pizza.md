# Harden post-id URL canonicalization (Substack email links vs. RSS slugs)

## Context

The user just added several Substack blogs to **Tracked Blogs** using `<domain>/feed`. Links captured
from Substack **email notifications** carry extra query params, e.g.:

- Email: `https://www.emilkirkegaard.com/p/top-universities-and-national-intelligence?publication_id=521681&post_id=200711891&isFreemail=false&r=52ktrf&triedRedirect=true&utm_source=substack&utm_medium=email`
- RSS feed: `https://www.emilkirkegaard.com/p/top-universities-and-national-intelligence` (bare slug)

All post-id derivation and dedup funnels through one function, `postIdFromUrl()`
(`src/orchestration/utils/blogs.ts:200`). It strips only a fixed denylist
(`TRACKING_PARAM_RE`, line 36: `utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `ref`, `ref_src`).
Substack's `publication_id`, `post_id`, `isFreemail`, `r`, `triedRedirect` survive, so the
email-captured `post-id` never equals the RSS bare slug → the already-captured post keeps showing
as uncaptured.

We **cannot** blindly strip all query params: on some sites a param like `article_id` is the real
identifier. The fix must be **platform-aware** (recognize when a slug is canonical and the params are
disposable), with a **per-blog override** for platforms auto-detection misses.

**Why one function is enough:** the feed dedup seen-set is rebuilt every run from each note's `source`
field via `addSourceUrl → postIdFromUrl` (`src/orchestration/utils/feedSources.ts:341`), and the RSS
side derives its id via `postIdFromUrl` too (`blogs.ts:142`/`161`). Fix the canonicalizer and both
sides converge — including notes already captured. No frontmatter backfill needed (decided:
matching-only; stale cosmetic `post-id` values are harmless and `upsertFrontmatterPropertyIfEmpty`
already won't overwrite them).

## Approach

A small, extensible **platform canonicalizer rule table** that `postIdFromUrl` consults, plus an
optional **Canon** override column on the Tracked Blogs table.

### 1. Rule table + Substack rule — `src/orchestration/utils/blogs.ts`

Add near `TRACKING_PARAM_RE`:

```ts
type CanonMethod = 'auto' | 'substack' | 'strip-params' | 'keep-params';

interface CanonRule {
    id: string;                       // e.g. 'substack'
    detect(u: URL): boolean;          // auto-detection by URL shape
    canonicalize(u: URL): string;     // produce the post-id string
}
```

`stripTrailingSlash(s)` helper; reuse for all branches.

**Substack rule** — keys off URL shape so it works for custom domains (emilkirkegaard.com is
Substack-hosted):

- `detect`: `^/p/[^/]+/?$`.test(`u.pathname`) **AND** a Substack signature is present —
  any of `post_id`, `publication_id`, `isFreemail`, `triedRedirect` params, or
  `utm_source === 'substack'`.
- `canonicalize`: drop hash, drop **all** query params, strip trailing slash →
  `` `${u.origin}${u.pathname.replace(/\/$/, '')}` ``.

The RSS bare slug has no params → `detect` returns false → it falls to the default branch which also
leaves it bare and strips the trailing slash. Both sides yield identical `https://host/p/slug`.

### 2. Rewrite `postIdFromUrl(url, opts?)` — `blogs.ts:200`

```ts
export function postIdFromUrl(
    url: string,
    opts?: { method?: CanonMethod; hostRules?: Map<string, CanonMethod> },
): string
```

Resolution order inside the `try`:
1. Determine effective method: `opts.method` if set and not `auto`; else
   `opts.hostRules?.get(u.hostname)`; else `'auto'`.
2. `keep-params` → only drop hash + trailing slash (for sites where params are the id).
3. `strip-params` → drop hash + **all** query + trailing slash.
4. `substack` (forced) → apply the Substack rule's `canonicalize` unconditionally.
5. `auto` → first `CANON_RULES` rule whose `detect` matches wins; otherwise the **existing**
   `TRACKING_PARAM_RE` denylist behavior (unchanged — `article_id` and unknown params preserved).

Default call (no opts) behaves exactly as today **plus** Substack auto-detection. Backward compatible:
all current `postIdFromUrl(url)` call sites keep working.

### 3. Per-blog `Canon` override column

- **Parse** — `parseBlogsTable` (`blogs.ts:38`): add optional `Canon` to the column list passed to
  `parseTable`, and `canon: CanonMethod` to `BlogEntry` (default `'auto'`). Validate against the four
  methods; unknown/empty → `'auto'`. `parseTable` tolerates the missing column for existing tables.
- **Feed side** — thread `entry.canon` through feed parsing so RSS/Atom ids honor a forced method:
  `parseFeed → parseRssItems/parseAtomEntries`, passing `{ method: canon }` into `postIdFromUrl`
  (`blogs.ts:142`, `:161`). Usually a no-op (feeds are already bare) but keeps both sides symmetric.
- **Note/seen side** — build a host→method map from the registry and consult it where notes are
  canonicalized:
  - `buildBlogCanonHostMap(entries): Map<hostname, CanonMethod>` (host of each blog's feed `link`
    where `canon !== 'auto'`).
  - Pass it as `{ hostRules }` into `addSourceUrl`/`postIdFromUrl` in the seen-set ingestion path
    (`feedSources.ts:341`, called from the blogs feed-source `ingestFrontmatterIds`). This is the
    branch that actually makes a forced method match a captured note against its feed.
- **Settings UI / template** — surface the new column in the Tracked Blogs editor and example table
  (`src/settings/sections/orchestration.ts:~474`, example table at `blogs.ts:96`). Documented values:
  `auto` (default), `substack`, `strip-params`, `keep-params`.

`lint.ts` `deriveSourceIdProperties` keeps pure `auto` (no blog context, no override) — its derived
`post-id` is cosmetic; matching correctness lives in the seen-set path above.

### 4. Docs — `AGENTS.md` `## Quirks`

Per repo convention, add a quirk: how post-id canonicalization works, the Substack `/p/<slug>` auto
rule and its signature params, why blind param-stripping is unsafe (`article_id`), and the `Canon`
override column with its four values.

## Critical files

- `src/orchestration/utils/blogs.ts` — rule table, Substack rule, `postIdFromUrl` rewrite,
  `BlogEntry.canon`, `parseBlogsTable`, feed-parse threading, example table.
- `src/orchestration/utils/feedSources.ts` — `addSourceUrl`/seen-set host-rules threading,
  `buildBlogCanonHostMap` (new, or co-located in blogs.ts).
- `src/settings/sections/orchestration.ts` — Tracked Blogs editor column.
- `AGENTS.md` — Quirks entry.
- `tests/postId.test.mjs` — new (below).
- Copy this plan to `plans/` in the repo before implementing (repo convention).

## Verification

New `tests/postId.test.mjs`, modeled on `tests/lint.wordcount.test.mjs` (esbuild-bundle `blogs.ts`,
stub `obsidian` — only `requestUrl` needs stubbing). Run with `npm test`. Assertions:

1. Substack email link → `https://www.emilkirkegaard.com/p/top-universities-and-national-intelligence`.
2. RSS bare slug → unchanged, and **equals** the canonicalized email link (the dedup invariant).
3. Non-Substack URL with `?article_id=123` → param **preserved** (no platform rule matches).
4. Generic `?utm_source=x&utm_medium=y` on a non-Substack URL → still stripped (denylist intact).
5. `keep-params` override preserves all params; `strip-params` override drops all; `substack` override
   reduces `/p/slug?...` even without signature params.
6. `parseBlogsTable` reads the `Canon` column and defaults missing/unknown values to `auto`; existing
   5-column tables still parse.

End-to-end: in the vault, run the blogs feed-tracker over a Substack feed where a `/p/slug` post was
already captured from an email link — it should be recognized as **seen** (no longer surfaced as a new
post) on both the dashboard and the intake workflow.
