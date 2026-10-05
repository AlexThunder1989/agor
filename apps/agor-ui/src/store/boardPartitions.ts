/**
 * Board partitions: one board's branches, sessions, board objects, cards and
 * full board record, loaded when the board is opened. Comments are
 * global and gated at first paint, so they are not part of a partition.
 *
 * Invariant I1 — presence is not completeness. Realtime keeps upserting rows
 * for every board the caller can see, so a row (or a non-empty bucket) in a map
 * says nothing about whether its board is complete. Surfaces that infer a fact
 * from ABSENCE ("teammate inaccessible", "no sessions", an empty canvas) gate on
 * `makeBoardReadySelector(boardId)` instead.
 *
 * Invariant I2 — a load never overwrites a live row. The snapshot is merged with
 * `applyPartitionSnapshot`, fenced per id by the touched stamps that every
 * realtime write records (`agorHydration.touchedSince`): a row written live
 * during the load keeps its live value. Branches and sessions are filled
 * (the global sets own them until Step 3); board objects, cards and the full
 * board record are reconciled (`replaceScope`), so loading a board again
 * after it was unloaded (a reconnect unloads every board but the displayed
 * one) drops rows deleted, moved or hidden meanwhile. The snapshot is never
 * discarded because of churn, so a partition load cannot starve the way a
 * skip-apply-on-race hydration can.
 *
 * Loads are deduplicated per (authority, board), and a load whose authority
 * changed before it resolved applies nothing.
 */
import type { AgorClient, Board, Branch, CardWithType, Session } from '@agor-live/client';
import { PAGINATION } from '@agor-live/client';
import {
  beginPartitionLoad,
  endPartitionLoad,
  getHydrationCancellationEpoch,
  type HydratedCollection,
  MAX_WHOLESALE_RESTARTS,
  touchedSince,
  WholesaleReplacementError,
  wholesaleReplacedSince,
} from './agorHydration';
import { type AgorState, agorStore } from './agorStore';
import { captureLoadLifetime, isLoadLifetimeCurrent, type LoadLifetime } from './loadLifetime';
import { getRealtimeAuthorityScope } from './realtimeBatch';
import {
  applyPartitionSnapshot,
  BOARD_SCOPE_PREFIX,
  type BoardPartitionSnapshot,
  boardScopeKey,
  type CoverageMembers,
  globalSetsMembers,
  type MemberLookup,
  type ScopeCoverage,
  scopeMembers,
} from './scopeMerge';
import { sessionListQuery } from './sessionListQuery';

/** `boardId`'s partition coverage entry, if any. */
export function selectBoardPartition(
  s: Pick<AgorState, 'coverage'>,
  boardId: string
): ScopeCoverage | undefined {
  return s.coverage.get(boardScopeKey(boardId));
}

const setBoardPartition = (boardId: string, entry: ScopeCoverage | null) =>
  agorStore.getState().setCoverage(boardScopeKey(boardId), entry);

/**
 * Whether `boardId` is complete: its partition is loaded. Nothing else makes a
 * board complete; board objects, cards and full board records load only with
 * it. Curried for per-board memoization.
 */
export function makeBoardReadySelector(
  boardId: string | null | undefined
): (s: AgorState) => boolean {
  return (s) => {
    return !!boardId && selectBoardPartition(s, boardId)?.status === 'loaded';
  };
}

/**
 * A coverage entry recorded under another authority or lifetime describes
 * loads that can no longer settle (or data that may no longer apply): a
 * partition counts as unloaded, and no entry's members keep rows alive.
 * Authority transitions also forget every partition entry.
 */
export function isCoverageCurrent(state: ScopeCoverage | undefined): boolean {
  return (
    !!state &&
    state.authorityScope === getRealtimeAuthorityScope() &&
    state.loadEpoch === getHydrationCancellationEpoch()
  );
}

/**
 * The committed memberships a replace of `exceptKey` must respect: every
 * other scope loaded under the current lifetime (a row one of them returned
 * is never removed), and the global sets while they exist. Loading, failed
 * and stale scopes hold nothing. Overlapping scopes are normal: my session on
 * a loaded board belongs to the user scope and to that partition.
 */
export function otherCommittedMembers(state: AgorState, exceptKey?: string): MemberLookup[] {
  const members: MemberLookup[] = [];
  for (const [key, entry] of state.coverage) {
    if (key === exceptKey || entry.status !== 'loaded' || !entry.members) continue;
    if (isCoverageCurrent(entry)) members.push(entry.members);
  }
  members.push(globalSetsMembers(state.globallyHydrated));
  return members;
}

export function makeBoardPartitionSelector(
  boardId: string | null | undefined
): (s: AgorState) => ScopeCoverage | undefined {
  return (s) => (boardId ? selectBoardPartition(s, boardId) : undefined);
}

/**
 * Record that the gated first-paint apply loaded `boardId`'s partition (the
 * board-scoped first paint runs the same queries as a partition load), under
 * that load's lifetime, with the ids its reads returned for the board; a
 * lifetime that is no longer current records nothing.
 */
