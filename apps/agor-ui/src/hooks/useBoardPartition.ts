import type { AgorClient } from '@agor-live/client';
import { useEffect, useMemo } from 'react';
import { agorStore, useAgorStore } from '../store/agorStore';
import {
  isPartitionStateCurrent,
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
  const partitionReady = useAgorStore(useMemo(() => makeBoardReadySelector(boardId), [boardId]));
  const partition = useAgorStore(useMemo(() => makeBoardPartitionSelector(boardId), [boardId]));
  const status = partition?.status;
  const boardKnown = useAgorStore((s) => (boardId ? s.boardById.has(boardId) : false));
  const firstPaintSettled = useAgorStore((s) => !s.loading);
  const { canUseMemberWorkspaceServices } = options;
  // Nothing to load without a board, or for one that doesn't exist (boards
  // are global and gated, so after first paint an unknown id never resolves):
  // ready, like `BoardPartitionStatus` — never "Loading board…" forever.
  const boardReady = partitionReady || !boardId || (firstPaintSettled && !boardKnown);

  useEffect(() => {
    if (!client || !boardId || !boardKnown || !firstPaintSettled) return;
    if (partitionReady) return;
    // An entry from another authority or load lifetime can never settle: it
    // counts as unloaded (authority transitions also forget every entry).
    const current = agorStore.getState().boardPartitions.get(boardId);
    if (isPartitionStateCurrent(current) && (status === 'loading' || status === 'error')) return;
    void loadBoardPartition(client, boardId, { canUseMemberWorkspaceServices });
  }, [
    boardId,
    boardKnown,
    partitionReady,
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
