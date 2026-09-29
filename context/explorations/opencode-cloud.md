# OpenCode in Agor Cloud — design contract

> Status (2026-09-23): **Local implementation and independent review in progress; hosted QA paused.** Canonical design for
> running the OpenCode agentic tool inside Agor Cloud (hosted, delegated,
> ephemeral executor Jobs). The public runtime (`preset-io/agor`) owns every
> behavior described here; Agor Cloud (`preset-io/agor-cloud`) owns only
> Kubernetes realization and references this document. Acceptance scenarios
> live in [`qa/specs/opencode-cloud/`](../../qa/specs/opencode-cloud/README.md).

## 1. Problem

Hosted workspaces offer OpenCode in the agent picker, but every hosted path
fails: provider settings throw a generic "could not be loaded" error with a
Retry button, readiness reports "Status unavailable", session creation is
accepted, and the first prompt is refused with a `BadRequest`. Three
independent runtime guards cause this and must stay in place until the
capabilities they protect exist:

| Guard                                   | Owner                                                                                                     | Why it exists                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Hosted tenancy / delegated mode refusal | `packages/agentic-tool-opencode/src/daemon/credential-namespace.ts` (`assertOpenCodeNativeAuthSupported`) | Native credentials and state live in a daemon-local XDG home; hosted daemons have no per-user home boundary |
| Templated transport refusal             | `execution-admission.ts`; `startInteractiveExecutor` / `startContainedExecutorCommand`                    | Provider operations promise local process containment; a remote launcher cannot prove it                    |
| Branch SDK-home refusal                 | `apps/agor-daemon/src/branch-sdk-home.ts` (`branchSdkHomeUnsupportedReason`)                              | The XDG data home mixes credentials with relocatable state                                                  |

Removing the guards would run OpenCode with the daemon pod's home as its
state root, no credential delivery, and a live SQLite WAL on the tenant network
filesystem. This document specifies the smallest safe first release instead.

## 2. Scope of the first release

**In scope**

- Managed OpenCode Sessions in hosted (`required_from_auth`) workspaces that
  execute through the delegated ephemeral executor Job. Branch-scoped Sessions
  may be shared only through the tenant and Branch prompt-sharing gates;
  execution-home Sessions remain owner-bound.
- OpenCode's own pinned `provider.list()` / `provider.auth()` catalog and
  generic API-key credentials. The managed package captures a versioned,
  credential-free catalog artifact at build time; hosted settings read that
  artifact without starting OpenCode or maintaining an Agor provider/model
  list. Alpha and deprecated models, OAuth methods, and credential-free paths
  are not offered.
- Truthful unsupported/saved/connected/failed states in settings, readiness,
  session creation, and prompting.
- Durable native conversation state across executor Jobs, with an explicit
  recovery-point semantic (section 6).
- Stop, resume, disconnect, and explicitly requested Session-local deletion
  under ordinary Session/Branch delete authorization after a closure-proven
  delete run. Branch/user/tenant
  deletion and portability of affected native state remain unsupported.

**Explicitly out of scope (deferred, guarded fail-closed)**

- OAuth / subscription login in hosted mode (`connect-oauth` is refused with a
  structured reason; local mode keeps its existing OAuth path).
