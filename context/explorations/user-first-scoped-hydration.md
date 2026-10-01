# User-first, board-scoped hydration

Status: design, revised 2026-10-01 to ship as **one branch and one PR**, reviewable commit by commit. Code baseline: `main` @ `ce9d64f`.

Paths are repo-relative. `UI` = `apps/agor-ui/src`, `D` = `apps/agor-daemon/src`, `core` = `packages/core/src`.

## 0. Summary

Today the UI paints a slice of data first, then pulls in the whole workspace in the background ("hydration"). Correctness relies on that background pass, and the pass is slow and can starve. This design moves to three layers:

1. **Global light data, loaded eagerly.** Lean boards, users, repos, card types, plus the small workspace collections already loaded in the background.
2. **The current user's data, loaded eagerly and bounded.** My recent sessions, plus server-computed summaries per board.
3. **Board partitions, loaded when the board is opened.** A partition is one board's branches, sessions, board objects, cards, comments and full board record.

Realtime keeps applying every event the server sends. A row being present in the store no longer means its board is complete: each board partition has an explicit loading state. Load-versus-event races use a **fill-only merge with a per-ID "touched" fence**. This extends the existing revision counters and never discards a snapshot, so it cannot starve the way `runHydration` does.

**Delivery.** One PR built as four ordered steps (11 commits):

- **Additive first, flip last.** Each step adds the replacement before removing what it replaces. Every commit leaves CI green and the app usable.
- **No schema migration** in the default scope.
- **No feature flag** (rationale in §10.4).
- **Land after `lean-session-list-payload`** (§11).

| Step                                               | Commits | State of `main` if the branch stopped here                                                                                                                                                                          |
| -------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. User-first first paint and board partitions** | 1.1–1.3 | Kamil's three symptoms fixed. The Home gate payload drops from at least 6.4 MB to about 0.5 MB plus lean globals. Opening a board fills its partition in one fetch. Global hydration still runs. Heap about 121 MB. |
| **2. Server summaries**                            | 2.1–2.2 | Home boards, stats bar, switcher counts, mobile counts and board emoji come from an RBAC-filtered server aggregate. They are correct even without global data.                                                      |
| **3. Annotations and session-MCP on demand**       | 3.1–3.2 | Board objects, cards, comments and full board records load per board; session↔MCP links load per session. Heap about −11 MB; network about −10 MB+ per cold load.                                                   |
| **4. Sessions and branches on demand**             | 4.1–4.4 | Server search, `$in` reads, targeted fetches, then the flip: no global session or branch hydration. Home heap about 30–35 MB; network about −24 MB more.                                                            |

Out of scope, possible follow-ups: daemon-side per-board realtime narrowing (§4.3), and server-persisted board visits (§5, which needs a migration).

## 1. Diagnosis (verified)

| Symptom                                                   | Root cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Evidence                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Home "My Sessions" shows the empty state               | First paint fetches the **global** 50 most recent sessions. My Sessions then keeps only `created_by === me`. On a busy workspace my sessions are often not in that 50. The full set only arrives with the 20 MB background hydration. The empty state also can't tell "loading" from "none".                                                                                                                                                                                                                                                                                                                                                          | `UI/hooks/useAgorData.ts:106`, `:618-633`. `UI/components/HomePage/HomeSessionsSection.tsx:102-108` uses `isOwnActiveSession` (`UI/utils/sessionSearch.ts:166-167`). Empty state `HomeSessionsSection.tsx:167-171`.                                                          |
| 2. Kamil's last-used board isn't in Home's Boards section | Rank order is localStorage `agor:recentBoardIds` (cleared), then the latest board/branch/session time, then name. On Home first paint `branchById` is `[]`, so no session can be joined to a board, and recency falls back to `board.last_updated`. Only 4 boards show per page.                                                                                                                                                                                                                                                                                                                                                                      | `HomeBoardsSection.tsx:23`, `:197-242`. Branches grouped through `branch.board_id` (`:41-50`). `UI/hooks/useRecentBoards.ts:5`. Home branches `[]`: `useAgorData.ts:784`.                                                                                                    |
| 3. Teammate drawer has no sessions for a few seconds      | Switching boards never fetches anything (`useAgorData.ts:1096-1101`). The drawer reads `sessionsByBranch` and `branchById`, which on Home → board are filled only by the global hydration. `runHydration` throws away the whole snapshot if **any** write to the collection lands during the fetch, and retries forever with backoff of 0×4, then 200 ms up to a 5 s cap. The full sessions fetch is a single 7,656-row, 20 MB page (`DEFAULT_LIMIT` is 10,000), so the race window is long and agent streaming hits it constantly. Also, while the teammate branch is missing, the drawer shows "inaccessible" and switches to the All-sessions tab. | `UI/store/agorHydration.ts:44-46`, `:256-286`. `core/config/constants.ts:114`. `UI/components/BoardTeammatePanel/BoardTeammatePanel.tsx:129-131`, `:260-264`. `UI/components/App/App.tsx:1200-1215`. Teammate branch is always on its board: `D/services/boards.ts:436-443`. |

Other verified facts the design relies on:

- **Daemon sessions query.** The sessions SQL fast path accepts only `archived, status, board_id, branch_id, $sort(updated_at|created_at), $limit, $count, $skip` (`D/services/sessions.ts:221-268`).
  - `created_by` therefore falls through to `super.find`. That path loads every visible session, filters in memory, and ignores the `$sort: {updated_at}` (`:2095`). With `$count: false` it returns **400** (`:1986-1987`).
  - `created_by` is already in the validator (`core/lib/feathers-validation.ts:134-157`). `session_id: {$in}` is not, because the validator declares `session_id` as a scalar.
  - RBAC is a SQL predicate (`inVisibleBranchSet`, `core/db/repositories/branch-access.ts:578-602`), so new filters compose with it by `AND`.
- **Session rows carry `branch_board_id`.** It is joined in every read and write path (`core/db/repositories/sessions.ts:182`).
- **Session patches insert missing rows.** The reducer inserts on a missing ID by design (`UI/store/agorMaps.ts:300-302`, `:433-465`). Branch, card, comment and board-object patches behave the same way through `replaceIfChanged` and `upsertBoardObjectInMaps`.
- **Canvas board membership comes from board objects.** The canvas uses `boardObjectsByBoardId`; Home, the switcher and settings use `branch.board_id` (`UI/store/selectors.ts:117-131`).
- **No aggregate endpoint exists.** The only server aggregate is `/leaderboard`, which has **no branch/board RBAC** (`D/services/leaderboard.ts:180-520`). Do not copy it.
- **Preferences are not a safe place for recent boards.** `users.patch` replaces `preferences` wholesale (`D/services/users.ts:1400`). Preferences are returned to any requester, and `users.patched` is broadcast to the whole tenant. Putting recent board IDs there would leak private board IDs.
- **A daemon refuses to start against a newer schema.** It refuses to start when the database is ahead of its binary (`D/setup/database.ts:90-94`). This shapes the rollback rules in §10.3.

