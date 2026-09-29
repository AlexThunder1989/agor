import type { UUID } from '@agor/core/types';
import { OPENCODE_SESSION_DELETE_DATA_KEY, TaskStatus } from '@agor/core/types';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import { createDatabase, type Database } from '../client';
import { insert, isPostgresDatabase, select, update } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { opencodeCheckpointAttempts, sessions, tasks as taskRows } from '../schema';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { BranchRepository } from './branches';
import { OpenCodeCheckpointAttemptRepository } from './opencode-checkpoint-attempts';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { UsersRepository } from './users';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'OpenCode checkpoint attempts PostgreSQL concurrency',
  () => {
    let dbA: Database;
    let dbB: Database;

    beforeAll(async () => {
      dbA = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      dbB = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(dbA);
      if (!isPostgresDatabase(dbA) || !isPostgresDatabase(dbB)) {
        throw new Error('PostgreSQL concurrency test requires PostgreSQL');
      }
      await dbA.execute(sql`SET TIME ZONE 'UTC'`);
      await dbB.execute(sql`SET TIME ZONE 'UTC'`);
    });

    afterAll(async () => {
      await Promise.all([
        (dbA as Database & { $client: { end: () => Promise<void> } }).$client.end(),
        (dbB as Database & { $client: { end: () => Promise<void> } }).$client.end(),
      ]);
    });

    async function createManagedSession(
      db: Database = dbA,
      scope: 'execution_home' | 'branch' = 'execution_home'
    ) {
      const ownerId = generateId() as UUID;
      await new UsersRepository(db).create({
        user_id: ownerId,
        email: `opencode-attempt-${ownerId}@example.invalid`,
        role: 'member',
      });
      const repo = await new RepoRepository(db).create({
        repo_id: generateId(),
        slug: `opencode-attempt-${generateId()}`,
        name: 'OpenCode race',
        repo_type: 'remote',
        remote_url: 'https://example.invalid/opencode.git',
        local_path: '/tmp/opencode-race',
        default_branch: 'main',
      });
      const branch = await new BranchRepository(db).create({
        branch_id: generateId(),
        repo_id: repo.repo_id,
        name: 'opencode-race',
        ref: 'main',
        branch_unique_id: Math.floor(Math.random() * 1_000_000_000),
        path: `/tmp/opencode-race/${generateId()}`,
        created_by: ownerId,
      });
      const session = await new SessionRepository(db).create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'opencode',
        created_by: ownerId,
        sdk_home_scope: scope,
      });
      return { ownerId, sessionId: session.session_id, branchId: branch.branch_id };
    }

    async function createManagedTask(
      sessionId: UUID,
      ownerId: UUID,
      db: Database = dbA,
      actorId: UUID = ownerId
    ) {
      const tasks = new TaskRepository(db);
      const created = await tasks.create({
        task_id: generateId(),
        session_id: sessionId,
        created_by: actorId,
        full_prompt: 'concurrent OpenCode holder admission',
        status: TaskStatus.DISPATCHING,
        message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
        git_state: { ref_at_start: 'main', sha_at_start: 'postgres-race' },
      });
      const connected = await tasks.connectExecutor(created.task_id);
      if (!connected) throw new Error('Task connection failed');
      await tasks.stampManagedOpenCodeProtocol(created.task_id);
      return connected.task;
    }

    function binding(
      sessionId: string,
      taskId: string,
      ownerId: string,
      storeId: string,
      holderId: string,
      tenant = 'default'
    ) {
      return {
        protocol: 3 as const,
        tenantId: tenant,
        ownerUserId: ownerId,
        sessionId,
        taskId,
        storeId,
        holderInstanceId: holderId,
        locator: {
          runId: generateId(),
          cellId: generateId(),
          tenantId: tenant,
          ownerRuntimeUserId: ownerId,
          sessionId,
          taskId,
          storeId,
          holderInstanceId: holderId,
          namespace: 'runtime-test',
          jobName: `job-${taskId}`,
          jobUid: generateId(),
          podName: `pod-${taskId}`,
          podUid: generateId(),
          containerName: 'executor' as const,
          containerId: `containerd://${generateId()}`,
          restartCount: 0 as const,
          imageIdentity: `sha256:${'c'.repeat(64)}`,
        },
      };
    }

    it('CAS fences deletion callbacks to the current bearer and stable reserved run across restart', async () => {
      const { sessionId } = await createManagedSession();
      const sessionsRepo = new SessionRepository(dbA);
      const row = await select(dbA).from(sessions).where(eq(sessions.session_id, sessionId)).one();
      if (!row) throw new Error('Session missing');
      await update(dbA, sessions)
        .set({
          data: {
            ...row.data,
            sdk_native_state_layout: 'session_root_v1',
            sdk_native_state_store_id: generateId(),
          },
        })
        .where(eq(sessions.session_id, sessionId))
        .run();
      const [claim] = await sessionsRepo.claimDeletionTree(sessionId);
      const operationId = claim!.operationId;
      const old = { runId: 'reserved-run', tokenFingerprint: 'a'.repeat(64) };
      const fresh = { ...old, tokenFingerprint: 'b'.repeat(64) };
      await sessionsRepo.reserveDeletionCredential(sessionId, operationId, old.tokenFingerprint, {
        tokenFingerprint: null,
        runId: null,
      });
      const ledger = new OpenCodeCheckpointAttemptRepository(dbA);
      await ledger.prepareSessionDeleteFiles(sessionId, operationId, undefined, old);
      await expect(
        ledger.prepareSessionDeleteFiles(sessionId, operationId, undefined, {
          ...old,
          runId: 'wrong-run',
        })
      ).rejects.toThrow(/invocation/);
      await expect(
        ledger.acknowledgeSessionDelete(
          sessionId,
          operationId,
          [],
          { outcome: 'deleted' },
          undefined,
          { ...old, runId: 'wrong-run' }
        )
      ).rejects.toThrow(/stale invocation/);
      // A reply authorized before this rotation must still lose the locked CAS.
      await expect(
        sessionsRepo.reserveDeletionCredential(sessionId, operationId, fresh.tokenFingerprint, {
          tokenFingerprint: old.tokenFingerprint,
          runId: null,
        })
      ).rejects.toThrow(/changed during recovery/);
      await sessionsRepo.reserveDeletionCredential(sessionId, operationId, fresh.tokenFingerprint, {
        tokenFingerprint: old.tokenFingerprint,
        runId: old.runId,
      });
      expect(await sessionsRepo.getDeletionCredentialState(sessionId, operationId)).toEqual({
        tokenFingerprint: fresh.tokenFingerprint,
        runId: old.runId,
      });
      await expect(
        ledger.acknowledgeSessionDelete(
          sessionId,
          operationId,
          [],
          { outcome: 'deleted' },
          undefined,
          old
        )
      ).rejects.toThrow(/stale invocation/);
      const restarted = new OpenCodeCheckpointAttemptRepository(dbA);
      await expect(
        restarted.prepareSessionDeleteFiles(sessionId, operationId, undefined, old)
      ).rejects.toThrow(/invocation/);
      await restarted.prepareSessionDeleteFiles(sessionId, operationId, undefined, fresh);
      await restarted.acknowledgeSessionDelete(
        sessionId,
        operationId,
        [],
        { outcome: 'deleted' },
        undefined,
        fresh
      );
      await new OpenCodeCheckpointAttemptRepository(dbA).acknowledgeSessionDelete(
        sessionId,
        operationId,
        [],
        { outcome: 'deleted' },
        undefined,
        fresh
      );
      await expect(
        restarted.acknowledgeSessionDelete(
          sessionId,
          operationId,
          [],
          { outcome: 'deleted' },
          undefined,
          old
        )
      ).rejects.toThrow(/stale invocation/);
      expect((await sessionsRepo.findById(sessionId))?.sdk_native_state_deletion_status).toBe(
        'state_cleared'
      );
    });
    it.each(['regressed', 'missing', 'native-id'] as const)(
      'rechecks admitted lineage at completion and cleanup: %s',
      async (corruption) => {
        const { ownerId, sessionId } = await createManagedSession();
        const ledger = new OpenCodeCheckpointAttemptRepository(dbA);
        const taskRepo = new TaskRepository(dbA);
        const storeId = generateId();
        const admit = async (
          input?: { storeId: string; attemptTaskId: string },
          nativeId = 'ses_lineage'
        ) => {
          const task = await createManagedTask(sessionId, ownerId);
          const holder = generateId();
          const grant = await ledger.begin({
            taskId: task.task_id,
            holderInstanceId: holder,
            storeId,
            binding: binding(sessionId, task.task_id, ownerId, storeId, holder),
          });
          expect(grant.outcome).toBe('admitted');
          if (input)
            await ledger.closeRead(task.task_id, holder, { storeId, taskId: input.attemptTaskId });
          const manifest = {
            version: 3 as const,
            storeId,
            openCodeVersion: '1.18.31',
            attemptTaskId: task.task_id,
            digest: `sha256:${'b'.repeat(64)}`,
            bytes: 4096,
            openCodeSessionId: nativeId,
            publishedAt: new Date().toISOString(),
          };
          await ledger.seal(task.task_id, holder, manifest);
          return { task, holder, manifest };
        };
        const complete = (v: Awaited<ReturnType<typeof admit>>) =>
          taskRepo.completeWithNativeStatePublication(
            v.task.task_id,
            { status: TaskStatus.COMPLETED, native_state_attempt: v.manifest },
            v.holder
          );
        const a = await admit();
        await complete(a);
        const b = await admit(a.manifest);
        await complete(b);
        const c = await admit(b.manifest, corruption === 'native-id' ? 'ses_other' : 'ses_lineage');
        if (corruption !== 'native-id') {
          const row = await select(dbA)
            .from(sessions)
            .where(eq(sessions.session_id, sessionId))
            .one();
          if (!row) throw new Error('Session missing');
          const data = { ...row.data };
          if (corruption === 'missing') delete data.sdk_native_state;
          else data.sdk_native_state = a.manifest;
          await update(dbA, sessions).set({ data }).where(eq(sessions.session_id, sessionId)).run();
          await expect(ledger.prepareCleanup(c.task.task_id, c.holder)).rejects.toThrow(/lineage/);
          expect(
            (
              await select(dbA)
                .from(opencodeCheckpointAttempts)
                .where(eq(opencodeCheckpointAttempts.task_id, b.task.task_id))
                .one()
            )?.retired_at
          ).toBeNull();
        }
        await expect(complete(c)).rejects.toThrow(/lineage|exact admitted input/);
        expect((await taskRepo.findById(c.task.task_id))?.status).toBe(TaskStatus.RUNNING);
      }
    );

    it('requires the branch Task actor in checkpoint bindings on PostgreSQL', async () => {
      const { ownerId, sessionId } = await createManagedSession(dbA, 'branch');
      const actorId = generateId() as UUID;
      await new UsersRepository(dbA).create({
        user_id: actorId,
        email: `opencode-actor-${actorId}@example.invalid`,
        role: 'member',
      });
      const task = await createManagedTask(sessionId, ownerId, dbA, actorId);
      const repo = new OpenCodeCheckpointAttemptRepository(dbA);
      const storeId = generateId();
      const holderId = generateId();
      await expect(
        repo.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: binding(sessionId, task.task_id, ownerId, storeId, holderId),
        })
      ).rejects.toThrow(/binding does not match/);
      await expect(
        repo.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: binding(sessionId, task.task_id, actorId, storeId, holderId),
        })
      ).resolves.toMatchObject({ outcome: 'admitted' });
      const attempt = await select(dbA)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, task.task_id))
        .one();
      expect(attempt?.owner_user_id).toBe(ownerId);
      expect(attempt?.binding.ownerUserId).toBe(actorId);
      await expect(
        new TaskRepository(dbA).assertManagedExecutorHolder(task.task_id, holderId)
      ).resolves.toBeUndefined();
    });

    it('persists and protects the managed Session layout marker on PostgreSQL', async () => {
      const { ownerId, sessionId } = await createManagedSession();
      const task = await createManagedTask(sessionId, ownerId);
      const attempts = new OpenCodeCheckpointAttemptRepository(dbA);
      const storeId = generateId();
      const holderId = generateId();
      const request = {
        taskId: task.task_id,
        holderInstanceId: holderId,
        storeId,
        binding: binding(sessionId, task.task_id, ownerId, storeId, holderId),
      };
      await expect(attempts.begin(request)).resolves.toMatchObject({ outcome: 'admitted' });

      const admittedSession = await select(dbA)
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one();
      expect(admittedSession?.data.sdk_native_state_layout).toBe('session_root_v1');
      expect(await new SessionRepository(dbA).findById(sessionId)).not.toHaveProperty(
        'sdk_native_state_layout'
      );
      await new SessionRepository(dbA).update(sessionId, { title: 'marker preserved' });
      const patchedSession = await select(dbA)
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one();
      expect(patchedSession?.data.sdk_native_state_layout).toBe('session_root_v1');
      if (!patchedSession) throw new Error('Session missing');

      await update(dbA, sessions)
        .set({
          data: { ...patchedSession.data, sdk_native_state_layout: 'session_root_v2' as never },
        })
        .where(eq(sessions.session_id, sessionId))
        .run();
      await expect(attempts.begin(request)).resolves.toEqual({
        outcome: 'rejected',
        code: 'legacy_state',
      });

      const unknownMarker = await select(dbA)
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one();
      if (!unknownMarker) throw new Error('Session missing');
      const { sdk_native_state_layout: _layout, ...unmarkedData } = unknownMarker.data;
      await update(dbA, sessions)
        .set({ data: unmarkedData })
        .where(eq(sessions.session_id, sessionId))
        .run();
      await expect(attempts.begin(request)).resolves.toEqual({
        outcome: 'rejected',
        code: 'legacy_state',
      });
    });

    it('clears only each explicitly closed Session on PostgreSQL', async () => {
      const root = await createManagedSession();
      const rootTask = await createManagedTask(root.sessionId, root.ownerId);
      const sessionsRepo = new SessionRepository(dbA);
      const child = await sessionsRepo.create({
        session_id: generateId(),
        branch_id: root.branchId,
        agentic_tool: 'opencode',
        created_by: root.ownerId,
        genealogy: { parent_session_id: root.sessionId, children: [] },
      });
      const childTask = await createManagedTask(child.session_id, root.ownerId);
      await expect(sessionsRepo.claimDeletionTree(root.sessionId)).rejects.toThrow(
        /unfinished tasks/
      );
      const ledger = new OpenCodeCheckpointAttemptRepository(dbA);
      const publish = async (sessionId: string, taskId: string) => {
        const storeId = generateId();
        const holderId = generateId();
        const grant = await ledger.begin({
          taskId,
          holderInstanceId: holderId,
          storeId,
          binding: binding(sessionId, taskId, root.ownerId, storeId, holderId),
        });
        if (grant.outcome !== 'admitted') throw new Error('holder was not admitted');
        const manifest = {
          version: 3 as const,
          storeId,
          openCodeVersion: '1.18.31',
          attemptTaskId: taskId,
          digest: `sha256:${'a'.repeat(64)}`,
          bytes: 4096,
          openCodeSessionId: 'ses_pg_delete',
          publishedAt: new Date().toISOString(),
        };
        await ledger.seal(taskId, holderId, manifest);
        await new TaskRepository(dbA).completeWithNativeStatePublication(
          taskId,
          { status: TaskStatus.COMPLETED, native_state_attempt: manifest },
          holderId
        );
        return grant.attempt.attempt_id;
      };
      const rootAttempt = await publish(root.sessionId, rootTask.task_id);
      const childAttempt = await publish(child.session_id, childTask.task_id);
      const claims = await sessionsRepo.claimDeletionTree(root.sessionId);
      const rootClaim = claims.find((claim) => claim.sessionId === root.sessionId)!;
      const childClaim = claims.find((claim) => claim.sessionId === child.session_id)!;
      const taskRepo = new TaskRepository(dbA);
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
      const close = async (sessionId: string, operationId: string, attemptId: string) => {
        const holderBinding = await ledger.reserveSessionDeleteObservation(
          sessionId,
          operationId,
          attemptId
        );
        if (!holderBinding) throw new Error('holder was already closed');
        await ledger.recordSessionDeleteObservation(
          sessionId,
          operationId,
          attemptId,
          holderBinding,
          'verified_closed'
        );
        return ledger.prepareSessionDeleteFiles(sessionId, operationId);
      };
      const rootFiles = await close(root.sessionId, rootClaim.operationId, rootAttempt);
      await ledger.acknowledgeSessionDelete(root.sessionId, rootClaim.operationId, rootFiles, {
        outcome: 'deleted',
      });
      const childBeforeAck = await select(dbA)
        .from(sessions)
        .where(eq(sessions.session_id, child.session_id))
        .one();
      expect(childBeforeAck?.data[OPENCODE_SESSION_DELETE_DATA_KEY]).toMatchObject({
        operation_id: childClaim.operationId,
        status: 'pending',
      });
      await expect(
        select(dbA)
          .from(opencodeCheckpointAttempts)
          .where(eq(opencodeCheckpointAttempts.attempt_id, childAttempt))
          .one()
      ).resolves.toBeDefined();
      const childFiles = await close(child.session_id, childClaim.operationId, childAttempt);
      await ledger.acknowledgeSessionDelete(child.session_id, childClaim.operationId, childFiles, {
        outcome: 'deleted',
      });
      const childAfter = await select(dbA)
        .from(sessions)
        .where(eq(sessions.session_id, child.session_id))
        .one();
      expect(childAfter?.data[OPENCODE_SESSION_DELETE_DATA_KEY]).toMatchObject({
        operation_id: childClaim.operationId,
        status: 'state_cleared',
      });
      await expect(sessionsRepo.findById(root.sessionId)).resolves.toBeDefined();
      await expect(
        sessionsRepo.assertNativeStateHandoffClear(root.sessionId)
      ).resolves.toBeUndefined();
    });

    it('allows deletion of a verified-closed co-prompter with the accepted checkpoint retained', async () => {
      const { ownerId, sessionId } = await createManagedSession(dbA, 'branch');
      const actorId = generateId() as UUID;
      await new UsersRepository(dbA).create({
        user_id: actorId,
        email: `opencode-closed-actor-${actorId}@example.invalid`,
        role: 'member',
      });
      const task = await createManagedTask(sessionId, ownerId, dbA, actorId);
      const attempts = new OpenCodeCheckpointAttemptRepository(dbA);
      const taskRepo = new TaskRepository(dbA);
      const storeId = generateId();
      const holderId = generateId();
      await expect(
        attempts.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: binding(sessionId, task.task_id, actorId, storeId, holderId),
        })
      ).resolves.toMatchObject({ outcome: 'admitted' });
      const output = {
        version: 3 as const,
        storeId,
        openCodeVersion: '1.18.31',
        attemptTaskId: task.task_id,
        digest: `sha256:${'a'.repeat(64)}`,
        bytes: 4096,
        openCodeSessionId: 'ses_pg_actor',
        publishedAt: new Date().toISOString(),
      };
      await attempts.seal(task.task_id, holderId, output);
      await taskRepo.completeWithNativeStatePublication(
        task.task_id,
        { status: TaskStatus.COMPLETED, native_state_attempt: output },
        holderId
      );
      await expect(new UsersRepository(dbA).delete(actorId)).rejects.toThrow(
        /opencode_native_state_handoff_required/
      );
      await update(dbA, opencodeCheckpointAttempts)
        .set({ holder_closed_observed_at: new Date() })
        .where(eq(opencodeCheckpointAttempts.task_id, task.task_id))
        .run();
      await expect(new UsersRepository(dbA).delete(actorId)).resolves.toBeUndefined();

      const next = await createManagedTask(sessionId, ownerId);
      const nextHolder = generateId();
      await expect(
        attempts.begin({
          taskId: next.task_id,
          holderInstanceId: nextHolder,
          storeId,
          binding: binding(sessionId, next.task_id, ownerId, storeId, nextHolder),
        })
      ).resolves.toMatchObject({ outcome: 'admitted', input: output });
    });

    it('keeps actor deletion blocked when the closed checkpoint binding is mismatched', async () => {
      const { ownerId, sessionId } = await createManagedSession(dbA, 'branch');
      const actorId = generateId() as UUID;
      await new UsersRepository(dbA).create({
        user_id: actorId,
        email: `opencode-mismatched-actor-${actorId}@example.invalid`,
        role: 'member',
      });
      const task = await createManagedTask(sessionId, ownerId, dbA, actorId);
      const attempts = new OpenCodeCheckpointAttemptRepository(dbA);
      const storeId = generateId();
      const holderId = generateId();
      const actorBinding = binding(sessionId, task.task_id, actorId, storeId, holderId);
      await expect(
        attempts.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: actorBinding,
        })
      ).resolves.toMatchObject({ outcome: 'admitted' });
      await update(dbA, taskRows)
        .set({ status: TaskStatus.COMPLETED, completed_at: new Date() })
        .where(eq(taskRows.task_id, task.task_id))
        .run();
      await update(dbA, opencodeCheckpointAttempts)
        .set({
          binding: { ...actorBinding, ownerUserId: ownerId },
          holder_closed_observed_at: new Date(),
          write_state: 'sealed',
        })
        .where(eq(opencodeCheckpointAttempts.task_id, task.task_id))
        .run();

      await expect(new UsersRepository(dbA).delete(actorId)).rejects.toThrow(
        /opencode_native_state_handoff_required/
      );
    });

    it('does not let another tenant checkpoint block actor deletion', async () => {
      const actor = await new UsersRepository(dbA).create({
        email: `opencode-other-tenant-actor-${generateId()}@example.invalid`,
        role: 'member',
      });
      await runWithTenantDatabaseScope(dbA, 'other-tenant', async (scoped) => {
        const { ownerId, sessionId } = await createManagedSession(scoped);
        const task = await new TaskRepository(scoped).create({
          task_id: generateId(),
          session_id: sessionId,
          created_by: ownerId,
          full_prompt: 'other tenant checkpoint',
          status: TaskStatus.DISPATCHING,
          message_range: {
            start_index: 0,
            end_index: 0,
            start_timestamp: new Date().toISOString(),
          },
          git_state: { ref_at_start: 'main', sha_at_start: 'other-tenant' },
        });
        const storeId = generateId();
        const holderId = generateId();
        const bindingForOtherTenant = binding(
          sessionId,
          task.task_id,
          ownerId,
          storeId,
          holderId,
          'other-tenant'
        );
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
            binding: { ...bindingForOtherTenant, ownerUserId: actor.user_id },
            write_state: 'open',
            created_at: new Date(),
            updated_at: new Date(),
          })
          .run();
      });

      await expect(new UsersRepository(dbA).delete(actor.user_id)).resolves.toBeUndefined();
    });

    it('rejects observation and closure when a branch attempt carries another Task actor', async () => {
      const { ownerId, sessionId } = await createManagedSession(dbA, 'branch');
      const actorId = generateId() as UUID;
      await new UsersRepository(dbA).create({
        user_id: actorId,
        email: `opencode-observe-actor-${actorId}@example.invalid`,
        role: 'member',
      });
      const targetTask = await createManagedTask(sessionId, ownerId, dbA, actorId);
      const attempts = new OpenCodeCheckpointAttemptRepository(dbA);
      const storeId = generateId();
      const targetHolder = generateId();
      const targetBinding = binding(sessionId, targetTask.task_id, actorId, storeId, targetHolder);
      const admitted = await attempts.begin({
        taskId: targetTask.task_id,
        holderInstanceId: targetHolder,
        storeId,
        binding: targetBinding,
      });
      if (admitted.outcome !== 'admitted') throw new Error('target holder was not admitted');
      await update(dbA, taskRows)
        .set({ status: TaskStatus.FAILED, completed_at: new Date() })
        .where(eq(taskRows.task_id, targetTask.task_id))
        .run();

      const collectorTask = await createManagedTask(sessionId, ownerId);
      const collectorHolder = generateId();
      const collectorBinding = binding(
        sessionId,
        collectorTask.task_id,
        ownerId,
        storeId,
        collectorHolder
      );
      const collector = await attempts.begin({
        taskId: collectorTask.task_id,
        holderInstanceId: collectorHolder,
        storeId,
        binding: collectorBinding,
      });
      if (collector.outcome !== 'admitted') throw new Error('collector holder was not admitted');
      await expect(
        attempts.prepareCleanup(collectorTask.task_id, collectorHolder)
      ).resolves.toMatchObject({ kind: 'observe', attemptId: admitted.attempt.attempt_id });

      await update(dbA, opencodeCheckpointAttempts)
        .set({ binding: { ...targetBinding, ownerUserId: ownerId } })
        .where(eq(opencodeCheckpointAttempts.attempt_id, admitted.attempt.attempt_id))
        .run();
      await expect(
        attempts.loadObservationBinding(
          collectorTask.task_id,
          collectorHolder,
          admitted.attempt.attempt_id
        )
      ).rejects.toThrow(/no longer eligible/);
      await expect(
        attempts.recordHolderObservation(
          collectorTask.task_id,
          collectorHolder,
          admitted.attempt.attempt_id,
          'verified_closed'
        )
      ).rejects.toThrow(/actor binding is not authoritative/);
      await expect(
        select(dbA)
          .from(opencodeCheckpointAttempts)
          .where(eq(opencodeCheckpointAttempts.attempt_id, admitted.attempt.attempt_id))
          .one()
      ).resolves.toMatchObject({ holder_closed_observed_at: null });
    });

    it('serializes two independent database connections to one immutable admitted holder', async () => {
      const { ownerId, sessionId } = await createManagedSession();
      const task = await createManagedTask(sessionId, ownerId);
      const storeId = generateId();
      const holderA = generateId();
      const holderB = generateId();
      const first = new OpenCodeCheckpointAttemptRepository(dbA);
      const second = new OpenCodeCheckpointAttemptRepository(dbB);
      const results = await Promise.all([
        first.begin({
          taskId: task.task_id,
          holderInstanceId: holderA,
          storeId,
          binding: binding(sessionId, task.task_id, ownerId, storeId, holderA),
        }),
        second.begin({
          taskId: task.task_id,
          holderInstanceId: holderB,
          storeId,
          binding: binding(sessionId, task.task_id, ownerId, storeId, holderB),
        }),
      ]);

      expect(results.filter((result) => result.outcome === 'admitted')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'rejected')).toEqual([
        { outcome: 'rejected', code: 'already_admitted' },
      ]);
      const winner = results.find((result) => result.outcome === 'admitted');
      if (winner?.outcome !== 'admitted') throw new Error('No holder was admitted');
      expect([holderA, holderB]).toContain(winner.attempt.holder_instance_id);
      await expect(
        first.begin({
          taskId: task.task_id,
          holderInstanceId: winner.attempt.holder_instance_id,
          storeId,
          binding: binding(
            sessionId,
            task.task_id,
            ownerId,
            storeId,
            winner.attempt.holder_instance_id
          ),
        })
      ).resolves.toMatchObject({ outcome: 'rejected', code: 'already_admitted' });
    });

    it('replays a response-lost exact holder across connections after Stop without new admission', async () => {
      const { ownerId, sessionId } = await createManagedSession();
      const task = await createManagedTask(sessionId, ownerId);
      const storeId = generateId();
      const holderId = generateId();
      const immutable = binding(sessionId, task.task_id, ownerId, storeId, holderId);
      const first = new OpenCodeCheckpointAttemptRepository(dbA);
      const second = new OpenCodeCheckpointAttemptRepository(dbB);
      await expect(
        first.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: immutable,
        })
      ).resolves.toMatchObject({ outcome: 'admitted' });
      await new TaskRepository(dbA).claimTermination({
        taskId: task.task_id,
        cause: 'user_stop',
        errorMessage: 'Stopped',
      });
      await expect(
        second.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: immutable,
        })
      ).resolves.toMatchObject({ outcome: 'admitted' });
      const rows = await select(dbA)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, task.task_id))
        .all();
      expect(rows).toHaveLength(1);
      await second.abandon(task.task_id, holderId);
      await expect(
        new TaskRepository(dbA).recordExecutorQuiescence({
          task_id: task.task_id,
          requested_at: (await new TaskRepository(dbA).findById(task.task_id))!.termination_request!
            .requested_at,
          holder_instance_id: holderId,
        })
      ).resolves.toMatchObject({ status: TaskStatus.STOPPING });
    });

    it('keeps a tenant-owned ledger invisible and unmodifiable from another PostgreSQL tenant', async () => {
      const tenantA = `checkpoint-a-${generateId()}`;
      const tenantB = `checkpoint-b-${generateId()}`;
      const foreign = await runWithTenantDatabaseScope(dbA, tenantA, async (scoped) => {
        const { ownerId, sessionId } = await createManagedSession(scoped);
        const task = await createManagedTask(sessionId, ownerId, scoped);
        const storeId = generateId();
        const holderId = generateId();
        const ledger = new OpenCodeCheckpointAttemptRepository(scoped);
        const admitted = await ledger.begin({
          taskId: task.task_id,
          holderInstanceId: holderId,
          storeId,
          binding: binding(sessionId, task.task_id, ownerId, storeId, holderId, tenantA),
        });
        expect(admitted.outcome).toBe('admitted');
        return { ownerId, sessionId, taskId: task.task_id, storeId, holderId };
      });

      await runWithTenantDatabaseScope(dbB, tenantB, async (scoped) => {
        const ledger = new OpenCodeCheckpointAttemptRepository(scoped);
        expect(
          await select(scoped)
            .from(opencodeCheckpointAttempts)
            .where(eq(opencodeCheckpointAttempts.task_id, foreign.taskId))
            .all()
        ).toEqual([]);
        expect(await new TaskRepository(scoped).findById(foreign.taskId)).toBeNull();
        await expect(
          ledger.begin({
            taskId: foreign.taskId,
            holderInstanceId: foreign.holderId,
            storeId: foreign.storeId,
            binding: binding(
              foreign.sessionId,
              foreign.taskId,
              foreign.ownerId,
              foreign.storeId,
              foreign.holderId,
              tenantB
            ),
          })
        ).rejects.toThrow();
        await expect(
          ledger.closeRead(foreign.taskId, foreign.holderId, {
            storeId: foreign.storeId,
            taskId: foreign.taskId,
          })
        ).rejects.toThrow();
        await expect(ledger.abandon(foreign.taskId, foreign.holderId)).rejects.toThrow();
        await expect(ledger.prepareCleanup(foreign.taskId, foreign.holderId)).rejects.toThrow();
        await expect(
          ledger.acknowledgeDelete(
            foreign.taskId,
            foreign.holderId,
            { storeId: foreign.storeId, taskId: foreign.taskId },
            { outcome: 'deleted' }
          )
        ).rejects.toThrow();
      });

      await runWithTenantDatabaseScope(dbA, tenantA, async (scoped) => {
        expect(
          await select(scoped)
            .from(opencodeCheckpointAttempts)
            .where(eq(opencodeCheckpointAttempts.task_id, foreign.taskId))
            .all()
        ).toHaveLength(1);
      });
    });

    it('rejects a completed checkpoint whose Session pointer was removed by an older writer', async () => {
      const { ownerId, sessionId } = await createManagedSession();
      const task = await createManagedTask(sessionId, ownerId);
      const storeId = generateId();
      const holderId = generateId();
      const attempts = new OpenCodeCheckpointAttemptRepository(dbA);
      const granted = await attempts.begin({
        taskId: task.task_id,
        holderInstanceId: holderId,
        storeId,
        binding: binding(sessionId, task.task_id, ownerId, storeId, holderId),
      });
      if (granted.outcome !== 'admitted') throw new Error('holder was not admitted');
      const published = {
        version: 3 as const,
        storeId,
        attemptTaskId: task.task_id,
        digest: `sha256:${'d'.repeat(64)}`,
        bytes: 1024,
        openCodeSessionId: 'pg-lost-pointer',
        openCodeVersion: '1.18.31',
        publishedAt: new Date().toISOString(),
      };
      await attempts.seal(task.task_id, holderId, published);
      await new TaskRepository(dbA).completeWithNativeStatePublication(
        task.task_id,
        { status: TaskStatus.COMPLETED, native_state_attempt: published },
        holderId
      );
      const before = await select(dbA)
        .from(sessions)
        .where(eq(sessions.session_id, sessionId))
        .one();
      if (!before) throw new Error('Session missing');
      const {
        sdk_native_state: _pointer,
        sdk_native_state_store_id: _storeId,
        sdk_native_state_layout: _layout,
        ...oldWriterData
      } = before.data;
      await update(dbA, sessions)
        .set({ data: oldWriterData })
        .where(eq(sessions.session_id, sessionId))
        .run();
      const next = await createManagedTask(sessionId, ownerId);
      const nextHolder = generateId();
      const request = {
        taskId: next.task_id,
        holderInstanceId: nextHolder,
        storeId,
        binding: binding(sessionId, next.task_id, ownerId, storeId, nextHolder),
      };
      await expect(attempts.begin(request)).resolves.toEqual({
        outcome: 'rejected',
        code: 'legacy_state',
      });
      await update(dbA, sessions)
        .set({ data: { ...oldWriterData, sdk_native_state_store_id: storeId } })
        .where(eq(sessions.session_id, sessionId))
        .run();
      await expect(attempts.begin(request)).resolves.toEqual({
        outcome: 'rejected',
        code: 'legacy_state',
      });
    });

    it('serializes completion against cleanup so a published attempt cannot be retired', async () => {
      const { ownerId, sessionId } = await createManagedSession();
      const task = await createManagedTask(sessionId, ownerId);
      const storeId = generateId();
      const holderId = generateId();
      const bindingValue = binding(sessionId, task.task_id, ownerId, storeId, holderId);
      const attemptsA = new OpenCodeCheckpointAttemptRepository(dbA);
      const attemptsB = new OpenCodeCheckpointAttemptRepository(dbB);
      const grant = await attemptsA.begin({
        taskId: task.task_id,
        holderInstanceId: holderId,
        storeId,
        binding: bindingValue,
      });
      if (grant.outcome !== 'admitted') throw new Error('holder was not admitted');
      const published = {
        version: 3 as const,
        storeId,
        attemptTaskId: task.task_id,
        digest: `sha256:${'e'.repeat(64)}`,
        bytes: 1024,
        openCodeSessionId: 'pg-race',
        openCodeVersion: '1.18.31',
        publishedAt: new Date().toISOString(),
      };
      await attemptsA.seal(task.task_id, holderId, published);

      const [completion, cleanup] = await Promise.allSettled([
        new TaskRepository(dbA).completeWithNativeStatePublication(
          task.task_id,
          {
            status: TaskStatus.COMPLETED,
            native_state_attempt: published,
          },
          holderId
        ),
        attemptsB.prepareCleanup(task.task_id, holderId),
      ]);
      expect(completion.status).toBe('fulfilled');
      const saved = await select(dbA)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, task.task_id))
        .one();
      expect(saved?.retired_at).toBeNull();
      if (cleanup.status === 'fulfilled') {
        expect(cleanup.value).not.toEqual({
          kind: 'delete',
          object: { storeId, taskId: task.task_id },
        });
      }
    });

    it('serializes a reader close against retirement and never deletes an open input', async () => {
      const { ownerId, sessionId } = await createManagedSession();
      const firstTask = await createManagedTask(sessionId, ownerId);
      const storeId = generateId();
      const firstHolder = generateId();
      const firstBinding = binding(sessionId, firstTask.task_id, ownerId, storeId, firstHolder);
      const attemptsA = new OpenCodeCheckpointAttemptRepository(dbA);
      const attemptsB = new OpenCodeCheckpointAttemptRepository(dbB);
      const first = await attemptsA.begin({
        taskId: firstTask.task_id,
        holderInstanceId: firstHolder,
        storeId,
        binding: firstBinding,
      });
      if (first.outcome !== 'admitted') throw new Error('first holder was not admitted');
      const firstManifest = {
        version: 3 as const,
        storeId,
        attemptTaskId: firstTask.task_id,
        digest: `sha256:${'f'.repeat(64)}`,
        bytes: 1024,
        openCodeSessionId: 'pg-reader-race',
        openCodeVersion: '1.18.31',
        publishedAt: new Date().toISOString(),
      };
      await attemptsA.seal(firstTask.task_id, firstHolder, firstManifest);
      await new TaskRepository(dbA).completeWithNativeStatePublication(
        firstTask.task_id,
        {
          status: TaskStatus.COMPLETED,
          native_state_attempt: firstManifest,
        },
        firstHolder
      );

      const slowReader = await createManagedTask(sessionId, ownerId);
      const slowHolder = generateId();
      const slow = await attemptsA.begin({
        taskId: slowReader.task_id,
        holderInstanceId: slowHolder,
        storeId,
        binding: binding(sessionId, slowReader.task_id, ownerId, storeId, slowHolder),
      });
      if (slow.outcome !== 'admitted' || !slow.input || slow.input.version !== 3) {
        throw new Error('slow reader was not admitted to a coordinated v3 input');
      }
      expect(slow.input.attemptTaskId).toBe(firstTask.task_id);
      await update(dbA, taskRows)
        .set({ status: TaskStatus.FAILED, completed_at: new Date() })
        .where(eq(taskRows.task_id, slowReader.task_id))
        .run();

      const publisher = await createManagedTask(sessionId, ownerId);
      const publisherHolder = generateId();
      const next = await attemptsA.begin({
        taskId: publisher.task_id,
        holderInstanceId: publisherHolder,
        storeId,
        binding: binding(sessionId, publisher.task_id, ownerId, storeId, publisherHolder),
      });
      if (next.outcome !== 'admitted' || !next.input || next.input.version !== 3) {
        throw new Error('publisher did not pin accepted v3 state');
      }
      await attemptsA.closeRead(publisher.task_id, publisherHolder, {
        storeId: next.input.storeId,
        taskId: next.input.attemptTaskId,
      });
      await expect(
        attemptsA.begin({
          taskId: publisher.task_id,
          holderInstanceId: publisherHolder,
          storeId,
          binding: binding(sessionId, publisher.task_id, ownerId, storeId, publisherHolder),
        })
      ).resolves.toMatchObject({ outcome: 'rejected', code: 'already_admitted' });
      const nextManifest = {
        ...firstManifest,
        attemptTaskId: publisher.task_id,
        digest: `sha256:${'1'.repeat(64)}`,
        publishedAt: new Date().toISOString(),
      };
      await attemptsA.seal(publisher.task_id, publisherHolder, nextManifest);
      await new TaskRepository(dbA).completeWithNativeStatePublication(
        publisher.task_id,
        {
          status: TaskStatus.COMPLETED,
          native_state_attempt: nextManifest,
        },
        publisherHolder
      );

      const collector = await createManagedTask(sessionId, ownerId);
      const collectorHolder = generateId();
      const collection = await attemptsA.begin({
        taskId: collector.task_id,
        holderInstanceId: collectorHolder,
        storeId,
        binding: binding(sessionId, collector.task_id, ownerId, storeId, collectorHolder),
      });
      if (collection.outcome !== 'admitted') throw new Error('collector was not admitted');

      const [, work] = await Promise.all([
        attemptsA.closeRead(slowReader.task_id, slowHolder, {
          storeId: slow.input.storeId,
          taskId: firstTask.task_id,
        }),
        attemptsB.prepareCleanup(collector.task_id, collectorHolder),
      ]);
      const old = await select(dbA)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, firstTask.task_id))
        .one();
      const reader = await select(dbA)
        .from(opencodeCheckpointAttempts)
        .where(eq(opencodeCheckpointAttempts.task_id, slowReader.task_id))
        .one();
      if (old?.retired_at) {
        expect(work).toEqual({ kind: 'delete', object: { storeId, taskId: firstTask.task_id } });
        expect(reader?.input_read_closed_at).not.toBeNull();
      } else {
        expect(reader?.input_read_closed_at).not.toBeNull();
        expect(work.kind).not.toBe('delete');
      }
    });
  }
);
