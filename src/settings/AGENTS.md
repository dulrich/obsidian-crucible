# src/settings/ — settings framework & AI/Orchestrate renderer split

Local instructions for the settings framework modules (`destructiveActions.ts`,
`modelCapabilities.ts`, `modelCatalogBrowser.ts`, `modelRefCollectors.ts`,
`providerModelProbe.ts`, `providerRefs.ts`, `bind.ts`, `shared.ts`) and the per-tab
renderers in `sections/`, plus `src/settings.ts` (tab shell) and `src/settingsView.ts`
(workspace-tab host). The root `AGENTS.md` is the canonical contract; this file adds what
is only true here, including the settings-chrome half of the fleet UI & UX Standards (the
design-law half — N1 language, icon mapping, pill taxonomy, destructive/reversible rules,
row-action-cell law — stays in root as fleet-wide law, not settings-local mechanics).

## UI & UX Standards — settings chrome

- **Grouped Cards:** All settings must be organized within `.crucible-settings-group` containers to match the native Obsidian "Options" look.
- **Inset Dividers:** Use `hr` with `.crucible-row-divider` for separators that don't touch the edges.
- **Widths:** Use the standardized CSS classes: `.pi-width-half` (150px), `.pi-width-normal` (300px), or `.pi-width-wide` (450px). NEVER use hardcoded pixel widths for controls in CSS.
- **Centering:** Vertical centering in settings rows is currently handled by the default Obsidian layout; do not attempt complex flex overrides without careful testing.
- **Tabs:** The settings page is divided into **Configure, Automate, AI, Orchestrator, Lint, Commands** (`CrucibleSettingsTab` in `src/settings.ts`; each tab's renderer lives in `src/settings/sections/`).
- **Fuzzy Search:** Use the custom `FileSuggest` and `FolderSuggest` classes for any file-path inputs.
- **List + edit pattern.** Tabs that manage a collection (Captures, Chains, Providers, Agents, Workflows) render a list of rows on the main view — each with an Enable toggle (when applicable) and a pencil button.
  - Editing flips into a per-item detail editor with a `← Back` button via the `editing*Index` / `editingWorkflowId` state on `CrucibleSettingTab`.
  - New collection-style tabs should follow this pattern instead of inlining all fields.

## Quirks index

The one-line hooks below say *where to walk*, not what to do — read the full entry before acting.

- New destructive controls register in `DESTRUCTIVE_ACTIONS` and route through `confirmDestructive` — never a bare `ConfirmModal`.
- AI/Orchestrate settings renderers are split by owned panel; pure settings-state logic lives in sibling modules.

## Quirks

Non-obvious Obsidian/runtime behaviors that bit us once and would bite again. Add entries here when a fix turned out to hinge on something the API docs don't surface — and add them to the **nearest** `AGENTS.md`, not automatically this one.

- **A new destructive control registers an action id in `DESTRUCTIVE_ACTIONS` and routes through `confirmDestructive` — never a bare `ConfirmModal` in settings/dashboard code.** `src/settings/destructiveActions.ts` is the framework (clsl WP-3/WP-4): a 25-entry registry (`{id, label, tier: critical|high|medium|low, group}`) plus `confirmDestructive(app, settings, actionId, { title?, message, impact? })`, which resolves suppression per-action → per-tier → global (`destructiveConfirmGlobal` default true; the "Destructive action confirmations" section on the Configure tab is the user surface) and shows the shared `ConfirmModal` only when required. Going around it means the user's suppression settings are silently ignored for that one control — which is exactly the audit finding that started this: 26 unconfirmed deletes with Provider as the lone ad-hoc exception. Rules that keep it sound: an unknown id fails safe (always confirms, plus a `logWarn`); a suppressed action must behave byte-identically to an unconfirmed click; entries with two UI entry points funnel through one helper (`deleteCapture`/`deleteTrigger`/`deleteAgent`/`deleteProvider`) so both confirm identically; `job-cancel` ships default-suppressed (`DEFAULT_SETTINGS.destructiveConfirmAction`) to preserve the queue monitor's one-click-cancel policy — still routed through the helper so it's overridable on. `tests/destructiveActionsWp4Retrofit.test.mjs` enforces the rule mechanically: every registry id must have a `confirmDestructive('<id>'` call site, and no `new ConfirmModal(` may appear under `src/settings/sections/`. Known gaps, deliberate: the three cache-clear buttons and Ignore/Unignore are not destructive (rebuildable/reversible); four pre-existing bulk confirms (orphaned-attachments "Cleanup all", queue "Clear queued", `search-rebuild-index`, `search-clear-query-log` — the latter two in `src/commands.ts`) still use a bare `ConfirmModal` and are unsuppressible; migrating them means adding registry ids first. The framework's `ConfirmDestructiveOptions` has no `confirmText` — every confirm button reads the modal default, which cost `deleteProvider` its custom "Delete provider" label; add the field to the framework if that ever matters, don't fork back to a bare modal.

- **AI/Orchestrate settings renderers are split by owned panel, and new pure settings-state logic goes in a sibling module — never inline in a renderer (rem-R4).** `sections/ai.ts` (40 lines) and `sections/orchestration.ts` (144) are entry points owning only the list/edit routing; the panels live in `aiProviders`/`aiProviderModels`/`aiAgents`/`aiAgentBinding` and `orchestrationQueue`/`orchestrationSearch`/`orchestrationIngestion`/`orchestrationWorkflows`, called in the exact pre-split DOM order. The describeModel-probe cache and catalog-entry resolution live in the dependency-free `src/settings/providerModelProbe.ts` (injected `describeModel` callback, no Obsidian import); the ref collectors in `src/settings/modelRefCollectors.ts` take `Provider[]`, not `CrucibleSettingTab`; `applyCatalogPick` (the catalog type-ahead pick's full effect) lives in `modelCapabilities.ts`. Keep renderer functions under ~150 lines and keep state transitions pure and importable — that separation is what let four of five source-text STRUCTURAL tests in `tests/providerModelConfigUI.test.mjs` become behavioral tests; don't regress a behavioral test back to reading source text when a pure function can be called instead.
