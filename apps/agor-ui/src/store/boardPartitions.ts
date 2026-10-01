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
 * `applyBoardPartition`: fill-only, fenced per id by the touched stamps that
 * every realtime write records (`agorHydration.touchedSince`). The snapshot is
 * never discarded because of churn, so a partition load cannot starve the way a
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
  type HydratedCollection,
  touchedSince,
  wholesaleReplacedSince,
} from './agorHydration';
import { applyBoardPartition, type BoardPartitionSnapshot } from './agorMaps';
import {
  type AgorState,
  agorStore,
  type BoardPartitionState,
  GLOBALLY_HYDRATED_COLLECTIONS,
} from './agorStore';
import { captureLoadLifetime, isLoadLifetimeCurrent, type LoadLifetime } from './loadLifetime';
import { sessionListQuery } from './sessionListQuery';

/**
 * Whether `boardId` is complete: its partition loaded, or (Steps 1–2) every
 * collection's global snapshot has applied. Curried for per-board memoization.
 */
export function makeBoardReadySelector(
  boardId: string | null | undefined
): (s: AgorState) => boolean {
  return (s) => {
    if (!boardId) return false;
    if (s.boardPartitions.get(boardId)?.status === 'loaded') return true;
    return GLOBALLY_HYDRATED_COLLECTIONS.every((c) => s.globallyHydrated.has(c));
  };
}

export function makeBoardPartitionSelector(
  boardId: string | null | undefined
): (s: AgorState) => BoardPartitionState | undefined {
  return (s) => (boardId ? s.boardPartitions.get(boardId) : undefined);
}

/**
 * Record that the gated first-paint apply loaded `boardId`'s partition (the
 * board-scoped first paint runs the same queries as a partition load), under
 * that load's lifetime; a lifetime that is no longer current records nothing.
 */
export function markBoardPartitionLoaded(
  boardId: string | null | undefined,
  lifetime: LoadLifetime
): void {
  if (!boardId || !isLoadLifetimeCurrent(lifetime)) return;
  agorStore
    .getState()
    .setBoardPartition(boardId, { status: 'loaded', authorityScope: lifetime.authorityScope });
}

/** Forget a failed partition so `useBoardPartition` loads it again. */
export function retryBoardPartition(boardId: string): void {
  const state = agorStore.getState().boardPartitions.get(boardId);
  if (state?.status === 'error') agorStore.getState().setBoardPartition(boardId, null);
}

const inflight = new Map<string, Promise<void>>();

/** Restart budget when a wholesale reconnect replacement lands mid-load. */
const MAX_WHOLESALE_RESTARTS = 3;

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
 * Load one board's partition and fill-merge it into the store. Deduplicated per
 * (authority, board); resolves once applied, dropped, or failed.
 */
export function loadBoardPartition(
  client: AgorClient,
  boardId: string,
  options: { canUseMemberWorkspaceServices: boolean }
): Promise<void> {
  // Captured before the first await, like every load (see `loadLifetime`).
  const lifetime = captureLoadLifetime();
  if (!lifetime) return Promise.resolve();
  const { authorityScope } = lifetime;
  const key = `${authorityScope}\u0000${lifetime.loadEpoch}\u0000${boardId}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const isCurrent = () => isLoadLifetimeCurrent(lifetime);
  const store = () => agorStore.getState();
  const run = async () => {
    store().setBoardPartition(boardId, { status: 'loading', authorityScope });
    for (let attempt = 0; ; attempt++) {
      const fence = beginPartitionLoad();
      try {
        const snapshot = await fetchBoardPartition(
          client,
          boardId,
          options.canUseMemberWorkspaceServices
        );
        if (!isCurrent()) return;
        if (wholesaleReplacedSince(fence) && attempt < MAX_WHOLESALE_RESTARTS) continue;
        const touched = (collection: HydratedCollection, id: string) =>
          touchedSince(collection, id, fence.startRevisions[collection]);
        store().applyMaps((prev) => applyBoardPartition(prev, snapshot, touched));
        store().setBoardPartition(boardId, { status: 'loaded', authorityScope });
        return;
      } catch (err) {
        if (!isCurrent()) return;
        console.warn(`[boardPartitions] load failed for board ${boardId}:`, err);
        store().setBoardPartition(boardId, {
          status: 'error',
          authorityScope,
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
  });
  inflight.set(key, promise);
  return promise;
}
