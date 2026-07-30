---
review-date: 2026-07-29
review-commit: b764f26f374406ee8437cec39fe895d1fdcea03a
review-type: tn-code-review
review-model: gpt-5.6-sol
review-harness: codex
review-effort: high
---
# Review — Obsidian Crucible whole-repository maintainability

*Recommended model/effort — Claude: Opus/high for the shared-contract and companion work;
Codex: gpt-5.6-sol/high for the same. The settings-only package can use Sonnet/medium or
gpt-5.6-terra/medium once its behavioral seams are pinned.*

| Tier | Open | Resolved |
|---|---:|---:|
| structural-regressions | 0 | 0 |
| simplification-misses | 0 | 0 |
| spaghetti | 0 | 0 |
| boundary-type-contracts | 2 | 0 |
| file-size | 1 | 0 |
| modularity | 1 | 0 |
| legibility | 0 | 0 |

## Context

Crucible has grown into a 70k-line plugin, companion, and test surface with strong behavioral
coverage and unusually detailed runtime invariants. This review asks whether those invariants are
represented in the architecture strongly enough to keep the next round of work from adding
optional-field recovery, giant edit surfaces, and implementation-shaped tests.

## Verdict

Not approved for further structural growth in the affected surfaces. The repository has strong
behavioral coverage and several deliberately documented runtime invariants, but four of those
invariants are currently represented as comments, optional fields, giant edit surfaces, or
source-text assertions instead of enforceable module and type boundaries.

This was a whole-repository review of `b764f26f374406ee8437cec39fe895d1fdcea03a`.
The review was read-only: no remediation code was written and no test suite was run. The
user-owned `FEEDBACK.md` remained unread and untouched.

## Findings

### F1 — Workflow outcomes do not encode their documented state invariants

**Tier:** boundary-type-contracts. **Severity:** high. **Priority:** P1.

`WorkflowResult` is one interface whose status-specific fields are all optional
(`src/orchestration/types.ts:73-105`), even though its own contract says
`serviceUnhealthy` is deferred-only. Both backends must recover the real state model
imperatively: `FileJobBackend` has a status ladder at
`src/orchestration/FileJobBackend.ts:348-367`, including a fallback for a failed result with no
error, and `applyCancellation` spreads one variant into another before clearing invalid fields
back to `undefined` (`src/orchestration/cancellation.ts:197-220`).

That leaves every workflow producer able to construct impossible combinations such as
`{status: 'done', error: ...}`, `{status: 'failed'}` without an error, or a failed result carrying
service-deferral data. This is not theoretical bookkeeping: the nearby contract records that
misclassifying a service deferral once produced 2,022 failure files. Existing tests distinguish
done/failed/deferred/cancelled behavior (`tests/workflowCancellation.test.mjs:149`) and pin
service-health data to deferrals (`tests/feedTrackerServiceHealth.test.mjs:150`), but the current
type cannot prevent malformed producers from compiling.

**Required design:** replace the optional-field bag with a discriminated union. Keep only genuine
common fields common; require `error` on failed results; allow retry/service fields only on
deferred results; and construct cancelled results cleanly rather than spreading and erasing fields.
Backend settlement must use an exhaustive switch with an `assertNever` backstop.

**Acceptance:** malformed status/field combinations fail type checking; both backends settle every
variant exhaustively; cancellation tests no longer expect invalid properties with `undefined`
values; all workflow producers compile without casts.

### F2 — Provider/model bindings admit invalid persisted states and duplicate their parser

**Tier:** boundary-type-contracts. **Severity:** medium-high. **Priority:** P2.

`AgentModelBinding` is modeled as a mode plus independently optional payloads
(`src/types.ts:463-475`). Runtime resolution therefore has to rediscover its invariants and issue
missing-pinned/missing-allow fallbacks (`src/agents.ts:128-173`). The settings renderer mutates the
mode tag in place without replacing the variant (`src/settings/sections/ai.ts:1112-1128`), then
lazily manufactures the corresponding optional payload during render
(`src/settings/sections/ai.ts:1141`, `:1222`). Persisted JSON can consequently retain stale pinned
data in runtime mode or represent pinned/constrained modes without their required payload.

