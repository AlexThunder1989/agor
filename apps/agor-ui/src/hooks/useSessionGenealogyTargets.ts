import type { AgorClient, Session } from '@agor-live/client';
import { PAGINATION } from '@agor-live/client';
import { useEffect } from 'react';
import { agorStore, useAgorStore } from '../store/agorStore';
import { sessionListQuery } from '../store/sessionListQuery';
import { fillOnDemand, rowsOf } from '../store/userScope';

/** The sessions `session` links to: parent, fork source, callback and remote-create ends, children. */
function genealogyTargetIds(session: Session | null | undefined): string[] {
  if (!session) return [];
  const ids = new Set<string>([
    ...(session.genealogy?.children ?? []),
    session.genealogy?.parent_session_id ?? '',
    session.genealogy?.forked_from_session_id ?? '',
    session.callback_config?.callback_session_id ?? '',
  ]);
  for (const relationship of session.remote_relationships?.as_target ?? []) {
    ids.add(relationship.source_session_id);
    ids.add(relationship.callback_session_id ?? '');
  }
  for (const relationship of session.remote_relationships?.as_source ?? []) {
    ids.add(relationship.target_session_id);
  }
  ids.delete('');
  ids.delete(session.session_id);
  return [...ids].sort();
}

/**
 * Resolve an opened session's genealogy links without global data: the
 * linked sessions the store lacks are read by id (`session_id $in`, in chunks
 * of `PAGINATION.MAX_ID_LIST`) once first paint settled, and filled with no
 * scope. Archived targets stay unloaded (a fill skips them). Re-reads only when
 * the set of linked ids changes, never on a patch of the session itself.
 */
export function useSessionGenealogyTargets(
  client: AgorClient | null | undefined,
  session: Session | null | undefined
): void {
  const ids = genealogyTargetIds(session).join(',');
  const firstPaintSettled = useAgorStore((s) => !s.loading);
  const authority = useAgorStore((s) => s.dataAuthority);

  useEffect(() => {
    if (!client || !ids || !firstPaintSettled || !authority) return;
    const { sessionById } = agorStore.getState();
    const missing = ids.split(',').filter((id) => !sessionById.has(id));
    for (let i = 0; i < missing.length; i += PAGINATION.MAX_ID_LIST) {
      const chunk = missing.slice(i, i + PAGINATION.MAX_ID_LIST);
      fillOnDemand(async () => ({
        sessions: rowsOf<Session>(
          await client.service('sessions').find({
            query: sessionListQuery({
              session_id: { $in: chunk },
              archived: false,
              $limit: chunk.length,
              $count: false,
            }),
          })
        ),
      })).catch((err) => console.warn('[genealogy] linked sessions failed:', err));
    }
  }, [client, ids, firstPaintSettled, authority]);
}
