/**
 * A Settings branch page stays consistent with realtime events: a patch that
 * lands while a re-read is in flight survives the older reply, and an event
 * that can change the page's membership or total (an off-page archive or
 * removal, a rename while searching) reads the page again.
 */
import { EventEmitter } from 'node:events';
import type { AgorClient, Branch } from '@agor-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agorStore } from '@/store/agorStore';
import { setRealtimeAuthorityScope } from '@/store/realtimeBatch';
import { useBranchPage } from './useBranchPage';

const branch = (n: number, overrides: Partial<Branch> = {}) =>
  ({ branch_id: `branch-${n}`, name: `feature-${n}`, archived: false, ...overrides }) as Branch;

function makeClient(total = 25) {
  const events = new EventEmitter();
  const page = () => ({
    total,
    data: Array.from({ length: 10 }, (_, i) => branch(i + 1)),
  });
  const find = vi.fn(async () => page());
  const client = {
    service: () => ({
      find,
      on: (e: string, fn: (...a: unknown[]) => void) => events.on(e, fn),
      off: (e: string, fn: (...a: unknown[]) => void) => events.off(e, fn),
    }),
  } as unknown as AgorClient;
  const emit = (event: string, payload: unknown) => act(() => void events.emit(event, payload));
  return { client, find, emit, page, setTotal: (n: number) => (total = n) };
}

beforeEach(() => {
  agorStore.getState().reset();
  setRealtimeAuthorityScope('me:member:1');
});
afterEach(() => {
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
});

it('keeps a rename that lands while an older re-read is in flight', async () => {
  const { client, find, emit, page } = makeClient();
  const { result } = renderHook(() => useBranchPage(client, { archived: false }, 1, 10));
  await waitFor(() => expect(result.current.rows).toHaveLength(10));
  let resolveStale: (value: ReturnType<typeof page>) => void = () => {};
  find.mockImplementationOnce(() => new Promise((resolve) => (resolveStale = resolve)));
  emit('created', branch(99));
  await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
  emit('patched', branch(1, { name: 'renamed-1' }));
  // The reply was read before the rename.
  await act(async () => resolveStale(page()));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.rows[0].name).toBe('renamed-1');
});

it('reads the page again when a rename may move a row into or out of the search', async () => {
  const { client, find, emit } = makeClient();
  const { result } = renderHook(() => useBranchPage(client, { search: 'feature' }, 1, 10));
  await waitFor(() => expect(result.current.rows).toHaveLength(10));
  emit('patched', branch(1, { name: 'other' })); // on the page, out of the match
  await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
  emit('patched', branch(42, { name: 'feature-42' })); // off the page, into the match
  await waitFor(() => expect(find).toHaveBeenCalledTimes(3));
});

it('reads the total again when an off-page row is archived or removed', async () => {
  const { client, find, emit, setTotal } = makeClient(25);
  const { result } = renderHook(() => useBranchPage(client, { archived: false }, 1, 10));
  await waitFor(() => expect(result.current.total).toBe(25));
  setTotal(24);
  emit('patched', branch(20, { archived: true }));
  await waitFor(() => expect(result.current.total).toBe(24));
  setTotal(23);
  emit('removed', branch(21));
  await waitFor(() => expect(result.current.total).toBe(23));
  expect(find).toHaveBeenCalledTimes(3);
});

it('patches an on-page row in place without reading again', async () => {
  const { client, find, emit } = makeClient();
  const { result } = renderHook(() => useBranchPage(client, { archived: false }, 1, 10));
  await waitFor(() => expect(result.current.rows).toHaveLength(10));
  emit('patched', branch(2, { name: 'renamed-2' }));
  expect(result.current.rows[1].name).toBe('renamed-2');
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(find).toHaveBeenCalledTimes(1);
});
