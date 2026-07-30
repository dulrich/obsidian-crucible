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
- [x] quite a few stuck search_delete_path jobs, there is file churn from Clippings -> auto-localize, Chain commands create _raw_transcript
- [x] several images or a stuck job (?) are timing out
	- [x] depending on what the error is it might be worth adding/using an OpenRouter fallback (should test in any case)
	- [x] test new image batch (first let agent check) -> I have not yet tried any vault-wide commands
	- [x] currently have a stuck image_describe_note
- [x] blink/rerender fix has stopped a pathway I used to use to refresh dataview tables -> add to chain or is there a watcher/timer approach?
	- [x] the chain is sometimes blanking the note, maybe wrong dataview command
- [x] Ingestion Dashboard still has blink/rerender pause, and scroll position is broken when long table views are involved
- [x] search failing to find the note/reference (I'm not sure if it actually is even in the vault -- it wasn't, but Sol tracked it down via firefox cache): talking to a genius who also has thirty years of linux kernel experience [fable sol]
- [x] Ingestion Dashboard > Uncaptured videos > Ignore (flash + re-render twice, scroll is now maintained)
- [x] still seeing timeouts in the image_describe_batch -> check logs or if something needed a restart (inference-engine?)
- [x] Chain has no edit-form delete button
- [x] repro query hit the now 4s timeout first run, close search modal -> reopen + repaste -> second run returns
- [x] Ingestion Dashboard -> multiple rerender jumps/flashes from YouTube Ingestion 
	- [x] any queued job added or cleared causes the render/jump
	- [x] does the ingestion dashboard need to be reassessed architecturally rather than patchwork, or is this solvable in the current architecture (i.e. retained virtual DOM or similar?)?
- [x] Two Recovered: aborted claim appear stuck (other stuck jobs did drain) -> drained after latest restart
- [ ] unclear: danger buttons have no rollover, or it's invisible in the Crucible theme (med)
- [ ] re-render flash appears gone, only remaining non-perfect symptom is scroll moves when viewing a lower section and a higher open Queue Monitor (typically) changes height, causing scroll position drift
- [ ] `references/x-post-metadata-ingestion-findings.md`
- [ ] just saw an image timeout after ... warning popup

---

# Ideas

---
