# Multi-Event Triggers and Channel Metadata Links

## Summary

- Allow one Automate trigger to listen to multiple note events with OR semantics.
- Fix Ingestion Dashboard -> Uncaptured videos so the Creator column opens the channel metadata note when one exists, falling back to YouTube only when it does not.

## Key Changes

- Update trigger types to support `on: { events: TriggerEvent[] }` while continuing to read existing saved `on: { event: TriggerEvent }` triggers.
- Update trigger adaptation/runtime matching so event triggers fire when the current event is included in the trigger's event list.
- Update the Automate trigger editor from a single event dropdown to a checkbox grid using existing `.crucible-checkbox-grid` styling.
- Keep at least one event selected; if a user tries to clear all, restore `create` as the default.
- Update trigger descriptions to show multiple events clearly, e.g. `on note created, note modified`.

## Dashboard Fix

- Add `channelAboutFile: TFile | null` to `UncapturedVideoRow`.
- Populate it in `computeUncapturedVideoRows` via `findExistingChannelAboutNote(app, root, channelId)`.
- In `renderUncapturedVideos`, render Creator with `this.renderFileLink(td, row.channelAboutFile, label)` when present.
- Preserve the current YouTube external link fallback via `renderChannelLink` when no channel metadata note exists.
- Do not change `renderChannelLink` globally, because other dashboard tables intentionally use it as an external fallback.

## Tests

- Add/extend trigger adapter tests for:
  - legacy single-event trigger still adapts and fires correctly;
  - multi-event trigger adapts to an event list;
  - multi-event trigger preserves existing job params/guards.
- Add or update dashboard data/render-facing tests where practical for the uncaptured video row carrying `channelAboutFile`; if DOM tests are not available, cover the data-row computation shape and rely on TypeScript for render wiring.
- Run the mandatory cleanup loop before reporting implementation complete:
  - `npm run lint`
  - `npx tsc -noEmit -skipLibCheck`
  - `node esbuild.config.mjs production`

## Assumptions

- Multiple selected trigger events mean "run on any selected event."
- A create+modify trigger may see both lifecycle events for the same note; existing queue dedupe remains the protection against duplicate queued work.
- On implementation start, remind the user to run `npm run dev` in a separate terminal for Obsidian hot reload.
