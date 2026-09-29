import type { UUID } from '@agor/core/types';
import { OPENCODE_SESSION_DELETE_DATA_KEY, TaskStatus } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { describe, expect, vi } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { insert, select, update } from '../database-wrapper';
import { branches, opencodeCheckpointAttempts, sessions, tasks as taskRows } from '../schema';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { dbTest, ensureTestUser } from '../test-helpers';
import { BranchMaintenanceRepository } from './branch-maintenance';
import { BranchRepository } from './branches';
import { OpenCodeCheckpointAttemptRepository } from './opencode-checkpoint-attempts';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { UsersRepository } from './users';

let branchCounter = 20_000;

async function newTask(
  db: Database,
  options: { actorId?: UUID; scope?: 'execution_home' | 'branch'; stamp?: boolean } = {}
) {
  const ownerId = generateId() as UUID;
  await ensureTestUser(db, ownerId);
  const actorId = options.actorId ?? ownerId;
  if (actorId !== ownerId) await ensureTestUser(db, actorId);
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `checkpoint-${generateId()}`,
    name: 'Checkpoint test',
    repo_type: 'remote',
    remote_url: 'https://example.test/repo.git',
    local_path: '/tmp/repo',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'checkpoint',
    ref: 'main',
    branch_unique_id: branchCounter++,
    path: '/tmp/checkpoint',
    created_by: ownerId,
  });
  const session = await new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    agentic_tool: 'opencode',
    created_by: ownerId,
    sdk_home_scope: options.scope ?? 'execution_home',
  });
  const tasks = new TaskRepository(db);
  const created = await tasks.create({
    task_id: generateId(),
    session_id: session.session_id,
    created_by: actorId,
    full_prompt: 'continue',
    status: TaskStatus.DISPATCHING,
    message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
    git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
  });
  const connected = await tasks.connectExecutor(created.task_id);
  if (!connected) throw new Error('Task connection failed');
  if (options.stamp !== false) await tasks.stampManagedOpenCodeProtocol(created.task_id);
  return {
    ownerId,
    actorId,
    sessionId: session.session_id,
    branchId: branch.branch_id,
    task: connected.task,
  };
}

