import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { __resetAuthConfigForTests, useAuthConfig } from './hooks/useAuthConfig';
import { useInitialLoadGates, useInitialLoadOwner } from './hooks/useInitialLoadObserver';
import { useInitialLoadReadiness } from './hooks/useInitialLoadReadiness';
import { getInitialLoadDebugTimer, type InitialLoadDebugTimings } from './utils/initialLoadDebug';

const originalUrl = window.location.href;
const snapshot = () =>
  (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
    .__AGOR_INITIAL_LOAD_TIMINGS__!;
let releaseHealth: (response: Response) => void;

// Production App observers + the real independently resolving health hook.
// No copied gate effect, and no synthetic call to configSettled in this suite.
function AppComposition({
  path = '/',
  userId = 'owner',
  generation = 1,
  connected = true,
  error = false,
  sessionId,
  active = true,
  client = {},
  showSurface = true,
}: {
  path?: string;
  userId?: string;
  generation?: number;
  connected?: boolean;
  error?: boolean;
  sessionId?: string;
  active?: boolean;
  client?: object;
  showSurface?: boolean;
}) {
  const config = useAuthConfig();
  useInitialLoadOwner(path, true, userId, generation);
  useInitialLoadGates({
    workspaceSurfaceShouldRun: true,
    authConfigError: config.error,
    authError: null,
    connectionError: error,
    dataError: null,
    authConfigLoading: config.loading,
    authLoading: false,
    authenticated: true,
    connected,
    connecting: !connected,
    routeModuleReady: true,
    loaderPhase: 'hidden',
  });
  // Keep the test surface mounted to exercise either observer ordering.
  // Production App retains its existing authConfigLoading render gate.
  if (config.error) return <div>Configuration error</div>;
  return showSurface ? <Surface sessionId={sessionId} active={active} client={client} /> : null;
}
function Surface({
  sessionId,
  active,
  client,
}: {
  sessionId?: string;
  active: boolean;
  client: object;
}) {
  useInitialLoadReadiness(
    sessionId ? 'conversation' : 'home',
    active,
    false,
    active && client ? sessionId : undefined
  );
  return <div>Usable content</div>;
}
beforeEach(() => {
  __resetAuthConfigForTests();
  window.history.replaceState({}, '', '/?debugLoad=1');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseHealth = resolve;
        })
    )
  );
});
afterEach(() => {
  cleanup();
  getInitialLoadDebugTimer()?.discard();
  localStorage.clear();
  window.history.replaceState({}, '', originalUrl);
  delete (window as Window & { __AGOR_INITIAL_LOAD_TIMINGS__?: InitialLoadDebugTimings })
    .__AGOR_INITIAL_LOAD_TIMINGS__;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function surfaceReached(surface = 'home') {
  await waitFor(() =>
    expect(
      snapshot().stageTransitions.some((s) => s.stage === `${surface}-paint-opportunity`)
    ).toBe(true)
  );
  expect(screen.getByText('Usable content')).not.toBeNull();
  expect(snapshot().status).toBe('pending');
}
async function health(status = 200) {
  await act(async () =>
    releaseHealth(new Response(JSON.stringify({ auth: { requireAuth: true } }), { status }))
  );
}
it.each([200, 503])(
  'waits for health %s after the surface milestone without gating content',
  async (status) => {
    render(<AppComposition />);
    await surfaceReached();
    await health(status);
    expect(snapshot().status).toBe(status === 200 ? 'success' : 'error');
    if (status === 503) {
      expect(screen.getByText('Configuration error')).not.toBeNull();
      expect(snapshot().stageTransitions.at(-1)?.stage).toBe('startup-gate-error');
    }
  }
);
it('discards navigation while config is pending and ignores late settlement', async () => {
  const view = render(<AppComposition />);
  await surfaceReached();
  view.rerender(<AppComposition path="/b/other/" />);
  expect(snapshot().status).toBe('discarded');
  const frozen = JSON.stringify(snapshot());
  await health();
  expect(JSON.stringify(snapshot())).toBe(frozen);
});
it.each([
  { userId: 'other', generation: 1 },
  { userId: 'owner', generation: 2 },
])('discards authority replacement before socket readiness: %j', async (next) => {
  const view = render(<AppComposition connected={false} showSurface={false} />);
  view.rerender(<AppComposition {...next} connected={false} showSurface={false} />);
  expect(snapshot().status).toBe('discarded');
  await health();
  expect(snapshot().status).toBe('discarded');
});
it('records startup-gate-error', () => {
  render(<AppComposition error />);
  expect(snapshot().status).toBe('error');
  expect(snapshot().stageTransitions.at(-1)?.stage).toBe('startup-gate-error');
});
it('survives StrictMode, client/active churn and a harmless transcript remount; rejects another session', async () => {
  window.history.replaceState({}, '', '/s/12345678/?debugLoad=1');
  const content = (props: Partial<Parameters<typeof AppComposition>[0]> = {}) => (
    <StrictMode>
      <AppComposition sessionId="12345678-full" {...props} />
    </StrictMode>
  );
  const view = render(content());
  await surfaceReached('conversation');
  view.rerender(content({ active: false, client: {} }));
  view.rerender(content({ showSurface: false }));
  view.rerender(content({ client: {} }));
  expect(snapshot().status).toBe('pending');
  view.rerender(content({ sessionId: '87654321-replacement' }));
  expect(snapshot().status).toBe('discarded');
  await health();
  expect(snapshot().status).toBe('discarded');
});
