import {
  CODEX_LIFECYCLE_MESSAGES,
  DAEMON_RESTART_RELEASED_MESSAGE,
  failureMessageBase,
  isConnectionLossMessage,
  isMissingCredentialMessage,
  isTerminalTaskStatus,
  LEGACY_SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE,
  parsePermissionTimeoutMs,
  SAFE_MISSING_PROVIDER_RESULT_MESSAGE,
  SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE,
} from '@agor/core/types';
import { type Task, TaskStatus } from '@agor-live/client';
import type { CompactNoticeType } from '../CompactNotice';

export type TurnOutcomeCause =
  | 'stop_unconfirmed'
  | 'restart_unconfirmed'
  | 'stopping'
  | 'waiting_to_start'
  | 'working_with_problem'
  | 'restart'
  | 'stopped'
  | 'access_changed'
  | 'approval_timeout'
  | 'not_connected'
  | 'never_started'
  | 'lost_connection'
  | 'stalled'
  | 'usage_limit'
  | 'provider_rejected'
  | 'stopped_early'
  | 'unknown';

export interface TurnOutcomeCopy {
  cause: TurnOutcomeCause;
  type: CompactNoticeType;
  message: string;
  action?: 'resume' | 'retry' | 'settings';
  /** Plain-language context shown above the raw error inside Details. */
  detailsLead?: string;
}

export interface TurnOutcomeContext {
  /** Tool activity is visible in the loaded transcript. */
  sawTools?: boolean;
  agentName?: string;
  /** The transcript shows the Connect panel for this turn's missing credential. */
  missingCredential?: boolean;
  /** This turn was rejected by a provider usage limit; `resetsAt` is unix seconds. */
  rateLimit?: { resetsAt?: number };
  /** Agor attached a restart notice to this turn. */
  restarted?: boolean;
  /** Who asked for the stop, when a person in the UI did. */
  stoppedBy?: 'you' | { name: string };
  now?: Date;
}

export const EDITS_KEPT = 'Any edits are kept.';
export const NO_FILES_CHANGED = 'No files changed.';

/** `executor_connected_at` exists from this date; older runs lack it even when they ran. */
const CONNECTED_AT_RECORDED_SINCE = Date.parse('2026-07-22T00:00:00.000Z');

const LOST_CONNECTION = new Set([
  SAFE_MISSING_PROVIDER_RESULT_MESSAGE,
  CODEX_LIFECYCLE_MESSAGES.stream_interrupted,
  CODEX_LIFECYCLE_MESSAGES.stream_ended_without_completion,
]);
const STOPPED_EARLY = new Set([
  SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE,
  LEGACY_SAFE_ZERO_TURN_PROVIDER_RESULT_MESSAGE,
  CODEX_LIFECYCLE_MESSAGES.completed_without_response,
]);