- Fork/adoption of OpenCode native state (`supportsSessionFork` remains
  `false`; a spawned Session keeps valid same-tool lineage or follows the new
  Session's Branch intent). Managed branch-scoped prompts use the protected
  per-Session checkpoint root and caller credentials, not a shared Branch
  state or credential home. Local native-file/OAuth mode remains separate and
  refuses unsupported branch-scoped sharing.
- A Branch SDK-home mount for OpenCode. New managed Sessions, including
  scheduled occurrences, follow sticky Branch intent and the existing
  `inherit`/`per_branch` setting; execution-home Sessions remain owner-bound.
- Configured/repository plugins, local MCP `command` servers, provider options
  other than a validated per-user endpoint, and remote auxiliary executor
  operations (discovery/verification Jobs). OpenCode's compiled-in plugins
  remain on; `OPENCODE_PURE=true` keeps user/repository/npm plugin discovery
  sealed.
- Any change to other agents' branch-home policy, Cloud's delegated execution
  mode, or the executor Job's network posture.

## 3. Trust and resource ownership

| Resource                                                                                              | Owner / boundary                                                                                                                                                                            | Persistence                                              | Delete / export                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider API key                                                                                      | Tenant + user + tool. Existing encrypted per-tool credential store `users.data.agentic_tools.opencode` (AES via `AGOR_MASTER_SECRET`, `apps/agor-daemon/src/services/users.ts`)             | Database row                                             | Deleted with the user row / tenant rows (existing)                                                                                                                                         |
| Projected credential at run time                                                                      | Task-scoped executor Job only. The executor uses the prompting actor's OpenCode connection through the existing task-scoped credential path. Credentials never become shared Session state. | Process memory of one Job; never written to disk by Agor | Nothing to delete                                                                                                                                                                          |
| Live native database (`opencode.db` + WAL), logs, state locks, cache, generated config, git snapshots | One executor Job, one task. All four `XDG_*` roots and `OPENCODE_DB` live on the Job's local scratch (`emptyDir`-backed `/tmp/agor-opencode/<taskId>`)                                      | Ephemeral                                                | Dies with the Job                                                                                                                                                                          |
| Published native checkpoint                                                                           | Immutable per-attempt object under the protected checkpoint root for exactly one Session; `storeId` is immutable Session authority.                                                         | Tenant filesystem; authority and retirement ledger in DB | Exact DB-committed tombstone or explicit Session-local delete receipt only; never inferred from age/order or directory enumeration. Broader deletion/export/import/re-home remains blocked |
| Accepted checkpoint pointer                                                                           | Session row plus same-tenant immutable attempt-ledger row; promoted only by the holder-qualified task completion transaction                                                                | Database                                                 | Not independently portable; affected handoff is rejected until separately authorized and fenced                                                                                            |
| OpenCode server password                                                                              | One Job, random per run                                                                                                                                                                     | Process env                                              | n/a                                                                                                                                                                                        |

Physical isolation of the persistent files is Cloud's per-user home `subPath`
(`home/cp-<hash(userId)>`), not the namespace key: a payload replayed with
another user's `namespaceKey` still resolves under the caller's own home and
cannot reach the other user's attempts. The namespace key only separates
tenants/users that could share one Unix home in local deployments. V3 also
binds every attempt to a DB-issued immutable `storeId`; task UUID order never
grants deletion authority.

Identity rules:

- The checkpoint namespace remains a stable Session lineage identity. The
  Session creator remains its owner, while each Task's trusted creator is the
  actor for credential lookup and checkpoint-holder authority.
- Knowing a session id, attempt id, or namespace key grants nothing; every
  read/write is authorized by the task credential and the row-locked task
  transition.
- The executor never receives an absolute daemon-side path. It receives a
  logical context (`namespaceKey`, `agorSessionId`, `taskId`, accepted
  checkpoint digest) and resolves paths under its own `$HOME`, which Cloud
  already mounts as the immutable per-user home (`/home/cp-<hash>`).
- Promise: cross-user and cross-tenant isolation plus controlled delivery. Not
  promised: protecting the owner's key from code the owner runs in their own
  Job (that requires a provider broker; deferred).

## 4. Credential authority

Exactly one authority applies per deployment, selected by the capability
resolver (section 8), never both:

| Authority            | Deployment                                                                                                    | Mechanism                                                                                                                                                                                                                                            | Status    |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `native-file`        | Local `simple`/`sandbox` without executor command template                                                    | Existing: `auth.json` in the daemon-owned namespace, mutated by contained local executor operations, OAuth supported                                                                                                                                 | Unchanged |
| `managed-projection` | Hosted + delegated + templated executor + `executor_storage.user_home: persistent-per-user` + operator opt-in | Per-provider entries encrypted in `users.data.agentic_tools.opencode`; the executor resolves only the Task actor's selected entry and writes it to private scratch `auth.json`; endpoint is separate scratch config; no daemon-side OpenCode process | New       |

The managed server consumes its internal `OPENCODE_AUTH_CONTENT` control value
before spawning OpenCode, writes the selected entry to mode-0600
`$XDG_DATA_HOME/opencode/auth.json`, then removes the value from the child
environment. OpenCode sees its native auth-file shape; the endpoint never
enters that file. OAuth refresh is excluded.

Storage shape: the existing per-user OpenCode bucket stores opaque encrypted
entries keyed by provider ID. Each entry has OpenCode's `{type:"api", key,
metadata?}` shape and an optional validated endpoint; Agor does not maintain
per-provider fields or interpret metadata. The three legacy fields
`OPENCODE_API_KEY_ANTHROPIC`, `OPENCODE_API_KEY_OPENAI`, and
`OPENCODE_API_KEY_KIMI_FOR_CODING` remain read-compatible; saving or removing a
matching provider also removes its legacy value. Presence is read without
decrypting. Saved IDs absent from the current catalog remain visible,
unavailable, and removable. Workspace-level (tenant) OpenCode connections are
not offered. Writes preserve the users service's last-writer-wins behavior.

The executor-scoped resolver returns only the Task actor's revalidated entry
for the Session's selected provider. The executor writes only `{type, key,
metadata?}` to scratch `auth.json`; a validated endpoint is written only to
scratch `provider.<id>.options.baseURL`. Neither value enters a task DTO. The
resolver never falls back to the Session creator. When there is no saved entry,
the actor's own Agor environment or credentials in their own persistent home
may satisfy OpenCode's connected-provider check; OpenCode home auth/config and
all inherited `OPENCODE_*` selectors stay excluded. The generic user-env path
does not carry saved provider entries. The selected key and serialized auth
content are explicitly registered with the managed-server sanitizer.

Saved keys are **saved, unverified**. Verification happens on the first
prompt: `assertExplicitModelAvailable` (existing) checks the provider is
connected and the model exists; a provider rejection surfaces as the existing
"reconnect provider" failure. No verification Job is spawned from settings.

## 5. Execution protocol (runtime ↔ executor ↔ Cloud)

Nothing new is added to the Cloud executor-run API. The existing chain is
reused unchanged: daemon `executor_command_template` → `agor-cloud-executor-launch`
→ `/executor-runs/start` + `/execute` → Job with the persistent per-user home
→ `agor-executor --stdin`. OpenCode-specific data travels inside the existing
executor payload:

```jsonc
// executorPayload (daemon → executor), OpenCode addition
"agenticToolContext": {
  "version": 3,
  "mode": "managed-projection",          // or "native-file" with the legacy dataHome
  "namespaceKey": "<sha256>",
  "agorSessionId": "<uuid>",
  "taskId": "<uuid>"
}
```

The payload carries no credential. After claiming a task, the executor resolves
only the prompting Task actor's selected provider entry, revalidates its generic
rules, and passes the selected auth object through the managed-server control
interface. The managed server writes only `{type, key, metadata?}` to mode-0600
scratch `auth.json`; the endpoint goes only to generated provider config. The
control value is removed before the child starts. The existing
`OPENCODE_CONFIG_CONTENT` / `OPENCODE_PERMISSION` interception values are set
by the executor as today. V3 payload carries no accepted pointer or
filesystem authority. The outer executor generates a per-invocation holder ID,
captures its immutable launch locator before payload environment application,
and obtains the input pin, store, exact holder binding, and current phases from
the daemon only after the DB admission transaction commits. Old managed v1/v2
contexts and legacy/uncertain homes fail closed; no pointer is imported or
silently reset. V3 manifests record the store ID, pinned OpenCode version, task,
size, digest, native session ID, and publication time. A different runtime
version refuses restore. Session/task/store IDs use canonical lowercase
spelling; UUID ordering is never eligibility or deletion authority.

Executor turn (managed-projection mode), across the executor adapter and
`OpenCodeTool.runTurn`:

1. Create a Job-private scratch root `<scratch>/<taskId>/` and point
   **all four** `XDG_*` roots and `OPENCODE_DB` at it. `<scratch>` is
   `AGOR_OPENCODE_SCRATCH_ROOT`, which Cloud pins to the `emptyDir` mount
   `/tmp/agor-opencode`; a managed turn fails before any provider call when the
   variable is absent or relative (there is no temp-directory fallback);
   `TMPDIR` is never consulted, and the executor's payload-environment boundary
   refuses a user-defined `AGOR_OPENCODE_SCRATCH_ROOT`, so neither can redirect
   live native state onto the network filesystem. Nothing OpenCode writes
   during the turn touches the network filesystem: logs, the `mkdir`-based
   state locks (whose staleness detection depends on mtime and would otherwise
   stall the next Job after a kill), cache, generated config, and the git
   snapshot object store are all Job-local. Cross-turn OpenCode "revert" is
   therefore not offered; Agor's own diff enrichment does not depend on it.
   The persistent home holds immutable `sessions/<sessionId>/stores/<storeId>/attempts/`
   objects. No output directory is created until the DB grant commits.
2. The outer executor calls `begin` before SDK/heartbeat/task-settlement work.
   A successful grant pins one DB-authoritative input object and reserves a
   distinct output for the exact holder. Copy the pinned input to scratch,
   verify the manifest/version/identity and copied bytes, close all source I/O,
   then acknowledge read-close. Missing or mismatched input fails before any
   provider call; it never starts an empty session.
3. Start the loopback server (existing `startManagedOpenCodeServer`), resume
   the grant's accepted input session ID or create a new session, run the prompt with
   the existing permission interception. In managed mode the executor does
   **not** patch `sdk_session_id` at native-session creation; the id is
   published only with the accepted checkpoint.
   Hosted configuration discovery is sealed before startup: project OpenCode
   config/component discovery is disabled, all inherited `OPENCODE_*` selectors
   are removed, and home/system configuration discovery uses empty scratch roots.
   The real execution `HOME` remains unchanged for tools. Built-in plugins stay
   enabled with `OPENCODE_PURE=true`; configured and repository plugins remain
   refused. The invocation validator refuses provider configuration overrides
   and attached local MCP commands. Remote MCP entries still come from the authorized
   Agor resolver. Repository OpenCode configuration is ignored, not merged.
   This is a configuration boundary, not a sandbox protecting a user's key from
   code the user explicitly runs in their own Job.
4. On a successful turn: close the server (existing bounded SIGTERM/SIGKILL),
   then run the **durability barrier**: open the scratch DB with `node:sqlite`
   (available unflagged in the executor image's Node 22.13),
   `PRAGMA wal_checkpoint(TRUNCATE)`, `PRAGMA integrity_check`, close; write
   the exact granted store's `attempts/<taskId>/opencode.db` via temp file + `fsync(file)` + `rename`,
   then `manifest.json` (sha256, bytes, `openCodeSessionId`, OpenCode version,
   task id) the same way, then `fsync(directory)`. Any failure → the turn is
   reported **failed** ("checkpoint not durable"); nothing is published.
5. Persist one immutable seal for the exact holder/manifest after all output
   I/O drains. The only ordinary pointer promotion is the holder-qualified
   completion transaction, taking Session before Task and ledger locks, and
   atomically completing the Task with the Session pointer/SDK ID. A terminal
   Task, duplicate/unadmitted holder, missing seal, changed locator, or retired
   object cannot publish or affect another holder's heartbeat, quiescence, or
   terminal result.
6. On failure, Stop, or abort: no publication. The scratch root is discarded
   with the Job. The session resumes from the previously accepted checkpoint.
7. After the input is copied, cleanup asks the DB for at most one operation
   when its bounded worker slot is ready. Only an already committed permanent
   tombstone authorizes exact-object deletion; age, UUID ordering, missing
   manifests, task terminality, and directory enumeration do not. Four
   round-robin lanes cover new retirement, failed deletion, unresolved-holder
   observation, and absent-object recheck. Healthy launches can reclaim
   eligible orphans, but this is conditional—not a storage bound or SLA.
   Unknown or stuck holders, idle Sessions, failed deletes, and tombstone
   history may remain indefinitely. Cleanup cannot block provider completion;
   a stuck worker is not reported closed and is not replaced in the same
   invocation. Before credential read the executor probes `node:sqlite` and
   resolves the scratch layout.

Cloud-side realization (agor-cloud): the Job template provides the immutable
per-user home; an `emptyDir`
with a `sizeLimit` is added at `/tmp/agor-opencode` on agent-task Jobs (not
shell pods). The kubelet enforces that limit by evicting the pod rather than
returning ENOSPC to the writer, so a turn that fills scratch ends as an evicted
pod and a failed run with no pointer published. A partial or manifest-less
attempt has no deletion authority until the DB commits retirement. The workspace runtime config's ephemeral-storage
limit is not guaranteed on legacy rows, which is why the volume carries its own
bound. Network
posture is unchanged (OpenCode binds `127.0.0.1` only; the pod has no
service-account token). Enablement uses the existing daemon config mechanism
(section 8), not a Cell API/console field or provisioning-spec mapping. The
hosting chart may supply this deployment policy by default; the generic runtime
default stays absent. A configured value never bypasses the prerequisites in
section 8 or supplies provider credentials. Cloud adds narrow daemon-side
identity-resolution and native-state-observation actions to the existing
runtime-internal route family; it never reads or deletes checkpoint bytes.
An independent, request/time-bounded observer records exact Pod UID, Job UID,
executor container ID, image identity, restart count, and termination time in
protected CAS-merged metadata before the one-hour Job TTL where possible.
Missing, stale, conflicting, or post-TTL evidence remains unknown and cannot
close a holder pin. This pre-TTL capture is an availability objective, not a
guarantee, and is detached from generic executor lifecycle reconciliation.

Publication first requires an existing non-empty database with the native
`session` table containing the completed session id; SQLite integrity alone is
not enough. A missing, empty, unrelated or wrong-session database fails the turn
without publishing a pointer.

## 6. Storage decision: checkpointed local DB versus block-backed live DB

Measured with the pinned `opencode` 1.14.33 executable and replayed on 1.18.31 (local, credential-free,
`serve` + session API; see `qa/specs/opencode-cloud/proof-log.md`):

| Question                                                                | Result                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does `OPENCODE_DB` move only the database?                              | Yes. `auth.json`, `log/`, config `.gitignore`, and state lock dirs stayed under the XDG roots; only `opencode.db{,-wal,-shm}` moved.                                                                                                                          |
| Is committed data durable across `SIGKILL` of `serve`?                  | Yes. Session created, server killed, restart on the same files: `session.get` 200.                                                                                                                                                                            |
| Is a copy of only `opencode.db` usable?                                 | **No.** Before checkpoint the main file was 4 KB with no schema; all rows were in the WAL (206 KB).                                                                                                                                                           |
| Is `db + wal` copy usable?                                              | Yes (row visible via sqlite3).                                                                                                                                                                                                                                |
| Does `wal_checkpoint(TRUNCATE)` after close yield one publishable file? | Yes. WAL → 0 bytes, `integrity_check` ok, resume from the single copied file: `session.get` 200.                                                                                                                                                              |
| Does SQLite fence a second writer?                                      | **No.** Two servers on one local DB both created sessions (2 rows). WAL is additionally unsupported on NFS.                                                                                                                                                   |
| Startup cost                                                            | ~1.1–1.4 s per `serve` readiness (local, warm).                                                                                                                                                                                                               |
| Marker quirk                                                            | With `OPENCODE_DB` outside the data root, every launch prints the one-time migration banner because the marker check reads `<data>/opencode.db`; the migration is a no-op without a `storage/` directory. Cosmetic; `OPENCODE_SKIP_MIGRATIONS` is not needed. |

Comparison:

|                     | A. Block PVC per session (RWOP)                                                                                                                     | B. Local DB + immutable checkpoint + DB-authorized publication (**selected**)                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live WAL location   | Block volume (supported)                                                                                                                            | Job-local disk (supported)                                                                                                                                                                                |
| Writer fence        | Attach controller only if the CSI honours RWOP; not a fence on `ontap-nas`/EFS; `gp2-enc-ebs` binds immediately to one AZ and pins every resume Job | DB-committed per-invocation holder grants, exact immutable store/task identity, input pins, one writer, and irreversible tombstones; requires acknowledged-commit durability and single-writer DB history |
| Failed/stopped turn | Keeps partial native rows Agor calls failed                                                                                                         | Loses that turn's native rows; conversation returns to the last accepted checkpoint                                                                                                                       |
| Lifecycle           | New volume object per session: delete, export, re-home, quota all need new code                                                                     | Exact DB-authorized retirement and explicit Session-local deletion; broader deletion/export/import/re-home remains blocked pending separately authorized whole-home drain/fence                           |
| Per-turn cost       | Attach/detach per Job, zone pinning, attachment limits                                                                                              | Copy ≤ tens of MB in/out per turn; checkpoint ~ms                                                                                                                                                         |
| New infrastructure  | Storage class validation, RWOP support, cost model                                                                                                  | None                                                                                                                                                                                                      |

Selected: **B**. Recovery-point semantic: a turn's native state becomes durable
only when Agor records the turn as completed. External effects of a failed or
stopped turn (tool writes, commits, API calls) are **not** rolled back and are
**never** replayed automatically; the transcript in Agor keeps whatever was
streamed. This is the same rule as today's runtime invariant "supervision does
not imply prompt replay or exactly-once external effects".

Not proven locally and deliberately left to future hosted QA/certification:
actual DB acknowledged-commit durability and single-writer behavior, fsync semantics on the
real FSx ONTAP / EFS mounts, cross-node resume, ephemeral-storage pressure
(full disk during checkpoint must fail the turn, not publish), and Job
replacement while a previous Job is unreachable.

## 7. Lifecycle, cancellation, and fencing

- **Stop**: the admitted holder must drain provider and live-file I/O, close its
  read pin/write state, and only then report holder-qualified quiescence. No
  generic acknowledgement is valid for a duplicate once any attempt exists or
  for a stuck cleanup child. A narrow pre-admission exception permits terminal
  settlement only after the Session→Task lock proves no attempt row exists and
  no provider or native-state I/O was started; an in-flight `begin` then cannot
  admit against the terminal/STOPPING Task. This is not holder authority and
  never releases an existing pin. Emergency exit leaves pins open for exact
  Cloud observation.
  After a managed output seals, exact Socket.IO acknowledgement/disconnect
  faults and transient service refusals retry the same holder's seal, fixed-ID
  message, and completion with a 15-minute retry-start budget per phase, using
  a monotonic clock. The deadline is checked after failed attempts, so the
  final in-flight request can exceed it by its bounded I/O timeout. A permanent
  refusal, revoked credential, or exhausted budget exits
  nonzero without abandoning possibly sealed output or manufacturing FAILED.
  Stale-heartbeat containment remains unverified for OpenCode; an owner may
  need to force-fail the Task after separate closure proof. This is recovery
  from an ambiguous response, not automatic replay of a provider turn.
  Templated containment stays "remote executor quiescence"; the OpenCode
  descriptor's `unverifiedTerminationReason` continues to mark substrate
  termination as unverified. Task terminality/force-fail is not process/I/O
  closure and does not release a pin. A stale admitted holder writes only its
  reserved object; the DB refuses its late publication once the Task is
  terminal. Its external effects are not rolled back or replayed.
- **Daemon death after launch, before executor claim**: unchanged (durable
  `dispatching` intent, reconciler warning, no automatic re-enqueue).
- **Node partition**: unchanged; the session remains non-promptable until
  quiescence or force-fail. No replacement writer is authorized by timeout.
- **Delete / revoke / offboard**: an authorized caller may explicitly delete
  Session-local v3 native state under ordinary Session/Branch delete
  authorization after the complete subtree is claimed, all
  holders and readers are proven closed, and a Cloud-bound delete run returns
  an exact file receipt. Retries retain the operation and run identity; a new
  token cannot authorize old callbacks, and Cloud must prove the preceding
  execution closed or never dispatched before another Pod starts. Unknown
  closure retains the Session and files. Legacy/unknown layouts and broader
  branch/user/tenant deletion still fail closed with
  `opencode_native_state_handoff_required`. Credential revocation remains
  independent and cannot close filesystem pins. No complete erasure promise
  is made by this slice.
- **Portability / re-home**: export/import/re-home containing affected native
  state is unsupported and rejected before deletion or filesystem
  materialization. Archives without native state retain existing behavior.
  An operator recovery needs separately authorized whole-home process/queued-
  launch drain or storage fence and a disjoint-store transfer; this design does
  not claim that procedure is implemented.
- **HA / two daemon replicas**: managed-projection has no daemon-local native
  state, so `opencode-auth`/`opencode-models` in that mode are database-backed
  and may be served by any replica; the constrained-HA gate becomes
  mode-conditional and keeps rejecting `native-file` in HA. Two replicas racing
  the same session are already fenced by the Session admission row.

## 8. Capability resolver and truthful UI

One resolver in `packages/agentic-tool-opencode/src/daemon/capabilities.ts`
replaces the scattered guards and returns:

```ts
type OpenCodeCapabilities =
  | { mode: 'native-file'; unixUserMode: 'simple' | 'sandbox' }
  | { mode: 'managed-projection' }
  | { mode: 'unsupported'; reason: { code: OpenCodeUnsupportedCode; message: string } };
