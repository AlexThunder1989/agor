# PR 2928 isolated startup experiment

Research-only evidence; this directory is not an application feature or a release benchmark gate. No implementation changes or PR-body edits are part of this branch.

## Frozen arms and isolation

- A: `122fe057e90a745208331dac690109d64ffcfcfa`
- B: `e373b7069a483d2bb97ad91198d1ad6804f79047`
- Research clone/managed branch: `01a0f235-f474-72ca-88b5-4cb9eb4506bb`, `benchmark-startup-2928-large-workspace`.
- Protected original preview `01a0f1be-4bed-77a2-bde2-6e06d42b1404` / UI 12286 was not changed, stopped, or used for requests.
- Inspected configured repository variants, selected `postgres` via `agor_environment_set`. All environment starts/stops use managed tools, targeting only the research branch. No repository-wide environment import.
- Temporary `compose-isolation.patch` removes provider-key passthrough and the host SSH mount, disables ordinary development/demo seeders, gives the image a research-only tag, retains project-owned dependency volumes, and selects the research entrypoint. No real worktrees, repositories, or agents are provisioned for fixture rows.
- One dedicated PostgreSQL database, fresh project-owned volume; app role `agor_app` is neither superuser nor BYPASSRLS. Static tenant `default`, normal capability policies initialized by repository utilities. No production database, tokens, credentials, or tenant content were queried/copied. Local synthetic authentication and generated deployment secrets stay inside the test environment; tokens are never retained in evidence.

## Fixture

`seed.mts` follows `packages/core/src/seed/demo-fixtures.ts`: source repository utilities create metadata and normalized permissions directly inside a tenant database transaction, without calling provisioning or execution services.

Deterministic logical IDs/content/layout, seeded once and **the same persisted snapshot reused across arms**. Repository-generated insertion timestamps and the daemon's automatic empty Main Board identity are not deterministic across fresh installations; exact raw fixture table hashes prove equality across this experiment's arms. `fixture-plan.json` retains the semantic seed hash. No rows are reseeded between measurements.

| Board | Zones | Branches | Sessions | Completed tasks | Board JSON bytes |
|---|---:|---:|---:|---:|---:|
| Benchmark Engineering | 4 | 120 | 240 | 240 | 1,211 |
| Benchmark Operations | 4 | 30 | 60 | 60 | 1,211 |
| Main Board (automatic, empty) | 0 | 0 | 0 | 0 | 97 |
| Total | 8 | 150 | 300 | 300 | 2,519 |

One synthetic local repo, one synthetic owner, 150 legitimate zone-relative branch placements. Each branch has notes, ref/base-ref, inert path metadata, owner, inherited capability policy and two completed sessions with title, description, model/effort, timestamps and task metadata. Every session has the same fixed four-message validation transcript: 1,200 messages total. The measured conversation is session `29280001-0005-7000-8000-000000000001`. No active sessions/tasks or generated live-agent events. Ordinary browser presence/subscription traffic is part of both arms.

The large board is an overview at fit-to-board zoom, not 120 simultaneously readable full-size cards. Four workflow zones, one short planning note, no deliberately inflated irrelevant JSON. This is a representative **synthetic large metadata/list workload**, not a claim about the distribution of real customer boards or long transcripts.

## Runtime and revision verification

Production Vite frontend (`NODE_ENV=production vite build`, gzip/static serving by the real daemon at `http://127.0.0.1:10292/ui/`). No Vite dev server or watcher, no timed compilation. The managed variant's nominal UI link on 12292 is not the URL benchmarked.

Backend: real daemon source entrypoint, Node + tsx with `--conditions=source`, development runtime configuration. This is **not a fully packaged production backend or HA deployment**. PostgreSQL 16.14 / pgvector image, static tenant with enforced RLS; no Redis/ingress/TLS/network-distance simulation. Both arms share lockfile, Docker image, machine, runtime flags, fixture and Chromium binary. See `environment-*.json` for exact versions, CPU, memory, load and image ID.

Before each arm's measured block, `attest.cjs`:

1. Asserts checkout HEAD equals the frozen SHA and that application/package source and lockfile have no tracked modifications relative to it.
2. Records Git tree ID, aggregate source hash and lockfile hash.
3. Reads actual daemon `/health` build SHA; each navigation independently asserts it too.
4. Fetches served HTML and **every built asset** and compares SHA-256 with the locally built bytes; records HTML/asset hashes. The source-mode daemon starts fresh only after checkout/build, and source is not changed during an arm's measurements.

The build-SHA environment stamp alone is not treated as proof; it is backed by clean frozen source, fresh process startup, and served bundle byte verification.

## Browser driver and readiness contract

`browser.mjs` is external and identical in A/B. `debugLoad` is absent/off; it does not read PR diagnostics for success. One headless Chromium process per block, a **new browser context/page per navigation** (empty browser HTTP/storage cache), 1440×1000 viewport, normal motion. Not a newly launched OS/browser process per sample. Server/DB/filesystem caches are warm, not flushed. Two complete board/conversation iterations per block are excluded warmups.

Synthetic local login happens once before each block and is excluded. The token is injected into each new context before application scripts. Navigation timing is `performance.now()` from the destination document's navigation time origin; it includes document/assets, normal auth revalidation/config load, socket work, app initialization, render and required layout settling, but excludes entering credentials and creating the browser context.

External readiness:

