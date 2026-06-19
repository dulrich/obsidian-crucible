# Command Reference

Crucible registers commands through its command registry so they can be shown, hidden, and searched from the settings UI. Some commands are always present. Others are generated from configured shortcuts, captures, chains, and agents.

## Static Commands

### Materialize

| Command | ID |
|---|---|
| Materialize day: today | `materialize-day-today` |
| Materialize day: pick date | `materialize-day-picker` |
| Materialize week: current | `materialize-week-today` |
| Materialize week: pick week | `materialize-week-picker` |
| Materialize month: current | `materialize-month-today` |
| Materialize month: pick month | `materialize-month-picker` |

### Lint

| Command | ID |
|---|---|
| Lint: word count | `word-count` |
| Lint: all | `lint-note` |
| Lint: vault | `lint-vault` |
| Lint: cleanup transcript | `lint-cleanup-transcript` |
| Lint: localize attachments | `lint-localize-attachments` |
| Lint: localize attachments (vault) | `lint-localize-attachments-vault` |
| Lint: repair attachment links | `lint-repair-attachments` |
| Lint: repair attachment links (vault) | `lint-repair-attachments-vault` |
| Lint: update property in vault | `lint-rename-property` |
| Lint: remove property from vault | `lint-remove-property` |

`Lint: localize attachments` is intentionally separate from `Lint: all` because it can copy binary files and download remote URLs.

### Files

| Command | ID |
|---|---|
| Move current file to daily folder | configured move command ID |
| Move current file to folder... | configured move command ID |

The file move commands are available only when an active note exists.

### Ingestion

| Command | ID |
|---|---|
| Open ingestion dashboard | `open-ingestion-dashboard` |

### Orchestrations

| Command | ID |
|---|---|
| Orchestrate: scan | `orchestrator-scan` |
| Orchestrate: run next | `orchestrator-run-next` |
| Orchestrate: enqueue daily brief lite | `orchestrator-enqueue-daily-brief-lite` |
| Orchestrate: enqueue transcript refine | `orchestrator-enqueue-transcript-refine` |
| Orchestrate: enqueue YouTube tracker | `orchestrator-enqueue-youtube-tracker` |
| Orchestrate: enqueue YouTube tracker consolidation | `orchestrator-enqueue-youtube-tracker-consolidation` |
| YouTube: fetch video metadata for active note | `youtube-fetch-video-metadata` |
| Orchestrate: enqueue Blogs tracker | `orchestrator-enqueue-blogs-tracker` |
| Orchestrate: enqueue Blogs tracker consolidation | `orchestrator-enqueue-blogs-tracker-consolidation` |
| Orchestrate: enqueue link scan | `orchestrator-enqueue-link-scan` |

Enqueue commands create queue jobs. The runner decides when the work executes, applies pacing, and uses note locks for note-mutating work.

### Search

| Command | ID |
|---|---|
| Search: vault | `search-vault` |
| Search: sweep vault | `search-sweep-vault` |
| Search: check service health | `search-health` |
| Search: rebuild index | `search-rebuild-index` |
| Search: reindex active note | `search-reindex-active-note` |

Search commands require the search companion service when search indexing or querying is enabled.

### Other

| Command | ID |
|---|---|
| Mark as forwarded | `mark-as-forwarded` |
| Reload plugin | `reload-plugin` |
| Open settings in a tab | `open-settings-tab` |
| Open Crucible command palette | `open-crucible-command-palette` |
| Debug command palette hints | `command-palette-hint-debug` |

The Crucible command palette commands are available only when the optional Crucible command palette is enabled.

## Dynamic Commands

| Source | Command name pattern | Notes |
|---|---|---|
| Shortcuts | `Shortcut: <name>` | Opens the configured file or target. |
| Captures | `Capture: <name>` | Runs the configured capture template. |
| Chains | `Chain: <name>` | Runs configured steps in order. Mutating chains take the target note lock. |
| Agents | `Agent: <name>` | Runs the configured agent with its provider and prompt templates. |

Dynamic commands are rebuilt from settings. Renaming or deleting the configured item changes the command list after settings save or plugin reload.

## Visibility and Chain Behavior

Settings include command visibility controls. Hidden commands do not appear in Obsidian's command palette, but the underlying configuration can still exist.

Commands that have chain-internal implementations are queueable and can be used reliably as chain steps. Note-mutating commands and mutating chains serialize through the note lock so automatic lint/localize triggers do not modify the same note at the same time.
