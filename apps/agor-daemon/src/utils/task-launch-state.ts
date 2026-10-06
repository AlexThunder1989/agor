import type { ExecutorMode, TaskLaunchFields } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';

export type ExecutorExitDisposition = 'authoritative' | 'passive' | 'ambiguous';

export function classifyExecutorExit(input: {
  mode: ExecutorMode;
  code: number | null;
  nonzeroMayHaveDispatched: boolean;
}): ExecutorExitDisposition {
  if (input.mode === 'local') return 'authoritative';
  if (input.code === 0) return 'passive';
  // A signaled launcher did not report its failure contract. sh -c can encode
  // its child's signal as 128+signal instead of exposing Node's signal field.
  // Neither form proves whether detached remote work was already submitted.
  if (input.code === null || input.code >= 128) return 'ambiguous';
  return input.nonzeroMayHaveDispatched ? 'ambiguous' : 'authoritative';
}

export function buildTaskLaunchState(
  startedAt: string,
  executorMode: ExecutorMode = 'local'
): Pick<TaskLaunchFields, 'status' | 'started_at' | 'executor_mode'> {
  return {
    status: TaskStatus.DISPATCHING,
    started_at: startedAt,
    executor_mode: executorMode,
  };
}
