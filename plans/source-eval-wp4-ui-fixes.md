# Source Eval WP4 UI Fix Plan

## Summary

Before leaving WP4, apply a focused UI correction pass to the Source Eval Dashboard. Keep this within WP4 scope: no WP5 export work, no schema changes unless needed for queue filtering, and no broad dashboard refactor.

## Key Changes

- Mirror Ingestion Dashboard's collapsible section header pattern with chevrons, clickable headers, `is-collapsed`, and default-collapsed Source Eval sections.
- Remove the Source Eval section border/background styling, and put the scorecard table in a bounded scroll container with a sticky header and compact table styling.
- Exclude generated period notes from Source Eval capture/labeling eligibility: `${dailyFolder}/YYYY-MM-DD.md`, `${weeklyFolder}/GGGG-WWW.md`, and `${monthlyFolder}/YYYY-MM.md`; keep nested capture notes eligible.
- Add labeling queue broad scopes matching scorecard filters: recent all, tracked, untracked, blogs, and YouTube, while keeping per-source options.
- Add visible labels for importance and quick-tag controls, and place quick tags on their own vertical row.

## Tests

- Update capture-index tests for period-note exclusion.
- Update queue tests for broad queue scopes.
- Run focused Source Eval tests plus lint, TypeScript, production build, and `git diff --check`.

## Assumptions

- "Default hidden" means every Source Eval section starts collapsed on dashboard open.
- The scorecard keeps all current columns; the immediate fix is scroll/container behavior, not column removal.
- Period-note exclusion targets generated period note files only, not source captures stored under period asset folders.
