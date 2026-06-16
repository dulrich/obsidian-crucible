# Search, Image Metadata Extraction, and Queue Notice Plan

## Summary

Add three coordinated changes: quiet routine queue notices by job type, generate persistent searchable metadata notes for localized images, and update search companion docs for SQLite/Postgres/Supabase setup expectations. Keep `runWorkflowWithTimeout` behavior unchanged; document no new AbortController work in this scope.

## Key Changes

- Add per-job-type routine notice suppression with defaults set to quiet for all job types. Suppress routine queued/promoted/already-queued/done notices; keep failures, disabled-workflow errors, parse errors, and explicit command feedback visible.
- Add a new image extraction feature toggle and provider/model selector, parallel to semantic embedding settings. Extend model capabilities with a vision/image-extraction capability and support API providers: OpenAI, Anthropic, Google, OpenRouter-compatible, and Ollama where the selected model is marked capable.
- Add a file-backed `image_metadata_extract` workflow. Localize enqueues it after writing or confirming an MD5-named localized image, only when the feature is enabled and the selected provider/model is configured and reachable enough to run.
- Store generated output as a sibling Markdown note beside the localized image: for `abc_MD5.webp`, create/update `abc_MD5.md`. The note includes frontmatter for resource path, MD5, extension, provider/model, extraction schema version, extracted timestamp, and source note paths, followed by `Description` and `Extracted text` sections.
- Re-extract automatically only when the extraction schema version changes. If another current sidecar with the same MD5 already exists elsewhere, reuse/copy its extracted content rather than calling the model again, then update resource-specific frontmatter.
- Let existing search indexing pick up the generated Markdown sidecar naturally; no companion DB schema change is needed for image text search.

## Public Interfaces / Types

- Extend `ProviderModelCapability` with an image/vision capability.
- Add settings for image extraction enabled state, provider/model ref, schema version/current prompt metadata, and per-job-type routine notice visibility.
- Add a new `JobType` for image metadata extraction with dedupe keyed by image MD5 plus schema version.
- Add docs-only search setup guidance in `docs/search-companion.md` for current local SQLite usage and the expected configuration values for standalone local Postgres and Supabase companion deployments, clearly noting that the bundled script remains SQLite-only.

## Test Plan

- Unit-test MD5 sidecar path generation, sidecar schema writing, current-schema skip behavior, and schema-version re-extraction.
- Unit-test localize enqueue behavior: one job per localized MD5 image, no enqueue when disabled, no enqueue without provider/model, and no duplicate enqueue for repeated embeds.
- Unit-test notice suppression helper/defaults so routine notices are quiet by default while failure notices still show.
- Add provider payload tests for image extraction request shaping where practical with mocked request calls.
- Run the mandatory cleanup loop before completion: `npm run lint`, `npx tsc -noEmit -skipLibCheck`, and `node esbuild.config.mjs production`.

## Assumptions

- "Online" means the configured provider/model is present and passes the same practical readiness checks the provider layer can do without an expensive extraction call; actual request failures are recorded on the job.
- Searchability comes from the generated Markdown companion note being indexed by the existing search pipeline.
- The docs work does not implement Postgres or Supabase backends.