## 2. Target data model

| Collection (sandbox size)                                                  | Today                                                          | Target                                                                                                          | Step                    |
| -------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------- |
| boards, lean                                                               | global, gated                                                  | **global, gated** (already lean, `D/services/boards.ts:173-238`)                                                | none                    |
| board full record (`objects`, `custom_css`; 68% of the boards payload)     | displayed board gated; all boards in background                | **per board** (`boards.get`), part of the partition                                                             | 3                       |
| users, repos, card-types                                                   | global, gated                                                  | unchanged                                                                                                       | none                    |
| agentic-tool-settings, mcp-servers, gateway-channels, artifacts (metadata) | global, background                                             | unchanged (artifacts are workspace-wide: search, `/a/`)                                                         | none                    |
| sessions (7,656 / 20 MB)                                                   | global 50 recent gated + full in background                    | **my 100 recent** (gated), **team 50 recent** (gated), **board partition** on open, **by-ID** gets              | 1 (mine), 4 (rest)      |
| branches (791 / 3.9 MB)                                                    | displayed board's, or `[]` on Home; full in background         | **board partition**; by ID for first-paint sessions (`$in`); 50 most recent by `created_at`                     | 4                       |
| board-objects (10,196 / 2.8 MB)                                            | board-scoped, or **global on Home**, gated; full in background | **board partition**                                                                                             | 1 (out of Home gate), 3 |
| cards (3,135 / 3.5 MB)                                                     | same                                                           | **board partition**                                                                                             | 1, 3                    |
| board-comments                                                             | same                                                           | **board partition** (unread counts and mentions are already per current board, `UI/store/selectors.ts:138-174`) | 1, 3                    |
| session-mcp-servers (25,870 / 4 MB)                                        | global, background                                             | **per session, on demand** (§6)                                                                                 | 3                       |
| board summaries, home totals                                               | derived on the client from global maps                         | **server aggregate** `home-summary`                                                                             | 2                       |
| recent board visits                                                        | localStorage                                                   | unchanged by default; server table optional (§5)                                                                | none                    |

Invariants:

- **I1. Presence is not completeness.** A row in a map says nothing about whether its board is complete. Only `boardPartitions[boardId].status === 'loaded'` does (Steps 1–2 also accept "all global collections have hydrated").
- **I2. A load never overwrites a live row.** Rows that realtime events have touched since the load started win over the snapshot.
- **I3. No new data path widens RBAC.** Every new server read composes the existing SQL visibility predicates and the tenant condition.

## 3. Board partitions: load, track, show, cache

### 3.1 State (new `UI/store/boardPartitions.ts`, store meta)

```ts
type PartitionStatus = 'loading' | 'loaded' | 'error';
boardPartitions: Map<BoardID, { status: PartitionStatus; authorityScope: string; error?: string }>;
// Steps 1–2 only: collections whose global snapshot has applied at least once.
globallyHydrated: Set<'sessions' | 'branches' | 'boardObjects' | 'cards' | 'comments' | 'boards'>;
selectBoardReady(boardId) =
  boardPartitions.get(boardId)?.status === 'loaded' ||
  (all six collections in globallyHydrated);   // shortcut removed in commit 3.2
```

- `globallyHydrated` is set inside `runHydration` after an apply, so `useAgorData` doesn't need to change for it. The gated first-paint apply also marks its board's partition `loaded`; that is a one-line call in `useAgorData`.

### 3.2 Trigger

- New `useBoardPartition(client, boardId, { canUseMemberWorkspaceServices })`, mounted in `UI/components/App/App.tsx` (with `currentBoardId`) and `UI/components/mobile/MobileApp.tsx` (with `effectiveBoardId`).
- If the board is not ready and not already loading under the current authority, it starts `loadBoardPartition`. In-flight loads are deduplicated per board.
- The authority scope is captured from `realtimeBatch`'s `activeAuthorityScope` (export a getter) at start and checked again before apply.
- `loadBoardPartition` runs the same six queries as the board-scoped first-paint batch (`useAgorData.ts:770-845`), in parallel:
  - `branches{board_id, archived:false}`
  - `sessions{board_id, archived:false, $sort:{updated_at:-1}}`
  - `board-objects{board_id}` (members only)
  - `board-comments{board_id}`
  - `cards{board_id}`
  - `boards.get(board_id)`
- Each is already pushed down to SQL and RBAC-scoped.

### 3.3 Merge: fill-only with a per-ID touched fence (race correctness)

Extend `UI/store/agorHydration.ts`. The existing `liveRevisions` are kept; this adds per-ID stamps.

```ts
bumpRevision(collection, id?)        // existing call sites add the entity id
touchedSince(collection, id, rev)    // true if id was written by a live event after rev
beginPartitionLoad() / endPartitionLoad()  // touched maps are only kept while a load is in flight
```

- IDs are stamped in `agorRealtimeActions.ts`, in `realtimeBatch.enqueueSessionPatch` (at enqueue time, not flush), and in the two store cascades.

The pure `applyBoardPartition(prev, snapshot, startRev)` reducer, in `agorMaps.ts`:

- **Absent rows:** insert a snapshot row only if its ID is **absent** from the store **and** has not been touched since `startRev`.
  - Sessions are inserted with `applySessionPatchToMaps`, which also builds buckets and remote surrogates.
  - Board objects use `upsertBoardObjectInMaps(…,'create')`.
  - Branches, cards and comments use an insert-if-absent.
- **Rows on a removed branch:** a session, board object or comment whose `branch_id` was touched since `startRev` and is now absent from `branchById` is skipped.
- **Present rows are never overwritten.**
- **Board record:** the full board record replaces the lean one unless `boards:<id>` was touched since `startRev`.

Why this is correct:

- A present row is kept current by events.
- An absent row is either untouched since the load started (the snapshot is the best information available), or touched (it was removed, archived or evicted, or its newer patch is queued and will flush).
- This assumes the server sends every write to this client. Writes missed while disconnected are recovered by the reconnect resync.
- **No starvation.** A snapshot is never discarded.
- **Interaction with the Steps 1–3 global hydrations.** A fill doesn't bump revisions, so it doesn't make the global hydration discard. Their later wholesale apply is a superset with equal rows: any difference would require a live write, which would make that hydration discard anyway.

