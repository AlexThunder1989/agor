import type { AgorClient, Branch, Session } from '@agor-live/client';
import { PAGINATION } from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DataMaps } from '../store/agorMaps';
import { agorStore, useAgorStore } from '../store/agorStore';
import { captureLoadLifetime } from '../store/loadLifetime';
import { sessionListQuery } from '../store/sessionListQuery';
import {
  type FillRows,
  fillOnDemand,
  MAX_REFERENCE_READ_ATTEMPTS,
  referenceRetryDelayMs,
  rowsOf,
} from '../store/userScope';
import { usePinnedRows } from './usePinnedRows';

type EnsureKind = 'sessions' | 'branches';

const ENSURE: Record<
  EnsureKind,
  {
    has: (maps: DataMaps, id: string) => boolean;
    ids: (rows: FillRows) => string[];
    read: (client: AgorClient, chunk: string[]) => Promise<FillRows>;
  }
> = {
  sessions: {
    has: (maps, id) => maps.sessionById.has(id),
    ids: (rows) => (rows.sessions ?? []).map((session) => session.session_id),
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
    ids: (rows) => (rows.branches ?? []).map((branch) => branch.branch_id),
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
 * The read state of a missing id under one authority: `pending` while a read
 * (or its retry) is outstanding, `absent` once the server didn't return it
 * (or every attempt failed). A loaded id has no state, so one the store later
 * evicts is read again; neither does an id whose read was cancelled.
 */
interface EnsureState {
  authority: string;
  status: Map<string, 'pending' | 'absent'>;
  attempts: Map<string, number>;
  timers: Set<ReturnType<typeof setTimeout>>;
}

/**
 * Make sure the store holds the rows of `ids` that a view refers to without
 * global data: the ones it lacks are read by id (`$in`, in chunks of
 * `PAGINATION.MAX_ID_LIST`) once first paint settled, and filled with no
 * scope while their pins hold them (a reply after unmount inserts nothing).
 * Archived rows stay unloaded (a fill skips them). Driven by the ids the
 * store is missing: a pending id is not asked for again, an absent one
 * not again under this authority, a failed read retries with the user
 * scope's capped backoff up to `MAX_REFERENCE_READ_ATTEMPTS`, and an id the
 * store evicts after loading it is read again. With `debounceMs`, a burst of
 * id changes is read once it settles. The ids are pinned while the view is
 * mounted (`usePinnedRows`), so no eviction takes a row it displays.
 */
function useEnsureRows(
  kind: EnsureKind,
  client: AgorClient | null | undefined,
  ids: Iterable<string>,
  debounceMs = 0
): void {
  const key = [...new Set(ids)].filter(Boolean).sort().join(',');
  usePinnedRows({ [kind]: key ? key.split(',') : [] });
  const missing = useAgorStore(
    useCallback(
      (s: DataMaps) =>
        key
          ? key
              .split(',')
              .filter((id) => !ENSURE[kind].has(s, id))
              .join(',')
          : '',
      [kind, key]
    )
  );
  const firstPaintSettled = useAgorStore((s) => !s.loading);
  const authority = useAgorStore((s) => s.dataAuthority);
  const state = useRef<EnsureState | null>(null);
  // Bumped by a retry timer to read the ids it released.
  const [retries, setRetries] = useState(0);

  useEffect(
    () => () => {
      for (const timer of state.current?.timers ?? []) clearTimeout(timer);
    },
    []
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: retries is a re-read trigger
  useEffect(() => {
    if (!client || !missing || !firstPaintSettled || !authority) return;
    const run = () => {
      if (state.current?.authority !== authority) {
        for (const timer of state.current?.timers ?? []) clearTimeout(timer);
        state.current = { authority, status: new Map(), attempts: new Map(), timers: new Set() };
      }
      const run = state.current;
      const toRead = missing.split(',').filter((id) => !run.status.has(id));
      for (const id of toRead) run.status.set(id, 'pending');
      for (let i = 0; i < toRead.length; i += PAGINATION.MAX_ID_LIST) {
        const chunk = toRead.slice(i, i + PAGINATION.MAX_ID_LIST);
        fillOnDemand(() => ENSURE[kind].read(client, chunk))
          .then((rows) => {
            if (state.current !== run) return;
            if (!rows) {
              // Cancelled, not absent: release the ids and read them again
              // under the lifetime that replaced it, if there is one.
              for (const id of chunk) run.status.delete(id);
              if (captureLoadLifetime()) setRetries((n) => n + 1);
              return;
            }
            // Absent only when the server didn't return it: a returned row
            // the store lacks (unpinned meanwhile, or removed live) is not.
            const maps = agorStore.getState();
            const returned = new Set(ENSURE[kind].ids(rows));
            for (const id of chunk) {
              run.attempts.delete(id);
              if (ENSURE[kind].has(maps, id) || returned.has(id)) run.status.delete(id);
              else run.status.set(id, 'absent');
            }
          })
          .catch((err) => {
            if (state.current !== run) return;
            console.warn(`[ensure] ${kind} by id failed:`, err);
            const attempt = Math.max(...chunk.map((id) => (run.attempts.get(id) ?? 0) + 1));
            for (const id of chunk) run.attempts.set(id, attempt);
            if (attempt >= MAX_REFERENCE_READ_ATTEMPTS) {
              for (const id of chunk) run.status.set(id, 'absent');
              return;
            }
            const timer = setTimeout(() => {
              run.timers.delete(timer);
              for (const id of chunk) run.status.delete(id);
              setRetries((n) => n + 1);
            }, referenceRetryDelayMs(attempt));
            run.timers.add(timer);
          });
      }
    };
    if (!debounceMs) {
      run();
      return;
    }
    const timer = setTimeout(run, debounceMs);
    return () => clearTimeout(timer);
  }, [kind, client, missing, firstPaintSettled, authority, debounceMs, retries]);
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
