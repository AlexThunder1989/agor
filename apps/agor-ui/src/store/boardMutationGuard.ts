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
 * The lifetime token is the partition's `generation`. It is kept while the
 * board stays loaded (live membership updates don't change it), and every
 * load gets a new one, so after an unload and reload a ticket from before the
 * unload never matches again, even once the board is loaded.
 *
 * A ticket also belongs to the guard that captured it (`owner`), which ends
 * all of its tickets when it unmounts: a confirmation, dialog or running
 * batch that outlives its component never dispatches. The connection and auth
 * generation are read from the published snapshot when checked, never from
 * values an owner rendered.
 */
import { agorStore } from './agorStore';
import { selectBoardPartition } from './boardPartitions';
import { connectionAllowsWrites, getConnectionSnapshot } from './connectionSnapshot';

/** The mounted lifetime of one guard; `alive` turns false when it unmounts. */
export interface BoardWriteOwner {
  readonly alive: boolean;
}

export interface BoardWriteTicket {
  readonly boardId: string;
  /** Generation of the loaded partition the write was decided against; `null` when the write doesn't need one. */
  readonly generation: number | null;
  /** Socket-auth generation at capture: a re-authentication ends the ticket. */
  readonly authGeneration: number;
  /** The guard that captured the ticket: its unmount ends the ticket. */
  readonly owner: BoardWriteOwner;
}

/**
 * A ticket for `boardId`, or `null` when the board can't be written now: the
 * owner unmounted, the connection is unusable, or its partition isn't loaded
 * (and one is required).
 */
export function captureBoardWriteTicket(
  boardId: string | null | undefined,
  options: { requirePartition: boolean; owner: BoardWriteOwner }
): BoardWriteTicket | null {
  const { requirePartition, owner } = options;
  const connection = getConnectionSnapshot();
  if (!boardId || !owner.alive || !connectionAllowsWrites(connection)) return null;
  const { authGeneration } = connection;
  if (!requirePartition) return { boardId, generation: null, authGeneration, owner };
  const partition = selectBoardPartition(agorStore.getState(), boardId);
  if (partition?.status !== 'loaded') return null;
  return { boardId, generation: partition.generation, authGeneration, owner };
}

/** Whether `ticket`'s partition is still loaded under the generation it was captured with. */
function samePartition(ticket: BoardWriteTicket): boolean {
  const current = selectBoardPartition(agorStore.getState(), ticket.boardId);
  return current?.status === 'loaded' && current.generation === ticket.generation;
}

/**
 * Whether everything `ticket` was captured under still holds now: its owner
 * is mounted, the connection is usable under the same auth generation, and
 * the partition lifetime is unchanged.
 */
export function isBoardWriteTicketCurrent(
  ticket: BoardWriteTicket | null | undefined
): ticket is BoardWriteTicket {
  if (!ticket?.owner?.alive) return false;
  const connection = getConnectionSnapshot();
  if (!connectionAllowsWrites(connection)) return false;
  if (ticket.authGeneration !== connection.authGeneration) return false;
  return ticket.generation === null || samePartition(ticket);
}

/**
 * Whether `ticket` can never be current again: there is none, its owner
 * unmounted, a re-authentication replaced its auth generation (generations
 * only advance), or its partition lifetime ended (the board unloaded). A
 * ticket held only by a passing condition (a disconnect, withheld edit) has not.
 */
export function hasBoardWriteTicketEnded(ticket: BoardWriteTicket | null | undefined): boolean {
  if (!ticket?.owner?.alive) return true;
  if (ticket.authGeneration !== getConnectionSnapshot().authGeneration) return true;
  return ticket.generation !== null && !samePartition(ticket);
}
