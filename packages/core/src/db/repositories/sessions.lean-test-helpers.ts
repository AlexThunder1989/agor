import { expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { projectLeanSession, type Session, type UserID } from '../../types';
import type { Database } from '../client';
import { BoardRepository } from './boards';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { UsersRepository } from './users';

/**
 * Lean page projection contract exercised on SQLite and PostgreSQL: the SQL
 * projection must match the in-memory `projectLeanSession` row for row, and the
 * page window/total must not change.
 */
export async function exerciseLeanSessionPage(db: Database) {
  const owner = (
    await new UsersRepository(db).create({
      email: `${generateId()}@example.invalid`,
      role: 'member',
    })
  ).user_id as UserID;
  const board = await new BoardRepository(db).create({ name: 'Lean', created_by: owner });
  const repo = await new RepoRepository(db).create({
    slug: `lean-${generateId()}`,
    name: 'Lean',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/lean.git',
    local_path: '/tmp/lean',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    repo_id: repo.repo_id,
    board_id: board.board_id,
    created_by: owner,
    name: 'lean',
    ref: 'lean',
    path: '/tmp/lean/lean',
    branch_unique_id: 1,
  });
  const gatewaySource = {
    channel_id: 'channel',
    channel_name: 'Slack',
    channel_type: 'slack' as const,
    thread_id: 'thread',
  };
  const contexts: Array<Session['custom_context']> = [
    {
      teamName: 'Backend',
      gateway_source: gatewaySource,
      slash_commands: ['review', 'compact'],
      skills: ['pdf'],
    },
    { scheduled_run: { rendered_prompt: 'x'.repeat(4096), run_index: 3 } },
    undefined,
    { teamName: 'only user keys' },
    { skills: null },
  ];
  const sessions = new SessionRepository(db);
  for (const [index, custom_context] of contexts.entries()) {
    await sessions.create({
      branch_id: branch.branch_id,
      created_by: owner,
      created_at: new Date(1_700_000_000_000 + index).toISOString(),
      title: `lean-${index}`,
      custom_context,
    });
  }

  const query = { branchId: branch.branch_id, sortCreatedAt: 1 as const, limit: 10 };
  const full = await sessions.findPage(query);
  const lean = await sessions.findPage({ ...query, lean: true });
  expect(lean.total).toBe(full.total);
  expect(lean.data.map((s) => s.session_id)).toEqual(full.data.map((s) => s.session_id));
  expect(lean.data).toEqual(full.data.map(projectLeanSession));

  const [withCommands, scheduled, noContext, userOnly, nullSkill] = lean.data;
  expect(withCommands.custom_context).toEqual({
    teamName: 'Backend',
    gateway_source: gatewaySource,
  });
  expect(withCommands.custom_context_omitted).toEqual(['slash_commands', 'skills']);
  expect(scheduled.custom_context).toEqual({});
  expect(scheduled.custom_context_omitted).toEqual(['scheduled_run']);
  // Rows with nothing withheld are complete and carry no marker.
  expect(noContext).toEqual(full.data[2]);
  expect(noContext.custom_context_omitted).toBeUndefined();
  expect(userOnly).toEqual(full.data[3]);
  expect(nullSkill.custom_context_omitted).toEqual(['skills']);
  // The default (non-lean) shape is unchanged.
  expect(full.data[0].custom_context).toMatchObject({ slash_commands: ['review', 'compact'] });
  expect(full.data.every((s) => s.custom_context_omitted === undefined)).toBe(true);
  // RBAC pushdown composes with the projection unchanged.
  expect(await sessions.findPage({ ...query, lean: true, visibleToUserId: owner })).toEqual(lean);
  // Single reads always stay full.
  expect((await sessions.findById(withCommands.session_id))?.custom_context).toEqual(contexts[0]);
  return { branchId: branch.branch_id, owner, full: full.data };
}
