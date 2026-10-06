/**
 * The event stream labels the sessions and branches its events name with the
 * store's session and branch maps empty (Step 3): it reads them by id,
 * debounced, each once.
 */
import type { AgorClient, Branch, Session } from '@agor-live/client';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import type { SocketEvent } from '../../hooks/useEventStream';
import { resetHydrationRevisions } from '../../store/agorHydration';
import { agorStore } from '../../store/agorStore';
import { discardRealtimeNow, setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { EventStreamPanel } from './EventStreamPanel';

const AUTHORITY = 'user-1:member:1';
const session = { session_id: 's1', branch_id: 'b2', archived: false } as Session;
const branch = (id: string) => ({ branch_id: id, name: id, archived: false }) as Branch;
const event = (id: string, data: unknown): SocketEvent => ({
  id,
  timestamp: new Date(0),
  type: 'crud',
  eventName: 'sessions patched',
  data,
});

beforeEach(() => {
  discardRealtimeNow();
  setRealtimeAuthorityScope(AUTHORITY);
  agorStore.getState().setDataAuthority(AUTHORITY);
  agorStore.getState().setLoading(false);
});
afterEach(() => {
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
  resetHydrationRevisions();
});

it('reads the sessions and branches its events name, debounced and once', async () => {
  const sessionsFind = vi.fn(async () => [session]);
  const branchesFind = vi.fn(async ({ query }: { query: { branch_id: { $in: string[] } } }) =>
    query.branch_id.$in.map(branch)
  );
  const client = {
    service: (name: string) => ({ find: name === 'sessions' ? sessionsFind : branchesFind }),
  } as unknown as AgorClient;
  const panel = (events: SocketEvent[]) => (
    <AppActionsProvider value={{} as never}>
      <EventStreamPanel collapsed={false} events={events} onClear={vi.fn()} client={client} />
    </AppActionsProvider>
  );
  const first = [event('e1', { session_id: 's1' }), event('e2', { branch_id: 'b1' })];
  const { rerender } = render(panel(first));
  rerender(panel([event('e3', { session_id: 's1' }), ...first]));
  await waitFor(() => expect(agorStore.getState().sessionById.has('s1')).toBe(true), {
    timeout: 3000,
  });
  await waitFor(() => expect(agorStore.getState().branchById.has('b2')).toBe(true), {
    timeout: 3000,
  });
  expect(sessionsFind).toHaveBeenCalledTimes(1);
  expect(agorStore.getState().branchById.has('b1')).toBe(true);
});
