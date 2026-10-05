/**
 * Load scopes, their coverage, and the two reducers that apply a scope's
 * snapshot (design r3 §3.8, §4.5).
 *
 * A scope is a set of rows one load is authoritative for: one board's
 * partition, a piece of the caller's user scope, and (Steps 1–2 only) the
 * global session and branch sets. Both reducers are fenced per id: a row that
 * a live event wrote since the load began keeps its live value, or its absence.
 *
 * - `fillScope` inserts absent rows and never overwrites a present one (I2).
 *   It cannot remove anything, so it is not reconciliation.
 * - `replaceScope` reconciles: it also overwrites present rows with the
 *   snapshot, and removes rows the scope claims that the snapshot no longer
 *   returns (deleted, moved out, or no longer visible) — only when the read
 *   was complete, and only when no other scope's committed read returned them.
 *
 * Each scope's state is one `ScopeCoverage` entry in the store's `coverage`
 * map: its status and lifetime, and, once loaded, its committed membership
 * (the ids its read actually returned) and whether that read was complete.
 * A scope's own replace finds candidates with a predicate on the CURRENT row
 * (`LoadScope`), so rows realtime moved in since are reconciled too; another
 * scope keeps a row only through its committed membership, so a loading or
 * failed scope keeps nothing alive, and two scopes whose reads both omit a row
 * converge instead of each deferring to the other's predicate.
 */
import type { Board, BoardEntityObject, Branch, CardWithType, Session } from '@agor-live/client';
import { isTeammate } from '@agor-live/client';
import { boardIdForSession } from '../utils/boardIdForSession';
import { shallowEqualEntity } from '../utils/shallowEqual';
import {
  applyEntityFill,
  applySessionPatchToMaps,
  buildSessionMaps,
  type DataMaps,
  isOnRemovedBranch,
  type PartitionTouched,
  removeBoardObjectFromMaps,
  upsertBoardObjectInMaps,
} from './agorMaps';

/** Rows of one scope's snapshot; an omitted collection is not part of the load. */
export interface ScopeRows {
  branches?: readonly Branch[];
  sessions?: readonly Session[];
  /** `null`: not read (a global viewer cannot read board objects). */
  boardObjects?: readonly BoardEntityObject[] | null;
  cards?: readonly CardWithType[];
  /** The scope's full board record; replaces the lean row unless touched. */
  board?: Board | null;
  /**
   * `false` for a capped read: it lists only part of the scope, so a row it
   * omits may still exist and is never removed.
   */
  complete?: boolean;
}

/** Which current store rows a scope claims. A missing predicate claims none. */
export interface LoadScope {
  key: string;
  claims: {
    branches?: (branch: Branch, maps: DataMaps) => boolean;
    sessions?: (session: Session, maps: DataMaps) => boolean;
    boardObjects?: (boardObject: BoardEntityObject, maps: DataMaps) => boolean;
    cards?: (card: CardWithType, maps: DataMaps) => boolean;
  };
}

export type CoverageCollection = keyof LoadScope['claims'];

/** Row ids per collection that a committed read returned. */
export type CoverageMembers = Readonly<Partial<Record<CoverageCollection, ReadonlySet<string>>>>;
/** What a replace asks of another scope's members: only `has` (the global sets hold every id). */
export type MemberLookup = Readonly<
  Partial<Record<CoverageCollection, Pick<ReadonlySet<string>, 'has'>>>
>;

/**
 * One scope's coverage: where its load is, under which lifetime, and what its
 * committed read held. Presence of rows never implies completeness (I1); a
 * `loaded` entry does. An entry from another lifetime (`authorityScope`,
 * `loadEpoch`) is stale: it may still drive readiness flags, but its members
 * keep no row alive.
 */
