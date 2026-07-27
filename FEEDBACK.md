---
title: Obsdian Crucible Feedback
created: 2026-07-18
modified: 2026-07-19
word-count: 53
tags: ""
---

---

# Todos
- [x] model settings UI:
	- [x] do dims/precision apply to rerank models? or how to confirm embed<->rerank compatibility
- [x] Crucible Search:
	- [x] search batch only uses about half the GPU, is the lag single-threaded insertion into the search db?
	- [x] if so is this a sqlite issue, config issue? -> maybe a case for postgres instead of sqlite if not plugin solvable
	- [x] or decide it's a raw table-insertion limitation regardless of providers

---

# Ideas

---
