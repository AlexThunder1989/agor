import type { AgorClient, Branch, Session } from '@agor-live/client';
import { PAGINATION } from '@agor-live/client';
import { useEffect, useRef } from 'react';
import type { DataMaps } from '../store/agorMaps';
import { agorStore, useAgorStore } from '../store/agorStore';
import { sessionListQuery } from '../store/sessionListQuery';
import { type FillRows, fillOnDemand, rowsOf } from '../store/userScope';

type EnsureKind = 'sessions' | 'branches';

const ENSURE: Record<
  EnsureKind,
  {
    has: (maps: DataMaps, id: string) => boolean;
    read: (client: AgorClient, chunk: string[]) => Promise<FillRows>;
  }
> = {
  sessions: {
    has: (maps, id) => maps.sessionById.has(id),
    read: async (client, chunk) => ({
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
    }),
  },
  branches: {
    has: (maps, id) => maps.branchById.has(id),
    read: async (client, chunk) => ({
      branches: rowsOf<Branch>(
        await client.service('branches').find({
          query: { branch_id: { $in: chunk }, archived: false, $limit: chunk.length },
        })
      ),
    }),
  },
};

/**
 * Make sure the store holds the rows of `ids` that a view refers to without
 * global data: the ones it lacks are read by id (`$in`, in chunks of
 * `PAGINATION.MAX_ID_LIST`) once first paint settled, and filled with no
 * scope. Archived rows stay unloaded (a fill skips them). Each id is read at
 * most once per authority (again only after a failed read), so an absent id
 * is not asked for again; with `debounceMs`, a burst of id changes is read
 * once it settles.
 */
function useEnsureRows(
  kind: EnsureKind,
  client: AgorClient | null | undefined,
  ids: Iterable<string>,
  debounceMs = 0
): void {
  const key = [...new Set(ids)].filter(Boolean).sort().join(',');
  const firstPaintSettled = useAgorStore((s) => !s.loading);
  const authority = useAgorStore((s) => s.dataAuthority);
  const requested = useRef({ authority, ids: new Set<string>() });

  useEffect(() => {
    if (!client || !key || !firstPaintSettled || !authority) return;
    const run = () => {
      if (requested.current.authority !== authority) {
        requested.current = { authority, ids: new Set() };
      }
      const seen = requested.current.ids;
      const maps = agorStore.getState();
      const missing = key.split(',').filter((id) => !seen.has(id) && !ENSURE[kind].has(maps, id));
      for (const id of missing) seen.add(id);
      for (let i = 0; i < missing.length; i += PAGINATION.MAX_ID_LIST) {
        const chunk = missing.slice(i, i + PAGINATION.MAX_ID_LIST);
        fillOnDemand(() => ENSURE[kind].read(client, chunk)).catch((err) => {
          // A failed read may be asked for again.
          for (const id of chunk) seen.delete(id);
          console.warn(`[ensure] ${kind} by id failed:`, err);
        });
      }
    };
    if (!debounceMs) {
      run();
      return;
    }
    const timer = setTimeout(run, debounceMs);
    return () => clearTimeout(timer);
  }, [kind, client, key, firstPaintSettled, authority, debounceMs]);
}

/** `useEnsureRows` for sessions (`session_id $in`, lean rows). */
export const useEnsureSessions = (
  client: AgorClient | null | undefined,
  ids: Iterable<string>,
  debounceMs?: number
) => useEnsureRows('sessions', client, ids, debounceMs);

/** `useEnsureRows` for branches (`branch_id $in`). */
export const useEnsureBranches = (
  client: AgorClient | null | undefined,
  ids: Iterable<string>,
  debounceMs?: number
) => useEnsureRows('branches', client, ids, debounceMs);