### 3.4 UI states

- **`App.tsx:1208`:** `primaryTeammateInaccessible = Boolean(primaryTeammateId && !primaryTeammateBranch && boardReady)`. "Not loaded" must not render as "no access", and it must not cause the default-tab flip.
- **`BoardTeammatePanel`:** takes a `boardReady` prop and shows a skeleton in the Teammate and All-sessions tabs until ready.
- **`SessionCanvas`:** while not ready, a centered "Loading board…" spinner if the board has no placements yet, otherwise a small "Syncing" pill.
- **`error`:** inline retry, plus an automatic retry on reconnect.

### 3.5 Caching, eviction, reconnect

- **Steps 1–2.** Partitions are never evicted. A silent reconnect still resyncs globally (`useAgorData.ts:609-617`, `:772-775`).
- **Step 3 (annotations).** A silent reconnect refetches board objects, cards and comments for the displayed board only. Other partitions are marked unloaded and their annotation rows dropped.
- **Step 4 (sessions and branches).** The silent refetch becomes a scoped first paint: globals, my sessions, team recent, and the displayed partition.
  - It is applied wholesale as today (`bumpFirstPaintMergeRevisions`), but rows touched during the fetch keep their live value.
  - Other partitions are marked unloaded and their non-pinned rows dropped (pinned = my sessions plus any open drawer session). Reopening such a board costs one partition fetch.
- **No LRU in v1.** Rows added by events grow with activity, not history (§4.2). Add an LRU only if Step 4 heap measurements show growth.

## 4. Realtime

### 4.1 Today (daemon, verified)

- **Channels.** A user connection joins `authenticated`, the tenant channel, and a per-user channel (`D/setup/socketio.ts:1977-2010`). There is no per-board Feathers channel.
- **Delivery.** `sessions`, `branches`, `board-objects`, `cards` and `board-comments` events go to **every tenant connection whose user can view the branch or board**, whatever that connection is looking at (`D/utils/realtime-publish.ts:935-1173`; policy in `D/utils/realtime-publish-policy.ts:107-195`).
- **Existing per-board and per-session rooms.**
  - Cursor rooms (raw Socket.IO, admitted by a `boards.get` check): `socketio.ts:1140-1212`.
  - Navbar association rooms: `:1223-1298`.
  - The per-session streaming Feathers channel (`D/services/session-streams.ts:76-108`).
- **HA.** The Redis relay carries the service event. Each daemon re-runs `resolveLocalDelivery` against its own connections (`D/utils/realtime-publish.ts:1247-1289`; `D/realtime/redis-realtime.ts:152-203`). RBAC revocation disconnects the tenant's sockets on every replica (`socketio.ts:828-866`).

**This PR changes no daemon channel or publish code.**

### 4.2 Client policy: keep applying every event

**Decision:** no client-side filter on incoming events. Events for boards that aren't loaded still upsert rows.

Rationale:

1. The memory problem is **history** (7,656 sessions), not **change**. Rows added by events are bounded by activity since the tab opened.
2. Dropping events on the client saves no network or parse work, which is the real per-event cost.
3. Dropping an event is only safe if boards that are `loading` count as admitted. Otherwise a dropped patch could leave a stale snapshot row in place. Not filtering removes that whole class of bugs.
4. Team activity and "my sessions on other boards" stay live for free.

Consequences, all covered by I1:

- Buckets for unloaded boards can be partial. Canvas, drawer and mobile views gate on `boardReady`, never on whether rows are present.
- Home aggregates come from the server (Step 2).

Board moves:

- **A loaded board's branch moves away.** It gets patched with the new `board_id` and drops off the canvas through the board-object events. Its sessions keep a stale `branch_board_id`. Every board lookup uses a shared helper, `boardIdForSession` (the `UI/components/mobile/sessionBoardId.ts:4-15` pattern): prefer `branchById.get(branch_id)?.board_id`, fall back to `branch_board_id`.
- **A branch moves into a loaded board.** It is inserted by the event. From commit 4.2, `useBoardPartition` also fills that branch's sessions (`sessions{branch_id}`).

### 4.3 Server narrowing (follow-up, not in this PR)

Model it on `presence:subscribe-boards`, using the same `boards.find` admission and the same HA behaviour (`socketio.ts:1223-1298`):

- **Watch messages.** A connection sends `realtime:watch-boards [ids]`, which the daemon stores as `connection.watchedBoardIds`.
- **Delivery filter.** In `resolveLocalDelivery`, **after** RBAC filtering (so it can only narrow), deliver a board-scoped event to a connection only if at least one of these holds:
  - the connection watches the event's board;
  - the row's `created_by` is the connection's user;
  - the event is `created`, or a `status` transition.

Constraints:

- `extractBoardId` only reads `board_id`/`boardId` (`realtime-publish.ts:416-422`). Sessions need `branch_board_id`.
- A branch move must reach watchers of both the old and the new board.
- Tasks and messages have no board ID. Leave them as they are.

Kept out because it is the only part that changes the HA realtime boundary. It is easier to justify with traffic measurements taken after this PR.

### 4.4 Reusing revision/generation machinery

- **Generations.** `runHydration` keeps its job (cancellation) for whatever stays global.
- **Revisions.** `liveRevisions` is reused as the stamp source for the per-ID fence.
- **Queue high-water mark.** The session-patch queue's `lastAppliedRevision` logic is unaffected: fill-merge never subsumes a queued patch, because touched IDs are skipped.
- **Authority fencing.** Uses the existing authority scope (`UI/store/realtimeBatch.ts:394-400`).

## 5. Home

| Section                             | Needs                                                             | Today                                                            | Target                                                                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| My Sessions (`HomeSessionsSection`) | my 100 most recent non-archived sessions, with board/branch pills | filtered from global maps                                        | **1.3:** gated `sessions{created_by: me, archived:false, $sort:{updated_at:-1}, $limit:100, $count:false}`; board pill through `boardIdForSession`. **4.2:** branch pills via `branches{branch_id:{$in}}`. |
| Jump back in                        | my sessions with status `awaiting_*`                              | `sessionById` scan (`JumpBackInSection.tsx:73-89`)               | **1.3:** covered by my 100. **4.2:** add `sessions{created_by: me, status: awaiting_input}` and `{…awaiting_permission}`.                                                                                  |
| Stats bar                           | running now, active this week (mine / team), active teammates     | `sessionById` scan (`HomeStatsBar.tsx:95-132`)                   | **2.2:** `home-summary.totals`.                                                                                                                                                                            |
| Team activity                       | newest 100 branch and session events                              | `branchById` + `sessionById` (`HomeActivitySection.tsx:239-267`) | **4.2:** gated team 50 sessions plus `branches{archived:false, $sort:{created_at:-1}, $limit:50}`. Stays live through events.                                                                              |
| Boards                              | rank, emoji, branch count, active count, last session time        | client derivation (`HomeBoardsSection.tsx:197-242`)              | **1.3:** rank adds my last activity per board. **2.2:** `home-summary.boards`.                                                                                                                             |
| Onboarding card                     | "has a session"                                                   | `sessionById.size`                                               | My sessions (1.3).                                                                                                                                                                                         |

