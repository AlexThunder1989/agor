import type { AgorClient, Session } from '@agor-live/client';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { buildSessionMaps } from '../store/agorMaps';
import { agorStore } from '../store/agorStore';
import { useSessionDetails } from './useSessionDetails';

const V1 = '2026-06-24T00:00:00.000Z';
const V2 = '2026-06-25T00:00:00.000Z';
const full = (version = V1) =>
  ({
    session_id: 's-1',
    branch_id: 'b-1',
    archived: false,
    last_updated: version,
    custom_context: { slash_commands: ['review'], skills: ['pdf'] },
  }) as unknown as Session;
const lean = (version = V1) =>
  ({
    ...full(version),
    custom_context: {},
    custom_context_omitted: ['slash_commands', 'skills'],
  }) as unknown as Session;

function seedStore(session: Session) {
  agorStore.getState().applyMaps((prev) => ({ ...prev, ...buildSessionMaps([session]) }));
}

beforeEach(() => {
  agorStore.getState().reset();
});

it('fills a lean open session from a full get and refetches for a newer lean version', async () => {
  const get = vi.fn((_id: string) => Promise.resolve(full()));
  const client = { service: () => ({ get }) } as unknown as AgorClient;
  seedStore(lean());
  const { rerender } = renderHook(({ session }) => useSessionDetails(client, session), {
    initialProps: { session: agorStore.getState().sessionById.get('s-1') },
  });
  await waitFor(() =>
    expect(agorStore.getState().sessionById.get('s-1')?.custom_context).toEqual({
      slash_commands: ['review'],
      skills: ['pdf'],
    })
  );
  expect(get).toHaveBeenCalledTimes(1);

  // Full rows (realtime / restored) never trigger a fetch.
  rerender({ session: agorStore.getState().sessionById.get('s-1') });
  expect(get).toHaveBeenCalledTimes(1);

  // A newer lean row replaces it; that version is fetched.
  seedStore(lean(V2));
  get.mockImplementation(() => Promise.resolve(full(V2)));
  rerender({ session: agorStore.getState().sessionById.get('s-1') });
  await waitFor(() =>
    expect(agorStore.getState().sessionById.get('s-1')?.custom_context_omitted).toBeUndefined()
  );
  expect(get).toHaveBeenCalledTimes(2);
});

it('ignores a response for a session the panel has left', async () => {
  let release!: (value: Session) => void;
  const get = vi.fn(() => new Promise<Session>((resolve) => (release = resolve)));
  const client = { service: () => ({ get }) } as unknown as AgorClient;
  seedStore(lean());
  const { rerender } = renderHook(({ session }) => useSessionDetails(client, session), {
    initialProps: { session: lean() as Session | null },
  });
  rerender({ session: null });
  release(full());
  await Promise.resolve();
  expect(agorStore.getState().sessionById.get('s-1')?.custom_context_omitted).toEqual([
    'slash_commands',
    'skills',
  ]);
});
