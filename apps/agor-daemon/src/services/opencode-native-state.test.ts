import type { AgorConfig } from '@agor/core/config';
import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  eq,
  generateId,
  OpenCodeCheckpointAttemptRepository,
  OpenCodeNativeStateHandoffRequiredError,
  RepoRepository,
  runWithTenantContext,
  SessionRepository,
  select,
  TaskRepository,
  UsersRepository,
} from '@agor/core/db';
import {
  OPENCODE_OBSERVER_BUSY_REASON,
  OPENCODE_SESSION_DELETE_DATA_KEY,
  TaskStatus,
} from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { opencodeCheckpointAttempts, sessions } from '../../../../packages/core/src/db/schema';
import { dbTest, ensureTestUser } from '../../../../packages/core/src/db/test-helpers';
import {
  OpenCodeNativeStateService,
  parseResolvedLocator,
  selectManagedOpenCodeAdmissionStoreId,
  withOpenCodeObserverSlot,
} from './opencode-native-state';

function cleanupBinding(
  sessionId: string,
  taskId: string,
  storeId: string,
  holderId: string,
  actorId: string
) {
  return {
    protocol: 3 as const,
    tenantId: 'default',
    ownerUserId: actorId,
    sessionId,
    taskId,
    storeId,
    holderInstanceId: holderId,
    locator: {
      runId: generateId(),
      cellId: generateId(),
      tenantId: 'default',
      ownerRuntimeUserId: actorId,
      sessionId,
      taskId,
      storeId,
      holderInstanceId: holderId,
      namespace: 'tenant-ns',
      jobName: 'executor-job',
      jobUid: generateId(),
      podName: 'executor-pod',
      podUid: generateId(),
      containerName: 'executor' as const,
      containerId: `containerd://${generateId()}`,
      restartCount: 0 as const,
      imageIdentity: `registry.example/agor/executor@sha256:${'c'.repeat(64)}`,
    },
  };
}

function cleanupManifest(taskId: string, storeId: string) {
  return {
    version: 3 as const,
    storeId,
    attemptTaskId: taskId,
    digest: `sha256:${'a'.repeat(64)}`,
    bytes: 4096,
    openCodeSessionId: 'ses_checkpoint',
    openCodeVersion: '1.18.31',
    publishedAt: new Date().toISOString(),
  };
}

describe('managed OpenCode admission retry store binding', () => {
  it('reuses a committed attempt store after a lost response instead of generating a new one', () => {
    expect(selectManagedOpenCodeAdmissionStoreId('admitted-store', undefined, undefined)).toBe(
      'admitted-store'
    );
    expect(
      selectManagedOpenCodeAdmissionStoreId('admitted-store', 'stale-session', 'stale-pointer')
    ).toBe('admitted-store');
    expect(selectManagedOpenCodeAdmissionStoreId(undefined, 'session-store', undefined)).toBe(
      'session-store'
    );
  });
});

