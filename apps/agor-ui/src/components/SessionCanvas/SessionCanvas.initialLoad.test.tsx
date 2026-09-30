import type { Board } from '@agor-live/client';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactFlowInstance, ReactFlowProps } from 'reactflow';
import { afterEach, expect, it, vi } from 'vitest';
import {
  beginInitialLoadDebug,
  getInitialLoadDebugTimer,
  type InitialLoadDebugTimings,
} from '../../utils/initialLoadDebug';
import SessionCanvas from './SessionCanvas';

let flowProps: ReactFlowProps;
vi.mock('reactflow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('reactflow')>()),
  ReactFlow: (props: ReactFlowProps) => {
    flowProps = props;
    return null;
  },
  useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
}));
const originalUrl = window.location.href;
const snapshot = () =>
  (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
    .__AGOR_INITIAL_LOAD_TIMINGS__;
afterEach(() => {
  cleanup();
  getInitialLoadDebugTimer()?.discard();
  localStorage.clear();
  window.history.replaceState({}, '', originalUrl);
  delete (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
    .__AGOR_INITIAL_LOAD_TIMINGS__;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([
  { debug: true, throws: true },
  { debug: false, throws: true },
  { debug: true, throws: false },
  { debug: false, throws: false },
])('preserves failed fit behavior: %j', ({ debug, throws }) => {
  window.history.replaceState({}, '', `/b/board/?debugLoad=${debug ? 1 : 0}`);
  beginInitialLoadDebug()?.configSettled();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  const error = new Error('SECRET positioning error');
  const fitView = vi.fn(() => {
    if (throws) throw error;
    return false;
  });
  const board = {
    board_id: 'board',
    objects: {
      zone: { type: 'zone', x: 0, y: 0, width: 500, height: 300, label: 'Zone' },
    },
  } as unknown as Board;
  const view = render(<SessionCanvas board={board} client={null} branches={[]} />);
  act(() => flowProps.onInit!({ fitView } as unknown as ReactFlowInstance));
  expect(flowProps.nodes!.length).toBeGreaterThan(0);
  if (throws) expect(() => act(() => vi.advanceTimersByTime(100))).toThrow(error);
  else act(() => vi.advanceTimersByTime(100));
  expect(fitView).toHaveBeenCalledExactlyOnceWith({
    padding: 0.2,
    minZoom: 0.1,
    maxZoom: 1.0,
    duration: 200,
  });
  if (debug) {
    expect(snapshot()?.status).toBe('error');
    expect(snapshot()?.stageTransitions.map((row) => row.stage)).toContain(
      'board-initial-position-failed'
    );
    expect(JSON.stringify(snapshot())).not.toContain('SECRET');
  } else {
    expect(snapshot()).toBeUndefined();
    expect(raf).not.toHaveBeenCalled();
  }
  expect(frames.size).toBe(0);
  if (!throws) {
    // A false fit still consumes the existing once-per-board attempt. Node
    // changes must not cause the diagnostic fix to retry positioning.
    view.rerender(
      <SessionCanvas
        board={{ ...board, objects: { ...board.objects, another: board.objects!.zone } }}
        client={null}
        branches={[]}
      />
    );
    expect(flowProps.nodes).toHaveLength(2);
  }
  act(() => vi.advanceTimersByTime(30_000));
  expect(fitView).toHaveBeenCalledTimes(1);
});
