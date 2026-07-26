---
title: Obsdian Crucible Feedback
created: 2026-07-18
modified: 2026-07-19
word-count: 53
tags: ""
---

---

# Todos
- [ ] Features:
	- [x] Queue monitor: job management UI (cancel/clear job|queue)
	- [ ] make model probing the default, fallback to manual on failure -> this does not appear to go beyond listing model strings (precision, capacities are recognized but not "one click" settable in the UI)
- [ ] cleanup CPU embedder/reranker docker (post sprint)
- [x] update Crucible Embed/Rerank local providers (or add new with CPU/GPU tagging)
- [ ] make sure there is no systemd/systemctl cruft created by this sprint (everything running in context-control managed fleet)
- [ ] ESI WP-5
	- [ ] guide: specific setups for plugin users (published docker containers with gotchas?)
- [ ] Vault Search -> Rerank button checks config, settings link if unset (minor UX follow-up, not urgent)
- [ ] are the data/findings that have been produced even valid?
- [ ] the queue monitor/control has been a major rework center: need an architectural review to ensure it's not fundamentally flawed (e.g. this service-versus-job failure that just came up which changes whether the queue should pause draining or a job should mark as failed)
- [ ] use /tn-code-review subagents if appropriate against the queue system specifically, and potentially everything built by this session in the past day

---

# Ideas

---
