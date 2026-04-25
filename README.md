# Personal Internet Plugin for Obsidian

This plugin bundles a variety of custom commands and interfaces for a personal workflow, replacing the need for several separate community plugins like Daily Notes, Templater, Shell Commands, Linter, and QuickAdd.

This project is based on the [Obsidian Sample Plugin](https://github.com/obsidianmd/obsidian-sample-plugin).

## Core Features

### 1. Materialize System
Automate the creation of organizational structures with custom commands and date-pickers:
- **Materialize Day/Week/Month:** Ensures the existence of date-based notes and folders (e.g., `daily/day/2026-04-24.md` and a matching folder).
- **Template Support:** Automatically applies templates with token replacement (`{{date}}`, `{{now}}`, `{{title}}`, etc.).
- **Smart Materialization:** Automatically materializes notes when clicking broken links to non-existent date files.

### 2. Linting Engine
A streamlined replacement for the Linter plugin, focused on essential metadata management:
- **Word Count:** Updates a `word-count` frontmatter property using accurate `Intl.Segmenter` logic.
- **Date Management:** Automatically manages `created` and `updated` properties based on file system metadata.
- **YAML Sorting:** Reorganizes frontmatter keys according to a user-defined priority list.
- **Lint on Save:** Optional automatic execution of linting rules whenever a file is modified.
- **Excluded Folders:** Define specific directories to skip during linting operations.

### 3. Shortcuts & Captures
Native-feeling interfaces to replace QuickAdd functionality:
- **Command Shortcuts:** Register custom commands to open specific files directly from the Command Palette.
- **Capture Workflows:** Define workflows to append or prepend text (with prompts) to daily notes or specific files.
- **Section Targeting:** Target specific markdown headers for captures (e.g., appending a thought under a `# Captures` header).

### 4. Floating Table of Contents
A clever, collapsible UI element for quick document navigation:
- **Collapsible Control:** A sleek, minimized charcoal box that expands to show document headers.
- **Configurable Position:** Anchor the ToC to any of the four corners of the editor.
- **hierarchical Indentation:** Visualizes your document's structure for easy scanning.

## Development

### Install
```bash
npm install
```

### Dev
```bash
npm run dev
```

### Production Build
```bash
npm run build
```

## Manual Installation
1. Copy `main.js`, `manifest.json`, and `styles.css` to your vault's plugin folder: `<Vault>/.obsidian/plugins/personal-internet/`
2. Reload Obsidian.
3. Enable **Personal Internet** in **Settings > Community plugins**.
