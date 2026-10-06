/**
 * Opening a branch from Settings reads that branch's active sessions for the
 * BranchModal, so its count and list are right with the store's session map
 * empty (Step 3).
 */
import type { AgorClient, Branch, Session, User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { Grid } from 'antd';
import { beforeEach, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { SettingsModal } from './SettingsModal';

const branch = { branch_id: 'branch-1', repo_id: 'repo-1', name: 'feature' } as Branch;
const session = { session_id: 's1', branch_id: 'branch-1', title: 'Fix it' } as Session;

vi.mock('./BranchesTable', () => ({
  BranchesTable: ({ onRowClick }: { onRowClick: (b: Branch) => void }) => (
    <button type="button" onClick={() => onRowClick(branch)}>
      open branch
    </button>
  ),
}));
vi.mock('../BranchModal', () => ({
  BranchModal: ({ open, sessions }: { open: boolean; sessions: Session[] }) =>
    open ? <div data-testid="branch-modal">{sessions.map((s) => s.title).join(',')}</div> : null,
}));

beforeEach(() => {
  agorStore.getState().reset();
  vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: true });
});

it("reads the opened branch's active sessions once", async () => {
  const findAll = vi.fn(async () => [session]);
  const client = { service: () => ({ findAll }) } as unknown as AgorClient;
  render(
    <SettingsModal
      open
      onClose={vi.fn()}
      client={client}
      currentUser={{ user_id: 'u1', role: 'admin' } as User}
      activeTab="branches"
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'open branch' }));
  expect(await screen.findByText('Fix it')).toBeInTheDocument();
  expect(findAll).toHaveBeenCalledTimes(1);
  expect(findAll).toHaveBeenCalledWith({
    query: { branch_id: 'branch-1', archived: false, $sort: { created_at: -1 } },
  });
});
