import { act, cleanup, renderHook } from '@testing-library/react';
import type { Node, ReactFlowInstance } from 'reactflow';
import { afterEach, expect, it, vi } from 'vitest';
import {
  beginInitialLoadDebug,
  getInitialLoadDebugTimer,
  type InitialLoadDebugTimings,
} from '../utils/initialLoadDebug';
import { useInitialBoardReadiness } from './useInitialBoardReadiness';

const originalUrl = window.location.href;
afterEach(() => {
  cleanup();
  getInitialLoadDebugTimer()?.discard();
  localStorage.clear();
  window.history.replaceState({}, '', originalUrl);
  delete (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
    .__AGOR_INITIAL_LOAD_TIMINGS__;
  vi.restoreAllMocks();
});
it('requires this board’s measured nodes, not an empty or same-sized stale React Flow store', () => {
  window.history.replaceState({}, '', '/b/target/?debugLoad=1');
  beginInitialLoadDebug()!.configSettled();
  const snapshot = () =>
    (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
      .__AGOR_INITIAL_LOAD_TIMINGS__!;
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    callbacks.set(++id, cb);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    callbacks.delete(id);
  });
  const frame = () =>
    act(() => {
      now += 100;
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(now);
    });
  const expected: Node = { id: 'target-node', position: { x: 9000, y: -8000 }, data: {} };
  let nodes: Node[] = [];
  const instance = {
    current: {
      getNodes: () => nodes,
      getViewport: () => ({ x: -9000, y: 8000, zoom: 1 }),
    } as unknown as ReactFlowInstance,
  };
  const view = renderHook(() => useInitialBoardReadiness(true, 'target', [expected], instance));
  frame();
  expect(snapshot().status).toBe('pending');
  view.result.current(200);
  nodes = [{ ...expected, id: 'stale-node', width: 100, height: 100 }];
  for (let i = 0; i < 6; i++) frame();
  expect(snapshot().status).toBe('pending');
  nodes = [expected]; // correct identity, not yet measured
  for (let i = 0; i < 3; i++) frame();
  expect(snapshot().status).toBe('pending');
  nodes = [{ ...expected, width: 100, height: 100 }];
  for (let i = 0; i < 3; i++) frame();
  expect(snapshot().status).toBe('success');
  view.unmount();
  expect(callbacks.size).toBe(0);
});
