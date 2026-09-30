import { parseEntityPath } from './entityPath';

const DEBUG_INITIAL_LOAD_STORAGE_KEY = 'agor.debug.initialLoad';

export interface InitialLoadDebugItem {
  key: string;
  label: string;
}

export interface InitialLoadDebugFetchTiming {
  key: string;
  label: string;
  startMs: number | null;
  endMs: number | null;
  durationMs: number | null;
  count: number | null;
  status: 'queued' | 'pending' | 'success' | 'error' | 'skipped' | 'not-started' | 'abandoned';
}

export interface InitialLoadDebugStageTransition {
  stage: string;
  atMs: number;
}

export interface InitialLoadDebugTimings {
  label: string;
  startedAt: string;
  navigationToStartMs: number;
  totalMs: number;
  fetchPhaseMs: number | null;
  indexingMs: number | null;
  status: 'pending' | 'success' | 'error' | 'discarded' | 'unsupported';
  fetches: InitialLoadDebugFetchTiming[];
  stageTransitions: InitialLoadDebugStageTransition[];
}

type DebugWindow = Window & {
  __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings;
};

function getWindow(): DebugWindow | null {
  return typeof window === 'undefined' ? null : (window as DebugWindow);
}

function getNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}

export function syncInitialLoadDebugFlagFromUrl(win = getWindow()): boolean {
  if (!win) return false;

  let value: string | null = null;
  try {
    value = new URLSearchParams(win.location.search).get('debugLoad');
  } catch {
    value = null;
  }

  try {
    if (value === '1') {
      win.localStorage.setItem(DEBUG_INITIAL_LOAD_STORAGE_KEY, '1');
    } else if (value === '0') {
      win.localStorage.removeItem(DEBUG_INITIAL_LOAD_STORAGE_KEY);
    }

    return win.localStorage.getItem(DEBUG_INITIAL_LOAD_STORAGE_KEY) === '1';
  } catch {
    return value === '1';
  }
}

export function isInitialLoadDebugEnabled(): boolean {
  return syncInitialLoadDebugFlagFromUrl();
}

// One bounded, in-memory startup snapshot. No Performance entries, request bodies,
// IDs, URLs, error messages, or persistent metrics. Promise tracking never cancels
// application work; discard only fences diagnostic continuations.
export type InitialLoadDebugTimer = ReturnType<typeof createInitialLoadDebugTimer>;
let activeTimer: InitialLoadDebugTimer | null = null;

export function getInitialLoadDebugTimer() {
  return activeTimer;
}

export function beginInitialLoadDebug() {
  activeTimer?.discard();
  const pathname = getWindow()?.location.pathname ?? '';
  const routePath = pathname.replace(/^\/ui(?=\/|$)/, '') || '/';
  const entity = /^\/[^/]+\/[^/]+\/?$/.test(routePath) ? parseEntityPath(routePath) : null;
  const target =
    routePath === '/'
      ? 'home'
      : /^\/(?:ui\/)?m(?:\/|$)/.test(pathname)
        ? null
        : entity?.kind === 'session'
          ? 'conversation'
          : entity?.kind === 'board' || entity?.kind === 'branch'
            ? 'board'
            : null;
  activeTimer = isInitialLoadDebugEnabled()
    ? createInitialLoadDebugTimer([], target ?? undefined, entity?.token)
    : null;
  if (activeTimer && !target) {
    activeTimer.markStage('unsupported-route');
    activeTimer.finish('unsupported');
  }
  return activeTimer;
}

