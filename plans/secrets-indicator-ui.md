# Secrets indicator UI in Crucible settings

## Context

Two places in Crucible settings let a user paste an API key into a password field that always renders as empty (we deliberately don't read the secret back into the UI). That hides whether a key is actually stored — users can't tell "is this configured?" without trying to use the feature. It also makes the "remove a provider" / "rotate a key" flow invisible: the only way to clear a stored secret today is to type something and re-save, or remove the provider entirely.

This change adds a small visual pattern: when a secret already exists in Obsidian Secret Storage, swap the empty password input for a static indicator ("API Key in Obsidian Secrets") plus a trash button that clears the secret. Clearing swaps back to the input so the user can paste a new key. We continue to never read the secret value into the DOM — only its existence (boolean).

Affected secrets:
1. **Provider API keys** — `src/settings.ts:1190-1201`, stored as `crucible-provider-${id}-key` via `ProviderManager` in `src/providers.ts:54-68`.
2. **YouTube Data API key** — `src/settings.ts:2299-2310`, stored as `crucible-youtube-data-api-key` via helpers in `src/orchestration/utils/youtubeApi.ts:9-17`.

## Approach

Add one reusable helper on `CrucibleSettingTab` (or as a local function in `settings.ts`) that mounts the right control onto a `Setting`:

```ts
// roughly
private mountSecretControl(setting: Setting, opts: {
  placeholder?: string;          // default 'Enter API key...'
  indicatorText?: string;        // default 'API Key in Obsidian Secrets'
  load: () => Promise<string>;   // returns '' when unset
  store: (v: string) => Promise<void>;
  clear: () => Promise<void>;
}): void
```

Behavior:
- Synchronously add the password input (current behavior) so the row paints immediately.
- Kick off `opts.load()`; if it resolves to a non-empty string, replace the input with the indicator UI: a small `<span>` reading "API Key in Obsidian Secrets" and an `addExtraButton(cb => cb.setIcon('trash').setTooltip('Clear API key'))` whose `onClick` calls `opts.clear()` then swaps back to the input.
- On the input's `onChange`, after a non-empty save via `opts.store(v)`, swap to the indicator.
- The swap is local to the Setting's control container — do not call `this.display()`, to preserve scroll position and not re-collapse expanded provider/workflow panes.

Reuse, don't duplicate: both call sites collapse to a few lines that build the `Setting` (name + desc) then call `mountSecretControl(...)`.

## Files to modify

1. **`src/settings.ts`** — add the `mountSecretControl` helper near the other private render helpers; replace the two existing `addText(t => { t.inputEl.type = 'password'; ... })` blocks at lines 1190-1201 and 2299-2310 with calls to the helper. The provider call passes `() => this.plugin.providerManager.loadApiKey(provider.id)`, `(v) => this.plugin.providerManager.storeApiKey(provider.id, v)`, `() => this.plugin.providerManager.deleteApiKey(provider.id)`. The YouTube call passes the equivalents from `youtubeApi.ts`.

2. **`src/orchestration/utils/youtubeApi.ts`** — add a `deleteYoutubeApiKey(app: App)` mirroring `ProviderManager.deleteApiKey` (set to empty string; Obsidian's SecretStorage doesn't expose an explicit delete — same pattern is already used at `src/providers.ts:64-68`). Export it; import it in `settings.ts` alongside `storeYoutubeApiKey`.

No changes to `types.ts`, `main.ts`, or storage keys. No new settings.

## Notes

- The "we don't load the key back into the UI" comment stays accurate in spirit — we only inspect length/emptiness of the loaded value, never render it.
- No confirmation modal on clear (matches the existing "trash provider" button at `src/settings.ts:1147`, which also deletes without confirmation). Accidental clears can be undone by pasting again.
- Use existing icon idiom `addExtraButton(cb => cb.setIcon('trash').setTooltip(...).onClick(...))` already used throughout the file.

## Verification

1. Build the plugin (`npm run build` or the project's usual command — check `package.json` scripts) and confirm no TypeScript errors.
2. Reload Obsidian with the plugin enabled.
3. **Provider flow:** Settings → AI → edit an API provider (e.g. OpenAI). With no key stored, confirm the password input shows. Paste a value; confirm the row swaps to the "API Key in Obsidian Secrets" + trash indicator without scroll jump or panel collapse. Reload Obsidian, reopen the provider, confirm the indicator is shown on load (proves the async existence check works). Click trash; confirm it swaps back to the input and the secret is cleared (re-open the provider to be sure).
4. **YouTube flow:** Settings → Orchestrator → edit YouTube Tracker workflow. Repeat the same paste / reload / clear cycle for the YouTube Data API key row.
5. **Cross-check:** run the `YouTube: fetch video metadata for active note` command after clearing the key — confirm it surfaces the existing "missing key" error path (proves clear actually clears the secret, not just the UI).
