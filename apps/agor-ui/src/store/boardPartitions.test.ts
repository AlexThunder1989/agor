import type {
  AgorClient,
  Board,
  BoardComment,
  BoardEntityObject,
  Branch,
  CardWithType,
  Session,
} from '@agor-live/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginPartitionLoad,
  bumpFirstPaintMergeRevisions,
  bumpRevision,
  endPartitionLoad,
  resetHydrationRevisions,
  runHydration,
  touchedSince,
} from './agorHydration';
import { applyBoardPartition, type BoardPartitionSnapshot, EMPTY_MAPS } from './agorMaps';
import { branchRemoved, cardRemoved, sessionPatched } from './agorRealtimeActions';
import { agorStore } from './agorStore';
import {
  loadBoardPartition,
  makeBoardReadySelector,
  markBoardPartitionLoaded,
  retryBoardPartition,
} from './boardPartitions';
import {
  discardRealtimeNow,
  enqueueSessionPatch,
  flushRealtimeNow,
  setRealtimeAuthorityScope,
} from './realtimeBatch';

const AUTHORITY = 'user-a:member:1';
const BOARD = 'board-1';

const branch = (id: string, overrides: Partial<Branch> = {}) =>
  ({ branch_id: id, board_id: BOARD, name: id, archived: false, ...overrides }) as Branch;