/** "10 minutes", "2 hours", "45 seconds": the largest unit that divides evenly. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const [value, unit] =
    seconds >= 3600 && seconds % 3600 === 0
      ? [seconds / 3600, 'hour']
      : seconds >= 60 && seconds % 60 === 0
        ? [seconds / 60, 'minute']
        : [seconds, 'second'];
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

/** "3:00 PM" today, "Mon 3:00 PM" otherwise. */
function formatReset(resetsAt: number, now: Date): string {
  const at = new Date(resetsAt * 1000);
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

/** Friendly one-line outcome for a finished or stopping turn; null when nothing needs saying. */
export function describeTurnOutcome(
  task: Task,
  {
    sawTools = false,
    agentName,
    missingCredential = false,
    rateLimit,
    restarted = false,
    stoppedBy,
    now = new Date(),
  }: TurnOutcomeContext = {}
): TurnOutcomeCopy | null {
  const { status, sdk_failure: failure, termination_request: request } = task;
  const error = failureMessageBase(task.error_message ?? '');
  const outcomeStatuses: TaskStatus[] = [
    TaskStatus.STOPPING,
    TaskStatus.STOPPED,
    TaskStatus.FAILED,
    TaskStatus.TIMED_OUT,
  ];
  if (!outcomeStatuses.includes(status) && !error) return null;
  const reason = failure?.reason;
  const cause = request?.cause;
  const wasRestart = restarted || error === DAEMON_RESTART_RELEASED_MESSAGE;

  if (failure?.termination === 'unverified') {
    return wasRestart
      ? {
          cause: 'restart_unconfirmed',
          type: 'warning',
          message: 'Agor restarted. The agent may still be editing files.',
        }
      : {
          cause: 'stop_unconfirmed',
          type: 'warning',
          message: 'The agent may not have stopped. Files may still change.',
          detailsLead: 'Only a branch owner or admin can force-stop it.',
        };
  }
  if (status === TaskStatus.STOPPING) {
    return { cause: 'stopping', type: 'info', message: 'Stopping the agent…' };
  }
  if (!isTerminalTaskStatus(status)) {
    return status === TaskStatus.DISPATCHING && !task.executor_connected_at
      ? { cause: 'waiting_to_start', type: 'info', message: 'Waiting for the agent to start…' }
      : {
          cause: 'working_with_problem',
          type: 'info',
          message: 'The agent hit a problem but is still working.',
        };
  }
  if (status === TaskStatus.COMPLETED) return null;
  const provenNothing = !sawTools && task.recorded_tool_count === 0;
  const work = provenNothing ? NO_FILES_CHANGED : EDITS_KEPT;
  if (wasRestart) {
    return {
      cause: 'restart',
      type: 'warning',
      message: `Agor restarted during this run. ${work}`,
      action: 'resume',
    };
  }
  if (cause === 'user_stop' || status === TaskStatus.STOPPED) {
    const who =
      stoppedBy === 'you'
        ? 'You stopped the agent.'
        : stoppedBy
          ? `${stoppedBy.name} stopped the agent.`
          : 'The agent was stopped.';
    return { cause: 'stopped', type: 'neutral', message: `${who} ${EDITS_KEPT}` };
  }
  if (cause === 'authorization_revoked') {
    return {
      cause: 'access_changed',
      type: 'warning',
      message: 'Agor stopped the agent after an access change.',
      action: 'resume',
    };
  }
  if (status === TaskStatus.TIMED_OUT) {
    const timeoutMs = parsePermissionTimeoutMs(error);
    return {
      cause: 'approval_timeout',
      type: 'warning',
      message: 'The agent stopped waiting for approval.',
      detailsLead: `Approval requests expire after ${timeoutMs ? formatDuration(timeoutMs) : 'a while'}.`,
      action: 'resume',
    };
  }

  if (missingCredential) return null;
  if (isMissingCredentialMessage(error)) {
    return {
      cause: 'not_connected',
      type: 'warning',
      message: `${agentName ?? 'Your agent'} isn't connected, so nothing ran.`,
      action: 'settings',
    };
  }
  const startupFailed =
    reason === 'startup_timeout' ||
    cause === 'startup_timeout' ||
    error === CODEX_LIFECYCLE_MESSAGES.stream_start_failed;
  const exited = reason === 'heartbeat_lost' || cause === 'heartbeat_lost';
  const neverConnected =
    !task.executor_connected_at &&
    !sawTools &&
    !task.recorded_tool_count &&
    (exited || Date.parse(task.created_at) >= CONNECTED_AT_RECORDED_SINCE);
  if (startupFailed || neverConnected) {
    return {
      cause: 'never_started',
      type: 'error',
      message: `The agent couldn't start. ${NO_FILES_CHANGED}`,
      action: 'retry',
    };
  }
  if (exited || LOST_CONNECTION.has(error) || isConnectionLossMessage(error)) {
    return {
      cause: 'lost_connection',
      type: 'error',
      message: `Lost connection to the agent. ${work}`,
      action: 'resume',
    };
  }
  if (cause === 'sdk_health_failure') {
    return {
      cause: 'stalled',
      type: 'error',
      message: `The agent stopped responding. ${work}`,
      action: 'resume',
    };
  }
  if (rateLimit) {
    const limit = agentName ? `${agentName} usage limit reached.` : 'Usage limit reached.';
    return {
      cause: 'usage_limit',
      type: 'warning',
      message: rateLimit.resetsAt
        ? `${limit} Try again after ${formatReset(rateLimit.resetsAt, now)}.`
        : `${limit} Try again later.`,
    };
  }
  if (error === CODEX_LIFECYCLE_MESSAGES.turn_failed) {
    return {
      cause: 'provider_rejected',
      type: 'error',
      message: `${agentName ?? 'The agent'} couldn't finish this run. ${work}`,
      action: 'resume',
    };
  }
  if (STOPPED_EARLY.has(error)) {
    return {
      cause: 'stopped_early',
      type: 'error',
      message: `The agent stopped early. ${work}`,
      action: 'resume',
    };
  }
  return {
    cause: 'unknown',
    type: 'error',
    message: `The agent hit a problem. ${work}`,
    action: 'resume',
  };
}