**Board ranking.**

- **1.3:** visit rank from localStorage (when present), then my last session activity on the board (descending), then the latest team activity, then name. After a localStorage clear, the board where I last prompted ranks first.
- **2.2:** visit rank from localStorage, then `my_last_session_at`, then `running_count + awaiting_count`, then `last_activity_at`, then name.

**`home-summary` (commit 2.1)** returns `find() → { boards: BoardSummary[], totals, generated_at }`:

```ts
interface BoardSummary {
  board_id;
  branch_count; // non-archived branches visible to caller
  running_count;
  awaiting_count; // non-archived sessions on visible branches
  last_activity_at;
  my_last_session_at; // max(sessions.updated_at), the latter WHERE created_by = caller
  unresolved_comment_count; // root comments visible to caller (mobile nav tree)
  primary_teammate: { branch_id; display_name; emoji } | null; // null unless caller can see that branch
}
totals: {
  running_now;
  active_this_week;
  my_active_this_week;
  active_users_this_week;
}
```

- **Query.** `GROUP BY branches.board_id` over the existing predicates: `visibleBoardCondition`, `visibleBranchAccessCondition`, `inVisibleBranchSet`, plus the tenant inventory condition. Superadmin and service accounts are handled the same way as in `find`.
- **Classification.** Classify the service `scoped` in `TENANT_OWNED_SERVICE_PATHS`. It is **not published** in realtime (default-deny).
- **Freshness.**
  - Fetch on Home mount.
  - Refetch, debounced 2 s, on session `created`/`removed`/archive/`status` change and on branch create/archive/move/remove events.
  - Bump `last_activity_at` and `my_last_session_at` locally from session patches.
- **Board emoji.** `getBoardEmoji` falls back to `summary.primary_teammate.emoji` when the teammate branch isn't loaded. The field is never put on board rows: board events are broadcast, so a per-caller field would leak.

**Server-persisted visits (optional, not in the default scope).**

- **Design if wanted:** a `user_board_visits(tenant_id, user_id, board_id, last_visited_at)` table.
  - Postgres RLS; FK cascade on board and user deletion.
  - Caller-only writes; never published.
  - Read through `home-summary` as `my_last_visited_at`.
  - Rank score = `max(my_last_visited_at, my_last_session_at)`.
- **Why not by default:** it is the PR's only schema change. Because of the database-ahead-of-binary refusal (§10.3), it would turn a plain revert into "revert code but keep the migration".
- **Kamil's symptom 2 without it:** `my_last_session_at` (server) fixes the ranking, and the localStorage overlay still ranks recently visited boards on the same device.

## 6. `session-mcp-servers`

**Not needed globally at startup.**

- **Readers.** Every reader looks at one session: `UI/components/App/App.tsx:1158-1164` → `SessionPanel.tsx:459-464`, `SessionMcpFooterControl.tsx:204-244`, `SessionSettingsModal.tsx:218-219`, `mobile/SessionPage.tsx:82-85`.
- **No workspace-wide reader.** Marketplace only uses the events as a refresh trigger (`Marketplace/useMarketplaceOverview.ts:136-153`).

Commit 3.1 changes:

- Remove the global fetch (`useAgorData.ts:550-561`).
- Add `useSessionMcpServerIds(sessionId)`:
  - It calls `session-mcp-servers.find({ query: { session_id } })` the first time a session needs it. The service supports `session_id` and `$in` (`D/register-services.ts:1141-1218`).
  - The result is applied with the per-ID fence.
  - The session is then recorded in a `sessionMcpLoaded: Set`.
  - Realtime events keep being applied.

**Caveat.** The update diff treats "not loaded" as "none attached" (`UI/utils/sessionMcpServers.ts:4-30`, called from `UI/App.tsx:1966` and `SessionMcpFooterControl.tsx:244`). The edit controls stay disabled until the session is in `sessionMcpLoaded`.

## 7. Features that assume the store is complete, and their replacements

The commit that delivers each replacement is in brackets.

- **My Sessions, Jump back in, Stats, Team activity, Boards.** See §5.
- **Board emoji fallback** (`BoardTile.tsx:17-26` and its callers). Summary teammate emoji [2.2]; a loaded branch still wins.
- **Board switcher counts** (`BoardSwitcher/BoardSwitcher.tsx:82-91`). Summary [2.2].
- **GlobalSearch** (`GlobalSearch/useGlobalSearch.ts:90-124`, `useRecents.ts:38-69`).
  - New `search.find({ q, types:['sessions','branches'], owned_by_me, $limit })` [4.1]. It runs the shared `SEARCHABLE_FIELDS` and `matchSearchTokens` (`core/search/searchable-fields.ts:34-73`) over rows visible to the caller, and returns the top N plus counts.
  - The UI shows local hits immediately and merges server hits debounced (250 ms) [4.2].
  - Boards, artifacts and MCP servers stay local.
- **Session genealogy** (`BranchCard/buildSessionTree.ts:64-91`; surrogates `agorMaps.ts:228-250`).
  - Fork and spawn trees are per branch.
  - Remote-create targets on other boards: after a partition fill, fetch missing targets with `sessions{session_id:{$in}}` [4.1 validator + `findPage.sessionIds`, capped at 200; 4.2 UI].
  - Callback and parent titles: lazy `sessions.get` (`CallbackTargetDisplay.tsx:47-69`) [4.2].
- **`/s/` deep link** (`hooks/useUrlState.ts:348-359`).
  - It resolves the board only through `branchById`. If the branch arrives later, the link is already marked resolved, so the board never switches.
  - Fix [1.3]: use `boardIdForSession`, and re-run recenter once `boardReady`.