- **Board overview:** 120 branch nodes and at least 240 session rows in the real DOM; exact branch-001 title and its exact first session title; branch and session are visibly within the viewport/React Flow clipping region and pass `elementFromPoint` containment; branch width demonstrates fit-to-board zoom; its geometry is stable for 100 ms. This extra stability interval is applied identically.
- **Direct conversation:** expected fixed final assistant paragraph inside the actual conversation scroll container, visible within its clip and hit-testable. The receipt retains rendered transcript text/hash. A shell, spinner, empty canvas, loaded store, or PR timer cannot satisfy either check.

An external WebSocket wrapper observes actual Socket.IO request/ack messages. It records request start, ack receipt and client-observed duration, endpoint/method/query, count, serialized ack byte length, and a hash of stable branch/session enrichment fields. Authentication payloads/tokens are excluded. In raw samples the generic `error` field is meaningful only for Feathers records with a string `service`; custom presence events use a different one-argument acknowledgment shape and their truthy first argument is not a Feathers error. The analyzer excludes these custom events from endpoint/error totals. Durations include browser scheduling/network/serialization, **not pure SQL or server-only time**. Long Task API and resource timing provide coarse critical-path evidence. Observer CPU time is recorded to make measurement overhead visible.

## Design and analysis

Bounded order: **A1(5), B1(5), B2(5), A2(5)** measured iterations per route, i.e. an AB block followed by BA. B1/B2 use the same running B daemon but separate Chromium processes and fresh excluded warmups. All arms/runs execute sequentially. No second arm environment runs concurrently. The host is shared with other workloads, which were not stopped; load is recorded and is a validity limitation.

10 measured observations per route/arm; 40 measured navigations total. Another 16 warmup navigations are retained but excluded. Pilot runs are retained separately and never pooled. `analyze.mjs` reports median, interpolated p25/p75, min/max, absolute and percentage median change, block medians, all recorded failures/page errors and content hashes. No small-n p95 claim. Percentage change is `(PR / baseline - 1) * 100`, so negative is faster.

Request metrics distinguish the primary board-scoped 120-branch and 240-session requests from the initial recent-50 session request and background full-150/full-300 hydration. Endpoint totals/bytes remain in raw samples. There is no server enrichment instrumentation in the timed path, so do not interpret client durations as isolated enrichment cost.

## Setup failures, exclusions and limitations

Before any measured samples, initial source-mode boot attempts exposed missing deployment config, missing root workspace module link, then a fixture harness syntax error. These were corrected only in the benchmark entrypoint/harness. They are setup failures, not silently discarded route measurements. The early pilot used a broader DOM scan; `pilot-final` validated the final lower-overhead readiness observer before A1. All pilots are excluded.

The source-mode daemon also logged failure of its startup git-credential-scrub executor helper because the executor CLI was not built. Fixture paths are inert, there are no credentials to scrub, startup work had settled before warmups, and task/session tables stayed unchanged. No executor functionality is benchmarked. This is a limitation of this intentionally source-mode, metadata-only test, not a PR regression.

No causal claim from a handful of milliseconds: compare changes to spread and order drift. Cold server/DB startup, small boards, real network latency, active sessions, long/tool-heavy transcripts, HA/auth-resolved multi-tenancy and packaged-backend behavior are outside scope. In particular, the second board lookup can regress tiny-board work; this experiment does not test that tradeoff.

## Reproduce

Use a **new isolated research clone/managed branch**, never an existing preview or production DB. Adapt project/port names and `browser.mjs`/`attest.cjs` URL constants to the newly rendered managed commands; review the whole isolation patch before starting. This evidence's project is `agor-benchmark-startup-2928-large-workspace`.

1. Use `simple-git` to check out B and apply `compose-isolation.patch`. Keep this directory available on both detached arms. Do not change `.agor.yml` or import a repo-wide environment.
2. Inspect configured variants; select `postgres` with managed `agor_environment_set` and start with `agor_environment_start`. The entrypoint builds UI, ensures a private development config, migrates the owned database, seeds once, and starts the real daemon. Wait for managed health plus actual `/health`.
3. Pilot the driver and verify counts. The scripts use the session host's existing tool installations: Playwright `1.60.0-alpha-1774999321000`, simple-git `3.36.0`, Chromium installation `chromium-1243`. Exact Chromium version is in every raw row. Adjust module/executable paths if installed elsewhere; do not change versions mid-comparison.
4. Managed **stop** before each checkout. `node benchmarks/pr2928/switch.cjs A` or `B` uses simple-git, then managed **start**; never run both arms at once.
5. Before A1/B1/A2, run `node benchmarks/pr2928/attest.cjs BLOCK`, `node benchmarks/pr2928/record-environment.cjs BLOCK`, and `docker exec -e NODE_OPTIONS=--conditions=source OWN_CONTAINER node --import tsx benchmarks/pr2928/fingerprint.mts BLOCK`.
6. `node benchmarks/pr2928/browser.mjs A1 5`, then B1 5, B2 5, A2 5 in that order, with managed stops/checkout/starts at arm boundaries. Use a new results directory or clear only prior synthetic result files: JSONL output is append-only. Retain any failures.
7. Repeat fixture fingerprint after blocks, and run `node benchmarks/pr2928/analyze.mjs`. Verify raw table hashes, returned enrichment hashes, visible title and transcript hashes.
8. Stop only the research environment via managed stop; no nuke. Restore temporary compose modifications and return the research clone to its research branch. Preserve evidence, fixture volumes and source hashes. Normal commit/push of this research evidence is allowed; never push changes to either frozen implementation arm.
