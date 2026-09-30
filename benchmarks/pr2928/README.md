# Results: PR 2928 matched large-workspace startup

**No speedup demonstrated.** PR medians were higher in this run. This is an observed comparison, not a causal estimate of a regression: the shared host and considerable within-PR block drift limit attribution. A small implementation regression is not ruled out. Do not promote the board-JSON materialization mechanism proof into a latency claim.

## Main results

Milliseconds; median [p25, p75]. Each cell has **n=10**. Delta is PR minus baseline; positive is slower.

| Route / metric | Baseline | PR | Delta ms | Delta % |
|---|---:|---:|---:|---:|
| Board: navigation → usable | 8,786.9 [8,683.6, 8,908.3] | 9,369.9 [8,897.7, 10,035.7] | +583.1 | +6.6% |
| Board: 120-branch request/ack | 59.3 [57.6, 64.5] | 75.0 [71.3, 90.7] | +15.7 | +26.5% |
| Board: 240-session request/ack | 63.5 [58.0, 64.9] | 75.4 [64.1, 84.5] | +11.8 | +18.6% |
| Conversation: navigation → usable | 3,779.9 [3,728.6, 3,840.6] | 3,958.9 [3,845.3, 4,521.1] | +179.0 | +4.7% |
| Conversation: 120-branch request/ack | 59.2 [56.5, 64.1] | 73.3 [65.6, 116.4] | +14.1 | +23.8% |
| Conversation: 240-session request/ack | 72.1 [66.2, 73.6] | 67.8 [59.1, 102.5] | -4.3 | -6.0% |

**40/40 measured navigations succeeded**, with zero page errors, zero Feathers request errors and zero navigation timeouts; 16 excluded warmups also succeeded. All samples, including slow outliers, are retained. Setup/pilot issues are listed in [METHOD.md](METHOD.md), not folded into or hidden from the experiment.

## Order drift / spread

| Block (chronological) | Board median ms | Conversation median ms |
|---|---:|---:|
| A1, 5 samples/route | 8,905.5 | 3,849.3 |
| B1, 5 samples/route | 8,820.5 | 3,939.1 |
| B2, 5 samples/route | 9,606.5 | 4,582.6 |
| A2, 5 samples/route | 8,656.7 | 3,737.3 |

The same B code moved from 8,820.5 to 9,606.5 ms on the board and 3,939.1 to 4,582.6 ms on the conversation between B1/B2. The AB board comparison was −1.0%; the BA comparison was +11.0%. This instability is larger than the pooled +6.6% board difference. Conversation AB/BA differences were +2.3% / +22.6%. No beneficial latency effect was detected; the data do not establish that the PR caused the slowdown.

Full measured navigation ranges: board A 8,389.6–9,175.7 / B 8,444.6–10,725.1 ms; conversation A 3,621.7–3,871.4 / B 3,581.0–5,378.5 ms. No small-n p95 is reported.

## Critical path and payload

- Board-scoped data acknowledgments were complete by a median 654.3 ms (A) / 706.1 ms (B), while the independent board readiness check completed at 8,786.9 / 9,369.9 ms. Recorded main-thread long tasks totaled median 6,339 / 6,903.5 ms. This points to browser-side rendering/layout/initialization as the dominant observed path, not the tens-of-milliseconds branch/session request. These are coarse browser observations, not component-level CPU attribution.
- Direct conversation still loads the board underneath it. Transcript fetch follows substantial browser work: in the first measured A sample, branch/session list requests finished before 0.8 s, session/task detail started near 2.95 s, messages finished near 3.35 s, and visible transcript readiness was 3.62 s. Across samples, long tasks totaled median 2,250.5 / 2,350.5 ms.
- External observer self-time was median 55.7 / 58.8 ms total for board navigation and 5.2 / 5.7 ms for conversation. The 100-ms stable-board-geometry condition is identical in both arms.
- Both arms issued 27 non-auth Feathers requests by board readiness and 32 by conversation readiness (custom presence events excluded). Main scoped responses were byte-identical in size: 139,410 bytes for 120 branches and 216,656 bytes for 240 sessions, including Socket.IO framing. Recent-50 sessions: 45,136 bytes; background full-150 branches: 174,216; full-300 sessions: 270,806. These are browser ack sizes, not SQL materialization sizes.
- No server enrichment instrumentation was inserted into the measured path. With these small 1,211-byte board JSON documents the old repeated join is a much smaller materialization workload than the earlier padded 64-placement fixture. The old **64 → 2 materializations / ~4.2 MB → ~131 KB** remains mechanism proof only, not a browser latency result. Tiny-board second-query overhead is untested.

## Fixture and equivalence

3 total boards, 8 zones, 150 branches, 300 completed sessions, 300 completed tasks and 1,200 synthetic messages; primary board 120 branches / 240 sessions. Populated-board JSON is 1,211 bytes each; empty automatic Main Board 97 bytes. Exact table hashes matched across 8 before/after snapshots, including both arms. Stable branch/session enrichment hashes and rendered transcript hash are identical. [verification.json](results/verification.json) records the assertions; [METHOD.md](METHOD.md) defines the external visible/hit-testable readiness contracts.

## Runtime / validity

PostgreSQL 16.14, application-role RLS, static tenant; production Vite frontend served by the real daemon, source-mode Node/tsx backend with development configuration. Chromium 153.0.8010.12, 1440×1000, same 16-vCPU AMD EPYC host/image. Fresh browser context per navigation, warm server/DB, preloaded synthetic auth with revalidation included, debugLoad off. Sequential A1/B1/B2/A2; no cross-arm concurrency. The host is shared; configuration is not a full production/HA deployment. Synthetic short transcripts and overview zoom, no active agents. No general production latency claim is justified.

## Frozen/served revisions

| Arm | Frozen backend/source commit (also asserted from `/health`) | Served frontend HTML SHA-256 |
|---|---|---|
| A | `122fe057e90a745208331dac690109d64ffcfcfa` | `24fcc0d84ccc1e4c37a797559c4c90a69bbe1101c65d6a5477b85ce1cfc41c97` |
| B | `e373b7069a483d2bb97ad91198d1ad6804f79047` | `ccb480da9abe37a2c092b8cc57e7ff3a4ec79eea02ebb5de25c0c7c211e19874` |

Every one of 453 built assets was fetched from the daemon and byte-verified for each attested arm. A1/A2 served HTML/assets and source hashes match; all arms have the same lockfile hash. Full per-file bundle hashes, aggregate source hashes, Git trees and image/runtime versions are in the attestation/environment JSON files. No source changes were made during measurements.

## Evidence and cleanup

Reproducer: `seed.mts`, `entrypoint.sh`, `compose-isolation.patch`, `switch.cjs`, `browser.mjs`, `attest.cjs`, `fingerprint.mts`, `record-environment.cjs`, `analyze.mjs`, `verify.mjs`. Raw: `results/{A1,B1,B2,A2}.jsonl`; excluded pilot and warmups are retained. `node benchmarks/pr2928/analyze.mjs && node benchmarks/pr2928/verify.mjs` regenerates and validates the analysis offline.

Managed research environment stopped; synthetic volumes preserved, no nuke. Temporary root compose change and served-UI symlink removed; clone returned to its research branch based on PR head. Original review preview, PR implementation, PR body, ready/CI/preview status and merge state were not changed. Evidence is committed only to this research branch.
