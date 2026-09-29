import type { AgorConfig } from '@agor/core/config';
import {
  BranchRepository,
  RepoRepository,
  SessionRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { SessionStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { hostedOpenCodeConfig } from '../../test/fixtures/hosted-opencode-config';
import { createDeploymentToolUnsupportedGate } from '../integrations/opencode/deployment-capabilities';
import { SessionsService } from './sessions';

async function fixture(db: TenantScopeAwareDatabase) {
  const user = await new UsersRepository(db).create({
    email: `${generateId()}-sdk-home-session@example.com`,
    name: 'SDK home session owner',
  });
  const repo = await new RepoRepository(db).create({
    slug: `sdk-home-session-${generateId()}`,
    name: 'SDK home session repo',
    repo_type: 'remote',
    remote_url: 'https://example.com/sdk-home-session.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    repo_id: repo.repo_id,
    name: `sdk-home-${generateId()}`,
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    base_ref: 'main',
    new_branch: false,
    created_by: user.user_id,
  });
  return { user, branch };
}

function appWithMode(mode: 'inherit' | 'per_branch'): Application {
  const config = {
    execution: {
      unix_user_mode: 'sandbox',
      sandbox: { enabled: true, home_mode: 'per_user', sdk_home_mode: mode },
    },
  } as AgorConfig;
  return {
    get: (key: string) => (key === 'config' ? config : undefined),
  } as unknown as Application;
}

describe('SessionsService SDK-home admission', () => {
  dbTest('stamps the legacy-safe execution home while the deployment inherits', async ({ db }) => {
    const { user, branch } = await fixture(db);
    const service = new SessionsService(db, appWithMode('inherit'));

    const session = await service.create(
      {
        branch_id: branch.branch_id,
        created_by: user.user_id,
        agentic_tool: 'claude-code',
        status: SessionStatus.IDLE,
      },
      { _agenticConfigResolved: true } as never
    );

    expect(session.sdk_home_scope).toBe('execution_home');
    await expect(new BranchRepository(db).findById(branch.branch_id)).resolves.toMatchObject({
      sdk_home: undefined,
    });
  });

  dbTest('adopts the branch and stamps the fresh session in one admission', async ({ db }) => {
    const { user, branch } = await fixture(db);
    const service = new SessionsService(db, appWithMode('per_branch'));

    const session = await service.create(
      {
        branch_id: branch.branch_id,
        created_by: user.user_id,
        agentic_tool: 'claude-code',
        status: SessionStatus.IDLE,
      },
      { _agenticConfigResolved: true } as never
    );

    expect(session.sdk_home_scope).toBe('branch');
    await expect(new BranchRepository(db).findById(branch.branch_id)).resolves.toMatchObject({
      sdk_home: 'per_branch',
    });
  });

  dbTest('refuses an incompatible tool without adopting the branch', async ({ db }) => {
    const { user, branch } = await fixture(db);
    const service = new SessionsService(db, appWithMode('per_branch'));

    await expect(
      service.create(
        {
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'cursor',
          status: SessionStatus.IDLE,
        },
        { _agenticConfigResolved: true } as never
      )
    ).rejects.toThrow(/cannot use a branch SDK home/i);

    await expect(new BranchRepository(db).findById(branch.branch_id)).resolves.toMatchObject({
      sdk_home: undefined,
    });
    await expect(new SessionRepository(db).findAll()).resolves.toHaveLength(0);
  });

  dbTest(
    'admits local Codex native auth when the pinned sandbox overlay is available',
    async ({ db }) => {
      const { user, branch } = await fixture(db);
      await new UsersRepository(db).update(user.user_id, {
        agentic_auth_methods: { codex: 'subscription' },
      });
      const service = new SessionsService(db, appWithMode('per_branch'));

      await expect(
        service.create(
          {
            branch_id: branch.branch_id,
            created_by: user.user_id,
            agentic_tool: 'codex',
            status: SessionStatus.IDLE,
          },
          { _agenticConfigResolved: true } as never
        )
      ).resolves.toMatchObject({ sdk_home_scope: 'branch' });

      await expect(new BranchRepository(db).findById(branch.branch_id)).resolves.toMatchObject({
        sdk_home: 'per_branch',
      });
      await expect(new SessionRepository(db).findAll()).resolves.toHaveLength(1);
    }
  );

  dbTest('still refuses local Codex native auth without a per-user sandbox', async ({ db }) => {
    const { user, branch } = await fixture(db);
    await new UsersRepository(db).update(user.user_id, {
      agentic_auth_methods: { codex: 'subscription' },
    });
    const app = {
      get: (key: string) =>
        key === 'config'
          ? ({ execution: { sandbox: { sdk_home_mode: 'per_branch' } } } as AgorConfig)
          : undefined,
    } as unknown as Application;
    const service = new SessionsService(db, app);

    await expect(
      service.create(
        {
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'codex',
          status: SessionStatus.IDLE,
        },
        { _agenticConfigResolved: true } as never
      )
    ).rejects.toThrow(/per-user sandbox credential overlay/i);

    await expect(new BranchRepository(db).findById(branch.branch_id)).resolves.toMatchObject({
      sdk_home: undefined,
    });
  });

  dbTest('rejects caller-controlled scope on create and patch', async ({ db }) => {
    const { user, branch } = await fixture(db);
    const service = new SessionsService(db, appWithMode('inherit'));

    await expect(
      service.create({
        branch_id: branch.branch_id,
        created_by: user.user_id,
        agentic_tool: 'claude-code',
        sdk_home_scope: 'branch',
      } as never)
    ).rejects.toThrow(/server-managed/);

    const session = await new SessionRepository(db).create({
      branch_id: branch.branch_id,
      created_by: user.user_id,
      agentic_tool: 'claude-code',
    });
    await expect(
      service.patch(session.session_id, { sdk_home_scope: 'branch' } as never)
    ).rejects.toThrow(/immutable and server-managed/);
  });
});

describe('hosted OpenCode Session scope follows Branch intent', () => {
  dbTest(
    'inherits parent scope for managed cross-tool children on an adopted Branch',
    async ({ db }) => {
      const { user, branch } = await fixture(db);
      await new UsersRepository(db).update(user.user_id, { unix_username: 'owner-home' });
      const branches = new BranchRepository(db);
      await branches.adoptSdkHome(branch.branch_id);
      const parent = await new SessionRepository(db).create({
        branch_id: branch.branch_id,
        created_by: user.user_id,
        unix_username: 'owner-home',
        agentic_tool: 'claude-code',
        sdk_home_scope: 'branch',
        status: SessionStatus.IDLE,
      });
      const config = hostedOpenCodeConfig();
      const app = {
        get: (key: string) => (key === 'config' ? config : undefined),
        service: (path: string) => {
          if (path === 'users')
            return { get: (id: string) => new UsersRepository(db).findById(id) };
          if (path === 'sessions') return { emit: () => undefined };
          throw new Error(`Unexpected service ${path}`);
        },
      } as unknown as Application;
      const service = new SessionsService(
        db,
        app,
        () => true,
        createDeploymentToolUnsupportedGate(config)
      );
      const child = await service.spawn(parent.session_id, {
        prompt: 'Fresh child',
        agent: 'opencode',
        modelConfig: { mode: 'exact', provider: 'anthropic', model: 'claude-sonnet-4-5' },
        enableCallback: false,
      });
      expect(child).toMatchObject({
        agentic_tool: 'opencode',
        sdk_home_scope: 'branch',
        genealogy: { parent_session_id: parent.session_id },
      });
      expect((await new SessionRepository(db).findById(parent.session_id))?.sdk_home_scope).toBe(
        'branch'
      );
      expect((await branches.findById(branch.branch_id))?.sdk_home).toBe('per_branch');

      const executionHomeParent = await new SessionRepository(db).create({
        branch_id: branch.branch_id,
        created_by: user.user_id,
        unix_username: 'owner-home',
        agentic_tool: 'claude-code',
        sdk_home_scope: 'execution_home',
        status: SessionStatus.IDLE,
      });
      const executionHomeChild = await service.spawn(executionHomeParent.session_id, {
        prompt: 'Fresh execution-home child',
        agent: 'opencode',
        modelConfig: { mode: 'exact', provider: 'anthropic', model: 'claude-sonnet-4-5' },
        enableCallback: false,
      });
      expect(executionHomeChild).toMatchObject({
        agentic_tool: 'opencode',
        sdk_home_scope: 'execution_home',
        genealogy: { parent_session_id: executionHomeParent.session_id },
      });
      expect(
        (await new SessionRepository(db).findById(executionHomeParent.session_id))?.sdk_home_scope
      ).toBe('execution_home');
      expect((await branches.findById(branch.branch_id))?.sdk_home).toBe('per_branch');
    }
  );

  dbTest('allows switching a branch-scoped Session to managed OpenCode', async ({ db }) => {
    const { user, branch } = await fixture(db);
    const config = hostedOpenCodeConfig();
    const service = new SessionsService(
      db,
      {
        get: (key: string) => (key === 'config' ? config : undefined),
      } as unknown as Application,
      () => true,
      createDeploymentToolUnsupportedGate(config)
    );
    const session = await service.create(
      {
        branch_id: branch.branch_id,
        created_by: user.user_id,
        agentic_tool: 'claude-code',
        status: SessionStatus.IDLE,
      },
      { _agenticConfigResolved: true } as never
    );

    await expect(
      service.patch(
        session.session_id,
        {
          agentic_tool: 'opencode',
          model_config: {
            mode: 'exact',
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            updated_at: new Date().toISOString(),
          },
        },
        { _agenticConfigResolved: true } as never
      )
    ).resolves.toMatchObject({ agentic_tool: 'opencode', sdk_home_scope: 'branch' });
    await expect(new SessionRepository(db).findById(session.session_id)).resolves.toMatchObject({
      agentic_tool: 'opencode',
      sdk_home_scope: 'branch',
    });
  });

  for (const adopted of [false, true]) {
    dbTest(
      `new managed sessions use branch scope (already adopted: ${adopted})`,
      async ({ db }) => {
        const { user, branch } = await fixture(db);
        const branchRepo = new BranchRepository(db);
        if (adopted) await branchRepo.adoptSdkHome(branch.branch_id);
        const config = hostedOpenCodeConfig();
        expect(config.execution.sandbox.sdk_home_mode).toBe('per_branch');
        const gate = createDeploymentToolUnsupportedGate(config);
        expect(gate('opencode')).toBeUndefined();
        const app = {
          get: (key: string) => (key === 'config' ? config : undefined),
        } as unknown as Application;
        const service = new SessionsService(db, app, () => true, gate);
        const data = {
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'opencode' as const,
          status: SessionStatus.IDLE,
          model_config: {
            mode: 'exact' as const,
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            updated_at: new Date().toISOString(),
          },
        };
        const session = await service.create(data, { _agenticConfigResolved: true } as never);
        expect(session).toMatchObject({
          sdk_home_scope: 'branch',
          created_by: user.user_id,
        });
        expect((await branchRepo.findById(branch.branch_id))?.sdk_home).toBe('per_branch');
        // Existing execution-home lineage remains immutable even after the
        // Branch adopts its future-session intent.
        const inherited = await service.create(data, {
          _agenticConfigResolved: true,
          _sdkHomeScope: 'execution_home',
        } as never);
        expect(inherited.sdk_home_scope).toBe('execution_home');
        await expect(
          service.create(data, {
            _agenticConfigResolved: true,
            _sdkHomeScope: 'branch',
          } as never)
        ).resolves.toMatchObject({ sdk_home_scope: 'branch' });
        expect((await branchRepo.findById(branch.branch_id))?.sdk_home).toBe('per_branch');
        // A different tool still adopts/uses the Cloud branch home.
        const other = await service.create(
          {
            branch_id: branch.branch_id,
            created_by: user.user_id,
            agentic_tool: 'claude-code',
            status: SessionStatus.IDLE,
          },
          { _agenticConfigResolved: true } as never
        );
        expect(other.sdk_home_scope).toBe('branch');
      }
    );
  }
});

dbTest('managed OpenCode respects inherit mode on an unadopted branch', async ({ db }) => {
  const { user, branch } = await fixture(db);
  const config = {
    ...hostedOpenCodeConfig(),
    execution: {
      ...hostedOpenCodeConfig().execution,
      sandbox: { ...hostedOpenCodeConfig().execution.sandbox, sdk_home_mode: 'inherit' as const },
    },
  } as AgorConfig;
  const service = new SessionsService(
    db,
    { get: (key: string) => (key === 'config' ? config : undefined) } as unknown as Application,
    () => true,
    createDeploymentToolUnsupportedGate(config)
  );

  const session = await service.create(
    {
      branch_id: branch.branch_id,
      created_by: user.user_id,
      agentic_tool: 'opencode',
      status: SessionStatus.IDLE,
      model_config: {
        mode: 'exact',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        updated_at: new Date().toISOString(),
      },
    },
    { _agenticConfigResolved: true } as never
  );

  expect(session.sdk_home_scope).toBe('execution_home');
  await expect(new BranchRepository(db).findById(branch.branch_id)).resolves.toMatchObject({
    sdk_home: undefined,
  });
});

dbTest(
  'local cross-tool spawn preserves an inherited execution home on an adopted branch',
  async ({ db }) => {
    const { user, branch } = await fixture(db);
    const branches = new BranchRepository(db);
    await branches.adoptSdkHome(branch.branch_id);
    const parent = await new SessionRepository(db).create({
      branch_id: branch.branch_id,
      created_by: user.user_id,
      agentic_tool: 'claude-code',
      sdk_home_scope: 'execution_home',
      status: SessionStatus.IDLE,
    });
    const config = {
      execution: {
        unix_user_mode: 'sandbox',
        sandbox: { enabled: true, home_mode: 'per_user', sdk_home_mode: 'per_branch' },
      },
    } as AgorConfig;
    const app = {
      get: (key: string) => (key === 'config' ? config : undefined),
      service: (path: string) => {
        if (path === 'users') return { get: (id: string) => new UsersRepository(db).findById(id) };
        if (path === 'sessions') return { emit: () => undefined };
        throw new Error(`Unexpected service ${path}`);
      },
    } as unknown as Application;
    const service = new SessionsService(db, app);
    const child = await service.spawn(parent.session_id, {
      prompt: 'Local child',
      agent: 'opencode',
      modelConfig: { mode: 'exact', provider: 'anthropic', model: 'claude-sonnet-4-5' },
      enableCallback: false,
    });
    expect(child.sdk_home_scope).toBe('execution_home');
    expect((await branches.findById(branch.branch_id))?.sdk_home).toBe('per_branch');
  }
);
