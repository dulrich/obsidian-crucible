---
title: Obsidian Crucible Control Plane
created: 2026-07-06
modified: 2026-07-19
word-count: 3
tags: ""
initiative-visibility: public
initiative-slug: obsidian-crucible
initiative-title: Obsidian Crucible
pending-plans:
  - "[[trigger-hardening-and-sqlite-queue]]"
initiative-status: active
initiative-cadence: as-needed
review-after-commits: 20
review-after-lines: 1500
---

---

# Blocked on User

- Before the SQLite queue WPs (thq WP-5+) dispatch: run in Obsidian devtools console `require('node:process').versions.node` (need ≥ 23.4) and `!!require('node:sqlite')` (need true), and report the result.

---
