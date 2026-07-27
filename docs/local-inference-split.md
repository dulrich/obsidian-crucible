# Design record — should local inference become its own initiative repo?

**Status:** study, no code. **Decision requested:** does `crucible-inference` graduate out of
`obsidian-crucible/docker/llamacpp-vulkan/` into a standalone initiative repo with
obsidian-crucible and news-ingestion as consumers?

**Verdict up front: NO for now — defer the repo split, but move the *boundary* immediately.**
The split's whole value rests on an artifact that does not exist yet (a CPU entity-extraction
sidecar both repos would share). Doing the move today buys a cross-repo rename and pays a real
bind-mount hazard for zero shared surface. Doing nothing at all is also wrong, because the next
container to be built — the GLiNER2 CPU sibling — will otherwise be born inside a public Obsidian
plugin repo that has no business owning it. The recommendation in §7 is a staged one.

This record is written against a read-only survey of `docker/llamacpp-vulkan/`,
`docs/local-inference.md`, `src/providers/AGENTS.md`, `src/search/AGENTS.md`,
`/home/_shared_code/context-control/compose.home.yml` + `SERVICES.md`, and
`/home/_shared_code/news-ingestion/` (`AGENTS.md`, `enrich/`, `pipeline/`, `research_bench/`,
`references/enrich-footprint-and-service-eval.md`).

---

## 1. What exists today

### 1a. This fleet's `crucible-inference` (the candidate to move)

One always-on `llama-swap` v243 router on `127.0.0.1:4806`, image
`crucible-llamacpp-vulkan:b10121-swap243`, spawning `llama-server` children per-model on first
request and unloading them at `ttl: 1800`.

| Alias | Group | Policy | Role |
|---|---|---|---|
| `bge-m3` | `retrieval` | `swap:false exclusive:false` | embedding, f16, 1024d |
| `bge-reranker-v2` | `retrieval` | " | rerank, Q8_0, `/rerank` only |
| `gemma-4-12b` | `chat` | `swap:true exclusive:true` | chat, Q4_K_M, `-c 32768`, `--jinja` |
| `nemotron-4b` | `chat` | " | chat, Q4_K_M, small/fast |

Measured against the CPU (Infinity) shape it replaced: embedding **3.7 → 95.0 chunks/s** (25.7×),
reranking 30 docs **9.48 s → 0.280 s** (34×), cold spawn 1.3 s, warm request 67 ms.

Physical constraint that shapes everything below: an RX 9070 (gfx1201/RDNA4, **15.92 GiB**
nameplate) on a machine with a live desktop session holding ~3.1 GiB of it — realistic free VRAM
is ~12.8 GiB, and `exclusive: true` can only evict this router's own children, never another GPU
client. The full fit math (per-model weights, SWA-aware KV) is in `config.yaml`'s `chat` group
comment; it is the reason 26B/27B/31B/35B-A3B are excluded.

The whole movable surface is **848 lines across six files** (`Dockerfile` 143, `config.yaml` 192,
`entrypoint.sh` 54, `smoke-inference.sh` 196, `README.md` 249, `AGENTS.md` 14, plus the
`CLAUDE.md` symlink). Ownership is already split across two repos: the container definition lives
here, the service definition (ports, `/dev/dri`, `group_add 992/44`, `mem_limit: 24g`, the
`/home/_shared_models:/models:ro` and `config.yaml` bind mounts) lives in
`context-control/compose.home.yml`.

### 1b. news-ingestion's models (the candidate second consumer)

**Shape: no service, no container, no GPU.** news-ingestion runs entirely as host-side `uv`
projects against a shared Postgres (`localhost:5432`, db `news_ingestion`, one schema per tool).
Its only deployment artifact in the entire repo is a pair of **systemd user units** —
`pipeline/deploy/news-pipeline.{service,timer}`, a oneshot `uv run pipeline poll --once --write
--limit 200` every 5 minutes. There is no Dockerfile and no compose fragment anywhere in the repo.

The models live in **`enrich/`** (tool `enrich`, RW schema `crisis24_enrich`, RO `crisis24`):

