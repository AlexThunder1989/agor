import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { PAGINATION } from '../../config/constants';
import { generateId } from '../../lib/ids';
import type {
  BoardID,
  BranchID,
  BranchPermissionConfig,
  CapabilityPolicyEntry,
  CapabilityPolicyFsAccess,
  CapabilityPolicyKind,
  CapabilityPolicyPresetId,
  Session,
  SessionID,
  UserID,
} from '../../types';
import { capabilityPolicyPresetCapabilities } from '../../types/capability-policy';
import type { Database } from '../client';
import { deleteFrom, select, update } from '../database-wrapper';
import { branches, branchPermissionConfigs, sessions } from '../schema';
import { tenantInventoryCondition } from '../tenant-inventory-condition';
import { BoardRepository } from './boards';
import { inVisibleBranchSet } from './branch-access';
import { BranchRepository } from './branches';
import { CapabilityPolicyRepository } from './capability-policies';
import { GroupRepository } from './groups';
import { RepoRepository } from './repos';
import { type SessionPageOptions, SessionRepository } from './sessions';
import { UsersRepository } from './users';

const USER_NAMES = [
  'owner',
  'viewerDirect',
  'noneDirect',
  'groupMember',
  'outsider',
  'superadmin',
  'viewerRole',
] as const;
type UserName = (typeof USER_NAMES)[number];

export interface SessionVisibilityFixture {
  users: Record<UserName, UserID>;
  boardIds: BoardID[];
  branchIds: BranchID[];
  /** Live sessions, plus sessions of a deleted branch (cascade-removed). */
  sessionIds: SessionID[];
  deletedSessionIds: SessionID[];
}

type Row = [SessionID, string | null];
type Page = { rows: Row[]; total?: number };

/**
 * The pre-per-row SessionRepository.findPage composition, verbatim apart from
 * the projection: every row filter plus `inVisibleBranchSet(..., opts)`.
 */