const session = (id: string, branchId: string, overrides: Partial<Session> = {}) =>
  ({
    session_id: id,
    branch_id: branchId,
    branch_board_id: BOARD,
    status: 'idle',
    archived: false,
    title: id,
    genealogy: { children: [] },
    created_at: '2026-01-01T00:00:00.000Z',
    last_updated: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as unknown as Session;
const boardObject = (id: string, branchId: string) =>
  ({ object_id: id, board_id: BOARD, branch_id: branchId }) as BoardEntityObject;
const comment = (id: string, branchId?: string) =>
  ({ comment_id: id, board_id: BOARD, branch_id: branchId, content: id }) as BoardComment;
const card = (id: string) => ({ card_id: id, board_id: BOARD, title: id }) as CardWithType;
const fullBoard = (overrides: Partial<Board> = {}) =>
  ({
    board_id: BOARD,
    name: 'Board',
    objects: { 'zone-1': { type: 'zone' } },
    ...overrides,
  }) as unknown as Board;

const snapshotOf = (overrides: Partial<BoardPartitionSnapshot> = {}): BoardPartitionSnapshot => ({
  boardId: BOARD,
  branches: [],
  sessions: [],
  boardObjects: [],
  comments: [],
  cards: [],
  board: null,
  ...overrides,
});

const never = () => false;

describe('applyBoardPartition (fill-only merge)', () => {
  it('inserts absent rows into every map and the session buckets', () => {
    const next = applyBoardPartition(
      EMPTY_MAPS,
      snapshotOf({
        branches: [branch('br-1')],
        sessions: [session('s-1', 'br-1')],
        boardObjects: [boardObject('o-1', 'br-1')],
        comments: [comment('c-1')],
        cards: [card('k-1')],
        board: fullBoard(),
      }),
      never
    );
    expect(next.branchById.has('br-1')).toBe(true);
    expect(next.sessionById.has('s-1')).toBe(true);
    expect(next.sessionsByBranch.get('br-1')?.map((s) => s.session_id)).toEqual(['s-1']);
    expect(next.boardObjectsByBoardId.get(BOARD)?.map((o) => o.object_id)).toEqual(['o-1']);
    expect(next.commentById.has('c-1')).toBe(true);
    expect(next.cardById.has('k-1')).toBe(true);
    expect(next.boardById.get(BOARD)?.objects).toBeDefined();
  });

  it('never overwrites a present row', () => {
    const live = session('s-1', 'br-1', { title: 'live' });
    const liveBranch = branch('br-1', { name: 'live' });
    const prev = applyBoardPartition(
      EMPTY_MAPS,
      snapshotOf({ branches: [liveBranch], sessions: [live] }),
      never
    );
    const next = applyBoardPartition(
      prev,
      snapshotOf({
        branches: [branch('br-1', { name: 'stale' })],
        sessions: [session('s-1', 'br-1', { title: 'stale' })],
      }),
      never
    );
    expect(next).toBe(prev);
    expect(next.sessionById.get('s-1')?.title).toBe('live');
    expect(next.branchById.get('br-1')?.name).toBe('live');
  });

  it('skips touched ids and rows on a touched-and-absent branch', () => {
    const touched = new Set(['sessions:s-gone', 'branches:br-archived', 'cards:k-gone']);
    const next = applyBoardPartition(
      EMPTY_MAPS,
      snapshotOf({
        branches: [branch('br-1'), branch('br-archived')],
        sessions: [
          session('s-1', 'br-1'),
          session('s-gone', 'br-1'),
          session('s-orphan', 'br-archived'),
        ],
        boardObjects: [boardObject('o-1', 'br-1'), boardObject('o-orphan', 'br-archived')],
        comments: [comment('c-1', 'br-1'), comment('c-orphan', 'br-archived')],
        cards: [card('k-1'), card('k-gone')],
      }),
      (collection, id) => touched.has(`${collection}:${id}`)
    );
    expect([...next.branchById.keys()]).toEqual(['br-1']);
    expect([...next.sessionById.keys()]).toEqual(['s-1']);
    expect([...next.boardObjectById.keys()]).toEqual(['o-1']);
    expect([...next.commentById.keys()]).toEqual(['c-1']);
    expect([...next.cardById.keys()]).toEqual(['k-1']);
  });

  it('replaces the lean board row unless the board was touched', () => {
    const lean = { board_id: BOARD, name: 'Board' } as Board;
    const prev = { ...EMPTY_MAPS, boardById: new Map([[BOARD, lean]]) };
    expect(
      applyBoardPartition(prev, snapshotOf({ board: fullBoard() }), never).boardById.get(BOARD)
        ?.objects
    ).toBeDefined();
    expect(
      applyBoardPartition(
        prev,
        snapshotOf({ board: fullBoard() }),
        (collection) => collection === 'boards'
      ).boardById.get(BOARD)
    ).toBe(lean);
  });

  it('projects remote-create surrogates regardless of snapshot order', () => {
    const target = session('s-target', 'br-2');
    const source = session('s-source', 'br-1', {
      remote_relationships: {
        as_source: [
          {
            relationship_type: 'remote_create',
            source_session_id: 's-source',
            target_session_id: 's-target',
          },
        ],
      },
    } as Partial<Session>);
    const next = applyBoardPartition(
      EMPTY_MAPS,
      snapshotOf({ branches: [branch('br-1'), branch('br-2')], sessions: [source, target] }),
      never
    );
    expect(next.sessionsByBranch.get('br-1')?.map((s) => s.session_id)).toEqual([
      's-source',
      's-target',
    ]);
    expect(next.sessionsByBranch.get('br-1')?.[1].remote_surrogate).toBeDefined();
  });
});

describe('touched fence', () => {
  beforeEach(() => resetHydrationRevisions());

  it('only stamps ids while a partition load is in flight', () => {
    bumpRevision('sessions', 'before');
    const fence = beginPartitionLoad();
    bumpRevision('sessions', 'during');
    expect(touchedSince('sessions', 'during', fence.startRevisions.sessions)).toBe(true);
    expect(touchedSince('sessions', 'before', fence.startRevisions.sessions)).toBe(false);
    endPartitionLoad();
    expect(touchedSince('sessions', 'during', fence.startRevisions.sessions)).toBe(false);
  });
});

/** Controllable mock client: each service call resolves when released. */
function makePartitionClient(data: {
  branches?: Branch[];
  sessions?: Session[];
  boardObjects?: BoardEntityObject[];
  comments?: BoardComment[];
  cards?: CardWithType[];
  board?: Board;
}) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const respond = async <T>(name: string, value: T) => {
    calls.push(name);
    await gate;
    return value;
  };
  const byService: Record<string, unknown> = {
    branches: data.branches ?? [],
    sessions: data.sessions ?? [],
    'board-objects': data.boardObjects ?? [],
    'board-comments': data.comments ?? [],
    cards: data.cards ?? [],
  };
  const client = {
    service: (name: string) => ({
      findAll: vi.fn(() => respond(name, byService[name])),
      get: vi.fn(() => respond(`${name}:get`, data.board ?? fullBoard())),
    }),
  } as unknown as AgorClient;
  return { client, release: () => release(), calls };
}

describe('loadBoardPartition', () => {
  beforeEach(() => {
    agorStore.getState().reset();
    resetHydrationRevisions();
    discardRealtimeNow();
    setRealtimeAuthorityScope(AUTHORITY);
  });
  afterEach(() => {
    setRealtimeAuthorityScope(null);
    discardRealtimeNow();
    agorStore.getState().reset();
    resetHydrationRevisions();
  });

  const ready = () => makeBoardReadySelector(BOARD)(agorStore.getState());

  it('marks the board loading, fills the snapshot, then marks it loaded', async () => {
    const { client, release } = makePartitionClient({
      branches: [branch('br-1')],
      sessions: [session('s-1', 'br-1')],
    });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    expect(agorStore.getState().boardPartitions.get(BOARD)?.status).toBe('loading');
    expect(ready()).toBe(false);
    release();
    await load;
    expect(ready()).toBe(true);
    expect(agorStore.getState().sessionById.has('s-1')).toBe(true);
  });

  it('dedupes in-flight loads of the same board', async () => {
    const { client, release, calls } = makePartitionClient({});
    const a = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    const b = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    expect(b).toBe(a);
    release();
    await a;
    expect(calls.filter((c) => c === 'sessions')).toHaveLength(1);
  });

  it('skips board objects for callers without member workspace services', async () => {
    const { client, release, calls } = makePartitionClient({});
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: false });
    release();
    await load;
    expect(calls).not.toContain('board-objects');
    expect(ready()).toBe(true);
  });

  it('drops the apply when the authority changes mid-load', async () => {
    const { client, release } = makePartitionClient({ sessions: [session('s-1', 'br-1')] });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    setRealtimeAuthorityScope('user-b:member:1');
    release();
    await load;
    expect(agorStore.getState().sessionById.size).toBe(0);
    // The stale load never writes partition state under the new authority.
    expect(agorStore.getState().boardPartitions.get(BOARD)?.authorityScope).toBe(AUTHORITY);
  });

  it('lets a patch queued during the load beat the snapshot, and never resurrects a removal', async () => {
    const { client, release } = makePartitionClient({
      branches: [branch('br-1')],
      sessions: [session('s-1', 'br-1', { title: 'stale' }), session('s-2', 'br-1')],
      cards: [card('k-1')],
    });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    // A streaming patch arrives mid-load and sits in the frame queue.
    bumpRevision('sessions');
    enqueueSessionPatch(AUTHORITY, session('s-1', 'br-1', { title: 'live' }));
    // A card removal for a row the snapshot still contains.
    cardRemoved(card('k-1'));
    release();
    await load;
    expect(agorStore.getState().sessionById.has('s-1')).toBe(false);
    expect(agorStore.getState().sessionById.has('s-2')).toBe(true);
    expect(agorStore.getState().cardById.has('k-1')).toBe(false);
    flushRealtimeNow(AUTHORITY);
    expect(agorStore.getState().sessionById.get('s-1')?.title).toBe('live');
  });

  it('skips rows on a branch deleted mid-load', async () => {
    const { client, release } = makePartitionClient({
      branches: [branch('br-1')],
      sessions: [session('s-1', 'br-1')],
      boardObjects: [boardObject('o-1', 'br-1')],
    });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    branchRemoved(branch('br-1'));
    release();
    await load;
    const state = agorStore.getState();
    expect(state.branchById.size).toBe(0);
    expect(state.sessionById.size).toBe(0);
    expect(state.boardObjectById.size).toBe(0);
    expect(ready()).toBe(true);
  });

  it('keeps a session patched live during the load', async () => {
    const live = session('s-1', 'br-1', { title: 'live' });
    sessionPatched(live);
    const { client, release } = makePartitionClient({
      sessions: [session('s-1', 'br-1', { title: 'stale' })],
    });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    release();
    await load;
    expect(agorStore.getState().sessionById.get('s-1')?.title).toBe('live');
  });

  it('restarts instead of applying across a wholesale reconnect replacement', async () => {
    let calls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const client = {
      service: (name: string) => ({
        findAll: vi.fn(async () => {
          if (name === 'sessions') calls += 1;
          if (calls === 1) await firstGate;
          return name === 'sessions'
            ? calls === 1
              ? [session('s-deleted-while-offline', 'br-1')]
              : [session('s-1', 'br-1')]
            : [];
        }),
        get: vi.fn(async () => fullBoard()),
      }),
    } as unknown as AgorClient;
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    bumpFirstPaintMergeRevisions();
    releaseFirst();
    await load;
    expect(calls).toBe(2);
    expect([...agorStore.getState().sessionById.keys()]).toEqual(['s-1']);
  });

  it('records a failure and lets retry clear it', async () => {
    const client = {
      service: () => ({
        findAll: vi.fn(async () => {
          throw new Error('boom');
        }),
        get: vi.fn(async () => fullBoard()),
      }),
    } as unknown as AgorClient;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    expect(agorStore.getState().boardPartitions.get(BOARD)?.status).toBe('error');
    retryBoardPartition(BOARD);
    expect(agorStore.getState().boardPartitions.has(BOARD)).toBe(false);
  });
});

