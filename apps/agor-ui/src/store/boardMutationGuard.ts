/**
 * Board write tickets: the one fence every board-scoped write passes.
 *
 * An unloaded board (a reconnect unloads every board but the displayed one)
 * is read-only: its cached rows and record may be stale, so a write derived
 * from them could restore a deleted zone or persist a wrong pin. A ticket
 * records the partition lifetime the write was decided against. It is
 * captured when the work is queued or its dialog opens, and checked
 * immediately before every dispatch, including each dispatch after an await.
 *
 * The lifetime token is the `loaded` partition entry itself. `setBoardPartition`
 * replaces the entry on every change, so an unload followed by a reload yields
 * a new entry: a ticket from before the unload never matches again, even once
 * the board is loaded.
 */
import { agorStore, type BoardPartitionState } from './agorStore';

export interface BoardWriteTicket {
  readonly boardId: string;
  /** The loaded partition the write was decided against; `null` when the write doesn't need one. */
  readonly partition: BoardPartitionState | null;
  /** Socket-auth generation at capture: a re-authentication ends the ticket. */
  readonly authGeneration: number;
}

/** A ticket for `boardId`, or `null` when its partition isn't loaded (and one is required). */
export function captureBoardWriteTicket(
  boardId: string | null | undefined,
  options: { requirePartition: boolean; authGeneration: number }
): BoardWriteTicket | null {
  if (!boardId) return null;
  const { requirePartition, authGeneration } = options;
  if (!requirePartition) return { boardId, partition: null, authGeneration };
  const partition = agorStore.getState().boardPartitions.get(boardId);
  if (partition?.status !== 'loaded') return null;
  return { boardId, partition, authGeneration };
}

/** Whether the partition lifetime and auth generation `ticket` was captured under still hold. */
export function isBoardWriteTicketCurrent(
  ticket: BoardWriteTicket | null | undefined,
  authGeneration: number
): ticket is BoardWriteTicket {
  if (!ticket || ticket.authGeneration !== authGeneration) return false;
  if (ticket.partition === null) return true;
  const current = agorStore.getState().boardPartitions.get(ticket.boardId);
  return current === ticket.partition && current.status === 'loaded';
}
