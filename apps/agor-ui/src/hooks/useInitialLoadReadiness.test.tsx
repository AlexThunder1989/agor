import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  beginInitialLoadDebug,
  getInitialLoadDebugTimer,
  type InitialLoadDebugTimings,
} from '../utils/initialLoadDebug';
import { useInitialLoadReadiness } from './useInitialLoadReadiness';

const snapshot = () =>
  (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
    .__AGOR_INITIAL_LOAD_TIMINGS__;
afterEach(() => {
  getInitialLoadDebugTimer()?.discard();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  delete (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
    .__AGOR_INITIAL_LOAD_TIMINGS__;
  vi.restoreAllMocks();
});

it('does nothing with debug off', () => {
  expect(beginInitialLoadDebug()).toBeNull();
  const raf = vi.spyOn(window, 'requestAnimationFrame');
  renderHook(() => useInitialLoadReadiness('home', true));
  expect(raf).not.toHaveBeenCalled();
  expect(snapshot()).toBeUndefined();
});

it('marks a commit before, not as, the two-frame paint opportunity and cancels on unmount', () => {
  window.history.replaceState({}, '', '/s/test/?debugLoad=1');
  beginInitialLoadDebug();
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    callbacks.set(++id, cb);
    return id;
  });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    callbacks.delete(id);
  });
  const { rerender, unmount } = renderHook(
    ({ ready }) => useInitialLoadReadiness('conversation', ready),
    { initialProps: { ready: false } }
  );
  expect(snapshot()?.stageTransitions).toEqual([]);
  rerender({ ready: true });
  expect(snapshot()?.stageTransitions.map((row) => row.stage)).toEqual([
    'conversation-ready-commit',
  ]);
  act(() => callbacks.get(1)!(0));
  expect(snapshot()?.status).toBe('pending');
  unmount();
  expect(cancel).toHaveBeenCalledWith(2);
  expect(callbacks.has(2)).toBe(false);
  expect(snapshot()?.status).toBe('pending'); // owner cleanup discards, not a false success
});

it('settles a transcript failure without exporting the error or claiming readiness', () => {
  window.history.replaceState({}, '', '/s/test/?debugLoad=1');
  beginInitialLoadDebug();
  renderHook(() => useInitialLoadReadiness('conversation', false, true));
  expect(snapshot()?.status).toBe('error');
  expect(snapshot()?.stageTransitions.map((row) => row.stage)).toEqual(['conversation-error']);
});
