import type { AgorClient, Branch } from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';
import { rowsOf } from '@/store/userScope';
import { useServerRead } from '../../hooks/useServerRead';

type Listener = (row: Branch) => void;
type Page = { rows: Branch[]; total: number };

const NO_PAGE: Page = { rows: [], total: 0 };

/**
 * One page of `branches.find(query)`, newest first, and the server's total,
 * for a settings table that pages on the daemon rather than over the store
 * (which holds only the loaded scopes). The rows are local display state:
 * they never enter the store and join no scope. Read through `useServerRead`:
 * a patch to a row on the page replaces it in place (and survives a re-read
 * in flight); an event that can change the page's membership or total — a
 * create, a removal, an archive flip, a patch to an off-page row under a
 * filter, any patch while searching — reads the page again, debounced.
 * `query: null` reads nothing.
 */
export function useBranchPage(
  client: AgorClient | null,
  query: Record<string, unknown> | null,
  page: number,
  pageSize: number
): { rows: Branch[]; total: number; loading: boolean; refresh: () => void } {
  // A stable key for an inline query object.
  const queryKey = query ? JSON.stringify(query) : null;
  const rowsRef = useRef<Branch[]>([]);
  const { data, loading, refresh } = useServerRead<Page>(
    client,
    queryKey && `${queryKey}|${page}|${pageSize}`,
    async (client) => {
      const found = await client.service('branches').find({
        query: {
          ...JSON.parse(queryKey as string),
          $limit: pageSize,
          $skip: (page - 1) * pageSize,
          $sort: { created_at: -1 },
        },
      });
      const rows = rowsOf<Branch>(found);
      return { rows, total: Array.isArray(found) ? rows.length : found.total };
    },
    {
      keepPrevious: true,
      subscribe: (client, { invalidate, patch }) => {
        const service = client.service('branches');
        const searching = query?.search !== undefined;
        // Under a filter, an off-page patch may be an archive flip or a match.
        const filtered = searching || query?.archived !== undefined;
        const patched: Listener = (branch) => {
          const row = rowsRef.current.find((r) => r.branch_id === branch.branch_id);
          if (row ? searching || row.archived !== branch.archived : filtered) invalidate();
          if (!row) return;
          patch((prev) => ({
            ...prev,
            rows: prev.rows.map((r) => (r.branch_id === branch.branch_id ? branch : r)),
          }));
        };
        service.on('created', invalidate);
        service.on('patched', patched);
        service.on('removed', invalidate);
        return () => {
          service.off('created', invalidate);
          service.off('patched', patched);
          service.off('removed', invalidate);
        };
      },
    }
  );
  const result = data ?? NO_PAGE;
  rowsRef.current = result.rows;
  return { ...result, loading, refresh };
}

/**
 * Active sessions per `field` value (a branch or a board), read as count-only
 * pages (`$limit: 0`) for just the ids a table shows, since the store holds
 * only the loaded scopes' sessions. Display only; an id missing from the map
 * has no count yet.
 */
export function useSessionCounts(
  client: AgorClient | null,
  field: 'branch_id' | 'board_id',
  ids: string[]
): Map<string, number> {
  const [counts, setCounts] = useState<Map<string, number>>(() => new Map());
  const idsKey = ids.join(',');

  useEffect(() => {
    if (!client || !idsKey) return;
    let cancelled = false;
    for (const id of idsKey.split(',')) {
      client
        .service('sessions')
        .find({ query: { [field]: id, archived: false, $limit: 0 } })
        .then((found) => {
          if (cancelled || Array.isArray(found)) return;
          setCounts((prev) => new Map(prev).set(id, found.total));
        })
        .catch(() => {
          // An unreadable count stays blank.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [client, field, idsKey]);

  return counts;
}