```

`managed-projection` requires all of: `multi_tenancy.mode === 'required_from_auth'`,
`execution.unix_user_mode === 'delegated'`, `execution.executor_command_template`
set, `execution.executor_storage.user_home === 'persistent-per-user'`, the trusted
`execution.opencode_native_state_observer.command_template` set, and the
operator opt-in `agentic_tools.opencode_hosted_native_state: 'checkpointed'`
(default absent → unsupported with code `hosted_native_state_disabled`).
`native-file` requires the existing local conditions. Anything else is
`unsupported` with a stable code (`hosted_tenancy`, `delegated_execution`,
`templated_transport`, `persistent_user_home_required`, `native_state_observer_required`,
`hosted_native_state_disabled`).

Consumers (all read the same resolver): `opencode-auth` find/create/remove,
`opencode-models` find, session creation and tool switch (`sessions.ts`), scheduled occurrence admission
(`scheduler.ts`, sharing the interactive deployment gate), task
admission (`admitExecutor`), executor launch (`getExecutorLaunch`), the task
completion publication gate (`tasks.ts`), the executor credential resolver
(`config/resolve-api-key`, which serves OpenCode only the Task actor's selected,
revalidated provider entry), and the settings/readiness UI. The tenant policy
for OpenCode accepts only `user_required` or `user_preferred`; tenant-shared
provider keys are refused because the tool has no tenant-level fields. `opencode-auth.find` returns a 200 response with
`runtime: 'unsupported'` and the structured reason instead of throwing; the UI
renders a permanent capability notice without Retry, readiness shows
"Not available in this workspace", and New Session rejects OpenCode with the
same reason. In `managed-projection` the settings list shows the pinned
OpenCode catalog's API-auth providers with save/remove controls, presence
"Saved (verified on first prompt)", an optional endpoint field, and the
isolation notice that credentials are encrypted for the account and delivered
only to the Task actor's executor run. OAuth-only providers and providers
captured as credential-free are unavailable; the latter require a saved entry
even if OpenCode reports a connected path in the user's Job. The hosted catalog
is derived from the installed artifact, with alpha/deprecated models removed and
defaults recomputed using OpenCode's model order.

## 9. Invariants

1. Guards are removed only by the resolver granting a mode; every consumer
   fails closed on `unsupported`.
2. No absolute daemon path or credential value crosses the executor payload
   except inside `env` through the existing per-tool credential path.
3. A live SQLite WAL never resides on the tenant network filesystem.
4. Only the task terminal transition publishes a checkpoint pointer; terminal
   tasks are immutable; the executor never overwrites an accepted artifact.
5. A turn is reported completed only after its checkpoint is verified and
   fsynced.
6. Missing or mismatched accepted state fails the turn; it never silently
   starts an empty conversation.
7. Execution-home prompts remain owner-bound. Managed branch-scoped prompts
   use the existing tenant, Branch, and Session-sharing gates; permission
   interception and MCP tool gating remain in force.
8. Nothing here auto-replays prompts or claims exactly-once external effects.
9. Local `native-file` behavior and every other agent's branch-home policy are
   unchanged.
10. Every admitted persistent read/write has a durable exact-holder grant;
    accepted pointers refer to sealed, nonretired ledger objects.
11. Force-fail, heartbeat expiry, `/finish`, TTL, and missing evidence never
    close pins. Retirement is permanent; deletion needs an exact tombstone and
    no accepted pointer, open read pin, or writer.
12. Transparent recovery requires one authoritative DB history that preserves
    every acknowledged grant/pointer/tombstone and enforces a single writer.
    Lossy/uncertain failover is fenced recovery, not transparent reconnect.
13. Reclamation is conditional on later launches, exact death evidence, and
    successful filesystem work. No bounded storage, quota, or cleanup SLA is
    claimed.

## 10. Implementation sequence (slices, one branch per repository)

1. **Truthful unsupported behavior** (runtime): capability resolver, structured
   unsupported reason through `opencode-auth`/`opencode-models`, session
   creation/tool-switch refusal, UI notice/readiness without Retry. Ships
   independently.
2. **Credential store and projection** (runtime): generic encrypted per-provider
   entries with legacy reads, settings connect/disconnect in managed mode,
   executor-scoped selected-entry pull and scratch `auth.json` projection,
   endpoint-only scratch config, redaction coverage, mode-conditional HA gate.
3. **DB coordination** (runtime): v3 attempt ledger, immutable store and
   holder grants, input pins, sealing/publication, irreversible retirement,
   first-use/legacy gates, deletion and portability barriers.
4. **Outer executor lifecycle** (runtime): admission before SDK/heartbeat or
   terminal settlement, exact holder-bound terminal/quiescence/heartbeat paths,
   duplicate-loser no-effect behavior and real Stop/cancellation drain.
5. **Native I/O and conditional cleanup** (runtime): verified copy, durability
   barrier, exact permanent retirement tombstones, bounded fair launch-driven
   worker, no unsafe deletion/handoff.
6. **Cloud recovery** (agor-cloud): exact locator resolution, narrow observation
   routes, protected per-container observations, detached budgeted pre-TTL
   capture, fail-closed unknown state.
7. **Lifecycle/docs and integrated local gates**: explicit Session-local
   deletion, broader deletion/portability blocks, both PRs, tests and independent whole-diff review loops. Local review
   and validation do not prove deployed infrastructure safety. Formal hosted QA
   remains paused; no per-Cell toggle or generic-default change is introduced.

## 11. Proof

Developer checks: runtime ledger/outer lifecycle/native-I/O and Cloud exact
observation tests, PostgreSQL/SQLite parity, typecheck/lint, chart checks, and
the synthetic pinned-executable probe. These are local evidence only; they do
not verify actual DB failover, hosted storage semantics, Cloud identity
injection, or infrastructure rollout.

Formal QA (not run; requires Richard's continuation): the scenarios in
`qa/specs/opencode-cloud/` against a real Cell with the compatible executor
image, two tenants, two users in one tenant, two daemon replicas where
supported, a real reviewed provider key supplied through the secure form,
crash/kill points, full disk, node partition, deletion race, and exact deployed
revision attestation.

## 12. Resolved decisions and assumptions

- Hosted catalog comes from the version-matched managed OpenCode package
  artifact; no Agor-maintained provider/model/field list and no auxiliary
  discovery Jobs. The build fails if captured data contains a provider key.
  The daemon does not start OpenCode to serve hosted settings.
- Credential authority in hosted mode is the existing encrypted per-tool user
  store, not `auth.json`: the hosted daemon has no filesystem path to a user's
  executor home (it resolves only a delegated home key), and Cloud's per-user
  home segment is Cloud-private. This keeps the runtime Cloud-agnostic and
  reuses the store that already holds Claude/Codex/Gemini API keys.
- Storage: option B (section 6) after local proof; no per-session volume.
- Inherited agent-pod egress risk (Cloud isolation record R1/R2) is disclosed,
  not fixed here; the OpenCode server is loopback-only and the pod has no
  service-account token.

## 13. Approved support boundary and unverified prerequisites

1. **Durability/single writer**: support assumes one authoritative database
   history that never loses acknowledged grants, pointers, or tombstones, plus
   effective single-writer fencing. This is an implementation contract, not a
   verified fact about any deployed Cell. Lossy/uncertain failover/PITR/rollback
   requires fenced recovery.
2. **Reclamation**: deletion is conditional and launch-driven, not bounded by
   time/count/storage. Unknown death, idle Sessions, stuck I/O, and failed
   filesystem operations may retain state indefinitely.
3. **Compatibility**: only first-use v3 state and established-absence existing
   Cells are eligible. Legacy or uncertain installations fail closed until a
   separately authorized physical drain/migration decision; no importer is
   included.
4. **Deletion/portability**: explicit v3 Session-local deletion requires a
   closure-proven Cloud run and exact receipt; legacy or uncertain state and
   broader deletion/export/import/re-home remain blocked until separately
   authorized whole-home fencing and transfer support.
5. **No scope drift**: retain the Cloud chart's existing default, do not add a
   per-Cell toggle, leave generic runtime defaults and other agents unchanged.
6. **Hosted providers (revision 7)** — use the pinned OpenCode artifact and
   generic `api` entry shape; do not curate a provider allowlist. OAuth methods
   and all-OAuth providers are unavailable. Providers captured as connected
   without a credential require a caller-owned saved entry; keyless Zen/Go
   paths are not admitted. Providers that disappear from a later pinned catalog
   remain saved and removable. The pin bump is the catalog update boundary.
7. **Saved-unverified credential state** — accepted; verify on
   first prompt.
8. **Egress disclosure** — note the inherited agent-pod egress
   risk in the beta terms rather than blocking on the FQDN allowlist work.

### 13.6 Hosted provider boundary (revision 7)

The executor revalidates generic entry rules at delivery: `type: "api"`, a
non-empty key up to 64 KiB, at most 32 metadata values of at most 1 KiB each,
and no control characters. Metadata values containing `://` must be absolute
HTTPS URLs without userinfo; other metadata values must match
`^[A-Za-z0-9][A-Za-z0-9._-]*$`. An optional endpoint follows the same HTTPS/no-
userinfo rule at save and before launch and is scoped to the entry owner. The
daemon/settings/control plane never contacts it; the executor sets only
`provider.<id>.options.baseURL`. No address-range filter is claimed. DNS
rebinding is a documented residual limit until agent egress is separately
sealed.

