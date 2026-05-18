# YouTube Shorts Transcript Cleanup (Version 1)

## Context

YouTube-shorts clippings ingested into the vault arrive in a fixed, machine-generated shape: a YouTube image-embed line, a `## Transcript` header, and a series of paragraphs each prefixed with `**mm:ss** · `. The body also carries non-speech annotations such as `\[music\]`. We want a **deterministic, pure text helper** that recognizes this exact shape and strips the boilerplate, leaving only the spoken text. Anything that doesn't match the shape must be returned unchanged — Version 1 is intentionally conservative so it can be applied broadly without risk of corrupting other note formats. Version 2+ will add more format variants.

Conceptually this is a **lint** operation, but it is dangerous enough that it must **not** run as part of `Lint: all`. It's exposed as its own command (`Lint: cleanup transcript`) that the user invokes deliberately on the active note.

## Scope (Version 1)

### Two layers

**1. Pure text function** — no Obsidian/App dependency, the deterministic core:

```ts
export function cleanupYoutubeTranscript(content: string): string
```

**2. Linter method** — Obsidian-aware wrapper that applies the function to a file:

```ts
async cleanupTranscriptInFile(file: TFile, silent?: boolean): Promise<boolean>
```

Both live in **`src/lint.ts`** alongside the rest of the linting helpers (`calculateWordCount`, `lintFile`, etc.). No new files.

### Pure function behavior