- **`/w/` deep link** (`useUrlState.ts:365-378`). On-demand `branches.get` after load, mirroring the `/s/` effect at `useAgorData.ts:1257-1325` [4.2].
- **`/b/` and `/a/` deep links.** Unchanged (global collections). The board renders through §3.
- **Short-ID ambiguity** (`utils/urlResolution.ts:20-34`). A not-found or ambiguous match against partial data falls back to a server `get` by short ID [4.2].
- **Mobile.**
  - Nav tree (`mobile/MobileNavTree.tsx:65-104`): counts from the summary [2.2]; branches and sessions load per expanded board through `useBoardPartition` [4.2].
  - Home and Sessions pages: my sessions.
  - Assistant tab: `sessions{branch_id: teammate}` [4.2].
  - Mobile search: `search.find` [4.2].
- **Teammate picker in the left panel** (`BoardTeammatePanel.tsx:200-222`). Server candidates, same as `SettingsModal/PrimaryTeammatePicker.tsx:88-108` [4.2].
- **Settings tables.**
  - Cards: fetch on open, plus `boards.get` for the zone names of the boards it references (`CardsTable.tsx:91-125`) [3.2].
  - Branches, Teammates and gateway `BranchSelect`: server-paginated fetch on open [4.2].
  - BoardsTable session counts: from the summary [2.2].
- **Facepiles** (`AppHeader/GlobalPresenceFacepile.tsx`). Built from presence; unaffected.
- **Schedules and scheduled runs** (`ScheduleTab.tsx:144-153`, `ScheduleRunsPanel.tsx:63-82`). Already fetched from the server; unaffected.
- **Branch-removal comment rehydrate** (`useAgorData.ts:1416-1435`, global). Refetch comments for the loaded boards only [3.2].
- **Unused indexes** `boardObjectByBranchId` and `boardObjectByCardId` (no readers). Dropped [3.2].

## 8. Implementation sequence (one branch, one PR)

Rules for every commit:

- **Green and usable.** Typecheck, lint and tests pass. The app works on `sqlite` and `rich`.
- **Tests travel with the code.** Each commit's tests ship in the same commit.
- **Order.** Replacements land before removals. The two removal commits (3.2 and 4.3) touch nothing else, so either one can be reverted cleanly (§10.3).
- **Commit messages.** Each body states the "after this commit" invariant below, so review can go commit by commit.

### Step 1: user-first first paint and board partitions

**1.1 `feat(sessions): SQL fast path for created_by`.** Daemon/core.

- `D/services/sessions.ts:231-240`: allow `created_by` (string) and pass `createdBy`.
- `core/db/repositories/sessions.ts:608-620`: add `eq(sessions.created_by, opts.createdBy)`.
- No index or migration (7.6k rows are served by `sessions_tenant_archived_updated_idx` plus a filter).
- _After:_ additive API; the UI is unchanged.

**1.2 `feat(ui): board partition loads with per-ID touched fence`.**

- New: `store/boardPartitions.ts`, `hooks/useBoardPartition.ts`, `applyBoardPartition` (in `agorMaps.ts`).
- Fence: `agorHydration.ts`, `agorRealtimeActions.ts`, `realtimeBatch.ts`.
- `useAgorData.ts`: one line, `markBoardPartitionLoaded(boardScope)` after the first-paint apply.
- Mount in `components/App/App.tsx` and `MobileApp.tsx`.
- Ready-gate `primaryTeammateInaccessible`.
- Loading states in `BoardTeammatePanel` and `SessionCanvas`.
- _After:_ symptom 3 fixed. Global hydration is unchanged and still makes every board ready eventually.

**1.3 `feat(home): user-first Home first paint`.**

- `useAgorData.ts` light batch gets the my-sessions query (keyed on `authenticatedUserId`, failure-tolerant, see §10.2), merged like `boardSessionsList`.
- On Home, board-objects, cards and comments leave the gate and become background global `runHydration` loops. The checklist becomes a per-load plan.
- Shared `boardIdForSession` helper.
- `HomeBoardsSection` ranking and session-to-board join. Show "—" instead of "0 branches" until branches have hydrated.
- `HomeSessionsSection` board pill.
- `useUrlState` `/s/` fix.
- _After:_ symptoms 1 and 2 fixed. **Step 1 is complete and shippable.**

### Step 2: server summaries

**2.1 `feat(daemon): home-summary service`.**

- Service, `TENANT_OWNED_SERVICE_PATHS` classification, realtime policy (not published), shared types in `core/types`.
- _After:_ additive API.

**2.2 `feat(home): Home, switcher, mobile counts and board emoji from home-summary`.**

- `useHomeSummary` hook with the debounced refetch and local bumps from §5.
- If the summary fails, render "—" and fall back to client derivation from loaded data (§10.2).
- _After:_ Home is correct without global data.

### Step 3: annotations and session-MCP on demand

**3.1 `feat(ui): load session↔MCP links per session`** (§6).

- _After:_ no `session-mcp-servers` startup request. Edit controls are gated on load.

**3.2 `refactor(ui): board objects, cards, comments and full boards load per board`.**

- `useAgorData.ts` deletions:
  - the Home global fetch (`:799-832` path);
  - the global hydrations at `:1049-1113`;
  - the global boards backfill.
- Scoped reconnect for these collections.
- Remove the `globallyHydrated` readiness shortcut.
- Per-board comment rehydrate on branch removal.
- CardsTable fetch-on-open.
- Drop the unused indexes.
- _After:_ every board open goes through its partition.

### Step 4: sessions and branches on demand

**4.1 `feat(daemon): session/branch $in reads and search service`.**

- Validator: `$in` for `session_id` and `branch_id`, capped at 200.
- `findPage.sessionIds`.
- `search` service: `scoped` classification, not published, shared matcher.
- _After:_ additive API.

**4.2 `feat(ui): server-backed replacements for workspace-wide reads`.**

- Search merge.
- Genealogy target fetch; callback/parent `get`.
- `/w/` get; short-ID server fallback.
- Teammate picker.
- Settings Branches/Teammates/`BranchSelect`.
- Mobile tree and assistant tab.
- Jump-back-in awaiting queries.
- Home branch pills (`$in`) and recent branches.
- Fill the sessions of a branch that moves onto a ready board.
- Everything here works with or without global data.
- _After:_ the app is still fully hydrated, but no surface depends on it.

**4.3 `refactor(ui): stop global session and branch hydration`.**

- `useAgorData.ts` deletions (`:985-1039`) and the scoped reconnect (§3.5).
- _After:_ final state.

**4.4 `docs: describe board-scoped loading`.**

- A short "What the browser loads" note in `apps/agor-docs/content/guide/architecture.mdx` (Real-Time Multiplayer).
- Mark this doc's status as implemented.
- Evidence (timings, heap, e2e logs) goes in the PR description, not the repo.

