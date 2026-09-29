import { OPENCODE_VERSION } from '@agor/agentic-tool-opencode';
import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  generateId,
  initializeDatabase,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type {
  AuthenticatedParams,
  OpenCodeProviderCatalogArtifact,
  User,
  UserID,
} from '@agor/core/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers.js';
import { ConfigService } from './config.js';
import { UsersService } from './users.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';
const hostedCatalog: OpenCodeProviderCatalogArtifact = {
  schemaVersion: 1,
  runtimeVersion: OPENCODE_VERSION,
  connected: ['opencode'],
  providers: [
    ...['openai', 'azure', 'opencode'].map((id) => ({
      id,
      name: id,
      env: [],
      models: [{ id: `${id}-model`, name: `${id} model`, status: 'active' as const }],
      authMethods: [{ index: 0, type: 'api' as const, label: 'API key' }],
    })),
    {
      id: 'oauth-only',
      name: 'OAuth only',
      env: [],
      models: [{ id: 'oauth-model', name: 'OAuth model', status: 'active' }],
      authMethods: [{ index: 0, type: 'oauth', label: 'Sign in' }],
    },
  ],
};

function executorParams(user: User, tenantId: string): AuthenticatedParams {
  return {
    provider: 'socketio',
    user: { user_id: user.user_id, email: user.email, role: user.role },
    tenant: { tenant_id: tenantId, source: 'auth_claim' },
    authentication: {
      strategy: 'jwt',
      payload: {
        type: 'executor-session',
        purpose: 'executor-task',
        task_id: 'shared-task',
        session_id: 'shared-session',
      },
    },
  } as AuthenticatedParams;
}

async function verifyProviderEntryBoundary(db: TenantScopeAwareDatabase, tenantId: string) {
  vi.stubEnv('AGOR_MASTER_SECRET', 'synthetic-opencode-entry-test-key');
  const scoped = await runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
    const repository = new UsersRepository(tenantDb);
    const alice = await repository.create({ email: `alice-${generateId()}@example.invalid` });
    const bob = await repository.create({ email: `bob-${generateId()}@example.invalid` });
    const users = new UsersService(db);
    const aliceParams = executorParams(alice, tenantId);
    await users.patch(
      alice.user_id as UserID,
      {
        agentic_tools: {
          opencode: {
            'provider:azure': JSON.stringify({ type: 'oauth', key: 'synthetic-invalid-entry' }),
            'provider:openai': JSON.stringify({
              type: 'api',
              key: 'alice-synthetic-key',
              endpoint: 'https://alice-saved.example.invalid/v1',
            }),
          },
        },
      },
      aliceParams
    );

    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('provider I/O forbidden during resolution'));
    let taskActor = alice;
    let selectedProvider = 'azure';
    const config = new ConfigService(
      db,
      {},
      undefined,
      undefined,
      undefined,
      async () => hostedCatalog
    );
    config.app = {
      service(name: string) {
        if (name === 'tasks') {
          return {
            get: vi.fn(async () => ({
              created_by: taskActor.user_id,
              session_id: 'shared-session',
            })),
          };
        }
        if (name === 'sessions') {
          return {
            get: vi.fn(async () => ({
              session_id: 'shared-session',
              branch_id: 'shared-branch',
              agentic_tool: 'opencode',
              model_config: { provider: selectedProvider },
            })),
          };
        }
        throw new Error(`unexpected service ${name}`);
      },
    } as never;

    const malformed = await config.resolveApiKey(
      { taskId: 'shared-task' as never, providerId: 'azure', tool: 'opencode' },
      aliceParams
    );
    expect(malformed).toMatchObject({ apiKey: null, decryptionFailed: true, source: 'user' });
    expect(malformed.connection).toBeUndefined();

    for (const value of ['{', JSON.stringify({ type: 'api', key: 'x'.repeat(65 * 1024) })]) {
      await users.patch(
        alice.user_id as UserID,
        {
          agentic_tools: { opencode: { 'provider:azure': value } },
        },
        aliceParams
      );
      const invalid = await config.resolveApiKey(
        { taskId: 'shared-task' as never, providerId: 'azure', tool: 'opencode' },
        aliceParams
      );
      expect(invalid).toMatchObject({ apiKey: null, decryptionFailed: true, source: 'user' });
      expect(invalid.connection).toBeUndefined();
    }
    for (const providerId of ['opencode', 'oauth-only']) {
      selectedProvider = providerId;
      const unavailable = await config.resolveApiKey(
        { taskId: 'shared-task' as never, providerId, tool: 'opencode' },
        aliceParams
      );
      expect(unavailable).toMatchObject({ apiKey: null, useNativeAuth: false });
      expect(unavailable.providerUnavailable).toBeTruthy();
      expect(unavailable.connection).toBeUndefined();
    }
    taskActor = alice;
    selectedProvider = 'openai';
    const aliceTurn = await config.resolveApiKey(
      { taskId: 'shared-task' as never, providerId: 'openai', tool: 'opencode' },
      aliceParams
    );
    taskActor = bob;
    const bobTurn = await config.resolveApiKey(
      { taskId: 'shared-task' as never, providerId: 'openai', tool: 'opencode' },
      executorParams(bob, tenantId)
    );
    expect(aliceTurn.connection).toEqual({
      'provider:openai': JSON.stringify({
        type: 'api',
        key: 'alice-synthetic-key',
        endpoint: 'https://alice-saved.example.invalid/v1',
      }),
    });
    expect(bobTurn).toMatchObject({ apiKey: null, source: 'none', useNativeAuth: false });
    expect(bobTurn.connection).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
    return { alice, bob, users, aliceTurn, bobTurn };
  });
  return scoped;
}

describe.skipIf(usesPostgresSchema)('OpenCode provider entry boundary (SQLite)', () => {
  dbTest(
    'round-trips an invalid direct user-service entry and resolves shared-session credentials per Task actor',
    async ({ db }) => {
      await verifyProviderEntryBoundary(db, `opencode-entry-${generateId()}`);
    }
  );
});

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'OpenCode provider entry boundary (PostgreSQL/RLS)',
  () => {
    let raw: Database;
    let db: TenantScopeAwareDatabase;

    beforeAll(async () => {
      raw = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(raw);
      db = createTenantScopedDatabaseProxy(raw, {
        requireScope: true,
        label: 'OpenCode provider entry integration test',
      });
    }, 60_000);

    afterAll(async () => {
      await (raw as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('round-trips an invalid direct user-service entry and resolves shared-session credentials per Task actor', async () => {
      await verifyProviderEntryBoundary(db, `opencode-entry-${generateId()}`);
    }, 60_000);
  }
);
