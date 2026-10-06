/**
 * Settings → Boards counts each board's active sessions with count-only reads,
 * so the counts are right with the store's branch and session maps empty
 * (Step 3).
 */
import type { AgorClient, Board } from '@agor-live/client';
import { render, screen, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { expect, it, vi } from 'vitest';
import { BoardsTable } from './BoardsTable';

const board = (n: number) =>
  ({ board_id: `board-${n}`, name: `Board ${n}`, slug: `board-${n}` }) as unknown as Board;

it('counts every board’s active sessions on the daemon', async () => {
  const sessionsFind = vi.fn(async ({ query }: { query: { board_id: string } }) => ({
    total: query.board_id === 'board-1' ? 4 : 0,
    limit: 0,
    skip: 0,
    data: [],
  }));
  const client = { service: () => ({ find: sessionsFind }) } as unknown as AgorClient;
  render(
    <AntApp>
      <BoardsTable
        client={client}
        boardById={new Map([board(1), board(2)].map((b) => [b.board_id, b]))}
        branchById={new Map()}
      />
    </AntApp>
  );
  const row = (await screen.findByText('Board 1')).closest('tr') as HTMLElement;
  expect(await within(row).findByText('4')).toBeInTheDocument();
  expect(sessionsFind).toHaveBeenCalledWith({
    query: { board_id: 'board-1', archived: false, $limit: 0 },
  });
});