The same boundary is duplicated because it lives in the wrong layer. `parseModelRef` is private in
`src/agents.ts:207-220`; `src/settings/providerRefs.ts:20-33` explicitly documents that it
reimplements the parser and must be kept in sync because importing the canonical function would
drag in the runtime/UI dependency graph. The happy-path tests in
`tests/providerRefs.test.mjs:82-111` do not exercise malformed binding shapes.

**Required design:** introduce an Obsidian-free provider/model contract module containing
`ProviderModelRef`, parse/format helpers, a discriminated `AgentModelBinding` union, and one
`normalizeAgentBinding(raw)` persistence boundary. Normalize old data during settings migration,
replace the entire variant when mode changes, and delete both private parser copies.

**Acceptance:** invalid bindings cannot be constructed after normalization; mode changes drop stale
variant data; all model-ref consumers share one parser; tests cover legacy/malformed JSON as well
as each valid variant.

### F3 — The search companion is four subsystems and an HTTP server in one 2,319-line module

**Tier:** file-size. **Severity:** high. **Priority:** P2.

`scripts/search-companion.mjs` owns schema creation/migration from line 292, a 169-line vector
backend at line 729, ranking and fusion from line 1087 through the 157-line `runSearch`, a
473-line request handler at line 1756, and process startup at line 2230. The handler alone owns
six endpoint branches; `/v1/chunks/upsert` occupies 164 lines and `/v1/search` another 75.

The hard threshold was crossed in commit `11369e9` when the vector-leg work grew the file from
576 to 1,048 lines; it has since more than doubled again. Tests already prove that cleaner seams
are viable: ranking/deadline helpers are imported directly by
`tests/searchCompanionDeadline.test.mjs:14`, while integration tests run the real handler against
an in-memory database (`tests/searchEmbeddingSpace.test.mjs:114`).

**Required design:** keep `scripts/search-companion.mjs` as a small executable and compatibility
re-export facade. Move schema/migrations, vector storage, ranking legs, endpoint handlers, and
startup into focused zero-dependency `.mjs` modules. Replace the serial route ladder with a small
explicit method/path dispatcher while preserving route-level transaction and deadline ownership.

**Acceptance:** no companion implementation file exceeds 1,000 lines; the facade remains directly
executable and preserves existing imports; endpoint modules state their injected dependencies;
schema/version pairing, loopback defaults, transactions, vector invalidation, deadlines, and all
existing integration tests remain unchanged.

### F4 — Settings rendering has become an untestable dependency knot

**Tier:** modularity. **Severity:** high. **Priority:** P2.

`src/settings/sections/ai.ts` combines provider CRUD, catalog probing, model-row state, agent CRUD,
and binding UI in 1,299 lines. `renderProviderModelsList` alone spans lines 498-865 and carries
44 nested callbacks, 25 save calls, and 11 full-tab rerenders. The Orchestrator settings file is
1,037 lines; `renderOrchestrationSettings` spans lines 187-686 and contains 94 nested callbacks
before five workflow-specific editors.

Both files crossed the 1,000-line threshold in recent commits: `ai.ts` moved from 996 to 1,051 in
`ab696f3`, and `orchestration.ts` from 971 to 1,004 in `cd7a0d0`. The test suite states the
architectural consequence directly. `tests/providerModelConfigUI.test.mjs:657-706` explains that
importing `ai.ts` drags the full settings/runtime graph, so it reads the source, brace-counts
function bodies, and regex-matches implementation text instead of executing the pure behavior.
Four other test files likewise inspect `src/` text for behavioral wiring.

**Required design:** split provider editor, model catalog, agent editor, binding editor, queue,
search, ingestion, and workflow settings into focused renderer modules. Extract catalog/probe,
binding, and row-state transitions into dependency-free functions. Keep the UI direct and
Obsidian-native—reuse `settings/bind.ts`; do not replace the large functions with a magical schema
or generic rendering DSL.

