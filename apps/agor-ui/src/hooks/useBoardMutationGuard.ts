import { useCallback, useMemo, useRef } from 'react';
import { useConnectionState, useMutationGate } from '../contexts/ConnectionContext';
import { useAgorStore } from '../store/agorStore';
import {
  type BoardWriteTicket,
  captureBoardWriteTicket,
  isBoardWriteTicketCurrent,
} from '../store/boardMutationGuard';
import { makeBoardPartitionSelector } from '../store/boardPartitions';
import { useThemedMessage } from '../utils/message';

export interface BoardMutationGuard {
  /** A write captured now would be accepted (reactive; drives disabled states). */
  canMutate: boolean;
  /**
   * Capture a ticket when work is queued or a dialog/picker opens; `null` when
   * the board can't be written now.
   */
  capture: () => BoardWriteTicket | null;
  /**
   * Whether a write under `ticket` may dispatch right now: same board, same
   * partition lifetime and auth generation, still allowed, connection usable.
   */
  isCurrent: (ticket: BoardWriteTicket | null | undefined) => ticket is BoardWriteTicket;
  /**
   * Run `dispatch` only if `ticket` is current; otherwise drop it, with
   * `staleWarning` shown to the user when given. Resolves whether it ran.
   * `dispatch` must send its request synchronously (no await before it).
   */
  write: (
    ticket: BoardWriteTicket | null | undefined,
    dispatch: () => Promise<unknown>,
    staleWarning?: string
  ) => Promise<boolean>;
  /** Show the standard "not saved" warning for a dropped write. */
  warnDropped: (message?: string) => void;
}

export const BOARD_RELOADED_WARNING = 'This board reloaded; your last change was not saved.';

/**
 * The single fence for board-scoped writes (see `store/boardMutationGuard.ts`).
 * `allowed` is the caller's permission for this kind of write (board.edit,
 * comment, …); the connection mutation gate is always applied. Every check
 * reads live values, so a ticket held by a stale closure is still judged now.
 */
export function useBoardMutationGuard(
  boardId: string | null | undefined,
  allowed: boolean,
  options: { requirePartition?: boolean } = {}
): BoardMutationGuard {
  const requirePartition = options.requirePartition ?? true;
  const gate = useMutationGate();
  const { authGeneration } = useConnectionState();
  const { showWarning } = useThemedMessage();
  const partition = useAgorStore(useMemo(() => makeBoardPartitionSelector(boardId), [boardId]));

  const live = useRef({ boardId, allowed, canMutate: gate.canMutate, authGeneration });
  live.current = { boardId, allowed, canMutate: gate.canMutate, authGeneration };

  const canMutate =
    !!boardId && allowed && gate.canMutate && (!requirePartition || partition?.status === 'loaded');

  const capture = useCallback(() => {
    const now = live.current;
    if (!now.allowed || !now.canMutate) return null;
    return captureBoardWriteTicket(now.boardId, {
      requirePartition,
      authGeneration: now.authGeneration,
    });
  }, [requirePartition]);

  const isCurrent = useCallback(
    (ticket: BoardWriteTicket | null | undefined): ticket is BoardWriteTicket => {
      const now = live.current;
      return (
        now.allowed &&
        now.canMutate &&
        ticket?.boardId === now.boardId &&
        isBoardWriteTicketCurrent(ticket, now.authGeneration)
      );
    },
    []
  );

  const warnDropped = useCallback(
    (message: string = BOARD_RELOADED_WARNING) => showWarning(message),
    [showWarning]
  );

  const write = useCallback(
    async (
      ticket: BoardWriteTicket | null | undefined,
      dispatch: () => Promise<unknown>,
      staleWarning?: string
    ) => {
      if (!isCurrent(ticket)) {
        if (staleWarning) showWarning(staleWarning);
        return false;
      }
      await dispatch();
      return true;
    },
    [isCurrent, showWarning]
  );

  return useMemo(
    () => ({ canMutate, capture, isCurrent, write, warnDropped }),
    [canMutate, capture, isCurrent, write, warnDropped]
  );
}