- `enrich/src/enrich/ports.py` — `EmbedderPort` / `ExtractorPort` **Protocols** (the seam).
- `enrich/src/enrich/models.py` — `make_embedder()` → `BAAI/bge-small-en-v1.5` (384d) via
  `sentence-transformers`; `make_gliner2_extractor()` → `fastino/gliner2-base-v1` via `gliner2`,
  with a crisis24-tuned schema (7 entity labels + two zero-shot classifications, `severity` and
  `event_type`). **Both libraries are imported *inside* the factory**, behind an optional
  `[models]` extra, so the default venv and offline tests never pull torch.
- `enrich/src/enrich/materialize.py` + `cli.py` — `enrich run [--embed] [--extract]`: two
  independent batch passes, idempotent by text hash, writing `crisis24_enrich.event_embedding`
  (`float4[]`, no pgvector) and `crisis24_enrich.event_ner` (raw JSONB + derived flat features).
- Consumers: **`research_bench` only**, read-only over the Postgres schema —
  `exp_sidecar_predictive`, `exp_sidecar_blind`, `exp_analyst_topic_direction`, `db.py`. Nothing
  calls a model at read time; the experiments read materialized columns.

Measured footprint (`references/enrich-footprint-and-service-eval.md`, 2026-07-20):

| Model | Cold load | Download | RSS | CPU throughput |
|---|---|---|---|---|
| `bge-small-en-v1.5` | 13.2 s | 257 MB | ~1.0 GB | 301 ev/s |
| `gliner2-base-v1` | 15.2 s | **1.6 GB** | ~2.5 GB (cumulative) | **13 ev/s** |

Full 19,080-event corpus: ~63 s to embed, **~24.5 min to extract**. GLiNER2 is the whole budget.

**That repo already ran this exact decision and said no.** The same document defines four triggers
for graduating to a shared service — (1) latency-sensitive online use, (2) throughput wall,
(3) multi-repo reuse, (4) memory pressure — and concludes *"Run in-repo, in-process, as the
`enrich` batch tool. Do not build a shared service."* All four were negative in July. Any split
proposal has to argue against that finding on its own terms, not around it.

Two details in it are worth correcting for this record. **First, "this box, CPU-only (no GPU)" is
a torch fact, not a hardware fact.** The footprint was measured on *this same host* — `du-tower`,
24 logical cores, `mem_info_vram_total` 17,095,983,104 B, i.e. byte-identical to the figure in
`config.yaml`'s fit math. `torch.cuda.is_available()` is False because the GPU is AMD gfx1201, and
the fleet **forbids ROCm there** (`docker/llamacpp-vulkan/AGENTS.md`: invalid GPU programs are the
workload class that wedges this card; see `context-control/references/rdna4-gpu-hang.md`). So the
document's "GPU option (not used here): typically 10–50× the CPU rate" is not available on this
fleet by any near-term path. GLiNER2 is CPU-bound *here* for structural reasons, permanently.
**Second, the 301 ev/s figure does not transfer** — `src/search/AGENTS.md` already records that the
same model on the same CPU measures 20.1 chunks/s against realistic ~1,118-character vault chunks,
15× apart purely on sequence length. The two repos already cite each other's numbers; they should
not start sharing a service on the strength of a number measured on a different text distribution.

### 1c. The future entity leg

GLiNER2 is **not llama.cpp-servable** — it is an encoder (DebertaV2 backbone) plus a span head,
with no GGUF path. The agreed future shape is a small always-on **CPU sibling container** (ONNX
runtime, `crucible-search` shape, no GPU passthrough). Crucible's search-facet work is being
designed entity-source-agnostic this sprint, so nothing in the plugin is waiting on it.

---

## 2. Repo boundary

### 2a. What would move

