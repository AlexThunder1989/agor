import type { AgorClient, Task } from '@agor-live/client';
import {
  isInFlightConnectionLossError,
  withConnectionErrorDetail,
} from '../../utils/connectionErrors';
import { waitForConnectedClient } from './stopReconciliation';

export type PromptTransportReconciliation = 'landed' | 'not_landed' | 'unknown';

export const PROMPT_NOT_SENT_MESSAGE =
  "Couldn't send. The connection to Agor dropped, but your message is still in the box.";
export const PROMPT_OUTCOME_UNKNOWN_MESSAGE =
  'The connection to Agor dropped as you sent this. Check the conversation before sending it again.';

/** Tolerates browser/daemon clock drift when comparing `created_at` to the local send time. */
const CLOCK_SKEW_TOLERANCE_MS = 30_000;
const RECENT_TASK_LIMIT = 20;

interface PromptAttempt {
  sessionId: string;
  userId: string;
  prompt: string;
  sentAt: number;
}

/** Never resend from here: a lost acknowledgement may follow a committed task. */
export async function reconcilePromptTransportFailure(
  getClient: () => AgorClient | null,
  attempt: PromptAttempt,
  reconnectTimeoutMs = 2_000
): Promise<PromptTransportReconciliation> {
  const client = await waitForConnectedClient(getClient, reconnectTimeoutMs);
  if (!client) return 'unknown';

  try {
    const result = (await client.service('tasks').find({
      query: {
        session_id: attempt.sessionId,
        created_by: attempt.userId,
        $sort: { created_at: -1 },
        $limit: RECENT_TASK_LIMIT,
      },
    })) as Task[] | { data: Task[] };
    const tasks = Array.isArray(result) ? result : result.data;
    const landed = tasks.some(
      (task) =>
        task.session_id === attempt.sessionId &&
        task.created_by === attempt.userId &&
        task.full_prompt === attempt.prompt &&
        Date.parse(task.created_at) >= attempt.sentAt - CLOCK_SKEW_TOLERANCE_MS
    );
    return landed ? 'landed' : 'not_landed';
  } catch {
    return 'unknown';
  }
}

/** Resolves true when the prompt is known to have reached the session. */
export async function sendPromptWithReconciliation({
  send,
  getClient,
  attempt,
  showError,
  isCurrent = () => true,
  reconnectTimeoutMs,
}: {
  send: () => Promise<unknown>;
  getClient: () => AgorClient | null;
  attempt: Omit<PromptAttempt, 'sentAt'>;
  showError: (message: string) => void;
  isCurrent?: () => boolean;
  reconnectTimeoutMs?: number;
}): Promise<boolean> {
  const sentAt = Date.now();
  try {
    await send();
    return isCurrent();
  } catch (error) {
    console.error('Prompt error:', error);
    if (!isInFlightConnectionLossError(error)) {
      if (isCurrent()) {
        showError(
          `Failed to send prompt: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return false;
    }
    const outcome = await reconcilePromptTransportFailure(
      getClient,
      { ...attempt, sentAt },
      reconnectTimeoutMs
    );
    if (!isCurrent()) return false;
    if (outcome === 'landed') return true;
    showError(
      withConnectionErrorDetail(
        outcome === 'not_landed' ? PROMPT_NOT_SENT_MESSAGE : PROMPT_OUTCOME_UNKNOWN_MESSAGE,
        error
      )
    );
    return false;
  }
}