**Acceptance:** neither settings file exceeds 1,000 lines; no renderer exceeds roughly 150 lines
without a documented cohesive reason; pure state transitions are imported and executed in tests;
behavioral tests no longer parse `src/` text; labels, list/edit navigation, persistence timing,
destructive confirmations, and rerender behavior remain stable.

## Decisions locked

- This is behavior-preserving remediation. No user-facing feature, companion endpoint, persisted
  setting meaning, or search schema version changes as a side effect of cleanup.
- The 1,000-line rule is enforced by decomposition, not by moving the same monolith behind a
  barrel file or generated wrapper.
- New seams are explicit typed ports and pure functions. Do not introduce a general framework,
  service locator, settings DSL, or generic route magic.
- `scripts/search-companion.mjs` remains the executable compatibility facade and the companion
  remains dependency-free.
- The remediation is handed to a later orchestrator session. This review session does not execute
  it and does not register a `pending-plans` link.

## Summary

The code-judo move is to make the contracts already described in comments real. Two discriminated
unions delete defensive branching and invalid cleanup; focused companion modules turn a 2,319-line
shared edit surface into existing testable seams; focused settings modules make pure state
executable in tests instead of searchable as text.

## Key Changes

**WP-R1 — Make workflow outcomes a real state model.**
*~1.8 kSLOC touched, net-negative · ~220k tokens · ~17 min wall · top (Claude Opus/high;
Codex gpt-5.6-sol/high) · Claude: subagent (same-tier handoff adds ~20k normalized overhead
but supplies independent contract review); Codex: subagent (same-tier handoff adds ~20k
normalized overhead and preserves orchestrator context)*
Replace `WorkflowResult` with a discriminated union, migrate producers and both backends, and make
cancellation construction and settlement exhaustive. This needs top-tier reasoning because one
shared result contract crosses every workflow, cancellation, persistence, and service-health path.
Files: `src/orchestration/{types,JobBackend,FileJobBackend,MemoryJobBackend,cancellation}.ts`,
`src/orchestration/workflows/*.ts`, focused cancellation/service-health/backend tests.

**WP-R2 — Canonicalize provider/model contracts.**
*~1.2 kSLOC touched, net-negative · ~170k tokens · ~14 min wall · top (Claude Opus/high;
Codex gpt-5.6-sol/high) · Claude: subagent (same-tier handoff adds ~20k normalized overhead
but provides an independent persistence-migration review); Codex: subagent (same-tier handoff
adds ~20k normalized overhead and keeps migration verification outside the orchestrator context)*
Create the dependency-free model-ref/binding contract, normalize persisted variants during
migration, replace variants atomically in settings, and remove duplicate parsing and runtime
fallback branches. This needs top-tier reasoning because the type change crosses stored user data,
settings mutations, execution, chain overrides, and provider deletion guards.
Files: `src/types.ts`, a new pure provider/model contract module, `src/{agents,modelPicker,main}.ts`,
`src/settings/{providerRefs,sections/ai}.ts`, migration/provider-ref/agent tests.

**WP-R3 — Decompose the search companion behind a stable facade.**
*~2.7 kSLOC touched, net-negative target · ~230k tokens · ~18 min wall · top (Claude Opus/high;
Codex gpt-5.6-sol/high) · Claude: subagent (same-tier handoff adds ~20k normalized overhead
but buys an independent transaction/deadline review); Codex: subagent (same-tier handoff adds
~20k normalized overhead and protects the orchestrator from the large companion diff)*
Extract schema, vector storage, ranking, endpoint, and startup modules; leave a small executable
facade; and preserve every public export and runtime invariant. This needs top-tier reasoning
because transactional batching, deadline accounting, matrix invalidation, and schema migration are
coupled behavior even when their files are separated.
Files: `scripts/search-companion.mjs`, new `scripts/search-companion/*.mjs`,
`tests/searchCompanion*.test.mjs`, `tests/searchEmbeddingSpace.test.mjs`,
`tests/searchEntityFacet.test.mjs`, `tests/searchVaultIsolation.test.mjs`.

