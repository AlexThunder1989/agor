/**
 * An event's BranchCard popover reads that branch's active sessions when it
 * opens, so it lists them with the store's session map empty (Step 3).
 */
import type { AgorClient, Branch, Repo, Session } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { EventItem } from './EventItem';

vi.mock('../BranchCard/BranchCard', () => ({
  default: ({ sessions }: { sessions: Session[] }) => (
    <div data-testid="branch-card">{sessions.map((s) => s.title).join(',')}</div>
  ),
}));

const branch = { branch_id: 'b1', repo_id: 'r1', name: 'feature-b1' } as Branch;
const repo = { repo_id: 'r1', name: 'repo', slug: 'org/repo' } as Repo;
const session = { session_id: 's1', branch_id: 'b1', title: 'Fix it' } as Session;

beforeEach(() => setRealtimeAuthorityScope('user-1:member:1'));
afterEach(() => {
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
});

it("reads the branch's sessions when its popover opens", async () => {
  const findAll = vi.fn(async () => [session]);
  const client = {
    service: () => ({ findAll, on: () => {}, off: () => {} }),
  } as unknown as AgorClient;
  render(
    <EventItem
      event={{
        id: 'e1',
        timestamp: new Date(0),
        type: 'crud',
        eventName: 'branches patched',
        data: { branch_id: 'b1' },
      }}
      branchById={new Map([[branch.branch_id, branch]])}
      sessionById={new Map()}
      repos={[repo]}
      userById={new Map()}
      client={client}
    />
  );
  expect(findAll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('feature-b1'));
  expect(await screen.findByText('Fix it')).toBeInTheDocument();
  expect(findAll).toHaveBeenCalledWith({
    query: { branch_id: 'b1', archived: false, $sort: { created_at: -1 } },
  });
});
