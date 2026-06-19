# Captures, Chains, and Agents

Crucible turns configured captures, chains, and agents into Obsidian commands. This makes workflows callable from the command palette, Crucible's optional command palette, hotkeys, and other Crucible chains.

## Captures

Captures insert templated text into configured target notes. A capture can prompt for user input and insert it with:

| Token | Meaning |
|---|---|
| `{{value}}` | Raw user input. |
| `{{value:oneline}}` | User input with whitespace collapsed to single spaces. Useful inside list items. |

Captures can target sections, append, prepend, or otherwise use the configured capture behavior. File and folder path fields use Crucible's fuzzy suggesters in settings.

## AI Providers and Agents

Providers define the model connection. Agents define reusable prompts on top of a provider. Agent commands are registered as `Agent: <name>` and can be run directly or from a chain.

API keys are stored through Obsidian's secret storage where supported. Provider configuration lives in plugin settings.

## Chains

Chains run a sequence of configured command steps. Steps can pass output forward with `{{response}}` where the receiving step supports templated input.

Important behavior:

- Chains are mutating by default. A mutating chain takes the target note lock.
- Read-only chains can be marked non-mutating so they skip note locking.
- Nested chains run awaited when registered as internal commands.
- Interactive picker commands are not a good fit for unattended chain steps because they require UI input.
- Note-mutating built-ins such as lint, localize, metadata fetch, captures, move-file commands, agents, and chains have internal command handlers so they can run as awaited chain steps.

The note lock matters: while a mutating chain owns a note, automatic lint/localize triggers skip that note instead of racing the chain.
