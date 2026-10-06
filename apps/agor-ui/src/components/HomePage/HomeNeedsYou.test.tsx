/**
 * A comment row for you names its session's branch with the store's session
 * and branch maps empty (Step 3): Needs you reads the shown comment rows'
 * target sessions, and their branches, by id.
 */
import type { AgorClient, BoardComment, Branch, Session } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetHydrationRevisions } from '../../store/agorHydration';
import { agorStore } from '../../store/agorStore';
import { discardRealtimeNow, setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import type { HomeCommentNeed } from '../../store/selectors';
import { HomeNeedsYou } from './HomeNeedsYou';

const AUTHORITY = 'user-me:member:1';
const comment = {
  comment_id: 'c1',
  board_id: 'board-1',
  session_id: 's1',
  created_by: 'user-2',
  content: 'Look at this',
  created_at: new Date(0).toISOString(),
} as BoardComment;
const need: HomeCommentNeed = {
  key: 'comment:c1',
  reason: 'comment',
  at: 0,
  boardId: 'board-1',
  thread: comment,
  comment,
  threadSize: 1,
};

beforeEach(() => {
  discardRealtimeNow();
  setRealtimeAuthorityScope(AUTHORITY);
  agorStore.getState().setLoading(false);
});
afterEach(() => {
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
  resetHydrationRevisions();
});

it("reads a shown comment's session and its branch for the row's branch chip", async () => {
  const sessionsFind = vi.fn(async () => [
    { session_id: 's1', branch_id: 'b1', archived: false } as Session,
  ]);
  const branchesFind = vi.fn(async () => [
    { branch_id: 'b1', name: 'feature-b1', archived: false } as Branch,
  ]);
  const client = {
    service: (name: string) => ({ find: name === 'sessions' ? sessionsFind : branchesFind }),
  } as unknown as AgorClient;
  render(
    <HomeNeedsYou
      client={client}
      needs={[need]}
      needsCount={1}
      needsByReason={{ permission: 0, failed: 0, finished: 0 }}
      commentCount={1}
      filter="all"
      onFilterChange={vi.fn()}
      expanded={false}
      onExpandedChange={vi.fn()}
      hydrated
      onOpenSession={vi.fn()}
      onOpenFailure={vi.fn()}
      onOpenComment={vi.fn()}
      onMarkRead={vi.fn()}
    />
  );
  expect(await screen.findByText('feature-b1')).toBeInTheDocument();
  expect(sessionsFind).toHaveBeenCalledTimes(1);
  expect(branchesFind).toHaveBeenCalledTimes(1);
});