describe('active cleanup observes terminal accepted holders', () => {
  dbTest(
    'keeps a verified-closed co-prompter pointer unretired and releases user deletion',
    async ({ db }) => {
      const alice = generateId();
      const bob = generateId();
      await ensureTestUser(db, alice);
      await ensureTestUser(db, bob);
      const repo = await new RepoRepository(db).create({
        repo_id: generateId(),
        slug: `native-observer-${generateId()}`,
        name: 'Native observer',
        repo_type: 'remote',
        remote_url: 'https://example.invalid/native-observer.git',
        local_path: '/tmp/native-observer',
        default_branch: 'main',
      });
      const branch = await new BranchRepository(db).create({
        branch_id: generateId(),
        repo_id: repo.repo_id,
        name: 'native-observer',
        ref: 'main',
        branch_unique_id: Math.floor(Math.random() * 1_000_000_000),
        path: '/tmp/native-observer',
        created_by: alice,
      });
      const session = await new SessionRepository(db).create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'opencode',
        created_by: alice,
        sdk_home_scope: 'branch',
      });
      const taskRepo = new TaskRepository(db);
      const attempts = new OpenCodeCheckpointAttemptRepository(db);
      const makeActiveTask = async (actorId: string, prompt: string) => {
        const task = await taskRepo.create({
          task_id: generateId(),
          session_id: session.session_id,
          created_by: actorId,
          full_prompt: prompt,
          status: TaskStatus.DISPATCHING,
          message_range: {
            start_index: 0,
            end_index: 0,
            start_timestamp: new Date().toISOString(),
          },
          git_state: { ref_at_start: 'main', sha_at_start: prompt },
        });
        const connected = await taskRepo.connectExecutor(task.task_id);
        if (!connected) throw new Error('Task connection failed');
        await taskRepo.stampManagedOpenCodeProtocol(task.task_id);
        return connected.task;
      };

      const bobTask = await makeActiveTask(bob, 'Bob checkpoint');
      const storeId = generateId();
      const bobHolder = generateId();
      const bobGrant = await attempts.begin({
        taskId: bobTask.task_id,
        holderInstanceId: bobHolder,
        storeId,
        binding: cleanupBinding(session.session_id, bobTask.task_id, storeId, bobHolder, bob),
      });
      if (bobGrant.outcome !== 'admitted') throw new Error('Bob was not admitted');
      const bobManifest = cleanupManifest(bobTask.task_id, storeId);
      await attempts.seal(bobTask.task_id, bobHolder, bobManifest);
      await taskRepo.completeWithNativeStatePublication(
        bobTask.task_id,
        { status: TaskStatus.COMPLETED, native_state_attempt: bobManifest },
        bobHolder
      );
      await expect(
        new UsersRepository(db).assertNativeStateHandoffClear(bob)
      ).rejects.toBeInstanceOf(OpenCodeNativeStateHandoffRequiredError);

      const aliceTask = await makeActiveTask(alice, 'Alice resumes Bob');
      const aliceHolder = generateId();
      const aliceGrant = await attempts.begin({
        taskId: aliceTask.task_id,
        holderInstanceId: aliceHolder,
        storeId,
        binding: cleanupBinding(session.session_id, aliceTask.task_id, storeId, aliceHolder, alice),
      });
      if (aliceGrant.outcome !== 'admitted' || aliceGrant.input?.version !== 3) {
        throw new Error('Alice did not resume Bob’s accepted checkpoint');
      }
      await attempts.closeRead(aliceTask.task_id, aliceHolder, {
        storeId,
        taskId: bobTask.task_id,
      });

      const now = new Date();
      const cleanup = await attempts.prepareCleanup(aliceTask.task_id, aliceHolder, now);
      expect(cleanup).toEqual({ kind: 'observe', attemptId: bobGrant.attempt.attempt_id });
      let outcome: 'verified_closed' | 'still_present' = 'still_present';
      const observer = new OpenCodeNativeStateService({
        db: createTenantScopedDatabaseProxy(db, { requireScope: false }),
        getConfig: () =>
          ({
            execution: {
              opencode_native_state_observer: {
                command_template: `cat >/dev/null; printf '%s\\n' '${JSON.stringify({ version: 1, action: 'observe', outcome })}'`,
                timeout_ms: 2_000,
              },
            },
          }) as unknown as AgorConfig,
      });
      const params = {
        tenant: { tenant_id: 'default' },
        authentication: {
          strategy: 'jwt',
          accessToken: 'active-task-token',
          payload: {
            type: 'executor-session',
            purpose: 'executor-task',
            session_id: session.session_id,
            task_id: aliceTask.task_id,
            branch_id: branch.branch_id,
            sub: alice,
            tenant_id: 'default',
          },
        },
      } as never;
      const observe = () =>
        runWithTenantContext('default', () =>
          observer.observe(
            {
              task_id: aliceTask.task_id,
              holder_instance_id: aliceHolder,
              attempt_id: bobGrant.attempt.attempt_id,
            },
            params
          )
        );
      await observe();

      let saved = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.attempt_id, bobGrant.attempt.attempt_id))
        .one();
      expect(saved?.holder_closed_observed_at).toBeNull();
      expect(saved?.retired_at).toBeNull();
      await expect(
        new UsersRepository(db).assertNativeStateHandoffClear(bob)
      ).rejects.toBeInstanceOf(OpenCodeNativeStateHandoffRequiredError);
      expect((await select(db).from(sessions).one())?.data[OPENCODE_SESSION_DELETE_DATA_KEY]).toBe(
        undefined
      );

      outcome = 'verified_closed';
      const retryAt = new Date(now.getTime() + 10_000);
      let retry = await attempts.prepareCleanup(aliceTask.task_id, aliceHolder, retryAt);
      for (let attempt = 0; retry.kind === 'none' && attempt < 4; attempt += 1) {
        retry = await attempts.prepareCleanup(aliceTask.task_id, aliceHolder, retryAt);
      }
      expect(retry).toEqual({ kind: 'observe', attemptId: bobGrant.attempt.attempt_id });
      await new Promise((resolve) => setTimeout(resolve, 1_050));
      await observe();

      saved = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.attempt_id, bobGrant.attempt.attempt_id))
        .one();
      expect(saved?.holder_closed_observed_at).not.toBeNull();
      expect(saved?.retired_at).toBeNull();
      await expect(
        new UsersRepository(db).assertNativeStateHandoffClear(bob)
      ).resolves.toBeUndefined();
      await expect(new UsersRepository(db).delete(bob)).resolves.toBeUndefined();
      await expect(new UsersRepository(db).findById(bob)).resolves.toBeNull();
      expect((await select(db).from(sessions).one())?.data.sdk_native_state).toEqual(bobManifest);
      expect((await select(db).from(sessions).one())?.data[OPENCODE_SESSION_DELETE_DATA_KEY]).toBe(
        undefined
      );
    }
  );
});

