import type { AgorClient, Branch, Session } from '@agor-live/client';
import { useRef } from 'react';
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

/** Session events that can change a count (an archive is a patch). */
const SESSION_EVENTS = ['created', 'patched', 'removed'] as const;
/** Branch events that move a branch's sessions to another board. */
const BRANCH_MOVE_EVENTS = ['patched', 'removed'] as const;

const NO_COUNTS = new Map<string, number>();

/**
 * Active sessions per `field` value (a branch or a board), read as count-only
 * pages (`$limit: 0`) for just the ids a table shows, since the store holds
 * only the loaded scopes' sessions. Read through `useServerRead`: counted
 * again after a session event for a shown branch (any session event for
 * boards), after a branch moves (board counts), and after a reconnect.
 * Display only; an id missing from the map has no count yet.
 */
export function useSessionCounts(
  client: AgorClient | null,
  field: 'branch_id' | 'board_id',
  ids: string[]
): Map<string, number> {
  const idsKey = ids.join(',');
  const { data } = useServerRead(
    client,
    idsKey ? `${field}|${idsKey}` : null,
    async (client) => {
      const counts = new Map<string, number>();
      await Promise.all(
        idsKey.split(',').map(async (id) => {
          const found = await client
            .service('sessions')
            .find({ query: { [field]: id, archived: false, $limit: 0 } });
          if (!Array.isArray(found)) counts.set(id, found.total);
        })
      );
      return counts;
    },
    {
      keepPrevious: true,
      subscribe: (client, { invalidate }) => {
        const shown = new Set(idsKey.split(','));
        const onSession = (session: Session) => {
          if (field === 'board_id' || shown.has(session.branch_id)) invalidate();
        };
        const sessions = client.service('sessions');
        const branches = client.service('branches');
        for (const event of SESSION_EVENTS) sessions.on(event, onSession);
        if (field === 'board_id')
          for (const event of BRANCH_MOVE_EVENTS) branches.on(event, invalidate);
        return () => {
          for (const event of SESSION_EVENTS) sessions.off(event, onSession);
          for (const event of BRANCH_MOVE_EVENTS) branches.off(event, invalidate);
        };
      },
    }
  );
  return data ?? NO_COUNTS;
}
