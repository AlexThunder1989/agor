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
 * Invariant I2 — a load never overwrites a live row. Every load is a complete
 * replace of the board (`replaceScope`): branches, sessions, board objects,
 * cards and the full board record. It is fenced per id by the touched stamps
 * that every realtime write records (`agorHydration.touchedSince`), so a row
 * written live during the load keeps its live value. Loading a board again
 * after it was unloaded (a reconnect or the LRU) drops rows deleted, moved or
 * hidden meanwhile, unless another scope's committed membership holds them.
 * The snapshot is never discarded because of churn, so a partition load cannot
 * starve the way a skip-apply-on-race hydration can.
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
  MAX_WHOLESALE_RESTARTS,
  touchedIdsSince,
  touchedSince,
  WholesaleReplacementError,
  wholesaleReplacedSince,
} from './agorHydration';
import { type AgorState, agorStore } from './agorStore';
import { backgroundReadsClear, holdBackgroundReads } from './backgroundReads';
import { captureLoadLifetime, isLoadLifetimeCurrent, type LoadLifetime } from './loadLifetime';
import { anyOf, evictRows } from './retention';
import {
  BOARD_SCOPE_PREFIX,
  type BoardPartitionSnapshot,
  boardPartitionScope,
  boardScopeKey,
  type CoverageUpdate,
  replaceScope,
  type ScopeCoverage,
  type ScopeRows,
  settledMembers,
  withCoverage,
} from './scopeMerge';
import { sessionListQuery } from './sessionListQuery';
import { otherCommittedMembers } from './userScope';

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
 * Whether `boardId` is complete: its partition is loaded from a complete
 * read. Nothing else makes a board complete; board objects, cards and full
 * board records load only with it. Curried for per-board memoization.
 */
export function makeBoardReadySelector(
  boardId: string | null | undefined
): (s: AgorState) => boolean {
  return (s) => {
    const entry = boardId ? selectBoardPartition(s, boardId) : undefined;
    return entry?.status === 'loaded' && entry.complete === true;
  };
}

export function makeBoardPartitionSelector(
  boardId: string | null | undefined
): (s: AgorState) => ScopeCoverage | undefined {
  return (s) => (boardId ? selectBoardPartition(s, boardId) : undefined);
}

/**
 * The coverage update that settles `boardId`'s partition from a read, in the
 * update that applies it: loaded under the read's lifetime and generation,
 * complete as the read says, with its membership (`settledMembers`: rows
 * realtime wrote since `startRevisions` are judged by their current value).
 * The board-scoped first paint runs the same queries as a partition load, so
 * it settles the board the same way.
 */
export function settleBoardPartition(
  boardId: string,
  lifetime: LoadLifetime,
  generation: number,
  rows: ScopeRows & { complete: boolean },
  startRevisions: Record<HydratedCollection, number>
): CoverageUpdate {
  const scope = boardPartitionScope(boardId);
  return (maps, coverage) =>
    withCoverage(coverage, scope.key, {
      status: 'loaded',
      authorityScope: lifetime.authorityScope,
      loadEpoch: lifetime.loadEpoch,
      generation,
      members: settledMembers(scope, rows, maps, (collection) =>
        touchedIdsSince(collection, startRevisions[collection])
      ),
      complete: rows.complete,
    });
}

let loadSequence = 0;

/** A new partition generation; generations only increase (see `partitionLoadMark`). */
export function nextPartitionGeneration(): number {
  return ++loadSequence;
}

/**
 * Background partitions the LRU keeps besides the displayed board: the most
 * recently used ones (a mounted background consumer counts as in use now).
 */
export const RETAINED_BACKGROUND_PARTITIONS = 3;

// The mounted consumers of a board's partition (`useBoardPartition`), in
// registration order: the board shells' displayed board, and background
// consumers (mobile navigation, the teammate panel). The UI resolves its
// board from far more than the URL (artifact routes, the mobile shell's
// fallbacks), so a reconnect resync reconciles the displayed board rather
// than re-deriving one from the URL.
const boardUses = new Map<number, { boardId: string; background: boolean }>();
let useSequence = 0;
// When each board was last used (a use registered or released), for the LRU.
const lastUsed = new Map<string, number>();

/**
 * Record that a mounted consumer uses `boardId`'s partition (displayed unless
 * `background`); returns the release function. Both ends run the LRU.
 */
export function registerBoardUse(boardId: string, background = false): () => void {
  const key = ++useSequence;
  boardUses.set(key, { boardId, background });
  lastUsed.set(boardId, key);
  evictInactivePartitions();
  return () => {
    boardUses.delete(key);
    lastUsed.set(boardId, ++useSequence);
    evictInactivePartitions();
  };
}

/** The board the UI displays (the most recently registered displayed use), if any. */
export function getDisplayedBoardId(): string | undefined {
  let latest: string | undefined;
  for (const use of boardUses.values()) if (!use.background) latest = use.boardId;
  return latest;
}

/**
 * The LRU: keep every displayed board, and of the other partitions the
 * `RETAINED_BACKGROUND_PARTITIONS` most recently used (mounted ones first);
 * evict the rest that are not mounted or loading. Evicting a partition drops
 * its coverage and the rows it claims that no other scope holds (`evictRows`).
 */