`useAgorData.ts` is touched by 1.2 (one line), 1.3 (light batch and Home gate plan), 3.1, 3.2 and 4.3 (deletions). §11 covers the lean branch.

## 9. Consolidated test plan

### 9.1 Matrix

| Layer                                                                         | SQLite   | PostgreSQL                                           | `rich` (Postgres + RBAC, Alice/Bob) | `ha` (2 daemons + Redis) |
| ----------------------------------------------------------------------------- | -------- | ---------------------------------------------------- | ----------------------------------- | ------------------------ |
| Daemon/core unit (`pnpm test`)                                                | ✓        | `*.postgres.test.ts` via `pnpm test:postgres:docker` | via fixtures in Postgres suites     | none                     |
| UI unit (`pnpm --filter agor-ui test`) and browser layout (`test:browser`)    | n/a      | n/a                                                  | n/a                                 | n/a                      |
| E2E (scripted Playwright against env variants with `SEED=true` demo fixtures) | `sqlite` | covered by `rich`                                    | ✓                                   | ✓ (reconnect, relay)     |

The repo has no committed Playwright e2e suite; only `apps/agor-ui/vitest.browser.config.ts` runs in CI (`browser` job). E2E runs as Playwright scripts against the `.agor.yml` variants. Results are attached to the PR.

HA is needed even though channels don't change, because Step 4 changes client reconnect semantics.

### 9.2 Daemon/core unit (SQLite + Postgres)

**Sessions `findPage` and service** [1.1, 4.1]

- `createdBy` and `sessionIds` AND with `visibleToUserId` and the tenant condition.
- Rows come back ordered by `updated_at`; `includeTotal:false` works.
- A regular user's `created_by` query takes the SQL path: no 400, no generic path.
- `$in` caps are rejected at 201.
- `created_by` combined with the lean branch's projection parameter stays on the SQL path (§11).

**`home-summary`** [2.1]

- A private branch on a shared board is counted for Bob, not for Alice.
- An invisible board is omitted.
- `primary_teammate` is null when the teammate branch is invisible.
- Superadmin sees everything.
- Totals match a brute-force count over visible rows.

**`search`** [4.1]

- Same results as the client matcher over the same rows.
- Never returns invisible rows.
- `owned_by_me` works; the limit is honoured.

**Cross-tenant negatives (one per new read)**

- `created_by`, `session_id $in`, `home-summary`, `search`: the same IDs from another tenant return nothing.

**Boundary checks**

- Classification boot assertion.
- Realtime publish policy: both new services are not published.
- `pnpm check:multitenancy-boundaries`.

### 9.3 UI unit and browser tests

**Fence and partition** [1.2]

- `applyBoardPartition` inserts absent rows and never overwrites present ones.
- It skips touched IDs, and rows on a touched-and-absent branch.
- The board record is replaced unless touched.
- An authority change drops the apply.
- In-flight loads are deduplicated.
- A patch queued during the load beats the snapshot.
- `realtimeBatch` stamps IDs at enqueue.

**First paint and reconnect, per route** (`useAgorData`) [1.3, 3.2, 4.3]

- **Home:**
  - the my-sessions query is issued;
  - Home reaches `initialLoadComplete` while board objects, cards and comments never resolve (1.3);
  - none of those collections, or session-mcp, are requested at all (3.1, 3.2);
  - no global sessions or branches `findAll` (4.3).
- **Board and deep-link routes:** the gate is unchanged.
- **Viewer role:** no board-objects request (`useAgorData.viewer-workspace.test.tsx`).
- **Reconnect:** replaces the displayed partition, keeps touched rows, and unloads the others.

**Components**

- `BoardTeammatePanel`: not ready shows a skeleton, with no "inaccessible" and no tab flip.
- `SessionCanvas` loading state.
- Home sections render from the summary with empty maps.
- The summary refetch is debounced, with local bumps.
- Board ranking with no visit history.
- `/s/` and `/w/` resolution switches boards.
- GlobalSearch merges server hits.
- Session-MCP controls are disabled until loaded; the diff is correct after load.
- Mobile nav tree loads lazily.

### 9.4 Existing tests to adapt (not delete blindly)

- **`useAgorData.test.tsx`, skip-apply-on-race suite (`:858-1057`).** Retarget it from sessions/branches to a collection that stays global (for example artifacts), and keep its guarantees.
- **"lean boards list + objects hydration" (`:1149-1287`).** The global objects backfill becomes a partition test.
- **"bulk-write revision bumps" (`:1059-1147`).** Moves to the scoped reconnect.
- **Home rerender tests** (`HomePage.rerender.test.tsx`, `HomeSections.rerender.test.tsx`): keep the "a streaming patch doesn't re-render the page" guarantee with summary-backed sections.
- **`BoardTeammatePanel` browser tests:** add the readiness prop.

### 9.5 E2E scenarios

| ID  | Scenario                                                                                                                                                                                                                     | Variants         | First valid after |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------- |
| S1  | Seed Bob with more than 60 sessions newer than Alice's. Clear localStorage and log in as Alice. My Sessions is populated at first paint, never the empty state. The Boards first page contains Alice's newest-session board. | sqlite, rich     | 1.3               |
| S2  | Home → that board while a script patches one of its sessions every 100 ms. The drawer lists the teammate's sessions in under 1 s. There is no "teammate unavailable" flash. The canvas shows loading, then a complete board. | sqlite, rich     | 1.2               |
| S3  | Deep links, cold and warm: `/b/`, `/s/` (other board, branch not loaded), `/w/` (other board, after load), `/a/`, `/m/board/…`, `/m/session/…`, `/m/comments/…`. Each lands on the right board, recentered.                  | sqlite           | 1.3 / 4.2         |
| S4  | RBAC: shared board, Bob's private branch. Alice's My Sessions, summary counts, search, partition loads and teammate emoji never reveal Bob's private rows; Bob sees them.                                                    | rich             | 1.1 / 2.1 / 4.1   |
| S5  | Live convergence: Alice has board A open and Home in a second tab. Bob creates branches and sessions on A and on an unopened B. A updates live; Home counts update within the debounce; opening B shows a complete board.    | sqlite, rich, ha | 2.2               |
| S6  | Reconnect: drop Alice's socket (on `ha`, restart her daemon) while Bob deletes a branch on A and edits B. After reconnect, A matches the server (the delete is gone), and B reloads on open.                                 | sqlite, ha       | 3.2 / 4.3         |
| S7  | Session-MCP: attach and detach from SessionPanel, settings and the mobile session page. Controls are disabled until loaded; there is no accidental detach.                                                                   | sqlite           | 3.1               |
| S8  | Search finds a session on a never-opened board, with correct counts and the owned-by-me toggle; Alice never finds Bob's private-branch session.                                                                              | sqlite, rich     | 4.2               |
| S9  | Mobile: nav tree counts come from the summary; expanding a board loads it; the assistant tab works for a teammate on another board.                                                                                          | sqlite           | 4.2               |
| S10 | A global viewer gets Home, boards and Marketplace without 403s, and no board-objects requests.                                                                                                                               | rich             | 1.3               |
| S11 | Scale fixture (script: about 5k sessions, 20 boards): network log, initial-load timings, heap after GC (§9.6).                                                                                                               | sqlite, rich     | each step         |
| S12 | Mixed version: a new UI bundle against the previous daemon build loads with degraded counts and search, and no fatal error (§10.2).                                                                                          | sqlite           | 1.3 / 2.2 / 4.2   |

