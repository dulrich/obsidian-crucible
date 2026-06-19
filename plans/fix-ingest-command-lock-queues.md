# Fix Ingest Lint Completion, Locks, and Queue Lanes

## Summary
- The saved `Ingest as Fanfic`, `Ingest as Blog`, and `Ingest as News` chains are functionally identical: tag, move to daily folder, then `lint-note`; Blog only has `debugMode: false`, which must remain behavior-neutral.
- Fix the underlying contracts centrally: command invocations must be awaited, mutating commands must serialize through the note/resource lock, and user-initiated jobs must drain before background jobs of the same type without interrupting already-running work.
- Before implementation, remind the user to run `npm run dev` in a separate terminal for Obsidian hot reload.

## Key Changes
- Command execution:
  - Add a central awaited Crucible command runner used by `registerCrucibleCommand`, chain registration, and queue-backed `command_run`.
  - Remove local `void` fire-and-forget paths for commands/chains that are expected to complete work; chain commands should return the `executeChain(...)` promise.
  - Make debug logging and Notices side effects only: failures or disabled settings must not change command success/completion behavior.
- Locking:
  - Extend internal command registration metadata with `mutating` and lock-target behavior.
  - Wrap mutating internal command execution in `NoteLockManager.withLock` for `targetFile ?? activeFile`; reentrant calls inside chains continue to run inline.
  - Move `lintFile`'s initial read and `word-count` calculation inside the note lock so the count reflects the serialized content being linted.
  - Audit current mutators (`upsert-tags`, `upsert-property`, move-file, lint/localize/metadata writes) so each queues against the note/resource lock through one shared path.
- Queue lanes:
  - Add `lane: 'user' | 'background'` to orchestration enqueue options and persisted file job frontmatter; legacy missing lane defaults by priority (`high` => user, otherwise background).
  - Sort file-backed jobs by lane first, then priority, then creation/id.
  - Add equivalent lane handling to `MemoryJobQueue`: pending background entries can be promoted by a user enqueue; running background entries are not interrupted.
  - Mark manual commands/dashboard actions as `user`; triggers, schedules, auto-source refill, image metadata, and automatic search/index work as `background`.

## Tests
- Add command contract tests proving:
  - `registerCrucibleCommand`/chain command registration await the underlying async work.
  - Debug mode on/off and Notice/debug failures do not alter command results.
  - `command_run` invokes the same awaited internal command path as chains.
- Add lock tests proving:
  - Two mutating invocations against the same note run FIFO.
  - `lint-note` after a move writes `word-count` to the moved target file.
  - `lintFile` computes `word-count` after acquiring the lock.
- Add queue tests proving:
  - User lane drains before background for each job type.
  - A user job enqueued while a background job is running waits and runs next.
  - Pending duplicate background jobs promote to user when manually requested.
  - Memory and file-backed queues share the same lane semantics.
- Run the mandatory cleanup loop: `npm run lint`, `npx tsc -noEmit -skipLibCheck`, `node esbuild.config.mjs production`, and confirm all exit 0.

## Assumptions
- "User" means direct palette commands, dashboard button clicks, and explicit manual enqueue actions.
- "Background" means triggers, schedules, automatic enrichment/refill, auto image metadata extraction, and automatic search/index maintenance.
- The fix should not special-case Blog/News/Fanfic chain names; identical chains should behave identically through the central contracts.