export function evictInactivePartitions(): void {
  const displayed = new Set<string>();
  const mounted = new Set<string>();
  for (const use of boardUses.values()) (use.background ? mounted : displayed).add(use.boardId);
  const { coverage } = agorStore.getState();
  const background: string[] = [];
  for (const key of coverage.keys()) {
    if (!key.startsWith(BOARD_SCOPE_PREFIX)) continue;
    const boardId = key.slice(BOARD_SCOPE_PREFIX.length);
    if (!displayed.has(boardId)) background.push(boardId);
  }
  for (const boardId of lastUsed.keys()) {
    if (!coverage.has(boardScopeKey(boardId)) && !mounted.has(boardId) && !displayed.has(boardId))
      lastUsed.delete(boardId);
  }
  if (background.length <= RETAINED_BACKGROUND_PARTITIONS) return;
  const recency = (boardId: string) =>
    mounted.has(boardId) ? Number.POSITIVE_INFINITY : (lastUsed.get(boardId) ?? 0);
  background.sort((a, b) => recency(b) - recency(a));
  const evicted = background
    .slice(RETAINED_BACKGROUND_PARTITIONS)
    .filter(
      (boardId) =>
        !mounted.has(boardId) && coverage.get(boardScopeKey(boardId))?.status !== 'loading'
    );
  if (evicted.length === 0) return;
  evictRows(anyOf(evicted.map(boardPartitionScope)), evicted.map(boardScopeKey));
}

/**
 * The rows of `boardIds` whose partitions are unloaded (a reconnect resync
 * dropped them), unless another scope holds them. A board loaded or loading
 * again since keeps its rows.
 */
export function evictUnloadedBoards(boardIds: readonly string[]): void {
  const { coverage } = agorStore.getState();
  const unloaded = boardIds.filter((boardId) => !coverage.has(boardScopeKey(boardId)));
  if (unloaded.length > 0) evictRows(anyOf(unloaded.map(boardPartitionScope)));
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
): { boardId: string; generation: number } | null {
  const boardId = getDisplayedBoardId();
  if (!boardId || agorStore.getState().coverage.has(boardScopeKey(boardId))) return null;
  const generation = nextPartitionGeneration();
  setBoardPartition(boardId, { status: 'loading', ...lifetime, generation });
  return { boardId, generation };
}

/** Whether `boardId`'s entry is still loading and owned by `generation`. */
function ownsLoading(boardId: string, generation: number): boolean {
  const entry = selectBoardPartition(agorStore.getState(), boardId);
  return entry?.status === 'loading' && entry.generation === generation;
}

export function releaseResyncClaim(claim: { boardId: string; generation: number } | null): void {
  if (claim && ownsLoading(claim.boardId, claim.generation)) setBoardPartition(claim.boardId, null);
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

/** A loading or loaded entry of a load that started under `lifetime` after `sinceMark`. */
function startedSince(entry: ScopeCoverage, lifetime: LoadLifetime, sinceMark: number): boolean {
  return (
    entry.status !== 'error' &&
    entry.authorityScope === lifetime.authorityScope &&
    entry.loadEpoch === lifetime.loadEpoch &&
    entry.generation > sinceMark
  );
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
  if (!entry || !startedSince(entry, lifetime, sinceMark)) return undefined;
  if (entry.status === 'loaded') return Promise.resolve();
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
    if (startedSince(entry, lifetime, sinceMark)) {
      boardIds.push(key.slice(BOARD_SCOPE_PREFIX.length));
    }
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
    // Every read is an unbounded `findAll`.
    complete: true,
  };
}

/**
 * Load one board's partition and replace it in the store (`replaceScope`,
 * respecting the other scopes' committed members). Deduplicated per
 * (authority, lifetime, board); resolves once applied, dropped, or failed.
 *
 * The `loading` entry is owned by this load (its `generation`). A load that
 * is cancelled (lifetime ended) or superseded releases its entry instead of
 * leaving the board stuck in `loading`. A load whose every attempt spans a
 * wholesale replacement never applies: it records a retryable error. The
 * snapshot and the `loaded` entry publish in one store update. A displayed
 * board's load holds background ones (`background`), which send no read
 * until the foreground reads settle (`backgroundReads.ts`).
 */
export function loadBoardPartition(
  client: AgorClient,
  boardId: string,
  options: { canUseMemberWorkspaceServices: boolean; background?: boolean }
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

  const generation = nextPartitionGeneration();
  const store = () => agorStore.getState();
  const isCurrent = () => isLoadLifetimeCurrent(lifetime) && ownsLoading(boardId, generation);
  const run = async () => {
    setBoardPartition(boardId, { status: 'loading', authorityScope, loadEpoch, generation });
    // A background board's reads queue behind the foreground ones on the one
    // socket: send none until the open transcript and displayed board settle.
    if (options.background) {
      await backgroundReadsClear();
      if (!isCurrent()) return;
    }
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
        store().applyMaps(
          (prev) =>
            replaceScope(
              prev,
              boardPartitionScope(boardId),
              snapshot,
              touched,
              otherCommittedMembers(store(), boardScopeKey(boardId))
            ),
          settleBoardPartition(boardId, lifetime, generation, snapshot, fence.startRevisions)
        );
        return;
      } catch (err) {
        if (!isCurrent()) return;
        console.warn(`[boardPartitions] load failed for board ${boardId}:`, err);
        setBoardPartition(boardId, {
          status: 'error',
          authorityScope,
          loadEpoch,
          generation,
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
    if (ownsLoading(boardId, generation)) setBoardPartition(boardId, null);
  });
  inflight.set(key, promise);
  if (!options.background) holdBackgroundReads(promise);
  return promise;
}
