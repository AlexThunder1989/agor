import type { Session } from '@agor-live/client';
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agorStore } from '../store/agorStore';
import { setRealtimeAuthorityScope } from '../store/realtimeBatch';
import { pinnedMembers } from '../store/rowPins';
import { usePinnedOpenRows, usePinnedRows } from './usePinnedRows';

const session = (id: string, branchId: string) =>
  ({
    session_id: id,
    branch_id: branchId,
    archived: false,
    genealogy: { children: [] },
  }) as unknown as Session;

beforeEach(() => {
  setRealtimeAuthorityScope('me:member:1');
  agorStore.getState().replaceMaps({
    sessionById: new Map(['s-a', 's-b', 's-c'].map((id) => [id, session(id, `br-${id}`)])),
  });
});
afterEach(() => {
  cleanup();
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
});

const present = () => [...agorStore.getState().sessionById.keys()].sort();

describe('usePinnedRows', () => {
  it('pins the new ids before releasing the old ones, and releases on unmount', () => {
    const { rerender, unmount } = renderHook(({ ids }) => usePinnedRows({ sessions: ids }), {
      initialProps: { ids: ['s-a', 's-b'] },
    });
    rerender({ ids: ['s-b', 's-c'] });
    // s-a was released and no scope holds it; s-b never left.
    expect(present()).toEqual(['s-b', 's-c']);
    expect(pinnedMembers.sessions?.has('s-b')).toBe(true);
    unmount();
    expect(present()).toEqual([]);
  });
});

describe('usePinnedOpenRows', () => {
  it("pins the open session's branch with it", () => {
    const { unmount } = renderHook(() =>
      usePinnedOpenRows({ sessions: ['s-a'], branches: ['br-x'] })
    );
    expect(pinnedMembers.sessions?.has('s-a')).toBe(true);
    expect(pinnedMembers.branches?.has('br-s-a')).toBe(true);
    expect(pinnedMembers.branches?.has('br-x')).toBe(true);
    unmount();
    expect(pinnedMembers.branches?.has('br-s-a')).toBe(false);
  });
});