### 9.6 Measurements (recorded in the PR per step)

**Protocol**

- Set `localStorage['agor.debug.initialLoad']`, then record `window.__AGOR_INITIAL_LOAD_TIMINGS__`.
- Chrome heap snapshot after forced GC on Home cold load and after opening one board.
- Total transferred bytes on Home cold load.

**Expected, from the sandbox measurements**

- Baseline: 121 MB after GC (340 MB pre-GC peak).
- Blocking individual collections: sessions → 60 MB; branches → 102 MB; objects, cards and comments → 113 MB; all of those plus session-MCP → 30 MB.

| After step | Home heap (post-GC) | Home cold network                                                             | Home gate              | Board open after Home                            |
| ---------- | ------------------- | ----------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------ |
| baseline   | ~121 MB             | ~34 MB+                                                                       | ≥6.4 MB                | waits for a quiet window (unbounded under churn) |
| 1          | ~121 MB             | about the same (+0.27 MB mine)                                                | ~0.5 MB + lean globals | one partition fetch                              |
| 2          | ~121 MB             | + summary (KB)                                                                | same                   | same                                             |
| 3          | ~110 MB             | −~10 MB+ (objects 2.8, cards 3.5, comments, session-MCP 4, board annotations) | same                   | partition includes annotations                   |
| 4          | ~30–35 MB           | −~24 MB more (sessions 20, branches 3.9)                                      | same                   | same; the 340 MB pre-GC peak is gone             |

## 10. Rollout, rollback and risk

### 10.1 What could break

| Area                 | Failure mode                                                                   | Introduced    | How it would show                 | Guard                                                          |
| -------------------- | ------------------------------------------------------------------------------ | ------------- | --------------------------------- | -------------------------------------------------------------- |
| Board view           | Empty or partial board after a switch (load not triggered, or readiness wrong) | 1.2, 3.2, 4.3 | Spinner forever, or missing cards | §9.3 partition tests; S2, S9; error state with retry           |
| Data freshness       | A load overwrites a newer row, or resurrects a deleted one                     | 1.2           | Stale status, ghost session       | Fence unit tests; S5                                           |
| Missed deletes       | A row deleted during a disconnect survives                                     | 3.2, 4.3      | Ghost branch or card              | Reconnect tests; S6 on `ha`                                    |
| RBAC                 | Aggregate or search reveals private rows or counts                             | 2.1, 4.1      | Wrong counts for Alice            | Negative unit tests; S4 on `rich`                              |
| Session-MCP          | Editing before load treats "not loaded" as none and detaches servers           | 3.1           | MCP servers vanish from a session | Controls disabled until loaded; S7                             |
| Deep links           | Link opens the drawer but doesn't switch board                                 | 1.3, 4.2      | Wrong board behind the drawer     | S3                                                             |
| Workspace-wide views | Settings tables, mobile tree or search are incomplete                          | 3.2, 4.2      | Missing rows                      | S8, S9; manual settings check                                  |
| Home                 | Stale or incorrect counts                                                      | 2.2           | Counts lag after activity         | S5; debounce and local bumps                                   |
| Performance          | `home-summary` or `search` slow on a large tenant                              | 2.1, 4.1      | Slow Home or search               | `EXPLAIN` on Postgres with the S11 fixture; server timing logs |
| Mixed versions       | New UI against an old daemon during a rolling deploy                           | all           | Missing endpoint or 400           | §10.2; S12                                                     |

### 10.2 Mixed-version window

- **Why it happens.** The daemon serves the UI bundle (`D/index.ts:614-641`). During an HA rolling deploy, or with a stale tab (`useServerVersion` flags drift), a new UI can talk to an old daemon.
- **New UI → old daemon.**
  - The old daemon answers the my-sessions query (`created_by` + `$count:false`) with **400**.
  - `home-summary` and `search` do not exist there.
  - The `$in` validator rejects objects.
- **Requirement.** Every new read is non-fatal:
  - My sessions falls back to the global recent slice.
  - Summary failure falls back to client derivation with "—".
  - Search failure shows local hits only.
  - `$in` failure skips the enrichment.
  - None of these may fail the first-paint gate.
- **Old UI → new daemon:** fine; every change is additive.

### 10.3 Rollback

- **Full rollback.** `git revert` of the merge commit. Safe because the default scope has **no migration**:
  - nothing is persisted in a new shape;
  - the new daemon services simply disappear;
  - old clients never call them.
- **Partial rollback.** Additive-first ordering gives two surgical revert points. Revert **4.3** to restore global session and branch hydration. If needed, then revert **3.2** to restore global annotation hydration. This keeps the server endpoints and replacements, which were written to work with or without global data (rule in §8). Revert 4.3 before 3.2.
- **If the optional `user_board_visits` table is added:** a revert must keep the migration files, journal entry and schema, and revert only code. A daemon refuses to start when the database is ahead of its binary (`D/setup/database.ts:90-94`).
  - Register the migration in `core/db/migrate.ts`'s impact registry (`classification: 'schema'`, `userAction: 'none'`, `rollbackCompatibility: 'compatible'`).
  - Add the table to the tenant deletion and portability catalogs, which the multitenancy checks enforce.
  - This cost is why it is out of the default scope.

### 10.4 Feature flag / kill switch: not recommended

