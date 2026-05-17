# Add Capture Source Note Variables

## Summary
Add capture-only template variables for linking back to the source note.

## Key Changes
- Support `{{source_link}}` as a complete Obsidian wikilink, for example `[[Folder/Source Note|Source Note]]`.
- Support `{{source_path}}` for templates that want to author their own wikilink syntax, for example `[[{{source_path}}]]`.
- Support `{{source_title}}` for the source note basename.
- Keep `{{title}}` as the target note title for backward compatibility.
- Expand source tokens to an empty string when no source note is available.

## Test Plan
- Verify a capture from an active note into a daily note expands `{{source_link}}`.
- Verify `[[{{source_path}}]]` creates a valid note link.
- Verify `{{source_title}}` expands to the source note basename.
- Verify existing variables like `{{value}}`, `{{title}}`, and `{{date}}` still work.
- Run `npm run lint`, `npx tsc -noEmit -skipLibCheck`, and `node esbuild.config.mjs production`.
