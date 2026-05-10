# CLI Provider Refactor: Per-CLI Shapes, Run Capture, Read-Only by Default

## Context

Current `callCli()` (`src/providers.ts:236-254`) treats every CLI agent the same: subcommand + `-m model` + extraArgs + (positional or `-p`) prompt. That assumption breaks down per the spec in `plans/cli-provider-options.md`:

- **Codex** is being invoked as `codex exec -m <model> "<prompt>"`. Real Codex headless usage is `codex exec [--sandbox read-only --ask-for-approval never] -` with the prompt on **stdin**, not as a positional arg. Long/multi-line prompts on argv are also fragile.
- **Claude** has dedicated `--append-system-prompt-file` and `--system-prompt-file` flags plus `--tools "Read"` for read-only orchestration; the current code mashes system + user with `\n\n` and passes them as one positional `-p` blob.
- **Gemini** and **OpenCode** have no first-class read-only flags — they need filesystem-level read-only enforcement (vault cwd) and proper stdin/`--file` delivery.
- Nothing in the current code captures the *response* as an artifact; only progress logs (stdout/stderr chunks interleaved) get written to `_crucible/cli-logs/`. For orchestrated/replayable agent runs we want a clean `task.md` + `response.md` per run.

Goal: replace the single shape table with per-CLI builders that match each tool's documented headless invocation, default to read-only, and persist a structured run artifact directory under `_crucible/cli-runs/` for orchestration.

## Design

### 1. Per-agent execution mode

Add to `Agent` (`src/types.ts:172-182`):

```ts
export type AgentExecutionMode = 'read-only' | 'edit' | 'unrestricted';

export interface Agent {
  // ...existing fields
  executionMode: AgentExecutionMode;  // default 'read-only'
}
```

Default for existing agents on migration: `'read-only'`. Surfaced as a dropdown in agent settings UI (`src/settings.ts`).

Plumb through: `AgentManager.executeAgent()` (`src/agents.ts:91`) → `providerManager.complete()` → CLI builders, alongside the existing `timeoutSeconds`.

### 2. Per-CLI builders

Replace `CLI_SHAPES` (`src/providers.ts:296-309`) and the generic argv assembly (`src/providers.ts:243-251`) with one builder per CLI kind. Each builder takes `(modelId, systemPrompt, userPrompt, mode, runDir, extraArgs)` and returns:

```ts
interface CliInvocation {
  args: string[];
  stdin?: string;          // if set, pipe to child.stdin and close
  // task.md / system.md already on disk in runDir; builder may reference them
}
```

Per-CLI command construction:

| Kind          | Subcommand | Read-only flags                                               | System prompt              | Prompt delivery          |
|---------------|------------|---------------------------------------------------------------|----------------------------|--------------------------|
| `claude-cli`  | (none)     | `--bare --tools Read --permission-mode dontAsk`               | `--append-system-prompt-file <runDir>/system.md` (when set) | `-p` from stdin (`-p "$(< task.md)"` semantics → write task.md, then `args=['-p', task]`) |
| `codex-cli`   | `exec`     | `--sandbox read-only --ask-for-approval never`                | Prepended into stdin payload (Codex has no system-prompt flag) | `-` argument; full prompt piped on **stdin** |
| `gemini-cli`  | (none)     | `--sandbox` (no native read-only-never flag — see note)       | Composed into stdin (`SYSTEM:\n…\n\nTASK:\n…`) | `--prompt "Follow stdin and produce the final answer only."` + stdin |
| `opencode-cli`| `run`      | (no native flag — see note)                                   | Composed into single message string | `--file <runDir>/task.md` + a short instruction message |

Mode mapping:
- `read-only` → flags above applied
- `edit` → safe-flags omitted; behavior matches today
- `unrestricted` → for Codex, swap `--sandbox read-only` → `--sandbox workspace-write --ask-for-approval never`; for Claude, drop `--tools Read` and `--permission-mode dontAsk`. Gemini/OpenCode unchanged (no native flags).

Filesystem-level read-only fallback: when `mode === 'read-only'` AND the CLI has no native flag (Gemini, OpenCode), surface a warning in the run header noting that read-only is best-effort (cwd is vault root by default; no kernel-level enforcement). This matches what `plans/cli-provider-options.md` recommends.

### 3. Run capture layout

Replace `CLI_DEFAULT_LOG_DIRECTORY = '_crucible/cli-logs'` (`src/providers.ts:31`) with `CLI_DEFAULT_RUN_DIRECTORY = '_crucible/cli-runs'`. Each invocation gets:

```
_crucible/cli-runs/
  2026-05-09T14-22-08-123Z-<agent-label>/
    task.md           # composed user prompt (the {{input}}-resolved text)
    system.md         # resolved system prompt (omitted if empty)
    invocation.json   # {kind, command, args, cwd, mode, model, timeoutMs, startedAt}
    response.md       # final stdout (written on close, exit 0 only)
    progress.log      # ISO-timestamped stdout/stderr chunks + meta lines (today's behavior)
  latest -> 2026-05-09T14-22-08-123Z-<agent-label>   # symlink (POSIX) / latest.txt pointer (Windows)
```

