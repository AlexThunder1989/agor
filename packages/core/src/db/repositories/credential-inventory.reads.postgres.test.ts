import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveUserEnvironment } from '../../config/env-resolver';
import { resolveProviderConnection } from '../../config/tenant-agentic-tool-resolver';
import { generateId } from '../../lib/ids';
import type { GatewayChannel, UserID } from '../../types';
import { createDatabase, type Database } from '../client';
import { select } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { users } from '../schema';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { AppVariableRepository } from './app-variables';
import { BranchRepository } from './branches';
import { GatewayChannelRepository } from './gateway-channels';
import { RepoRepository } from './repos';
import { TenantAgenticToolSettingsRepository } from './tenant-agentic-tools';
import { UsersRepository } from './users';

const url = process.env.AGOR_TEST_POSTGRES_URL;

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'credential inventories preserve PostgreSQL tenant isolation across async decryption',
  () => {
    let db: Database;
    const tenants = [`inventory-a-${generateId()}`, `inventory-b-${generateId()}`];
    const owners = new Map<string, { user: UserID; channel: GatewayChannel }>();

    beforeAll(async () => {
      vi.stubEnv('AGOR_MASTER_SECRET', 'synthetic-inventory-master');
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
      const role = await select(db, { safe: sql<boolean>`NOT rolsuper AND NOT rolbypassrls` })
        .from(sql`pg_roles`)
        .where(sql`rolname = current_user`)
        .one();
      expect(role?.safe).toBe(true);
      for (const [index, tenant] of tenants.entries()) {
        await runWithTenantDatabaseScope(db, tenant, async (scoped) => {
          const user = await new UsersRepository(scoped).create({
            email: `${tenant}@example.invalid`,
            name: 'Synthetic inventory test',
          });
          const repo = await new RepoRepository(scoped).create({
            repo_id: generateId(),
            slug: `inventory-${tenant}`,
            name: 'Synthetic',
            repo_type: 'remote',
            remote_url: 'https://example.invalid/repo.git',
            local_path: `/tmp/${generateId()}`,
            default_branch: 'main',
          });
          const branch = await new BranchRepository(scoped).create({
            branch_id: generateId(),
            repo_id: repo.repo_id,
            name: 'main',
            ref: 'main',
            branch_unique_id: 8123456 + index,
            path: `/tmp/${generateId()}`,
            created_by: user.user_id,
          });
          const channel = await new GatewayChannelRepository(scoped).create({
            name: 'Synthetic',
            channel_type: 'slack',
            created_by: user.user_id,
            agor_user_id: user.user_id,
            target_branch_id: branch.branch_id,
            channel_key: generateId(),
            enabled: true,
            config: { bot_token: `bot-${tenant}`, app_token: `app-${tenant}` },
          });
          owners.set(tenant, { user: user.user_id, channel });
          await new UsersRepository(scoped).setToolConfigField(
            user.user_id,
            'codex',
            'OPENAI_API_KEY',
            `user-key-${tenant}`
          );
          const users = new UsersRepository(scoped);
          await users.setToolConfigField(
            user.user_id,
            'opencode',
            'provider:openai',
            JSON.stringify({ type: 'api', key: `openai-${tenant}` })
          );
          await users.setToolConfigField(
            user.user_id,
            'opencode',
            'provider:anthropic',
            JSON.stringify({ type: 'api', key: `anthropic-${tenant}` })
          );
          await users.setToolConfigField(
            user.user_id,
            'opencode',
            'OPENCODE_API_KEY_OPENAI',
            `legacy-openai-${tenant}`
          );
          await new TenantAgenticToolSettingsRepository(scoped).patch('codex', {
            connection: { OPENAI_API_KEY: `key-${tenant}` },
          });
        });
      }
    }, 60000);

    afterAll(async () => {
      vi.unstubAllEnvs();
      if (db) await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });

    it('returns only the concurrent caller tenant, including same-key settings and user-filtered gateway reads', async () => {
      await Promise.all(
        tenants.map((tenant) =>
          runWithTenantDatabaseScope(db, tenant, async (scoped) => {
            const own = owners.get(tenant)!;
            const foreign = owners.get(tenants.find((value) => value !== tenant)!)!;
            const channels = new GatewayChannelRepository(scoped);
            const settings = new TenantAgenticToolSettingsRepository(scoped);
            const [inventory, tools] = await Promise.all([channels.findAll(), settings.findAll()]);
            expect(inventory).toHaveLength(1);
            expect(inventory[0]).toMatchObject({
              id: own.channel.id,
              config: { bot_token: `bot-${tenant}`, app_token: `app-${tenant}` },
            });
            expect(Object.getOwnPropertyDescriptor(inventory[0], 'tenant_id')).toMatchObject({
              value: tenant,
              enumerable: false,
            });
            expect(tools.get('codex')?.connection?.OPENAI_API_KEY).toBe(`key-${tenant}`);
            expect(
              await resolveProviderConnection('codex', { userId: own.user, db: scoped })
            ).toMatchObject({
              source: 'user',
              connection: { OPENAI_API_KEY: `user-key-${tenant}` },
            });
            const userRepo = new UsersRepository(scoped);
            expect(await userRepo.getToolConfigField(own.user, 'codex', 'OPENAI_API_KEY')).toBe(
              `user-key-${tenant}`
            );
            const ownOpenCode = await userRepo.getToolConfig(own.user, 'opencode');
            expect(ownOpenCode).toMatchObject({
              'provider:openai': JSON.stringify({ type: 'api', key: `openai-${tenant}` }),
              'provider:anthropic': JSON.stringify({ type: 'api', key: `anthropic-${tenant}` }),
              OPENCODE_API_KEY_OPENAI: `legacy-openai-${tenant}`,
            });
            await expect(
              userRepo.getToolConfigField(own.user, 'opencode', 'provider:openai')
            ).resolves.toBe(JSON.stringify({ type: 'api', key: `openai-${tenant}` }));
            await expect(
              userRepo.getToolConfigField(foreign.user, 'opencode', 'provider:openai')
            ).resolves.toBeNull();
            await userRepo.setToolConfigField(
              own.user,
              'opencode',
              'provider:openai',
              JSON.stringify({ type: 'api', key: `rotated-openai-${tenant}` })
            );
            await userRepo.deleteToolConfigField(own.user, 'opencode', 'provider:anthropic');
            await expect(
              userRepo.getToolConfigField(own.user, 'opencode', 'provider:openai')
            ).resolves.toBe(JSON.stringify({ type: 'api', key: `rotated-openai-${tenant}` }));
            await expect(
              userRepo.getToolConfigField(own.user, 'opencode', 'provider:anthropic')
            ).resolves.toBeNull();
            const publicUser = await userRepo.findById(own.user);
            expect(publicUser?.agentic_tools?.opencode).toEqual({
              'provider:openai': true,
              OPENCODE_API_KEY_OPENAI: true,
            });
            const rawUser = await select(scoped)
              .from(users)
              .where(eq(users.user_id, own.user))
              .one();
            expect(JSON.stringify(rawUser?.data)).not.toContain(`rotated-openai-${tenant}`);
            expect(await userRepo.getToolConfig(own.user, 'codex')).toMatchObject({
              OPENAI_API_KEY: `user-key-${tenant}`,
            });
            await expect(userRepo.getToolConfig(foreign.user, 'codex')).resolves.toBeNull();
            await expect(
              userRepo.getToolConfigField(foreign.user, 'codex', 'OPENAI_API_KEY')
            ).resolves.toBeNull();
            expect(await resolveUserEnvironment(own.user, scoped, { tool: 'codex' })).toMatchObject(
              { OPENAI_API_KEY: `user-key-${tenant}` }
            );
            expect(
              await resolveUserEnvironment(foreign.user, scoped, { tool: 'codex' })
            ).not.toHaveProperty('OPENAI_API_KEY');
            // A foreign user ID cannot select their credential; normal tenant fallback remains local.
            expect(
              await resolveProviderConnection('codex', { userId: foreign.user, db: scoped })
            ).toMatchObject({ source: 'tenant', connection: { OPENAI_API_KEY: `key-${tenant}` } });
            expect((await channels.findByUser(own.user)).map((channel) => channel.id)).toEqual([
              own.channel.id,
            ]);
            await expect(channels.findByUser(foreign.user)).resolves.toEqual([]);
            await expect(channels.findById(foreign.channel.id)).resolves.toBeNull();
            await expect(channels.findByKey(foreign.channel.channel_key)).resolves.toBeNull();
            // No status/plaintext cache may outlive credential deletion or rotation.
            await new AppVariableRepository(scoped).delete('agentic_tools', 'codex');
            expect((await settings.findAll()).get('codex')).toEqual({});
            await channels.update(own.channel.id, { config: { bot_token: 'rotated' } });
            expect((await channels.findAll())[0].config.bot_token).toBe('rotated');
            await channels.delete(own.channel.id);
            await expect(channels.findAll()).resolves.toEqual([]);
          })
        )
      );
    });
  }
);