export interface ScopeCoverage {
  status: 'loading' | 'loaded' | 'error';
  /** Authority scope of the load; a load never applies across scopes. */
  authorityScope: string;
  /** Hydration cancellation epoch of that load. */
  loadEpoch: number;
  /** The load that owns a `loading` entry; only its owner may settle or release it. */
  loadId?: number;
  /** The load that settled a `loaded` entry (absent when first paint or a resync did). */
  loadedBy?: number;
  error?: string;
  /** The ids the committed read returned (not archived), per collection read. */
  members?: CoverageMembers;
  /** `false`: the committed read was capped, so `members` is part of the scope. */
  complete?: boolean;
}

export const BOARD_SCOPE_PREFIX = 'board:';
export const boardScopeKey = (boardId: string) => `${BOARD_SCOPE_PREFIX}${boardId}`;

/** Coverage keys of the user scope's pieces (`userScope.ts`). */
export const USER_SCOPE_KEYS = {
  /** All of my active sessions (U1, or a complete gated page). */
  sessions: 'user:sessions',
  /** My branches (U2). */
  branches: 'user:branches',
  /** Teammate branches I can view (U3, capped). */
  teammates: 'user:teammates',
  /** Branches my sessions and comment threads reference (U5, by id). */
  references: 'user:references',
} as const;

/** The committed membership of a read: the ids of its rows that are not archived. */
export function scopeMembers(rows: ScopeRows): CoverageMembers {
  const live = <T extends { archived?: boolean }>(list: readonly T[], id: (row: T) => string) =>
    new Set(list.filter((row) => !row.archived).map(id));
  return {
    ...(rows.branches ? { branches: live(rows.branches, (b) => b.branch_id) } : {}),
    ...(rows.sessions ? { sessions: live(rows.sessions, (r) => r.session_id) } : {}),
    ...(rows.boardObjects
      ? { boardObjects: new Set(rows.boardObjects.map((o) => o.object_id)) }
      : {}),
    ...(rows.cards ? { cards: new Set(rows.cards.map((c) => c.card_id)) } : {}),
  };
}

/** One board's partition: its branches, sessions, board objects and cards. */
export function boardPartitionScope(boardId: string): LoadScope {
  return {
    key: boardScopeKey(boardId),
    claims: {
      branches: (branch) => branch.board_id === boardId,
      sessions: (session, maps) => boardIdForSession(session, maps.branchById) === boardId,
      boardObjects: (boardObject) => boardObject.board_id === boardId,
      cards: (card) => card.board_id === boardId,
    },
  };
}

/**
 * The caller's user scope (`userScope.ts`): my active sessions, and my
 * branches, teammate branches and the branches my sessions or comment
 * threads reference (`referenced`, computed at most once per reducer call).
 */
export function userScopeClaims(userId: string, referenced: () => ReadonlySet<string>): LoadScope {
  return {
    key: 'user',
    claims: {
      sessions: (session) => !session.archived && session.created_by === userId,
      branches: (branch) =>
        branch.created_by === userId || isTeammate(branch) || referenced().has(branch.branch_id),
    },
  };
}

const EVERY_ID: Pick<ReadonlySet<string>, 'has'> = { has: () => true };

/**
 * Steps 1–2 only: once a global session or branch snapshot has applied, the
 * global set holds every row of that collection, so no partition replace
 * removes one; the global resync reconciles them. Removed with global
 * hydration in 3.3. Annotations have no global claim: a card or board object
 * belongs to exactly one board, so its board's partition is authoritative.
 */
export function globalSetsMembers(globallyHydrated: ReadonlySet<string>): MemberLookup {
  return {
    ...(globallyHydrated.has('sessions') ? { sessions: EVERY_ID } : {}),
    ...(globallyHydrated.has('branches') ? { branches: EVERY_ID } : {}),
  };
}

/**
 * Fill-only apply: insert absent, untouched rows of every collection in
 * `rows`; never overwrite or remove. Branches and sessions go through
 * `applyEntityFill`; board objects and cards follow the same rules (rows on a
 * touched-and-absent branch are skipped). `rows.board` is ignored: a board
 * record is always replaced (see `replaceScope`).
 */
