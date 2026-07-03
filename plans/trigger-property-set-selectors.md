# Trigger Conditions: Property Sets and Typed Value Selectors

## Summary

- Add a new condition type, `Property value in set`, for matching one frontmatter property against multiple accepted values.
- Add an explicit selector type on property-value conditions so values can use text, tag, file, folder, or YouTube channel search controls.
- Apply the same condition behavior to Automate triggers and chain guard steps, since both share `GuardCondition`.

## Key Changes

- Extend `GuardConditionType` with `property-in-set` and include it in sync trigger-safe guard types.
- Extend `GuardCondition` with:
  - `values?: string[]` for set membership.
  - `valueKind?: 'text' | 'tag' | 'file' | 'folder' | 'youtube-channel'` for UI control selection.
- Runtime semantics:
  - `property-equals`: unchanged comparison behavior; `valueKind` only changes the editor control.
  - `property-in-set`: trim/ignore blank configured values; pass when the note property's scalar value equals any configured value.
  - If the frontmatter property is an array, pass when any scalar array item is in the configured set.
  - Matching remains exact and case-sensitive, which preserves YouTube `channelId` correctness.
- Keep existing saved conditions valid; missing `values` means no match, missing `valueKind` defaults to `text`.

## UI Changes

- In Automate trigger conditions and chain guard steps:
  - Add `Property value in set` to the condition type dropdown.
  - Add a `Value type` dropdown for `property-equals` and `property-in-set`.
  - Render values using the chosen type:
    - `text`: normal text input.
    - `tag`: tag input with a tag suggester.
    - `file`: existing `FileSuggest`.
    - `folder`: existing `FolderSuggest`.
    - `youtube-channel`: new suggester sourced from the configured YouTube channels registry; display `Channel Name (channelId)` and store only `channelId`.
- For `property-in-set`, render an editable list of value rows with add/remove controls; each row uses the selected value type's control.
- Add a small defaulting helper: when the property name is `channelId`, initialize new property-value conditions with `valueKind: 'youtube-channel'`; otherwise default to `text`. Users can override explicitly.

## Tests

- Add guard evaluator coverage for:
  - scalar `property-in-set` match and non-match.
  - frontmatter array value matching any configured set value.
  - blank configured values ignored.
  - existing `property-equals` still works.
- Add trigger adapter coverage for a `channelId` set condition matching multiple YouTube channels.
- Add lightweight suggester/helper tests where practical for YouTube channel option formatting and stored value selection.
- Before completion, run:
  - `npm run lint`
  - `npx tsc -noEmit -skipLibCheck`
  - `node esbuild.config.mjs production`
  - `npm test`

## Assumptions

- Selector type is explicitly stored per condition, with property-name-based defaults only for convenience.
- Multiple accepted values are stored as `string[]`, not parsed from a textarea.
- YouTube channel selector reads the existing configured channels registry and does not call the network.
