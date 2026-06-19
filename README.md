# Crucible

Crucible is an Obsidian plugin for turning capture, cleanup, ingestion, and AI-assisted note work into repeatable workflows.

It consolidates note materialization, templated captures, linting, attachment localization, command shortcuts, AI providers, agents, chains, tracker workflows, and vault search into one plugin.

## Features

- **Materialize notes:** Create daily, weekly, and monthly notes from templates, with matching asset folders and template variables.
- **Capture workflows:** Append, prepend, or section-insert templated text into target notes. Captures can prompt for `{{value}}` and can be used inside chains.
- **Agents and providers:** Configure OpenAI-compatible, Anthropic, Google, OpenRouter, and Ollama providers, then expose reusable agents as commands.
- **Chains:** Compose captures, linting, agents, file moves, metadata enrichment, and other Crucible commands into ordered workflows.
- **Lint and localize:** Normalize frontmatter, word counts, transcript formatting, derived IDs, attachment links, and local copies of remote or misplaced attachments.
- **Orchestration queue:** Run durable file-backed and transient memory-backed jobs for trackers, search indexing, daily brief generation, transcript refinement, link scans, and metadata enrichment.
- **Ingestion dashboard:** Monitor clippings, transcripts, blog and YouTube intake runs, uncaptured items, missing YouTube metadata, ignored IDs, queue state, and orphaned localized attachments.
- **Search companion:** Index vault notes through a user-run local search service, with commands for vault search, rebuilds, health checks, and active-note reindexing.
- **Settings and commands:** Open settings in a workspace tab, hide commands from Obsidian's palette, and optionally use Crucible's own command palette with fuzzy hints.

## Documentation

Start with [docs/index.md](docs/index.md).

- [Command reference](docs/commands.md)
- [Materialize and templates](docs/materialize-and-templates.md)
- [Captures, chains, and agents](docs/captures-chains-agents.md)
- [Lint and localize](docs/lint-and-localize.md)
- [Orchestration](docs/orchestration.md)
- [Tracked sources](docs/tracked-sources.md)
- [Ingestion dashboard](docs/ingestion-dashboard.md)
- [Search companion](docs/search-companion.md)

## Installation

Clone this repository into your vault's plugin folder, install dependencies, and build:

```bash
cd <Vault>/.obsidian/plugins
git clone <repo-url> obsidian-crucible
cd obsidian-crucible
npm install
npm run build
```

For local development, link the repository root into the vault plugin folder and run `npm run dev` in a separate terminal. Obsidian loads `main.js`, `manifest.json`, and `styles.css`.

## License

MIT