export function markBoardPartitionLoaded(
  boardId: string | null | undefined,
  lifetime: LoadLifetime,
  members: CoverageMembers = {}
): void {
  if (!boardId || !isLoadLifetimeCurrent(lifetime)) return;
  setBoardPartition(boardId, {
    status: 'loaded',
    authorityScope: lifetime.authorityScope,
    loadEpoch: lifetime.loadEpoch,
    members,
  });
}

let loadSequence = 0;

// The boards the UI currently displays (registered by `useBoardPartition`), in
// registration order. The UI resolves its board from far more than the URL
// (artifact routes, the mobile shell's fallbacks), so a reconnect resync
// reconciles THIS board rather than re-deriving one from the URL.
const displayedBoards = new Map<number, string>();
let displayedSequence = 0;

/** Record that the UI displays `boardId`; returns the unregister function. */
export function registerDisplayedBoard(boardId: string): () => void {
  const key = ++displayedSequence;
  displayedBoards.set(key, boardId);
  return () => {
    displayedBoards.delete(key);
  };
}

/** The board the UI displays (the most recently registered one), if any. */
export function getDisplayedBoardId(): string | undefined {
  let latest: string | undefined;
  for (const boardId of displayedBoards.values()) latest = boardId;
  return latest;
}

/**
 * A reconnect resync claims the displayed board's partition while it has no
 * entry (an authority transition just unloaded every board), so
 * `useBoardPartition` doesn't read the board a second time alongside the
 * resync. The resync settles the entry; `releaseResyncClaim` frees it if the
 * resync ends without doing so.
 */
export function claimDisplayedBoardForResync(
  lifetime: LoadLifetime
): { boardId: string; loadId: number } | null {
  const boardId = getDisplayedBoardId();
  if (!boardId || agorStore.getState().coverage.has(boardScopeKey(boardId))) return null;
  const loadId = ++loadSequence;
  setBoardPartition(boardId, {
    status: 'loading',
    authorityScope: lifetime.authorityScope,
    loadEpoch: lifetime.loadEpoch,
    loadId,
  });
  return { boardId, loadId };
}

export function releaseResyncClaim(claim: { boardId: string; loadId: number } | null): void {
  if (!claim) return;
  if (selectBoardPartition(agorStore.getState(), claim.boardId)?.loadId === claim.loadId) {
    setBoardPartition(claim.boardId, null);
  }
}

const inflight = new Map<string, Promise<void>>();

// Loads dedupe per (authority, lifetime, partition epoch, board).
function inflightKey(lifetime: LoadLifetime, partitionEpoch: number, boardId: string): string {
  return `${lifetime.authorityScope}\u0000${lifetime.loadEpoch}\u0000${partitionEpoch}\u0000${boardId}`;
}

/** The sequence mark of partition loads started so far (see `partitionLoadSince`). */
export function partitionLoadMark(): number {
  return loadSequence;
}

/**
 * A load of `boardId` that started after `sinceMark` under `lifetime`: its
 * promise while in flight, a resolved one once it has loaded the board, else
 * `undefined`. A reconnect resync reuses it instead of reading the board a
 * second time: the load started after the resync did, so its snapshot
 * already reflects everything the resync must reconcile.
 */
export function partitionLoadSince(
  boardId: string,
  lifetime: LoadLifetime,
  sinceMark: number
): Promise<void> | undefined {
  const entry = selectBoardPartition(agorStore.getState(), boardId);
  if (
    !entry ||
    entry.authorityScope !== lifetime.authorityScope ||
    entry.loadEpoch !== lifetime.loadEpoch
  ) {
    return undefined;
  }
  if (entry.status === 'loaded') {
    return entry.loadedBy !== undefined && entry.loadedBy > sinceMark
      ? Promise.resolve()
      : undefined;
  }
  if (entry.status !== 'loading' || entry.loadId === undefined || entry.loadId <= sinceMark) {
    return undefined;
  }
  return inflight.get(inflightKey(lifetime, agorStore.getState().partitionEpoch, boardId));
}

/**
 * The boards whose partition load started after `sinceMark` under `lifetime`:
 * still loading, or loaded by such a load. Their reads postdate a resync that
 * took the mark, so its reset keeps them rather than read them again.
 */
export function partitionsLoadedSince(lifetime: LoadLifetime, sinceMark: number): string[] {
  const boardIds: string[] = [];
  for (const [key, entry] of agorStore.getState().coverage) {
    if (!key.startsWith(BOARD_SCOPE_PREFIX)) continue;
    const boardId = key.slice(BOARD_SCOPE_PREFIX.length);
    if (
      entry.authorityScope !== lifetime.authorityScope ||
      entry.loadEpoch !== lifetime.loadEpoch
    ) {
      continue;
    }
    const startedBy =
      entry.status === 'loaded'
        ? entry.loadedBy
        : entry.status === 'loading'
          ? entry.loadId
          : undefined;
    if (startedBy !== undefined && startedBy > sinceMark) boardIds.push(boardId);
  }
  return boardIds;
}