export function createInitialLoadDebugTimer(
  items: readonly InitialLoadDebugItem[],
  target?: 'home' | 'board' | 'conversation',
  targetToken?: string
) {
  const start = getNow();
  const timings: InitialLoadDebugTimings = {
    label: 'Agor initial load',
    startedAt: new Date().toISOString(),
    // performance.now is relative to navigation in browsers. This explicitly
    // exposes time BEFORE App mounted, rather than calling data-fetch time E2E.
    navigationToStartMs: roundMs(start),
    totalMs: 0,
    fetchPhaseMs: null,
    indexingMs: null,
    status: 'pending',
    fetches: [],
    stageTransitions: [],
  };
  let closed = false;
  const settlementListeners = new Set<() => void>();
  let configReady = false;
  let surfaceReady = false;
  let fetchStart: number | null = null;
  let indexingStart: number | null = null;
  const elapsed = () => roundMs(getNow() - start);
  const publish = () => {
    if (closed) return;
    timings.totalMs = elapsed();
    const win = getWindow();
    if (win) win.__AGOR_INITIAL_LOAD_TIMINGS__ = timings;
  };
  const queue = (entries: readonly InitialLoadDebugItem[]) => {
    if (closed) return;
    for (const item of entries) {
      if (timings.fetches.length >= 32 || timings.fetches.some((row) => row.key === item.key))
        continue;
      timings.fetches.push({
        ...item,
        startMs: null,
        endMs: null,
        durationMs: null,
        count: null,
        status: 'queued',
      });
    }
    publish();
  };
  const markStage = (stage: string) => {
    if (
      closed ||
      timings.stageTransitions.length >= 64 ||
      timings.stageTransitions.some((row) => row.stage === stage)
    )
      return;
    timings.stageTransitions.push({ stage, atMs: elapsed() });
    publish();
  };
  const settle = (status: 'success' | 'error' | 'discarded' | 'unsupported') => {
    if (closed) return timings;
    for (const row of timings.fetches) {
      if (row.status === 'queued') row.status = 'not-started';
      else if (row.status === 'pending') {
        row.status = 'abandoned';
        row.endMs = elapsed();
        row.durationMs = roundMs(row.endMs - row.startMs!);
      }
    }
    timings.status = status;
    publish();
    closed = true;
    if (activeTimer === timer) activeTimer = null;
    for (const listener of settlementListeners) listener();
    settlementListeners.clear();
    return timings;
  };
  const timer = {
    queue,
    markStage,
    onSettled(listener: () => void) {
      if (closed) listener();
      else settlementListeners.add(listener);
      return () => {
        settlementListeners.delete(listener);
      };
    },
    surfaceReady(surface: 'home' | 'board' | 'conversation') {
      markStage(`${surface}-paint-opportunity`);
      if (surface === target) surfaceReady = true;
      if (surfaceReady && configReady) timer.finish('success');
    },
    configSettled() {
      configReady = true;
      markStage('auth-config-ready');
      if (surfaceReady) timer.finish('success');
    },
    observeConversation(sessionId: string) {
      if (target !== 'conversation') return;
      // Compare the resolved identity, not component/client lifetimes. Tokens
      // may be short or full UUIDs; never publish either in the diagnostic.
      if (
        targetToken &&
        !sessionId.replaceAll('-', '').startsWith(targetToken.replaceAll('-', ''))
      ) {
        timer.discard();
      } else {
        markStage('conversation-view-mounted');
      }
    },
    surfaceFailed(surface: 'home' | 'board' | 'conversation', stage = `${surface}-error`) {
      if (surface !== target) return;
      markStage(stage);
      timer.finish('error');
    },
    skip(key: string) {
      if (closed) return;
      const row = timings.fetches.find((row) => row.key === key);
      if (row?.status === 'queued') row.status = 'skipped';
      publish();
    },
    startFetchPhase() {
      if (!closed) fetchStart = getNow();
    },
    endFetchPhase() {
      if (!closed && fetchStart !== null) timings.fetchPhaseMs = roundMs(getNow() - fetchStart);
      publish();
    },
    startIndexing() {
      if (!closed) indexingStart = getNow();
    },
    endIndexing() {
      if (!closed && indexingStart !== null) timings.indexingMs = roundMs(getNow() - indexingStart);
      publish();
    },
    track<T>(key: string, request: () => Promise<T>): Promise<T> {
      queue([{ key, label: key }]);
      const row = closed
        ? undefined
        : timings.fetches.find((row) => row.key === key && row.status === 'queued');
      if (row) {
        row.startMs = elapsed();
        row.status = 'pending';
        publish();
      }
      const end = (status: 'success' | 'error', result?: T) => {
        if (closed || !row) return;
        row.endMs = elapsed();
        row.durationMs = roundMs(row.endMs - row.startMs!);
        row.status = status;
        row.count =
          status === 'success'
            ? Array.isArray(result)
              ? result.length
              : result == null
                ? 0
                : 1
            : null;
        publish();
      };
      // Start immediately, preserving the caller's existing scheduling, including
      // synchronous throws. Rejections propagate unchanged without copying errors.
      try {
        return request().then(
          (result) => {
            end('success', result);
            return result;
          },
          (error) => {
            end('error');
            throw error;
          }
        );
      } catch (error) {
        end('error');
        throw error;
      }
    },
    discard() {
      return settle('discarded');
    },
    finish(status: 'success' | 'error' | 'unsupported'): InitialLoadDebugTimings {
      if (closed) return timings;
      settle(status);
      console.groupCollapsed?.('[Agor initial load]', { status, totalMs: timings.totalMs });
      console.table?.(timings.fetches);
      console.log('Copy from window.__AGOR_INITIAL_LOAD_TIMINGS__', timings);
      console.groupEnd?.();
      return timings;
    },
  };
  queue(items);
  return timer;
}

/** Two animation frames are only a paint OPPORTUNITY, never proof of paint. */
export function afterInitialLoadPaintOpportunity(callback: () => void): () => void {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(callback);
  });
  return () => cancelAnimationFrame(frame);
}
