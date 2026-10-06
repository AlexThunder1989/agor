import type { AgorClient, Branch } from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { rowsOf } from '@/store/userScope';

type Listener = (row: Branch) => void;

/**
 * One page of `branches.find(query)`, newest first, and the server's total,
 * for a settings table that pages on the daemon rather than over the store
 * (which holds only the loaded scopes). The rows are local display state:
 * they never enter the store and join no scope. A patch to a row on the page
 * replaces it in place; a create, a removal, or a patch that flips `archived`
 * reads the page again. `query: null` reads nothing.
 */
export function useBranchPage(
  client: AgorClient | null,
  query: Record<string, unknown> | null,
  page: number,
  pageSize: number
): { rows: Branch[]; total: number; loading: boolean; refresh: () => void } {
  const [result, setResult] = useState<{ rows: Branch[]; total: number }>({ rows: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((r) => r + 1), []);
  const rowsRef = useRef(result.rows);
  rowsRef.current = result.rows;
  // A stable dependency for an inline query object.
  const queryKey = query ? JSON.stringify(query) : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is a re-read trigger
  useEffect(() => {
    if (!client || !queryKey) return;
    let cancelled = false;
    setLoading(true);
    client
      .service('branches')
      .find({
        query: {
          ...JSON.parse(queryKey),
          $limit: pageSize,
          $skip: (page - 1) * pageSize,
          $sort: { created_at: -1 },
        },
      })
      .then((found) => {
        if (cancelled) return;
        const rows = rowsOf<Branch>(found);
        setResult({ rows, total: Array.isArray(found) ? rows.length : found.total });
      })
      .catch((err) => {
        if (!cancelled) console.warn('[settings] branch page read failed:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, queryKey, page, pageSize, revision]);

  useEffect(() => {
    if (!client) return;
    const service = client.service('branches');
    const onPage = (branch: Branch) =>
      rowsRef.current.find((row) => row.branch_id === branch.branch_id);
    const patched: Listener = (branch) => {
      const row = onPage(branch);
      if (!row) return;
      if (row.archived !== branch.archived) return refresh();
      setResult((prev) => ({
        ...prev,
        rows: prev.rows.map((r) => (r.branch_id === branch.branch_id ? branch : r)),
      }));
    };
    const removed: Listener = (branch) => {
      if (onPage(branch)) refresh();
    };
    service.on('created', refresh);
    service.on('patched', patched);
    service.on('removed', removed);
    return () => {
      service.off('created', refresh);
      service.off('patched', patched);
      service.off('removed', removed);
    };
  }, [client, refresh]);

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
