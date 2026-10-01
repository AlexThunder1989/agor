import type { AgorClient, BoardComment, Branch, Session } from '@agor-live/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelAllHydrations, resetHydrationRevisions } from './agorHydration';
import { sessionCreated } from './agorRealtimeActions';
import { agorStore } from './agorStore';
import { captureLoadLifetime } from './loadLifetime';
import { discardRealtimeNow, setRealtimeAuthorityScope } from './realtimeBatch';
import {
  MY_SESSIONS_FULL_LIMIT,
  referencedBranchIds,
  startUserScope,
  stopUserScope,
} from './userScope';

const AUTHORITY = 'me:member:1';
const ME = 'user-me';
/** The current load lifetime (what `useAgorData` passes for its load). */
const lifetime = () => {
  const current = captureLoadLifetime();
  if (!current) throw new Error('no authority');
  return current;
};

const session = (id: string, branchId: string, overrides: Partial<Session> = {}) =>
  ({
    session_id: id,
    branch_id: branchId,
    created_by: ME,
    status: 'idle',
    archived: false,
    genealogy: { children: [] },
    last_updated: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as unknown as Session;
const branch = (id: string, overrides: Partial<Branch> = {}) =>
  ({ branch_id: id, board_id: 'board-1', name: id, archived: false, ...overrides }) as Branch;
const comment = (id: string, overrides: Partial<BoardComment>) =>
  ({
    comment_id: id,
    board_id: 'board-1',
    content: id,
    resolved: false,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as BoardComment;

type Call = { service: string; method: 'find' | 'findAll'; query: Record<string, unknown> };

/** Mock client answering by service + query shape; records every call. */
function makeClient(handlers: {
  mine?: (limit: number) => Session[] | Promise<Session[]>;
  myBranches?: () => Branch[] | Promise<Branch[]>;
  teammates?: () => Branch[] | Promise<Branch[]>;
  byIds?: (ids: string[]) => Branch[] | Promise<Branch[]>;
}) {
  const calls: Call[] = [];
  const respond = async (
    service: string,
    method: Call['method'],
    args: { query: Record<string, unknown> }
  ) => {
    const query = args.query;
    calls.push({ service, method, query });
    if (service === 'sessions') return (await handlers.mine?.(query.$limit as number)) ?? [];
    if (query.teammate) return { data: (await handlers.teammates?.()) ?? [] };
    if (query.created_by) return (await handlers.myBranches?.()) ?? [];
    const ids = (query.branch_id as { $in: string[] }).$in;
    return { data: (await handlers.byIds?.(ids)) ?? [] };
  };
  const client = {
    service: (name: string) => ({
      find: vi.fn((args) => respond(name, 'find', args)),
      findAll: vi.fn((args) => respond(name, 'findAll', args)),
    }),
  } as unknown as AgorClient;
  return { client, calls };
}

const flags = () => {
  const s = agorStore.getState();
  return {
    mySessionsLoaded: s.mySessionsLoaded,
    mySessionsTruncated: s.mySessionsTruncated,
    teammatesLoaded: s.teammatesLoaded,
    homeBranchesLoaded: s.homeBranchesLoaded,
  };
};

beforeEach(() => {
  agorStore.getState().reset();
  resetHydrationRevisions();
  discardRealtimeNow();
  setRealtimeAuthorityScope(AUTHORITY);
});
afterEach(() => {
  stopUserScope();
  vi.useRealTimers();
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
  resetHydrationRevisions();
});

describe('user scope', () => {
  it('skips the full read when the gated page already held all of my sessions', async () => {
    const { client, calls } = makeClient({});
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: true });
    expect(calls.filter((c) => c.service === 'sessions')).toEqual([]);
    expect(flags()).toEqual({
      mySessionsLoaded: true,
      mySessionsTruncated: false,
      teammatesLoaded: true,
      homeBranchesLoaded: true,
    });
  });

  it('reads all of my sessions in one capped read and flags truncation', async () => {
    const rows = Array.from({ length: MY_SESSIONS_FULL_LIMIT }, (_, i) =>
      session(`s-${i}`, 'br-1')
    );
    const { client, calls } = makeClient({
      mine: () => rows,
      byIds: () => [branch('br-1')],
    });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: false });
    const reads = calls.filter((c) => c.service === 'sessions');
    expect(reads).toHaveLength(1);
    expect(reads[0].query).toEqual({
      created_by: ME,
      archived: false,
      $sort: { updated_at: -1 },
      $limit: MY_SESSIONS_FULL_LIMIT,
      $count: false,
      lean: true,
    });
    expect(agorStore.getState().sessionById.size).toBe(MY_SESSIONS_FULL_LIMIT);
    expect(flags().mySessionsTruncated).toBe(true);
  });

  it('keeps live rows through a large (batched) fill of my sessions', async () => {
    const live = session('s-0', 'br-0', { title: 'live' });
    agorStore.getState().applyMaps((prev) => ({
      ...prev,
      sessionById: new Map([[live.session_id, live]]),
      sessionsByBranch: new Map([['br-0', [live]]]),
    }));
    const rows = Array.from({ length: 500 }, (_, i) =>
      session(`s-${i}`, `br-${i % 3}`, { title: 'snapshot' })
    );
    const { client } = makeClient({
      mine: () => rows,
      byIds: (ids) => ids.map((id) => branch(id)),
    });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: false });
    const state = agorStore.getState();
    expect(state.sessionById.get('s-0')).toBe(live);
    expect(state.sessionById.size).toBe(500);
    expect(state.sessionsByBranch.get('br-0')?.[0]).toBe(live);
    expect([...state.sessionsByBranch.values()].reduce((n, bucket) => n + bucket.length, 0)).toBe(
      500
    );
  });

  it('loads teammates, never overwriting a live (full) row', async () => {
    const live = branch('mate', { name: 'live', notes: 'full' } as Partial<Branch>);
    agorStore.getState().setMap('branchById', new Map([[live.branch_id, live]]));
    const { client } = makeClient({
      teammates: () => [branch('mate', { name: 'stale' }), branch('mate-2')],
    });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: true });
    expect(agorStore.getState().branchById.get('mate')).toBe(live);
    expect(agorStore.getState().branchById.has('mate-2')).toBe(true);
    expect(flags().teammatesLoaded).toBe(true);
  });

  it('ensures referenced branches in chunks of 200 and records the absent ones', async () => {
    const mine = Array.from({ length: 250 }, (_, i) => session(`s-${i}`, `br-${i}`));
    const { client, calls } = makeClient({
      mine: () => mine,
      // The server returns all but br-7 (archived, deleted or invisible).
      byIds: (ids) => ids.filter((id) => id !== 'br-7').map((id) => branch(id)),
    });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: false });
    const idReads = calls.filter((c) => c.query.branch_id);
    expect(idReads.map((c) => (c.query.branch_id as { $in: string[] }).$in.length)).toEqual([
      200, 50,
    ]);
    expect(idReads[0].query).toMatchObject({ archived: false });
    expect([...agorStore.getState().absentBranchIds]).toEqual(['br-7']);
    expect(flags().homeBranchesLoaded).toBe(true);
  });

  it('resolves references from a complete gated page without waiting for my branches', async () => {
    agorStore.getState().applyMaps((prev) => ({
      ...prev,
      sessionById: new Map([['s-1', session('s-1', 'br-ref')]]),
    }));
    let releaseMine!: () => void;
    const mineGate = new Promise<void>((resolve) => {
      releaseMine = resolve;
    });
    const { client, calls } = makeClient({
      myBranches: async () => {
        await mineGate;
        return [];
      },
      byIds: (ids) => ids.map((id) => branch(id)),
    });
    const run = startUserScope(client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: true,
    });
    await vi.waitFor(() => expect(agorStore.getState().branchById.has('br-ref')).toBe(true));
    expect(calls.some((c) => c.query.branch_id)).toBe(true);
    expect(flags().homeBranchesLoaded).toBe(false);
    releaseMine();
    await run;
    expect(flags().homeBranchesLoaded).toBe(true);
  });

  it('references the branches of candidate comment threads only', () => {
    agorStore.setState({
      commentById: new Map(
        [
          // Someone else spoke last → candidate.
          comment('root-a', { branch_id: 'br-a', created_by: 'bob' }),
          // I spoke last → not a candidate.
          comment('root-b', { branch_id: 'br-b', created_by: 'bob' }),
          comment('reply-b', {
            branch_id: 'br-b',
            parent_comment_id: 'root-b',
            created_by: ME,
            created_at: '2026-01-02T00:00:00.000Z',
          }),
          // Resolved → not a candidate.
          comment('root-c', { branch_id: 'br-c', created_by: 'bob', resolved: true }),
        ].map((c) => [c.comment_id, c])
      ),
    });
    expect([...referencedBranchIds(agorStore.getState(), ME)]).toEqual(['br-a']);
  });

  it('ensures new references once, batched, and clears an absent mark when the branch arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, calls } = makeClient({ byIds: (ids) => ids.map((id) => branch(id)) });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: true });
    expect(flags().homeBranchesLoaded).toBe(true);

    sessionCreated(session('new-1', 'br-new'));
    sessionCreated(session('new-2', 'br-new'));
    sessionCreated(session('new-3', 'br-other'));
    await vi.advanceTimersByTimeAsync(150);
    const idReads = calls.filter((c) => c.query.branch_id);
    expect(idReads).toHaveLength(1);
    expect((idReads[0].query.branch_id as { $in: string[] }).$in.sort()).toEqual([
      'br-new',
      'br-other',
    ]);

    agorStore.getState().setUserScope({ absentBranchIds: new Set(['br-late']) });
    agorStore
      .getState()
      .setMap('branchById', (prev) => new Map(prev).set('br-late', branch('br-late')));
    await vi.advanceTimersByTimeAsync(150);
    expect(agorStore.getState().absentBranchIds.size).toBe(0);
  });

  it('leaves flags unset when my sessions cannot be read (older daemon)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = makeClient({
      mine: () => Promise.reject(new Error('400 created_by unsupported')),
    });
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: false });
    expect(flags()).toEqual({
      mySessionsLoaded: false,
      mySessionsTruncated: false,
      teammatesLoaded: true,
      homeBranchesLoaded: false,
    });
  });

  it('drops a run whose authority changed, and resets with the maps', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client } = makeClient({
      mine: async () => {
        await gate;
        return [session('s-1', 'br-1')];
      },
    });
    const run = startUserScope(client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
    });
    setRealtimeAuthorityScope('someone-else:member:1');
    release();
    await run;
    expect(agorStore.getState().sessionById.size).toBe(0);
    expect(flags().mySessionsLoaded).toBe(false);

    setRealtimeAuthorityScope(AUTHORITY);
    agorStore.getState().setUserScope({ mySessionsLoaded: true, teammatesLoaded: true });
    agorStore.getState().resetMaps();
    expect(flags()).toEqual({
      mySessionsLoaded: false,
      mySessionsTruncated: false,
      teammatesLoaded: false,
      homeBranchesLoaded: false,
    });
  });

  it('rejects a lifetime that was cancelled before the run started', async () => {
    const { client, calls } = makeClient({});
    const stale = lifetime();
    cancelAllHydrations(); // an unmount/remount, same authority
    await startUserScope(client, { userId: ME, lifetime: stale, gatedMineComplete: true });
    expect(calls).toEqual([]);
    expect(flags().mySessionsLoaded).toBe(false);
  });

  it('drops a run cancelled mid-read even when the authority is the same again', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client } = makeClient({
      mine: async () => {
        await gate;
        return [session('s-1', 'br-1')];
      },
      teammates: async () => {
        await gate;
        return [branch('mate')];
      },
    });
    const run = startUserScope(client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
    });
    cancelAllHydrations();
    release();
    await run;
    expect(agorStore.getState().sessionById.size).toBe(0);
    expect(agorStore.getState().branchById.size).toBe(0);
    expect(flags()).toEqual({
      mySessionsLoaded: false,
      mySessionsTruncated: false,
      teammatesLoaded: false,
      homeBranchesLoaded: false,
    });
  });

  it('keeps flags true while a silent-resync re-run is in flight', async () => {
    const { client } = makeClient({});
    await startUserScope(client, { userId: ME, lifetime: lifetime(), gatedMineComplete: true });
    expect(flags().homeBranchesLoaded).toBe(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = makeClient({
      mine: async () => {
        await gate;
        return [];
      },
    });
    const rerun = startUserScope(slow.client, {
      userId: ME,
      lifetime: lifetime(),
      gatedMineComplete: false,
    });
    expect(flags()).toMatchObject({ mySessionsLoaded: true, homeBranchesLoaded: true });
    release();
    await rerun;
    expect(flags()).toMatchObject({ mySessionsLoaded: true, homeBranchesLoaded: true });
  });
});
