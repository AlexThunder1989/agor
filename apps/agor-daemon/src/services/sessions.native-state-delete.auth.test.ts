import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgorConfig } from '@agor/core/config';
import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  eq,
  generateId,
  OpenCodeCheckpointAttemptRepository,
  RepoRepository,
  SessionRepository,
  select,
  UsersRepository,
  update,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { AuthenticationService, feathers, NotAuthenticated } from '@agor/core/feathers';
import { OPENCODE_SESSION_DELETE_DATA_KEY } from '@agor/core/types';
import express from 'express';
import { describe, expect } from 'vitest';
import { sessions } from '../../../../packages/core/src/db/schema.js';
import { runWithTenantContext } from '../../../../packages/core/src/db/tenant-context.js';
import { runWithTenantDatabaseScope } from '../../../../packages/core/src/db/tenant-scope.js';
import {
  dbTest,
  ensureTestUser,
  setTestBranchUserRole,
} from '../../../../packages/core/src/db/test-helpers.js';
import { getOrCreateExecutorConnectionRevocationFence } from '../auth/executor-connection-admission.js';
import { RuntimeJWTStrategy } from '../auth/runtime-jwt-strategy.js';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../auth/runtime-tokens.js';
import { registerExecutorResponseRoutes } from '../executor-response-channel.js';
import { NOOP_METRICS } from '../metrics/index.js';
import {
  configureResolvedConfigSlice,
  resetResolvedConfigSliceForTests,
} from '../utils/build-resolved-config-slice.js';
import { configureDaemonUrl, configureExecutor } from '../utils/spawn-executor.js';
import { SessionTokenService } from './session-token-service.js';
import { SessionsService } from './sessions.js';

const jwtSecret = 'session-delete-auth-test-jwt-secret';

