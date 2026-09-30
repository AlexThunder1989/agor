import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginInitialLoadDebug,
  createInitialLoadDebugTimer,
  getInitialLoadDebugTimer,
  type InitialLoadDebugTimings,
  isInitialLoadDebugEnabled,
  syncInitialLoadDebugFlagFromUrl,
} from './initialLoadDebug';

const originalUrl = window.location.href;

afterEach(() => {
  getInitialLoadDebugTimer()?.discard();
  window.history.replaceState({}, '', originalUrl);
  window.localStorage.clear();
  delete (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
    .__AGOR_INITIAL_LOAD_TIMINGS__;
  vi.restoreAllMocks();
});

describe('initial load debug flag', () => {
  it('persists when debugLoad=1 is present', () => {
    window.history.replaceState({}, '', '/?debugLoad=1');

    expect(syncInitialLoadDebugFlagFromUrl()).toBe(true);
    expect(window.localStorage.getItem('agor.debug.initialLoad')).toBe('1');
  });

  it('removes the persisted flag when debugLoad=0 is present', () => {
    window.localStorage.setItem('agor.debug.initialLoad', '1');
    window.history.replaceState({}, '', '/?debugLoad=0');

    expect(syncInitialLoadDebugFlagFromUrl()).toBe(false);
    expect(window.localStorage.getItem('agor.debug.initialLoad')).toBeNull();
  });

  it('uses the persisted flag when the URL has no override', () => {
    window.localStorage.setItem('agor.debug.initialLoad', '1');
    window.history.replaceState({}, '', '/boards');

    expect(isInitialLoadDebugEnabled()).toBe(true);
  });
});

describe('initial load debug timer', () => {
  it('captures fetch status, counts, stage transitions, and exposes the latest payload', async () => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'table').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);

    const timer = createInitialLoadDebugTimer([{ key: 'sessions', label: 'Sessions' }]);
    timer.markStage('fetching');
    timer.startFetchPhase();
    await timer.track('sessions', () => Promise.resolve([{}, {}]));
    timer.endFetchPhase();
    timer.markStage('indexing');
    timer.startIndexing();
    timer.endIndexing();
    timer.markStage('idle');

    const timings = timer.finish('success');

    expect(timings.status).toBe('success');
    expect(timings.fetches).toMatchObject([
      { key: 'sessions', label: 'Sessions', count: 2, status: 'success' },
    ]);
    expect(timings.stageTransitions.map((transition) => transition.stage)).toEqual([
      'fetching',
      'indexing',
      'idle',
    ]);
    expect(
      (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
        .__AGOR_INITIAL_LOAD_TIMINGS__
    ).toBe(timings);
  });

  it('records fetch errors without swallowing them', async () => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => undefined);
    vi.spyOn(console, 'table').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'groupEnd').mockImplementation(() => undefined);

    const timer = createInitialLoadDebugTimer([{ key: 'branches', label: 'Branches' }]);

    await expect(timer.track('branches', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom'
    );

    const timings = timer.finish('error');
    expect(timings).toMatchObject({ status: 'error' });
    expect(timings.fetches).toMatchObject([
      { key: 'branches', label: 'Branches', count: null, status: 'error' },
    ]);
  });
});

