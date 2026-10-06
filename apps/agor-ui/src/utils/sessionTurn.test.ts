import {
  type AgorClient,
  isSessionPromptable,
  type Session,
  SessionStatus,
} from '@agor-live/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSessionMaps, EMPTY_MAPS } from '../store/agorMaps';
import { agorStore } from '../store/agorStore';
import { clearOpenedSessionFlags } from './sessionAttention';
import { canSessionStartTurn } from './sessionTurn';

afterEach(() => agorStore.getState().reset());

/** Settles a session the way the daemon does, then opens it the way the UI does. */
async function openedAfterSettling(status: Session['status']): Promise<Session> {
  let session = { session_id: 's1', status, ready_for_prompt: true } as Session;
  agorStore.setState({ ...EMPTY_MAPS, ...buildSessionMaps([session]) } as never);
  const patch = vi.fn(async (_id: string, data: Partial<Session>) => {
    session = { ...session, ...data };
  });
  clearOpenedSessionFlags({ service: () => ({ patch }) } as unknown as AgorClient, 's1');
  await vi.waitFor(() => expect(patch).toHaveBeenCalled());
  return session;
}

describe('canSessionStartTurn', () => {
  it.each([SessionStatus.FAILED, SessionStatus.TIMED_OUT, SessionStatus.IDLE])(
    'still allows a new turn after a %s session is opened',
    async (status) => {
      const opened = await openedAfterSettling(status);
      expect(opened.ready_for_prompt).toBe(false);
      expect(canSessionStartTurn(opened, 0)).toBe(true);
      // The old gate read the unread flag and hid recovery once the session was opened.
      if (status !== SessionStatus.IDLE) expect(isSessionPromptable(opened)).toBe(false);
    }
  );

  it.each([
    SessionStatus.RUNNING,
    SessionStatus.STOPPING,
    SessionStatus.AWAITING_PERMISSION,
    SessionStatus.AWAITING_INPUT,
  ])('never starts a second turn while the session is %s', (status) => {
    expect(canSessionStartTurn({ status }, 0)).toBe(false);
  });

  it('never jumps a queued prompt', () => {
    expect(canSessionStartTurn({ status: SessionStatus.FAILED }, 1)).toBe(false);
  });
});