describe('Session deletion retry executor authentication', () => {
  dbTest(
    'authenticates a fresh remover after the original requester is deleted',
    async ({ db }) => {
      const branchOwnerId = generateId();
      const originalRequesterId = generateId();
      const retryAdminId = generateId();
      await ensureTestUser(db, branchOwnerId);
      await ensureTestUser(db, originalRequesterId);
      await ensureTestUser(db, retryAdminId);
      const repo = await new RepoRepository(db).create({
        repo_id: generateId(),
        slug: `delete-auth-${generateId()}`,
        name: 'Session deletion authentication',
        repo_type: 'remote',
        remote_url: 'https://example.invalid/session-delete-auth.git',
        local_path: '/tmp/session-delete-auth',
        default_branch: 'main',
      });
      const branch = await new BranchRepository(db).create({
        branch_id: generateId(),
        repo_id: repo.repo_id,
        name: 'session-delete-auth',
        ref: 'main',
        branch_unique_id: Math.floor(Math.random() * 1_000_000_000),
        path: '/tmp/session-delete-auth',
        created_by: branchOwnerId,
      });
      for (const userId of [originalRequesterId, retryAdminId]) {
        await setTestBranchUserRole(db, branch.branch_id, userId, 'manager', 'none', branchOwnerId);
      }
      const session = await new SessionRepository(db).create({
        session_id: generateId(),
        branch_id: branch.branch_id,
        agentic_tool: 'opencode',
        created_by: branchOwnerId,
      });
      const sessionRow = await select(db)
        .from(sessions)
        .where(eq(sessions.session_id, session.session_id))
        .one();
      if (!sessionRow) throw new Error('Session row missing');
      await update(db, sessions)
        .set({
          data: {
            ...sessionRow.data,
            sdk_native_state_layout: 'session_root_v1',
            sdk_native_state_store_id: generateId(),
          },
        })
        .where(eq(sessions.session_id, session.session_id))
        .run();

      const sessionTokenService = new SessionTokenService(
        { expiration_ms: 60_000, max_uses: -1 },
        { startCleanupTimer: false }
      );
      sessionTokenService.setJwtSecret(jwtSecret);
      const authApp = feathers();
      authApp.set('authentication', {
        secret: jwtSecret,
        entity: 'user',
        entityId: 'user_id',
        service: 'users',
        authStrategies: ['jwt'],
        jwtOptions: {
          header: { typ: 'access' },
          audience: RUNTIME_JWT_AUDIENCE,
          issuer: RUNTIME_JWT_ISSUER,
          algorithm: 'HS256',
          expiresIn: '5m',
        },
      });
      authApp.use('users', {
        async get(userId: string, params: { tenant?: { tenant_id?: string } }) {
          const tenantId = params.tenant?.tenant_id;
          if (!tenantId) throw new NotAuthenticated('Authenticated tenant is unavailable');
          const user = await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
            new UsersRepository(scoped).findById(userId)
          );
          if (!user) throw new NotAuthenticated('User no longer exists');
          return user;
        },
      });
      const authentication = new AuthenticationService(authApp);
      authentication.register(
        'jwt',
        new RuntimeJWTStrategy({
          sessionTokenService,
          executorRevocationFence: getOrCreateExecutorConnectionRevocationFence(authApp),
          multiTenancy: {
            mode: 'required_from_auth',
            static_tenant_id: 'unused' as never,
            auth_claim: 'tenant_id',
          },
        })
      );
      authApp.use('authentication', authentication);

      const authenticatedUsers: string[] = [];
      const launchBodyUsers: string[] = [];
      const operationIds: string[] = [];
      const serverApp = express();
      serverApp.set('metrics', NOOP_METRICS);
      registerExecutorResponseRoutes(serverApp);
      serverApp.use(express.json());
      serverApp.post('/dispatch', async (req, res) => {
        const { payload, launchUserId } = req.body as {
          payload: { sessionToken: string; params: { sessionId: string; operationId: string } };
          launchUserId: string;
        };
        launchBodyUsers.push(launchUserId);
        operationIds.push(payload.params.operationId);
        try {
          const authResult = await authApp
            .service('authentication')
            .create({ strategy: 'jwt', accessToken: payload.sessionToken }, { provider: 'rest' });
          authenticatedUsers.push(authResult.user.user_id);
          if (authenticatedUsers.length === 1) {
            res.json({ success: false, error: { code: 'UNKNOWN', message: 'retry required' } });
            return;
          }
          await runWithTenantDatabaseScope(db, 'default', async () => {
            const authority = {
              runId: 'reserved-delete-run',
              tokenFingerprint: createHash('sha256').update(payload.sessionToken).digest('hex'),
            };
            const attempts = new OpenCodeCheckpointAttemptRepository(db);
            await attempts.prepareSessionDeleteFiles(
              payload.params.sessionId,
              payload.params.operationId,
              undefined,
              authority
            );
            await attempts.acknowledgeSessionDelete(
              payload.params.sessionId,
              payload.params.operationId,
              [],
              { outcome: 'deleted' },
              undefined,
              authority
            );
          });
          res.json({ success: true, data: { outcome: 'deleted' } });
        } catch {
          res.status(401).json({ success: false, error: { code: 'AUTHENTICATION_FAILED' } });
        }
      });

      const tempDir = await mkdtemp(join(tmpdir(), 'session-delete-auth-'));
      const scriptPath = join(tempDir, 'executor.mjs');
      await writeFile(
        scriptPath,
        `let input=''; for await (const chunk of process.stdin) input+=chunk;\n` +
          `const payload=JSON.parse(input);\n` +
          `let result; try { const dispatch=await fetch(new URL('/dispatch', payload.executorResponse.url), {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({payload,launchUserId:process.argv[2]})}); result=await dispatch.json(); } catch (e) { result={success:false,error:{code:'HARNESS_ERROR',message:String(e)}}; }\n` +
          `const frame={v:1,requestId:payload.executorResponse.requestId,type:'final',seq:0,result};\n` +
          `await fetch(payload.executorResponse.url, {method:'POST',headers:{authorization:'Bearer '+payload.executorResponse.token,'content-type':'application/x-ndjson','x-agor-executor-response-protocol':'executor-response-v1'},body:JSON.stringify(frame)+'\\n'});\n`
      );
      const server = serverApp.listen(0, '127.0.0.1') as Server;
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Test server did not bind a port');
      const origin = `http://127.0.0.1:${address.port}`;
      configureDaemonUrl(origin);
      configureResolvedConfigSlice({} as AgorConfig);
      configureExecutor(
        {
          executor_command_template: `node ${JSON.stringify(scriptPath)} {user_id}`,
          executor_response: {
            origin_url: origin,
            external_protocol: 'executor-response-v1',
            timeout_ms: { default: 5_000 },
          },
        },
        { localResponseOriginUrl: origin }
      );

      const serviceApp = {
        sessionTokenService,
        service(name: string) {
          return name === 'sessions'
            ? { emit: () => undefined }
            : { observeSessionDelete: async () => undefined };
        },
      } as unknown as Application;
      const service = new SessionsService(
        createTenantScopedDatabaseProxy(db, { requireScope: false }),
        serviceApp
      );
      const removerParams = (userId: string) =>
        ({
          provider: 'rest',
          tenant: { tenant_id: 'default' },
          user: { user_id: userId, role: 'member' },
        }) as never;

      try {
        await runWithTenantContext('default', () =>
          expect(
            service.remove(session.session_id, removerParams(originalRequesterId))
          ).rejects.toThrow(/deletion is pending/i)
        );
        const afterFirstFailure = await select(db)
          .from(sessions)
          .where(eq(sessions.session_id, session.session_id))
          .one();
        const firstOperation = afterFirstFailure?.data[OPENCODE_SESSION_DELETE_DATA_KEY] as {
          operation_id: string;
        };
        await runWithTenantDatabaseScope(db, 'default', (scoped) =>
          new UsersRepository(scoped).delete(originalRequesterId)
        );

        await runWithTenantContext('default', () =>
          expect(service.remove(session.session_id, removerParams(retryAdminId))).rejects.toThrow(
            /deletion is pending/i
          )
        );

        expect(authenticatedUsers).toEqual([originalRequesterId, retryAdminId]);
        expect(launchBodyUsers).toEqual([originalRequesterId, originalRequesterId]);
        expect(operationIds).toEqual([firstOperation.operation_id, firstOperation.operation_id]);
        await runWithTenantContext('default', () =>
          expect(
            service.remove(session.session_id, removerParams(retryAdminId))
          ).resolves.toMatchObject({
            session_id: session.session_id,
          })
        );
        await expect(new SessionRepository(db).findById(session.session_id)).resolves.toBeNull();
      } finally {
        sessionTokenService.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(tempDir, { recursive: true, force: true });
        configureExecutor(null, { localResponseOriginUrl: 'http://localhost:3030' });
        configureDaemonUrl('http://localhost:3030');
        resetResolvedConfigSliceForTests();
      }
    }
  );
});
