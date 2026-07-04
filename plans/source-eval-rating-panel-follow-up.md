# Source Eval Rating Panel Follow-Up

## Summary

Apply a focused UI/data tweak pass to the Source Eval rating panel and queue behavior. Keep `urgent` as a boolean label field, add read-state and persistent skip controls, and preserve existing quick-tag semantics.

## Key Changes

- Keep `Urgent` as `eval-urgent`, rendered on its own `Urgent?` checkbox row.
- Add a `Read?` row with check / red-X state controls, writing the existing `read` frontmatter field on save.
- Prepopulate quick-tag toggles from both normal `tags:` and parsed `eval-tags`; saves continue merging quick tags into normal `tags:`.
- Keep the embedded note preview at a stable fixed/min-height with internal scrolling.
- Rename temporary queue advance from `Skip` to `Next`.
- Add persistent `Skip labeling`, writing `eval-skip: true` and excluding those notes from future default labeling queues.

## Tests

- Update label parsing/capture-index tests for `eval-skip`.
- Update rating queue tests for skipped capture filtering.
- Run focused Source Eval tests plus lint, TypeScript, production build, and `git diff --check`.
