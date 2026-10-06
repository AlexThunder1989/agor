/**
 * Long-tab retention (design r3 §4.5): with global hydration off, opening and
 * closing many boards and sessions keeps the store on a plateau — the
 * displayed board, `RETAINED_BACKGROUND_PARTITIONS` recent partitions, the
 * user scope and the pinned rows — instead of growing with every visit.
 */
import type { AgorClient, Board, Branch, CardWithType, Session } from '@agor-live/client';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resetHydrationRevisions } from '../store/agorHydration';
import { agorStore } from '../store/agorStore';
import { makeBoardReadySelector, RETAINED_BACKGROUND_PARTITIONS } from '../store/boardPartitions';
import { captureLoadLifetime } from '../store/loadLifetime';
import { discardRealtimeNow, setRealtimeAuthorityScope } from '../store/realtimeBatch';
import { USER_SCOPE_KEYS } from '../store/scopeMerge';
import { setGlobalHydrationForTests } from './useAgorData';
import { useBoardPartition } from './useBoardPartition';
import { useEnsureSessions } from './useEnsureRows';
import { usePinnedOpenRows } from './usePinnedRows';

const AUTHORITY = 'user-me:member:1';
const ME = 'user-me';
const BOARDS = 20;
const BRANCHES_PER_BOARD = 5;
const SESSIONS_PER_BRANCH = 4;
const OPENED_SESSIONS = 50;

const boardId = (b: number) => `board-${b}`;
const branchId = (b: number, r: number) => `br-${b}-${r}`;
const sessionId = (b: number, r: number, s: number) => `s-${b}-${r}-${s}`;

/** Every board's rows on the server; one session per board is mine. */
function server() {
  const branches: Branch[] = [];
  const sessions: Session[] = [];
  const cards: CardWithType[] = [];
  for (let b = 0; b < BOARDS; b++) {
    cards.push({ card_id: `k-${b}`, board_id: boardId(b), title: 'card' } as CardWithType);
    for (let r = 0; r < BRANCHES_PER_BOARD; r++) {
      branches.push({
        branch_id: branchId(b, r),
        board_id: boardId(b),
        name: branchId(b, r),
        archived: false,
        created_by: 'user-other',
      } as Branch);
      for (let s = 0; s < SESSIONS_PER_BRANCH; s++) {
        sessions.push({
          session_id: sessionId(b, r, s),
          branch_id: branchId(b, r),
          branch_board_id: boardId(b),
          created_by: r === 0 && s === 0 ? ME : 'user-other',
          status: 'idle',
          archived: false,
          title: sessionId(b, r, s),
          genealogy: { children: [] },
        } as unknown as Session);
      }
    }
  }
  return { branches, sessions, cards };
}

function makeClient(rows: ReturnType<typeof server>) {
  const onBoard = <T extends { board_id?: string | null }>(list: T[], id: unknown) =>
    list.filter((row) => row.board_id === id);
  const client = {
    service: (name: string) => ({
      findAll: async ({ query }: { query: Record<string, unknown> }) => {
        if (name === 'branches') return onBoard(rows.branches, query.board_id);
        if (name === 'sessions')
          return rows.sessions.filter((s) => s.branch_board_id === query.board_id);
        if (name === 'cards') return onBoard(rows.cards, query.board_id);
        return [];
      },
      find: async ({ query }: { query: { session_id: { $in: string[] } } }) =>
        rows.sessions.filter((s) => query.session_id.$in.includes(s.session_id)),
      get: async (id: string) => ({ board_id: id, name: id, objects: {} }) as unknown as Board,
    }),
  } as unknown as AgorClient;
  return client;
}

/** The app shell: the displayed board, and the open session read by id and pinned. */
function useShell(client: AgorClient, board: string | null, session: string | null) {
  useBoardPartition(client, board, { canUseMemberWorkspaceServices: true });
  useEnsureSessions(client, session ? [session] : []);
  usePinnedOpenRows({ sessions: [session] });
}

beforeEach(() => {
  setGlobalHydrationForTests(false);
  discardRealtimeNow();
  setRealtimeAuthorityScope(AUTHORITY);
  const store = agorStore.getState();
  store.setDataAuthority(AUTHORITY);
  store.setLoading(false);
  store.replaceMaps({
    boardById: new Map(
      Array.from({ length: BOARDS }, (_, b) => [boardId(b), { board_id: boardId(b) } as Board])
    ),
  });
});
afterEach(() => {
  cleanup();
  setGlobalHydrationForTests(true);
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
  resetHydrationRevisions();
});

