import { act, renderHook, screen } from '@testing-library/react';
import { App } from 'antd';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../contexts/ConnectionContext';
import { agorStore } from '../store/agorStore';
import { captureBoardWriteTicket, isBoardWriteTicketCurrent } from '../store/boardMutationGuard';
import { useBoardMutationGuard } from './useBoardMutationGuard';

const BOARD = 'board-guard';
const OTHER = 'board-other';

const connection = (overrides: Partial<{ connected: boolean; authGeneration: number }> = {}) => ({
  connected: true,
  connecting: false,
  authGeneration: 1,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
  ...overrides,
});

function load(boardId = BOARD) {
  agorStore.getState().setBoardPartition(boardId, {
    status: 'loaded',
    authorityScope: 'fixture',
    loadEpoch: 0,
  });
}

function unload() {
  agorStore.getState().resetBoardPartitions();
}

describe('board write tickets', () => {
  beforeEach(() => {
    agorStore.setState({ boardPartitions: new Map() });
  });

  it('captures nothing for an unloaded board unless the write needs no partition', () => {
    expect(captureBoardWriteTicket(BOARD, { requirePartition: true, authGeneration: 1 })).toBe(
      null
    );
    agorStore.getState().setBoardPartition(BOARD, {
      status: 'loading',
      authorityScope: 'fixture',
      loadEpoch: 0,
      loadId: 1,
    });
    expect(captureBoardWriteTicket(BOARD, { requirePartition: true, authGeneration: 1 })).toBe(
      null
    );
    const free = captureBoardWriteTicket(BOARD, { requirePartition: false, authGeneration: 1 });
    expect(isBoardWriteTicketCurrent(free, 1)).toBe(true);
  });

  it('a ticket from before an unload is never current again, even after the board reloads', () => {
    load();
    const ticket = captureBoardWriteTicket(BOARD, { requirePartition: true, authGeneration: 1 });
    expect(isBoardWriteTicketCurrent(ticket, 1)).toBe(true);
    unload();
    expect(isBoardWriteTicketCurrent(ticket, 1)).toBe(false);
    load();
    expect(isBoardWriteTicketCurrent(ticket, 1)).toBe(false);
    const fresh = captureBoardWriteTicket(BOARD, { requirePartition: true, authGeneration: 1 });
    expect(isBoardWriteTicketCurrent(fresh, 1)).toBe(true);
  });

  it('a re-authentication ends a ticket', () => {
    load();
    const ticket = captureBoardWriteTicket(BOARD, { requirePartition: true, authGeneration: 1 });
    expect(isBoardWriteTicketCurrent(ticket, 2)).toBe(false);
  });
});

describe('useBoardMutationGuard', () => {
  beforeEach(() => {
    agorStore.setState({ boardPartitions: new Map() });
  });

  function renderGuard(initial: { boardId?: string; allowed?: boolean; connected?: boolean }) {
    let props = { boardId: BOARD, allowed: true, connected: true, ...initial };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <App>
        <ConnectionProvider value={connection({ connected: props.connected })}>
          {children}
        </ConnectionProvider>
      </App>
    );
    const view = renderHook(() => useBoardMutationGuard(props.boardId, props.allowed), {
      wrapper,
    });
    return {
      ...view,
      update(next: Partial<typeof props>) {
        props = { ...props, ...next };
        view.rerender();
      },
    };
  }

  it('reports canMutate only for a loaded, allowed, connected board', () => {
    const view = renderGuard({});
    expect(view.result.current.canMutate).toBe(false);
    expect(view.result.current.capture()).toBe(null);
    act(() => load());
    expect(view.result.current.canMutate).toBe(true);
    view.update({ allowed: false });
    expect(view.result.current.canMutate).toBe(false);
    expect(view.result.current.capture()).toBe(null);
    view.update({ allowed: true, connected: false });
    expect(view.result.current.canMutate).toBe(false);
  });

  it('never dispatches a write whose ticket went stale across an unload and reload', async () => {
    act(() => load());
    const view = renderGuard({});
    const ticket = view.result.current.capture();
    expect(ticket).not.toBe(null);
    act(() => unload());
    act(() => load());
    expect(view.result.current.canMutate).toBe(true);
    const dispatch = vi.fn(async () => {});
    let sent: boolean | undefined;
    await act(async () => {
      sent = await view.result.current.write(ticket, dispatch, 'Board reloaded; not saved.');
    });
    expect(sent).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await screen.findByText('Board reloaded; not saved.')).toBeTruthy();
  });

  it('rechecks the live permission, connection and board at dispatch time', async () => {
    act(() => load());
    act(() => load(OTHER));
    const view = renderGuard({});
    const ticket = view.result.current.capture();
    const dispatch = vi.fn(async () => {});
    await act(async () => {
      expect(await view.result.current.write(ticket, dispatch)).toBe(true);
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    for (const change of [{ allowed: false }, { connected: false }, { boardId: OTHER }]) {
      view.update({ boardId: BOARD, allowed: true, connected: true, ...change });
      expect(view.result.current.isCurrent(ticket)).toBe(false);
    }
    view.update({ boardId: BOARD, allowed: true, connected: true });
    expect(view.result.current.isCurrent(ticket)).toBe(true);
  });
});