Built-in plugins remain enabled and `OPENCODE_PURE=true` remains set. Configured
and repository plugins remain refused. Turn-time installation of an unbundled
provider SDK follows OpenCode's local behavior and is allowed; the package is
unpinned third-party code running in the actor's own Job alongside that actor's
credentials and executor token, so the user guide discloses the exposure.

Proof boundary: mock captures can verify transport and caller-key delivery,
not account-specific continuation. The OpenAI Responses API may return
`invalid_encrypted_content` when a later actor's OpenAI key belongs to a
different organization from the earlier turn; Azure OpenAI resource changes
are expected to have the same limitation. Agor does not edit history or fall
back to another user's credential. The accepted activation proof is the
separately authorized P11 provider exercise; all other providers and credential
paths remain mock-verified and unproven for cross-user continuation.

## 14. Open technical unknowns (do not change accepted behavior)

- Actual per-Cell DB topology, effective durability/single-writer/failover
  configuration, historical managed-state/image execution, executor fencing,
  and hosted filesystem durability/visibility are not established by local
  tests or checked-in configuration. Activation/hosted QA needs separately
  authorized operator evidence and certification.
- Ephemeral-storage `sizeLimit` for the scratch root (DB, WAL, logs, snapshot
  objects, copy buffers); the pod-template test pins whatever value QA
  confirms.

## 15. Independent design challenge (2026-09-10)

A fresh, read-only adversarial review of sections 4–8 found no launch blocker
and three high findings, all adopted above: publication must take the Session
lock before the Task lock and carry the pointer in an executor-managed task
field (section 5 step 5); credentials must use the executor's task-scoped pull,
not the generic user env loop, with static env-safe field names (section 4);
and the projected keys must be registered individually with the sanitizer
(section 4). Medium findings adopted: all `XDG_*` roots on Job-local scratch,
Cloud `emptyDir` `sizeLimit`, and the mode-conditional HA gate. The former
"prune all but accepted" behavior is superseded by the coordinated v3 ledger
and exact tombstones above. Scenario additions from the review are in
`qa/specs/opencode-cloud/scenarios.md` (OC-16, OC-31, OC-43, OC-54, OC-62).
The historical reviewer did not run code or verify NFS/executor-image behavior;
current implementation review is tracked separately, and formal hosted QA
remains paused.
