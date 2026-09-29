# Local proof log — OpenCode storage, durability, and cancellation inputs

Performed 2026-09-10 on macOS (darwin-arm64) with the pinned `opencode`
1.14.33 executable resolved from the workspace `node_modules`
(`opencode-darwin-arm64@1.14.33`). No provider credentials, no network beyond
loopback. These are developer verification results that informed the storage
decision in the design; they are **not** Cloud acceptance evidence.

## Run 1 — `local-spike-storage.mjs`

| Step                                                                                | Observation                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve` with `XDG_*` under a private home and `OPENCODE_DB` in a separate directory | Startup printed the one-time migration banner (marker check reads the XDG data root), then `opencode server listening on http://127.0.0.1:<port>`                                                                                                        |
| `POST /session`                                                                     | 200, session id returned                                                                                                                                                                                                                                 |
| `PUT /auth/anthropic` with a placeholder API key                                    | 200; `auth.json` (80 B, mode 0600 by OpenCode) written under `<XDG_DATA_HOME>/opencode/`, not next to the database                                                                                                                                       |
| Native file inventory after one session + one key                                   | `data/opencode/auth.json`, `data/opencode/log/<ts>.log`, `xdg-config/opencode/.gitignore`, `xdg-state/opencode/locks/<hash>.lock/{heartbeat,meta.json}`; database directory: `opencode.db` (4 KB), `opencode.db-shm` (32 KB), `opencode.db-wal` (206 KB) |
| `SIGKILL` the server                                                                | Files unchanged                                                                                                                                                                                                                                          |
| Copy only `opencode.db`, query with sqlite3                                         | `no such table: session` — the main file held no schema before the first checkpoint                                                                                                                                                                      |
| Copy `opencode.db` + `-wal`, query                                                  | 1 session row                                                                                                                                                                                                                                            |
| Restart with the same files, `GET /session/<id>`                                    | 200, same id (committed data survived SIGKILL)                                                                                                                                                                                                           |
| `GET /session/ses_doesnotexist`                                                     | 404                                                                                                                                                                                                                                                      |
| After `SIGTERM`                                                                     | Main file 168 KB, WAL 4 KB (the restart's `wal_checkpoint(PASSIVE)` moved data into the main file)                                                                                                                                                       |
| Restart **without** `OPENCODE_DB`                                                   | `GET /session/<id>` 404; a fresh `opencode.db` was created under the XDG data root (proves `OPENCODE_DB` placement, no accidental sharing)                                                                                                               |

## Run 2 — `local-spike-concurrency.mjs`

| Step                                                                 | Observation                                                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Two `serve` processes on one `OPENCODE_DB`                           | Startup 1354 ms and 1066 ms; both created sessions (2 rows); server A could read server B's session — SQLite provides **no** single-writer fence |
| Close server A with `SIGTERM`                                        | WAL 53 KB remained (no checkpoint at exit)                                                                                                       |
| `PRAGMA wal_checkpoint(TRUNCATE)` on the closed files                | `0                                                                                                                                               | 0   | 0`; WAL 0 bytes |
| Copy only `opencode.db` after checkpoint                             | 2 session rows, `integrity_check` ok                                                                                                             |
| Start a third server on that single copied file in a fresh directory | `GET /session/<id from A>` 200 — resume from a checkpointed single file works                                                                    |

## What this does and does not establish

Established: `OPENCODE_DB` separates only the database; credentials stay in the
XDG data home; committed transactions survive process kill; a main-file-only
copy before checkpoint is unusable; checkpoint-then-copy yields a single
consistent, resumable file; SQLite is not a writer fence.

Not established (Cloud QA): fsync behavior on FSx ONTAP / EFS, cross-node
resume, full-disk behavior during checkpoint, Job cancellation timing, and any
behavior involving a real provider.

## Slice 3 — hosted provider catalog and credential delivery (2026-09-29)

These are local checks on the 1.18.31 pin; all provider credentials and replies
were synthetic. No real provider request was made.

| Proof | Exercise and result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P16   | In local Linux Docker, built the artifact with the pinned Linux binary and compared the credential-free `provider.list()` and `provider.auth()` results: 214 provider records and 17 interactive auth methods matched. The artifact contained no provider `key`/`options`. For one connected OpenAI provider, an API-key-only synthetic entry produced the same 49 model IDs in turn-time `config.providers` as the served projection after the status rule. The daemon catalog path was separately unit-tested as artifact-only (no OpenCode process). **Pass.**                                    |
| P17   | Ran the pinned local binary with the production managed-server scratch layout and a loopback HTTPS OpenAI mock. One request reached `/v1/responses` with `Bearer synthetic-p17-key` and model `gpt-5-nano`; `auth.json` was mode `0600` and contained only `type`, `key`, and `metadata`, while the endpoint appeared only in `opencode.json`. The mock intentionally returned a synthetic 401 after capture. The raw provider list yielded 29 distinct `api.npm` packages. This is **partial**: the other packages, Azure `resourceName`, Bedrock, and Alice/Bob turn switching were not exercised. |
| P18   | Focused SQLite users/auth tests passed. The full restricted-role PostgreSQL Docker run exercised the added credential-inventory PostgreSQL suite; the overall run reported 493 passed and one unrelated branch-deletion-recovery failure. API/config resolver tests covered legacy reads, entry revalidation, actor/tool/provider scope, and no-key DTO projection. **Partial:** a malformed/oversized value written directly through the users service was not round-tripped through the executor resolver on both DB dialects.                                                                     |
| P19   | Provider-entry unit tests exercised the accepted/refused endpoint and metadata table and the delivery tests revalidate before launch. Daemon find/create/remove did not invoke a saved endpoint in the focused service tests. The explicit Alice/Bob shared-session endpoint separation and a network-call spy around all three daemon operations were not run.                                                                                                                                                                                                                                      |
| P20   | Repeated the loopback HTTPS OpenAI capture with no auth file and a synthetic `OPENAI_API_KEY` in the Task process environment. The pinned child sent exactly that value as `Bearer synthetic-p20-env-key` to `/v1/responses`; the scratch auth file remained absent. Connected/disconnected admission, platform-variable filtering, and caller-actor config selection are covered by unit tests. Caller-home credential delivery and the Alice/Bob negative were not exercised over the mock; P05's metadata canaries remain blocked with sandbox QA.                                                |
| P21   | Hosted binary config-boundary coverage verified configured/repository plugins do not execute; hosted environment tests preserve `OPENCODE_PURE=true`. The P17 turn reached OpenAI with OpenCode's built-in tool definitions enabled. Unbundled SDK installation into scratch (and its failure path) was not exercised.                                                                                                                                                                                                                                                                               |

The PostgreSQL command was `pnpm test:postgres:docker`; it verified the
restricted `agor_app` role (`NOSUPERUSER`, `NOBYPASSRLS`) and ended at
493 passed / 1 failed / 0 skipped across 96 files. The sole failure was
`branch-deletion-recovery.postgres.test.ts` (`test/branch-deletion-recovery.ts:362`).
The affected service, shared test harness, and PostgreSQL test sources match
`origin/main` at `95b14fa20fb477b9a110363ef54e6fecc0a43e5e`; the failure is thus
in the same baseline code, not this slice.

Focused commands also passed:

- `pnpm --filter @agor/agentic-tool-opencode exec vitest run src/shared/provider-catalog.test.ts src/runtime/hosted-config.test.ts src/runtime/opencode-tool.test.ts src/runtime/auth-handler.integration.test.ts src/ui/OpenCodeProviderSettings.test.tsx src/ui/OpenCodeModelSelector.test.tsx` — 89 passed, 1 skipped.
- `pnpm --filter @agor/executor exec vitest run src/handlers/sdk/opencode.test.ts` — 31 passed.
- `pnpm --filter @agor/core exec vitest run src/db/repositories/users.test.ts src/db/repositories/credential-inventory.reads.postgres.test.ts` — 25 passed; PostgreSQL case gated outside the Docker run.
- `pnpm --filter @agor/daemon exec vitest run src/integrations/opencode/auth-service.test.ts src/integrations/opencode/models-service.test.ts src/services/config.test.ts src/services/check-auth.test.ts src/hooks/classify-missing-credential.test.ts` — 148 passed.
- `pnpm check` — passed.

This local proof does not replace blocked Cloud evidence: P05 and P11 remain
unrun by authority. P17, P19, P20 and P21 are partial as called out above;
P16's Linux parity check did run.

## Run 3 — replay of both spikes against the 1.18.31 executable (2026-09-21)

After the branch was rebased onto a main that pins `opencode-darwin-arm64@1.18.31`,
both spikes were replayed unchanged against that executable. Every observation
above held: `OPENCODE_DB` places only the database; `auth.json` stays under the
XDG data home; the main-file-only copy before checkpoint still has no session
rows (the main file now carries the schema, but not the committed rows); the
`db + wal` copy has the row; `session.get` matches after a SIGKILL restart;
`wal_checkpoint(TRUNCATE)` on the closed files yields a consistent main-file
copy (`integrity_check` ok) that a third server resumes; two writers on one
`OPENCODE_DB` are still not fenced. Differences: the log file is now
`log/opencode.log`, and the generated `opencode.jsonc` appears under the XDG
config root. A separate loopback probe with `OPENCODE_AUTH_CONTENT` set and no
`auth.json` confirmed that the projected provider is reported as connected and
no credential file is written.

## Completion of reduced P17–P21 (2026-09-29)

The following observations supersede the partial local rows above. The executable
was the pinned 1.18.31 Darwin binary. Credentials, OAuth tokens, SDK package and
provider responses were synthetic; an HTTPS CONNECT mock intercepted outbound
traffic and never forwarded it. Provider definitions and model metadata came
from the binary, without SDK or model overrides. A saved endpoint was set only
on the compatible-provider entry. TLS verification was disabled only in these
throwaway mock children, not in product configuration.

- **P17:** Alice and Bob used one native Session per provider across fresh hosted
  scratch layouts: `llmgateway-providers` (`@ai-sdk/openai-compatible`),
  `openrouter`, `kimi-for-coding`, `zai`, `azure` with `resourceName`, and
  `amazon-bedrock` bearer credentials. Each capture contained the current actor's
  synthetic key, correct provider/model route, and only the selected entry in
  mode-0600 `auth.json`. The compatible-provider request reached its saved HTTPS
  endpoint; Azure reached the resource hostname derived from the actor's own
  metadata. OpenAI `/v1/responses` and Anthropic `/v1/messages` were captured
  separately with both actors, using their production definitions. Mock 401s
  prove delivery, not successful account continuation. Other catalog providers
  are covered through their credential shape; their SDK request format is
  unverified.
- **P18:** `config.opencode-provider-entry.postgres.test.ts` passes through the
  actual users service and Config resolver on SQLite and restricted-role
  PostgreSQL/RLS. Non-API, malformed JSON and oversized entries yield re-entry
  status without a connection or provider I/O. Alice's endpoint resolves only
  for her Task; Bob's Task receives no Alice entry. Keyless Zen and an all-OAuth
  provider are unavailable. Existing credential inventory/storage suites retain
  sequential saves, narrow removal, legacy and tenant-boundary coverage.
- **P19:** A network spy covers hosted `find`, `create` with a saved endpoint,
  and `remove`: no fetch or executor command occurs. The resolver shared-Session
  negative prevents Bob from receiving Alice's saved endpoint. Generic endpoint
  and metadata validation remains covered by the provider-catalog suite.
- **P20:** Alice's Vertex project/location environment and a synthetic
  service-account file under her own home produced an OAuth token request and
  a Vertex request carrying the mock access token. Bob resumed the same native
  Session with his own home and no Alice environment/file: no token or provider
  request occurred. No saved auth file existed in either scratch layout.
- **P21:** A loopback registry served a synthetic `@qvac/ai-sdk-provider` package
  to the pinned native installer. The package installed and executed under
  scratch. After native shutdown, the production checkpoint publisher sealed
  only `opencode.db` and `manifest.json` (258,048-byte DB), excluding SDK/cache,
  config and credentials. A fresh Bob layout with registry 404 returned
  `Failed to initialize provider: qvac`, without silently using Alice's package.
  The configured/repository plugin exclusion test also passed against the real
  binary with the exact hosted discovery environment.

Validation after merging main `504c7ec7`: `pnpm check` passed; tool-focused tests
48 passed/1 opt-in skipped, executor tests 31 passed, credential service tests
27 passed/1 PostgreSQL-gated skipped, Session header tests 28 passed. The real
binary hosted configuration test passed all 3 cases. Restricted-role PostgreSQL
reported 500 passed/2 failed/1 skipped across 97 files; the new provider-entry
case passed. The failures were the unchanged macOS branch-deletion recovery
case and a main timestamp assertion 3 ms outside its client-clock bound. The
latter passed all 4 cases in an isolated restricted-role replay; the original
aggregate failure is retained as a limit. These are local developer checks,
not Cloud/EFS or real-provider acceptance. The subsequent latest-main update
is validated separately before publication.

### Final review corrections

- Hosted defaults use the pinned runtime's ordering after filtering alpha/deprecated models; the regression reverses object order and the selected default.
- The local curated picker and its no-server regression remain unchanged from main. Hosted projection is separate.
- Hosted provider settings render unavailability reasons and disable OAuth-only entry creation while retaining saved-entry removal.
- Native layout and v3 manifest reuse canonical types; obsolete static credential-field resolution is removed and hosted admission/check-auth reuse the same availability projection.
- The existing Node.js 22.13 floor is retained and disclosed in the changelog.
- Focused executor suites: 42 passed. Focused daemon credential/check-auth/classification suites: 89 passed, 1 PostgreSQL-only skip. Full source checks pass after remediation. Independent focused review and hosted acceptance remain pending.