| Artifact | From | Note |
|---|---|---|
| `Dockerfile`, `entrypoint.sh` | `docker/llamacpp-vulkan/` | GPU assertion + dual-use exec tail |
| `config.yaml` | " | the router contract; bind-mounted, never baked |
| `smoke-inference.sh` | " | host-run HTTP smoke, no Docker/systemd knowledge |
| `AGENTS.md` (+`CLAUDE.md` symlink) | " | the llvmpipe / capability-probe quirk family |
| `README.md` | " | build, upgrade, alias table, migration status |
| The `crucible-inference` service block | `context-control/compose.home.yml` | ~45 lines incl. comments |
| Operator half of `docs/local-inference.md` | `docs/` | §10 (RDNA4 worked example), §12a, parts of §5/§9 |

Compose ownership is the subtle one. Today `context-control` owns *every* fleet service, and the
inference block is 45 lines of hard-won commentary (why `group_add` is numeric, why `mem_limit` is
24g and not 4g, why the healthcheck means "router up" not "models loaded"). A split repo should own
the **service fragment** (its own `compose.yml` or an included fragment) while `context-control`
keeps the fleet composition — the same relationship `crucible-search` has today, where the build
context points into a sibling repo but the service block stays in the fleet file. Moving the whole
block out of `compose.home.yml` would be a bigger change than moving the container, and would break
`home-compose` as the single entry point.

### 2b. What must NOT move

- **All plugin client code.** `src/providers/*` (the `openai-compatible` kind, `apiBaseUrl`
  asymmetry, the optional API key, `looksLikeCrossEncoder`), `src/search/*` (embedding lifecycle,
  `embedding_space`, coverage-aware skip), `src/settings/sections/ai.ts`. These are consumer
  concerns and would be equally true against a hosted API.
- **The provider-seam quirks.** "A reranker is not an embedding model" belongs to
  `src/providers/AGENTS.md` because the trap is in the *client's* model picker, not the server. The
  container README's copy is a courtesy pointer, not the canonical entry.
- **Consumer-facing setup routes.** `docs/local-inference.md` §12b–§12f (LM Studio, Infinity,
  ollama, hosted, the companion itself) document how a *Crucible user* points a vault at whatever
  they already run. A public community plugin must keep those; they are not this fleet's service.
- **`scripts/search-companion.mjs` and `crucible-search`.** Different animal entirely — a
  dependency-free Node/SQLite index, schema-paired to the plugin binary
  (`SCHEMA_VERSION`/`SEARCH_REQUIRED_SCHEMA_VERSION`). It must stay lockstep with the plugin and
  has no business in an inference repo.
- **Measurement artifacts.** Already correctly homed in
  `/home/_shared_code/eval-harness/local-inference-bench/measurements/`.

### 2c. Coupling audit — how attached is the plugin, really?

Grepped for every in-repo reference to `llamacpp-vulkan` / `crucible-inference` / `4806`:

- **Zero code dependencies.** Two hits in `src/` are *comments* (`src/settings/modelCapabilities.ts`
  lines 181, 241) and one is a *test name* (`tests/providerModelConfigUI.test.mjs:504`). Nothing
  imports, reads, spawns, or hardcodes anything from `docker/llamacpp-vulkan/`. `DEFAULT_SETTINGS`
  ships `providers: []` — no base URL, no model id, no port.
- **Docs and plans only:** `AGENTS.md` (one table row), `src/providers/AGENTS.md`,
  `src/search/AGENTS.md`, `docs/local-inference.md`, `docs/search-companion.md`,
  `docs/multimodal-image-search.md`, and six historical `plans/*.md`.

The container is already a *sibling*, not a component. That is the strongest structural argument
that the split is cheap whenever it is wanted — and equally the argument that it is not urgent.

---

## 3. Merged service shape

If the split happens, the target is one repo owning a **two-tier local-inference fleet**:

```
GPU tier   crucible-inference   llama-swap router : one port, N GGUF children,
(exists)                        spawn-on-demand, ttl-unload, swap/exclusive groups.
                                Everything llama.cpp can serve: embed, rerank, chat, (vision).

CPU tier   <entity sidecar>     always-on, resident, no /dev/dri. ONNX runtime.
(future)                        Everything llama.cpp CANNOT serve: encoder+span-head models
                                (GLiNER2), classifier heads, anything torch/transformers-shaped.
```