describe('startup lifecycle', () => {
  it.each(['success', 'error', 'discarded'] as const)(
    'notifies observer cleanup once on %s, including late subscribers',
    (status) => {
      const timer = createInitialLoadDebugTimer([]);
      const removed = vi.fn();
      timer.onSettled(removed)();
      const cleanup = vi.fn();
      timer.onSettled(cleanup);
      if (status === 'discarded') timer.discard();
      else timer.finish(status);
      timer.discard();
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(removed).not.toHaveBeenCalled();
      const late = vi.fn();
      timer.onSettled(late);
      expect(late).toHaveBeenCalledTimes(1);
    }
  );

  it('distinguishes queued, pending, skipped and failed work; redacts errors', async () => {
    const timer = createInitialLoadDebugTimer([
      { key: 'light', label: 'Light' },
      { key: 'heavy', label: 'Heavy' },
      { key: 'optional', label: 'Optional' },
      { key: 'failed', label: 'Failed' },
    ]);
    let resolve!: (rows: unknown[]) => void;
    const pending = timer.track(
      'light',
      () =>
        new Promise<unknown[]>((r) => {
          resolve = r;
        })
    );
    const snapshot = () =>
      (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
        .__AGOR_INITIAL_LOAD_TIMINGS__!;
    expect(snapshot().fetches.map((row) => row.status)).toEqual([
      'pending',
      'queued',
      'queued',
      'queued',
    ]);
    expect(snapshot().fetches[0].startMs).not.toBeNull();
    expect(snapshot().fetches[1].startMs).toBeNull();
    timer.skip('optional');
    await expect(
      timer.track('failed', () => Promise.reject(new Error('SECRET user-content')))
    ).rejects.toThrow('SECRET');
    const result = timer.finish('error');
    expect(result.fetches.map((row) => row.status)).toEqual([
      'abandoned',
      'not-started',
      'skipped',
      'error',
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SECRET');
    resolve([{}]);
    await pending;
    timer.markStage('late');
    expect(JSON.stringify(result)).toBe(serialized);
  });

  it('separates frame wait from synchronous index work', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const timer = createInitialLoadDebugTimer([]);
    timer.markStage('index-frame-wait-start');
    now = 40;
    timer.markStage('index-frame-wait-end');
    timer.startIndexing();
    now = 45;
    timer.endIndexing();
    const result = timer.finish('success');
    expect(result.indexingMs).toBe(5);
    expect(result.stageTransitions).toEqual([
      { stage: 'index-frame-wait-start', atMs: 0 },
      { stage: 'index-frame-wait-end', atMs: 40 },
    ]);
  });

  it('keeps data readiness distinct from conversation readiness and paint proxy', () => {
    const timer = createInitialLoadDebugTimer([], 'conversation');
    timer.configSettled();
    timer.markStage('data-ready');
    timer.surfaceReady('board');
    timer.markStage('conversation-ready-commit');
    const snapshot = (
      window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings }
    ).__AGOR_INITIAL_LOAD_TIMINGS__!;
    expect(snapshot.status).toBe('pending');
    timer.surfaceReady('conversation');
    expect(snapshot.status).toBe('success');
    expect(snapshot.stageTransitions.map((row) => row.stage)).toEqual([
      'auth-config-ready',
      'data-ready',
      'board-paint-opportunity',
      'conversation-ready-commit',
      'conversation-paint-opportunity',
    ]);
  });

  it('bounds snapshots and ignores discarded completions', async () => {
    const timer = createInitialLoadDebugTimer([]);
    for (let i = 0; i < 100; i++) {
      timer.queue([{ key: `key${i}`, label: 'bounded' }]);
      timer.markStage(`stage${i}`);
    }
    let resolve!: () => void;
    const pending = timer.track(
      'key0',
      () =>
        new Promise<void>((r) => {
          resolve = r;
        })
    );
    const snapshot = timer.discard();
    const copy = JSON.stringify(snapshot);
    resolve();
    await pending;
    expect(JSON.stringify(snapshot)).toBe(copy);
    expect(snapshot.fetches).toHaveLength(32);
    expect(snapshot.stageTransitions).toHaveLength(64);
    expect(snapshot.status).toBe('discarded');
  });
});

it.each([
  '/a/artifact/',
  '/settings/',
  '/m/board/board/',
  '/m/session/session/',
  '/ui/m/board/board/',
  '/settings/b/board/',
  '/b/board/extra/',
])('settles unsupported route %s explicitly', (path) => {
  window.history.replaceState({}, '', `${path}?debugLoad=1`);
  expect(beginInitialLoadDebug()).toBeNull();
  expect(
    (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
      .__AGOR_INITIAL_LOAD_TIMINGS__
  ).toMatchObject({ status: 'unsupported', stageTransitions: [{ stage: 'unsupported-route' }] });
});
