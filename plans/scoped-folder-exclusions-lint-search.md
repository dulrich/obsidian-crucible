# Scoped Folder Exclusions for Lint and Search

## Summary

Replace the lint-only ignored-folder list with a scoped exclusion list that can independently apply to lint and search. Search indexing will skip the plugin's internal `_crucible` area by default, including orchestration queue notes, while existing lint exclusions keep their current lint behavior after migration.

## Key Changes

- Add `excludedFolders: { folder: string; lint: boolean; search: boolean }[]`.
- Default entry: `{ folder: '_crucible', lint: false, search: true }`.
- Convert legacy `lintIgnoredFolders` entries into lint-only scoped exclusions during migration.
- Add shared path-exclusion helpers with folder-boundary matching.
- Make lint and search use scoped exclusions.
- Remove queue-scan mutation of lint exclusions.
- Update the Lint settings UI so each excluded folder row has `Lint` and `Search` toggles.

## Test Plan

- Unit tests for exact/nested folder matching, sibling-prefix safety, empty row behavior, and separate lint/search scopes.
- Migration coverage for legacy lint-only exclusions and default `_crucible` search exclusion.
- Search coverage for excluding `_crucible/**` from rebuild and lifecycle enqueue behavior.
- Required cleanup loop: `npm run lint`, `npx tsc -noEmit -skipLibCheck`, `node esbuild.config.mjs production`.

## Assumptions

- The plugin-internal folder default is `_crucible`.
- Existing lint exclusions remain lint-only after migration.
- Search exclusion changes are applied to future indexing; users should rebuild the search index to purge stale rows.
