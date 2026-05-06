# Crucible

An agentic second brain for Obsidian. Orchestrate your workflows, capture your reading, and synthesize insights.

Crucible consolidates features traditionally spread across multiple plugins (Daily Notes, Templater, QuickAdd, Linter) into a single, cohesive engine designed for intellectual digestion and sense-making.

## Features

- **Automated Note Materialization:** Seamlessly create daily, weekly, and monthly notes based on templates.
- **Workflow Captures:** Quickly append or prepend content to notes with custom templates.
- **Smart Linting:** Keep your properties and frontmatter clean and consistent automatically.
- **Table of Contents:** A floating, collapsible navigator for your long-form notes.
- **Command Shortcuts:** Map specific files to commands for instant access.
- **AI Agents:** Define reusable AI assistants with custom system prompts, user prompt templates, and a configured provider. Agents are registered as commands and can be invoked from the command palette or chained together.
- **Chains:** Compose multi-step workflows by linking captures, linting, and agent calls into a single command. Each step can pass its output to the next via `{{response}}`.
- **AI Providers:** Connect to OpenAI, Anthropic, Google (Gemini), OpenRouter, or a local Ollama instance. API keys are stored securely using Obsidian's secret storage.
- **Settings in a tab:** Open the full settings UI in a workspace tab via the *Open settings in a tab* command, side-by-side with your notes instead of buried in the modal.

## Installation

1. Search for "Crucible" in the Obsidian community plugins (Pending).
2. Or, clone this repository into your `.obsidian/plugins` folder and run `npm install && npm run build`.

## License

MIT
