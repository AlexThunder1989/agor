import { act, render, renderHook, screen } from '@testing-library/react';
import { App } from 'antd';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../contexts/ConnectionContext';
import { agorStore } from '../store/agorStore';
import { captureBoardWriteTicket, isBoardWriteTicketCurrent } from '../store/boardMutationGuard';
import { publishConnectionSnapshot, withdrawConnectionSnapshot } from '../store/connectionSnapshot';
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
  const publisher = {};
  const owner = { alive: true };
  const capture = (requirePartition: boolean) =>
    captureBoardWriteTicket(BOARD, { requirePartition, owner });

  beforeEach(() => {
    agorStore.setState({ boardPartitions: new Map() });
    owner.alive = true;
    publishConnectionSnapshot(publisher, connection());
  });
  afterEach(() => withdrawConnectionSnapshot(publisher));

  it('captures nothing for an unloaded board unless the write needs no partition', () => {
    expect(capture(true)).toBe(null);
    agorStore.getState().setBoardPartition(BOARD, {
      status: 'loading',
      authorityScope: 'fixture',
      loadEpoch: 0,
      loadId: 1,
    });
    expect(capture(true)).toBe(null);
    expect(isBoardWriteTicketCurrent(capture(false))).toBe(true);
  });

  it('a ticket from before an unload is never current again, even after the board reloads', () => {
    load();
    const ticket = capture(true);
    expect(isBoardWriteTicketCurrent(ticket)).toBe(true);
    unload();
    expect(isBoardWriteTicketCurrent(ticket)).toBe(false);
    load();
    expect(isBoardWriteTicketCurrent(ticket)).toBe(false);
    expect(isBoardWriteTicketCurrent(capture(true))).toBe(true);
  });

  it('a re-authentication or an unusable connection ends a ticket', () => {
    load();
    const ticket = capture(false);
    publishConnectionSnapshot(publisher, connection({ connected: false }));
    expect(isBoardWriteTicketCurrent(ticket)).toBe(false);
    expect(capture(false)).toBe(null);
    publishConnectionSnapshot(publisher, connection({ authGeneration: 2 }));
    expect(isBoardWriteTicketCurrent(ticket)).toBe(false);
    expect(isBoardWriteTicketCurrent(capture(false))).toBe(true);
  });

  it("an owner's end ends its tickets", () => {
    load();
    const ticket = capture(true);
    owner.alive = false;
    expect(isBoardWriteTicketCurrent(ticket)).toBe(false);
    expect(capture(true)).toBe(null);
  });
});

describe('useBoardMutationGuard', () => {
  beforeEach(() => {
    agorStore.setState({ boardPartitions: new Map() });
  });

  function renderGuard(
    initial: { boardId?: string; allowed?: boolean; connected?: boolean },
    options: { requirePartition?: boolean } = {}
  ) {
    let props = { boardId: BOARD, allowed: true, connected: true, ...initial };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <App>
        <ConnectionProvider value={connection({ connected: props.connected })}>
          {children}
        </ConnectionProvider>
      </App>
    );
    const view = renderHook(() => useBoardMutationGuard(props.boardId, props.allowed, options), {
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

  it.each([true, false])(
    'ends every ticket when the guard unmounts (requirePartition: %s)',
    async (requirePartition) => {
      act(() => load());
      const view = renderGuard({}, { requirePartition });
      const ticket = view.result.current.capture();
      expect(view.result.current.isCurrent(ticket)).toBe(true);
      const { isCurrent, write } = view.result.current;
      view.unmount();
      // Nothing else changed: same board lifetime, connection and generation.
      expect(isCurrent(ticket)).toBe(false);
      const dispatch = vi.fn(async () => {});
      await act(async () => {
        expect(await write(ticket, dispatch)).toBe(false);
      });
      expect(dispatch).not.toHaveBeenCalled();
    }
  );

  it('judges a held ticket against the connection published now, not the last render', () => {
    act(() => load());
    const view = renderGuard({}, { requirePartition: false });
    const ticket = view.result.current.capture();
    const { isCurrent, capture } = view.result.current;
    // Another provider (the app after a re-authentication) publishes generation 2.
    render(
      <ConnectionProvider value={connection({ authGeneration: 2 })}>
        <div />
      </ConnectionProvider>
    );
    expect(isCurrent(ticket)).toBe(false);
    // Its owner still renders generation 1: nothing is captured until both agree.
    expect(capture()).toBe(null);
  });
});
