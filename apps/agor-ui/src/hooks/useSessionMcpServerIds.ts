import type { AgorClient } from '@agor-live/client';
import { useEffect, useMemo } from 'react';
import { useAgorStore } from '../store/agorStore';
import { makeSessionMcpServerIdsSelector } from '../store/selectors';
import { loadSessionMcpServerIds } from '../store/sessionMcpLinks';

// Stable sentinel for the common no-MCP case, so `React.memo` consumers
// (SessionPanel) keep their bailout.
const EMPTY_IDS: string[] = Object.freeze([] as string[]) as string[];

/**
 * One session's attached MCP server ids, loaded on first need. `loaded` is
 * false until this session's links have been read in the current authority
 * lifetime; until then `ids` may be partial (realtime events only), so edit
 * controls must stay disabled (see `sessionMcpLinks`).
 */
export function useSessionMcpServerIds(
  client: AgorClient | null | undefined,
  sessionId: string | null | undefined
): { ids: string[]; loaded: boolean } {
  const ids =
    useAgorStore(useMemo(() => makeSessionMcpServerIdsSelector(sessionId), [sessionId])) ??
    EMPTY_IDS;
  const loaded = useAgorStore((s) => (sessionId ? s.sessionMcpLoaded.has(sessionId) : false));
  // Loads capture the realtime authority, which exists once first paint ran.
  const firstPaintSettled = useAgorStore((s) => !s.loading);

  useEffect(() => {
    if (!client || !sessionId || loaded || !firstPaintSettled) return;
    void loadSessionMcpServerIds(client, sessionId);
  }, [client, sessionId, loaded, firstPaintSettled]);

  return { ids, loaded };
}