export function fillScope(prev: DataMaps, rows: ScopeRows, touched: PartitionTouched): DataMaps {
  let maps = applyEntityFill(prev, rows, touched);

  for (const boardObject of rows.boardObjects ?? []) {
    if (maps.boardObjectById.has(boardObject.object_id)) continue;
    if (
      touched('boardObjects', boardObject.object_id) ||
      isOnRemovedBranch(maps, boardObject.branch_id, touched)
    )
      continue;
    maps = upsertBoardObjectInMaps(maps, boardObject, 'create');
  }

  let cardById = maps.cardById;
  for (const card of rows.cards ?? []) {
    if (cardById.has(card.card_id) || touched('cards', card.card_id)) continue;
    if (cardById === maps.cardById) cardById = new Map(cardById);
    cardById.set(card.card_id, card);
  }
  if (cardById !== maps.cardById) maps = { ...maps, cardById };

  return maps;
}

/**
 * Whether a snapshot row equals the store row. The daemon reserializes nested
 * fields (positions, configs, board objects), so a shallow compare would
 * rewrite — and re-render — every row on each replace; compare the JSON when
 * the shallow check fails.
 */
function sameRow(a: object | undefined, b: object): boolean {
  if (!a) return false;
  return shallowEqualEntity(a, b) || JSON.stringify(a) === JSON.stringify(b);
}

/** Above this many session upserts and removals, rebuild the session maps once. */
const INCREMENTAL_SESSION_LIMIT = 64;

/**
 * Reconciling apply of `scope`'s snapshot, for every collection present in
 * `rows`:
 *
 * - every untouched snapshot row is inserted or overwrites the store row;
 * - when the read was complete, every untouched store row the scope claims
 *   but the snapshot omits is removed, unless one of `others` (the committed
 *   memberships of the other loaded scopes) holds it;
 * - touched rows keep their live value or absence, and snapshot rows on a
 *   branch removed live during the load are skipped.
 *
 * Returns `prev` unchanged when nothing changed. Never bumps revisions.
 */
