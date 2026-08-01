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
- [ ] test OpenRouter as the image description provider
- [x] unclear: danger buttons have no rollover, or it's invisible in the Crucible theme (med)
- [x] re-render flash appears gone, only remaining non-perfect symptom is scroll moves when viewing a lower section and a higher open Queue Monitor (typically) changes height, causing scroll position drift
- [x] saw an image timeout after ... warning popup po
- [x] `references/x-post-metadata-ingestion-findings.md` -> WIP
- [x] image_describe_note -> queue not draining -> missing a new setting?
- [x] orphaned attachments (3323) -> is this true because something updated, or a bug?
- [x] Queue Monitor: action buttons in single row, let Target take the wrapping
- [x] how to view status/stats of the job queue db now?
- [x] image_describe_note queue refilled to ~100 on restart
- [x] Missing localized attachments -> remediation sprint follow-up
	- [x] metadata cache materialization is slow?
	- [x] non-repairables are showing the image + "Open Pasted Image" -> [[_resources/2026-04-19/7ee8e1d60e2ca8ef3c8730ef5967e55a_MD5.jpg|Open: Pasted image 20260419104648.png]]
	- [x] Why orphaned :
	- [x] ```
	      shows image in note, listed in missing/non-repairable: [[_resources/2026-04-16/f34bd9d2b253c80286162eb4ed306f7d_MD5.jpg|Open: Pasted image 20260416085404.png]]
	      orphan: af32b896eff98149db09b8b9983f3b2f_MD5.jpg
	  ```
- [x] X-metadata: does the x-metadata link cause adjacency boosting in search? (ditto raw transcripts, yt-metadata)
- [x] YT Enrich needs a failure reason (detect -> configure notice/link like Search Modal rerank button)
- [ ] did this item get missed in the plan, or did I add it later: Ingestion Dashboard > Uncaptured posts: single-line read|metadata|Ingest|Ignore -> icon driven preferred, Ignore needs danger styling
- [ ] is this jargon-thread added to the eval search query set? -> it was tricky, rerank helps the actual target, and it exercises the new linked note pathway
- [x] still 4 "non-repairables" -> all show their pasted image -> is this actually a different glitch in the note, like double image (one is broken)?
- [x] Still seeing search timeouts (maybe type-ahead is stacking queries?):
	- [x] this version doesn't rank: genius author sysadmin inventing concept-words sol fable
	- [x] this version does: sol and fable talk like brilliant authors who are also experienced linux sysadmins reddit
	- [x] rerank brought the actual result way up in the second case
- [ ] what commands validate/audit/clean the search state (every note indexed, every image indexed, deleted notes purged, updated from edits)

---

# Ideas

---
