# Crucible: Capture — `{{value:oneline}}` whitespace-collapse token

## Context

Capture values can span multiple paragraphs in the source (e.g., a "Monthly Observation" selection), but some captures insert into a markdown list in the destination note. `insertIntoSection()` splices the payload as a single entry with internal newlines preserved, so blank lines inside the value break the list. The user wants an option to collapse any whitespace run into a single space.

Decision (confirmed with user): expose this as a **template token modifier** `{{value:oneline}}`, following the existing `{{datetime:FORMAT}}` precedent — per-use control, no Capture schema or settings-UI change. The user updates their Monthly Observation capture template to `- … {{value:oneline}}`.

## Changes

### 1. `src/utils.ts` — collapse helper + token replacement
- Add an exported helper near the other string utils (e.g., next to `slugify`, ~line 101):
  ```typescript
  export function collapseWhitespace(text: string): string {
  	return text.replace(/\s+/g, ' ').trim();
  }
  ```
- In `applyTemplateString()`'s `replaceTokens` (line 78–87), add alongside the `{{value}}` line (line 85):
  ```typescript
  result = result.replace(/{{value:oneline}}/g, collapseWhitespace(value));
  result = result.replace(/{{value}}/g, value);
  ```
  (The `{{value}}` regex requires `}}` immediately after `value`, so it cannot eat the modified token; ordering is cosmetic but keep the modifier first.)

No change needed in `src/captures.ts` — the capture pipeline already flows through `applyTemplateString()` at `src/captures.ts:69`.

### 2. `src/agents.ts:81` — keep the `{{input}}` alias consistent
`{{input}}` is rewritten to `{{value}}` before substitution. Generalize the rewrite so `{{input:oneline}}` (and any future modifier) also works:
```typescript
const userTemplate = (await this.resolvePrompt(agent, 'user') || '{{input}}').replace(/{{input(:[^}]*)?}}/g, '{{value$1}}');
```
(When the optional group doesn't match, `$1` substitutes as empty string — plain `{{input}}` still maps to `{{value}}`.)

### 3. `src/settings.ts` — document token in the variables panel
In `baseTemplateVariables()` (line 65), inside the `includeValue` block after the `value` entry (line 74):
```typescript
variables.push({ token: 'value:oneline', description: 'Runtime input collapsed to one line (whitespace runs → single space)', example: 'Para one. Para two.' });
```
This surfaces it in every template-variables panel that shows `{{value}}`, including the capture content editor (`automate.ts:651–652`).

### 4. `AGENTS.md` — docs
- **Template Engine** section (line 84 list): add after the `{{value}}` bullet:
  `- \`{{value:oneline}}\`: User input with all whitespace runs (including newlines/paragraph breaks) collapsed to single spaces — for inserting multi-paragraph input into list items.`
- **Quirks** section: one entry noting that `{{input}}` in agent prompts is rewritten to `{{value}}` via `/{{input(:[^}]*)?}}/` in `src/agents.ts`, so token modifiers like `:oneline` must survive that rewrite — any new `{{value:*}}` modifier automatically gets an `{{input:*}}` alias.

### 5. Test — `tests/templateTokens.test.mjs`
Follow the esbuild-bundle pattern from `tests/postId.test.mjs`: bundle `src/utils.ts` with an `obsidian` stub (must export `moment`, `Platform` since `utils.ts` imports them), set `globalThis.window = { moment: () => fakeMoment }`, and pass a fake `date` object (`{ format: () => '…' }`) to `applyTemplateString`. Cases:
- `collapseWhitespace('a  b\n\nc\td')` → `'a b c d'` (and trims edges)
- `applyTemplateString('- {{value:oneline}}', …)` with a multi-paragraph value → single line
- `{{value}}` still preserves newlines; both tokens coexist in one template

## Pre-implementation

Per workflow convention: copy this plan to `/home/_shared_code/obsidian-crucible/plans/` before starting.

## Verification

1. `npm test` — new template-token test plus existing suite.
2. `npm run build` — tsc type-check + production esbuild.
3. `npm run lint`.
4. Manual (Obsidian): create a capture with source "Selection", target a section containing a list, content template `- {{date}} {{value:oneline}}`; select a multi-paragraph passage and run the capture — confirm the destination list stays intact with the value on one line, and that the token appears in the capture editor's template-variables panel.