export function replaceScope(
  prev: DataMaps,
  scope: LoadScope,
  rows: ScopeRows,
  touched: PartitionTouched,
  others: readonly MemberLookup[]
): DataMaps {
  let maps = prev;
  const claims: LoadScope['claims'] = rows.complete === false ? {} : scope.claims;
  const claimedElsewhere = (collection: CoverageCollection, id: string) =>
    others.some((other) => other[collection]?.has(id));

  if (rows.branches) {
    const returned = new Map<string, Branch>();
    for (const branch of rows.branches) {
      if (!branch.archived) returned.set(branch.branch_id, branch);
    }
    let branchById = maps.branchById;
    const write = () => {
      if (branchById === maps.branchById) branchById = new Map(branchById);
      return branchById;
    };
    for (const [id, branch] of returned) {
      if (touched('branches', id)) continue;
      if (!sameRow(branchById.get(id), branch)) write().set(id, branch);
    }
    const claim = claims.branches;
    if (claim) {
      for (const [id, branch] of maps.branchById) {
        if (returned.has(id) || touched('branches', id) || !claim(branch, maps)) continue;
        if (claimedElsewhere('branches', id)) continue;
        write().delete(id);
      }
    }
    if (branchById !== maps.branchById) maps = { ...maps, branchById };
  }

  if (rows.sessions) {
    const returned = new Map<string, Session>();
    for (const session of rows.sessions) {
      if (!session.archived) returned.set(session.session_id, session);
    }
    const upserts: Session[] = [];
    for (const [id, session] of returned) {
      if (touched('sessions', id) || isOnRemovedBranch(maps, session.branch_id, touched)) continue;
      if (!sameRow(maps.sessionById.get(id), session)) upserts.push(session);
    }
    const removals: Session[] = [];
    const claim = claims.sessions;
    if (claim) {
      for (const [id, session] of maps.sessionById) {
        // Archived rows are deep-link heals outside every list scope.
        if (session.archived || returned.has(id) || touched('sessions', id)) continue;
        if (!claim(session, maps) || claimedElsewhere('sessions', id)) continue;
        removals.push(session);
      }
    }
    if (upserts.length + removals.length > INCREMENTAL_SESSION_LIMIT) {
      const removed = new Set(removals.map((session) => session.session_id));
      const next = new Map(maps.sessionById);
      for (const id of removed) next.delete(id);
      for (const session of upserts) next.set(session.session_id, session);
      const rebuilt = buildSessionMaps([...next.values()], {
        sessionById: maps.sessionById,
        sessionsByBranch: maps.sessionsByBranch,
      });
      maps = { ...maps, ...rebuilt };
    } else {
      // Archiving removes a session from `sessionById` and every bucket.
      for (const session of removals) {
        maps = applySessionPatchToMaps(maps, { ...session, archived: true });
      }
      // Remote-create sources after their targets, as in `applyEntityFill`.
      upserts.sort(
        (a, b) =>
          Number(!!a.remote_relationships?.as_source?.length) -
          Number(!!b.remote_relationships?.as_source?.length)
      );
      for (const session of upserts) maps = applySessionPatchToMaps(maps, session);
    }
  }

  if (rows.boardObjects) {
    const returned = new Map<string, BoardEntityObject>();
    for (const boardObject of rows.boardObjects) returned.set(boardObject.object_id, boardObject);
    for (const [id, boardObject] of returned) {
      if (touched('boardObjects', id) || isOnRemovedBranch(maps, boardObject.branch_id, touched))
        continue;
      if (sameRow(maps.boardObjectById.get(id), boardObject)) continue;
      maps = upsertBoardObjectInMaps(maps, boardObject, 'patch');
    }
    const claim = claims.boardObjects;
    if (claim) {
      for (const [id, boardObject] of maps.boardObjectById) {
        if (returned.has(id) || touched('boardObjects', id) || !claim(boardObject, maps)) continue;
        if (claimedElsewhere('boardObjects', id)) continue;
        maps = removeBoardObjectFromMaps(maps, boardObject);
      }
    }
  }

  if (rows.cards) {
    const returned = new Map<string, CardWithType>();
    for (const card of rows.cards) returned.set(card.card_id, card);
    let cardById = maps.cardById;
    const write = () => {
      if (cardById === maps.cardById) cardById = new Map(cardById);
      return cardById;
    };
    for (const [id, card] of returned) {
      if (touched('cards', id)) continue;
      if (!sameRow(cardById.get(id), card)) write().set(id, card);
    }
    const claim = claims.cards;
    if (claim) {
      for (const [id, card] of maps.cardById) {
        if (returned.has(id) || touched('cards', id) || !claim(card, maps)) continue;
        if (claimedElsewhere('cards', id)) continue;
        write().delete(id);
      }
    }
    if (cardById !== maps.cardById) maps = { ...maps, cardById };
  }

  const board = rows.board;
  if (board && !touched('boards', board.board_id)) {
    if (!sameRow(maps.boardById.get(board.board_id), board)) {
      maps = { ...maps, boardById: new Map(maps.boardById).set(board.board_id, board) };
    }
  }

  return maps;
}

/** One board's partition as fetched by `loadBoardPartition`. */
export interface BoardPartitionSnapshot extends ScopeRows {
  boardId: string;
  branches: readonly Branch[];
  sessions: readonly Session[];
  boardObjects: readonly BoardEntityObject[] | null;
  cards: readonly CardWithType[];
  board: Board | null;
}

/**
 * Apply a board partition: branches and sessions fill-only (Steps 1–2: the
 * global sets and their resync own them), board objects, cards and the full
 * board record reconcile with `replaceScope`. Comments are global and loaded
 * before first paint, so they are not part of a partition.
 */
export function applyPartitionSnapshot(
  prev: DataMaps,
  snapshot: BoardPartitionSnapshot,
  touched: PartitionTouched,
  others: readonly MemberLookup[]
): DataMaps {
  const filled = fillScope(
    prev,
    { branches: snapshot.branches, sessions: snapshot.sessions },
    touched
  );
  return replaceScope(
    filled,
    boardPartitionScope(snapshot.boardId),
    { boardObjects: snapshot.boardObjects, cards: snapshot.cards, board: snapshot.board },
    touched,
    others
  );
}