**WP-R4 — Split settings rendering and expose executable state seams.**
*~2.8 kSLOC touched, net-negative target · ~180k tokens · ~14 min wall · mid (Claude
Sonnet/medium; Codex gpt-5.6-terra/medium) · Claude: subagent (~29% normalized saving including
handoff overhead); Codex: subagent (~39% normalized saving including handoff overhead)*
Split the AI and Orchestrator settings by owned panel, extract pure transitions, and replace
source-text assertions with behavioral imports while preserving direct Obsidian UI code. Mid-tier
models are sufficient once WP-R2 pins the binding contract and the brief pins visible labels and
rerender behavior.
Files: `src/settings/sections/{ai,orchestration}.ts`, new focused renderer/state modules,
`tests/providerModelConfigUI.test.mjs`, and affected settings/orchestration UI tests.

## Public Interfaces

- `WorkflowResult` changes internally from an optional-field interface to a discriminated union;
  workflow behavior and persisted job statuses remain stable.
- `AgentModelBinding` becomes a discriminated persisted contract with an explicit legacy
  normalizer; existing user data must migrate without loss.
- Search companion HTTP paths, payloads, schema version, CLI arguments, loopback binding, and the
  current facade exports remain stable.
- Settings tab ids, labels, list/edit navigation, and persisted setting keys remain stable.

## Execution

WP-R1 and WP-R3 are independent and may run in parallel after the orchestrator prepares grounded
briefs. WP-R2 can also run beside WP-R1, but WP-R4 starts only after WP-R2 lands so the settings
split targets the final binding contract. The orchestrator reviews each diff, re-runs the
prescribed gates, and commits each package separately. Subagents never commit.

The later orchestrator must ask the user which implementation subagents to spawn before every
dispatch. No dispatch is authorized by this review record alone.

## Test Plan / Verification

For every package, add focused tests first and run the nearest child `AGENTS.md` gates. Before each
commit, run the root cleanup sequence verbatim and sequentially:

1. `npm run lint`
2. `npx tsc -noEmit -skipLibCheck`
3. `npm test` — no test/file-count drop from the pre-WP baseline, and never below the documented
   949 tests across 79 files
4. `node esbuild.config.mjs production`
5. Confirm all four processes exit 0.

Also run the repository-wide `console.*` gate with `grep -rna --include='*.ts' "console\." src/`,
and run `file` plus `LC_ALL=C grep -caP '\0'` on every touched or created file. WP-R3 must exercise
the real HTTP handler against in-memory SQLite, not only pure ranking helpers. WP-R4 must replace,
not merely supplement, the source-body parser assertions it makes obsolete.

## Critical Files

- `src/orchestration/types.ts`
- `src/orchestration/{JobBackend,FileJobBackend,MemoryJobBackend,cancellation}.ts`
- `src/types.ts`
- `src/agents.ts`
- `src/settings/providerRefs.ts`
- `src/settings/sections/{ai,orchestration}.ts`
- `scripts/search-companion.mjs`
- `src/search/AGENTS.md`
- `src/orchestration/AGENTS.md`

## Assumptions

- The current behavior and test expectations are authoritative; remediation does not reinterpret
  product semantics.
- Legacy settings may contain incomplete/stale binding objects, so normalization must be total and
  conservative rather than assuming only current UI-produced shapes.
- Companion decomposition uses relative local `.mjs` modules and adds no runtime dependency.
- Any UI-observable regression discovered during WP-R4 follows the repository rerun-packet
  protocol rather than expanding scope through speculative Obsidian-internal inspection.

**Total ≈ 8.5 kSLOC, ~800k raw tokens; ~808k Claude-path / ~790k Codex-path
Opus/Sol-equivalent tokens.**
