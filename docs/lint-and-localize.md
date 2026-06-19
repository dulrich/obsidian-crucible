# Lint and Localize

Crucible's lint commands clean frontmatter, derived properties, transcript text, word counts, and attachment references.

## Lint Commands

- `Lint: word count` calculates prose word count.
- `Lint: all` runs the configured note lint operations.
- `Lint: vault` runs lint across the vault, respecting ignored folders.
- `Lint: cleanup transcript` normalizes transcript-style text.
- `Lint: update property in vault` renames a frontmatter property across the vault.
- `Lint: remove property from vault` removes a frontmatter property across the vault.

Frontmatter updates use Obsidian's frontmatter processor so YAML structure is preserved.

## Word Count

Word count is prose-only. It strips frontmatter, code, comments, embeds, SVG/script/style blocks, and reduces links to visible text before counting. Re-linting old notes can lower historical counts because markup tokens are no longer counted as prose.

## Derived IDs

`Lint: all` derives metadata IDs from the note's `source` property:

- YouTube: `yt-video-id`
- Blog posts: `post-id`

Tracker intake uses plural aggregate keys in tracker notes:

- YouTube: `yt-video-ids`
- Blog posts: `post-ids`

The singular keys describe what one note represents. The plural keys are intake-run aggregates.

## Localize Attachments

Attachment localization is separate from `Lint: all`. It can copy files, download remote media, convert images, and rewrite embeds, so it is exposed as explicit commands:

- `Lint: localize attachments`
- `Lint: localize attachments (vault)`
- `Lint: repair attachment links`
- `Lint: repair attachment links (vault)`

User-facing behaviors worth knowing:

- Localized attachment names use a deterministic content MD5. The same final bytes produce the same name, which makes repeated localization idempotent and deduplicates identical files.
- Markdown embeds are emitted with empty alt text. Obsidian treats numeric alt text as image display width, so filename-like alts such as `1` can make an image render at 1px.
- Web clipper `data:image/...` placeholder embeds are stripped when image localization runs because they can prevent the real image embed from rendering.
- Long remote downloads re-read the note before writing replacements so concurrent note edits are not overwritten by stale content.
- Attachment repair resolves broken localized embeds by expected folder first, then by a unique vault-wide content-hash filename match.

Automated lint/localize triggers respect ignored folders and skip notes that are currently locked by another mutating Crucible operation.