export async function legacySessionPage(db: Database, opts: SessionPageOptions): Promise<Page> {
  const tenantCondition = tenantInventoryCondition(db, sessions);
  if (opts.branchIds?.length === 0 || opts.sessionIds?.length === 0)
    return opts.includeTotal === false ? { rows: [] } : { rows: [], total: 0 };
  const conditions = [];
  if (tenantCondition) conditions.push(tenantCondition);
  if (opts.status !== undefined) conditions.push(eq(sessions.status, opts.status));
  if (opts.boardId !== undefined) conditions.push(eq(branches.board_id, opts.boardId));
  if (opts.branchId !== undefined) conditions.push(eq(sessions.branch_id, opts.branchId));
  if (opts.branchIds !== undefined) conditions.push(inArray(sessions.branch_id, opts.branchIds));
  if (opts.sessionIds !== undefined) conditions.push(inArray(sessions.session_id, opts.sessionIds));
  if (opts.createdBy !== undefined) conditions.push(eq(sessions.created_by, opts.createdBy));
  if (opts.archived !== undefined) conditions.push(eq(sessions.archived, opts.archived));
  if (opts.visibleToUserId) {
    conditions.push(inVisibleBranchSet(db, opts.visibleToUserId, sessions.branch_id, opts));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  let total: number | undefined;
  if (opts.includeTotal !== false) {
    // biome-ignore lint/suspicious/noExplicitAny: Mirrors the repository's conditional builder.
    const countQuery: any = select(db, { count: sql<number>`count(*)` })
      .from(sessions)
      .leftJoin(branches, eq(sessions.branch_id, branches.branch_id));
    const countRow = await (whereClause ? countQuery.where(whereClause) : countQuery).one();
    total = Number(countRow?.count ?? 0);
  }
  if (opts.limit === 0) return { rows: [], ...(total === undefined ? {} : { total }) };
  // biome-ignore lint/suspicious/noExplicitAny: Mirrors the repository's conditional builder.
  let dataQuery: any = select(db, { id: sessions.session_id, board: branches.board_id })
    .from(sessions)
    .leftJoin(branches, eq(sessions.branch_id, branches.branch_id));
  if (whereClause) dataQuery = dataQuery.where(whereClause);
  if (opts.sortUpdatedAt !== undefined) {
    dataQuery = dataQuery.orderBy(
      opts.sortUpdatedAt === -1 ? desc(sessions.updated_at) : asc(sessions.updated_at),
      asc(sessions.session_id)
    );
  } else if (opts.sortCreatedAt !== undefined) {
    dataQuery = dataQuery.orderBy(
      opts.sortCreatedAt === -1 ? desc(sessions.created_at) : asc(sessions.created_at),
      asc(sessions.session_id)
    );
  } else {
    dataQuery = dataQuery.orderBy(asc(sessions.created_at), asc(sessions.session_id));
  }
  if (opts.limit !== undefined) dataQuery = dataQuery.limit(opts.limit);
  if (opts.skip) dataQuery = dataQuery.offset(opts.skip);
  const rows = (await dataQuery.all()) as { id: SessionID; board: string | null }[];
  return {
    rows: rows.map((row) => [row.id, row.board ?? null]),
    ...(total === undefined ? {} : { total }),
  };
}

async function currentFindPage(db: Database, opts: SessionPageOptions): Promise<Page> {
  const page = await new SessionRepository(db).findPage(opts);
  return {
    rows: page.data.map((s: Session) => [s.session_id, s.branch_board_id ?? null]),
    ...(page.total === undefined ? {} : { total: page.total }),
  };
}

/**
 * Seed every visibility tier the session reads must respect: primary owners,
 * direct grants and direct `none` shadows, active and archived groups, Others
 * fallbacks, private packages (including on shared boards and with dormant
 * entries), inherited board templates, board-less and archived branches, a
 * deleted branch, and sessions from many creators with tied timestamps.
 */
export async function seedSessionVisibilityFixture(
  db: Database
): Promise<SessionVisibilityFixture> {
  const userRepo = new UsersRepository(db);
  const users = {} as Record<UserName, UserID>;
  for (const name of USER_NAMES) {
    const role = name === 'superadmin' ? 'superadmin' : name === 'viewerRole' ? 'viewer' : 'member';
    users[name] = (
      await userRepo.create({ email: `${name}-${generateId()}@example.invalid`, role })
    ).user_id as UserID;
  }
  const groupRepo = new GroupRepository(db);
  const active = await groupRepo.create({
    name: `Active-${generateId()}`,
    created_by: users.owner,
  });
  const archived = await groupRepo.create({
    name: `Archived-${generateId()}`,
    created_by: users.owner,
  });
  for (const name of ['groupMember', 'viewerRole', 'noneDirect'] as const)
    await groupRepo.addMember(active.group_id, users[name], users.owner);
  for (const name of ['groupMember', 'noneDirect'] as const)
    await groupRepo.addMember(archived.group_id, users[name], users.owner);

  const grant = (
    kind: CapabilityPolicyKind,
    preset: CapabilityPolicyPresetId,
    fs_access: CapabilityPolicyFsAccess = 'none'
  ) => {
    const capabilities = capabilityPolicyPresetCapabilities(kind, preset, fs_access);
    if (!capabilities) throw new Error(`Invalid test role ${kind}/${preset}/${fs_access}`);
    return { preset, capabilities, fs_access };
  };
  const user = (name: UserName) => ({ principal_type: 'user' as const, user_id: users[name] });
  const activeGroup = { principal_type: 'group' as const, group_id: active.group_id };
  const archivedGroup = { principal_type: 'group' as const, group_id: archived.group_id };
  const entry = (
    principal: CapabilityPolicyEntry['principal'],
    preset: CapabilityPolicyPresetId,
    fs: CapabilityPolicyFsAccess = 'none'
  ): CapabilityPolicyEntry => ({
    entry_id: generateId(),
    principal,
    ...grant('branch_access', preset, fs),
  });
  const config = (
    sharing: 'private' | 'shared',
    others: CapabilityPolicyPresetId,
    entries: CapabilityPolicyEntry[] = [],
    othersFs: CapabilityPolicyFsAccess = 'none'
  ): BranchPermissionConfig => ({
    access: {
      schema_version: 1,
      policy_kind: 'branch_access',
      sharing_mode: sharing,
      entries,
      others: grant('branch_access', others, othersFs),
    },
    allow_shared_session_prompts: false,
  });

  const boardRepo = new BoardRepository(db);
  const policies = new CapabilityPolicyRepository(db);
  const board = async (name: string, shared: boolean, template: BranchPermissionConfig) => {
    const created = await boardRepo.create({
      name,
      created_by: users.owner,
      access_mode: shared ? 'shared' : 'private',
    });
    const boardId = created.board_id as BoardID;
    const current = await policies.getBoardPolicies(boardId);
    await policies.replaceBoardPolicies(
      boardId,
      { ...current, branch_template: template },
      users.owner
    );
    return boardId;
  };
  const sharedBoard = await board('Shared', true, config('shared', 'viewer'));
  const privateBoard = await board('Private', false, config('private', 'none'));
  const groupBoard = await board(
    'Group template',
    true,
    config('shared', 'none', [entry(activeGroup, 'viewer'), entry(user('noneDirect'), 'none')])
  );

  const repo = await new RepoRepository(db).create({
    slug: `session-visibility-${generateId()}`,
    name: 'Session visibility',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/session-visibility.git',
    local_path: '/tmp/session-visibility',
    default_branch: 'main',
  });
  const branchRepo = new BranchRepository(db);
  const specs: {
    name: string;
    board: BoardID | null;
    owner?: UserName;
    inherit?: boolean;
    archived?: boolean;
    override?: BranchPermissionConfig;
    /** Flip the stored package to private after writing (the API refuses this shape). */
    forcePrivate?: boolean;
  }[] = [
    { name: 'inherit-shared', board: sharedBoard, inherit: true },
    { name: 'inherit-private', board: privateBoard, inherit: true },
    { name: 'inherit-group', board: groupBoard, inherit: true },
    { name: 'private-on-shared-board', board: sharedBoard, override: config('private', 'none') },
    {
      name: 'others-view-direct-none',
      board: sharedBoard,
      override: config('shared', 'viewer', [entry(user('noneDirect'), 'none')]),
    },
    {
      name: 'direct-viewer-only',
      board: sharedBoard,
      override: config('shared', 'none', [entry(user('viewerDirect'), 'viewer')]),
    },
    {
      name: 'others-collaborator-write',
      board: groupBoard,
      override: config('shared', 'collaborator', [], 'write'),
    },
    {
      name: 'group-with-direct-shadow',
      board: groupBoard,
      override: config('shared', 'none', [
        entry(activeGroup, 'viewer'),
        entry(archivedGroup, 'manager', 'write'),
        entry(user('groupMember'), 'none'),
      ]),
    },
    {
      name: 'archived-group-only',
      board: sharedBoard,
      override: config('shared', 'none', [entry(archivedGroup, 'viewer')]),
    },
    {
      name: 'group-none-shadows-others',
      board: sharedBoard,
      override: config('shared', 'viewer', [entry(activeGroup, 'none')]),
    },
    {
      name: 'archived-branch',
      board: sharedBoard,
      archived: true,
      override: config('shared', 'viewer'),
    },
    {
      name: 'owned-by-viewer-direct',
      board: sharedBoard,
      owner: 'viewerDirect',
      override: config('private', 'none'),
    },
    {
      name: 'private-with-dormant-entry',
      board: sharedBoard,
      override: config('shared', 'viewer', [entry(user('viewerDirect'), 'manager', 'write')]),
      forcePrivate: true,
    },
    { name: 'boardless-shared', board: null, override: config('shared', 'viewer') },
    { name: 'boardless-private', board: null, override: config('private', 'none') },
    { name: 'shared-on-private-board', board: privateBoard, override: config('shared', 'viewer') },
    { name: 'deleted', board: sharedBoard, override: config('shared', 'viewer') },
  ];

  const sessionRepo = new SessionRepository(db);
  const branchIds: BranchID[] = [];
  const sessionIds: SessionID[] = [];
  const deletedSessionIds: SessionID[] = [];
  const base = Date.UTC(2026, 0, 1);
  let n = 0;
  for (const [index, spec] of specs.entries()) {
    const owner = users[spec.owner ?? 'owner'];
    const branch = await branchRepo.create({
      repo_id: repo.repo_id,
      ...(spec.board ? { board_id: spec.board } : {}),
      created_by: owner,
      name: spec.name,
      ref: spec.name,
      path: `/tmp/session-visibility/${spec.name}`,
      branch_unique_id: index,
      permission_binding: spec.inherit ? 'inherit' : 'override',
      archived: spec.archived ?? false,
    });
    const branchId = branch.branch_id as BranchID;
    if (spec.override) {
      const policy = await policies.getBranchPolicy(branchId);
      await policies.replaceBranchPolicy(
        branchId,
        { ...policy, override_config: spec.override },
        owner
      );
    }
    if (spec.forcePrivate) {
      await update(db, branchPermissionConfigs)
        .set({ sharing_mode: 'private' })
        .where(eq(branchPermissionConfigs.branch_id, branchId))
        .run();
    }
    for (let k = 0; k < 6; k++, n++) {
      const session = await sessionRepo.create({
        branch_id: branchId,
        created_by: users[USER_NAMES[(index + k) % USER_NAMES.length]],
        status: k % 4 === 1 ? 'running' : 'idle',
        archived: k % 3 === 2,
        // Few distinct instants, so the session_id tie-breaker decides order.
        created_at: new Date(base + ((n * 7) % 11) * 1000).toISOString(),
        title: `${spec.name}-${k}`,
      });
      await update(db, sessions)
        .set({ updated_at: new Date(base + ((n * 5) % 13) * 1000) })
        .where(eq(sessions.session_id, session.session_id))
        .run();
      (spec.name === 'deleted' ? deletedSessionIds : sessionIds).push(session.session_id);
    }
    if (spec.name === 'deleted') {
      // Sessions cascade with their branch; their ids must stay unresolvable.
      await deleteFrom(db, branches).where(eq(branches.branch_id, branchId)).run();
    } else {
      branchIds.push(branchId);
    }
  }
  // Archive only now: policy writes refuse inactive group principals.
  await groupRepo.update(archived.group_id, { archived: true });
  return {
    users,
    boardIds: [sharedBoard, privateBoard, groupBoard],
    branchIds,
    sessionIds,
    deletedSessionIds,
  };
}

/**
 * Differential proof for SessionRepository.findPage's per-row visibility on
 * created_by / exact-id reads: for every principal x query shape it returns
 * exactly the rows, order, board ids and totals of the pre-change branch-set
 * composition, and exactly the rows the TypeScript point resolver allows.
 * `foreign` (PostgreSQL) is another tenant's fixture; its ids and principals
 * must never resolve here.
 */
export async function exerciseSessionVisibilityParity(
  db: Database,
  fixture: SessionVisibilityFixture,
  foreign?: SessionVisibilityFixture
): Promise<number> {
  const { users } = fixture;
  // Oracle: unscoped rows filtered by the independent point resolver.
  const all = (await new SessionRepository(db).findPage({ limit: 10_000 })).data;
  expect(new Set(all.map((s) => s.session_id))).toEqual(new Set(fixture.sessionIds));
  const policies = new CapabilityPolicyRepository(db);
  const visibleBranches = new Map<UserID, Set<string>>();
  for (const name of USER_NAMES) {
    const visible = new Set<string>();
    for (const branchId of fixture.branchIds) {
      const access = await policies.resolveBranchAccess(branchId, users[name]);
      if (access.capabilities.includes('branch.view')) visible.add(branchId);
    }
    visibleBranches.set(users[name], visible);
  }
  // The tiers must actually differ, or the parity below proves little.
  const sizes = new Set([...visibleBranches.values()].map((set) => set.size));
  expect(sizes.size).toBeGreaterThanOrEqual(4);

  const principals: [string, UserID | undefined][] = [
    ...USER_NAMES.map((name) => [name, users[name]] as [string, UserID]),
    // Superadmins and service accounts bypass at the hook: no visibleToUserId.
    ['unscoped', undefined],
    // Outside the predicate contract (not a same-tenant principal); still identical.
    ...(foreign ? [['foreign-owner', foreign.users.owner] as [string, UserID]] : []),
  ];
  const someIds = (pick: (index: number) => boolean) =>
    fixture.sessionIds.filter((_, index) => pick(index));
  const unknown = generateId() as SessionID;
  const mixedIds = [
    ...someIds((i) => i % 2 === 0),
    ...fixture.deletedSessionIds.slice(0, 2),
    unknown,
    ...(foreign ? foreign.sessionIds.slice(0, 5) : []),
  ];
  const filters: [string, Partial<SessionPageOptions>][] = [
    ...USER_NAMES.map(
      (name) => [`created_by=${name}`, { createdBy: users[name] }] as [string, SessionPageOptions]
    ),
    ['created_by=unknown', { createdBy: generateId() as UserID }],
    [
      'ids=all+deleted+unknown',
      { sessionIds: [...fixture.sessionIds, ...fixture.deletedSessionIds, unknown] },
    ],
    ['ids=mixed', { sessionIds: mixedIds }],
    // Past MAX_ID_LIST the read keeps the branch-set form.
    [
      'ids=over-cap',
      {
        sessionIds: [
          ...mixedIds,
          ...Array.from(
            { length: PAGINATION.MAX_ID_LIST + 1 - mixedIds.length },
            () => generateId() as SessionID
          ),
        ],
      },
    ],
    ['ids=single', { sessionIds: [fixture.sessionIds[7]] }],
    ['ids=deleted', { sessionIds: fixture.deletedSessionIds }],
    ['ids=empty', { sessionIds: [] }],
    ['created_by+ids', { createdBy: users.owner, sessionIds: mixedIds }],
    ['created_by+board', { createdBy: users.groupMember, boardId: fixture.boardIds[2] }],
    ['created_by+status', { createdBy: users.outsider, status: 'running' }],
    ['ids+board', { sessionIds: fixture.sessionIds, boardId: fixture.boardIds[0] }],
    ['ids+branch', { sessionIds: fixture.sessionIds, branchId: fixture.branchIds[4] }],
    ['ids+branches', { sessionIds: fixture.sessionIds, branchIds: fixture.branchIds.slice(3, 9) }],
    ['created_by+branches=[]', { createdBy: users.owner, branchIds: [] }],
    ...(foreign
      ? ([
          ['created_by=foreign-owner', { createdBy: foreign.users.owner }],
          ['ids=foreign', { sessionIds: foreign.sessionIds }],
          ['created_by+foreign-board', { createdBy: users.owner, boardId: foreign.boardIds[0] }],
          ['ids+foreign-branch', { sessionIds: mixedIds, branchId: foreign.branchIds[0] }],
        ] as [string, Partial<SessionPageOptions>][])
      : []),
  ];

  let comparisons = 0;
  async function compare(label: string, opts: SessionPageOptions): Promise<Page> {
    const legacy = await legacySessionPage(db, opts);
    const current = await currentFindPage(db, opts);
    expect(current, label).toEqual(legacy);
    comparisons++;
    return current;
  }
  function expectedIds(principal: UserID | undefined, opts: SessionPageOptions): Set<string> {
    const visible = principal ? visibleBranches.get(principal) : undefined;
    return new Set(
      all
        .filter(
          (s) =>
            (opts.createdBy === undefined || s.created_by === opts.createdBy) &&
            (opts.sessionIds === undefined || opts.sessionIds.includes(s.session_id)) &&
            (opts.archived === undefined || s.archived === opts.archived) &&
            (opts.status === undefined || s.status === opts.status) &&
            (opts.boardId === undefined || s.branch_board_id === opts.boardId) &&
            (opts.branchId === undefined || s.branch_id === opts.branchId) &&
            (opts.branchIds === undefined || opts.branchIds.includes(s.branch_id)) &&
            (principal === undefined || visible?.has(s.branch_id) === true)
        )
        .map((s) => s.session_id)
    );
  }

  const sorts: Partial<SessionPageOptions>[] = [
    { sortUpdatedAt: -1 },
    { sortUpdatedAt: 1 },
    { sortCreatedAt: -1 },
    { sortCreatedAt: 1 },
    {},
  ];
  for (const [principalLabel, visibleToUserId] of principals) {
    for (const [filterLabel, filter] of filters) {
      const label = `${principalLabel} ${filterLabel}`;
      for (const archived of [undefined, false, true]) {
        const opts = { ...filter, archived, visibleToUserId };
        const full = await compare(`${label} archived=${archived}`, {
          ...opts,
          limit: 1000,
          sortUpdatedAt: -1,
        });
        expect(full.total).toBe(full.rows.length);
        if (principalLabel !== 'foreign-owner') {
          expect(new Set(full.rows.map(([id]) => id)), `${label} oracle`).toEqual(
            expectedIds(visibleToUserId, opts)
          );
        }
        // Uncounted pages up to MAX_ID_LIST take the per-row probe for the
        // caller's own sessions; larger ones keep the branch-set form.
        for (const limit of [PAGINATION.MAX_ID_LIST, 1000]) {
          await compare(`${label} archived=${archived} no-count limit=${limit}`, {
            ...opts,
            includeTotal: false,
            limit,
            sortCreatedAt: 1,
          });
        }
        await compare(`${label} archived=${archived} count-only`, { ...opts, limit: 0 });
      }
      for (const sort of sorts) {
        for (const window of [
          { limit: 1000 },
          { limit: PAGINATION.MAX_ID_LIST, includeTotal: false },
        ]) {
          await compare(`${label} sort=${JSON.stringify(sort)} ${JSON.stringify(window)}`, {
            ...filter,
            ...sort,
            ...window,
            visibleToUserId,
          });
        }
      }
      // Walk pages past the end with both counted and no-count windows.
      const total = (await compare(`${label} total`, { ...filter, visibleToUserId, limit: 0 }))
        .total!;
      for (let skip = 0; skip <= total + 4; skip += 4) {
        await compare(`${label} page skip=${skip}`, {
          ...filter,
          visibleToUserId,
          sortUpdatedAt: -1,
          limit: 4,
          skip,
          ...(skip % 8 === 4 ? { includeTotal: false } : {}),
        });
      }
    }
  }
  return comparisons;
}
