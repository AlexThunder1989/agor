import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgorClient, createClient } from '@agor/core/api';
import {
  acquireTenantWriteGate,
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  eq,
  executeRaw,
  generateId,
  getCurrentTenantDatabaseScope,
  initializeDatabase,
  isPostgresDatabase,
  OpenCodeCheckpointAttemptRepository,
  OpenCodeNativeStateHandoffRequiredError,
  RepoRepository,
  releaseTenantWriteGate,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  ScheduleRepository,
  SessionRepository,
  select,
  sessions,
  sql,
  TaskRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
  update,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  OpenCodeCheckpointBinding,
  Params,
  Session,
  SessionID,
  Task,
  TenantID,
} from '@agor/core/types';
import {
  OPENCODE_SESSION_DELETE_DATA_KEY,
  OPENCODE_SESSION_STATE_DELETE_COMMAND,
  SessionStatus,
  TaskStatus,
} from '@agor/core/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { opencodeCheckpointAttempts } from '../../../../packages/core/src/db/schema.js';
import { setTestBranchUserRole } from '../../../../packages/core/src/db/test-helpers.js';
import { boardMetadataTestApp } from '../../test/board-metadata-app.js';
import { hostedOpenCodeConfig } from '../../test/fixtures/hosted-opencode-config.js';
import {
  EXECUTOR_COMMAND_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
} from '../auth/executor-session-token.js';
import { createDeploymentToolUnsupportedGate } from '../integrations/opencode/deployment-capabilities.js';
import { OpenCodeNativeStateService } from './opencode-native-state.js';
import { SchedulerService } from './scheduler.js';
import { SessionsService } from './sessions.js';

const mocks = vi.hoisted(() => ({
  getDaemonUrl: vi.fn(() => 'http://daemon.invalid'),
  issueExecutorCommandToken: vi.fn(),
  requestExecutor: vi.fn(),
}));

vi.mock('../utils/spawn-executor.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../utils/spawn-executor.js');
  return { ...actual, getDaemonUrl: mocks.getDaemonUrl, requestExecutor: mocks.requestExecutor };
});
vi.mock('./session-token-service.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./session-token-service.js');
  return { ...actual, issueExecutorCommandToken: mocks.issueExecutorCommandToken };
});

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgres = process.env.AGOR_DB_DIALECT === 'postgresql';

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown[] } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

