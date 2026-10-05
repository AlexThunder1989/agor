import type {
  AgorClient,
  Board,
  BoardEntityObject,
  Branch,
  CardWithType,
  Session,
} from '@agor-live/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardCoverage, markBoardLoaded } from '../test/userScopeCoverage';
import {
  beginPartitionLoad,
  bumpFirstPaintMergeRevisions,
  bumpRevision,
  cancelAllHydrations,
  endPartitionLoad,
  resetHydrationRevisions,
  runHydration,
  touchedSince,
} from './agorHydration';
import { EMPTY_MAPS } from './agorMaps';
import {
  branchPatched,
  branchRemoved,
  cardCreated,
  cardRemoved,
  sessionPatched,
} from './agorRealtimeActions';
import { agorStore } from './agorStore';
import {
  loadBoardPartition,
  makeBoardReadySelector,
  otherCommittedMembers,
  partitionLoadMark,
  partitionLoadSince,
  partitionsLoadedSince,
  retryBoardPartition,
  selectBoardPartition,
} from './boardPartitions';
import { captureLoadLifetime, isLoadLifetimeCurrent } from './loadLifetime';
import {
  discardRealtimeNow,
  enqueueSessionPatch,
  flushRealtimeNow,
  setRealtimeAuthorityScope,
} from './realtimeBatch';
import {
  applyPartitionSnapshot,
  type BoardPartitionSnapshot,
  boardPartitionScope,
  boardScopeKey,
  replaceScope,
  USER_SCOPE_KEYS,
} from './scopeMerge';

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
  cards: [],
  board: null,
  complete: true,
  ...overrides,
});

const never = () => false;

