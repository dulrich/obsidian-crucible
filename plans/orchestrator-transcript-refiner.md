# Orchestrator — Transcript Refiner (Plan 4 of 4)

## Context

Wire the orchestrator into the **existing** "Refine Transcript" Chain (registered in `data.json:98-167`). The orchestrator does not reimplement transcript refinement — it queues a job whose execution opens the target note and invokes `chainManager.executeChain()` on the named chain.

This is the smallest of the four workflows because the heavy lifting already exists. Its real value is letting transcript refinement participate in the same queue/scan/run-next lifecycle as the other workers.

**Depends on:** Plan 1 (core).

## What it does

1. User picks a target note (a transcript) via a `FileSuggest` modal.
2. Orchestrator enqueues a `transcript_refine` job with `params.targetPath`.
3. On `runNext()`:
   - Resolve the target file. If gone → fail.
   - Look up the chain by name (default `"Refine Transcript"`, overridable via `params.agentChainName`).
   - If chain is missing → fail with a guiding error.
   - Open the target file in the active leaf (the chain's `crucible:source:active-file` step depends on this).
   - Invoke `chainManager.executeChain(chain, undefined, file)`.
   - Surface chain success/failure as job status.

## Files to add

```
src/orchestration/workflows/TranscriptRefinerWorkflow.ts
src/orchestration/utils/transcript.ts     (helpers for future scan integration)
```

## Files to modify

- `src/main.ts` — register workflow + add `orchestrator-enqueue-transcript-refine` command.

## Implementation details

### `src/orchestration/utils/transcript.ts`

```ts
export function findRawTranscripts(app: App): TFile[];
// Iterates getMarkdownFiles(), reads metadataCache frontmatter, returns files
// where frontmatter['transcript_status'] === 'raw'. NOT wired into scan() in v1.
```

This helper is included so plan-5-and-beyond auto-enqueue work has a place to land. It is not invoked by anything in v1.

### `src/orchestration/workflows/TranscriptRefinerWorkflow.ts`

```ts
const DEFAULT_CHAIN_NAME = "Refine Transcript";

export class TranscriptRefinerWorkflow implements Workflow {
  async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
    const targetPath = job.params?.targetPath;
    if (typeof targetPath !== "string" || !targetPath) {
      return { status: "failed", error: "Missing params.targetPath" };
    }

    const file = app.vault.getAbstractFileByPath(targetPath);
    if (!(file instanceof TFile)) {
      return { status: "failed", error: `Target note not found: ${targetPath}` };
    }

    const chainName = (job.params?.agentChainName as string) ?? DEFAULT_CHAIN_NAME;
    const chain = plugin.settings.chains.find(c => c.name === chainName);
    if (!chain) {
      return {
        status: "failed",
        error: `Chain "${chainName}" is not configured. Add it under Settings → Automate → Chains.`,
      };
    }

    // Open the file so chain steps that act on the active editor work.
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(file);

    try {
      await plugin.chainManager.executeChain(chain, undefined, file);
    } catch (err) {
      return { status: "failed", error: `Chain execution failed: ${String(err)}` };
    }

    return {
      status: "done",
      outputPaths: [file.path],
      notes: `Ran chain "${chainName}" on ${file.path}`,
    };
  }
}
```

### Enqueue command

```ts
this.addCommand({
  id: "orchestrator-enqueue-transcript-refine",
  name: "Orchestrator: Enqueue transcript refine",
  callback: async () => {
    new FileSuggestModal(this.app, async (file) => {
      await this.orchestrator.enqueue("transcript_refine", { targetPath: file.path });
    }).open();
  },
});
```

`FileSuggestModal` — reuse pattern from existing settings.ts `FileSuggest` (or wrap it as a modal). If a suitable modal helper doesn't exist, add a minimal `FuzzySuggestModal<TFile>` subclass in this plan; keep it scoped to `.md` files.

## main.ts wiring

```ts
import { TranscriptRefinerWorkflow } from "./orchestration/workflows/TranscriptRefinerWorkflow";

this.orchestrator.register("transcript_refine", new TranscriptRefinerWorkflow());
```

## Verification

1. `npm run build` — clean.
2. **Happy path:**
   - Pick an existing transcript note that does NOT have `#refined` tag (the chain has a guard against this).
   - `Orchestrator: Enqueue transcript refine` → modal opens; pick the file.
   - Job appears in `inbox/`.
   - `Orchestrator: Run next` → file opens in active leaf; chain runs end-to-end (same outputs as manually triggering "Refine Transcript" today: `_raw_transcript/` copy, refined body, `transcript`/`refined` tags, `model` property, lint).
   - Job moves to `done/`.
3. **Missing chain:**
   - Temporarily rename the chain in settings (e.g., `"Refine Transcript X"`).
   - Enqueue + run → job moves to `failed/` with the guiding error in frontmatter.
4. **Missing target:**
   - Enqueue with a known path, then delete the file before running.
   - `Run next` → fails with `"Target note not found"`.
5. **Already-refined target (guard step trips):**
   - Pick a note that already has `#refined`.
   - Run → chain's first step (the guard) halts execution. Today the chain stops silently; verify the orchestrator records this as `done` (since chain didn't throw). Acceptable v1 behavior; document in the job's `notes`.
6. **Re-enqueue same target:**
   - Two jobs for the same path can coexist in inbox/. Running them sequentially refines twice (the second hits the `#refined` guard). No special handling — orchestrator treats jobs as independent.

## Out of scope (deferred)

- Auto-detection of `transcript_status: raw` notes during `scan()` (helper exists in `utils/transcript.ts` but is not wired).
- Pre-flight check that the chain still references valid agent IDs.
- Per-job override of the agent (different model than default).
- Batch enqueue of all raw transcripts in one command.