describe.skipIf(!postgresUrl || !usesPostgres)(
  'Session native-state deletion (PostgreSQL/RLS)',
  () => {
    let rawDb: Database;
    let db: TenantScopeAwareDatabase;

    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      if (!isPostgresDatabase(rawDb)) throw new Error('PostgreSQL test requires PostgreSQL');
      const [role] = rowsOf(
        await executeRaw(
          rawDb,
          sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
        )
      );
      const [rls] = rowsOf(
        await executeRaw(
          rawDb,
          sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.sessions'::regclass`
        )
      );
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
      expect(rls).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      db = createTenantScopedDatabaseProxy(rawDb, {
        requireScope: true,
        label: 'session-native-state-delete-postgres-test',
      });
    }, 60_000);

    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    beforeEach(() => {
      vi.clearAllMocks();
      mocks.requestExecutor.mockReset();
      let tokenNumber = 0;
      mocks.issueExecutorCommandToken.mockImplementation(
        async () => `fresh-token-${++tokenNumber}`
      );
    });

    async function seedSessionFixture(tenantId: TenantID, withChild = false) {
      return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const owner = await new UsersRepository(scoped).create({
          email: `${generateId()}@example.test`,
          name: 'Session owner',
          role: 'admin',
        });
        const repo = await new RepoRepository(scoped).create({
          repo_id: generateId(),
          slug: `session-delete-${generateId()}`,
          name: 'Session deletion',
          repo_type: 'remote',
          remote_url: 'https://example.invalid/session-delete.git',
          local_path: `/tmp/${generateId()}`,
          default_branch: 'main',
        });
        const branch = await new BranchRepository(scoped).create({
          branch_id: generateId(),
          repo_id: repo.repo_id,
          name: 'session-delete',
          ref: 'main',
          branch_unique_id: Math.floor(Math.random() * 1_000_000_000),
          path: `/tmp/${generateId()}`,
          created_by: owner.user_id,
        });
        const repository = new SessionRepository(scoped);
        const create = async (parentSessionId?: SessionID) => {
          const session = await repository.create({
            session_id: generateId(),
            branch_id: branch.branch_id,
            agentic_tool: 'opencode',
            created_by: owner.user_id,
            sdk_home_scope: 'branch',
            status: SessionStatus.IDLE,
            genealogy: {
              ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
              children: [],
            },
          });
          const row = await select(scoped)
            .from(sessions)
            .where(eq(sessions.session_id, session.session_id))
            .one();
          if (!row) throw new Error('Session row missing');
          const storeId = generateId();
          // The tree case exercises store-only deletion; the single-Session
          // actor case assigns its layout/store through real admission below.
          if (withChild)
            await update(scoped, sessions)
              .set({
                data: {
                  ...row.data,
                  sdk_native_state_layout: 'session_root_v1',
                  sdk_native_state_store_id: storeId,
                },
              })
              .where(eq(sessions.session_id, session.session_id))
              .run();
          return { session, storeId };
        };
        const root = await create();
        const child = withChild ? await create(root.session.session_id) : undefined;
        return { owner, branch, root, child };
      });
    }

    async function acknowledge(sessionId: string, operationId: string, tenantId: TenantID) {
      return runWithTenantContext(tenantId, async () => {
        const session = await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
          new SessionRepository(scoped).findById(sessionId)
        );
        if (!session) throw new Error('Session missing');
        const token = 'synthetic-command-token';
        const fingerprint = createHash('sha256').update(token).digest('hex');
        const runId = `delete-run-${operationId}`;
        // This synthetic service fixture stands in for Cloud's guarded retry;
        // it does not establish the external closure proof itself.
        await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
          const repository = new SessionRepository(scoped);
          const previous = await repository.getDeletionCredentialState(sessionId, operationId);
          await repository.reserveDeletionCredential(sessionId, operationId, fingerprint, previous);
        });
        const changed = vi.fn(async () => undefined);
        const native = new OpenCodeNativeStateService({
          db,
          getConfig: () =>
            ({
              execution: {
                opencode_native_state_observer: {
                  command_template: `node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const r=JSON.parse(b);console.log(JSON.stringify({version:1,action:"authorize_delete",authorized:r.runId==="${runId}"&&r.tokenFingerprint==="${fingerprint}"}))})'`,
                  timeout_ms: 2000,
                },
              },
            }) as never,
          onSessionDeletionChanged: changed,
        });
        const params = {
          tenant: { tenant_id: tenantId, source: 'explicit' },
          authentication: {
            strategy: 'jwt',
            accessToken: token,
            payload: {
              type: EXECUTOR_SESSION_TOKEN_TYPE,
              purpose: EXECUTOR_COMMAND_TOKEN_PURPOSE,
              session_id: `${OPENCODE_SESSION_STATE_DELETE_COMMAND}:${operationId}`,
              branch_id: session.branch_id,
            },
          },
        } as Params;
        const input = { session_id: sessionId, operation_id: operationId, run_id: runId };
        // These params represent the already-authenticated token projection;
        // signature/expiry verification remains the transport's responsibility.
        await expect(
          native.prepareSessionDeleteCommand(input, {
            ...params,
            authentication: {
              strategy: 'jwt',
              payload: {
                type: EXECUTOR_SESSION_TOKEN_TYPE,
                purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
                session_id: sessionId,
                task_id: generateId(),
                branch_id: session.branch_id,
              },
            },
          } as Params)
        ).rejects.toThrow(/token scoped/);
        await expect(
          native.prepareSessionDeleteCommand({ ...input, operation_id: generateId() }, params)
        ).rejects.toThrow(/token scoped/);
        const prepared = await native.prepareSessionDeleteCommand(input, params);
        const receipt = {
          ...input,
          files: prepared.files,
          result: { outcome: 'deleted' as const },
        };
        await native.acknowledgeSessionDelete(receipt, params);
        await new Promise((resolve) => setTimeout(resolve, 1050));
        await native.acknowledgeSessionDelete(receipt, params); // Lost reply replay is idempotent.
        expect(changed).toHaveBeenCalledWith(tenantId, sessionId);
        await new Promise((resolve) => setTimeout(resolve, 1050));
        await expect(
          native.acknowledgeSessionDelete(
            {
              ...receipt,
              result: { outcome: 'failed', error_code: 'STALE_FAILURE' },
            },
            params
          )
        ).rejects.toThrow(/receipt does not match/);
      });
    }

    function makeService() {
      const app = {
        service: (name: string) => {
          if (name === 'sessions') return { emit: vi.fn() };
          if (name !== 'opencode-native-state') throw new Error(`Unexpected service ${name}`);
          return { observeSessionDelete: vi.fn(async () => undefined) };
        },
      } as unknown as Application;
      return new SessionsService(db, app);
    }

    function remove(
      service: SessionsService,
      sessionId: string,
      tenantId: TenantID,
      actorId: string
    ) {
      return runWithTenantContext(tenantId, () =>
        service.remove(sessionId, {
          tenant: { tenant_id: tenantId, source: 'explicit' },
          user: { user_id: actorId },
        } as never)
      );
    }

    it('refuses scheduled deletion before a native-state fence under restricted-role RLS', async () => {
      const tenantId = `session-retention-${generateId()}` as TenantID;
      const { root } = await seedSessionFixture(tenantId);
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const row = await select(scoped)
          .from(sessions)
          .where(eq(sessions.session_id, root.session.session_id))
          .one();
        if (!row) throw new Error('Session row missing');
        await update(scoped, sessions)
          .set({
            data: {
              ...row.data,
              sdk_native_state_layout: 'session_root_v1',
              sdk_native_state_store_id: root.storeId,
            },
          })
          .where(eq(sessions.session_id, root.session.session_id))
          .run();
      });
      const app = { service: () => ({ emit: vi.fn() }) } as unknown as Application;
      const service = new SessionsService(db, app);

      await expect(
        runWithTenantContext(tenantId, () =>
          service.remove(root.session.session_id, {
            tenant: { tenant_id: tenantId, source: 'explicit' },
          } as never)
        )
      ).rejects.toBeInstanceOf(OpenCodeNativeStateHandoffRequiredError);
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const raw = await select(scoped)
          .from(sessions)
          .where(eq(sessions.session_id, root.session.session_id))
          .one();
        expect(raw?.data[OPENCODE_SESSION_DELETE_DATA_KEY]).toBeUndefined();
        expect(
          (await new SessionRepository(scoped).findById(root.session.session_id))
            ?.sdk_native_state_deletion_status
        ).toBeUndefined();
      });
      expect(mocks.issueExecutorCommandToken).not.toHaveBeenCalled();
      expect(mocks.requestExecutor).not.toHaveBeenCalled();
    });

    it('requires handoff before fencing unmarked native state under restricted-role RLS', async () => {
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

      for (const data of legacyState) {
        const tenantId = `legacy-delete-${generateId()}` as TenantID;
        const { root } = await seedSessionFixture(tenantId);
        await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
          const before = await select(scoped)
            .from(sessions)
            .where(eq(sessions.session_id, root.session.session_id))
            .one();
          if (!before) throw new Error('Session row missing');
          await update(scoped, sessions)
            .set({ data: { ...before.data, ...data } })
            .where(eq(sessions.session_id, root.session.session_id))
            .run();
        });

        await expect(
          runWithTenantContext(tenantId, () =>
            runWithTenantDatabaseScope(db, tenantId, (scoped) =>
              new SessionRepository(scoped).claimDeletionTree(root.session.session_id)
            )
          )
        ).rejects.toBeInstanceOf(OpenCodeNativeStateHandoffRequiredError);

        const after = await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
          select(scoped)
            .from(sessions)
            .where(eq(sessions.session_id, root.session.session_id))
            .one()
        );
        expect(after?.data).toMatchObject(data);
        expect(after?.data[OPENCODE_SESSION_DELETE_DATA_KEY]).toBeUndefined();
      }
    });

    it('creates managed Sessions in sticky Branch scope and preserves inherited lineage under RLS', async () => {
      const tenantId = `sdk-home-${generateId()}` as TenantID;
      const { owner, branch } = await seedSessionFixture(tenantId);
      const config = hostedOpenCodeConfig();
      const app = { get: (key: string) => (key === 'config' ? config : undefined) } as Application;
      const service = new SessionsService(
        db,
        app,
        () => true,
        createDeploymentToolUnsupportedGate(config)
      );
      const create = (inheritedScope?: 'branch' | 'execution_home') =>
        runWithTenantContext(tenantId, () =>
          runWithTenantDatabaseScope(db, tenantId, () =>
            service.create(
              {
                branch_id: branch.branch_id,
                created_by: owner.user_id,
                agentic_tool: 'opencode',
                status: SessionStatus.IDLE,
                model_config: {
                  mode: 'exact',
                  provider: 'anthropic',
                  model: 'claude-sonnet-4-5',
                  updated_at: new Date().toISOString(),
                },
              },
              {
                _agenticConfigResolved: true,
                tenant: { tenant_id: tenantId },
                ...(inheritedScope ? { _sdkHomeScope: inheritedScope } : {}),
              } as never
            )
          )
        );
      expect((await create()).sdk_home_scope).toBe('branch');
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const branches = new BranchRepository(scoped);
        expect((await branches.findById(branch.branch_id))?.sdk_home).toBe('per_branch');
        await branches.adoptSdkHome(branch.branch_id);
      });
      expect((await create()).sdk_home_scope).toBe('branch');
      await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        expect((await new BranchRepository(scoped).findById(branch.branch_id))?.sdk_home).toBe(
          'per_branch'
        );
      });
      expect((await create('branch')).sdk_home_scope).toBe('branch');
      expect((await create('execution_home')).sdk_home_scope).toBe('execution_home');
    });

    it('adopts Branch scope for a scheduled managed OpenCode run under restricted-role RLS', async () => {
      const tenantId = `scheduler-sdk-home-${generateId()}` as TenantID;
      const { owner, branch } = await seedSessionFixture(tenantId);
      await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        new UsersRepository(scoped).update(owner.user_id, {
          unix_username: `schedule-${generateId().slice(-8)}`,
        })
      );
      const schedule = await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        new ScheduleRepository(scoped).create({
          branch_id: branch.branch_id,
          created_by: owner.user_id,
          name: 'Managed OpenCode run',
          cron_expression: '0 * * * *',
          timezone_mode: 'utc',
          prompt: 'Scheduled prompt',
          enabled: true,
          retention: 0,
          allow_concurrent_runs: false,
          agentic_tool_config: {
            agentic_tool: 'opencode',
            model_config: { mode: 'exact', provider: 'anthropic', model: 'claude-sonnet-4-5' },
          },
        })
      );
      const config = hostedOpenCodeConfig();
      const sessionsRepo = new SessionRepository(db);
      const app = {
        get: (name: string) =>
          name === 'distributedWorkIdentity'
            ? { instanceId: 'pg-test', bootId: 'pg-test' }
            : undefined,
        service: (path: string) => {
          if (path === 'sessions') {
            return {
              emit: vi.fn(),
              patch: (id: string, data: Partial<Session>) => sessionsRepo.update(id, data),
              remove: vi.fn(),
            };
          }
          if (path === '/sessions/:id/prompt') {
            return {
              create: async (
                data: { prompt: string; idempotencyTaskId: string },
                params: { route: { id: string } }
              ) =>
                ({
                  task_id: data.idempotencyTaskId,
                  session_id: params.route.id,
                  status: TaskStatus.DISPATCHING,
                  full_prompt: data.prompt,
                }) as Task,
            };
          }
          if (path === 'session-mcp-servers') return { emit: vi.fn() };
          throw new Error(`Unexpected scheduler service: ${path}`);
        },
      } as unknown as Application;
      const scheduler = new SchedulerService(db, app, {
        deploymentPolicy: { managed: true, installed: new Set(['opencode']) },
        deploymentToolUnsupported: createDeploymentToolUnsupportedGate(config),
        sdkHomeMode: 'per_branch',
        unixUserMode: 'delegated',
        managedOpenCode: true,
        tenantId,
      });

      await runWithTenantContext(tenantId, () =>
        scheduler.executeScheduleNow({
          scheduleId: schedule.schedule_id,
          triggeredBy: owner.user_id,
        })
      );
      const [created] = await runWithTenantDatabaseScope(db, tenantId, () =>
        new SessionRepository(db).findByScheduleId(schedule.schedule_id)
      );
      expect(created).toMatchObject({
        sdk_home_scope: 'branch',
        created_by: owner.user_id,
        agentic_tool: 'opencode',
      });
      await expect(
        runWithTenantDatabaseScope(db, tenantId, () =>
          new BranchRepository(db).findById(branch.branch_id)
        )
      ).resolves.toMatchObject({ sdk_home: 'per_branch' });
    });

    it('allows an authorized Branch manager to request mixed-owner deletion under RLS', async () => {
      const tenantId = `delete-owner-${generateId()}` as TenantID;
      const { owner, branch, root, child } = await seedSessionFixture(tenantId, true);
      if (!child) throw new Error('Expected child fixture');
      const manager = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const actor = await new UsersRepository(scoped).create({
          email: `${generateId()}@example.test`,
          name: 'Branch manager',
          role: 'member',
        });
        await setTestBranchUserRole(
          scoped,
          branch.branch_id,
          actor.user_id,
          'manager',
          'none',
          owner.user_id
        );
        await update(scoped, sessions)
          .set({ created_by: actor.user_id })
          .where(eq(sessions.session_id, root.session.session_id))
          .run();
        await new TaskRepository(scoped).create({
          session_id: root.session.session_id,
          created_by: actor.user_id,
          full_prompt: 'Completed work',
          status: TaskStatus.COMPLETED,
        });
        return actor;
      });
      const snapshot = () =>
        runWithTenantDatabaseScope(db, tenantId, async (scoped) => ({
          sessions: await select(scoped).from(sessions).all(),
          tasks: await new TaskRepository(scoped).findAll(),
        }));
      const before = await snapshot();
      mocks.requestExecutor.mockResolvedValue({ success: false, error: { code: 'UNKNOWN' } });
      await expect(
        runWithTenantContext(tenantId, () =>
          makeService().remove(root.session.session_id, {
            provider: 'rest',
            tenant: { tenant_id: tenantId, source: 'explicit' },
            user: { user_id: manager.user_id, role: 'member' },
          } as never)
        )
      ).rejects.toThrow(/deletion is pending/i);
      const after = await snapshot();
      expect(after.sessions).toHaveLength(before.sessions.length);
      expect(after.tasks).toEqual(before.tasks);
      for (const sessionId of [root.session.session_id, child.session.session_id]) {
        const row = after.sessions.find((candidate) => candidate.session_id === sessionId);
        expect(row?.data[OPENCODE_SESSION_DELETE_DATA_KEY]).toMatchObject({ status: 'error' });
      }
      expect(mocks.issueExecutorCommandToken).toHaveBeenCalledTimes(2);
      expect(mocks.requestExecutor).toHaveBeenCalledTimes(2);
      await expect(
        runWithTenantDatabaseScope(db, tenantId, (scoped) =>
          new TaskRepository(scoped).createPending({
            session_id: root.session.session_id,
            created_by: manager.user_id,
            full_prompt: 'Still promptable',
            status: TaskStatus.CREATED,
          })
        )
      ).rejects.toThrow(/native state|deletion/i);
    });

    it('uses registered JWT/service hooks for expiry, restart and exact run/bearer callbacks', async () => {
      const tenantId = `delete-authority-${generateId()}` as TenantID;
      const { owner, root } = await seedSessionFixture(tenantId, true);
      const sessionId = root.session.session_id;
      const [claim] = await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        new SessionRepository(scoped).claimDeletionTree(sessionId)
      );
      const operationId = claim!.operationId;
      const runId = `run-${operationId}`;
      const directory = await mkdtemp(join(tmpdir(), 'delete-authority-'));
      const authorityFile = join(directory, 'authority.json');
      // Protocol fixture at the external Cloud seam. The companion launcher
      // does not yet implement authorize_delete; this does not prove that seam.
      const config = {
        database: { dialect: 'postgresql' },
        multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
        execution: {
          opencode_native_state_observer: {
            timeout_ms: 2000,
            command_template: `node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{const r=JSON.parse(b),a=JSON.parse(require("fs").readFileSync("${authorityFile}","utf8"));console.log(JSON.stringify({version:1,action:"authorize_delete",authorized:r.runId===a.runId&&r.tokenFingerprint===a.fingerprint}))})'`,
          },
        },
      } as const;
      let fixture = await boardMetadataTestApp(
        db,
        config as never,
        true,
        false,
        false,
        false,
        true
      );
      const mint = (expirationMs = 60_000) =>
        runWithTenantDatabaseScope(db, tenantId, () =>
          fixture.tokenService!.generateCommandToken(
            `${OPENCODE_SESSION_STATE_DELETE_COMMAND}:${operationId}`,
            owner.user_id,
            root.session.branch_id,
            expirationMs
          )
        );
      const reserve = async (token: string) => {
        const fingerprint = createHash('sha256').update(token).digest('hex');
        await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
          const repository = new SessionRepository(scoped);
          const previous = await repository.getDeletionCredentialState(sessionId, operationId);
          await repository.reserveDeletionCredential(sessionId, operationId, fingerprint, previous);
        });
        await writeFile(authorityFile, JSON.stringify({ runId, fingerprint }));
      };
      let client: AgorClient | undefined;
      const connect = async (token: string) => {
        client?.io.close();
        client = createClient(fixture.url, false, {
          reconnectionAttempts: 0,
          socketAuthentication: { accessToken: token },
        });
        await new Promise<void>((resolve, reject) => {
          client!.io.once('connect', resolve);
          client!.io.once('connect_error', reject);
          client!.io.connect();
        });
      };
      const native = () => client!.service('opencode-native-state');
      const input = { session_id: sessionId, operation_id: operationId, run_id: runId };
      try {
        const expired = await mint(1000);
        await reserve(expired);
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await expect(connect(expired)).rejects.toThrow(/expired|jwt|tenant context/i);
        const old = await mint();
        await reserve(old);
        await connect(old);
        await expect(
          native().prepareSessionDeleteCommand({ ...input, run_id: 'wrong-run' })
        ).rejects.toThrow(/run or credential/);
        await new Promise((resolve) => setTimeout(resolve, 1050));
        const prepared = await native().prepareSessionDeleteCommand(input);
        const receipt = {
          ...input,
          files: prepared.files,
          result: { outcome: 'deleted' as const },
        };
        const fresh = await mint();
        await reserve(fresh);
        await expect(native().acknowledgeSessionDelete(receipt)).rejects.toThrow(
          /run or credential/
        );
        client?.io.close();
        await fixture.close();
        fixture = await boardMetadataTestApp(db, config as never, true, false, false, false, true);
        await new Promise((resolve) => setTimeout(resolve, 1050));
        await connect(fresh);
        await native().prepareSessionDeleteCommand(input);
        await native().acknowledgeSessionDelete(receipt);
        await new Promise((resolve) => setTimeout(resolve, 1050));
        await native().acknowledgeSessionDelete(receipt);
        expect(
          (
            await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
              new SessionRepository(scoped).findById(sessionId)
            )
          )?.sdk_native_state_deletion_status
        ).toBe('state_cleared');
      } finally {
        client?.io.close();
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('exposes pending/error/cleared states until an ordinary remove retry succeeds', async () => {
      const tenantId = `session-delete-${generateId()}` as TenantID;
      const { owner, root, child } = await seedSessionFixture(tenantId, true);
      if (!child) throw new Error('Expected child fixture');
      const retryingAdmin = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const admin = await new UsersRepository(scoped).create({
          email: `${generateId()}@example.test`,
          name: 'Retrying branch manager',
          role: 'member',
        });
        await setTestBranchUserRole(
          scoped,
          root.session.branch_id,
          admin.user_id,
          'manager',
          'none',
          owner.user_id
        );
        return admin;
      });
      const fixture = await boardMetadataTestApp(
        db,
        {
          database: { dialect: 'postgresql' },
          multi_tenancy: { mode: 'required_from_auth', auth_claim: 'tenant_id' },
          execution: {},
        },
        false,
        false,
        false,
        true
      );
      const observerService = {
        async find() {
          return [];
        },
        observeSessionDelete: vi.fn(async ({ session_id }: { session_id: string }) => {
          expect(getCurrentTenantDatabaseScope()).toBeUndefined();
          await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
            await executeRaw(scoped, sql`SET LOCAL lock_timeout = '2s'`);
            await update(scoped, sessions)
              .set({ updated_at: new Date() })
              .where(eq(sessions.session_id, session_id))
              .run();
          });
        }),
      };
      (fixture.app as unknown as Application).use('opencode-native-state', observerService);
      const removeTree = async (actorId: string = owner.user_id) => {
        const response = await fetch(`${fixture.url}/sessions/${root.session.session_id}`, {
          method: 'DELETE',
          headers: fixture.headers(actorId, tenantId),
        });
        const body = (await response.json()) as { message?: string };
        if (!response.ok) throw new Error(body.message);
        return body;
      };
      let signalStarted!: () => void;
      let releaseRequest!: () => void;
      const started = new Promise<void>((resolve) => (signalStarted = resolve));
      const requestGate = new Promise<void>((resolve) => (releaseRequest = resolve));
      let requests = 0;
      mocks.requestExecutor.mockImplementation(async () => {
        expect(getCurrentTenantDatabaseScope()).toBeUndefined();
        requests += 1;
        if (requests === 1) {
          signalStarted();
          await requestGate;
        }
        return { success: false, error: { code: 'UNKNOWN' } };
      });

      try {
        const other = await seedSessionFixture(tenantId);
        const move = (sessionId: string, branchId: string) =>
          runWithTenantDatabaseScope(db, tenantId, (scoped) =>
            update(scoped, sessions)
              .set({ branch_id: branchId })
              .where(eq(sessions.session_id, sessionId))
              .run()
          );
        const request = () =>
          fetch(`${fixture.url}/sessions/${root.session.session_id}`, {
            method: 'DELETE',
            headers: fixture.headers(owner.user_id, tenantId),
          });
        // Root access must not confer deletion authority over a different-branch child.
        await move(child.session.session_id, other.branch.branch_id);
        expect((await request()).status).toBe(403);
        await move(child.session.session_id, root.session.branch_id);
        // Mutate after the normal authorization hooks cached the old branch.
        let changeAfterAuthorization = true;
        fixture.app.service('sessions').hooks({
          before: {
            remove: [
              async (context) => {
                if (changeAfterAuthorization) {
                  changeAfterAuthorization = false;
                  await move(root.session.session_id, other.branch.branch_id);
                }
                return context;
              },
            ],
          },
        });
        expect((await request()).status).toBe(403);
        await move(root.session.session_id, root.session.branch_id);
        const gate = await acquireTenantWriteGate(rawDb, tenantId, {
          reason: 'freeze',
          holder: 'test',
        });
        try {
          expect((await request()).status).toBe(503);
        } finally {
          await releaseTenantWriteGate(rawDb, tenantId, { generation: gate.generation });
        }
        expect(mocks.requestExecutor).not.toHaveBeenCalled();
        await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
          for (const id of [root.session.session_id, child.session.session_id]) {
            expect(
              (await new SessionRepository(scoped).findById(id))?.sdk_native_state_deletion_status
            ).toBeUndefined();
          }
        });
        const queued = await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
          new TaskRepository(scoped).createPending({
            task_id: generateId(),
            session_id: child.session.session_id,
            created_by: owner.user_id,
            full_prompt: 'unfinished child',
            status: TaskStatus.QUEUED,
          })
        );
        const busy = await fetch(`${fixture.url}/sessions/${root.session.session_id}`, {
          method: 'DELETE',
          headers: fixture.headers(owner.user_id, tenantId),
        });
        expect(busy.status).toBe(409);
        expect(((await busy.json()) as { message: string }).message).toMatch(/unfinished tasks/);
        await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
          expect(
            (await new SessionRepository(scoped).findById(root.session.session_id))
              ?.sdk_native_state_deletion_status
          ).toBeUndefined();
          await new TaskRepository(scoped).delete(queued.task_id);
        });
        const foreignTenant = `delete-foreign-${generateId()}` as TenantID;
        const foreignUser = await runWithTenantDatabaseScope(db, foreignTenant, (scoped) =>
          new UsersRepository(scoped).create({
            email: `${generateId()}@example.test`,
            role: 'admin',
          })
        );
        const denied = await fetch(`${fixture.url}/sessions/${root.session.session_id}`, {
          method: 'DELETE',
          headers: fixture.headers(foreignUser.user_id, foreignTenant),
        });
        expect([403, 404]).toContain(denied.status);
        expect(mocks.requestExecutor).not.toHaveBeenCalled();
        const firstRemove = removeTree().then(
          () => {
            throw new Error('Removal succeeded before checkpoint acknowledgement');
          },
          (error: Error) => error
        );
        // An early authorization/setup failure must fail, not hang at the barrier.
        await Promise.race([
          started,
          firstRemove.then((error) => {
            throw error;
          }),
        ]);
        const pending = await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
          new SessionRepository(scoped).findById(root.session.session_id)
        );
        expect(pending?.sdk_native_state_deletion_status).toBe('pending');
        // This separate writer must acquire the Session row while helper I/O is
        // paused. A SELECT alone would not detect an uncommitted row lock (MVCC).
        await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
          await executeRaw(scoped, sql`SET LOCAL lock_timeout = '2s'`);
          await update(scoped, sessions)
            .set({ updated_at: new Date() })
            .where(eq(sessions.session_id, root.session.session_id))
            .run();
        });
        releaseRequest();
        expect((await firstRemove).message).toMatch(/deletion is pending/i);

        const firstRequests = mocks.requestExecutor.mock.calls.map(
          ([request]) =>
            request as {
              command: string;
              params: { sessionId: string; operationId: string };
            }
        );
        expect(firstRequests.map((request) => request.command)).toEqual([
          OPENCODE_SESSION_STATE_DELETE_COMMAND,
          OPENCODE_SESSION_STATE_DELETE_COMMAND,
        ]);
        const operationFor = new Map(
          firstRequests.map((request) => [request.params.sessionId, request.params.operationId])
        );
        const rootOperation = operationFor.get(root.session.session_id)!;
        const childOperation = operationFor.get(child.session.session_id)!;
        // Exact known IDs confer no cross-tenant read or deletion authority.
        await runWithTenantDatabaseScope(db, `foreign-${generateId()}`, async (scoped) => {
          expect(await new SessionRepository(scoped).findById(root.session.session_id)).toBeNull();
          const foreignLedger = new OpenCodeCheckpointAttemptRepository(scoped);
          await expect(
            foreignLedger.prepareSessionDeleteFiles(root.session.session_id, rootOperation)
          ).rejects.toThrow(/operation or layout is invalid/);
          await expect(
            foreignLedger.acknowledgeSessionDelete(root.session.session_id, rootOperation, [], {
              outcome: 'deleted',
            })
          ).rejects.toThrow(/not found/);
        });
        const read = (sessionId: string) =>
          runWithTenantDatabaseScope(db, tenantId, (scoped) =>
            new SessionRepository(scoped).findById(sessionId)
          );
        expect((await read(root.session.session_id))?.sdk_native_state_deletion_status).toBe(
          'error'
        );
        expect((await read(child.session.session_id))?.sdk_native_state_deletion_status).toBe(
          'error'
        );
        await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
          const ledger = new OpenCodeCheckpointAttemptRepository(scoped);
          const staleOperationId = generateId();
          await expect(
            ledger.prepareSessionDeleteFiles(root.session.session_id, staleOperationId)
          ).rejects.toThrow(/operation or layout is invalid/);
          await expect(
            ledger.acknowledgeSessionDelete(root.session.session_id, staleOperationId, [], {
              outcome: 'deleted',
            })
          ).rejects.toThrow(/operation is no longer current/);
        });

        // Acknowledge the child first; it must not clear its parent's state.
        await acknowledge(child.session.session_id, childOperation, tenantId);
        expect((await read(child.session.session_id))?.sdk_native_state_deletion_status).toBe(
          'state_cleared'
        );
        expect((await read(root.session.session_id))?.sdk_native_state_deletion_status).toBe(
          'error'
        );

        // Dispatch success is not a durable acknowledgement: a lost callback
        // leaves pending committed even after the HTTP conflict returns.
        mocks.requestExecutor.mockResolvedValueOnce({ success: true, data: {} });
        await expect(removeTree(retryingAdmin.user_id)).rejects.toThrow(/deletion is pending/i);
        expect((await read(root.session.session_id))?.sdk_native_state_deletion_status).toBe(
          'pending'
        );

        mocks.requestExecutor.mockImplementationOnce(
          async (request: { params: { sessionId: string; operationId: string } }) => {
            await acknowledge(request.params.sessionId, request.params.operationId, tenantId);
            return { success: true, data: { outcome: 'deleted' } };
          }
        );
        await expect(removeTree(retryingAdmin.user_id)).rejects.toThrow(/deletion is pending/i);
        const retryRequest = mocks.requestExecutor.mock.calls[3]![0] as {
          params: { sessionId: string; operationId: string };
        };
        expect(retryRequest.params.operationId).toBe(rootOperation);
        expect(mocks.issueExecutorCommandToken.mock.calls.map(([, , userId]) => userId)).toEqual([
          owner.user_id,
          owner.user_id,
          retryingAdmin.user_id,
          retryingAdmin.user_id,
        ]);
        expect(
          (mocks.requestExecutor.mock.calls as Array<unknown[]>).map(
            ([, options]) =>
              (options as { templateVariables: Record<string, string> }).templateVariables.user_id
          )
        ).toEqual([owner.user_id, owner.user_id, owner.user_id, owner.user_id]);
        expect((await read(root.session.session_id))?.sdk_native_state_deletion_status).toBe(
          'state_cleared'
        );
        expect((await read(child.session.session_id))?.sdk_native_state_deletion_status).toBe(
          'state_cleared'
        );

        await expect(removeTree()).resolves.toMatchObject({ session_id: root.session.session_id });
        expect(await read(root.session.session_id)).toBeNull();
        expect(await read(child.session.session_id)).toBeNull();
        expect(mocks.requestExecutor).toHaveBeenCalledTimes(4);
      } finally {
        releaseRequest();
        await fixture.close();
      }
    }, 60_000);

    it('retains a historical co-prompter checkpoint after its storage owner is gone', async () => {
      const tenantId = `session-delete-actor-${generateId()}` as TenantID;
      const { owner, root } = await seedSessionFixture(tenantId);
      const session = root.session;
      const seeded = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
        const actor = await new UsersRepository(scoped).create({
          email: `${generateId()}@example.test`,
          role: 'member',
        });
        const taskRepo = new TaskRepository(scoped);
        const task = await taskRepo.create({
          task_id: generateId(),
          session_id: session.session_id,
          created_by: actor.user_id,
          full_prompt: 'publish a co-prompter checkpoint',
          status: TaskStatus.DISPATCHING,
          message_range: {
            start_index: 0,
            end_index: 0,
            start_timestamp: new Date().toISOString(),
          },
          git_state: { ref_at_start: 'main', sha_at_start: 'pg-delete' },
        });
        await taskRepo.connectExecutor(task.task_id);
        await taskRepo.stampManagedOpenCodeProtocol(task.task_id);
        const storeId = root.storeId;
        const holderId = generateId();
        const binding: OpenCodeCheckpointBinding = {
          protocol: 3,
          tenantId,
          ownerUserId: actor.user_id,
          sessionId: session.session_id,
          taskId: task.task_id,
          storeId,
          holderInstanceId: holderId,
          locator: {
            runId: generateId(),
            cellId: generateId(),
            tenantId,
            ownerRuntimeUserId: actor.user_id,
            sessionId: session.session_id,
            taskId: task.task_id,
            storeId,
            holderInstanceId: holderId,
            namespace: 'runtime-test',
            jobName: `job-${task.task_id}`,
            jobUid: generateId(),
            podName: `pod-${task.task_id}`,
            podUid: generateId(),
            containerName: 'executor',
            containerId: `containerd://${generateId()}`,
            restartCount: 0,
            imageIdentity: `sha256:${'c'.repeat(64)}`,
          },
        };
        const ledger = new OpenCodeCheckpointAttemptRepository(scoped);
        await expect(
          ledger.begin({ taskId: task.task_id, holderInstanceId: holderId, storeId, binding })
        ).resolves.toMatchObject({ outcome: 'admitted' });
        const manifest = {
          version: 3 as const,
          storeId,
          openCodeVersion: '1.18.31',
          attemptTaskId: task.task_id,
          digest: `sha256:${'a'.repeat(64)}`,
          bytes: 4096,
          openCodeSessionId: 'ses_pg_delete_actor',
          publishedAt: new Date().toISOString(),
        };
        await ledger.seal(task.task_id, holderId, manifest);
        await taskRepo.completeWithNativeStatePublication(
          task.task_id,
          { status: TaskStatus.COMPLETED, native_state_attempt: manifest },
          holderId
        );
        const published = await select(scoped)
          .from(sessions)
          .where(eq(sessions.session_id, session.session_id))
          .one();
        if (!published) throw new Error('Published Session missing');
        await update(scoped, sessions)
          .set({
            data: { ...published.data, sdk_session_id: manifest.openCodeSessionId },
          })
          .where(eq(sessions.session_id, session.session_id))
          .run();
        await update(scoped, opencodeCheckpointAttempts)
          .set({ holder_closed_observed_at: new Date() })
          .where(sql`${opencodeCheckpointAttempts.task_id} = ${task.task_id}`)
          .run();
        await new UsersRepository(scoped).delete(actor.user_id);
        return { owner, session };
      });

      const service = makeService();
      mocks.requestExecutor.mockImplementationOnce(
        async (request: { params: { sessionId: string; operationId: string } }) => {
          await acknowledge(request.params.sessionId, request.params.operationId, tenantId);
          return { success: true, data: { outcome: 'deleted' } };
        }
      );
      await expect(
        remove(service, seeded.session.session_id, tenantId, seeded.owner.user_id)
      ).rejects.toThrow(/deletion is pending/i);
      const fenced = await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        new SessionRepository(scoped).findById(seeded.session.session_id)
      );
      expect(fenced?.sdk_native_state_deletion_status).toBe('state_cleared');
      expect(fenced?.sdk_session_id).toBeUndefined();
      await expect(
        remove(service, seeded.session.session_id, tenantId, seeded.owner.user_id)
      ).resolves.toMatchObject({ session_id: seeded.session.session_id });
      const removed = await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
        new SessionRepository(scoped).findById(seeded.session.session_id)
      );
      expect(removed).toBeNull();
    });
  }
);
