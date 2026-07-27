---
title: Obsdian Crucible Feedback
created: 2026-07-18
modified: 2026-07-19
word-count: 53
tags: ""
---

---

# Todos
- [ ] model settings UI:
	- [x] like the callouts, consolidate them at the bottom rather than split
	- [x] only show Embeddings UI when capability implies it
	- [x] model -> use should set expected capabilities, dims (if known)
	- [ ] do dims/precision apply to rerank models? or how to confirm embed<->rerank compatibility
- [x] Crucible Inference
	- [x] consolidate downloaded models to a chosen folder
	- [x] possible lm-studio uninstall
	- [x] audit installed unsloth studio, anythingllm, any other stray serving dashboard/harnesses
	- [x] get that gemma4-12B and other local options into a chat list for local
	- [x] if we don't have one downloaded, pick a local multimodal and test/design the image -> narrative description + content (especially charts) -> search pipeline
- [ ] Crucible Search:
	- [ ] search batch only uses about half the GPU, is the lag single-threaded insertion into the search db?
	- [ ] if so is this a sqlite issue, config issue? -> maybe a case for postgres instead of sqlite if not plugin solvable
	- [ ] or decide it's a raw table-insertion limitation regardless of providers
- [x] Another vault search example query:
	- [x] matt pocock lean claude context skills -> (looking for this, not in the results or rerank): [[How To Kill The Bloat In Claude Code's System Prompt]]

---

# Ideas

---