The tiers are not stylistic. The GPU tier's whole design — one process, on-demand spawn, VRAM
eviction groups — exists because VRAM is 12.8 GiB and contended. The CPU tier's design is the
opposite: ~2.5 GiB of ordinary RAM, always resident, because the cost of *not* being resident is a
13–15 s cold load per call and there is no scarce resource to reclaim. A single "inference service"
abstraction over both would be a lie; two siblings under one repo is the honest shape.

**Port allocation is a real problem the split has to solve, not a formality.**
`context-control/SERVICES.md` defines the `48X0` decade as *"a tool's base port, and `48X1`+ are
that tool's own internal sidecar services"*, and `4800` is registered as **Obsidian Crucible's**
base. So `4801` (crucible-search) and `4806` (crucible-inference) are today allocated *inside the
Crucible plugin's decade* — which is exactly right while inference is a Crucible subfolder and
exactly wrong the moment it becomes a peer initiative with two consumers. A split repo needs its
own base (`4810`, say, with the entity sidecar at `4811`), and `4806` then becomes a compatibility
alias that must be kept alive because vaults store the URL. Two adjacent registry facts found in
passing: **`4806` is not registered in `SERVICES.md` at all** (neither were the retired 4802–4805),
and **`4760` is double-booked** — `SERVICES.md` assigns it to news-ingestion's labeling studio while
`compose.home.yml` runs `de-toda-la-vida` there. Both want fixing regardless of this decision.
(`config.yaml`'s `startPort: 5800` is container-internal and never published, so its collision with
the `57X0` dev-port convention is cosmetic — but a new repo should not inherit the coincidence
unexamined.)

**The alias contract becomes the cross-consumer API, and its blast radius grows.** Today
"append-only, never rename" protects one thing: Crucible vaults store aliases as `modelId` in
`data.json`, so a rename silently breaks every vault. Add news-ingestion and it also protects a
**database primary key** — `crisis24_enrich.event_embedding` and `event_ner` are both
`PRIMARY KEY (event_id, model)`. A renamed alias there does not error; it forks the store, leaving
19,080 orphan rows under the old name while a full re-materialization runs under the new one.
Cross-consumer, the rule needs one addition: **a consumer registry in the service repo** — who
stores which alias, and where — so the append-only rule is auditable rather than remembered.

---

## 4. Consumer contracts

### 4a. obsidian-crucible: optional dependency (already true, no work required)

"Optional dependency" is not aspirational here; it is the shipped default, and the split changes
none of it:

- `DEFAULT_SETTINGS`: `providers: []`, `searchSemanticEnabled: false`, `searchRerankEnabled: false`.
  A fresh install talks to nothing.
- The vector leg is **dimension-agnostic by requirement** — Crucible ships publicly, so no model
  and no base URL may be compiled in (`src/search/AGENTS.md`).
- Degradation is graded, not binary: no embedding provider → FTS-only; a query/index width or
  space mismatch → `runVectorLeg` sets `outcome.note` and falls back to `mode: 'fts'` rather than
  failing the search; a dead companion → `CompanionAvailabilityGate` with distinct probe-confirmed
  (5 min) and transient (5 s) offline windows.
- Concretely, a provider row is just `{kind: 'openai-compatible', baseUrl:
  'http://127.0.0.1:4806/v1', modelId: 'bge-m3', capabilities: [...]}` — user-entered. Repointing a
  vault at a different server is a base-URL edit, which is the entire reason the aliases were named
  after the ids vaults already stored.

The only thing the plugin owes a split repo is **documentation links** and the standing
capability-probe discipline (probe by response body, never status code).

### 4b. news-ingestion: what it consumes today, and what it would consume

**Today: nothing over HTTP.** In-process torch, batch, host-side, behind
`EmbedderPort`/`ExtractorPort`. Its output is consumed by `research_bench` through a read-only
Postgres schema read.

**Post-merge, the honest inventory of overlap is: zero shared artifacts today.**

