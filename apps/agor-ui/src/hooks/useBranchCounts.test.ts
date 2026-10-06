/**
 * Branch-count badges read the per-board `branch-counts` aggregate, so they
 * are right with the store's branch map empty (Step 3), and re-read it,
 * debounced, after branch events.
 */
import type { AgorClient } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agorStore } from '../store/agorStore';
import { setRealtimeAuthorityScope } from '../store/realtimeBatch';
import { BRANCH_COUNTS_DEBOUNCE_MS, useBranchCounts } from './useBranchCounts';

function makeClient() {
  const listeners = new Map<string, Set<() => void>>();
  let count = 2;
  const find = vi.fn(async () => [{ board_id: 'board-1', branch_count: count }]);
  const client = {
    service: (name: string) =>
      name === 'branch-counts'
        ? { find }
        : {
            on: (event: string, fn: () => void) => {
              if (!listeners.has(event)) listeners.set(event, new Set());
              listeners.get(event)?.add(fn);
            },
            off: (event: string, fn: () => void) => listeners.get(event)?.delete(fn),
          },
  } as unknown as AgorClient;
  const emit = (event: string) => {
    for (const fn of listeners.get(event) ?? []) fn();
  };
  return { client, find, emit, setCount: (n: number) => (count = n), listeners };
}

beforeEach(() => {
  agorStore.getState().reset();
  setRealtimeAuthorityScope('user-1:member:1');
});
afterEach(() => {
  vi.useRealTimers();
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
});

it('reads the per-board counts with the store empty', async () => {
  const { client } = makeClient();
  const { result } = renderHook(() => useBranchCounts(client));
  await waitFor(() => expect(result.current.get('board-1')).toBe(2));
});

it('re-reads once, debounced, after a burst of branch events', async () => {
  const { client, find, emit, setCount } = makeClient();
  const { result } = renderHook(() => useBranchCounts(client));
  await waitFor(() => expect(result.current.get('board-1')).toBe(2));
  vi.useFakeTimers();
  setCount(3);
  emit('created');
  emit('patched');
  emit('removed');
  expect(find).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(BRANCH_COUNTS_DEBOUNCE_MS);
  });
  expect(find).toHaveBeenCalledTimes(2);
  expect(result.current.get('board-1')).toBe(3);
});

it('reads nothing without a realtime authority, and unsubscribes on unmount', async () => {
  setRealtimeAuthorityScope(null);
  const { client, find, listeners } = makeClient();
  const { unmount } = renderHook(() => useBranchCounts(client));
  expect(find).not.toHaveBeenCalled();
  act(() => setRealtimeAuthorityScope('user-1:member:1'));
  await waitFor(() => expect(find).toHaveBeenCalledTimes(1));
  unmount();
  expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
});
