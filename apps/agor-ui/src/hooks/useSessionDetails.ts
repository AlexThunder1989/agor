import { type AgorClient, isLeanSession, type Session } from '@agor-live/client';
import { useEffect } from 'react';
import { sessionDetailsLoaded } from '../store/agorRealtimeActions';

/**
 * Session lists load lean (heavy `custom_context` keys such as slash commands,
 * skills, and the scheduled-run snapshot are withheld). An open session needs
 * them, so fetch its full row once per lean version and fill the store entry.
 *
 * Keyed on `last_updated`: if a newer lean row replaces the restored one, the
 * effect re-runs and fetches that version. A fetched row of a different version
 * changes nothing; the realtime `patched` event for that write delivers the
 * full row itself. Failures leave the lean row in place (no autocomplete
 * entries) and retry on the next version or reopen.
 */
export function useSessionDetails(
  client: AgorClient | null,
  session:
    | Pick<Session, 'session_id' | 'last_updated' | 'custom_context_omitted'>
    | null
    | undefined
): void {
  const sessionId = session?.session_id;
  const version = session?.last_updated;
  const lean = !!session && isLeanSession(session);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the re-fetch key for a newer lean row
  useEffect(() => {
    if (!client || !sessionId || !lean) return;
    // Drop a response once the panel moved on. The store write itself only
    // fills a lean row with this exact id and version (see `sessionDetailsLoaded`).
    let active = true;
    client
      .service('sessions')
      .get(sessionId)
      .then((full) => {
        if (active) sessionDetailsLoaded(full as Session);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [client, sessionId, version, lean]);
}