| | crucible-inference serves | enrich needs |
|---|---|---|
| Embedding | `bge-m3` f16 **1024d**, GGUF/llama.cpp | `bge-small-en-v1.5` **384d**, sentence-transformers |
| Rerank | `bge-reranker-v2` Q8_0 | — (no rerank in the pipeline) |
| Chat | gemma-4-12b, nemotron-4b | — (uses hosted LLM SDKs for stage prompts) |
| Entity/NER | — (llama.cpp cannot serve it) | `gliner2-base-v1`, torch/DebertaV2 |

No shared model, no shared runtime, no shared weight file. The overlap is a *future* one: the
GLiNER2 CPU sidecar is the single artifact both repos would genuinely want — Crucible for the
entity facet, news-ingestion for `enrich run --extract`.

If the merge happened, the migration on news-ingestion's side is small and already anticipated:
its own eval says *"the `EmbedderPort` / `ExtractorPort` seam already isolates the model calls —
lifting them behind a service is then a localized change: the port stays, only the factory's
transport changes."* Concretely `models.py`'s two factories gain HTTP-backed siblings; `db.py`,
`materialize.py`, `features.py`, and every test double are untouched. The `[models]` extra becomes
unnecessary for a service-backed run, which removes a 1.9 GB download from the tool's setup path.

Two hazards that come with that, and they are not small:

1. **Switching the embedder is a re-materialization, not a config flip.** `model` is in the primary
   key and the row carries `dim`; moving from 384d `bge-small-en-v1.5` to 1024d `bge-m3` rewrites
   every row and invalidates every fitted experiment in `research_bench` (`exp_sidecar_predictive`,
   `exp_sidecar_blind`). This is the same class of trap as Crucible's `embedding_space` guard, but
   news-ingestion has no equivalent refusal-to-mix mechanism — it would simply write both. If a
   merge ever proceeds, adding an alias for the *existing* 384d model is the correct move, not
   migrating enrich onto `bge-m3`.
2. **GLiNER2's 13 ev/s is not fixed by this fleet's GPU.** Per §1b, ROCm is forbidden on gfx1201
   and there is no CUDA. A shared service moves *where* the CPU work happens; it does not make it
   faster. The honest gains would be residency (no 15.2 s cold load per invocation) and not
   downloading 1.6 GB into every consumer.

### 4c. What news-ingestion gains from the llama-swap learnings

Independent of any repo move, five transferable lessons — worth writing down even under a no-go:

1. **Spawn-on-demand + `ttl` beats socket activation.** This fleet deleted an entire systemd
   socket-activation apparatus (units, `-ctl`, `install.sh`) because llama-swap already does
   start-on-first-request and idle-unload in one process. news-ingestion's systemd-timer deployment
   is the same family of solution to a different problem; if it ever wants a resident model, the
   router pattern is strictly less machinery than a unit per model.
2. **Swap/exclusive groups are how you express a scarce-resource policy declaratively.** The
   `retrieval` (coexist) vs `chat` (evict everything) split is a two-line policy that would
   otherwise be scheduling code. RAM-tier sidecars need the same reasoning applied to RSS.
3. **Fit math before configuration.** The `chat` group comment computes weights from `stat`, KV
   from GGUF header metadata, SWA-aware, against *measured free* VRAM rather than nameplate — and
   that is what excluded four candidate models on evidence. The equivalent for a 2.5 GB GLiNER2
   sidecar co-resident with Postgres is one paragraph of the same discipline.
4. **A healthy service has told you nothing.** The four-instance quirk in
   `docker/llamacpp-vulkan/AGENTS.md` — `torch.cuda.is_available()` True on an image that dies on
   the first kernel; `llvmpipe` enumerating as a valid Vulkan device so a silent CPU fallback
   passes every healthcheck; LM Studio answering unknown endpoints with **HTTP 200**; a written API
   description not matching the wire format (`quant` vs `quantization`) — is directly reusable
   wherever news-ingestion adds a model runtime. **Probe by response body, never status code.**
