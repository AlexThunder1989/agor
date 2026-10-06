import { isSessionExecuting, type Session } from '@agor-live/client';

/**
 * A prompt sent now would start the next turn, not queue behind one: the same
 * rule the composer uses. `ready_for_prompt` is deliberately ignored: it is
 * also an unread flag that opening the session clears, and the prompt route
 * repairs a failed session whose flag was cleared.
 */
export function canSessionStartTurn(
  session: Pick<Session, 'status'>,
  queuedTaskCount: number
): boolean {
  return !isSessionExecuting(session) && queuedTaskCount === 0;
}
