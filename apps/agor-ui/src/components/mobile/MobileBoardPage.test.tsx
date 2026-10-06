import type { Board, BoardEntityObject, Branch } from '@agor-live/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { App } from 'antd';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { OPEN_BOARD_SWITCHER_EVENT } from '../../utils/shellEvents';
import { MobileBoardPage } from './MobileBoardPage';

type CanvasProps = {
  readOnly?: boolean;
  branches: Branch[];
  onSessionClick: (id: string) => void;
  onOpenBranch: (id: string) => void;
};
const canvas: { props?: CanvasProps; renders: number } = { renders: 0 };
vi.mock('../SessionCanvas/SessionCanvas', () => ({
  default: (props: CanvasProps) => {
    canvas.props = props;
    canvas.renders++;
    return <div data-testid="canvas" />;
  },
}));
vi.mock('../CommentsPanel', () => ({ CommentsPanel: () => <div data-testid="comments" /> }));

const board = { board_id: 'board-1', name: 'Delivery', objects: {} } as unknown as Board;
const other = { board_id: 'board-2', name: 'Ops', objects: {} } as unknown as Board;
const branch = { branch_id: 'branch-1', name: 'feat/mobile', board_id: 'board-1' } as Branch;
const boardById = new Map([
  [board.board_id, board],
  [other.board_id, other],
]);
const branchById = new Map([[branch.branch_id, branch]]);

function Probe() {
  const { pathname, search } = useLocation();
  return <output aria-label="location">{pathname + search}</output>;
}

function renderPage(entry: string | { pathname: string; state: unknown }, onOpenBranch = vi.fn()) {
  // MobileApp re-renders on every session patch and passes fresh inline handlers.
  const tree = () => (
    <App>
      <MemoryRouter initialEntries={[entry]}>
        <Probe />
        <Routes>
          <Route
            path="/m/board/:boardId"
            element={
              <MobileBoardPage
                client={null}
                boardById={boardById}
                branchById={branchById}
                onOpenBranch={onOpenBranch}
                onNewSession={() => {}}
                onForkSession={vi.fn(async () => {})}
                onSpawnSession={vi.fn(async () => {})}
                onSendComment={vi.fn()}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </App>
  );
  const { rerender } = render(tree());
  return { onOpenBranch, rerenderFromShell: () => rerender(tree()) };
}

const location = () => screen.getByRole('status', { name: 'location' }).textContent;

beforeEach(() => {
  canvas.props = undefined;
  canvas.renders = 0;
  agorStore.setState({
    ...EMPTY_MAPS,
    boardById,
    branchById,
    boardObjectsByBoardId: new Map([
      [
        board.board_id,
        [{ board_id: board.board_id, branch_id: branch.branch_id } as BoardEntityObject],
      ],
    ]),
  } as never);
});
afterEach(() => vi.restoreAllMocks());

describe('MobileBoardPage', () => {
  it('shows the board tabs, led by a read-only canvas of this board', async () => {
    renderPage('/m/board/board-1');
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['Board', 'Teammate', 'Sessions', 'Comments']);
    expect(screen.getByRole('tab', { name: 'Board' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('canvas')).toBeInTheDocument();
    expect(canvas.props?.readOnly).toBe(true);
    expect(canvas.props?.branches).toEqual([branch]);
    expect(screen.getByText('Delivery')).toBeInTheDocument();
  });

  it('keeps the selected tab in the URL', () => {
    renderPage('/m/board/board-1?tab=comments');
    expect(screen.getByRole('tab', { name: 'Comments' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));
    expect(location()).toBe('/m/board/board-1?tab=all-sessions');
    fireEvent.click(screen.getByRole('tab', { name: 'Board' }));
    expect(location()).toBe('/m/board/board-1');
  });

  it('opens sessions and branches tapped on the canvas', async () => {
    const { onOpenBranch } = renderPage('/m/board/board-1');
    await screen.findByTestId('canvas');
    act(() => canvas.props?.onOpenBranch('branch-1'));
    expect(onOpenBranch).toHaveBeenCalledWith('branch-1', 'general');
    act(() => canvas.props?.onSessionClick('session-1'));
    expect(location()).toBe('/m/session/session-1');
  });

  it('does not re-render the canvas when the shell re-renders for a session patch', async () => {
    const { rerenderFromShell } = renderPage('/m/board/board-1');
    await screen.findByTestId('canvas');
    const renders = canvas.renders;
    act(() => agorStore.setState({ sessionById: new Map() } as never));
    rerenderFromShell();
    expect(canvas.renders).toBe(renders);
  });

  it('opens the board switcher when arriving from All boards', () => {
    const listener = vi.fn();
    window.addEventListener(OPEN_BOARD_SWITCHER_EVENT, listener);
    renderPage({ pathname: '/m/board/board-1', state: { openBoardSwitcher: true } });
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_BOARD_SWITCHER_EVENT, listener);
  });

  it('keeps the switcher on an unknown board', () => {
    renderPage('/m/board/missing');
    expect(screen.getByText('Board not found')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Home/ })).toBeInTheDocument();
  });
});
