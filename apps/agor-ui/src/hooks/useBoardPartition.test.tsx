import type { AgorClient } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelAllHydrations, resetHydrationRevisions } from '../store/agorHydration';
import { agorStore } from '../store/agorStore';
import { loadBoardPartition } from '../store/boardPartitions';
import { discardRealtimeNow, setRealtimeAuthorityScope } from '../store/realtimeBatch';
import { useBoardPartition } from './useBoardPartition';

const AUTHORITY = 'user-a:member:1';
const BOARD = 'board-1';

/** A client whose partition reads wait for `release`; counts session reads. */
function makeClient() {
  const gates: Array<() => void> = [];
  let sessionReads = 0;
  const wait = () => new Promise<void>((resolve) => gates.push(resolve));
  const client = {
    io: { on: vi.fn(), off: vi.fn() },
    service: (name: string) => ({
      findAll: vi.fn(async () => {
        if (name === 'sessions') sessionReads += 1;
        await wait();
        return [];
      }),
      get: vi.fn(async () => {
        await wait();
        return { board_id: BOARD, name: 'Board', objects: {} };
      }),
    }),
  } as unknown as AgorClient;
  return {
    client,
    sessionReads: () => sessionReads,
    releaseAll: () => {
      for (const release of gates.splice(0)) release();
    },
  };
}

beforeEach(() => {
  agorStore.getState().reset();
  resetHydrationRevisions();
  discardRealtimeNow();
  setRealtimeAuthorityScope(AUTHORITY);
  agorStore.getState().setLoading(false);
  agorStore
    .getState()
    .setMap('boardById', new Map([[BOARD, { board_id: BOARD, name: 'Board' } as never]]));
});
afterEach(() => {
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
  resetHydrationRevisions();
});

describe('useBoardPartition', () => {
  it('reloads a board whose loading entry belongs to a cancelled lifetime', async () => {
    const stale = makeClient();
    // A load from the previous lifetime that never settles in this one.
    void loadBoardPartition(stale.client, BOARD, { canUseMemberWorkspaceServices: true });
    cancelAllHydrations();
    expect(agorStore.getState().boardPartitions.get(BOARD)?.status).toBe('loading');

    const fresh = makeClient();
    const { result } = renderHook(() =>
      useBoardPartition(fresh.client, BOARD, { canUseMemberWorkspaceServices: true })
    );
    await waitFor(() => expect(fresh.sessionReads()).toBe(1));
    await act(async () => fresh.releaseAll());
    await waitFor(() => expect(result.current.boardReady).toBe(true));
    stale.releaseAll();
  });

  it('is ready without a board, and for a board that does not exist', () => {
    const { client } = makeClient();
    const none = renderHook(() =>
      useBoardPartition(client, null, { canUseMemberWorkspaceServices: true })
    );
    expect(none.result.current.boardReady).toBe(true);
    const unknown = renderHook(() =>
      useBoardPartition(client, 'does-not-exist', { canUseMemberWorkspaceServices: true })
    );
    expect(unknown.result.current.boardReady).toBe(true);
  });
});