describe('board readiness', () => {
  beforeEach(() => {
    agorStore.getState().reset();
    resetHydrationRevisions();
    setRealtimeAuthorityScope(AUTHORITY);
  });
  afterEach(() => setRealtimeAuthorityScope(null));

  it('is ready once the first-paint apply marks the board loaded', () => {
    markBoardPartitionLoaded(BOARD);
    expect(makeBoardReadySelector(BOARD)(agorStore.getState())).toBe(true);
    expect(makeBoardReadySelector('board-2')(agorStore.getState())).toBe(false);
  });

  it('treats every board as ready once all six global snapshots have applied', async () => {
    const collections = [
      'sessions',
      'branches',
      'boardObjects',
      'cards',
      'comments',
      'boards',
    ] as const;
    for (const [i, c] of collections.entries()) {
      expect(makeBoardReadySelector('board-2')(agorStore.getState())).toBe(false);
      await runHydration(
        c,
        [c],
        async () => [],
        () => {}
      );
      if (i < collections.length - 1)
        expect(makeBoardReadySelector('board-2')(agorStore.getState())).toBe(false);
    }
    expect(makeBoardReadySelector('board-2')(agorStore.getState())).toBe(true);
  });

  it('resets with the maps on an identity change', () => {
    markBoardPartitionLoaded(BOARD);
    agorStore.getState().resetMaps();
    expect(makeBoardReadySelector(BOARD)(agorStore.getState())).toBe(false);
  });
});
