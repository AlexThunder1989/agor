import { useEffect, useLayoutEffect, useRef } from 'react';
import { beginInitialLoadDebug, getInitialLoadDebugTimer } from '../utils/initialLoadDebug';

/** App-owned cold-start lifetime; independent of rendering and socket availability. */
export function useInitialLoadOwner(
  pathname: string,
  authenticated: boolean,
  userId: string | undefined,
  authenticationGeneration: number
) {
  const startupPath = useRef(pathname);
  useLayoutEffect(() => {
    const timer = beginInitialLoadDebug();
    timer?.markStage('app-mounted');
    return () => {
      timer?.discard();
    };
  }, []);
  useLayoutEffect(() => {
    // This is a cold-start trace, not a navigation or reconnect tracer.
    if (pathname !== startupPath.current) getInitialLoadDebugTimer()?.discard();
  }, [pathname]);
  // Bind diagnostics to the first authenticated owner even before the socket
  // can start useAgorData. Its request-scope cleanup handles later transitions.
  const startupAuthority = useRef<{ userId: string; generation: number } | null>(null);
  useLayoutEffect(() => {
    const previous = startupAuthority.current;
    if (
      previous &&
      (!authenticated ||
        previous.userId !== userId ||
        previous.generation !== authenticationGeneration)
    ) {
      getInitialLoadDebugTimer()?.discard();
    }
    if (authenticated && userId)
      startupAuthority.current = { userId: userId, generation: authenticationGeneration };
  }, [authenticated, userId, authenticationGeneration]);
}

/** Passive observations of App's existing gates, never a rendering gate. */
export function useInitialLoadGates({
  workspaceSurfaceShouldRun,
  authConfigError,
  authError,
  connectionError,
  dataError,
  authConfigLoading,
  authLoading,
  authenticated,
  connected,
  connecting,
  routeModuleReady,
  loaderPhase,
}: {
  workspaceSurfaceShouldRun: boolean;
  authConfigError: unknown;
  authError: unknown;
  connectionError: unknown;
  dataError: unknown;
  authConfigLoading: boolean;
  authLoading: boolean;
  authenticated: boolean;
  connected: boolean;
  connecting: boolean;
  routeModuleReady: boolean;
  loaderPhase: string;
}) {
  useEffect(() => {
    const timer = getInitialLoadDebugTimer();
    if (!timer) return;
    if (!workspaceSurfaceShouldRun) {
      timer.markStage('unsupported-surface');
      timer.finish('unsupported');
      return;
    }
    if (authConfigError || authError || connectionError || dataError) {
      timer.markStage('startup-gate-error');
      timer.finish('error');
      return;
    }
    if (!authConfigLoading) timer.configSettled();
    if (!authLoading && authenticated) timer.markStage('authenticated');
    if (connected && !connecting) timer.markStage('socket-ready');
    if (routeModuleReady) timer.markStage('route-module-ready');
    timer.markStage(`loader-${loaderPhase}`);
  }, [
    workspaceSurfaceShouldRun,
    authConfigError,
    authError,
    connectionError,
    dataError,
    authConfigLoading,
    authLoading,
    authenticated,
    connected,
    connecting,
    routeModuleReady,
    loaderPhase,
  ]);
}
