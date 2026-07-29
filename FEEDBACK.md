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
- [ ] Ingestion Dashboard > Uncaptured videos > Ignore (flash + re-render twice, scroll is now maintained)

---

# Ideas

---
