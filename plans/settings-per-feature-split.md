# Settings per-feature split

> Part 4 of 6 of the architectural cruft sweep. Independent — largest unit.
> Behavior-preserving refactor only. DO NOT change the settings schema or key names.

## Context

`src/settings.ts` is **2924 lines** — one `CrucibleSettingTab` with **178** `new Setting(` blocks
and **164** hand-written `onChange` handlers. Roughly a third of the file is the repeated
boilerplate pattern:

```ts
new Setting(containerEl)
  .setName('...')
  .setDesc('...')
  .addText(t => t.setValue(this.settings.x).onChange(async v => { this.settings.x = v; await this.save(); }));
```

The settings for distinct features (youtube, blogs, weather, localize, daily brief, providers,
periods) are interleaved in one giant `display()` with no module boundaries.

## Verified current shape (re-read before starting)

- `CrucibleSettingTab extends PluginSettingTab` (84) is the only class. Small pure helpers above it:
  `sortByNameWithEmptyLast` (35), `defaultCliCommand` (47), `modelIdPlaceholder` (57), `collectAllRefs` (72).
- The settings **type + DEFAULTS** are consumed by the load path; the migration logic lives in
  `main.ts` (`migrateSettings`, ~449) — leave both untouched.

## Target structure

```
src/settings/
  bind.ts                 # data-driven field helpers (see below)
  sections/
    general.ts youtube.ts blogs.ts weather.ts localize.ts dailyBrief.ts providers.ts periods.ts
src/settings.ts           # slim CrucibleSettingTab.display() -> ordered renderSection(...) calls
```

Field helpers kill the dominant boilerplate:

```ts
bindText(container, { name, desc, get: () => s.x, set: v => { s.x = v; }, placeholder }, save);
bindToggle(container, { name, desc, get, set }, save);
bindNumber(container, { name, desc, get, set, min, max }, save);
bindDropdown(container, { name, desc, options, get, set }, save);
```

Each helper encapsulates the `new Setting(...).addX(...).setValue(...).onChange(async v => { set; await save })`
chain. Each section module exports `render(tab, container)` and is called by `display()`.

## Steps

1. Add `src/settings/bind.ts` with the field helpers. Keep the `save` callback the tab already uses.
2. Move each feature's block of settings into its `sections/*.ts` module, replacing raw `new Setting`
   chains with `bind*` calls. Preserve order, names, descriptions, and persisted keys exactly.
3. Reduce `CrucibleSettingTab.display()` to ordered `renderSection(tab, container)` calls.
4. Keep the type + DEFAULTS where the load path expects them. Do not rename or restructure any setting key.
5. Confirm neither the tab nor any section file exceeds 1000 lines.

## Guardrails

- No file over 1000 lines.
- **No schema changes** — an existing `data.json` must keep loading with zero loss. Same key names, same defaults.
- The `bind*` helpers must be genuinely data-driven (no per-field copy of the chain) or this unit fails its purpose.

## Verification

- `npm run build` clean; `npm run lint` clean.
- Open Settings in a real vault: confirm every control reads its persisted value and writes back (toggle a
  few, reload the tab, reopen). Load an existing `data.json` and confirm no setting is dropped or reset.
