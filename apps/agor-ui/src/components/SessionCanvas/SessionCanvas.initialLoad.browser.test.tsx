import type { AgorClient, Board, BoardEntityObject, Branch, Repo, User } from '@agor-live/client';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { App } from 'antd';
import 'reactflow/dist/style.css';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import {
  beginInitialLoadDebug,
  getInitialLoadDebugTimer,
  type InitialLoadDebugTimings,
} from '../../utils/initialLoadDebug';
import SessionCanvas from './SessionCanvas';

const originalUrl = window.location.href;
const snapshot = () =>
  (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
    .__AGOR_INITIAL_LOAD_TIMINGS__!;
afterEach(() => {
  cleanup();
  getInitialLoadDebugTimer()?.discard();
  localStorage.clear();
  window.history.replaceState({}, '', originalUrl);
  delete (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
    .__AGOR_INITIAL_LOAD_TIMINGS__;
  vi.restoreAllMocks();
});
it.each([
  { empty: false, measured: true, debug: true },
  { empty: true, measured: true, debug: true },
  { empty: false, measured: false, debug: true },
  { empty: false, measured: true, debug: false },
  { empty: false, measured: false, debug: false },
])('observes existing positioning: %j', async ({ empty, measured, debug }) => {
  if (!measured) {
    // React Flow reads offset dimensions both on mount and in ResizeObserver.
    // Hold only its nodes unmeasured, leaving the actual fitView implementation.
    for (const dimension of ['offsetWidth', 'offsetHeight'] as const) {
      const get = Object.getOwnPropertyDescriptor(HTMLElement.prototype, dimension)!.get!;
      vi.spyOn(HTMLElement.prototype, dimension, 'get').mockImplementation(function (
        this: HTMLElement
      ) {
        return this.classList.contains('react-flow__node') ? 0 : get.call(this);
      });
    }
  }
  window.history.replaceState({}, '', `/b/startup/?debugLoad=${debug ? 1 : 0}`);
  const timer = beginInitialLoadDebug();
  timer?.configSettled();
  const user = { user_id: 'startup-owner', role: 'member' } as User;
  const board: Board = {
    board_id: 'startup-board' as Board['board_id'],
    name: 'Startup fixture',
    objects: measured
      ? {}
      : { note: { type: 'markdown', x: 12000, y: -9000, width: 300, content: 'Unmeasured note' } },
    created_by: user.user_id,
    primary_owner_user_id: user.user_id,
    created_at: '2026-09-01T00:00:00.000Z',
    last_updated: '2026-09-01T00:00:00.000Z',
    archived: false,
    url: '/b/startup/',
  };
  const branch = {
    branch_id: 'off-origin-branch',
    board_id: board.board_id,
    repo_id: 'startup-repo',
    name: 'Off-origin usable content',
    filesystem_status: 'ready',
    archived: false,
  } as Branch;
  const repo = { repo_id: branch.repo_id, slug: 'fixture/startup' } as Repo;
  const placement = {
    object_id: 'startup-placement',
    board_id: board.board_id,
    branch_id: branch.branch_id,
    entity_type: 'branch',
    position: { x: 12000, y: -9000 },
  } as BoardEntityObject;
  agorStore.setState({
    ...EMPTY_MAPS,
    userById: new Map([[user.user_id, user]]),
    repoById: new Map([[repo.repo_id, repo]]),
    branchById: new Map(empty || !measured ? [] : [[branch.branch_id, branch]]),
    boardObjectsByBoardId: new Map([[board.board_id, empty || !measured ? [] : [placement]]]),
  });
  const client = {
    service: () => ({
      find: async () => ({ data: [], capabilities: [] }),
      get: async () => ({ capabilities: [] }),
      on: vi.fn(),
      off: vi.fn(),
    }),
  } as unknown as AgorClient;
  // Synchronous observation AT terminal publication, not a later Playwright
  // assertion that could accidentally wait out an incorrectly early milestone.
  let visibleAtTerminal = false;
  let nodesAtTerminal = -1;
  const finish = timer?.surfaceReady;
  if (timer)
    vi.spyOn(timer, 'surfaceReady').mockImplementation((surface) => {
      const pane = document.querySelector('.react-flow')!.getBoundingClientRect();
      const nodes = [...document.querySelectorAll<HTMLElement>('.react-flow__node')];
      nodesAtTerminal = nodes.length;
      const node = nodes.find((n) => n.dataset.id === branch.branch_id);
      if (node) {
        const rect = node.getBoundingClientRect();
        const x =
          (Math.max(rect.left, pane.left, 0) + Math.min(rect.right, pane.right, innerWidth)) / 2;
        const y =
          (Math.max(rect.top, pane.top, 0) + Math.min(rect.bottom, pane.bottom, innerHeight)) / 2;
        visibleAtTerminal =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > pane.left &&
          rect.left < pane.right &&
          rect.bottom > pane.top &&
          rect.top < Math.min(pane.bottom, innerHeight) &&
          !!node.textContent?.includes(branch.name) &&
          node.contains(document.elementFromPoint(x, y));
      }
      finish!(surface);
    });
  render(
    <App>
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          authGeneration: 1,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <div style={{ height: 500 }}>
          <SessionCanvas
            board={board}
            branches={empty || !measured ? [] : [branch]}
            client={client}
            currentUserId={user.user_id}
            height={500}
          />
        </div>
      </ConnectionProvider>
    </App>
  );
  if (!debug || !measured) {
    if (debug) {
      await waitFor(() => expect(snapshot().status).toBe('error'));
      expect(snapshot().stageTransitions.map((row) => row.stage)).toContain(
        'board-initial-position-failed'
      );
      expect(snapshot().stageTransitions.map((row) => row.stage)).not.toContain(
        'board-ready-commit'
      );
      expect(nodesAtTerminal).toBe(-1);
    } else expect(snapshot()).toBeUndefined();
    // Debug mode leaves the real positioning outcome unchanged.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await waitFor(() => {
      const pane = document.querySelector('.react-flow')!.getBoundingClientRect();
      const node = document.querySelector<HTMLElement>('.react-flow__node')!;
      const rect = node.getBoundingClientRect();
      expect(
        getComputedStyle(node).visibility !== 'hidden' &&
          rect.right > pane.left &&
          rect.left < pane.right &&
          rect.bottom > pane.top &&
          rect.top < pane.bottom
      ).toBe(measured);
    });
    return;
  }
  await waitFor(() => expect(snapshot().status).toBe('success'));
  expect(nodesAtTerminal).toBe(empty ? 0 : 1);
  if (!empty) {
    expect(visibleAtTerminal).toBe(true);
    const at = (stage: string) =>
      snapshot().stageTransitions.find((row) => row.stage === stage)!.atMs;
    expect(at('board-initial-position-start') - at('board-initialized')).toBeGreaterThanOrEqual(90);
    expect(
      at('board-initial-position-settled') - at('board-initial-position-start')
    ).toBeGreaterThanOrEqual(200);
  }
});
