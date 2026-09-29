import { createHash } from 'node:crypto';
import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  eq,
  generateId,
  OpenCodeCheckpointAttemptRepository,
  OpenCodeNativeStateHandoffRequiredError,
  RepoRepository,
  SessionRepository,
  select,
  TaskRepository,
  update,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { UUID } from '@agor/core/types';
import {
  OPENCODE_SESSION_DELETE_DATA_KEY,
  OPENCODE_SESSION_STATE_DELETE_COMMAND,
  TaskStatus,
} from '@agor/core/types';
import { beforeEach, describe, expect, vi } from 'vitest';
import { sessions } from '../../../../packages/core/src/db/schema';
import { runWithTenantDatabaseScope } from '../../../../packages/core/src/db/tenant-scope';
import {
  dbTest,
  ensureTestUser,
  setTestBranchUserRole,
} from '../../../../packages/core/src/db/test-helpers';

const mocks = vi.hoisted(() => ({
  getDaemonUrl: vi.fn(() => 'http://daemon.invalid'),
  issueExecutorCommandToken: vi.fn(),
  requestExecutor: vi.fn(),
}));

vi.mock('../utils/spawn-executor.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../utils/spawn-executor.js');
  return {
    ...actual,
    getDaemonUrl: mocks.getDaemonUrl,
    requestExecutor: mocks.requestExecutor,
  };
});
vi.mock('./session-token-service.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./session-token-service.js');
  return { ...actual, issueExecutorCommandToken: mocks.issueExecutorCommandToken };
});

import { SessionsService } from './sessions';

async function createOpenCodeBranch(db: Parameters<typeof ensureTestUser>[0], actorId: UUID) {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `session-delete-${generateId()}`,
    name: 'Session deletion retry',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/session-delete.git',
    local_path: '/tmp/session-delete',
    default_branch: 'main',
  });
  return new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'session-delete',
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1_000_000_000),
    path: '/tmp/session-delete',
    created_by: actorId,
  });
}