5. **The smoke-test discipline.** `smoke-inference.sh` runs entirely over HTTP against the running
   service, touches neither Docker nor systemd, asserts *shapes* not values (vector length is
   reported, not asserted, because dimension is a model fact), includes a **negative** check that
   an unimplemented endpoint fails fast rather than hanging, and marks the slow `ttl` check as
   explicitly skipped rather than silently omitted. `enrich` has no equivalent live check today.

---

## 5. Migration cost and sequencing

Honest estimate for the full move, if taken:

| Step | Scope | Risk |
|---|---|---|
| New repo scaffold (`AGENTS.md`, `README`, `INITIATIVE.md`, git init on master) | ~0.2 kSLOC | none |
| `git mv` the six files | 848 lines, no edits | none |
| Repoint compose `build.context` + **both bind-mount absolute paths** | ~4 lines in `compose.home.yml` | **highest — see below** |
| `SERVICES.md` rows (new base decade, `4806` alias, backfill missing rows) | ~5 lines | none |
| Doc repoints in obsidian-crucible | 7 files, ~15 relative links | link rot only |
| `AGENTS.md` table row + `src/providers`/`src/search` "related areas" pointers | 3 edits | none |
| Split `docs/local-inference.md` operator half out (§10, §12a) | ~120 of 734 lines | judgement call |
| news-ingestion: nothing | — | — |

**Total ≈ 1.0–1.3 kSLOC touched, almost all of it moves or link edits.** No test changes, no
plugin code changes, no image rebuild (the image is tag-addressed and unaffected by where its
Dockerfile lives).

