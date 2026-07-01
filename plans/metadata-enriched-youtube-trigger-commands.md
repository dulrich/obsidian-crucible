# Metadata-Enriched YouTube Trigger Commands

## Summary

Add a new user trigger event for YouTube metadata enrichment, evaluated against the created/found metadata note for all enrichments. Extend trigger actions to support queueable Crucible commands via the existing `command_run` workflow. Add two queueable ingestion commands: ignore the target YouTube video and open/watch the target YouTube video.

## Key Changes

- Extend trigger types with `youtube-metadata-enriched` and a command action shape.
- Subscribe `TriggerRegistry` to the ingestion event bus and fire the new event against the metadata note.
- Update the trigger editor so command actions can select queueable Crucible commands and configure schema-backed args.
- Add queueable `youtube-ignore-video` and `youtube-watch-video` commands that derive `videoId`/`url` from the target metadata note.

## Tests

- Cover metadata-enriched trigger adaptation and command action seed generation.
- Cover video-id and URL derivation helpers used by the new ingestion commands.
- Run `npm run lint`, `npx tsc -noEmit -skipLibCheck`, and `node esbuild.config.mjs production`.

## Assumptions

- The trigger target for this event is the YouTube metadata note.
- Ignoring a video only writes to `_crucible/orchestration/ignored.md`.
- Existing dirty files are unrelated and must not be reverted.
