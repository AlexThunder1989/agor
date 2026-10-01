import type { AgorClient } from '@agor-live/client';
import { useEffect, useMemo } from 'react';
import { agorStore, useAgorStore } from '../store/agorStore';
import {
  loadBoardPartition,
  makeBoardPartitionSelector,
  makeBoardReadySelector,
  retryBoardPartition,
} from '../store/boardPartitions';

/**
 * Load the displayed board's partition when it is not ready yet, and report
 * readiness. Waits for the gated first paint (which loads the first-paint
 * board's partition itself), dedupes in-flight loads, and retries a failed load
 * when the socket reconnects. Returns `boardReady` — gate every "absent means
 * none / no access" inference on it (invariant I1).
 */
export function useBoardPartition(
  client: AgorClient | null,
  boardId: string | null | undefined,
  options: { canUseMemberWorkspaceServices: boolean }
): { boardReady: boolean; status: 'loading' | 'loaded' | 'error' | undefined } {
  const boardReady = useAgorStore(useMemo(() => makeBoardReadySelector(boardId), [boardId]));
  const partition = useAgorStore(useMemo(() => makeBoardPartitionSelector(boardId), [boardId]));
  const status = partition?.status;
  const boardKnown = useAgorStore((s) => (boardId ? s.boardById.has(boardId) : false));
  const firstPaintSettled = useAgorStore((s) => !s.loading);
  const { canUseMemberWorkspaceServices } = options;

  useEffect(() => {
    if (!client || !boardId || !boardKnown || !firstPaintSettled) return;
    if (boardReady || status === 'loading' || status === 'error') return;
    void loadBoardPartition(client, boardId, { canUseMemberWorkspaceServices });
  }, [
    boardId,
    boardKnown,
    boardReady,
    canUseMemberWorkspaceServices,
    client,
    firstPaintSettled,
    status,
  ]);

  // A failed load retries automatically once the socket reconnects.
  useEffect(() => {
    if (!client || !boardId || status !== 'error') return;
    const retry = () => {
      if (agorStore.getState().boardPartitions.get(boardId)?.status === 'error') {
        retryBoardPartition(boardId);
      }
    };
    client.io.on('connect', retry);
    return () => {
      client.io.off('connect', retry);
    };
  }, [boardId, client, status]);

  return { boardReady, status };
}
