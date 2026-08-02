---
title: Obsdian Crucible Feedback
created: 2026-07-18
modified: 2026-07-28
word-count: 73
tags: ""
---

---

# Todos
- [ ] orchestrator session: claude --resume d8c6f53f-3742-4f97-b8cb-d8f73c052066
	- [x] SA1 — companion /v1/paths (brief at runs/dispatch/sa-1-brief.md)
	- [x] RA1 — rerank/link-boost measurement arm (brief at eval-harness/.claude/dispatch/ra-1-brief.md)
- [ ] test OpenRouter as the image description provider
- [x] did this item get missed in the plan, or did I add it later: Ingestion Dashboard > Uncaptured posts: single-line read|metadata|Ingest|Ignore -> icon driven preferred, Ignore needs danger styling
	- [x] still need a warn|error color distinction (Ignore icon button)
	- [x] the intent was full icon-only (read|metadata|ingest|(un)ignore) -> also consistent order posts/videos
		- [x] we need clear visual language for the icons, and a cheap consistency audit in other Plugin surfaces (especially config may overlap)
	- [x] Publish Date should not break lines either
	- [x] Ingest needs to be disabled if not configured, or not possible due to missing metadata (popup explain)
- [x] Uncaptured videos Refresh / Auto-enqueue are not vertically aligned
- [x] X posts needs default hidden, and this is going to get enormous when run against link registry backfill
- [x] is this jargon-thread added to the eval search query set? -> it was tricky, rerank helps the actual target, and it exercises the new linked note pathway
- [x] Queue monitor pills look like they want to be a filter UI, but are not clickable
- [x] Channel control center: too long, tighten text ala "per-status video counts" and bring "Enrich All" to the main line
- [x] what commands validate/audit/clean the search state (every note indexed, every image indexed, deleted notes purged, updated from edits)
	- [x] audit tells the state, needs commands/instruction for repair
- [x] pin header in Crucible Settings (definitely in tab, live test in modal)
- [x] [[2026-05]] [[271 bugs found in Firefox, zero written by a human attacker. What this means for the future of safe code + 2 prompts]]
	- [x] sentence version ranks: software developers in crisis/mourning because code generation has caused loss of the historic romanctic craftsman experience
	- [x] keyword dump does not: developers mourning because lost historic profession craftsman romantic
	- [x] reranker saves the 271 bugs source note
	- [x] check if the logger saved my numerous early attempts and if any rank
- [x] possible up-ranking based on tag #gold, monthly capture count as a facet
- [ ] brief me on the eval-harness bug (we probably bring it in now)
- [ ] section buttons are now misaligned with each other (Uncaptured videos Refresh -> auto-enqueue did align)
- [ ] Refresh icon needs a space before the text
- [ ] audit tells the state, needs commands/instruction for repair
	- [ ] reconcile says enqueued but nothing visible in queue monitor
- [ ] pinned header leaves a visual gap, small in tab view, large in the Obsidian settings window
	- [ ] this happened previously when pinned header was attempted as well, was unable to resolve in the settings window
	- [ ] worth a try at least in the tab view (screenshots if helpful -> or how best to debug live?)
- [ ] Pending: sweep the repo's AGENTS for terseness/pointers and set the dox pattern active

---

# Ideas

---
