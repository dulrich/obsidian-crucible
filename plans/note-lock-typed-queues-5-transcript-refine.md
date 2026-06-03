# Chunk 5 — Transcript Refine through the queue

Part of [note-lock-typed-queues.md](./note-lock-typed-queues.md). Depends on Chunks 1, 3.

## Goal
Stop triggering Transcript Refine via a direct/debounced call; route it **only** through the
orchestration queue, deduped by input path, so rapid edits collapse to one job and it
participates in note-locking + per-type rate-limit.

## Audit current trigger
`transcript_refine` has `workflows/TranscriptRefinerWorkflow.ts`, registered in `main.ts:87`.
Find the actual invocation site (debounced direct call vs. command). Confirm where the
"debounce issue" originates.

## Change
- Replace the direct/debounced call with `orchestrator.enqueue('transcript_refine', { inputPath })`.
- **Dedupe by input path**: before enqueue, skip if a queued/running `transcript_refine` job
  already targets that path (check `JobStore.listFolder('queued'|'running')` params/inputPaths, or
  reuse the Chunk 3 idempotency key mechanism with `idempotentKey: p=>p.inputPath` if treated as a
  file-persistence type — note idempotency currently lives in the memory path, so for file types
  add a lightweight "already queued for this path?" guard).
- The workflow acquires the note-lock for the transcript file (via Chunk 1 wiring) so refine can't
  race localize/lint on the same note.

## Verify
- `npm run build` + `npm test` green.
- Manual: rapidly edit a transcript → exactly one queued refine job (deduped), runs once, holds
  the note-lock (overlay shows), no debounce-driven double runs.