describe('applyPartitionSnapshot', () => {
  it('inserts absent rows into every map and the session buckets', () => {
    const next = applyPartitionSnapshot(
      EMPTY_MAPS,
      snapshotOf({
        branches: [branch('br-1')],
        sessions: [session('s-1', 'br-1')],
        boardObjects: [boardObject('o-1', 'br-1')],
        cards: [card('k-1')],
        board: fullBoard(),
      }),
      never
    );
    expect(next.branchById.has('br-1')).toBe(true);
    expect(next.sessionById.has('s-1')).toBe(true);
    expect(next.sessionsByBranch.get('br-1')?.map((s) => s.session_id)).toEqual(['s-1']);
    expect(next.boardObjectsByBoardId.get(BOARD)?.map((o) => o.object_id)).toEqual(['o-1']);
    expect(next.cardById.has('k-1')).toBe(true);
    expect(next.boardById.get(BOARD)?.objects).toBeDefined();
  });

  it('never overwrites a present branch or session (the global sets own them)', () => {
    const live = session('s-1', 'br-1', { title: 'live' });
    const liveBranch = branch('br-1', { name: 'live' });
    const prev = applyPartitionSnapshot(
      EMPTY_MAPS,
      snapshotOf({ branches: [liveBranch], sessions: [live] }),
      never
    );
    const next = applyPartitionSnapshot(
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
    const next = applyPartitionSnapshot(
      EMPTY_MAPS,
      snapshotOf({
        branches: [branch('br-1'), branch('br-archived')],
        sessions: [
          session('s-1', 'br-1'),
          session('s-gone', 'br-1'),
          session('s-orphan', 'br-archived'),
        ],
        boardObjects: [boardObject('o-1', 'br-1'), boardObject('o-orphan', 'br-archived')],
        cards: [card('k-1'), card('k-gone')],
      }),
      (collection, id) => touched.has(`${collection}:${id}`)
    );
    expect([...next.branchById.keys()]).toEqual(['br-1']);
    expect([...next.sessionById.keys()]).toEqual(['s-1']);
    expect([...next.boardObjectById.keys()]).toEqual(['o-1']);
    expect([...next.cardById.keys()]).toEqual(['k-1']);
  });

  it('replaces the lean board row unless the board was touched', () => {
    const lean = { board_id: BOARD, name: 'Board' } as Board;
    const prev = { ...EMPTY_MAPS, boardById: new Map([[BOARD, lean]]) };
    expect(
      applyPartitionSnapshot(prev, snapshotOf({ board: fullBoard() }), never).boardById.get(BOARD)
        ?.objects
    ).toBeDefined();
    expect(
      applyPartitionSnapshot(
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
    const next = applyPartitionSnapshot(
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
  cards?: CardWithType[];
  board?: Board;
}) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const queries = new Map<string, unknown>();
  const respond = async <T>(name: string, value: T) => {
    calls.push(name);
    await gate;
    return value;
  };
  const byService: Record<string, unknown> = {
    branches: data.branches ?? [],
    sessions: data.sessions ?? [],
    'board-objects': data.boardObjects ?? [],
    cards: data.cards ?? [],
  };
  const client = {
    service: (name: string) => ({
      findAll: vi.fn((args?: { query?: unknown }) => {
        queries.set(name, args?.query);
        return respond(name, byService[name]);
      }),
      get: vi.fn(() => respond(`${name}:get`, data.board ?? fullBoard())),
    }),
  } as unknown as AgorClient;
  return { client, release: () => release(), calls, queries };
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
    expect(selectBoardPartition(agorStore.getState(), BOARD)?.status).toBe('loading');
    expect(ready()).toBe(false);
    release();
    await load;
    expect(ready()).toBe(true);
    expect(agorStore.getState().sessionById.has('s-1')).toBe(true);
  });

  it('offers a resync only the loads that started after its mark, in flight or loaded', async () => {
    const lifetime = captureLoadLifetime()!;
    const { client, release } = makePartitionClient({});
    // Started before the resync's mark: never reused.
    const before = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    const mark = partitionLoadMark();
    expect(partitionLoadSince(BOARD, lifetime, mark)).toBe(undefined);
    release();
    await before;
    expect(partitionLoadSince(BOARD, lifetime, mark)).toBe(undefined);

    // Started after it: the in-flight promise, then reused once loaded.
    agorStore.getState().resetBoardPartitions();
    const second = makePartitionClient({});
    const after = loadBoardPartition(second.client, BOARD, { canUseMemberWorkspaceServices: true });
    expect(partitionLoadSince(BOARD, lifetime, mark)).toBe(after);
    second.release();
    await after;
    await expect(partitionLoadSince(BOARD, lifetime, mark)).resolves.toBe(undefined);
    // Another lifetime never matches.
    expect(
      partitionLoadSince(BOARD, { ...lifetime, loadEpoch: lifetime.loadEpoch + 1 }, mark)
    ).toBe(undefined);
    // A resync keeps the boards loaded since its mark across its reset, and
    // only those: board-2's load started before the mark.
    agorStore.getState().setCoverage(boardScopeKey('board-2'), {
      ...boardCoverage('loaded', lifetime),
      generation: mark,
    });
    expect(partitionsLoadedSince(lifetime, mark)).toEqual([BOARD]);
    expect(partitionsLoadedSince({ ...lifetime, loadEpoch: lifetime.loadEpoch + 1 }, mark)).toEqual(
      []
    );
    agorStore.getState().resetBoardPartitions(partitionsLoadedSince(lifetime, mark));
    expect(selectBoardPartition(agorStore.getState(), BOARD)?.status).toBe('loaded');
    expect(agorStore.getState().coverage.has(boardScopeKey('board-2'))).toBe(false);
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

  it("reads the board's sessions as lean rows", async () => {
    const { client, release, queries } = makePartitionClient({});
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    release();
    await load;
    expect(queries.get('sessions')).toMatchObject({ board_id: BOARD, archived: false, lean: true });
  });

  it('never reads comments: they are global and gated at first paint', async () => {
    const { client, release, calls } = makePartitionClient({});
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    release();
    await load;
    expect(calls).not.toContain('board-comments');
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
    // The stale load never settles its entry under the new authority; it
    // releases it, so the board loads again instead of staying 'loading'.
    expect(agorStore.getState().coverage.has(boardScopeKey(BOARD))).toBe(false);
  });

  it('drops the apply when the load is cancelled, even under the same authority', async () => {
    const { client, release } = makePartitionClient({ sessions: [session('s-1', 'br-1')] });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    cancelAllHydrations(); // unmount + remount of the data owner
    release();
    await load;
    expect(agorStore.getState().sessionById.size).toBe(0);
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
    // The cascade wrote no session or board-object ids: they leave the membership anyway.
    const members = selectBoardPartition(state, BOARD)?.members;
    expect([...(members?.sessions ?? [])]).toEqual([]);
    expect([...(members?.boardObjects ?? [])]).toEqual([]);
  });

  it("a branch moved off the board during its read takes its sessions out of the board's membership", async () => {
    const { client, release } = makePartitionClient({
      branches: [branch('br-1')],
      sessions: [session('s-1', 'br-1')],
    });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    branchPatched(branch('br-1', { board_id: 'board-2' }));
    release();
    await load;
    expect([
      ...(selectBoardPartition(agorStore.getState(), BOARD)?.members?.sessions ?? []),
    ]).toEqual([]);
    // So a complete replace of the board it moved to, which omits s-1, removes it.
    const others = otherCommittedMembers(agorStore.getState(), boardScopeKey('board-2'));
    agorStore
      .getState()
      .applyMaps((prev) =>
        replaceScope(prev, boardPartitionScope('board-2'), { sessions: [] }, never, others)
      );
    expect(agorStore.getState().sessionById.has('s-1')).toBe(false);
  });

  it("a branch moved onto the board during its read brings its present sessions into the board's membership", async () => {
    agorStore.getState().applyMaps((prev) =>
      applyPartitionSnapshot(
        prev,
        snapshotOf({
          boardId: 'board-2',
          branches: [branch('br-2', { board_id: 'board-2' })],
          sessions: [session('s-2', 'br-2', { branch_board_id: 'board-2' })],
        }),
        never
      )
    );
    const { client, release } = makePartitionClient({});
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    branchPatched(branch('br-2'));
    release();
    await load;
    const members = selectBoardPartition(agorStore.getState(), BOARD)?.members;
    expect([...(members?.branches ?? [])]).toEqual(['br-2']);
    expect([...(members?.sessions ?? [])]).toEqual(['s-2']);
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

  it('releases its loading entry when cancelled, so the board counts as unloaded', async () => {
    const { client, release } = makePartitionClient({ sessions: [session('s-1', 'br-1')] });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    const entry = selectBoardPartition(agorStore.getState(), BOARD);
    expect(entry?.status).toBe('loading');
    cancelAllHydrations();
    // Another lifetime's entry is not current even before the load settles.
    expect(isLoadLifetimeCurrent(entry!)).toBe(false);
    release();
    await load;
    expect(agorStore.getState().coverage.has(boardScopeKey(BOARD))).toBe(false);
    // A new load under the new lifetime starts instead of deduping into the old one.
    const again = makePartitionClient({ sessions: [session('s-2', 'br-1')] });
    const reload = loadBoardPartition(again.client, BOARD, { canUseMemberWorkspaceServices: true });
    again.release();
    await reload;
    expect(ready()).toBe(true);
    expect(agorStore.getState().sessionById.has('s-2')).toBe(true);
  });

  it("never records loaded into the next user's store when its apply's subscriber logs out", async () => {
    const { client, release } = makePartitionClient({ sessions: [session('s-1', 'br-1')] });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    // `applyMaps` notifies synchronously: switch identity from inside it.
    const unsubscribe = agorStore.subscribe((state) => {
      if (!state.sessionById.has('s-1')) return;
      unsubscribe();
      cancelAllHydrations();
      agorStore.getState().reset();
      setRealtimeAuthorityScope('user-b:member:1');
    });
    release();
    await load;
    expect(agorStore.getState().coverage.has(boardScopeKey(BOARD))).toBe(false);
    expect(ready()).toBe(false);
  });

  it('never overwrites the entry of a load that superseded it during its apply', async () => {
    const first = makePartitionClient({ sessions: [session('s-1', 'br-1')] });
    const second = makePartitionClient({ sessions: [session('s-2', 'br-1')] });
    const load = loadBoardPartition(first.client, BOARD, { canUseMemberWorkspaceServices: true });
    let reload: Promise<void> | undefined;
    const unsubscribe = agorStore.subscribe((state) => {
      if (!state.sessionById.has('s-1')) return;
      unsubscribe();
      cancelAllHydrations(); // remount: a new lifetime loads the board again
      reload = loadBoardPartition(second.client, BOARD, { canUseMemberWorkspaceServices: true });
    });
    first.release();
    await load;
    const entry = selectBoardPartition(agorStore.getState(), BOARD);
    expect(entry?.status).toBe('loading');
    expect(isLoadLifetimeCurrent(entry!)).toBe(true);
    second.release();
    await reload;
    expect(agorStore.getState().sessionById.has('s-2')).toBe(true);
    expect(ready()).toBe(true);
    expect(isLoadLifetimeCurrent(selectBoardPartition(agorStore.getState(), BOARD)!)).toBe(true);
  });

  it('never applies after the restart budget: records a retryable error instead', async () => {
    let calls = 0;
    const client = {
      service: (name: string) => ({
        findAll: vi.fn(async () => {
          if (name === 'sessions') {
            calls += 1;
            // Every attempt spans a wholesale replacement.
            bumpFirstPaintMergeRevisions();
            return [session(`s-stale-${calls}`, 'br-1')];
          }
          return [];
        }),
        get: vi.fn(async () => fullBoard()),
      }),
    } as unknown as AgorClient;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    expect(calls).toBe(4);
    expect(agorStore.getState().sessionById.size).toBe(0);
    expect(selectBoardPartition(agorStore.getState(), BOARD)?.status).toBe('error');
    retryBoardPartition(BOARD);
    expect(agorStore.getState().coverage.has(boardScopeKey(BOARD))).toBe(false);
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
    expect(selectBoardPartition(agorStore.getState(), BOARD)?.status).toBe('error');
    retryBoardPartition(BOARD);
    expect(agorStore.getState().coverage.has(boardScopeKey(BOARD))).toBe(false);
  });

  it('reloading a board reconciles its annotations: deleted, moved and hidden rows leave', async () => {
    // Rows left from before a reconnect unloaded the board.
    agorStore.getState().applyMaps((prev) =>
      applyPartitionSnapshot(
        prev,
        snapshotOf({
          boardObjects: [boardObject('o-kept', 'br-1'), boardObject('o-hidden', 'br-private')],
          cards: [card('k-deleted'), card('k-moved'), card('k-kept')],
        }),
        never
      )
    );
    const { client, release } = makePartitionClient({
      boardObjects: [boardObject('o-kept', 'br-1')],
      cards: [card('k-kept')],
    });
    const load = loadBoardPartition(client, BOARD, { canUseMemberWorkspaceServices: true });
    // A card created live during the load stays although the snapshot lacks it.
    cardCreated(card('k-live'));
    release();
    await load;
    const state = agorStore.getState();
    expect([...state.boardObjectById.keys()]).toEqual(['o-kept']);
    expect([...state.cardById.keys()].sort()).toEqual(['k-kept', 'k-live']);
    expect(ready()).toBe(true);
    // Its membership: the ids the read returned, and the row realtime wrote
    // during the read that the board claims now; not the rows deleted meanwhile.
    const members = selectBoardPartition(state, BOARD)?.members;
    expect([...(members?.cards ?? [])].sort()).toEqual(['k-kept', 'k-live']);
    expect([...(members?.boardObjects ?? [])]).toEqual(['o-kept']);
  });

  it('only committed members of other current, loaded scopes (and the global sets) keep rows', () => {
    const lifetime = captureLoadLifetime()!;
    const entry = (status: 'loading' | 'loaded' | 'error', id: string) => ({
      status,
      ...lifetime,
      generation: 0,
      members: { sessions: new Set([id]) },
    });
    const { setCoverage } = agorStore.getState();
    setCoverage(boardScopeKey('board-2'), entry('loaded', 's-2'));
    setCoverage(boardScopeKey(BOARD), entry('loaded', 's-1'));
    setCoverage(boardScopeKey('board-3'), entry('loading', 's-3'));
    setCoverage(boardScopeKey('board-4'), entry('error', 's-4'));
    setCoverage(USER_SCOPE_KEYS.sessions, entry('loaded', 's-mine'));
    // Committed under an earlier authority: stale.
    setCoverage(USER_SCOPE_KEYS.teammates, {
      ...entry('loaded', 's-stale'),
      authorityScope: 'user-a:member:0',
    });
    const holds = (id: string, collection: 'sessions' | 'branches' = 'sessions') =>
      otherCommittedMembers(agorStore.getState(), boardScopeKey(BOARD)).some((members) =>
        members[collection]?.has(id)
      );
    expect(['s-1', 's-2', 's-3', 's-4', 's-mine', 's-stale'].filter((id) => holds(id))).toEqual([
      's-2',
      's-mine',
    ]);
    agorStore.getState().markGloballyHydrated(['sessions']);
    expect(holds('s-any')).toBe(true);
    expect(holds('br-any', 'branches')).toBe(false);
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
    markBoardLoaded(BOARD);
    expect(makeBoardReadySelector(BOARD)(agorStore.getState())).toBe(true);
    expect(makeBoardReadySelector('board-2')(agorStore.getState())).toBe(false);
  });

  it('is not ready from an incomplete read', () => {
    agorStore.getState().setCoverage(boardScopeKey(BOARD), { ...boardCoverage(), complete: false });
    expect(makeBoardReadySelector(BOARD)(agorStore.getState())).toBe(false);
  });

  it('never treats a board as ready from global snapshots: only its partition', async () => {
    for (const c of ['sessions', 'branches'] as const) {
      await runHydration(
        c,
        [c],
        async () => [],
        () => {}
      );
    }
    expect(agorStore.getState().globallyHydrated.size).toBe(2);
    expect(makeBoardReadySelector('board-2')(agorStore.getState())).toBe(false);
    markBoardLoaded('board-2');
    expect(makeBoardReadySelector('board-2')(agorStore.getState())).toBe(true);
  });

  it('resets with the maps on an identity change', () => {
    markBoardLoaded(BOARD);
    agorStore.getState().resetMaps();
    expect(makeBoardReadySelector(BOARD)(agorStore.getState())).toBe(false);
  });
});
