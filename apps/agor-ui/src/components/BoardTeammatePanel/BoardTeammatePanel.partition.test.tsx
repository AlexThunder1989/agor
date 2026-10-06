/**
 * A primary teammate that lives on another board: its sessions come with
 * that board's partition (loaded in the background), so the teammate tab
 * works with the store's session map empty (Step 3).
 */
import type { AgorClient, Board, Branch, Repo, Session, User } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetHydrationRevisions } from '../../store/agorHydration';
import { agorStore } from '../../store/agorStore';
import { getDisplayedBoardId } from '../../store/boardPartitions';
import { discardRealtimeNow, setRealtimeAuthorityScope } from '../../store/realtimeBatch';
import { BoardTeammatePanel } from './BoardTeammatePanel';

vi.mock('../BranchCard', () => ({
  BranchSessionSections: ({ sessions }: { sessions: Session[] }) => (
    <ul>
      {sessions.map((s) => (
        <li key={s.session_id}>{s.title}</li>
      ))}
    </ul>
  ),
}));

const board = { board_id: 'board-1', name: 'Shown', primary_teammate_id: 'mate' } as Board;
const otherBoard = { board_id: 'board-2', name: 'Home of the teammate' } as Board;
const teammate = {
  branch_id: 'mate',
  board_id: 'board-2',
  repo_id: 'repo-1',
  name: 'mate',
  filesystem_status: 'ready',
  archived: false,
} as unknown as Branch;
const repo = { repo_id: 'repo-1', slug: 'acme/app' } as Repo;
const session = {
  session_id: 's1',
  branch_id: 'mate',
  title: 'Teammate task',
  status: 'idle',
} as unknown as Session;

beforeEach(() => {
  agorStore.getState().reset();
  resetHydrationRevisions();
  discardRealtimeNow();
  setRealtimeAuthorityScope('user-1:member:1');
  agorStore.getState().setLoading(false);
  agorStore.getState().setMap(
    'boardById',
    new Map([
      [board.board_id, board],
      [otherBoard.board_id, otherBoard],
    ])
  );
  agorStore
    .getState()
    .setMap('userById', new Map([['user-1', { user_id: 'user-1', role: 'member' } as User]]));
});
afterEach(() => {
  setRealtimeAuthorityScope(null);
  agorStore.getState().reset();
});

it("loads the teammate's board in the background and lists its sessions", async () => {
  const client = {
    io: { on: vi.fn(), off: vi.fn() },
    service: (name: string) => ({
      findAll: vi.fn(async () =>
        name === 'sessions' ? [session] : name === 'branches' ? [teammate] : []
      ),
      find: vi.fn(async () => []),
      get: vi.fn(async () => ({ ...otherBoard, objects: {} })),
    }),
  } as unknown as AgorClient;
  render(
    <AntApp>
      <BoardTeammatePanel
        board={board}
        activeTab="teammate"
        onTabChange={vi.fn()}
        primaryTeammateBranch={teammate}
        primaryTeammateRepo={repo}
        primaryTeammateInaccessible={false}
        currentUserId="user-1"
        onSessionClick={vi.fn()}
        client={client}
      />
    </AntApp>
  );
  expect(screen.getByTestId('board-partition-skeleton')).toBeInTheDocument();
  expect(await screen.findByText('Teammate task')).toBeInTheDocument();
  expect(getDisplayedBoardId()).toBeUndefined();
});