- **A flag doubles the riskiest code path.** A runtime flag would have to keep the global-hydration path that 3.2 and 4.3 delete, and test it in both modes. That doubles the test matrix for the riskiest code, and keeps the starvation bug alive in one mode.
- **Rollback is already cheap.** The PR is migration-free and its server changes are additive, so a full or partial revert (§10.3) is fast and clean.
- **Nothing to configure.** None of the changes is an operator-tunable behaviour that would justify a durable config key.
- **Debug only.** The existing `agor.debug.initialLoad` timing hook is enough to diagnose problems in the field; no new debug flag is needed.
- **Revisit if Kamil wants staged exposure** (for example one cloud tenant first). The narrowest acceptable version would be a temporary per-tenant switch that only skips commit 4.3's removal, with a removal date.

### 10.5 How reviewers should verify

1. **Review commit by commit.** Each message states its invariant. CI must be green on every commit, not only the tip (`git rebase -x 'pnpm test …'`, or CI on each pushed commit).
2. **Focus reading on:**
   - the fence reducer (1.2);
   - the first-paint plan and failure tolerance (1.3);
   - the summary SQL predicates (2.1);
   - session-MCP gating (3.1);
   - the two `useAgorData` deletions (3.2, 4.3);
   - search RBAC (4.1).
3. **Run it:**
   - `sqlite` env with `SEED=true`: clear localStorage, enable `agor.debug.initialLoad`, then Home → board → another board → deep links; check the network tab.
   - `rich` as Alice and as Bob (S4).
   - `ha` reconnect (S6).
4. **PR evidence:**
   - timings JSON per step;
   - heap snapshots (Home and one board);
   - network byte totals;
   - the S1–S12 run log.

### 10.6 Other risks

- **Not loaded vs no access.** Everything that infers a fact from absence must gate on `boardReady`. The audit list is §7.
- **Recenter timing.** A `/s/` recenter can fire before the partition is ready. Re-trigger it when ready.
- **Aggregate cost.** `home-summary` grows linearly with non-archived sessions. Consider materialization past about 100k sessions.
- **Long-lived tabs.** Rows added by events grow with activity. Measure in S11 and add an LRU if needed.
- **Board membership is defined two ways.** The canvas uses board objects; other places use `branch.board_id`. The partition loads both. The inconsistency already exists today.
- **Review fatigue on one large PR.** Mitigated by the commit discipline in §8 and the step-tagged test plan.

## 11. Interaction with `lean-session-list-payload`

**Overlap**

- `useAgorData.ts`:
  - light-batch session query `:618-633`;
  - silent reconnect query `:611-617`;
  - board sessions `:790-797`;
  - sessions hydration `:986-1021`.
- `D/services/sessions.ts` `shouldSqlPageSessionQuery` (`:221-268`).
- Probably `SessionRepository.findPage` (`core/db/repositories/sessions.ts:591-676`), if lean adds a projection option.

**Recommendation: land `lean-session-list-payload` first.**

1. **It is small and nearly independent.** Rebasing this branch onto it is mechanical. Our commit 4.3 deletes the hydration block lean edits, so its changes there disappear along with the block.
2. **The other order is worse.** If this PR lands first, lean has to redo its edits against restructured code.
3. **Lean rows help this PR immediately.** Every list query this PR keeps or adds (my sessions, team recent, partitions, search hits) gets smaller.
4. **This PR shrinks lean's hardest case.** That case is "a lean row must not overwrite a full row". After 4.3, wholesale overwrites happen only at reconnect, and the fill merge never overwrites.

**Contract to agree with the lean worker**

- **(a) Fields lean list rows must keep.** Lean rows are allowed to omit only fields that are fetched when a drawer opens. They must keep the fields that partitions and Home read:
  - `session_id`, `branch_id`, `branch_board_id`, `created_by`, `status`, `archived`;
  - `title`, `description`, `agentic_tool`;
  - `created_at`, `last_updated`;
  - `genealogy`, `remote_relationships`;
  - `scheduled_*`, `ready_for_prompt`.
- **(b) The reconnect apply in 4.3 keeps richer rows.** It must not replace a present full row's omitted fields with absent ones. Reuse lean's merge helper if it provides one.
- **(c) Combined query stays on the SQL path.** `created_by` plus lean's parameter must both be in `shouldSqlPageSessionQuery` (unit test in §9.2).

**If lean slips by more than about a week**

- Develop Steps 1–2 here regardless; their `useAgorData` edits are small.
- Before merging, decide the order with the lean owner. If this PR goes first, lean rebases and applies its projection only to the remaining queries.

## 12. Multi-tenancy assessment

| Change                                      | Resource class                             | Handling                                                                                                                             |
| ------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `created_by` filter (1.1)                   | Tenant-owned (sessions)                    | It is a filter, not an access grant. It composes with the tenant condition and `inVisibleBranchSet`. Cross-tenant negative test.     |
| `home-summary` (2.1)                        | Derived (aggregate over tenant-owned rows) | Classified `scoped`. Visibility predicates and the tenant condition only. Not published. Cross-tenant and capability-negative tests. |
| `$in` reads and `search` (4.1)              | Tenant-owned (sessions, branches)          | Same predicates; search narrows candidates in SQL before matching. Classified `scoped`, not published.                               |
| Client changes (1.2–1.3, 2.2, 3.x, 4.2–4.3) | Existing RBAC-scoped queries               | Authority-fenced applies; maps reset on identity change as today.                                                                    |
| Optional `user_board_visits`                | Tenant-owned and user-private              | RLS. Caller-only. Board/user deletion cascades. Tenant deletion and portability catalogs. Not published.                             |
| Realtime                                    | Unchanged in this PR                       | Server narrowing (§4.3) is a separate follow-up with its own HA review.                                                              |

## 13. Open questions for Kamil

1. **My Sessions:** only sessions I created (today's behaviour), or also shared sessions I prompted last?
2. **Board visits:** include the optional `user_board_visits` table, which makes ranking survive a localStorage clear and work across devices but adds the PR's only migration and the keep-the-migration rollback rule? Or rank by my session activity plus the local visit overlay (proposed)?
3. **Boards section default:** all accessible boards ranked (today), or a "Mine" filter by default?
4. **Team activity:** after 4.3 it shows the server's recent 50 plus live events. Is it acceptable that it is not a complete history scan?
5. **Reconnect:** is it OK to drop cached partitions of other boards (about 1 s reload on next open)?
6. **Settings:** may the admin tables (branches, teammates, cards) fetch when opened, with pagination, instead of being instant?
7. **Search:** server-side search (proposed), or a lazily fetched client index (about 2 MB)?
8. **Staged exposure:** any requirement to expose this to one tenant first? If yes, see §10.4 for the narrowest acceptable switch.
9. **Server-side realtime narrowing (§4.3):** follow-up after measuring traffic (proposed), or fold it into this PR? Folding it in adds HA channel tests to S5 and S6.