it('opening and closing 20 boards and 50 sessions keeps the store on a plateau', async () => {
  const rows = server();
  const client = makeClient(rows);
  // The user scope: my sessions, loaded with their rows.
  const mine = rows.sessions.filter((s) => s.created_by === ME);
  agorStore.getState().applyMaps(
    (prev) => ({
      ...prev,
      sessionById: new Map([...prev.sessionById, ...mine.map((s) => [s.session_id, s] as const)]),
    }),
    (_maps, coverage) =>
      new Map(coverage).set(USER_SCOPE_KEYS.sessions, {
        status: 'loaded',
        ...captureLoadLifetime()!,
        generation: 0,
        userId: ME,
        members: { sessions: new Set(mine.map((s) => s.session_id)) },
        complete: true,
      })
  );

  const { rerender, unmount } = renderHook(
    ({ board, session }: { board: string | null; session: string | null }) =>
      useShell(client, board, session),
    { initialProps: { board: null as string | null, session: null as string | null } }
  );

  const perBoard = {
    branches: BRANCHES_PER_BOARD,
    sessions: BRANCHES_PER_BOARD * SESSIONS_PER_BRANCH,
  };
  const partitions = 1 + RETAINED_BACKGROUND_PARTITIONS;
  // Displayed + retained partitions, the user scope, and the open session with its pin.
  const bound = {
    branches: partitions * perBoard.branches,
    sessions: partitions * perBoard.sessions + mine.length + 1,
    cards: partitions,
  };
  const peak = { branches: 0, sessions: 0, cards: 0, partitions: 0 };
  const record = () => {
    const state = agorStore.getState();
    peak.branches = Math.max(peak.branches, state.branchById.size);
    peak.sessions = Math.max(peak.sessions, state.sessionById.size);
    peak.cards = Math.max(peak.cards, state.cardById.size);
    peak.partitions = Math.max(
      peak.partitions,
      [...state.coverage.keys()].filter((key) => key.startsWith('board:')).length
    );
    expect(state.branchById.size).toBeLessThanOrEqual(bound.branches);
    expect(state.sessionById.size).toBeLessThanOrEqual(bound.sessions);
    expect(state.cardById.size).toBeLessThanOrEqual(bound.cards);
  };

  for (let i = 0; i < OPENED_SESSIONS; i++) {
    const board = boardId(i % BOARDS);
    // A session on a board that is not loaded: read by id, pinned while open.
    const b = (i + 7) % BOARDS;
    const session = sessionId(b, 1 + (i % (BRANCHES_PER_BOARD - 1)), i % SESSIONS_PER_BRANCH);
    rerender({ board, session });
    await waitFor(() => {
      const state = agorStore.getState();
      expect(makeBoardReadySelector(board)(state)).toBe(true);
      expect(state.sessionById.has(session)).toBe(true);
    });
    record();
  }
  // Close the session and leave for Home.
  rerender({ board: null, session: null });
  record();

  const state = agorStore.getState();
  const final = {
    branches: state.branchById.size,
    sessions: state.sessionById.size,
    cards: state.cardById.size,
    partitions: [...state.coverage.keys()].filter((key) => key.startsWith('board:')).length,
  };
  // The plateau: never more than the displayed board and the retained ones.
  expect(peak.partitions).toBe(partitions);
  expect(peak.branches).toBe(bound.branches);
  expect(peak.cards).toBe(bound.cards);
  // Home: the last RETAINED_BACKGROUND_PARTITIONS boards, the user scope, no pins.
  expect(final.partitions).toBe(RETAINED_BACKGROUND_PARTITIONS);
  expect(final.branches).toBe(RETAINED_BACKGROUND_PARTITIONS * perBoard.branches);
  expect(final.cards).toBe(RETAINED_BACKGROUND_PARTITIONS);
  const retainedMine = mine.filter((s) => !state.sessionById.has(s.session_id));
  expect(retainedMine).toEqual([]);
  expect(final.sessions).toBe(
    RETAINED_BACKGROUND_PARTITIONS * perBoard.sessions +
      mine.length -
      RETAINED_BACKGROUND_PARTITIONS
  );
  expect(state.globallyHydrated.size).toBe(0);
  unmount();
});
