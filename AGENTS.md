# Personal Internet Plugin (Development Guide)

## Project overview

- **Target:** Obsidian Community Plugin (TypeScript → bundled JavaScript).
- **Consolidation:** Replaces features from Daily Notes, Templater, Shell Commands, Linter, and QuickAdd.
- **Entry point:** `src/main.ts` compiled to `main.js` and loaded by Obsidian.
- **Artifacts:** `main.js`, `manifest.json`, and `styles.css`.

## Environment & tooling

- Node.js: use current LTS.
- **Bundler:** esbuild (configured via `esbuild.config.mjs`).
- **Types:** `obsidian` type definitions.

### Commands

```bash
npm install     # Install dependencies
npm run dev     # Watch for changes and hot-recompile
npm run build   # Production build with minification
```

## Core Loop

Agents must follow this cycle for every task:
1.  **Implement** the requested code changes.
2.  **Test** by running `npm run build` and `npm run lint`.
3.  **Fix** any TypeScript, bundling, or linting errors discovered.
4.  **Verify** both the build and linting succeed before reporting that the task is complete.

## File & folder conventions

- **Modular Architecture:** The project is split into functional modules to keep `main.ts` slim.
- **Source Structure**:
  ```
  src/
    main.ts           # Entry point, lifecycle, command/event registration
    settings.ts       # Settings tab UI and pane rendering
    types.ts          # Centralized TypeScript interfaces and DEFAULT_SETTINGS
    materialize.ts    # Logic for Day/Week/Month note and folder creation
    lint.ts           # Linting engine (word count, YAML formatting, date mgmt)
    captures.ts       # Capture execution logic and prompt modals
    toc.ts            # Table of Contents UI component
    suggesters.ts     # Fuzzy-search autocomplete classes for files/folders
    utils.ts          # Shared helpers (template replacement, folder checks)
  ```

## UI & UX Standards

- **Grouped Cards:** All settings must be organized within `.personal-internet-settings-group` containers to match the native Obsidian "Options" look.
- **Inset Dividers:** Use `hr` with `.personal-internet-row-divider` for separators that don't touch the edges.
- **Tabs:** The settings page is divided into "Settings", "Shortcuts", "Captures", "Lint", and "Variables".
- **Fuzzy Search:** Use the custom `FileSuggest` and `FolderSuggest` classes for any file-path inputs.

## Template Engine

Supported tokens in any template or property injection:
- `{{date}}`: Target date of the note (YYYY-MM-DD).
- `{{time}}`: Target time of the note (HH:mm).
- `{{today}}`: System date at invocation (YYYY-MM-DD).
- `{{now}}`: System ISO datetime at invocation.
- `{{title}}`: Resolved note title (from property or filename).
- `{{value}}`: User input (supported in Captures).
- `{{datetime:FORMAT}}`: Custom Moment.js format string.

## Coding Conventions

- **Safe YAML:** Always use `this.app.fileManager.processFrontMatter` for metadata updates to ensure structural integrity.
- **Recursive Safety:** Use the `isMaterializing` flag to wrap all plugin-driven file modifications to prevent infinite loops (especially with "Lint on Save").
- **Path Awareness:** Always check `isPathIgnored` from the `Linter` class before running automated note body operations.

## Testing

- Link the root directory to your vault:
  ```bash
  ln -s /path/to/plugin <Vault>/.obsidian/plugins/personal-internet
  ```
- Use the **Reload Plugin** command from the palette after a re-build.
