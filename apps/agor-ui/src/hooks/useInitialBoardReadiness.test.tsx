import { act, cleanup, renderHook } from '@testing-library/react';
import type { Node, ReactFlowInstance } from 'reactflow';
import { afterEach, expect, it, vi } from 'vitest';
import {
  beginInitialLoadDebug,
  getInitialLoadDebugTimer,
  type InitialLoadDebugTimings,
} from '../utils/initialLoadDebug';
import { useInitialBoardReadiness } from './useInitialBoardReadiness';
import { useInitialLoadOwner } from './useInitialLoadObserver';

const originalUrl = window.location.href;
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
const snapshot = () =>
  (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
    .__AGOR_INITIAL_LOAD_TIMINGS__!;

function frameQueue() {
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
  return { frame, callbacks };
}

function fixture(measured = true) {
  const node: Node = { id: 'target-node', position: { x: 9000, y: -8000 }, data: {} };
  const instance = {
    current: {
      getNodes: vi.fn(() => [measured ? { ...node, width: 100, height: 100 } : node]),
      getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
      fitView: vi.fn(() => false),
    } as unknown as ReactFlowInstance,
  };
  return { node, instance };
}

it('requires this board’s measured nodes, not an empty or same-sized stale React Flow store', () => {
  window.history.replaceState({}, '', '/b/target/?debugLoad=1');
  beginInitialLoadDebug()!.configSettled();
  const snapshot = () =>
    (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
      .__AGOR_INITIAL_LOAD_TIMINGS__!;
  const { frame, callbacks } = frameQueue();
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
  expect(callbacks.size).toBe(0);
  view.unmount();
});

it('settles an unsuccessful position immediately, without queued frames or false readiness', () => {
  window.history.replaceState({}, '', '/b/target/?debugLoad=1');
  beginInitialLoadDebug()!.configSettled();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { frame, callbacks } = frameQueue();
  const { node, instance } = fixture(false);
  const view = renderHook(() => useInitialBoardReadiness(true, 'target', [node], instance));
  view.result.current(200, false);
  const immediateStatus = snapshot().status;
  const terminal = JSON.stringify(snapshot());
  for (let i = 0; i < 10_000; i++) frame();
  expect(snapshot().status).toBe('error');
  expect(immediateStatus).toBe('error');
  expect(snapshot().stageTransitions.map((row) => row.stage)).toContain(
    'board-initial-position-failed'
  );
  expect(snapshot().stageTransitions.map((row) => row.stage)).not.toContain('board-ready-commit');
  expect(callbacks.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(JSON.stringify(snapshot())).toBe(terminal);
  expect(instance.current.getNodes).not.toHaveBeenCalled();
  expect(instance.current.fitView).not.toHaveBeenCalled();
});

it.each(['no position signal', 'unmeasured nodes', 'missing store nodes'])(
  'bounds observation with %s, even without another animation frame',
  (missing) => {
    window.history.replaceState({}, '', '/b/target/?debugLoad=1');
    beginInitialLoadDebug()!.configSettled();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { callbacks } = frameQueue();
    const { node, instance } = fixture(missing !== 'unmeasured nodes');
    if (missing === 'missing store nodes') vi.mocked(instance.current.getNodes).mockReturnValue([]);
    const view = renderHook(() => useInitialBoardReadiness(true, 'target', [node], instance));
    if (missing !== 'no position signal') view.result.current(200);
    act(() => vi.advanceTimersByTime(29_999));
    expect(snapshot().status).toBe('pending');
    act(() => vi.advanceTimersByTime(1));
    expect(snapshot().status).toBe('error');
    expect(snapshot().stageTransitions.map((row) => row.stage)).toContain(
      'board-readiness-timeout'
    );
    expect(callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(instance.current.fitView).not.toHaveBeenCalled();
  }
);

it.each(['discard', 'error', 'unmount', 'navigation', 'authority change'])(
  'cancels queued observation on %s without needing a frame',
  (cancel) => {
    window.history.replaceState({}, '', '/b/target/?debugLoad=1');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { callbacks } = frameQueue();
    const { node, instance } = fixture();
    const view = renderHook(
      ({ path, user }) => {
        useInitialLoadOwner(path, true, user, 1);
        return useInitialBoardReadiness(true, path, [node], instance);
      },
      { initialProps: { path: '/b/target/', user: 'owner' } }
    );
    act(() => vi.advanceTimersByTime(0)); // Flush jsdom’s URL/storage housekeeping.
    expect(callbacks.size).toBe(1);
    if (cancel === 'unmount') view.unmount();
    else if (cancel === 'navigation') view.rerender({ path: '/b/other/', user: 'owner' });
    else if (cancel === 'authority change') view.rerender({ path: '/b/target/', user: 'other' });
    else if (cancel === 'error') getInitialLoadDebugTimer()!.finish('error');
    else getInitialLoadDebugTimer()!.discard();
    expect(snapshot().status).toBe(cancel === 'error' ? 'error' : 'discarded');
    expect(callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  }
);

it.each(['success', 'discard', 'unmount'])('empty board paint opportunity: %s', (outcome) => {
  window.history.replaceState({}, '', '/b/target/?debugLoad=1');
  const timer = beginInitialLoadDebug()!;
  timer.configSettled();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { frame, callbacks } = frameQueue();
  const { instance } = fixture();
  vi.mocked(instance.current.getNodes).mockReturnValue([]);
  const view = renderHook(() => useInitialBoardReadiness(true, 'target', [], instance));
  frame(); // ready commit, paint is still queued
  expect(snapshot().status).toBe('pending');
  if (outcome === 'success') {
    frame();
    frame();
  } else if (outcome === 'discard') timer.discard();
  else view.unmount();
  expect(snapshot().status).toBe(
    outcome === 'unmount' ? 'pending' : outcome === 'success' ? 'success' : 'discarded'
  );
  expect(callbacks.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(instance.current.fitView).not.toHaveBeenCalled();
});

it('debug off schedules no observer or deadline and does not position', () => {
  window.history.replaceState({}, '', '/b/target/?debugLoad=0');
  expect(beginInitialLoadDebug()).toBeNull();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { callbacks } = frameQueue();
  const { node, instance } = fixture();
  const view = renderHook(() => useInitialBoardReadiness(true, 'target', [node], instance));
  view.result.current(200);
  view.result.current(0, false);
  expect(callbacks.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(instance.current.getNodes).not.toHaveBeenCalled();
  expect(instance.current.fitView).not.toHaveBeenCalled();
  expect(snapshot()).toBeUndefined();
});