**What breaks during transition.** Exactly one thing, and it is sharp: `compose.home.yml`
bind-mounts `config.yaml` by **absolute path**
(`/home/_shared_code/obsidian-crucible/docker/llamacpp-vulkan/config.yaml:/app/config.yaml:ro`).
Move the file without updating compose in the same change and Docker does not error — it
**creates an empty directory at the source path** and mounts that, so llama-swap starts against a
directory-shaped config and the router fails to serve any model while the container itself looks
alive. That is precisely the fleet's recurring failure signature (a guard passes and the thing is
wrong), so the move must be one atomic change across both repos with a `smoke-inference.sh` run
immediately after. The `/models` mount is unaffected (already `/home/_shared_models`, moved out of
LM Studio's library on 2026-07-26 for this reason). Vault-side: nothing — the URL, port, and
aliases do not change, so no vault re-embeds and no provider row is edited.

**Rollback** is `git mv` back plus reverting one compose commit; the running container and its
image are untouched by either direction. There is no data migration and no schema pairing involved.

**Sequencing, if it is ever taken:** (1) new repo + scaffold; (2) atomic move + compose repoint +
smoke; (3) doc repoints in obsidian-crucible; (4) `SERVICES.md`; (5) *only then* build the entity
sidecar in the new repo; (6) news-ingestion's HTTP-backed `ExtractorPort` factory, last, as its own
decision with its own gates.

---

## 6. Deciding factors

Reusing news-ingestion's own four triggers, because they are the right ones and it is the repo
being asked to become a consumer:

| Trigger | Status | Note |
|---|---|---|
| 1. Latency-sensitive online use | **Not fired** | enrich is periodic batch. `pipeline`'s `gliner2@v1` fast_reject slot is a `NotImplementedError` stub awaiting labels — that is the latent online path, and it is not built. |
| 2. Throughput wall | **Not fired** | ~25 min for the full corpus, resumable and hash-idempotent. And this fleet's GPU cannot accelerate it (no CUDA, ROCm forbidden on gfx1201). |
| 3. Multi-repo reuse | **Not fired *yet* — and this is the whole question** | Zero shared models today. Fires the day a GLiNER2 sidecar exists that both repos want. |
| 4. Memory pressure | **Not fired** | ~2.5 GB peak in a process that starts and exits, not co-resident with Postgres. |

Two factors the enrich framework does not cover, both pointing *toward* an eventual split:

5. **Public-repo hygiene.** obsidian-crucible ships as an Obsidian community plugin. It currently
   carries a GPU container, a router config naming this host's GGUF paths, and VRAM math for one
   specific desktop machine. `runs/` was scrubbed from this repo's git history on 2026-07-26 for
   exactly this class of reason. This is a real argument, but it is a tidiness argument, not a
   capability one.
6. **Where the *next* container is born.** This is the decisive one. The entity sidecar is the
   first artifact with two genuine consumers. Building it under
   `obsidian-crucible/docker/gliner2-onnx/` would create the coupling the split is meant to
   prevent, and then the move becomes a move of *two* services with a live consumer attached
   instead of one with none.

---

## 7. Recommendation

**No-go on the repo split today. Go on the boundary, in three staged steps.**

**Stage 1 — now, costs nothing.** Leave `crucible-inference` exactly where it is. Record here (done)
that its home is provisional and that the trigger is the entity sidecar, not a date. Fix the two
registry defects found in passing: register `4806` in `context-control/SERVICES.md`, and resolve the
`4760` double-booking. Add the consumer-registry line to the alias contract in `config.yaml`'s
header — that vaults *and* (prospectively) a Postgres primary key depend on those names.

**Stage 2 — when the entity sidecar is actually wanted.** Create the initiative repo *then*, and
build the sidecar in it from day one. Move `docker/llamacpp-vulkan/` across in the same initiative,
per §5's sequencing, with the atomic compose repoint. At that point the repo has two services, two
consumers, a reason to exist, and a boundary that was chosen rather than inherited.

**Stage 3 — separately, on news-ingestion's own schedule.** Its `ExtractorPort` gains an HTTP
factory pointed at the sidecar, and only if it wants the residency win. Its embedder stays 384d
`bge-small-en-v1.5` — as an *appended alias*, never a migration to `bge-m3` (§4b hazard 1).

**Why not just do it now?** Because the move's benefit is entirely optionality, its cost is a
cross-repo atomic change with a silent-failure mode, and the coupling audit (§2c) proves the option
stays cheap: zero code dependencies, docs-only references, no tests, no image rebuild, no vault
impact. Splitting a repo to hold one service with one consumer, in anticipation of a second service
that has not been specified, is the version of this that ages badly. Splitting it the week the
second service is written is the version that does not.

**What would change the answer.** Any of: the entity sidecar getting scheduled; `pipeline`'s
`gliner2@v1` fast_reject slot getting implemented (that fires trigger 1 outright — an online
per-item path on the ingest hot loop); a third consumer appearing; or a decision to publish the
plugin's repo more widely under stricter hygiene rules.

---

## 8. Open questions for the user

1. **Is the GLiNER2 CPU sidecar actually scheduled, or is it a shape constraint only?** The
   sprint's Assumption 3 says "nothing this sprint runs a model for entities." If it lands next
   sprint, Stage 2 starts immediately and Stage 1 is nearly pointless. If it is a year out, this
   record should be re-read rather than executed.
2. **Which repo would own the new initiative — a new one, or does it fold into `context-control`?**
   `context-control` already owns the compose file, `SERVICES.md`, and the RDNA4 GPU reference. A
   `context-control/inference/` subtree is a third option this record did not assume, and it is
   cheaper than a new repo while still getting the artifact out of the public plugin.
3. **Does the entity sidecar serve Crucible over HTTP, or does the plugin stay entity-source-
   agnostic indefinitely?** §4 assumes both repos become HTTP consumers. If Crucible's facet ends
   up frontmatter-only, the sidecar has exactly one consumer (news-ingestion) and belongs in
   news-ingestion — which would make the answer to the whole split question a firmer no.
4. **Should `docs/local-inference.md` split now or at the move?** It is 734 lines serving two
   audiences (Crucible users choosing a route; this fleet's operator running `crucible-inference`).
   Splitting it is independently useful and does not require the repo move.
5. **Confirm the `4806` → new-decade transition would keep `4806` as a permanent alias.** Vaults
   store the base URL; a port change is a per-vault settings edit, which is the same class of
   breakage the alias rule exists to prevent.
