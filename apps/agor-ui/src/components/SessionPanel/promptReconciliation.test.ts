import type { AgorClient, Task } from '@agor-live/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SOCKET_DISCONNECTED_ERROR } from '../../utils/connectionErrors';
import {
  PROMPT_OUTCOME_UNKNOWN_MESSAGE,
  reconcilePromptTransportFailure,
  sendPromptWithReconciliation,
} from './promptReconciliation';

const attempt = { sessionId: 'session-1', userId: 'user-a', prompt: 'Ship it' };

function task(overrides: Partial<Task> = {}): Task {
  return {
    task_id: 'task-1',
    session_id: attempt.sessionId,
    created_by: attempt.userId,
    full_prompt: attempt.prompt,
    status: 'queued',
    created_at: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function clientFinding(find: ReturnType<typeof vi.fn>, connected = true) {
  return { io: { connected }, service: () => ({ find }) } as unknown as AgorClient;
}

function sendLosingConnection(client: AgorClient | null) {
  const showError = vi.fn();
  const result = sendPromptWithReconciliation({
    send: () => Promise.reject(new Error(SOCKET_DISCONNECTED_ERROR)),
    getClient: () => client,
    attempt,
    showError,
    reconnectTimeoutMs: 50,
  });
  return { result, showError };
}

describe('sendPromptWithReconciliation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('treats a prompt that landed as sent, without a toast', async () => {
    const find = vi.fn().mockResolvedValue({ data: [task()] });
    const { result, showError } = sendLosingConnection(clientFinding(find));
    await expect(result).resolves.toBe(true);
    expect(showError).not.toHaveBeenCalled();
    expect(find).toHaveBeenCalledWith({
      query: {
        session_id: 'session-1',
        created_by: 'user-a',
        $sort: { created_at: -1 },
        $limit: 20,
      },
    });
  });

  it('keeps the text and says so when the prompt did not land', async () => {
    const find = vi.fn().mockResolvedValue({
      data: [
        task({ full_prompt: 'Something else' }),
        task({ created_by: 'user-b' }),
        task({ created_at: new Date(Date.now() - 10 * 60_000).toISOString() }),
      ],
    });
    const { result, showError } = sendLosingConnection(clientFinding(find));
    await expect(result).resolves.toBe(false);
    expect(showError).toHaveBeenCalledOnce();
    expect(showError).toHaveBeenCalledWith(
      "Couldn't send. The connection to Agor dropped, but your message is still in the box. (socket has been disconnected)"
    );
  });

  it('asks the user to check the conversation while still offline', async () => {
    const find = vi.fn();
    const { result, showError } = sendLosingConnection(clientFinding(find, false));
    await expect(result).resolves.toBe(false);
    expect(find).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledOnce();
    expect(showError).toHaveBeenCalledWith(
      'The connection to Agor dropped as you sent this. Check the conversation before sending it again. (socket has been disconnected)'
    );
  });

  it('asks the user to check the conversation when the check fails', async () => {
    const find = vi.fn().mockRejectedValue(new Error('Forbidden'));
    const { result, showError } = sendLosingConnection(clientFinding(find));
    await expect(result).resolves.toBe(false);
    expect(showError).toHaveBeenCalledWith(
      `${PROMPT_OUTCOME_UNKNOWN_MESSAGE} (socket has been disconnected)`
    );
  });

  it('shows the raw detail without a leading "Error: "', async () => {
    const showError = vi.fn();
    await sendPromptWithReconciliation({
      send: () => Promise.reject(new Error('Error: operation has timed out')),
      getClient: () => null,
      attempt,
      showError,
      reconnectTimeoutMs: 10,
    });
    expect(showError).toHaveBeenCalledWith(
      'The connection to Agor dropped as you sent this. Check the conversation before sending it again. (operation has timed out)'
    );
  });

  it('keeps the existing toast for other errors without reconciling', async () => {
    const getClient = vi.fn();
    const showError = vi.fn();
    await expect(
      sendPromptWithReconciliation({
        send: () => Promise.reject(new Error('Session is archived')),
        getClient,
        attempt,
        showError,
      })
    ).resolves.toBe(false);
    expect(getClient).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith('Failed to send prompt: Session is archived');
  });

  it('stays silent when the caller is no longer current', async () => {
    const find = vi.fn().mockResolvedValue({ data: [] });
    const showError = vi.fn();
    await expect(
      sendPromptWithReconciliation({
        send: () => Promise.reject(new Error(SOCKET_DISCONNECTED_ERROR)),
        getClient: () => clientFinding(find),
        attempt,
        showError,
        isCurrent: () => false,
      })
    ).resolves.toBe(false);
    expect(showError).not.toHaveBeenCalled();
  });
});

describe('reconcilePromptTransportFailure', () => {
  it('waits for the replacement client after a reconnect', async () => {
    let current: AgorClient | null = null;
    const find = vi.fn().mockResolvedValue([task()]);
    setTimeout(() => {
      current = clientFinding(find);
    }, 10);
    await expect(
      reconcilePromptTransportFailure(() => current, { ...attempt, sentAt: Date.now() }, 500)
    ).resolves.toBe('landed');
  });
});
