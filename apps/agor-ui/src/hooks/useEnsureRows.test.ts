import type { AgorClient, Branch } from '@agor-live/client';
import { PAGINATION } from '@agor-live/client';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelAllHydrations, resetHydrationRevisions } from '../store/agorHydration';
import { agorStore } from '../store/agorStore';
import { discardRealtimeNow, setRealtimeAuthorityScope } from '../store/realtimeBatch';
import { pinnedMembers } from '../store/rowPins';
import { MAX_REFERENCE_READ_ATTEMPTS } from '../store/userScope';
import { useEnsureBranches } from './useEnsureRows';

const AUTHORITY = 'me:member:1';
const branch = (id: string) =>
  ({ branch_id: id, board_id: 'board-1', name: `name-${id}`, archived: false }) as Branch;

function makeClient(known: Branch[]) {
  const find = vi.fn(async ({ query }: { query: { branch_id: { $in: string[] } } }) =>
    known.filter((b) => query.branch_id.$in.includes(b.branch_id))
  );
  return { client: { service: () => ({ find }) } as unknown as AgorClient, find };
}

beforeEach(() => {
  discardRealtimeNow();
  setRealtimeAuthorityScope(AUTHORITY);
  agorStore.getState().setDataAuthority(AUTHORITY);
  agorStore.getState().setLoading(false);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
  resetHydrationRevisions();
});

describe('useEnsureBranches', () => {
  it('reads the branches the store lacks by id, in chunks, and fills them with no scope', async () => {
    const ids = Array.from({ length: PAGINATION.MAX_ID_LIST + 1 }, (_, i) => `b-${i}`);
    const { client, find } = makeClient([branch('b-0'), branch(`b-${PAGINATION.MAX_ID_LIST}`)]);
    renderHook(() => useEnsureBranches(client, ids));
    await waitFor(() => expect(agorStore.getState().branchById.has('b-0')).toBe(true));
    await waitFor(() =>
      expect(agorStore.getState().branchById.has(`b-${PAGINATION.MAX_ID_LIST}`)).toBe(true)
    );
    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[0][0].query).toMatchObject({ archived: false });
    expect(agorStore.getState().coverage.size).toBe(0);
  });

  it('reads an id once, even when absent and asked for again', async () => {
    const { client, find } = makeClient([]);
    const { rerender } = renderHook(({ ids }) => useEnsureBranches(client, ids), {
      initialProps: { ids: ['gone'] },
    });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    rerender({ ids: ['gone', 'new'] });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    expect(find.mock.calls[1][0].query.branch_id.$in).toEqual(['new']);
  });

  it('waits out a burst of id changes with a debounce', async () => {
    vi.useFakeTimers();
    const { client, find } = makeClient([]);
    const { rerender } = renderHook(({ ids }) => useEnsureBranches(client, ids, 500), {
      initialProps: { ids: ['a'] },
    });
    rerender({ ids: ['a', 'b'] });
    rerender({ ids: ['a', 'b', 'c'] });
    expect(find).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0].query.branch_id.$in).toEqual(['a', 'b', 'c']);
  });

  it('retries a failed read with backoff, a bounded number of times', async () => {
    vi.useFakeTimers();
    const { client, find } = makeClient([branch('b-1')]);
    const real = find.getMockImplementation();
    find.mockRejectedValueOnce(new Error('offline'));
    renderHook(() => useEnsureBranches(client, ['b-1']));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(find).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(find).toHaveBeenCalledTimes(2);
    expect(agorStore.getState().branchById.has('b-1')).toBe(true);

    find.mockImplementation(async () => {
      throw new Error('down');
    });
    renderHook(() => useEnsureBranches(client, ['b-2']));
    for (let i = 0; i < 2 * MAX_REFERENCE_READ_ATTEMPTS; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
    }
    expect(
      find.mock.calls.filter(([{ query }]) => query.branch_id.$in.includes('b-2'))
    ).toHaveLength(MAX_REFERENCE_READ_ATTEMPTS);
    find.mockImplementation(real as never);
  });

  it('reads a row again once the store evicts it', async () => {
    const { client, find } = makeClient([branch('b-1')]);
    renderHook(() => useEnsureBranches(client, ['b-1']));
    await waitFor(() => expect(agorStore.getState().branchById.has('b-1')).toBe(true));
    act(() => agorStore.setState({ branchById: new Map() }));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(agorStore.getState().branchById.has('b-1')).toBe(true));
  });

  it('reads an id again when its read was cancelled, never recording it absent', async () => {
    const { client, find } = makeClient([branch('b-1'), branch('b-2')]);
    let resolveFirst: (rows: Branch[]) => void = () => {};
    find.mockImplementationOnce(
      () =>
        new Promise<Branch[]>((resolve) => {
          resolveFirst = resolve;
        })
    );
    const { rerender } = renderHook(({ ids }) => useEnsureBranches(client, ids), {
      initialProps: { ids: ['b-1'] },
    });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
    // Hydration is cancelled under the same authority (a store remount).
    act(() => cancelAllHydrations());
    await act(async () => resolveFirst([branch('b-1')]));
    rerender({ ids: ['b-1', 'b-2'] });
    await waitFor(() => expect(agorStore.getState().branchById.has('b-2')).toBe(true));
    await waitFor(() => expect(agorStore.getState().branchById.has('b-1')).toBe(true));
    expect(
      find.mock.calls.slice(1).some(([{ query }]) => query.branch_id.$in.includes('b-1'))
    ).toBe(true);
  });
});

describe('useEnsureBranches retention', () => {
  it('pins the rows it reads while mounted; unmounting evicts the ones nothing holds', async () => {
    const { client } = makeClient([branch('b-1')]);
    const { unmount } = renderHook(() => useEnsureBranches(client, ['b-1']));
    await waitFor(() => expect(agorStore.getState().branchById.has('b-1')).toBe(true));
    expect(pinnedMembers.branches?.has('b-1')).toBe(true);
    unmount();
    expect(pinnedMembers.branches?.has('b-1')).toBe(false);
    expect(agorStore.getState().branchById.has('b-1')).toBe(false);
  });
});
