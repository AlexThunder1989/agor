/**
 * The mobile nav tree loads a board's branches and sessions when the board is
 * expanded (its partition, in the background), so it works with the store's
 * branch and session maps empty (Step 3).
 */
import type { AgorClient, Board, Branch, Session } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetHydrationRevisions } from '../../store/agorHydration';
import { agorStore, useAgorStore } from '../../store/agorStore';
import { getDisplayedBoardId } from '../../store/boardPartitions';
import { discardRealtimeNow, setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { selectBranchById, selectSessionsByBranch } from '../../store/selectors';
import { MobileNavTree } from './MobileNavTree';

const board = { board_id: 'board-1', name: 'Delivery' } as Board;
const branch = {
  branch_id: 'branch-1',
  board_id: 'board-1',
  name: 'checkout-flow',
  archived: false,
} as unknown as Branch;
const session = {
  session_id: 'session-1',
  branch_id: 'branch-1',
  title: 'Fix the cart',
  status: 'idle',
  last_updated: '2026-10-01T00:00:00.000Z',
} as unknown as Session;

function makeClient() {
  const reads: string[] = [];
  const client = {
    io: { on: vi.fn(), off: vi.fn() },
    service: (name: string) => ({
      findAll: vi.fn(async () => {
        reads.push(name);
        return name === 'branches' ? [branch] : name === 'sessions' ? [session] : [];
      }),
      get: vi.fn(async () => ({ ...board, objects: {} })),
    }),
  } as unknown as AgorClient;
  return { client, reads };
}

function Tree({ client }: { client: AgorClient }) {
  const branchById = useAgorStore(selectBranchById);
  const sessionsByBranch = useAgorStore(selectSessionsByBranch);
  return (
    <MemoryRouter>
      <MobileNavTree
        client={client}
        canUseMemberWorkspaceServices
        boardById={new Map([[board.board_id, board]])}
        branchById={branchById}
        sessionsByBranch={sessionsByBranch}
        commentById={new Map()}
        onOpenWorkspaceSettings={vi.fn()}
        onOpenUserSettings={vi.fn()}
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  agorStore.getState().reset();
  resetHydrationRevisions();
  discardRealtimeNow();
  setRealtimeAuthorityScope('user-a:member:1');
  agorStore.getState().setLoading(false);
  agorStore.getState().setMap('boardById', new Map([[board.board_id, board]]));
});
afterEach(() => {
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
});

it('loads an expanded board in the background and lists its branches and sessions', async () => {
  const { client, reads } = makeClient();
  render(<Tree client={client} />);
  // Collapsed boards read nothing.
  expect(reads).toEqual([]);

  const expand = () =>
    screen.getAllByRole('button').find((el) => el.getAttribute('aria-expanded') === 'false');
  fireEvent.click(expand() as HTMLElement);
  expect(await screen.findByText('checkout-flow')).toBeInTheDocument();
  fireEvent.click(expand() as HTMLElement);
  expect(await screen.findByText('Fix the cart')).toBeInTheDocument();
  await waitFor(() => expect(reads).toContain('sessions'));
  // A navigation list never takes the displayed board's place.
  expect(getDisplayedBoardId()).toBeUndefined();
});