**Returns `content` unchanged** when any of these are true:
- There is non-whitespace content before the YouTube embed line (frontmatter does not count — it's stripped from consideration via the existing `FRONTMATTER_REGEX` from `src/utils.ts` before matching, then re-prepended on output).
- There is non-whitespace content between the embed line and the `## Transcript` header.
- No YouTube embed line is found.
- No `## Transcript` header follows the embed.
- The first non-blank paragraph after `## Transcript` is not a timestamped paragraph.

**When the shape matches**, the function returns:
- Frontmatter (if any) → preserved verbatim
- Embed line and `## Transcript` header → dropped
- The contiguous run of `**mm:ss** · …` paragraphs → cleaned (timestamps stripped, `[music]`-style annotations stripped, intra-paragraph whitespace collapsed), joined by blank lines
- Anything after the timestamped run → passed through unchanged (per Q&A: trailing content is allowed and preserved)

### Linter method behavior (`cleanupTranscriptInFile`)

- Returns `true` and does nothing if `isPathIgnored(file.path)` is true.
- Reads the file, calls `cleanupYoutubeTranscript(content)`.
- If output `===` input (no match, or already clean), shows a Notice "Transcript cleanup: no changes" (when not silent) and returns `true`.
- If output differs, wraps the write in `withMaterializing(...)` and uses `app.vault.modify(file, cleaned)`. Shows Notice "Transcript cleaned" on success.
- Errors caught the same way `lintFile` catches them, with a Notice and `console.error`.
- **Never called from `lintFile` or `lintFolder` or `lintVault`** — explicitly out of the `Lint: all` path.

## Pattern matching (precise)

After stripping any leading frontmatter via `FRONTMATTER_REGEX` (defined in `src/utils.ts`), three checks in order. Any failure → return original `content` unchanged.

1. **Lead-in shape.** The first non-blank line of the body MUST be a YouTube image embed:
   ```
   ![](<url>)
   ```
   where `<url>` is validated by **`extractVideoIdFromUrl`** from `src/orchestration/utils/youtube.ts:26` (already handles `youtube.com/watch?v=`, `youtu.be/`, and `youtube.com/shorts/`).

2. **Gap shape.** Between the embed line and the `## Transcript` header (matched with optional leading/trailing whitespace), only blank lines are permitted. Any other non-whitespace content → bail.

3. **Body shape.** After `## Transcript` (allowing blank lines), the next non-blank paragraph must begin with `**\d+:\d+**` (optionally followed by separator chars like ` · `). The **transcript region** spans from that first timestamped paragraph through the last consecutive timestamped paragraph. The first non-timestamped paragraph (or end of body) ends the region.

If all three pass, proceed; else return `content` verbatim.

## Cleanup transforms

Applied only to the matched **transcript region**. Frontmatter, content before the embed (whitespace-only by construction), and content after the transcript region are preserved verbatim.

1. **Drop the embed line and the `## Transcript` header** plus the blank lines between them and the first timestamped paragraph.
2. **For each timestamped paragraph:** strip the leading `**\d+:\d+**` token plus any immediately following separator characters in the set `[ \t·•|–—-]+`.
3. **Strip bracketed non-speech annotations** with a single regex matching both escaped and unescaped forms:
   - Pattern: `\\?\[[A-Za-z][A-Za-z ]*\]\\?` not followed by `(` — i.e. `[word]`, `\[word\]`, `[two words]`, `\[two words\]`, but never the `[text]` of a markdown `[text](url)` link.
   - After stripping, collapse intra-paragraph whitespace (`\s+` → single space) and trim each paragraph.
4. **Join cleaned paragraphs with a blank line** (`\n\n`). If trailing content exists after the transcript region, separate the joined cleanup output from it with a blank line and pass the trailing content through verbatim. Ensure the final result ends with a single trailing newline.

## Command wiring

Following the pattern at `src/main.ts:124-147` (the `word-count`, `lint-note`, `lint-vault` commands) and the internal-command registration at line 618-620.

1. **Add UI command in `main.ts`** (next to the other Lint commands around line 142):
   ```ts
   this.addCommand({
       id: 'lint-cleanup-transcript',
       name: 'Lint: cleanup transcript',
       checkCallback: (checking) => {
           if (this.settings.hiddenCommands.includes('lint-cleanup-transcript')) return false;
           if (!checking) { void this.chainManager.executeInternalCommand(`${prefix}:lint-cleanup-transcript`, {}); }
           return true;
       },
   });
   ```

2. **Register the internal handler** (next to the others at line 618-620):
   ```ts
   register('lint-cleanup-transcript', async (_a, _p, _e, tf) => await this.linter.cleanupTranscriptInFile(tf));
   ```

3. **Settings `hiddenCommands`** — the new id should be supported by whatever surface lets users hide individual commands (already handled by the generic `hiddenCommands.includes(id)` check; no extra plumbing needed).

4. **Not part of `Lint: all`** — `lintFile` is untouched; this method is invoked only by the new command.

## Critical files

- **Edit `src/lint.ts`** — add the pure `cleanupYoutubeTranscript(content)` exported function (top of file, near `FRONTMATTER_REGEX` import) and the `Linter.cleanupTranscriptInFile(file, silent?)` method.
- **Edit `src/main.ts`** — add the `lint-cleanup-transcript` command (~line 142 area) and its internal-command registration (~line 620 area).
- **Read (no edit) for reuse:** `src/orchestration/utils/youtube.ts` — import `extractVideoIdFromUrl`. `src/utils.ts` — `FRONTMATTER_REGEX` is already imported in `lint.ts`. `src/frontmatter.ts` — `withMaterializing` is already imported.

## Verification

The pure function is testable without Obsidian; the file-level method requires the plugin to run.

1. **Pure function — hand-verify against fixtures.** Write a throwaway script that imports `cleanupYoutubeTranscript` and runs each input → output:
   - **Match — happy path:** the example body from the request. Expect `\[music\]` removed, timestamps and `·` separator stripped, two paragraphs joined by a blank line.
   - **No-match — text before embed:** prepend `Some intro text\n\n`. Expect unchanged.
   - **No-match — text between embed and header:** insert a paragraph between embed and `## Transcript`. Expect unchanged.
   - **No-match — missing header.** Expect unchanged.
   - **No-match — non-YouTube embed URL.** Expect unchanged.
   - **No-match — no timestamped paragraphs.** Expect unchanged.
   - **Markdown links survive:** include `[some link](https://example.com)` inside a timestamped paragraph. Expect link intact.
   - **Trailing content preserved:** append `\n\n## Notes\n\nlater content\n` after the last timestamped paragraph. Expect transcript cleaned, `## Notes` section passed through unchanged.
   - **Frontmatter preserved:** prepend a YAML block. Expect it to round-trip unchanged with the transcript cleaned underneath.

2. **Full cleanup loop** (per AGENTS.md "Full Cleanup Loop (MANDATORY)"):
   - `npm run lint` → exit 0
   - `npx tsc -noEmit -skipLibCheck` → exit 0
   - `node esbuild.config.mjs production` → exit 0

3. **In-Obsidian smoke test.** Reload the plugin, open a known matching note, run `Lint: cleanup transcript` from the command palette; confirm the body is cleaned and frontmatter is intact. Open a non-matching note (e.g., any daily note) and run the same command; confirm no change and a "no changes" Notice. Run `Lint: all` on a matching transcript note and confirm the transcript body is **not** cleaned (only frontmatter touched), proving the new logic is fully out of the `Lint: all` path.

## Out of scope (deferred to Version 2+)

- Other transcript shapes (no `## Transcript` header, different timestamp formats, missing embed, etc.).
- Frontmatter mutation such as `transcript_status: raw → cleaned`.
- A folder/vault batch variant of the cleanup command.
- A `lintFolder`-style consolidation that runs the cleanup across `findRawTranscripts()` results.