describe('SessionsService explicit native-state deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let tokenNumber = 0;
    mocks.issueExecutorCommandToken.mockImplementation(async () => `fresh-token-${++tokenNumber}`);
  });

  dbTest(
    'scheduled retention refuses native state before creating a deletion fence',
    async ({ db }) => {
      const ownerId = generateId();
      await ensureTestUser(db, ownerId);
      const branch = await createOpenCodeBranch(db, ownerId);
      const session = await new SessionRepository(db).create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'opencode',
        created_by: ownerId,
      });
      const row = await select(db).from(sessions).one();
      if (!row) throw new Error('Session row missing');
      await update(db, sessions)
        .set({
          data: {
            ...row.data,
            sdk_native_state_layout: 'session_root_v1',
            sdk_native_state_store_id: generateId(),
          },
        })
        .run();
      const app = { service: () => ({ emit: vi.fn() }) } as unknown as Application;
      const service = new SessionsService(
        createTenantScopedDatabaseProxy(db, { requireScope: false }),
        app
      );

      await expect(
        service.remove(session.session_id, {
          provider: undefined,
          tenant: { tenant_id: 'default' },
        } as never)
      ).rejects.toBeInstanceOf(OpenCodeNativeStateHandoffRequiredError);

      const retained = await new SessionRepository(db).findById(session.session_id);
      expect(retained).not.toBeNull();
      expect(retained?.sdk_native_state_deletion_status).toBeUndefined();
      expect(
        (await select(db).from(sessions).one())?.data[OPENCODE_SESSION_DELETE_DATA_KEY]
      ).toBeUndefined();
      expect(mocks.issueExecutorCommandToken).not.toHaveBeenCalled();
      expect(mocks.requestExecutor).not.toHaveBeenCalled();
    }
  );

  dbTest(
    'requires native-state handoff before fencing unmarked pointer and store-only Sessions',
    async ({ db }) => {
      const ownerId = generateId();
      await ensureTestUser(db, ownerId);
      const branch = await createOpenCodeBranch(db, ownerId);
      const nativeState = {
        version: 3 as const,
        attemptTaskId: generateId(),
        storeId: generateId(),
        digest: `sha256:${'a'.repeat(64)}`,
        bytes: 1,
        openCodeSessionId: 'legacy-session-id',
        openCodeVersion: '1.18.31',
        publishedAt: new Date().toISOString(),
      };
      const legacyState = [
        { sdk_native_state: nativeState },
        { sdk_native_state_store_id: generateId() },
      ];
      const repository = new SessionRepository(db);

      for (const data of legacyState) {
        const session = await repository.create({
          session_id: generateId(),
          branch_id: branch.branch_id,
          agentic_tool: 'opencode',
          created_by: ownerId,
        });
        const before = await select(db)
          .from(sessions)
          .where(eq(sessions.session_id, session.session_id))
          .one();
        if (!before) throw new Error('Session row missing');
        await update(db, sessions)
          .set({ data: { ...before.data, ...data } })
          .where(eq(sessions.session_id, session.session_id))
          .run();

        await expect(repository.claimDeletionTree(session.session_id)).rejects.toBeInstanceOf(
          OpenCodeNativeStateHandoffRequiredError
        );

        const after = await select(db)
          .from(sessions)
          .where(eq(sessions.session_id, session.session_id))
          .one();
        expect(after?.data).toMatchObject(data);
        expect(after?.data[OPENCODE_SESSION_DELETE_DATA_KEY]).toBeUndefined();
      }
    }
  );

  dbTest('ordinary Branch deletion permission still gates a different remover', async ({ db }) => {
    const ownerId = generateId();
    const removerId = generateId();
    await ensureTestUser(db, ownerId);
    await ensureTestUser(db, removerId);
    const branch = await createOpenCodeBranch(db, ownerId);
    const session = await new SessionRepository(db).create({
      session_id: generateId(),
      branch_id: branch.branch_id,
      agentic_tool: 'opencode',
      created_by: ownerId,
    });
    const row = await select(db).from(sessions).one();
    if (!row) throw new Error('Session row missing');
    await update(db, sessions)
      .set({
        data: {
          ...row.data,
          sdk_native_state_layout: 'session_root_v1',
          sdk_native_state_store_id: generateId(),
        },
      })
      .run();
    const before = await select(db).from(sessions).one();
    const app = { service: () => ({ emit: vi.fn() }) } as unknown as Application;
    const service = new SessionsService(
      createTenantScopedDatabaseProxy(db, { requireScope: false }),
      app
    );
    await expect(
      service.remove(session.session_id, {
        provider: 'rest',
        tenant: { tenant_id: 'default' },
        user: { user_id: removerId },
      } as never)
    ).rejects.toThrow(/'all' permission/i);
    expect(mocks.issueExecutorCommandToken).not.toHaveBeenCalled();
    expect(mocks.requestExecutor).not.toHaveBeenCalled();
    expect(await select(db).from(sessions).one()).toEqual(before);
  });

  dbTest(
    'allows an authorized Branch manager to request mixed-owner Session deletion',
    async ({ db }) => {
      const branchOwnerId = generateId();
      const removerId = generateId();
      await ensureTestUser(db, branchOwnerId);
      await ensureTestUser(db, removerId);
      const branch = await createOpenCodeBranch(db, branchOwnerId);
      await setTestBranchUserRole(
        db,
        branch.branch_id,
        removerId,
        'manager',
        'none',
        branchOwnerId
      );
      const repository = new SessionRepository(db);
      const root = await repository.create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'opencode',
        created_by: removerId,
        ready_for_prompt: true,
      });
      const child = await repository.create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'opencode',
        created_by: branchOwnerId,
        ready_for_prompt: true,
        genealogy: { parent_session_id: root.session_id, children: [] },
      });
      for (const session of [root, child]) {
        const row = (await select(db).from(sessions).all()).find(
          (candidate) => candidate.session_id === session.session_id
        );
        if (!row) throw new Error('Session row missing');
        await update(db, sessions)
          .set({
            data: {
              ...row.data,
              sdk_native_state_layout: 'session_root_v1',
              sdk_native_state_store_id: generateId(),
            },
          })
          .where(eq(sessions.session_id, session.session_id))
          .run();
      }
      const tasks = new TaskRepository(db);
      await tasks.create({
        session_id: root.session_id,
        created_by: removerId,
        full_prompt: 'Completed work',
        status: TaskStatus.COMPLETED,
      });
      const beforeSessions = await select(db).from(sessions).all();
      const beforeTasks = await tasks.findAll();
      const app = {
        service: (name: string) =>
          name === 'sessions'
            ? { emit: vi.fn() }
            : { observeSessionDelete: vi.fn(async () => undefined) },
      } as unknown as Application;
      const service = new SessionsService(
        createTenantScopedDatabaseProxy(db, { requireScope: false }),
        app
      );

      mocks.requestExecutor.mockResolvedValue({ success: false, error: { code: 'UNKNOWN' } });
      await expect(
        service.remove(root.session_id, {
          provider: 'rest',
          tenant: { tenant_id: 'default' },
          user: { user_id: removerId, role: 'member' },
        } as never)
      ).rejects.toThrow(/deletion is pending/i);
      const afterSessions = await select(db).from(sessions).all();
      expect(afterSessions).toHaveLength(beforeSessions.length);
      for (const expected of [root, child]) {
        const row = afterSessions.find((candidate) => candidate.session_id === expected.session_id);
        expect(row?.data[OPENCODE_SESSION_DELETE_DATA_KEY]).toMatchObject({ status: 'error' });
      }
      expect(await tasks.findAll()).toEqual(beforeTasks);
      expect(mocks.issueExecutorCommandToken).toHaveBeenCalledTimes(2);
      expect(mocks.requestExecutor).toHaveBeenCalledTimes(2);
      await expect(
        tasks.createPending({
          session_id: root.session_id,
          created_by: removerId,
          full_prompt: 'Still promptable',
          status: TaskStatus.CREATED,
        })
      ).rejects.toThrow(/native state|deletion/i);
    }
  );

  dbTest(
    'keeps uncertain closure pending and reuses one operation on an explicit retry',
    async ({ db }) => {
      const actorId = generateId();
      const retryingAdminId = generateId();
      await ensureTestUser(db, actorId);
      await ensureTestUser(db, retryingAdminId);
      const branch = await createOpenCodeBranch(db, actorId);
      await setTestBranchUserRole(
        db,
        branch.branch_id,
        retryingAdminId,
        'manager',
        'none',
        actorId
      );
      const session = await new SessionRepository(db).create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'opencode',
        created_by: actorId,
      });
      const storeId = generateId();
      const row = await select(db).from(sessions).one();
      if (!row) throw new Error('Session row missing');
      await update(db, sessions)
        .set({
          data: {
            ...row.data,
            sdk_native_state_layout: 'session_root_v1',
            sdk_native_state_store_id: storeId,
          },
        })
        .run();

      const observed: string[] = [];
      const emit = vi.fn();
      const app = {
        service: vi.fn((name: string) => {
          if (name === 'sessions') return { emit };
          if (name !== 'opencode-native-state') throw new Error(`Unexpected service ${name}`);
          return {
            observeSessionDelete: vi.fn(async ({ operation_id }: { operation_id: string }) => {
              observed.push(operation_id);
            }),
          };
        }),
      } as unknown as Application;
      const service = new SessionsService(
        createTenantScopedDatabaseProxy(db, { requireScope: false }),
        app
      );
      const params = {
        provider: 'rest',
        tenant: { tenant_id: 'default' },
        user: { user_id: actorId, role: 'member' },
      } as never;

      mocks.requestExecutor.mockResolvedValueOnce({ success: false, error: { code: 'UNKNOWN' } });
      await expect(service.remove(session.session_id, params)).rejects.toThrow(
        /deletion is pending/i
      );

      const afterFailure = await select(db).from(sessions).one();
      const marker = afterFailure?.data[OPENCODE_SESSION_DELETE_DATA_KEY] as {
        operation_id: string;
        status: string;
        launch_user_id: string;
      };
      expect(marker.status).toBe('error');
      expect(marker.launch_user_id).toBe(actorId);
      expect(
        emit.mock.calls.map(([, session]) => session.sdk_native_state_deletion_status)
      ).toEqual(['pending', 'error']);
      expect(emit.mock.calls[0]?.[2]).toMatchObject({
        path: 'sessions',
        params: { tenant: { tenant_id: 'default' } },
      });

      mocks.requestExecutor.mockImplementationOnce(
        async (request: {
          command: string;
          sessionToken: string;
          params: { sessionId: string; operationId: string };
        }) => {
          await runWithTenantDatabaseScope(db, 'default', async () => {
            const authority = {
              runId: 'reserved-delete-run',
              tokenFingerprint: createHash('sha256').update(request.sessionToken).digest('hex'),
            };
            await new OpenCodeCheckpointAttemptRepository(db).prepareSessionDeleteFiles(
              request.params.sessionId,
              request.params.operationId,
              undefined,
              authority
            );
            await new OpenCodeCheckpointAttemptRepository(db).acknowledgeSessionDelete(
              request.params.sessionId,
              request.params.operationId,
              [],
              { outcome: 'deleted' },
              undefined,
              authority
            );
          });
          return { success: true, data: { outcome: 'deleted' } };
        }
      );
      const retryParams = {
        ...params,
        user: { user_id: retryingAdminId, role: 'manager' },
      } as never;
      await expect(service.remove(session.session_id, retryParams)).rejects.toThrow(
        /deletion is pending/i
      );

      const requests = mocks.requestExecutor.mock.calls as Array<
        [
          {
            command: string;
            sessionToken: string;
            params: { operationId: string };
          },
        ]
      >;
      const commandIds = requests.map(
        ([request]) => `${request.command}:${request.params.operationId}`
      );
      expect(commandIds).toEqual([
        `${OPENCODE_SESSION_STATE_DELETE_COMMAND}:${marker.operation_id}`,
        `${OPENCODE_SESSION_STATE_DELETE_COMMAND}:${marker.operation_id}`,
      ]);
      expect(mocks.issueExecutorCommandToken.mock.calls.map(([, commandId]) => commandId)).toEqual(
        commandIds
      );
      expect(mocks.issueExecutorCommandToken.mock.calls.map(([, , userId]) => userId)).toEqual([
        actorId,
        retryingAdminId,
      ]);
      expect(
        (
          mocks.requestExecutor.mock.calls as Array<
            [{ sessionToken: string }, { templateVariables: Record<string, string> }]
          >
        ).map(([, options]) => options.templateVariables.user_id)
      ).toEqual([actorId, actorId]);
      expect(requests.map(([request]) => request.sessionToken)).toEqual([
        'fresh-token-1',
        'fresh-token-2',
      ]);
      expect(observed).toEqual([marker.operation_id, marker.operation_id]);

      const stillFenced = await new SessionRepository(db).findById(session.session_id);
      expect(stillFenced).not.toBeNull();
      const clearedRow = await select(db).from(sessions).one();
      expect(clearedRow?.data[OPENCODE_SESSION_DELETE_DATA_KEY]).toMatchObject({
        operation_id: marker.operation_id,
        status: 'state_cleared',
      });
      await expect(service.remove(session.session_id, retryParams)).resolves.toMatchObject({
        session_id: session.session_id,
      });
      await expect(new SessionRepository(db).findById(session.session_id)).resolves.toBeNull();
    }
  );
  for (const direction of [1, -1] as const) {
    dbTest(`removes overlapping bulk selections once (sort ${direction})`, async ({ db }) => {
      const actorId = generateId();
      await ensureTestUser(db, actorId);
      const branch = await createOpenCodeBranch(db, actorId);
      const repo = new SessionRepository(db);
      const root = await repo.create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'opencode',
        created_by: actorId,
      });
      const child = await repo.create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'opencode',
        created_by: actorId,
        genealogy: { parent_session_id: root.session_id, children: [] },
      });
      const emit = vi.fn();
      const app = { service: () => ({ emit }) } as unknown as Application;
      const service = new SessionsService(
        createTenantScopedDatabaseProxy(db, { requireScope: false }),
        app
      );
      const result = await service.remove(null, {
        tenant: { tenant_id: 'default' },
        query: {
          branch_id: branch.branch_id,
          $sort: { session_id: direction },
          $limit: 1,
          $skip: 1,
          $select: ['session_id'],
        },
      } as never);
      expect(Array.isArray(result)).toBe(true);
      expect((result as (typeof root)[]).map((row) => row.session_id)).toEqual(
        [root.session_id, child.session_id].sort((a, b) => direction * a.localeCompare(b))
      );
      expect(await repo.findById(root.session_id)).toBeNull();
      expect(await repo.findById(child.session_id)).toBeNull();
      // Selected children are returned for ordinary service event emission, not
      // emitted a second time as an implicitly removed descendant.
      expect(emit).not.toHaveBeenCalled();
    });
  }
});