`createCliProcessLog()` (`src/providers.ts:256-293`) becomes `createCliRunArtifacts()`, returning a handle with helpers `writeTask(text)`, `writeSystem(text)`, `writeInvocation(meta)`, `writeChunk(stream, chunk)`, `writeResponse(text)`, `close(message)`. Existing `CliProcessLog` class is renamed and extended.

The `provider.cliLogEnabled` setting (`src/settings.ts:1017`) is renamed/repurposed to `provider.cliRunArtifactsEnabled` (default **on** — was off). `provider.cliLogDirectory` → `provider.cliRunDirectory`.

### 4. runProcess changes

`runProcessOnce()` (`src/providers.ts:669-726`) gains optional `stdin?: string`. When set, write to `child.stdin` and `child.stdin.end()` after spawn. Update `SpawnedProcess` interface to include `stdin: { write, end }`.

On exit code 0, the run handle writes `response.md` from accumulated stdout (in addition to streaming chunks into `progress.log`).

## Files to modify

- `src/providers.ts` — bulk of the work: replace `CLI_SHAPES` + `callCli` with per-kind builders; rename log infrastructure → run-artifacts infrastructure; extend `runProcessOnce` for stdin; add mode-aware safe-flag injection.
- `src/types.ts` — add `AgentExecutionMode` and `Agent.executionMode` field; rename `Provider.cliLogEnabled` / `cliLogDirectory` to `cliRunArtifactsEnabled` / `cliRunDirectory`.
- `src/settings.ts` — add execution-mode dropdown to the agent editor (around line ~for agents); rename CLI provider log fields (`src/settings.ts:1017,1031`); update default for the artifacts-enabled toggle to `true`.
- `src/agents.ts` — pass `agent.executionMode` through to `providerManager.complete()` (extend `ProviderCompletionOptions` in `src/providers.ts:35-37` with `executionMode` and `agentLabel` for run-dir naming).
- Settings migration: in whatever loadData/migrate path exists (find at execution-time — likely in `main.ts` or `src/settings.ts`), default `executionMode='read-only'` for legacy agents and rename old log field keys.

## Reuse / existing helpers to keep

- `parseExtraArgs` (`src/providers.ts:311-320`) — still used per-builder for user-supplied extra flags (appended after safe flags).
- `resolveCliCommand` / `runProcess` resolution path (`src/providers.ts:409-430`) — unchanged; still resolves bare commands via PATH + known dirs.
- `normalizeVaultLogDirectory`, `formatLogTimestamp`, `sanitizeLogName` (`src/providers.ts:382-393`) — keep as-is; reused by run-artifacts dir creation.
- `applyTemplateString` and existing prompt resolution in `src/agents.ts:79-84` — unchanged. The composed `system` and `user` strings are what flow into the new builders.

## Verification

1. **Unit-level (manual)**: in Obsidian dev vault, create one agent per CLI kind (`claude`, `codex`, `gemini`, `opencode`) bound to a known-good model, with a multi-line system prompt and a `{{value}}`-templated user prompt. Run each in `read-only` mode and verify:
   - `_crucible/cli-runs/<ts>-<agent>/task.md` contains the resolved user prompt verbatim (multi-line preserved, no shell-quoting artifacts).
   - `_crucible/cli-runs/<ts>-<agent>/system.md` exists when the agent has a system prompt.
   - `invocation.json` shows the expected argv (e.g. for Codex: `["exec", "--sandbox", "read-only", "--ask-for-approval", "never", "-"]` and stdin used).
   - `response.md` matches what the agent returned in Obsidian.
   - `progress.log` has interleaved stdout/stderr.
2. **Codex regression specifically**: confirm the prompt is delivered via stdin, not argv. Run `ps`/check `invocation.json` during a long prompt and confirm argv length is small.
3. **Mode toggle**: switch an agent to `edit`, re-run, confirm safe flags are absent in `invocation.json`. Switch to `unrestricted`, confirm sandbox flag flips for Codex / `--tools Read` is dropped for Claude.
4. **Read-only enforcement test**: in `read-only` mode, give the Claude/Codex agent a prompt that asks it to write a file. Verify the file is *not* created and the agent reports a tool/sandbox refusal in `response.md`.
5. **Migration**: open the dev vault with existing agents/providers (no `executionMode` field, old `cliLogEnabled` field). Confirm: legacy agents pick up `executionMode='read-only'` default; old `cliLogEnabled` value migrates to `cliRunArtifactsEnabled`; no settings reset.
6. **Build**: `npm run build` (or whatever the repo uses — check `package.json` scripts) passes with no type errors.