/** Forget a failed partition so `useBoardPartition` loads it again. */
export function retryBoardPartition(boardId: string): void {
  if (selectBoardPartition(agorStore.getState(), boardId)?.status === 'error') {
    setBoardPartition(boardId, null);
  }
}

async function fetchBoardPartition(
  client: AgorClient,
  boardId: string,
  canUseMemberWorkspaceServices: boolean
): Promise<BoardPartitionSnapshot> {
  // The board-scoped first-paint queries of `useAgorData` (comments are
  // global and gated, so not part of a partition); each is pushed down to SQL
  // and RBAC-scoped by the daemon.
  const [branches, sessions, boardObjects, cards, board] = await Promise.all([
    client.service('branches').findAll({
      query: { archived: false, board_id: boardId, $limit: PAGINATION.DEFAULT_LIMIT },
    }) as Promise<Branch[]>,
    client.service('sessions').findAll({
      query: sessionListQuery({
        archived: false,
        board_id: boardId,
        $limit: PAGINATION.DEFAULT_LIMIT,
        $sort: { updated_at: -1 },
      }),
    }) as Promise<Session[]>,
    canUseMemberWorkspaceServices
      ? client
          .service('board-objects')
          .findAll({ query: { board_id: boardId, $limit: PAGINATION.DEFAULT_LIMIT } })
      : Promise.resolve(null),
    client
      .service('cards')
      .findAll({ query: { board_id: boardId, $limit: PAGINATION.DEFAULT_LIMIT } }) as Promise<
      CardWithType[]
    >,
    client.service('boards').get(boardId) as Promise<Board>,
  ]);
  return {
    boardId,
    branches,
    sessions,
    boardObjects: boardObjects as BoardPartitionSnapshot['boardObjects'],
    cards,
    board,
  };
}

/**
 * Load one board's partition and merge it into the store
 * (`applyPartitionSnapshot`). Deduplicated per
 * (authority, lifetime, board); resolves once applied, dropped, or failed.
 *
 * The `loading` entry is owned by this load (`loadId`). A load that is
 * cancelled (lifetime ended) or superseded releases its entry instead of
 * leaving the board stuck in `loading`. A load whose every attempt spans a
 * wholesale replacement never applies: it records a retryable error.
 */
export function loadBoardPartition(
  client: AgorClient,
  boardId: string,
  options: { canUseMemberWorkspaceServices: boolean }
): Promise<void> {
  // Captured before the first await, like every load (see `loadLifetime`).
  const lifetime = captureLoadLifetime();
  if (!lifetime) return Promise.resolve();
  const { authorityScope, loadEpoch } = lifetime;
  // Per partition epoch too: a load orphaned by a reset (its entry is gone,
  // so it can never settle the board) must not absorb the board's next request.
  const partitionEpoch = agorStore.getState().partitionEpoch;
  const key = inflightKey(lifetime, partitionEpoch, boardId);
  const existing = inflight.get(key);
  if (existing) return existing;

  const loadId = ++loadSequence;
  const store = () => agorStore.getState();
  const owns = () => selectBoardPartition(store(), boardId)?.loadId === loadId;
  const isCurrent = () => isLoadLifetimeCurrent(lifetime) && owns();
  const run = async () => {
    setBoardPartition(boardId, { status: 'loading', authorityScope, loadEpoch, loadId });
    for (let attempt = 0; ; attempt++) {
      const fence = beginPartitionLoad();
      try {
        const snapshot = await fetchBoardPartition(
          client,
          boardId,
          options.canUseMemberWorkspaceServices
        );
        if (!isCurrent()) return;
        if (wholesaleReplacedSince(fence)) {
          // Never apply across a replacement: the snapshot could resurrect
          // rows it removed. Restart, then surface a retryable error.
          if (attempt < MAX_WHOLESALE_RESTARTS) continue;
          throw new WholesaleReplacementError();
        }
        const touched = (collection: HydratedCollection, id: string) =>
          touchedSince(collection, id, fence.startRevisions[collection]);
        const others = otherCommittedMembers(store(), boardScopeKey(boardId));
        store().applyMaps((prev) => applyPartitionSnapshot(prev, snapshot, touched, others));
        // `applyMaps` notifies subscribers synchronously; one may have ended
        // this lifetime (logout, remount) or started a load that owns the entry.
        if (!isCurrent()) return;
        setBoardPartition(boardId, {
          status: 'loaded',
          authorityScope,
          loadEpoch,
          loadedBy: loadId,
          members: scopeMembers(snapshot),
        });
        return;
      } catch (err) {
        if (!isCurrent()) return;
        console.warn(`[boardPartitions] load failed for board ${boardId}:`, err);
        setBoardPartition(boardId, {
          status: 'error',
          authorityScope,
          loadEpoch,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      } finally {
        endPartitionLoad();
      }
    }
  };
  const promise = run().finally(() => {
    inflight.delete(key);
    // Cancelled or dropped while still loading: release the entry so the
    // board counts as unloaded and the next mount/authority loads it again.
    if (owns()) setBoardPartition(boardId, null);
  });
  inflight.set(key, promise);
  return promise;
}
