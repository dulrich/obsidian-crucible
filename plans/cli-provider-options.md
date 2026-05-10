Here are the closest equivalents for your Codex pattern:

```bash
codex exec \
  --sandbox read-only \
  --ask-for-approval never \
  - < task.md \
  > codex.response.md \
  2> codex.progress.log
```

## Claude Code

Claude Code’s non-interactive mode is `claude -p` / `claude --print`. It supports stdin, text/json/stream-json output, custom system prompt files, and tool restrictions. ([Claude][1])

### Read-only-ish, final answer to stdout

```bash
claude --bare \
  -p "$(cat task.md)" \
  --tools "Read" \
  --permission-mode dontAsk \
  --output-format text \
  > claude.response.md \
  2> claude.progress.log
```

Better if you have a system prompt file:

```bash
claude --bare \
  --append-system-prompt-file ./system.md \
  -p "$(cat task.md)" \
  --tools "Read" \
  --permission-mode dontAsk \
  --output-format text \
  > claude.response.md \
  2> claude.progress.log
```

For a stricter system-prompt replacement:

```bash
claude --bare \
  --system-prompt-file ./system.md \
  -p "$(cat task.md)" \
  --tools "Read" \
  --permission-mode dontAsk \
  --output-format text \
  > claude.response.md \
  2> claude.progress.log
```

Notes:

`--tools "Read"` is the important part for “no writes.” Claude’s CLI reference says `--tools` restricts which built-in tools are available, while `--disallowedTools` can remove specific tools such as `Edit`. ([Claude][2])

`--bare` is useful for deterministic orchestration because it skips auto-discovery of hooks, skills, plugins, MCP servers, auto memory, and `CLAUDE.md`. ([Claude][1])

If you want JSON:

```bash
claude --bare \
  --append-system-prompt-file ./system.md \
  -p "$(cat task.md)" \
  --tools "Read" \
  --permission-mode dontAsk \
  --output-format json \
  > claude.response.json \
  2> claude.progress.log
```

## Gemini CLI

Gemini CLI headless mode is triggered by `-p` / `--prompt`, or by piping stdin in a non-TTY context. It supports text and JSON output. ([Google Gemini][3])

### Basic final answer to stdout

```bash
gemini \
  --prompt "$(cat task.md)" \
  --output-format text \
  > gemini.response.md \
  2> gemini.progress.log
```

With prompt composition:

```bash
{
  printf '%s\n\n' "SYSTEM INSTRUCTIONS:"
  cat ./system.md
  printf '\n\n%s\n\n' "TASK:"
  cat ./task.md
} | gemini \
    --prompt "Follow the instructions from stdin and produce the final answer only." \
    --output-format text \
    > gemini.response.md \
    2> gemini.progress.log
```

For JSON:

```bash
gemini \
  --prompt "$(cat task.md)" \
  --output-format json \
  > gemini.response.json \
  2> gemini.progress.log
```

### About read-only

Gemini CLI does **not** appear to have a direct equivalent to Codex’s:

```bash
--sandbox read-only --ask-for-approval never
```

It has `--sandbox` / `-s`, approval modes, and allowed-tool configuration. The documented approval modes are `default`, `auto_edit`, and `yolo`; there is no documented “never ask and disallow edits” equivalent in the command-line flags I found. ([Google Gemini][4])

Closest safe pattern:

```bash
gemini \
  --sandbox \
  --approval-mode default \
  --prompt "$(cat task.md)" \
  --output-format text \
  > gemini.response.md \
  2> gemini.progress.log
```

For a deterministic orchestrator, I would not rely on Gemini’s approval prompts. I would run it inside an OS/container-level read-only wrapper if writes must be impossible, for example a disposable Docker/Podman mount with the repo mounted read-only.

## OpenCode

OpenCode’s non-interactive command is:

```bash
opencode run [message..]
```

It supports `--model`, `--agent`, `--file`, `--format json`, and attaching to an `opencode serve` backend. ([OpenCode][5])

### Basic final answer to stdout

```bash
opencode run "$(cat task.md)" \
  > opencode.response.md \
  2> opencode.progress.log
```

With prompt composition:

```bash
opencode run "$(
  {
    printf '%s\n\n' "SYSTEM INSTRUCTIONS:"
    cat ./system.md
    printf '\n\n%s\n\n' "TASK:"
    cat ./task.md
  }
)" \
  > opencode.response.md \
  2> opencode.progress.log
```

With JSON events/raw output:

```bash
opencode run \
  --format json \
  "$(cat task.md)" \
  > opencode.events.jsonl \
  2> opencode.progress.log
```

OpenCode also has `--file/-f` to attach files to the message: ([OpenCode][5])

```bash
opencode run \
  --file ./task.md \
  "Read the attached task and return the final answer only." \
  > opencode.response.md \
  2> opencode.progress.log
```

### About read-only

I do not see a documented OpenCode CLI flag equivalent to Codex’s `--sandbox read-only`. OpenCode supports `opencode run` for automation and `--agent` for choosing an agent, but the run flags shown in the docs do not include a read-only sandbox or approval-never mode. ([OpenCode][5])

For strict no-write orchestration, wrap it externally:

```bash
docker run --rm \
  -v "$PWD:/workspace:ro" \
  -w /workspace \
  your-opencode-image \
  opencode run "$(cat task.md)" \
  > opencode.response.md \
  2> opencode.progress.log
```

## Practical summary

| Tool     | Non-interactive command | Prompt file pattern                         | Read-only control                                              | Plain final stdout |
| -------- | ----------------------- | ------------------------------------------- | -------------------------------------------------------------- | ------------------ |
| Codex    | `codex exec -`          | stdin                                       | `--sandbox read-only --ask-for-approval never`                 | yes                |
| Claude   | `claude -p`             | `-p "$(cat task.md)"` or pipe context       | `--tools "Read"` / disallow write tools                        | yes                |
| Gemini   | `gemini -p`             | `--prompt "$(cat task.md)"` or pipe stdin   | no exact CLI equivalent found; use sandbox/external RO wrapper | yes                |
| OpenCode | `opencode run`          | `opencode run "$(cat task.md)"` or `--file` | no exact CLI equivalent found; use external RO wrapper         | yes                |

For deterministic adjudication/review tasks, Claude is closest to Codex because you can explicitly restrict tools and pass a system prompt file. For Gemini and OpenCode, use filesystem-level enforcement if “must not write” is a hard requirement.

[1]: https://code.claude.com/docs/en/headless "Run Claude Code programmatically - Claude Code Docs"
[2]: https://code.claude.com/docs/en/cli-reference "CLI reference - Claude Code Docs"
[3]: https://google-gemini.github.io/gemini-cli/docs/cli/headless.html "Headless Mode | gemini-cli"
[4]: https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html "Gemini CLI Configuration | gemini-cli"
[5]: https://open-code.ai/en/docs/cli "OpenCode CLI: Run Prompts, Agents, Sessions, and Automation - OpenCode Docs"

