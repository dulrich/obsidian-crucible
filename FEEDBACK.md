---
title: Obsdian Crucible Feedback
created: 2026-07-18
modified: 2026-07-19
word-count: 53
tags: ""
---

---

# Todos
- [x] Features:
	- [x] Queue monitor: job management UI (cancel/clear job|queue)
	- [x] make model probing the default, fallback to manual on failure -> this does not appear to go beyond listing model strings (precision, capacities are recognized but not "one click" settable in the UI)
- [x] cleanup CPU embedder/reranker docker (post sprint)
- [x] update Crucible Embed/Rerank local providers (or add new with CPU/GPU tagging)
- [x] make sure there is no systemd/systemctl cruft created by this sprint (everything running in context-control managed fleet)
- [x] ESI WP-5
	- [x] guide: specific setups for plugin users (published docker containers with gotchas?)
- [x] Vault Search -> Rerank button checks config, settings link if unset (minor UX follow-up, not urgent)
- [x] are the data/findings that have been produced even valid?
- [x] the queue monitor/control has been a major rework center: need an architectural review to ensure it's not fundamentally flawed (e.g. this service-versus-job failure that just came up which changes whether the queue should pause draining or a job should mark as failed)
- [x] use /tn-code-review subagents if appropriate against the queue system specifically, and potentially everything built by this session in the past day
- [ ] cleanup/audit and tighten AGENTS.md in repo (quirks is large, possibly out of date, and wordy) -> check dox pattern if appropriate here, and automatic lint gate status
- [x] The pre-scrub bundle and FEEDBACK.md backup in /home/dulrich/ are now safe to delete whenever you've confirmed the GitHub side looks right.
- [ ] model settings UI:
	- [ ] like the callouts, consolidate them at the bottom rather than split
	- [ ] only show Embeddings UI when capability implies it
	- [ ] model -> use should set expected capabilities, dims (if known)
- [ ] Crucible Inference
	- [ ] consolidate downloaded models to a chosen folder
	- [ ] possible lm-studio uninstall
	- [ ] audit installed unsloth studio, anythingllm, any other stray serving dashboard/harnesses
	- [ ] get that gemma4-12B and other local options into a chat list for local
	- [ ] if we don't have one downloaded, pick a local multimodal and test/design the image -> narrative description + content (especially charts) -> search pipeline
- [ ] Crucible Search:
	- [ ] search batch only uses about half the GPU, is the lag single-threaded insertion into the search db?
	- [ ] if so is this a sqlite issue, config issue? -> maybe a case for postgres instead of sqlite if not plugin solvable
	- [ ] or decide it's a raw table-insertion limitation regardless of providers
- [ ] Another vault search example query:
	- [ ] matt pocock lean claude context skills -> (looking for this, not in the results or rerank): [[How To Kill The Bloat In Claude Code's System Prompt]]

---

# Ideas

---