function resolvedLocator(containerId: string) {
  return {
    runId: 'run-1',
    cellId: 'cell-1',
    tenantId: 'tenant-1',
    ownerRuntimeUserId: 'user-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    storeId: 'store-1',
    holderInstanceId: 'holder-1',
    namespace: 'tenant-ns',
    jobName: 'executor-job',
    jobUid: 'job-uid',
    podName: 'executor-pod',
    podUid: 'pod-uid',
    containerName: 'executor',
    containerId,
    restartCount: 0,
    imageIdentity: `sha256:${'a'.repeat(64)}`,
  };
}

describe('parseResolvedLocator', () => {
  it('accepts the exact CRI container ID returned by Cloud', () => {
    expect(parseResolvedLocator(resolvedLocator('containerd://0123456789abcdef'))).toMatchObject({
      containerId: 'containerd://0123456789abcdef',
    });
  });

  it('rejects a malformed container ID instead of widening other Cloud identifiers', () => {
    expect(() => parseResolvedLocator(resolvedLocator('../containerd://id'))).toThrow(
      /invalid container binding/
    );
  });
});

describe('trusted Cloud observer helper budget', () => {
  it('allows only one helper per tenant task and throttles immediate replay', async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const first = withOpenCodeObserverSlot(
        'tenant-budget',
        'task-budget',
        'resolve',
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      );
      await expect(
        withOpenCodeObserverSlot('tenant-budget', 'task-budget', 'resolve', async () => {})
      ).rejects.toMatchObject({
        code: 429,
        data: { reason: OPENCODE_OBSERVER_BUSY_REASON },
      });
      finish();
      await first;
      await expect(
        withOpenCodeObserverSlot('tenant-budget', 'task-budget', 'resolve', async () => {})
      ).rejects.toThrow(/busy/);
      vi.advanceTimersByTime(1_000);
      await expect(
        withOpenCodeObserverSlot('tenant-budget', 'task-budget', 'resolve', async () => 'admitted')
      ).resolves.toBe('admitted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one tenant from occupying every helper slot', async () => {
    const releases: Array<() => void> = [];
    const pending = Array.from({ length: 4 }, (_, index) =>
      withOpenCodeObserverSlot(
        'tenant-a-budget',
        `task-${index}`,
        'resolve',
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          })
      )
    );
    await expect(
      withOpenCodeObserverSlot('tenant-a-budget', 'task-fifth', 'resolve', async () => {})
    ).rejects.toThrow(/busy/);
    await expect(
      withOpenCodeObserverSlot('tenant-b-budget', 'task-first', 'resolve', async () => 'admitted')
    ).resolves.toBe('admitted');
    for (const release of releases) release();
    await Promise.all(pending);
  });

  it('reserves capacity for admission when observations are busy', async () => {
    const releases: Array<() => void> = [];
    const pending = Array.from({ length: 4 }, (_, index) =>
      withOpenCodeObserverSlot(
        `tenant-observe-${index}`,
        `task-${index}`,
        'observe',
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          })
      )
    );
    await expect(
      withOpenCodeObserverSlot('tenant-observe-fifth', 'task-fifth', 'observe', async () => {})
    ).rejects.toThrow(/busy/);
    await expect(
      withOpenCodeObserverSlot('tenant-resolve', 'task-first', 'resolve', async () => 'admitted')
    ).resolves.toBe('admitted');
    for (const release of releases) release();
    await Promise.all(pending);
  });

  it('caps total helpers across many tenants', async () => {
    const releases: Array<() => void> = [];
    const pending = Array.from({ length: 16 }, (_, index) =>
      withOpenCodeObserverSlot(
        `tenant-global-${Math.floor(index / 4)}`,
        `task-${index}`,
        'resolve',
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          })
      )
    );
    await expect(
      withOpenCodeObserverSlot('tenant-global-fifth', 'task-extra', 'resolve', async () => {})
    ).rejects.toThrow(/busy/);
    for (const release of releases) release();
    await Promise.all(pending);
  });
});