function binding(
  sessionId: string,
  taskId: string,
  storeId: string,
  holderId: string,
  ownerId: string
) {
  return {
    protocol: 3 as const,
    tenantId: 'default',
    ownerUserId: ownerId,
    sessionId,
    taskId,
    storeId,
    holderInstanceId: holderId,
    locator: {
      runId: generateId(),
      cellId: generateId(),
      tenantId: 'default',
      ownerRuntimeUserId: ownerId,
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

function manifest(taskId: string, storeId: string) {
  return {
    version: 3 as const,
    storeId,
    openCodeVersion: '1.18.31',
    attemptTaskId: taskId,
    digest: `sha256:${'a'.repeat(64)}`,
    bytes: 4096,
    openCodeSessionId: 'ses_checkpoint',
    publishedAt: new Date().toISOString(),
  };
}

async function publishCheckpoint(db: Database, sessionId: string, taskId: string, actorId: string) {
  const storeId = generateId();
  const holderId = generateId();
  const attempts = new OpenCodeCheckpointAttemptRepository(db);
  const admitted = await attempts.begin({
    taskId,
    holderInstanceId: holderId,
    storeId,
    binding: binding(sessionId, taskId, storeId, holderId, actorId),
  });
  if (admitted.outcome !== 'admitted') throw new Error('checkpoint holder was not admitted');
  const published = manifest(taskId, storeId);
  await attempts.seal(taskId, holderId, published);
  await new TaskRepository(db).completeWithNativeStatePublication(
    taskId,
    { status: TaskStatus.COMPLETED, native_state_attempt: published },
    holderId
  );
  return admitted.attempt.attempt_id;
}

async function taskInSession(db: Database, sessionId: string, actorId: string) {
  const tasks = new TaskRepository(db);
  const created = await tasks.create({
    task_id: generateId(),
    session_id: sessionId as UUID,
    created_by: actorId as UUID,
    full_prompt: 'child checkpoint',
    status: TaskStatus.DISPATCHING,
    message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
    git_state: { ref_at_start: 'main', sha_at_start: 'delete-tree' },
  });
  const connected = await tasks.connectExecutor(created.task_id);
  if (!connected) throw new Error('Task connection failed');
  await tasks.stampManagedOpenCodeProtocol(created.task_id);
  return connected.task;
}

describe('OpenCodeCheckpointAttemptRepository', () => {
  dbTest('deletes a closed branch checkpoint written by a co-prompter', async ({ db }) => {
    const foreignActorId = generateId() as UUID;
    const { ownerId, sessionId, task } = await newTask(db, {
      actorId: foreignActorId,
      scope: 'branch',
    });
    const attemptId = await publishCheckpoint(db, sessionId, task.task_id, foreignActorId);
    const sessionsRepo = new SessionRepository(db);
    const [claim] = await sessionsRepo.claimDeletionTree(sessionId);
    const ledger = new OpenCodeCheckpointAttemptRepository(db);
    const observed = await ledger.reserveSessionDeleteObservation(
      sessionId,
      claim.operationId,
      attemptId
    );
    if (!observed) throw new Error('Expected a closure observation');
    await ledger.recordSessionDeleteObservation(
      sessionId,
      claim.operationId,
      attemptId,
      observed,
      'verified_closed'
    );
    expect(ownerId).not.toBe(foreignActorId);
    const files = await ledger.prepareSessionDeleteFiles(sessionId, claim.operationId);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ attemptId, taskId: task.task_id });
    await ledger.acknowledgeSessionDelete(sessionId, claim.operationId, files, {
      outcome: 'deleted',
    });
    expect(await sessionsRepo.findById(sessionId)).toMatchObject({
      sdk_native_state_deletion_status: 'state_cleared',
    });
  });

  dbTest(
    'refuses to observe or close a branch holder with a mismatched Task actor binding',
    async ({ db }) => {
      const actorId = generateId() as UUID;
      const {
        ownerId,
        sessionId,
        task: targetTask,
      } = await newTask(db, {
        actorId,
        scope: 'branch',
      });
      const attempts = new OpenCodeCheckpointAttemptRepository(db);
      const tasks = new TaskRepository(db);
      const storeId = generateId();
      const targetHolder = generateId();
      const targetBinding = binding(sessionId, targetTask.task_id, storeId, targetHolder, actorId);
      const admitted = await attempts.begin({
        taskId: targetTask.task_id,
        holderInstanceId: targetHolder,
        storeId,
        binding: targetBinding,
      });
      if (admitted.outcome !== 'admitted') throw new Error('target holder was not admitted');
      await update(db, taskRows)
        .set({ status: TaskStatus.FAILED, completed_at: new Date() })
        .where(eq(taskRows.task_id, targetTask.task_id))
        .run();

      const created = await tasks.create({
        task_id: generateId(),
        session_id: sessionId,
        created_by: ownerId,
        full_prompt: 'observe prior holder',
        status: TaskStatus.DISPATCHING,
        message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
        git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
      });
      const connected = await tasks.connectExecutor(created.task_id);
      if (!connected) throw new Error('collector Task connection failed');
      await tasks.stampManagedOpenCodeProtocol(created.task_id);
      const collectorHolder = generateId();
      const collectorBinding = binding(
        sessionId,
        created.task_id,
        storeId,
        collectorHolder,
        ownerId
      );
      const collector = await attempts.begin({
        taskId: created.task_id,
        holderInstanceId: collectorHolder,
        storeId,
        binding: collectorBinding,
      });
      if (collector.outcome !== 'admitted') throw new Error('collector holder was not admitted');
      await expect(
        attempts.prepareCleanup(created.task_id, collectorHolder)
      ).resolves.toMatchObject({
        kind: 'observe',
        attemptId: admitted.attempt.attempt_id,
      });

      await update(db, opencodeCheckpointAttempts)
        .set({ binding: { ...targetBinding, ownerUserId: ownerId } })
        .where(eq(opencodeCheckpointAttempts.attempt_id, admitted.attempt.attempt_id))
        .run();
      await expect(
        attempts.loadObservationBinding(
          created.task_id,
          collectorHolder,
          admitted.attempt.attempt_id
        )
      ).rejects.toThrow(/no longer eligible/);
      await expect(
        attempts.recordHolderObservation(
          created.task_id,
          collectorHolder,
          admitted.attempt.attempt_id,
          'verified_closed'
        )
      ).rejects.toThrow(/actor binding is not authoritative/);
      await expect(
        select(db)
          .from(opencodeCheckpointAttempts)
          .where(eq(opencodeCheckpointAttempts.attempt_id, admitted.attempt.attempt_id))
          .one()
      ).resolves.toMatchObject({ holder_closed_observed_at: null });
    }
  );

  dbTest(
    'binds managed branch checkpoints to Task actor while retaining Session creator ownership',
    async ({ db }) => {
      const actorId = generateId() as UUID;
      const { ownerId, sessionId, task } = await newTask(db, { actorId, scope: 'branch' });
      const repo = new OpenCodeCheckpointAttemptRepository(db);
      const storeId = generateId();
      const holderId = generateId();
      await expect(
        repo.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: binding(sessionId, task.task_id, storeId, holderId, ownerId),
        })
      ).rejects.toThrow(/binding does not match/);
      const actorBinding = binding(sessionId, task.task_id, storeId, holderId, actorId);
      await expect(
        repo.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: actorBinding,
        })
      ).resolves.toMatchObject({ outcome: 'admitted' });

      const attempt = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, task.task_id))
        .one();
      expect(attempt?.owner_user_id).toBe(ownerId);
      expect(attempt?.binding.ownerUserId).toBe(actorId);
      await expect(
        new TaskRepository(db).assertManagedExecutorHolder(task.task_id, holderId)
      ).resolves.toBeUndefined();
      const session = await select(db)
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one();
      expect(session?.data.sdk_native_state_layout).toBe('session_root_v1');
      expect(await new SessionRepository(db).findById(sessionId)).not.toHaveProperty(
        'sdk_native_state_layout'
      );
      await expect(
        new SessionRepository(db).update(sessionId, { title: 'marker preserved' })
      ).resolves.toBeDefined();
      const afterPatch = await select(db)
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one();
      expect(afterPatch?.data.sdk_native_state_layout).toBe('session_root_v1');
      await expect(
        new SessionRepository(db).update(sessionId, { branch_id: generateId() })
      ).rejects.toThrow(/opencode_native_state_handoff_required/);

      await update(db, opencodeCheckpointAttempts)
        .set({ binding: { ...actorBinding, ownerUserId: ownerId } })
        .where(eq(opencodeCheckpointAttempts.task_id, task.task_id))
        .run();
      await expect(
        new TaskRepository(db).assertManagedExecutorHolder(task.task_id, holderId)
      ).rejects.toThrow(/no longer authoritative/);
    }
  );

  dbTest(
    'releases a co-prompter user guard only after verified closed completion',
    async ({ db }) => {
      const actorId = generateId() as UUID;
      const { ownerId, sessionId, task } = await newTask(db, { actorId, scope: 'branch' });
      const attempts = new OpenCodeCheckpointAttemptRepository(db);
      const tasksRepo = new TaskRepository(db);
      const storeId = generateId();
      const holderId = generateId();
      const admitted = await attempts.begin({
        taskId: task.task_id,
        holderInstanceId: holderId,
        storeId,
        binding: binding(sessionId, task.task_id, storeId, holderId, actorId),
      });
      expect(admitted.outcome).toBe('admitted');
      const output = manifest(task.task_id, storeId);
      await attempts.seal(task.task_id, holderId, output);
      await tasksRepo.completeWithNativeStatePublication(
        task.task_id,
        { status: TaskStatus.COMPLETED, native_state_attempt: output },
        holderId
      );
      await expect(new UsersRepository(db).delete(actorId)).rejects.toThrow(
        /opencode_native_state_handoff_required/
      );

      await update(db, opencodeCheckpointAttempts)
        .set({ holder_closed_observed_at: new Date() })
        .where(eq(opencodeCheckpointAttempts.task_id, task.task_id))
        .run();
      await expect(new UsersRepository(db).delete(actorId)).resolves.toBeUndefined();

      const next = await tasksRepo.create({
        task_id: generateId(),
        session_id: sessionId,
        created_by: ownerId,
        full_prompt: 'resume with the current actor',
        status: TaskStatus.DISPATCHING,
        message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
        git_state: { ref_at_start: 'main', sha_at_start: 'resume' },
      });
      const connected = await tasksRepo.connectExecutor(next.task_id);
      if (!connected) throw new Error('Task connection failed');
      await tasksRepo.stampManagedOpenCodeProtocol(next.task_id);
      const nextHolder = generateId();
      const resumed = await attempts.begin({
        taskId: next.task_id,
        holderInstanceId: nextHolder,
        storeId,
        binding: binding(sessionId, next.task_id, storeId, nextHolder, ownerId),
      });
      expect(resumed).toMatchObject({ outcome: 'admitted', input: output });
    }
  );

  dbTest(
    'keeps a task actor deletion blocked when its checkpoint binding is mismatched',
    async ({ db }) => {
      const actorId = generateId() as UUID;
      const { ownerId, sessionId, task } = await newTask(db, { actorId, scope: 'branch' });
      const attempts = new OpenCodeCheckpointAttemptRepository(db);
      const storeId = generateId();
      const holderId = generateId();
      const actorBinding = binding(sessionId, task.task_id, storeId, holderId, actorId);
      await expect(
        attempts.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: actorBinding,
        })
      ).resolves.toMatchObject({ outcome: 'admitted' });
      await update(db, taskRows)
        .set({ status: TaskStatus.COMPLETED, completed_at: new Date() })
        .where(eq(taskRows.task_id, task.task_id))
        .run();
      await update(db, opencodeCheckpointAttempts)
        .set({
          binding: { ...actorBinding, ownerUserId: ownerId },
          holder_closed_observed_at: new Date(),
          write_state: 'sealed',
        })
        .where(eq(opencodeCheckpointAttempts.task_id, task.task_id))
        .run();

      await expect(new UsersRepository(db).delete(actorId)).rejects.toThrow(
        /opencode_native_state_handoff_required/
      );
    }
  );

  dbTest('does not let another tenant checkpoint block actor deletion', async ({ db }) => {
    const actorId = generateId() as UUID;
    await new UsersRepository(db).create({
      user_id: actorId,
      email: `opencode-cross-tenant-actor-${actorId}@example.invalid`,
      role: 'member',
    });
    await runWithTenantDatabaseScope(db, 'other-tenant', async (scoped) => {
      const { ownerId, sessionId, task } = await newTask(scoped);
      const storeId = generateId();
      const holderId = generateId();
      const createdBinding = binding(sessionId, task.task_id, storeId, holderId, ownerId);
      const bindingForOtherTenant = {
        ...createdBinding,
        tenantId: 'other-tenant',
        ownerUserId: actorId,
        locator: { ...createdBinding.locator, tenantId: 'other-tenant' },
      };
      await insert(scoped, opencodeCheckpointAttempts)
        .values({
          tenant_id: 'other-tenant',
          attempt_id: generateId(),
          owner_user_id: ownerId,
          session_id: sessionId,
          task_id: task.task_id,
          store_id: storeId,
          attempt_no: 1,
          holder_instance_id: holderId,
          binding: bindingForOtherTenant,
          write_state: 'open',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .run();
    });

    await expect(new UsersRepository(db).delete(actorId)).resolves.toBeUndefined();
  });

  dbTest('rejects a pointer older than a higher completed sealed attempt', async ({ db }) => {
    const { ownerId, sessionId, task: firstTask } = await newTask(db);
    const attempts = new OpenCodeCheckpointAttemptRepository(db);
    const tasksRepo = new TaskRepository(db);
    const storeId = generateId();
    const accept = async (taskId: string) => {
      const holderId = generateId();
      const admission = await attempts.begin({
        taskId,
        holderInstanceId: holderId,
        storeId,
        binding: binding(sessionId, taskId, storeId, holderId, ownerId),
      });
      expect(admission.outcome).toBe('admitted');
      if (admission.outcome === 'admitted' && admission.input && 'storeId' in admission.input) {
        await attempts.closeRead(taskId, holderId, {
          storeId: admission.input.storeId,
          taskId: admission.input.attemptTaskId,
        });
      }
      const output = manifest(taskId, storeId);
      await attempts.seal(taskId, holderId, output);
      await tasksRepo.completeWithNativeStatePublication(
        taskId,
        { status: TaskStatus.COMPLETED, native_state_attempt: output },
        holderId
      );
      return output;
    };
    const first = await accept(firstTask.task_id);
    const createNext = async () => {
      const task = await tasksRepo.create({
        task_id: generateId(),
        session_id: sessionId,
        created_by: ownerId,
        full_prompt: 'continue',
        status: TaskStatus.DISPATCHING,
        message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
        git_state: { ref_at_start: 'main', sha_at_start: 'next' },
      });
      const connected = await tasksRepo.connectExecutor(task.task_id);
      if (!connected) throw new Error('Task connection failed');
      await tasksRepo.stampManagedOpenCodeProtocol(task.task_id);
      return task;
    };
    await accept((await createNext()).task_id);
    const before = await select(db).from(sessions).where(eq(sessions.session_id, sessionId)).one();
    if (!before) throw new Error('Session missing');
    await update(db, sessions)
      .set({ data: { ...before.data, sdk_native_state: first } })
      .where(eq(sessions.session_id, sessionId))
      .run();
    const third = await createNext();
    const holderId = generateId();
    await expect(
      attempts.begin({
        taskId: third.task_id,
        holderInstanceId: holderId,
        storeId,
        binding: binding(sessionId, third.task_id, storeId, holderId, ownerId),
      })
    ).rejects.toThrow(/older than a completed checkpoint/);
  });

  dbTest(
    'rejects unmarked replay and unknown layout markers before granting a holder',
    async ({ db }) => {
      const { ownerId, sessionId, task } = await newTask(db);
      const repo = new OpenCodeCheckpointAttemptRepository(db);
      const storeId = generateId();
      const holderId = generateId();
      const grant = await repo.begin({
        taskId: task.task_id,
        holderInstanceId: holderId,
        storeId,
        binding: binding(sessionId, task.task_id, storeId, holderId, ownerId),
      });
      expect(grant.outcome).toBe('admitted');
      const session = await select(db)
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one();
      if (!session) throw new Error('Session missing');
      const { sdk_native_state_layout: _layout, ...legacyData } = session.data;
      await update(db, sessions)
        .set({ data: legacyData })
        .where(eq(sessions.session_id, sessionId))
        .run();
      await expect(
        repo.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: binding(sessionId, task.task_id, storeId, holderId, ownerId),
        })
      ).resolves.toEqual({ outcome: 'rejected', code: 'legacy_state' });

      const unknown = await newTask(db);
      const unknownSession = await select(db)
        .from(sessions)
        .where(eq(sessions.session_id, unknown.sessionId))
        .one();
      if (!unknownSession) throw new Error('Session missing');
      await update(db, sessions)
        .set({
          data: {
            ...unknownSession.data,
            sdk_native_state_layout: 'session_root_v2' as never,
          },
        })
        .where(eq(sessions.session_id, unknown.sessionId))
        .run();
      const unknownHolder = generateId();
      const unknownStore = generateId();
      await expect(
        repo.begin({
          taskId: unknown.task.task_id,
          holderInstanceId: unknownHolder,
          storeId: unknownStore,
          binding: binding(
            unknown.sessionId,
            unknown.task.task_id,
            unknownStore,
            unknownHolder,
            unknown.ownerId
          ),
        })
      ).resolves.toEqual({ outcome: 'rejected', code: 'legacy_state' });
    }
  );

  dbTest(
    'rejects an unmarked completed checkpoint after its pointer and store identity are dropped',
    async ({ db }) => {
      const { ownerId, sessionId, task } = await newTask(db);
      const attempts = new OpenCodeCheckpointAttemptRepository(db);
      const tasks = new TaskRepository(db);
      const storeId = generateId();
      const holderId = generateId();
      const admission = await attempts.begin({
        taskId: task.task_id,
        holderInstanceId: holderId,
        storeId,
        binding: binding(sessionId, task.task_id, storeId, holderId, ownerId),
      });
      expect(admission.outcome).toBe('admitted');

      const published = manifest(task.task_id, storeId);
      await attempts.seal(task.task_id, holderId, published);
      await tasks.completeWithNativeStatePublication(
        task.task_id,
        { status: TaskStatus.COMPLETED, native_state_attempt: published },
        holderId
      );

      const session = await select(db)
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one();
      if (!session) throw new Error('Session missing');
      const {
        sdk_native_state: _pointer,
        sdk_native_state_store_id: _storeId,
        sdk_native_state_layout: _layout,
        ...legacyData
      } = session.data;
      await update(db, sessions)
        .set({ data: legacyData })
        .where(eq(sessions.session_id, sessionId))
        .run();

      const nextTask = await tasks.create({
        task_id: generateId(),
        session_id: sessionId,
        created_by: ownerId,
        full_prompt: 'resume after an older writer dropped checkpoint state',
        status: TaskStatus.DISPATCHING,
        message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
        git_state: { ref_at_start: 'main', sha_at_start: 'resume' },
      });
      const connected = await tasks.connectExecutor(nextTask.task_id);
      if (!connected) throw new Error('Task connection failed');
      await tasks.stampManagedOpenCodeProtocol(nextTask.task_id);
      const nextHolder = generateId();
      await expect(
        attempts.begin({
          taskId: nextTask.task_id,
          holderInstanceId: nextHolder,
          storeId,
          binding: binding(sessionId, nextTask.task_id, storeId, nextHolder, ownerId),
        })
      ).resolves.toEqual({ outcome: 'rejected', code: 'legacy_state' });
    }
  );

  dbTest(
    'replays only an existing exact open holder after Stop without admitting a new writer',
    async ({ db }) => {
      const { ownerId, sessionId, task } = await newTask(db);
      const attempts = new OpenCodeCheckpointAttemptRepository(db);
      const storeId = generateId();
      const holderId = generateId();
      const immutable = binding(sessionId, task.task_id, storeId, holderId, ownerId);
      await expect(
        attempts.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: immutable,
        })
      ).resolves.toMatchObject({ outcome: 'admitted' });
      await new TaskRepository(db).claimTermination({
        taskId: task.task_id,
        cause: 'user_stop',
        errorMessage: 'Stopped',
      });
      const assertRuntimeAuthority = vi.fn(async () => undefined);
      await expect(
        attempts.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: immutable,
          authority: {} as never,
          assertRuntimeAuthority,
        })
      ).resolves.toMatchObject({ outcome: 'admitted' });
      expect(assertRuntimeAuthority).toHaveBeenCalledWith(
        expect.anything(),
        task.task_id,
        expect.anything(),
        true
      );
      await expect(
        attempts.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: { ...immutable, locator: { ...immutable.locator, podUid: generateId() } },
        })
      ).resolves.toMatchObject({ outcome: 'rejected' });
      const otherHolder = generateId();
      await expect(
        attempts.begin({
          taskId: task.task_id,
          holderInstanceId: otherHolder,
          storeId,
          binding: binding(sessionId, task.task_id, storeId, otherHolder, ownerId),
        })
      ).resolves.toMatchObject({ outcome: 'rejected' });
      await attempts.abandon(task.task_id, holderId);
      await expect(
        attempts.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: immutable,
        })
      ).resolves.toMatchObject({ outcome: 'rejected' });
    }
  );
  dbTest('allows an admitted holder to abandon during Branch maintenance', async ({ db }) => {
    const { ownerId, sessionId, task } = await newTask(db);
    const attempts = new OpenCodeCheckpointAttemptRepository(db);
    const storeId = generateId();
    const holderId = generateId();
    await attempts.begin({
      taskId: task.task_id,
      holderInstanceId: holderId,
      storeId,
      binding: binding(sessionId, task.task_id, storeId, holderId, ownerId),
    });
    const route = await select(db, { branch_id: sessions.branch_id })
      .from(sessions)
      .where(eq(sessions.session_id, sessionId))
      .one();
    if (!route) throw new Error('Session missing');
    const branch = await select(db)
      .from(branches)
      .where(eq(branches.branch_id, route.branch_id))
      .one();
    if (!branch) throw new Error('Branch missing');
    await update(db, branches)
      .set({
        data: {
          ...branch.data,
          maintenance: {
            branch_id: route.branch_id,
            operation_id: generateId(),
            generation: 1,
            kind: 'cleanup',
          },
        },
      })
      .where(eq(branches.branch_id, route.branch_id))
      .run();
    await expect(attempts.abandon(task.task_id, holderId)).resolves.toBeUndefined();
    const row = await select(db)
      .from(opencodeCheckpointAttempts)
      .where(eq(opencodeCheckpointAttempts.task_id, task.task_id))
      .one();
    expect(row?.write_state).toBe('abandoned');
  });
  dbTest(
    'serializes concurrent distinct holders before either receives a grant',
    async ({ db }) => {
      const { ownerId, sessionId, task } = await newTask(db);
      const repoA = new OpenCodeCheckpointAttemptRepository(db);
      const repoB = new OpenCodeCheckpointAttemptRepository(db);
      const storeId = generateId();
      const holderA = generateId();
      const holderB = generateId();
      const results = await Promise.all([
        repoA.begin({
          taskId: task.task_id,
          holderInstanceId: holderA,
          storeId,
          binding: binding(sessionId, task.task_id, storeId, holderA, ownerId),
        }),
        repoB.begin({
          taskId: task.task_id,
          holderInstanceId: holderB,
          storeId,
          binding: binding(sessionId, task.task_id, storeId, holderB, ownerId),
        }),
      ]);

      expect(results.filter((result) => result.outcome === 'admitted')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'rejected')).toEqual([
        { outcome: 'rejected', code: 'already_admitted' },
      ]);
      const admitted = results.find((result) => result.outcome === 'admitted');
      if (admitted?.outcome !== 'admitted') throw new Error('no holder was admitted');
      expect([holderA, holderB]).toContain(admitted.attempt.holder_instance_id);
    }
  );

  dbTest(
    'commits one exact holder, pins only accepted input, and seals idempotently',
    async ({ db }) => {
      const { ownerId, sessionId, task } = await newTask(db);
      const repo = new OpenCodeCheckpointAttemptRepository(db);
      const storeId = generateId();
      const holderId = generateId();
      const immutableBinding = binding(sessionId, task.task_id, storeId, holderId, ownerId);
      const grant = await repo.begin({
        taskId: task.task_id,
        holderInstanceId: holderId,
        binding: immutableBinding,
        storeId,
      });
      expect(grant.outcome).toBe('admitted');
      if (grant.outcome !== 'admitted') throw new Error('Admission was not granted');
      expect(grant.input).toBeNull();
      expect(grant.attempt).toMatchObject({
        task_id: task.task_id,
        session_id: sessionId,
        store_id: storeId,
        holder_instance_id: holderId,
        attempt_no: 1,
        write_state: 'open',
        retired_at: null,
      });
      await expect(new SessionRepository(db).delete(sessionId)).rejects.toThrow(
        /opencode_native_state_handoff_required/
      );

      const repeated = await repo.begin({
        taskId: task.task_id,
        holderInstanceId: holderId,
        binding: immutableBinding,
        storeId,
      });
      expect(repeated.outcome).toBe('admitted');
      const loserHolder = generateId();
      const duplicate = await repo.begin({
        taskId: task.task_id,
        holderInstanceId: loserHolder,
        binding: binding(sessionId, task.task_id, storeId, loserHolder, ownerId),
        storeId,
      });
      expect(duplicate).toMatchObject({ outcome: 'rejected', code: 'already_admitted' });

      const published = manifest(task.task_id, storeId);
      await repo.seal(task.task_id, holderId, published);
      await expect(repo.seal(task.task_id, holderId, published)).resolves.toBeUndefined();
      await expect(
        repo.seal(task.task_id, holderId, { ...published, bytes: 8192 })
      ).rejects.toThrow(/changed its manifest/);
      await expect(
        repo.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          binding: immutableBinding,
          storeId,
        })
      ).resolves.toMatchObject({ outcome: 'rejected', code: 'already_admitted' });
      const saved = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, task.task_id))
        .one();
      expect(saved?.write_state).toBe('sealed');
      expect(saved?.sealed_manifest).toEqual(published);

      // Generic Session writes must not erase the store identity established by
      // the grant, even though it is intentionally absent from the public DTO.
      const before = await select(db)
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one();
      expect(before?.data.sdk_native_state_store_id).toBe(storeId);
      const projected = await new SessionRepository(db).findById(sessionId);
      expect(Object.hasOwn(projected ?? {}, 'sdk_native_state_store_id')).toBe(false);
      expect(Object.hasOwn(projected ?? {}, 'opencode_cleanup_cursor')).toBe(false);
      await new SessionRepository(db).update(sessionId, { title: 'metadata only' });
      const after = await select(db).from(sessions).where(eq(sessions.session_id, sessionId)).one();
      expect(after?.data.sdk_native_state_store_id).toBe(storeId);

      await update(db, taskRows)
        .set({ status: TaskStatus.FAILED, completed_at: new Date() })
        .where(eq(taskRows.task_id, task.task_id))
        .run();
      await expect(repo.seal(task.task_id, holderId, published)).resolves.toBeUndefined();
      await expect(repo.abandon(task.task_id, holderId)).rejects.toThrow(/sealed/i);
      const session = await select(db, { branch_id: sessions.branch_id })
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one();
      if (!session) throw new Error('Session missing');
      await expect(
        runWithTenantDatabaseScope(db, 'default', (scoped) =>
          new BranchMaintenanceRepository(scoped).claim(session.branch_id, 'delete')
        )
      ).rejects.toThrow(/opencode_native_state_handoff_required/);
      await expect(new UsersRepository(db).delete(ownerId)).rejects.toThrow(
        /opencode_native_state_handoff_required/
      );
    }
  );

  dbTest(
    'refuses a new empty turn when a completed checkpoint pointer was lost',
    async ({ db }) => {
      const { ownerId, sessionId, task } = await newTask(db);
      const attempts = new OpenCodeCheckpointAttemptRepository(db);
      const tasksRepo = new TaskRepository(db);
      const storeId = generateId();
      const holderId = generateId();
      const admitted = await attempts.begin({
        taskId: task.task_id,
        holderInstanceId: holderId,
        storeId,
        binding: binding(sessionId, task.task_id, storeId, holderId, ownerId),
      });
      expect(admitted.outcome).toBe('admitted');
      const published = manifest(task.task_id, storeId);
      await attempts.seal(task.task_id, holderId, published);
      await tasksRepo.completeWithNativeStatePublication(
        task.task_id,
        { status: TaskStatus.COMPLETED, native_state_attempt: published },
        holderId
      );

      // Simulate a pre-migration Session writer rebuilding its JSON data.
      const before = await select(db)
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one();
      if (!before) throw new Error('Session missing');
      const {
        sdk_native_state: _pointer,
        sdk_native_state_store_id: _storeId,
        ...oldWriterData
      } = before.data;
      await update(db, sessions)
        .set({ data: oldWriterData })
        .where(eq(sessions.session_id, sessionId))
        .run();

      const next = await tasksRepo.create({
        task_id: generateId(),
        session_id: sessionId,
        created_by: ownerId,
        full_prompt: 'must not start empty',
        status: TaskStatus.DISPATCHING,
        message_range: {
          start_index: 0,
          end_index: 0,
          start_timestamp: new Date().toISOString(),
        },
        git_state: { ref_at_start: 'main', sha_at_start: 'lost-pointer' },
      });
      const connected = await tasksRepo.connectExecutor(next.task_id);
      if (!connected) throw new Error('Task connection failed');
      await tasksRepo.stampManagedOpenCodeProtocol(next.task_id);
      const nextHolder = generateId();
      await expect(
        attempts.begin({
          taskId: next.task_id,
          holderInstanceId: nextHolder,
          storeId,
          binding: binding(sessionId, next.task_id, storeId, nextHolder, ownerId),
        })
      ).resolves.toEqual({ outcome: 'rejected', code: 'legacy_state' });
      // Keeping only the store id is not enough: the accepted input must still
      // be present to prevent an empty resume of a successful conversation.
      await update(db, sessions)
        .set({ data: { ...oldWriterData, sdk_native_state_store_id: storeId } })
        .where(eq(sessions.session_id, sessionId))
        .run();
      await expect(
        attempts.begin({
          taskId: next.task_id,
          holderInstanceId: nextHolder,
          storeId,
          binding: binding(sessionId, next.task_id, storeId, nextHolder, ownerId),
        })
      ).resolves.toEqual({ outcome: 'rejected', code: 'legacy_state' });
    }
  );

  dbTest(
    'allows a fresh turn after a failed first attempt without an accepted pointer',
    async ({ db }) => {
      const { ownerId, sessionId, task } = await newTask(db);
      const attempts = new OpenCodeCheckpointAttemptRepository(db);
      const tasksRepo = new TaskRepository(db);
      const storeId = generateId();
      const holderId = generateId();
      const first = await attempts.begin({
        taskId: task.task_id,
        holderInstanceId: holderId,
        storeId,
        binding: binding(sessionId, task.task_id, storeId, holderId, ownerId),
      });
      expect(first).toMatchObject({ outcome: 'admitted', input: null });
      await attempts.abandon(task.task_id, holderId);
      await update(db, taskRows)
        .set({ status: TaskStatus.FAILED, completed_at: new Date() })
        .where(eq(taskRows.task_id, task.task_id))
        .run();

      const next = await tasksRepo.create({
        task_id: generateId(),
        session_id: sessionId,
        created_by: ownerId,
        full_prompt: 'retry after failed first use',
        status: TaskStatus.DISPATCHING,
        message_range: {
          start_index: 0,
          end_index: 0,
          start_timestamp: new Date().toISOString(),
        },
        git_state: { ref_at_start: 'main', sha_at_start: 'first-use-retry' },
      });
      const connected = await tasksRepo.connectExecutor(next.task_id);
      if (!connected) throw new Error('Task connection failed');
      await tasksRepo.stampManagedOpenCodeProtocol(next.task_id);
      const nextHolder = generateId();
      await expect(
        attempts.begin({
          taskId: next.task_id,
          holderInstanceId: nextHolder,
          storeId,
          binding: binding(sessionId, next.task_id, storeId, nextHolder, ownerId),
        })
      ).resolves.toMatchObject({ outcome: 'admitted', input: null });
    }
  );

  dbTest(
    'bounded cleanup rotation reaches a healthy successor beyond 32 ineligible rows',
    async ({ db }) => {
      const { ownerId, sessionId, task: firstTask } = await newTask(db);
      const taskRepo = new TaskRepository(db);
      const attempts = new OpenCodeCheckpointAttemptRepository(db);
      const storeId = generateId();
      const history: Array<{ taskId: string; holderId: string }> = [];
      let currentTask = firstTask;

      const nextManagedTask = async () => {
        const created = await taskRepo.create({
          task_id: generateId(),
          session_id: sessionId,
          created_by: ownerId,
          full_prompt: 'fair cleanup progression',
          status: TaskStatus.DISPATCHING,
          message_range: {
            start_index: 0,
            end_index: 0,
            start_timestamp: new Date().toISOString(),
          },
          git_state: { ref_at_start: 'main', sha_at_start: 'cleanup-fairness' },
        });
        const connected = await taskRepo.connectExecutor(created.task_id);
        if (!connected) throw new Error('Task connection failed');
        await taskRepo.stampManagedOpenCodeProtocol(created.task_id);
        return connected.task;
      };

      for (let index = 0; index < 35; index += 1) {
        const holderId = generateId();
        const admitted = await attempts.begin({
          taskId: currentTask.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: binding(sessionId, currentTask.task_id, storeId, holderId, ownerId),
        });
        if (admitted.outcome !== 'admitted') throw new Error('history holder was not admitted');
        if (admitted.input?.version === 3) {
          await attempts.closeRead(currentTask.task_id, holderId, {
            storeId: admitted.input.storeId,
            taskId: admitted.input.attemptTaskId,
          });
        } else if (admitted.input) {
          throw new Error('test history requires a coordinated v3 input');
        }
        const published = {
          version: 3 as const,
          storeId,
          attemptTaskId: currentTask.task_id,
          digest: `sha256:${String(index).padStart(64, '0')}`,
          bytes: 1024,
          openCodeSessionId: 'cleanup-fairness',
          openCodeVersion: '1.18.31',
          publishedAt: new Date(Date.now() + index).toISOString(),
        };
        await attempts.seal(currentTask.task_id, holderId, published);
        await taskRepo.completeWithNativeStatePublication(
          currentTask.task_id,
          {
            status: TaskStatus.COMPLETED,
            native_state_attempt: published,
          },
          holderId
        );
        history.push({ taskId: currentTask.task_id, holderId });

        // Supersede the preceding accepted pointer before corrupting its binding.
        // Cleanup must treat these 33 terminal-looking ledger rows as ineligible.
        if (index > 0 && index - 1 < 33) {
          const ineligible = history[index - 1]!;
          const row = await select(db)
            .from(opencodeCheckpointAttempts)
            .where(eq(opencodeCheckpointAttempts.task_id, ineligible.taskId))
            .one();
          if (!row) throw new Error('history attempt disappeared');
          await update(db, opencodeCheckpointAttempts)
            .set({
              binding: { ...row.binding, sessionId: generateId() },
            })
            .where(eq(opencodeCheckpointAttempts.task_id, ineligible.taskId))
            .run();
        }
        if (index < 34) currentTask = await nextManagedTask();
      }

      const healthyTask = history[33]!;
      await update(db, opencodeCheckpointAttempts)
        .set({ holder_closed_observed_at: new Date() })
        .where(eq(opencodeCheckpointAttempts.session_id, sessionId))
        .run();
      const collectorTask = await nextManagedTask();
      const collectorHolder = generateId();
      const collector = await attempts.begin({
        taskId: collectorTask.task_id,
        holderInstanceId: collectorHolder,
        storeId,
        binding: binding(sessionId, collectorTask.task_id, storeId, collectorHolder, ownerId),
      });
      if (collector.outcome !== 'admitted') throw new Error('collector was not admitted');

      let work = await attempts.prepareCleanup(collectorTask.task_id, collectorHolder);
      expect(work.kind).toBe('none');
      const afterFirst = await select(db)
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one();
      const cleanupCursor = afterFirst?.data.opencode_cleanup_cursor as
        | { lanes?: { retire?: { cursorAttemptNo?: number } } }
        | undefined;
      expect(cleanupCursor?.lanes?.retire?.cursorAttemptNo).toBe(8);

      let calls = 1;
      while (work.kind === 'none' && calls < 8) {
        work = await attempts.prepareCleanup(collectorTask.task_id, collectorHolder);
        calls += 1;
      }
      expect(calls).toBe(5);
      expect(work).toEqual({
        kind: 'delete',
        object: { storeId, taskId: healthyTask.taskId },
      });
      const retired = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, healthyTask.taskId))
        .one();
      expect(retired?.retired_at).not.toBeNull();
      expect(retired?.delete_observed_at).toBeNull();
    }
  );

  dbTest('observes a superseded terminal holder before retiring its checkpoint', async ({ db }) => {
    const { ownerId, sessionId, task: firstTask } = await newTask(db);
    const taskRepo = new TaskRepository(db);
    const attempts = new OpenCodeCheckpointAttemptRepository(db);
    const storeId = generateId();
    const firstHolder = generateId();
    const first = await attempts.begin({
      taskId: firstTask.task_id,
      holderInstanceId: firstHolder,
      storeId,
      binding: binding(sessionId, firstTask.task_id, storeId, firstHolder, ownerId),
    });
    if (first.outcome !== 'admitted') throw new Error('first holder was not admitted');
    const firstManifest = manifest(firstTask.task_id, storeId);
    await attempts.seal(firstTask.task_id, firstHolder, firstManifest);
    await taskRepo.completeWithNativeStatePublication(
      firstTask.task_id,
      { status: TaskStatus.COMPLETED, native_state_attempt: firstManifest },
      firstHolder
    );

    const createNextTask = async () => {
      const created = await taskRepo.create({
        task_id: generateId(),
        session_id: sessionId,
        created_by: ownerId,
        full_prompt: 'advance checkpoint',
        status: TaskStatus.DISPATCHING,
        message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
        git_state: { ref_at_start: 'main', sha_at_start: 'cleanup-observation' },
      });
      const connected = await taskRepo.connectExecutor(created.task_id);
      if (!connected) throw new Error('Task connection failed');
      await taskRepo.stampManagedOpenCodeProtocol(created.task_id);
      return connected.task;
    };
    const successorTask = await createNextTask();
    const successorHolder = generateId();
    const successor = await attempts.begin({
      taskId: successorTask.task_id,
      holderInstanceId: successorHolder,
      storeId,
      binding: binding(sessionId, successorTask.task_id, storeId, successorHolder, ownerId),
    });
    if (successor.outcome !== 'admitted' || successor.input?.version !== 3) {
      throw new Error('successor did not pin the accepted checkpoint');
    }
    await attempts.closeRead(successorTask.task_id, successorHolder, {
      storeId,
      taskId: firstTask.task_id,
    });
    const successorManifest = manifest(successorTask.task_id, storeId);
    await attempts.seal(successorTask.task_id, successorHolder, successorManifest);
    await taskRepo.completeWithNativeStatePublication(
      successorTask.task_id,
      { status: TaskStatus.COMPLETED, native_state_attempt: successorManifest },
      successorHolder
    );

    const collectorTask = await createNextTask();
    const collectorHolder = generateId();
    const collector = await attempts.begin({
      taskId: collectorTask.task_id,
      holderInstanceId: collectorHolder,
      storeId,
      binding: binding(sessionId, collectorTask.task_id, storeId, collectorHolder, ownerId),
    });
    if (collector.outcome !== 'admitted' || collector.input?.version !== 3) {
      throw new Error('collector did not pin the accepted checkpoint');
    }
    await attempts.closeRead(collectorTask.task_id, collectorHolder, {
      storeId,
      taskId: successorTask.task_id,
    });

    const cleanup = await attempts.prepareCleanup(collectorTask.task_id, collectorHolder);

    expect(cleanup).toEqual({ kind: 'observe', attemptId: first.attempt.attempt_id });
    const retained = await select(db)
      .from(opencodeCheckpointAttempts)
      .where(eq(opencodeCheckpointAttempts.attempt_id, first.attempt.attempt_id))
      .one();
    expect(retained?.retired_at).toBeNull();
    expect(retained?.holder_closed_observed_at).toBeNull();

    await expect(
      attempts.loadObservationBinding(
        collectorTask.task_id,
        collectorHolder,
        first.attempt.attempt_id
      )
    ).resolves.toEqual(first.attempt.binding);
    await attempts.recordHolderObservation(
      collectorTask.task_id,
      collectorHolder,
      first.attempt.attempt_id,
      'verified_closed'
    );
    const reclaimed = await attempts.prepareCleanup(collectorTask.task_id, collectorHolder);
    expect(reclaimed).toEqual({
      kind: 'delete',
      object: { storeId, taskId: firstTask.task_id },
    });
    const closed = await select(db)
      .from(opencodeCheckpointAttempts)
      .where(eq(opencodeCheckpointAttempts.attempt_id, first.attempt.attempt_id))
      .one();
    expect(closed?.holder_closed_observed_at).not.toBeNull();
    expect(closed?.retired_at).not.toBeNull();
  });

  dbTest(
    'retries failed deletes and rechecks acknowledged absence without clearing tombstones',
    async ({ db }) => {
      const { ownerId, sessionId, task: firstTask } = await newTask(db);
      const taskRepo = new TaskRepository(db);
      const attempts = new OpenCodeCheckpointAttemptRepository(db);
      const storeId = generateId();
      const firstHolder = generateId();
      const first = await attempts.begin({
        taskId: firstTask.task_id,
        holderInstanceId: firstHolder,
        storeId,
        binding: binding(sessionId, firstTask.task_id, storeId, firstHolder, ownerId),
      });
      if (first.outcome !== 'admitted') throw new Error('first holder was not admitted');
      const firstManifest = manifest(firstTask.task_id, storeId);
      await attempts.seal(firstTask.task_id, firstHolder, firstManifest);
      await taskRepo.completeWithNativeStatePublication(
        firstTask.task_id,
        {
          status: TaskStatus.COMPLETED,
          native_state_attempt: firstManifest,
        },
        firstHolder
      );
      await new SessionRepository(db).update(sessionId, { title: 'pointer-preserving metadata' });
      const afterMetadata = await select(db)
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one();
      expect(afterMetadata?.data.sdk_native_state).toEqual(firstManifest);

      const createNextTask = async () => {
        const created = await taskRepo.create({
          task_id: generateId(),
          session_id: sessionId,
          created_by: ownerId,
          full_prompt: 'delete retry',
          status: TaskStatus.DISPATCHING,
          message_range: {
            start_index: 0,
            end_index: 0,
            start_timestamp: new Date().toISOString(),
          },
          git_state: { ref_at_start: 'main', sha_at_start: 'delete-retry' },
        });
        const connected = await taskRepo.connectExecutor(created.task_id);
        if (!connected) throw new Error('Task connection failed');
        await taskRepo.stampManagedOpenCodeProtocol(created.task_id);
        return connected.task;
      };
      const publisher = await createNextTask();
      const publisherHolder = generateId();
      const next = await attempts.begin({
        taskId: publisher.task_id,
        holderInstanceId: publisherHolder,
        storeId,
        binding: binding(sessionId, publisher.task_id, storeId, publisherHolder, ownerId),
      });
      if (next.outcome !== 'admitted' || next.input?.version !== 3) {
        throw new Error('publisher did not pin the accepted v3 input');
      }
      await attempts.closeRead(publisher.task_id, publisherHolder, {
        storeId,
        taskId: firstTask.task_id,
      });
      // A lost begin response may be replayed only while its input pin is live.
      // Never hand a closed grant back as if the old checkpoint were still pinned.
      await expect(
        attempts.begin({
          taskId: publisher.task_id,
          holderInstanceId: publisherHolder,
          storeId,
          binding: binding(sessionId, publisher.task_id, storeId, publisherHolder, ownerId),
        })
      ).resolves.toMatchObject({ outcome: 'rejected', code: 'already_admitted' });
      const nextManifest = {
        ...manifest(publisher.task_id, storeId),
        publishedAt: '2026-09-23T00:00:00.000Z',
      };
      await attempts.seal(publisher.task_id, publisherHolder, nextManifest);
      await taskRepo.completeWithNativeStatePublication(
        publisher.task_id,
        {
          status: TaskStatus.COMPLETED,
          native_state_attempt: nextManifest,
        },
        publisherHolder
      );
      await update(db, opencodeCheckpointAttempts)
        .set({ holder_closed_observed_at: new Date() })
        .where(eq(opencodeCheckpointAttempts.session_id, sessionId))
        .run();

      const collector = await createNextTask();
      const collectorHolder = generateId();
      const collectorGrant = await attempts.begin({
        taskId: collector.task_id,
        holderInstanceId: collectorHolder,
        storeId,
        binding: binding(sessionId, collector.task_id, storeId, collectorHolder, ownerId),
      });
      if (collectorGrant.outcome !== 'admitted') throw new Error('collector was not admitted');

      const now = new Date('2026-09-23T12:00:00.000Z');
      const tombstone = await attempts.prepareCleanup(collector.task_id, collectorHolder, now);
      expect(tombstone).toEqual({ kind: 'delete', object: { storeId, taskId: firstTask.task_id } });
      if (tombstone.kind !== 'delete') throw new Error('expected tombstone reservation');
      await attempts.acknowledgeDelete(
        collector.task_id,
        collectorHolder,
        tombstone.object,
        {
          outcome: 'failed',
          errorCode: 'WORKER_TIMEOUT',
        },
        now
      );
      let saved = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      expect(saved).toMatchObject({
        delete_failure_count: 1,
        delete_last_error: 'WORKER_TIMEOUT',
        delete_observed_at: null,
        delete_retry_at: new Date(now.getTime() + 2_000),
      });

      // A due retry tombstone is still retained while exact holder closure is unknown.
      await update(db, opencodeCheckpointAttempts)
        .set({
          holder_closed_observed_at: null,
          holder_observation_retry_at: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1_000),
          holder_observation_last_error: 'CLOUD_STILL_PRESENT',
        })
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .run();
      await expect(
        attempts.prepareCleanup(collector.task_id, collectorHolder, new Date(now.getTime() + 2_000))
      ).resolves.toEqual({ kind: 'none' });
      saved = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      expect(saved).toMatchObject({
        retired_at: expect.any(Date),
        delete_failure_count: 1,
        delete_observed_at: null,
        holder_closed_observed_at: null,
      });
      await update(db, opencodeCheckpointAttempts)
        .set({ holder_closed_observed_at: new Date() })
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .run();

      await expect(
        attempts.prepareCleanup(collector.task_id, collectorHolder, new Date(now.getTime() + 1_999))
      ).resolves.toEqual({ kind: 'none' });
      const retry = await attempts.prepareCleanup(
        collector.task_id,
        collectorHolder,
        new Date(now.getTime() + 2_000)
      );
      expect(retry).toEqual(tombstone);
      await attempts.acknowledgeDelete(
        collector.task_id,
        collectorHolder,
        tombstone.object,
        {
          outcome: 'deleted',
        },
        new Date(now.getTime() + 2_000)
      );
      saved = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      expect(saved?.retired_at).not.toBeNull();
      expect(saved?.delete_observed_at).toEqual(new Date(now.getTime() + 2_000));
      expect(saved?.delete_retry_at).toEqual(
        new Date(now.getTime() + 24 * 60 * 60 * 1_000 + 2_000)
      );
      await attempts.acknowledgeDelete(
        collector.task_id,
        collectorHolder,
        tombstone.object,
        { outcome: 'deleted' },
        new Date(now.getTime() + 2_001)
      );
      saved = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      expect(saved?.delete_retry_at).toEqual(
        new Date(now.getTime() + 24 * 60 * 60 * 1_000 + 2_000)
      );

      // Acknowledged absence is also only rechecked/deleted while closure remains proven.
      const recheckAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000 + 2_000);
      const acknowledgedAbsenceAt = saved?.delete_observed_at;
      await update(db, opencodeCheckpointAttempts)
        .set({
          holder_closed_observed_at: null,
          holder_observation_retry_at: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1_000),
          holder_observation_last_error: 'CLOUD_STILL_PRESENT',
        })
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .run();
      await expect(
        attempts.prepareCleanup(collector.task_id, collectorHolder, recheckAt)
      ).resolves.toEqual({ kind: 'none' });
      saved = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      expect(saved).toMatchObject({
        retired_at: expect.any(Date),
        delete_observed_at: acknowledgedAbsenceAt,
        holder_closed_observed_at: null,
      });
      await update(db, opencodeCheckpointAttempts)
        .set({ holder_closed_observed_at: new Date() })
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .run();

      const recheck = await attempts.prepareCleanup(collector.task_id, collectorHolder, recheckAt);
      expect(recheck).toEqual(tombstone);
      const afterRecheckReservation = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      expect(afterRecheckReservation?.retired_at).not.toBeNull();
      expect(afterRecheckReservation?.delete_observed_at).not.toBeNull();
      await attempts.acknowledgeDelete(
        collector.task_id,
        collectorHolder,
        tombstone.object,
        { outcome: 'deleted' },
        new Date(now.getTime() + 24 * 60 * 60 * 1_000 + 2_000)
      );
      const afterRecheck = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      expect(afterRecheck?.retired_at).not.toBeNull();
      expect(afterRecheck?.delete_retry_at).toBeNull();
    }
  );

  dbTest(
    'reclaims healthy hourly turns across four days without a growing backlog',
    async ({ db }) => {
      const { ownerId, sessionId, task: firstTask } = await newTask(db);
      const taskRepo = new TaskRepository(db);
      const attempts = new OpenCodeCheckpointAttemptRepository(db);
      const storeId = generateId();
      const epoch = Date.parse('2026-09-01T00:00:00.000Z');
      let currentTask = firstTask;
      for (let hour = 0; hour < 96; hour += 1) {
        const now = new Date(epoch + hour * 60 * 60 * 1_000);
        const holderId = generateId();
        const grant = await attempts.begin({
          taskId: currentTask.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: binding(sessionId, currentTask.task_id, storeId, holderId, ownerId),
        });
        if (grant.outcome !== 'admitted') throw new Error('hourly holder was not admitted');
        if (grant.input?.version === 3) {
          await attempts.closeRead(currentTask.task_id, holderId, {
            storeId,
            taskId: grant.input.attemptTaskId,
          });
        }
        // A healthy worker slot can reserve again after each fast completed
        // operation, but never reserves a batch ahead of the filesystem worker.
        for (let slot = 0; slot < 4; slot += 1) {
          const work = await attempts.prepareCleanup(currentTask.task_id, holderId, now);
          if (work.kind === 'delete') {
            await attempts.acknowledgeDelete(
              currentTask.task_id,
              holderId,
              work.object,
              { outcome: 'deleted' },
              now
            );
          } else if (work.kind === 'observe') {
            throw new Error('healthy finished holders have closure evidence');
          }
        }
        const published = {
          ...manifest(currentTask.task_id, storeId),
          publishedAt: now.toISOString(),
        };
        await attempts.seal(currentTask.task_id, holderId, published);
        await taskRepo.completeWithNativeStatePublication(
          currentTask.task_id,
          { status: TaskStatus.COMPLETED, native_state_attempt: published },
          holderId
        );
        await update(db, opencodeCheckpointAttempts)
          .set({ holder_closed_observed_at: now })
          .where(eq(opencodeCheckpointAttempts.task_id, currentTask.task_id))
          .run();
        if (hour === 47 || hour === 95) {
          const rows = await select(db)
            .from(opencodeCheckpointAttempts)
            .where(eq(opencodeCheckpointAttempts.session_id, sessionId))
            .all();
          const neverDeleted = rows.filter(
            (row: typeof opencodeCheckpointAttempts.$inferSelect) =>
              !row.delete_observed_at && row.task_id !== currentTask.task_id
          );
          expect(neverDeleted.length).toBeLessThanOrEqual(4);
        }
        if (hour < 95) {
          const created = await taskRepo.create({
            task_id: generateId(),
            session_id: sessionId,
            created_by: ownerId,
            full_prompt: 'hourly turn',
            status: TaskStatus.DISPATCHING,
            message_range: { start_index: 0, end_index: 0, start_timestamp: now.toISOString() },
            git_state: { ref_at_start: 'main', sha_at_start: 'hourly-cleanup' },
          });
          const connected = await taskRepo.connectExecutor(created.task_id);
          if (!connected) throw new Error('hourly task did not connect');
          await taskRepo.stampManagedOpenCodeProtocol(created.task_id);
          currentTask = connected.task;
        }
      }
    },
    60_000
  );

  dbTest('leaves a legacy pointer untouched and refuses first-use admission', async ({ db }) => {
    const { ownerId, sessionId, task } = await newTask(db);
    const oldPointer = {
      version: 2,
      openCodeVersion: '1.18.31',
      attemptTaskId: generateId(),
      digest: `sha256:${'b'.repeat(64)}`,
      bytes: 100,
      openCodeSessionId: 'legacy',
      publishedAt: new Date().toISOString(),
    };
    const row = await select(db).from(sessions).where(eq(sessions.session_id, sessionId)).one();
    if (!row) throw new Error('Session missing');
    await update(db, sessions)
      .set({ data: { ...row.data, sdk_native_state: oldPointer as never } })
      .where(eq(sessions.session_id, sessionId))
      .run();
    const holderId = generateId();
    const result = await new OpenCodeCheckpointAttemptRepository(db).begin({
      taskId: task.task_id,
      holderInstanceId: holderId,
      binding: binding(sessionId, task.task_id, generateId(), holderId, ownerId),
    });
    expect(result).toEqual({ outcome: 'rejected', code: 'legacy_state' });
    const unchanged = await select(db)
      .from(sessions)
      .where(eq(sessions.session_id, sessionId))
      .one();
    expect(unchanged?.data.sdk_native_state).toEqual(oldPointer);
    await expect(new SessionRepository(db).delete(sessionId)).rejects.toThrow(
      /opencode_native_state_handoff_required/
    );
  });

  dbTest(
    'keeps a superseded input pinned after force-fail until exact holder death evidence',
    async ({ db }) => {
      const { ownerId, sessionId, task: firstTask } = await newTask(db);
      const taskRepo = new TaskRepository(db);
      const attempts = new OpenCodeCheckpointAttemptRepository(db);
      const firstHolder = generateId();
      const firstStore = generateId();
      const first = await attempts.begin({
        taskId: firstTask.task_id,
        holderInstanceId: firstHolder,
        storeId: firstStore,
        binding: binding(sessionId, firstTask.task_id, firstStore, firstHolder, ownerId),
      });
      if (first.outcome !== 'admitted') throw new Error('first holder was not admitted');
      const firstManifest = manifest(firstTask.task_id, firstStore);
      await attempts.seal(firstTask.task_id, firstHolder, firstManifest);
      await taskRepo.completeWithNativeStatePublication(
        firstTask.task_id,
        {
          status: TaskStatus.COMPLETED,
          native_state_attempt: firstManifest,
        },
        firstHolder
      );
      await update(db, opencodeCheckpointAttempts)
        .set({ holder_closed_observed_at: new Date() })
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .run();

      const createNextTask = async () => {
        const created = await taskRepo.create({
          task_id: generateId(),
          session_id: sessionId,
          created_by: ownerId,
          full_prompt: 'continue checkpoint attempt',
          status: TaskStatus.DISPATCHING,
          message_range: {
            start_index: 0,
            end_index: 0,
            start_timestamp: new Date().toISOString(),
          },
          git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
        });
        const connected = await taskRepo.connectExecutor(created.task_id);
        if (!connected) throw new Error('Task connection failed');
        await taskRepo.stampManagedOpenCodeProtocol(created.task_id);
        return connected.task;
      };

      const abandonedTask = await createNextTask();
      const abandonedHolder = generateId();
      const abandoned = await attempts.begin({
        taskId: abandonedTask.task_id,
        holderInstanceId: abandonedHolder,
        storeId: firstStore,
        binding: binding(sessionId, abandonedTask.task_id, firstStore, abandonedHolder, ownerId),
      });
      if (abandoned.outcome !== 'admitted') throw new Error('second holder was not admitted');
      expect(abandoned.input).toEqual(firstManifest);
      // A force-failed Task can be terminal while its already-granted native file
      // read is still live. This models coordinator release without IO closure.
      await update(db, taskRows)
        .set({ status: TaskStatus.FAILED, completed_at: new Date() })
        .where(eq(taskRows.task_id, abandonedTask.task_id))
        .run();

      const publisherTask = await createNextTask();
      const publisherHolder = generateId();
      const publisher = await attempts.begin({
        taskId: publisherTask.task_id,
        holderInstanceId: publisherHolder,
        storeId: firstStore,
        binding: binding(sessionId, publisherTask.task_id, firstStore, publisherHolder, ownerId),
      });
      if (publisher.outcome !== 'admitted') throw new Error('publisher holder was not admitted');
      await attempts.closeRead(publisherTask.task_id, publisherHolder, {
        storeId: firstStore,
        taskId: firstTask.task_id,
      });
      const publisherManifest = manifest(publisherTask.task_id, firstStore);
      await attempts.seal(publisherTask.task_id, publisherHolder, publisherManifest);
      await taskRepo.completeWithNativeStatePublication(
        publisherTask.task_id,
        {
          status: TaskStatus.COMPLETED,
          native_state_attempt: publisherManifest,
        },
        publisherHolder
      );

      const collectorTask = await createNextTask();
      const collectorHolder = generateId();
      const collector = await attempts.begin({
        taskId: collectorTask.task_id,
        holderInstanceId: collectorHolder,
        storeId: firstStore,
        binding: binding(sessionId, collectorTask.task_id, firstStore, collectorHolder, ownerId),
      });
      if (collector.outcome !== 'admitted') throw new Error('collector holder was not admitted');
      const work = await attempts.prepareCleanup(collectorTask.task_id, collectorHolder);
      expect(work).toEqual({ kind: 'observe', attemptId: abandoned.attempt.attempt_id });

      const bindingForOldHolder = await attempts.loadObservationBinding(
        collectorTask.task_id,
        collectorHolder,
        abandoned.attempt.attempt_id
      );
      expect(bindingForOldHolder).toEqual(abandoned.attempt.binding);
      await attempts.recordHolderObservation(
        collectorTask.task_id,
        collectorHolder,
        abandoned.attempt.attempt_id,
        'unknown',
        'CLOUD_UNKNOWN'
      );
      await expect(
        attempts.loadObservationBinding(
          collectorTask.task_id,
          collectorHolder,
          abandoned.attempt.attempt_id
        )
      ).rejects.toThrow(/no longer eligible/);
      await update(db, opencodeCheckpointAttempts)
        .set({ holder_observation_retry_at: new Date(0) })
        .where(eq(opencodeCheckpointAttempts.attempt_id, abandoned.attempt.attempt_id))
        .run();
      let retriedObservation = false;
      for (let index = 0; index < 8; index += 1) {
        const next = await attempts.prepareCleanup(collectorTask.task_id, collectorHolder);
        if (next.kind === 'observe' && next.attemptId === abandoned.attempt.attempt_id) {
          retriedObservation = true;
          break;
        }
      }
      expect(retriedObservation).toBe(true);
      await expect(
        attempts.loadObservationBinding(
          collectorTask.task_id,
          collectorHolder,
          abandoned.attempt.attempt_id
        )
      ).resolves.toEqual(abandoned.attempt.binding);
      await attempts.recordHolderObservation(
        collectorTask.task_id,
        collectorHolder,
        abandoned.attempt.attempt_id,
        'verified_closed'
      );
      const oldAttempt = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      expect(oldAttempt?.retired_at).toBeNull();

      await expect(
        attempts.prepareCleanup(collectorTask.task_id, collectorHolder)
      ).resolves.toEqual({
        kind: 'delete',
        object: { storeId: firstStore, taskId: firstTask.task_id },
      });
      const retired = await select(db)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      expect(retired?.retired_at).toBeTruthy();
    }
  );

  dbTest(
    'requires explicit closure and per-Session file receipts for recursive delete',
    async ({ db }) => {
      const root = await newTask(db);
      const sessionsRepo = new SessionRepository(db);
      await expect(sessionsRepo.claimDeletionTree(root.sessionId)).rejects.toThrow(
        /unfinished tasks/
      );
      const child = await sessionsRepo.create({
        session_id: generateId(),
        branch_id: root.branchId,
        agentic_tool: 'opencode',
        created_by: root.ownerId,
        genealogy: { parent_session_id: root.sessionId, children: [] },
      });
      const childTask = await taskInSession(db, child.session_id, root.ownerId);
      const rootAttempt = await publishCheckpoint(
        db,
        root.sessionId,
        root.task.task_id,
        root.ownerId
      );
      const childAttempt = await publishCheckpoint(
        db,
        child.session_id,
        childTask.task_id,
        root.ownerId
      );
      const ledger = new OpenCodeCheckpointAttemptRepository(db);
      const claims = await sessionsRepo.claimDeletionTree(root.sessionId);
      expect(claims).toHaveLength(2);
      const rootClaim = claims.find((claim) => claim.sessionId === root.sessionId)!;
      const childClaim = claims.find((claim) => claim.sessionId === child.session_id)!;
      await expect(taskInSession(db, root.sessionId, root.ownerId)).rejects.toThrow(/deletion/i);
      const taskRepo = new TaskRepository(db);
      await expect(
        taskRepo.createPending({
          task_id: generateId(),
          session_id: root.sessionId,
          created_by: root.ownerId,
          full_prompt: 'replay a stable pending launch',
          status: TaskStatus.CREATED,
        })
      ).rejects.toThrow(/deletion/i);
      await expect(
        taskRepo.createPending({
          session_id: root.sessionId,
          created_by: root.ownerId,
          full_prompt: 'enqueue a new prompt',
          status: TaskStatus.QUEUED,
        })
      ).rejects.toThrow(/deletion/i);
      await expect(
        sessionsRepo.create({
          session_id: generateId(),
          branch_id: root.branchId,
          agentic_tool: 'opencode',
          created_by: root.ownerId,
          genealogy: { parent_session_id: root.sessionId, children: [] },
        })
      ).rejects.toThrow(/deletion/i);

      const closeAndDelete = async (
        sessionId: string,
        claim: (typeof claims)[number],
        attemptId: string,
        unknownFirst = false
      ) => {
        let binding = await ledger.reserveSessionDeleteObservation(
          sessionId,
          claim.operationId,
          attemptId
        );
        if (!binding) throw new Error('holder was already closed');
        if (unknownFirst) {
          await ledger.recordSessionDeleteObservation(
            sessionId,
            claim.operationId,
            attemptId,
            binding,
            'unknown',
            'CLOUD_UNKNOWN'
          );
          await expect(
            ledger.prepareSessionDeleteFiles(sessionId, claim.operationId)
          ).rejects.toThrow(/prove every holder/);
          binding = await ledger.reserveSessionDeleteObservation(
            sessionId,
            claim.operationId,
            attemptId
          );
          if (!binding) throw new Error('unknown result was treated as closure');
        }
        await ledger.recordSessionDeleteObservation(
          sessionId,
          claim.operationId,
          attemptId,
          binding,
          'verified_closed'
        );
        const files = await ledger.prepareSessionDeleteFiles(sessionId, claim.operationId);
        await ledger.acknowledgeSessionDelete(sessionId, claim.operationId, files, {
          outcome: 'deleted',
        });
        return files;
      };

      const childFiles = await closeAndDelete(child.session_id, childClaim, childAttempt, true);
      const rootWhileChildCleared = await select(db)
        .from(sessions)
        .where(eq(sessions.session_id, root.sessionId))
        .one();
      expect(rootWhileChildCleared?.data[OPENCODE_SESSION_DELETE_DATA_KEY]).toMatchObject({
        operation_id: rootClaim.operationId,
        status: 'pending',
      });
      await expect(
        select(db)
          .from(opencodeCheckpointAttempts)
          .where(eq(opencodeCheckpointAttempts.attempt_id, rootAttempt))
          .one()
      ).resolves.toBeDefined();
      await expect(
        sessionsRepo.assertNativeStateHandoffClear(child.session_id)
      ).resolves.toBeUndefined();
      await ledger.acknowledgeSessionDelete(child.session_id, childClaim.operationId, childFiles, {
        outcome: 'deleted',
      });
      await closeAndDelete(root.sessionId, rootClaim, rootAttempt);

      const rootAfter = await select(db)
        .from(sessions)
        .where(eq(sessions.session_id, root.sessionId))
        .one();
      const childAfter = await select(db)
        .from(sessions)
        .where(eq(sessions.session_id, child.session_id))
        .one();
      expect(rootAfter?.data[OPENCODE_SESSION_DELETE_DATA_KEY]).toMatchObject({
        operation_id: rootClaim.operationId,
        status: 'state_cleared',
      });
      expect(childAfter?.data[OPENCODE_SESSION_DELETE_DATA_KEY]).toMatchObject({
        operation_id: childClaim.operationId,
        status: 'state_cleared',
      });
      expect(rootAfter?.data).not.toHaveProperty('sdk_native_state');
      expect(rootAfter?.data).not.toHaveProperty('sdk_native_state_store_id');
      expect(rootAfter?.data).not.toHaveProperty('sdk_native_state_layout');
      await expect(sessionsRepo.findById(root.sessionId)).resolves.toBeDefined();
      await expect(
        sessionsRepo.assertNativeStateHandoffClear(root.sessionId)
      ).resolves.toBeUndefined();
      await expect(
        ledger.acknowledgeSessionDelete(child.session_id, rootClaim.operationId, childFiles, {
          outcome: 'deleted',
        })
      ).rejects.toThrow(/no longer current/);
    }
  );
});

dbTest(
  'does not clear an unresolved deletion receipt when state metadata is absent',
  async ({ db }) => {
    const { sessionId, task } = await newTask(db);
    await update(db, taskRows)
      .set({ status: TaskStatus.FAILED, completed_at: new Date() })
      .where(eq(taskRows.task_id, task.task_id))
      .run();
    const session = await select(db).from(sessions).where(eq(sessions.session_id, sessionId)).one();
    if (!session) throw new Error('Session missing');
    const operationId = generateId();
    await update(db, sessions)
      .set({
        data: {
          ...session.data,
          [OPENCODE_SESSION_DELETE_DATA_KEY]: { operation_id: operationId, status: 'pending' },
        },
      })
      .where(eq(sessions.session_id, sessionId))
      .run();

    await expect(new SessionRepository(db).claimDeletionTree(sessionId)).resolves.toMatchObject([
      { sessionId, operationId, status: 'pending', hasNativeState: true },
    ]);
    await expect(
      select(db).from(sessions).where(eq(sessions.session_id, sessionId)).one()
    ).resolves.toMatchObject({
      data: {
        [OPENCODE_SESSION_DELETE_DATA_KEY]: { operation_id: operationId, status: 'pending' },
      },
    });
  }
);
