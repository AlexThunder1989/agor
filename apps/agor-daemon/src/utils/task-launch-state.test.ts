import { TaskStatus } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { buildTaskLaunchState, classifyExecutorExit } from './task-launch-state.js';

describe('buildTaskLaunchState', () => {
  it('launches through the executor dispatch state', () => {
    expect(buildTaskLaunchState('2026-07-10T20:00:00.000Z')).toEqual({
      status: TaskStatus.DISPATCHING,
      started_at: '2026-07-10T20:00:00.000Z',
      executor_mode: 'local',
    });
  });

  it('snapshots templated execution at dispatch', () => {
    expect(buildTaskLaunchState('2026-07-10T20:00:00.000Z', 'templated')).toMatchObject({
      status: TaskStatus.DISPATCHING,
      executor_mode: 'templated',
    });
  });
});

describe('classifyExecutorExit', () => {
  it.each([
    [{ mode: 'local', code: 0, nonzeroMayHaveDispatched: false }, 'authoritative'],
    [{ mode: 'templated', code: 0, nonzeroMayHaveDispatched: false }, 'passive'],
    [{ mode: 'templated', code: 9, nonzeroMayHaveDispatched: false }, 'authoritative'],
    [{ mode: 'templated', code: 9, nonzeroMayHaveDispatched: true }, 'ambiguous'],
    [{ mode: 'templated', code: null, nonzeroMayHaveDispatched: false }, 'ambiguous'],
    [{ mode: 'templated', code: null, nonzeroMayHaveDispatched: true }, 'ambiguous'],
    [{ mode: 'templated', code: 137, nonzeroMayHaveDispatched: true }, 'ambiguous'],
    [{ mode: 'templated', code: 137, nonzeroMayHaveDispatched: false }, 'ambiguous'],
    [{ mode: 'templated', code: 143, nonzeroMayHaveDispatched: false }, 'ambiguous'],
  ] as const)('classifies %# as %s', (input, expected) => {
    expect(classifyExecutorExit(input)).toBe(expected);
  });
});
