import type { AgorClient, BoardBranchCount } from '@agor-live/client';
import { useEffect, useState } from 'react';
import { useAgorStore } from '../store/agorStore';

/** Trailing debounce of the re-read after branch events. */
export const BRANCH_COUNTS_DEBOUNCE_MS = 1000;

/** Branch events that can change a board's active count (move and archive are patches). */
const BRANCH_EVENTS = ['created', 'patched', 'updated', 'removed'] as const;

/**
 * Active branches per board, from the `branch-counts` aggregate (the caller's
 * visible branches on visible boards), for the board badges — the store holds
 * only the loaded scopes' branches. Read under the realtime authority (again
 * after a reconnect or identity change) and re-read, debounced, after branch
 * events. A board missing from the map has no active branch.
 */
export function useBranchCounts(client: AgorClient | null): Map<string, number> {
  const [counts, setCounts] = useState<Map<string, number>>(() => new Map());
  const authority = useAgorStore((s) => s.dataAuthority);

  useEffect(() => {
    if (!client || !authority) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      client
        .service('branch-counts')
        .find()
        .then((rows: BoardBranchCount[]) => {
          if (!cancelled) setCounts(new Map(rows.map((r) => [r.board_id, r.branch_count])));
        })
        .catch((err: unknown) => console.warn('[branch-counts] read failed:', err));
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(read, BRANCH_COUNTS_DEBOUNCE_MS);
    };
    read();
    const branches = client.service('branches');
    for (const event of BRANCH_EVENTS) branches.on(event, schedule);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      for (const event of BRANCH_EVENTS) branches.off(event, schedule);
    };
  }, [client, authority]);

  return counts;
}
