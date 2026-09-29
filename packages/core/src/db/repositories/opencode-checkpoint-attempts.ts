import type {
  OpenCodeCheckpointAdmission,
  OpenCodeCheckpointAttempt,
  OpenCodeCheckpointBinding,
  OpenCodeCheckpointCleanupWork,
  OpenCodeCheckpointDeleteResult,
  OpenCodeCleanupCursor,
  OpenCodeNativeStateAttempt,
  OpenCodeSessionDeleteAuthority,
} from '@agor/core/types';
import { isTerminalTaskStatus, TaskStatus } from '@agor/core/types';
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import {
  isCoordinatedOpenCodeNativeStateAttempt,
  OPENCODE_SESSION_DELETE_DATA_KEY,
} from '../../types/opencode-native-state.js';
import {
  lockSessionBranchForAdmission,
  lockSessionBranchForExistingWork,
} from '../branch-admission';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import { opencodeCheckpointAttempts, sessions, tasks } from '../schema';
import { getCurrentTenantId } from '../tenant-context';
import { EntityNotFoundError, RepositoryError } from './base';
import type { TaskRuntimeAuthorityScope } from './tasks';

type AttemptRow = typeof opencodeCheckpointAttempts.$inferSelect;

function attemptMatchesTaskActor(
  attempt: AttemptRow,
  task: typeof tasks.$inferSelect,
  session: typeof sessions.$inferSelect,
  tenant: string
): boolean {
  const binding = attempt.binding as OpenCodeCheckpointBinding | null;
  if (!binding || typeof binding !== 'object') return false;
  return (
    session.agentic_tool === 'opencode' &&
    (session.sdk_home_scope === 'branch' || session.sdk_home_scope === 'execution_home') &&
    (session.sdk_home_scope !== 'execution_home' || task.created_by === session.created_by) &&
    session.data.sdk_native_state_layout === 'session_root_v1' &&
    task.session_id === session.session_id &&
    attempt.tenant_id === tenant &&
    attempt.session_id === session.session_id &&
    attempt.task_id === task.task_id &&
    attempt.owner_user_id === session.created_by &&
    binding.protocol === 3 &&
    binding.tenantId === tenant &&
    binding.sessionId === session.session_id &&
    binding.taskId === task.task_id &&
    binding.storeId === attempt.store_id &&
    binding.holderInstanceId === attempt.holder_instance_id &&
    binding.ownerUserId === task.created_by &&
    binding.locator.tenantId === tenant &&
    binding.locator.ownerRuntimeUserId === task.created_by &&
    binding.locator.sessionId === session.session_id &&
    binding.locator.taskId === task.task_id &&
    binding.locator.storeId === attempt.store_id &&
    binding.locator.holderInstanceId === attempt.holder_instance_id
  );
}

function tenantId(): string {
  return getCurrentTenantId() ?? 'default';
}

function iso(value: Date | string | null): string | null {
  return value == null ? null : value instanceof Date ? value.toISOString() : value;
}

function expose(row: AttemptRow): OpenCodeCheckpointAttempt {
  return {
    ...row,
    binding: row.binding as OpenCodeCheckpointBinding,
    sealed_manifest: row.sealed_manifest as OpenCodeNativeStateAttempt | null,
    input_read_closed_at: iso(row.input_read_closed_at),
    retired_at: iso(row.retired_at),
    delete_observed_at: iso(row.delete_observed_at),
    delete_retry_at: iso(row.delete_retry_at),
    holder_closed_observed_at: iso(row.holder_closed_observed_at),
    holder_observation_retry_at: iso(row.holder_observation_retry_at),
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  };
}

const CLEANUP_LANES = ['retire', 'retry_delete', 'observe', 'recheck_absent'] as const;
const MAX_IDENTITIES_PER_LANE = 8;
const MAX_CLEANUP_BACKOFF_MS = 24 * 60 * 60 * 1_000;

function nextLane(lane: OpenCodeCleanupCursor['nextLane']): OpenCodeCleanupCursor['nextLane'] {
  return CLEANUP_LANES[(CLEANUP_LANES.indexOf(lane) + 1) % CLEANUP_LANES.length];
}

function emptyCleanupCursor(): OpenCodeCleanupCursor {
  return {
    version: 1,
    nextLane: 'retire',
    lanes: {
      retire: { cursorAttemptNo: 0, roundHighWatermark: 0 },
      retry_delete: { cursorAttemptNo: 0, roundHighWatermark: 0 },
      observe: { cursorAttemptNo: 0, roundHighWatermark: 0 },
      recheck_absent: { cursorAttemptNo: 0, roundHighWatermark: 0 },
    },
  };
}

function readCleanupCursor(value: unknown): OpenCodeCleanupCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyCleanupCursor();
  const source = value as Record<string, unknown>;
  if (
    source.version !== 1 ||
    !CLEANUP_LANES.includes(source.nextLane as never) ||
    !source.lanes ||
    typeof source.lanes !== 'object' ||
    Array.isArray(source.lanes)
  ) {
    return emptyCleanupCursor();
  }
  const lanes = source.lanes as Record<string, unknown>;
  const result = emptyCleanupCursor();
  result.nextLane = source.nextLane as OpenCodeCleanupCursor['nextLane'];
  for (const lane of CLEANUP_LANES) {
    const entry = lanes[lane];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return emptyCleanupCursor();
    const pair = entry as Record<string, unknown>;
    if (
      ![pair.cursorAttemptNo, pair.roundHighWatermark].every(
        (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
      )
    )
      return emptyCleanupCursor();
    result.lanes[lane] = {
      cursorAttemptNo: pair.cursorAttemptNo as number,
      roundHighWatermark: pair.roundHighWatermark as number,
    };
  }
  return result;
}

function retryAt(now: Date, failures: number): Date {
  return new Date(
    now.getTime() + Math.min(MAX_CLEANUP_BACKOFF_MS, 1_000 * 2 ** Math.min(failures, 16))
  );
}

const OBSERVATION_RESERVED = 'OBSERVATION_RESERVED';

async function applyHolderObservationTransition(
  tx: Database,
  target: AttemptRow,
  outcome: 'verified_closed' | 'still_present' | 'unknown',
  errorCode: string | undefined,
  now: Date
): Promise<void> {
  if (outcome === 'verified_closed') {
    await update(tx, opencodeCheckpointAttempts)
      .set({
        holder_closed_observed_at: now,
        holder_observation_retry_at: null,
        holder_observation_last_error: null,
        ...(target.input_task_id && !target.input_read_closed_at
          ? { input_read_closed_at: now }
          : {}),
        ...(target.write_state === 'open' ? { write_state: 'abandoned' as const } : {}),
        updated_at: now,
      })
      .where(eq(opencodeCheckpointAttempts.attempt_id, target.attempt_id))
      .run();
    return;
  }
  const failures = target.holder_observation_failure_count + 1;
  await update(tx, opencodeCheckpointAttempts)
    .set({
      holder_observation_failure_count: failures,
      holder_observation_retry_at: retryAt(now, failures),
      holder_observation_last_error: (errorCode ?? outcome).slice(0, 96),
      updated_at: now,
    })
    .where(eq(opencodeCheckpointAttempts.attempt_id, target.attempt_id))
    .run();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function exactManifest(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/** Revalidate accepted lineage while the caller holds the Session lock. */
export async function assertAcceptedOpenCodeLineage(
  db: Database,
  session: typeof sessions.$inferSelect
): Promise<Extract<OpenCodeNativeStateAttempt, { version: 3 }> | undefined> {
  const pointer = session.data.sdk_native_state;
  if (pointer !== undefined && !isCoordinatedOpenCodeNativeStateAttempt(pointer)) {
    throw new RepositoryError('Accepted OpenCode lineage is malformed');
  }
  const accepted = await select(db)
    .from(opencodeCheckpointAttempts)
    .innerJoin(tasks, eq(tasks.task_id, opencodeCheckpointAttempts.task_id))
    .where(
      and(
        eq(opencodeCheckpointAttempts.tenant_id, tenantId()),
        eq(opencodeCheckpointAttempts.session_id, session.session_id),
        eq(tasks.session_id, session.session_id),
        eq(tasks.status, TaskStatus.COMPLETED),
        eq(opencodeCheckpointAttempts.write_state, 'sealed')
      )
    )
    .orderBy(sql`${opencodeCheckpointAttempts.attempt_no} DESC`)
    .limit(1)
    .one();
  if (!pointer) {
    if (accepted) throw new RepositoryError('Accepted OpenCode lineage has lost its pointer');
    return undefined;
  }
  const row = accepted?.opencode_checkpoint_attempts;
  if (
    !row ||
    row.retired_at ||
    row.store_id !== session.data.sdk_native_state_store_id ||
    row.store_id !== pointer.storeId ||
    row.task_id !== pointer.attemptTaskId ||
    !exactManifest(row.sealed_manifest, pointer) ||
    !attemptMatchesTaskActor(row, accepted.tasks, session, tenantId())
  ) {
    throw new RepositoryError(
      'Accepted OpenCode lineage does not match the latest completed checkpoint'
    );
  }
  return pointer;
}

/**
 * Coordinates managed OpenCode read pins, output ownership, and permanent
 * retirement. Every method is a short DB-only unit; filesystem/Cloud work is
 * deliberately owned by callers after these transactions commit.
 */
export class OpenCodeCheckpointAttemptRepository {
  constructor(private readonly db: Database) {}

  async begin(input: {
    taskId: string;
    holderInstanceId: string;
    binding: OpenCodeCheckpointBinding;
    storeId?: string;
    authority?: TaskRuntimeAuthorityScope;
    assertRuntimeAuthority?: (
      tx: Database,
      taskId: string,
      authority: TaskRuntimeAuthorityScope,
      allowStoppingReplay: boolean
    ) => Promise<void>;
    now?: Date;
  }): Promise<OpenCodeCheckpointAdmission> {
    const tenant = tenantId();
    if (!input.holderInstanceId || input.binding.holderInstanceId !== input.holderInstanceId) {
      throw new RepositoryError('OpenCode holder identity does not match its immutable binding');
    }
    const route = await select(this.db, { session_id: tasks.session_id })
      .from(tasks)
      .where(eq(tasks.task_id, input.taskId))
      .one();
    if (!route) throw new EntityNotFoundError('Task', input.taskId);

    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockSessionBranchForAdmission(tx, route.session_id);
        await lockRowForUpdate(tx, this.db, sessions, eq(sessions.session_id, route.session_id));
        const session = await select(tx)
          .from(sessions)
          .where(eq(sessions.session_id, route.session_id))
          .one();
        if (!session) throw new EntityNotFoundError('Session', route.session_id);
        if (session.data.opencode_session_delete) {
          return { outcome: 'rejected', code: 'session_deleting' } as const;
        }
        await lockRowForUpdate(tx, this.db, tasks, eq(tasks.task_id, input.taskId));
        const task = await select(tx).from(tasks).where(eq(tasks.task_id, input.taskId)).one();
        if (!task || task.session_id !== session.session_id)
          throw new EntityNotFoundError('Task', input.taskId);
        const current = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.task_id, input.taskId)
            )
          )
          .one();
        const pointer = session.data.sdk_native_state;
        const layout = session.data.sdk_native_state_layout;
        if (layout !== undefined && layout !== 'session_root_v1') {
          return { outcome: 'rejected', code: 'legacy_state' } as const;
        }
        if (
          layout !== 'session_root_v1' &&
          (pointer !== undefined ||
            session.data.sdk_native_state_store_id !== undefined ||
            current != null)
        ) {
          return { outcome: 'rejected', code: 'legacy_state' } as const;
        }
        const taskIsActive =
          task.data.managed_opencode_protocol === 3 &&
          session.agentic_tool === 'opencode' &&
          (session.sdk_home_scope === 'branch' ||
            (session.sdk_home_scope === 'execution_home' &&
              task.created_by === session.created_by)) &&
          !isTerminalTaskStatus(task.status) &&
          !!task.executor_connected_at &&
          [TaskStatus.RUNNING, TaskStatus.AWAITING_INPUT, TaskStatus.AWAITING_PERMISSION].includes(
            task.status as never
          );
        const stoppingReplay =
          !!current &&
          task.status === TaskStatus.STOPPING &&
          task.data.managed_opencode_protocol === 3 &&
          session.agentic_tool === 'opencode' &&
          (session.sdk_home_scope === 'branch' ||
            (session.sdk_home_scope === 'execution_home' &&
              task.created_by === session.created_by)) &&
          !!task.executor_connected_at &&
          current.holder_instance_id === input.holderInstanceId &&
          exactManifest(current.binding, input.binding);
        if (input.authority && input.assertRuntimeAuthority) {
          await input.assertRuntimeAuthority(tx, task.task_id, input.authority, stoppingReplay);
        }
        if (current) {
          if (
            (!taskIsActive && !stoppingReplay) ||
            current.retired_at ||
            current.write_state !== 'open' ||
            (current.input_task_id && current.input_read_closed_at) ||
            current.holder_instance_id !== input.holderInstanceId ||
            current.owner_user_id !== session.created_by ||
            current.binding.ownerUserId !== task.created_by ||
            !exactManifest(current.binding, input.binding)
          ) {
            return { outcome: 'rejected', code: 'already_admitted' } as const;
          }
          const pinnedInput = current.input_task_id
            ? await select(tx)
                .from(opencodeCheckpointAttempts)
                .where(
                  and(
                    eq(opencodeCheckpointAttempts.tenant_id, tenant),
                    eq(opencodeCheckpointAttempts.session_id, session.session_id),
                    eq(opencodeCheckpointAttempts.store_id, current.input_store_id!),
                    eq(opencodeCheckpointAttempts.task_id, current.input_task_id)
                  )
                )
                .one()
            : null;
          const pinnedManifest = pinnedInput?.sealed_manifest as OpenCodeNativeStateAttempt | null;
          if (
            current.input_task_id &&
            (!pinnedInput ||
              pinnedInput.retired_at ||
              pinnedInput.write_state !== 'sealed' ||
              !isCoordinatedOpenCodeNativeStateAttempt(pinnedManifest) ||
              pinnedManifest.attemptTaskId !== current.input_task_id ||
              pinnedManifest.storeId !== current.input_store_id)
          )
            throw new RepositoryError(
              'OpenCode admission input pin no longer resolves to its sealed object'
            );
          return {
            outcome: 'admitted',
            attempt: expose(current),
            input: pinnedManifest,
          } as const;
        }
        if (pointer !== undefined && !isCoordinatedOpenCodeNativeStateAttempt(pointer)) {
          return { outcome: 'rejected', code: 'legacy_state' } as const;
        }
        if (!taskIsActive) {
          return { outcome: 'rejected', code: 'task_not_active' } as const;
        }
        if (!pointer) {
          const prior = await select(tx, { attempt_id: opencodeCheckpointAttempts.attempt_id })
            .from(opencodeCheckpointAttempts)
            .where(
              and(
                eq(opencodeCheckpointAttempts.tenant_id, tenant),
                eq(opencodeCheckpointAttempts.session_id, session.session_id)
              )
            )
            .limit(1)
            .one();
          if (layout === 'session_root_v1' && (!session.data.sdk_native_state_store_id || !prior)) {
            return { outcome: 'rejected', code: 'legacy_state' } as const;
          }
          // A first failed attempt can legitimately have a store identity but
          // no accepted pointer. If even the store identity vanished while a
          // ledger exists, an older binary may have rewritten the Session.
          if (prior && !session.data.sdk_native_state_store_id) {
            return { outcome: 'rejected', code: 'legacy_state' } as const;
          }
          // Completion publishes the pointer in the same transaction as the
          // Task status. Never silently start an empty conversation after a
          // mixed-version Session writer drops that accepted pointer.
          const accepted = await select(tx, {
            attempt_id: opencodeCheckpointAttempts.attempt_id,
          })
            .from(opencodeCheckpointAttempts)
            .innerJoin(tasks, eq(tasks.task_id, opencodeCheckpointAttempts.task_id))
            .where(
              and(
                eq(opencodeCheckpointAttempts.tenant_id, tenant),
                eq(opencodeCheckpointAttempts.session_id, session.session_id),
                eq(opencodeCheckpointAttempts.write_state, 'sealed'),
                eq(tasks.session_id, session.session_id),
                eq(tasks.status, TaskStatus.COMPLETED)
              )
            )
            .limit(1)
            .one();
          if (accepted) return { outcome: 'rejected', code: 'legacy_state' } as const;
        }
        const storeId =
          session.data.sdk_native_state_store_id ??
          pointer?.storeId ??
          input.storeId ??
          generateId();
        if (pointer && pointer.storeId !== storeId)
          throw new RepositoryError('Accepted OpenCode state does not match the immutable store');
        if (
          session.data.sdk_native_state_store_id &&
          input.storeId &&
          session.data.sdk_native_state_store_id !== input.storeId
        ) {
          throw new RepositoryError('OpenCode checkpoint store identity is immutable');
        }
        if (
          input.binding.tenantId !== tenant ||
          input.binding.sessionId !== session.session_id ||
          input.binding.taskId !== task.task_id ||
          input.binding.storeId !== storeId ||
          input.binding.ownerUserId !== task.created_by ||
          input.binding.protocol !== 3
        ) {
          throw new RepositoryError(
            'OpenCode checkpoint binding does not match the locked Task and Session'
          );
        }
        const attemptNo = await select(tx, {
          value: sql<number>`COALESCE(MAX(${opencodeCheckpointAttempts.attempt_no}), 0) + 1`,
        })
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.session_id, session.session_id)
            )
          )
          .one();
        if (!attemptNo || !Number.isSafeInteger(attemptNo.value) || attemptNo.value < 1) {
          throw new RepositoryError('OpenCode attempt sequence is unavailable');
        }
        let inputAttempt: AttemptRow | null = null;
        if (pointer) {
          inputAttempt = await select(tx)
            .from(opencodeCheckpointAttempts)
            .where(
              and(
                eq(opencodeCheckpointAttempts.tenant_id, tenant),
                eq(opencodeCheckpointAttempts.session_id, session.session_id),
                eq(opencodeCheckpointAttempts.store_id, pointer.storeId),
                eq(opencodeCheckpointAttempts.task_id, pointer.attemptTaskId)
              )
            )
            .one();
          if (
            !inputAttempt ||
            inputAttempt.retired_at ||
            inputAttempt.write_state !== 'sealed' ||
            !exactManifest(inputAttempt.sealed_manifest, pointer)
          ) {
            throw new RepositoryError(
              'Accepted OpenCode checkpoint has no matching sealed live ledger row'
            );
          }
          const newerAccepted = await select(tx, {
            attempt_id: opencodeCheckpointAttempts.attempt_id,
          })
            .from(opencodeCheckpointAttempts)
            .innerJoin(tasks, eq(tasks.task_id, opencodeCheckpointAttempts.task_id))
            .where(
              and(
                eq(opencodeCheckpointAttempts.tenant_id, tenant),
                eq(opencodeCheckpointAttempts.session_id, session.session_id),
                eq(opencodeCheckpointAttempts.store_id, pointer.storeId),
                eq(opencodeCheckpointAttempts.write_state, 'sealed'),
                sql`${opencodeCheckpointAttempts.attempt_no} > ${inputAttempt.attempt_no}`,
                eq(tasks.session_id, session.session_id),
                eq(tasks.status, TaskStatus.COMPLETED)
              )
            )
            .limit(1)
            .one();
          if (newerAccepted) {
            throw new RepositoryError(
              'Accepted OpenCode pointer is older than a completed checkpoint'
            );
          }
        }
        const now = input.now ?? new Date();
        const row = await insert(tx, opencodeCheckpointAttempts)
          .values({
            tenant_id: tenant,
            attempt_id: generateId(),
            owner_user_id: session.created_by,
            session_id: session.session_id,
            task_id: task.task_id,
            store_id: storeId,
            attempt_no: attemptNo.value,
            holder_instance_id: input.holderInstanceId,
            binding: input.binding,
            input_store_id: inputAttempt?.store_id ?? null,
            input_task_id: inputAttempt?.task_id ?? null,
            write_state: 'open',
            created_at: now,
            updated_at: now,
          })
          .returning()
          .one();
        if (
          session.data.sdk_native_state_store_id !== storeId ||
          session.data.sdk_native_state_layout !== 'session_root_v1'
        ) {
          await update(tx, sessions)
            .set({
              data: {
                ...session.data,
                sdk_native_state_layout: 'session_root_v1',
                sdk_native_state_store_id: storeId,
              },
              updated_at: now,
            })
            .where(eq(sessions.session_id, session.session_id))
            .run();
        }
        return {
          outcome: 'admitted',
          attempt: expose(row),
          input: pointer ?? null,
        } as const;
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }

  async closeRead(
    taskId: string,
    holderId: string,
    expectedInput: { storeId: string; taskId: string },
    now = new Date()
  ): Promise<void> {
    await this.mutateAttempt(taskId, holderId, async (tx, row) => {
      if (row.retired_at)
        throw new RepositoryError('Retired OpenCode input cannot be reopened or changed');
      if (
        row.input_task_id !== expectedInput.taskId ||
        row.input_store_id !== expectedInput.storeId
      ) {
        throw new RepositoryError('OpenCode read close does not match the granted input');
      }
      if (row.input_read_closed_at) return;
      await update(tx, opencodeCheckpointAttempts)
        .set({ input_read_closed_at: now, updated_at: now })
        .where(eq(opencodeCheckpointAttempts.attempt_id, row.attempt_id))
        .run();
    });
  }

  async seal(
    taskId: string,
    holderId: string,
    manifest: OpenCodeNativeStateAttempt,
    now = new Date()
  ): Promise<void> {
    if (!isCoordinatedOpenCodeNativeStateAttempt(manifest))
      throw new RepositoryError('Only v3 OpenCode state can be sealed');
    await this.mutateAttempt(taskId, holderId, async (tx, row, task) => {
      if (
        row.retired_at ||
        row.write_state === 'abandoned' ||
        manifest.attemptTaskId !== row.task_id ||
        manifest.storeId !== row.store_id
      ) {
        throw new RepositoryError(
          'OpenCode output is retired, abandoned, or bound to another object'
        );
      }
      // A response can be lost after sealing. Exact same-manifest replay is a
      // read-only confirmation even if Stop reached the task meanwhile; never
      // allow a new seal after Stop or terminality.
      if (row.write_state === 'sealed') {
        if (!exactManifest(row.sealed_manifest, manifest))
          throw new RepositoryError('OpenCode seal retry changed its manifest');
        return;
      }
      if (
        isTerminalTaskStatus(task.status) ||
        task.status === TaskStatus.STOPPING ||
        !task.executor_connected_at
      ) {
        throw new RepositoryError('OpenCode output cannot seal after Task termination or Stop');
      }
      if (row.input_task_id && !row.input_read_closed_at) {
        throw new RepositoryError(
          'OpenCode output cannot seal while its granted input remains pinned'
        );
      }
      await update(tx, opencodeCheckpointAttempts)
        .set({ write_state: 'sealed', sealed_manifest: manifest, updated_at: now })
        .where(eq(opencodeCheckpointAttempts.attempt_id, row.attempt_id))
        .run();
    });
  }

  async abandon(taskId: string, holderId: string, now = new Date()): Promise<void> {
    await this.mutateAttempt(taskId, holderId, async (tx, row) => {
      if (row.retired_at) throw new RepositoryError('Retired OpenCode output cannot be changed');
      if (row.input_task_id && !row.input_read_closed_at) {
        throw new RepositoryError('OpenCode input must be closed before abandoning its output');
      }
      if (row.write_state === 'sealed') {
        throw new RepositoryError('Sealed OpenCode output cannot be abandoned');
      }
      if (row.write_state === 'open') {
        await update(tx, opencodeCheckpointAttempts)
          .set({ write_state: 'abandoned', updated_at: now })
          .where(eq(opencodeCheckpointAttempts.attempt_id, row.attempt_id))
          .run();
      }
    });
  }

  /**
   * Reserve at most one cleanup operation, persisting lane progress and the
   * retirement tombstone before any caller can touch the filesystem. Every
   * lane scans a finite high-watermark and rotates after at most eight rows.
   */
  async prepareCleanup(
    taskId: string,
    holderId: string,
    now = new Date()
  ): Promise<OpenCodeCheckpointCleanupWork> {
    const tenant = tenantId();
    const route = await select(this.db, { session_id: tasks.session_id })
      .from(tasks)
      .where(eq(tasks.task_id, taskId))
      .one();
    if (!route) throw new EntityNotFoundError('Task', taskId);
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockSessionBranchForAdmission(tx, route.session_id);
        await lockRowForUpdate(tx, this.db, sessions, eq(sessions.session_id, route.session_id));
        const session = await select(tx)
          .from(sessions)
          .where(eq(sessions.session_id, route.session_id))
          .one();
        if (!session) throw new EntityNotFoundError('Session', route.session_id);
        await lockRowForUpdate(tx, this.db, tasks, eq(tasks.task_id, taskId));
        const task = await select(tx).from(tasks).where(eq(tasks.task_id, taskId)).one();
        if (!task || task.session_id !== session.session_id)
          throw new EntityNotFoundError('Task', taskId);
        const owner = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.task_id, taskId),
              eq(opencodeCheckpointAttempts.holder_instance_id, holderId)
            )
          )
          .one();
        if (
          !owner ||
          owner.retired_at ||
          task.data.managed_opencode_protocol !== 3 ||
          !task.executor_connected_at ||
          isTerminalTaskStatus(task.status)
        ) {
          throw new RepositoryError(
            'Cleanup reservation requires the active admitted OpenCode holder'
          );
        }
        const state = session.data as Record<string, unknown>;
        // Legacy/uncertain state disables reclamation as well as new admission.
        if (state.sdk_native_state_layout !== 'session_root_v1') return { kind: 'none' };
        const pointer = await assertAcceptedOpenCodeLineage(tx, session);
        const maxRow = await select(tx, {
          value: sql<number>`COALESCE(MAX(${opencodeCheckpointAttempts.attempt_no}), 0)`,
        })
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.session_id, session.session_id)
            )
          )
          .one();
        const maximum = Number(maxRow?.value ?? 0);
        const cursor = readCleanupCursor(state.opencode_cleanup_cursor);
        let lane = cursor.nextLane;
        const readPage = async (selectedLane: typeof lane, pageCursor: number, high: number) =>
          select(tx)
            .from(opencodeCheckpointAttempts)
            .where(
              and(
                eq(opencodeCheckpointAttempts.tenant_id, tenant),
                eq(opencodeCheckpointAttempts.session_id, session.session_id),
                sql`${opencodeCheckpointAttempts.attempt_no} > ${pageCursor}`,
                sql`${opencodeCheckpointAttempts.attempt_no} <= ${high}`,
                selectedLane === 'retire'
                  ? isNull(opencodeCheckpointAttempts.retired_at)
                  : selectedLane === 'retry_delete'
                    ? and(
                        sql`${opencodeCheckpointAttempts.retired_at} IS NOT NULL`,
                        isNull(opencodeCheckpointAttempts.delete_observed_at)
                      )
                    : selectedLane === 'recheck_absent'
                      ? sql`${opencodeCheckpointAttempts.retired_at} IS NOT NULL AND ${opencodeCheckpointAttempts.delete_observed_at} IS NOT NULL`
                      : and(
                          isNull(opencodeCheckpointAttempts.holder_closed_observed_at),
                          or(
                            isNull(opencodeCheckpointAttempts.holder_observation_retry_at),
                            lte(opencodeCheckpointAttempts.holder_observation_retry_at, now)
                          )
                        ),
                selectedLane === 'retry_delete'
                  ? or(
                      isNull(opencodeCheckpointAttempts.delete_retry_at),
                      lte(opencodeCheckpointAttempts.delete_retry_at, now)
                    )
                  : undefined,
                selectedLane === 'recheck_absent'
                  ? and(
                      isNotNull(opencodeCheckpointAttempts.delete_retry_at),
                      lte(opencodeCheckpointAttempts.delete_retry_at, now)
                    )
                  : undefined
              )
            )
            .orderBy(asc(opencodeCheckpointAttempts.attempt_no))
            .limit(MAX_IDENTITIES_PER_LANE)
            .all();
        const hasOpenReader = async (candidate: AttemptRow) =>
          Boolean(
            await select(tx, { attempt_id: opencodeCheckpointAttempts.attempt_id })
              .from(opencodeCheckpointAttempts)
              .where(
                and(
                  eq(opencodeCheckpointAttempts.tenant_id, tenant),
                  eq(opencodeCheckpointAttempts.session_id, session.session_id),
                  eq(opencodeCheckpointAttempts.input_store_id, candidate.store_id),
                  eq(opencodeCheckpointAttempts.input_task_id, candidate.task_id),
                  isNull(opencodeCheckpointAttempts.input_read_closed_at)
                )
              )
              .limit(1)
              .one()
          );

        for (let laneOffset = 0; laneOffset < CLEANUP_LANES.length; laneOffset += 1) {
          let laneState = cursor.lanes[lane];
          if (
            laneState.roundHighWatermark === 0 ||
            laneState.cursorAttemptNo >= laneState.roundHighWatermark
          ) {
            laneState = { cursorAttemptNo: 0, roundHighWatermark: maximum };
            cursor.lanes[lane] = laneState;
          }
          if (laneState.roundHighWatermark === 0) {
            lane = nextLane(lane);
            continue;
          }
          const page = await readPage(
            lane,
            laneState.cursorAttemptNo,
            laneState.roundHighWatermark
          );
          for (const candidate of page) {
            laneState.cursorAttemptNo = candidate.attempt_no;
            if (lane === 'retry_delete' || lane === 'recheck_absent') {
              if (
                pointer &&
                pointer.storeId === candidate.store_id &&
                pointer.attemptTaskId === candidate.task_id
              ) {
                throw new RepositoryError(
                  'A tombstone unexpectedly names the currently accepted checkpoint'
                );
              }
              if (candidate.store_id !== state.sdk_native_state_store_id) continue;
              if (
                !candidate.holder_closed_observed_at ||
                (candidate.input_task_id !== null && !candidate.input_read_closed_at) ||
                (await hasOpenReader(candidate))
              ) {
                continue;
              }
              await this.lockAttempt(tx, candidate);
              cursor.nextLane = nextLane(lane);
              await this.saveCleanupCursor(tx, session, cursor, now);
              return {
                kind: 'delete',
                object: { storeId: candidate.store_id, taskId: candidate.task_id },
              };
            }
            const candidateTask = await select(tx)
              .from(tasks)
              .where(eq(tasks.task_id, candidate.task_id))
              .one();
            if (
              !candidateTask ||
              !attemptMatchesTaskActor(candidate, candidateTask, session, tenant) ||
              candidate.store_id !== state.sdk_native_state_store_id
            ) {
              continue;
            }
            if (lane === 'observe') {
              const sealed =
                candidate.write_state === 'sealed' &&
                isCoordinatedOpenCodeNativeStateAttempt(candidate.sealed_manifest) &&
                candidate.sealed_manifest.storeId === candidate.store_id &&
                candidate.sealed_manifest.attemptTaskId === candidate.task_id;
              if (
                !isTerminalTaskStatus(candidateTask.status) ||
                candidate.holder_closed_observed_at ||
                (candidate.write_state !== 'open' &&
                  candidate.write_state !== 'abandoned' &&
                  !sealed &&
                  !(candidate.input_task_id && !candidate.input_read_closed_at))
              )
                continue;
              await this.lockAttempt(tx, candidate);
              const retry = retryAt(now, candidate.holder_observation_failure_count);
              await update(tx, opencodeCheckpointAttempts)
                .set({
                  holder_observation_retry_at: retry,
                  holder_observation_last_error: OBSERVATION_RESERVED,
                  updated_at: now,
                })
                .where(eq(opencodeCheckpointAttempts.attempt_id, candidate.attempt_id))
                .run();
              cursor.nextLane = nextLane(lane);
              await this.saveCleanupCursor(tx, session, cursor, now);
              return { kind: 'observe', attemptId: candidate.attempt_id };
            }
            const sealed =
              candidate.write_state === 'sealed' &&
              isCoordinatedOpenCodeNativeStateAttempt(candidate.sealed_manifest) &&
              candidate.sealed_manifest.storeId === candidate.store_id &&
              candidate.sealed_manifest.attemptTaskId === candidate.task_id;
            if (
              lane !== 'retire' ||
              !isTerminalTaskStatus(candidateTask.status) ||
              !candidate.holder_closed_observed_at ||
              (candidate.write_state !== 'sealed' && candidate.write_state !== 'abandoned') ||
              (candidate.write_state === 'sealed' && !sealed) ||
              (candidate.input_task_id !== null && candidate.input_read_closed_at === null) ||
              (pointer &&
                pointer.storeId === candidate.store_id &&
                pointer.attemptTaskId === candidate.task_id)
            ) {
              continue;
            }
            if (await hasOpenReader(candidate)) continue;
            await this.lockAttempt(tx, candidate);
            const lockedCandidate = await select(tx)
              .from(opencodeCheckpointAttempts)
              .where(eq(opencodeCheckpointAttempts.attempt_id, candidate.attempt_id))
              .one();
            if (
              !lockedCandidate ||
              lockedCandidate.retired_at ||
              !lockedCandidate.holder_closed_observed_at
            )
              continue;
            await update(tx, opencodeCheckpointAttempts)
              .set({ retired_at: now, updated_at: now })
              .where(
                and(
                  eq(opencodeCheckpointAttempts.attempt_id, candidate.attempt_id),
                  isNull(opencodeCheckpointAttempts.retired_at)
                )
              )
              .run();
            cursor.nextLane = nextLane(lane);
            await this.saveCleanupCursor(tx, session, cursor, now);
            return {
              kind: 'delete',
              object: { storeId: candidate.store_id, taskId: candidate.task_id },
            };
          }
          if (page.length < MAX_IDENTITIES_PER_LANE)
            laneState.cursorAttemptNo = laneState.roundHighWatermark;
          lane = nextLane(lane);
        }
        cursor.nextLane = lane;
        await this.saveCleanupCursor(tx, session, cursor, now);
        return { kind: 'none' };
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }

  /** Load only the immutable persisted locator for this exact due observation. */
  async loadObservationBinding(
    taskId: string,
    holderId: string,
    attemptId: string
  ): Promise<OpenCodeCheckpointBinding> {
    const tenant = tenantId();
    const currentTask = await select(this.db).from(tasks).where(eq(tasks.task_id, taskId)).one();
    if (!currentTask) throw new EntityNotFoundError('Task', taskId);
    const session = await select(this.db)
      .from(sessions)
      .where(eq(sessions.session_id, currentTask.session_id))
      .one();
    if (!session) throw new EntityNotFoundError('Session', currentTask.session_id);
    const work = await select(this.db)
      .from(opencodeCheckpointAttempts)
      .where(
        and(
          eq(opencodeCheckpointAttempts.tenant_id, tenant),
          eq(opencodeCheckpointAttempts.session_id, currentTask.session_id),
          eq(opencodeCheckpointAttempts.attempt_id, attemptId)
        )
      )
      .one();
    const owner = await select(this.db)
      .from(opencodeCheckpointAttempts)
      .where(
        and(
          eq(opencodeCheckpointAttempts.tenant_id, tenant),
          eq(opencodeCheckpointAttempts.session_id, currentTask.session_id),
          eq(opencodeCheckpointAttempts.task_id, taskId),
          eq(opencodeCheckpointAttempts.holder_instance_id, holderId)
        )
      )
      .one();
    const targetTask = work
      ? await select(this.db).from(tasks).where(eq(tasks.task_id, work.task_id)).one()
      : null;
    const sealed =
      work?.write_state === 'sealed' &&
      isCoordinatedOpenCodeNativeStateAttempt(work.sealed_manifest) &&
      work.sealed_manifest.storeId === work.store_id &&
      work.sealed_manifest.attemptTaskId === work.task_id;
    const needsObservation =
      work?.write_state === 'open' ||
      work?.write_state === 'abandoned' ||
      sealed ||
      Boolean(work?.input_task_id && !work.input_read_closed_at);
    if (
      !work ||
      !owner ||
      !targetTask ||
      !isTerminalTaskStatus(targetTask.status) ||
      !attemptMatchesTaskActor(owner, currentTask, session, tenant) ||
      !attemptMatchesTaskActor(work, targetTask, session, tenant) ||
      owner.retired_at ||
      work.holder_closed_observed_at ||
      // retry_at is also the in-flight lease set by prepareCleanup. The marker
      // distinguishes that reservation from a completed failed observation's
      // backoff, which must not launch another trusted helper yet.
      work.holder_observation_last_error !== OBSERVATION_RESERVED ||
      !needsObservation
    ) {
      throw new RepositoryError('OpenCode observation identity is no longer eligible');
    }
    return work.binding as OpenCodeCheckpointBinding;
  }

  /** Persist Cloud's exact-container observation and recover only that holder's open I/O phases. */
  async recordHolderObservation(
    currentTaskId: string,
    currentHolderId: string,
    attemptId: string,
    outcome: 'verified_closed' | 'still_present' | 'unknown',
    errorCode?: string,
    now = new Date()
  ): Promise<void> {
    const tenant = tenantId();
    const route = await select(this.db, { session_id: tasks.session_id })
      .from(tasks)
      .where(eq(tasks.task_id, currentTaskId))
      .one();
    if (!route) throw new EntityNotFoundError('Task', currentTaskId);
    await runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockSessionBranchForExistingWork(tx, route.session_id);
        await lockRowForUpdate(tx, this.db, sessions, eq(sessions.session_id, route.session_id));
        const session = await select(tx)
          .from(sessions)
          .where(eq(sessions.session_id, route.session_id))
          .one();
        if (!session) throw new EntityNotFoundError('Session', route.session_id);
        const current = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.session_id, route.session_id),
              eq(opencodeCheckpointAttempts.task_id, currentTaskId),
              eq(opencodeCheckpointAttempts.holder_instance_id, currentHolderId)
            )
          )
          .one();
        const target = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.session_id, route.session_id),
              eq(opencodeCheckpointAttempts.attempt_id, attemptId)
            )
          )
          .one();
        if (!current || current.retired_at || !target || target.holder_closed_observed_at) return;
        const taskIds = [...new Set([currentTaskId, target.task_id])].sort();
        for (const id of taskIds) await lockRowForUpdate(tx, this.db, tasks, eq(tasks.task_id, id));
        const targetTask = await select(tx)
          .from(tasks)
          .where(eq(tasks.task_id, target.task_id))
          .one();
        const caller = await select(tx).from(tasks).where(eq(tasks.task_id, currentTaskId)).one();
        if (
          !targetTask ||
          !caller ||
          !attemptMatchesTaskActor(current, caller, session, tenant) ||
          !attemptMatchesTaskActor(target, targetTask, session, tenant)
        ) {
          throw new RepositoryError('OpenCode observation actor binding is not authoritative');
        }
        if (!isTerminalTaskStatus(targetTask.status)) {
          return;
        }
        const attemptIds = [...new Set([current.attempt_id, target.attempt_id])].sort();
        for (const id of attemptIds)
          await lockRowForUpdate(
            tx,
            this.db,
            opencodeCheckpointAttempts,
            eq(opencodeCheckpointAttempts.attempt_id, id)
          );
        const lockedTarget = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(eq(opencodeCheckpointAttempts.attempt_id, target.attempt_id))
          .one();
        const lockedCurrent = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(eq(opencodeCheckpointAttempts.attempt_id, current.attempt_id))
          .one();
        if (!lockedTarget || !lockedCurrent || lockedTarget.holder_closed_observed_at) return;
        if (
          !attemptMatchesTaskActor(lockedCurrent, caller, session, tenant) ||
          !attemptMatchesTaskActor(lockedTarget, targetTask, session, tenant)
        ) {
          throw new RepositoryError('OpenCode observation actor binding is not authoritative');
        }
        await applyHolderObservationTransition(tx, lockedTarget, outcome, errorCode, now);
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }

  /** Reserve one immutable holder binding for explicit Session deletion. */
  async listSessionDeleteAttemptIds(sessionId: string, operationId: string): Promise<string[]> {
    const tenant = tenantId();
    const session = await select(this.db)
      .from(sessions)
      .where(eq(sessions.session_id, sessionId))
      .one();
    const marker = session?.data[OPENCODE_SESSION_DELETE_DATA_KEY] as
      | { operation_id?: unknown; status?: unknown }
      | undefined;
    if (
      !session ||
      marker?.operation_id !== operationId ||
      !['pending', 'error'].includes(String(marker.status))
    )
      throw new RepositoryError('OpenCode Session deletion operation is no longer current');
    const rows = await select(this.db, { attempt_id: opencodeCheckpointAttempts.attempt_id })
      .from(opencodeCheckpointAttempts)
      .where(
        and(
          eq(opencodeCheckpointAttempts.tenant_id, tenant),
          eq(opencodeCheckpointAttempts.session_id, sessionId)
        )
      )
      .all();
    return rows.map((row: { attempt_id: string }) => row.attempt_id);
  }

  async reserveSessionDeleteObservation(
    sessionId: string,
    operationId: string,
    attemptId: string,
    now = new Date()
  ): Promise<OpenCodeCheckpointBinding | null> {
    const tenant = tenantId();
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockRowForUpdate(tx, this.db, sessions, eq(sessions.session_id, sessionId));
        const session = await select(tx)
          .from(sessions)
          .where(eq(sessions.session_id, sessionId))
          .one();
        const marker = session?.data[OPENCODE_SESSION_DELETE_DATA_KEY] as
          | { operation_id?: unknown; status?: unknown }
          | undefined;
        if (
          !session ||
          marker?.operation_id !== operationId ||
          !['pending', 'error'].includes(String(marker.status))
        )
          throw new RepositoryError('OpenCode Session deletion operation is no longer current');
        await lockRowForUpdate(
          tx,
          this.db,
          opencodeCheckpointAttempts,
          eq(opencodeCheckpointAttempts.attempt_id, attemptId)
        );
        const attempt = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.session_id, sessionId),
              eq(opencodeCheckpointAttempts.attempt_id, attemptId)
            )
          )
          .one();
        if (!attempt) throw new EntityNotFoundError('OpenCode checkpoint attempt', attemptId);
        if (attempt.holder_closed_observed_at) return null;
        await lockRowForUpdate(tx, this.db, tasks, eq(tasks.task_id, attempt.task_id));
        const task = await select(tx).from(tasks).where(eq(tasks.task_id, attempt.task_id)).one();
        if (
          !task ||
          !isTerminalTaskStatus(task.status) ||
          !attemptMatchesTaskActor(attempt, task, session, tenant)
        ) {
          throw new RepositoryError('OpenCode deletion holder binding is not authoritative');
        }
        if (
          attempt.holder_observation_last_error === OBSERVATION_RESERVED &&
          (!attempt.holder_observation_retry_at || attempt.holder_observation_retry_at > now)
        ) {
          throw new RepositoryError('OpenCode holder observation is already reserved');
        }
        await update(tx, opencodeCheckpointAttempts)
          .set({
            holder_observation_retry_at: retryAt(now, attempt.holder_observation_failure_count),
            holder_observation_last_error: OBSERVATION_RESERVED,
            updated_at: now,
          })
          .where(eq(opencodeCheckpointAttempts.attempt_id, attemptId))
          .run();
        return attempt.binding as OpenCodeCheckpointBinding;
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }

  /** Persist operation-bound observer output using the same closure transition as turn cleanup. */
  async recordSessionDeleteObservation(
    sessionId: string,
    operationId: string,
    attemptId: string,
    expectedBinding: OpenCodeCheckpointBinding,
    outcome: 'verified_closed' | 'still_present' | 'unknown',
    errorCode?: string,
    now = new Date()
  ): Promise<void> {
    const tenant = tenantId();
    await runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockRowForUpdate(tx, this.db, sessions, eq(sessions.session_id, sessionId));
        const session = await select(tx)
          .from(sessions)
          .where(eq(sessions.session_id, sessionId))
          .one();
        const marker = session?.data[OPENCODE_SESSION_DELETE_DATA_KEY] as
          | { operation_id?: unknown; status?: unknown }
          | undefined;
        if (
          !session ||
          marker?.operation_id !== operationId ||
          !['pending', 'error'].includes(String(marker.status))
        )
          throw new RepositoryError('OpenCode Session deletion operation is no longer current');
        await lockRowForUpdate(
          tx,
          this.db,
          opencodeCheckpointAttempts,
          eq(opencodeCheckpointAttempts.attempt_id, attemptId)
        );
        const target = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.session_id, sessionId),
              eq(opencodeCheckpointAttempts.attempt_id, attemptId)
            )
          )
          .one();
        if (!target || target.holder_closed_observed_at) return;
        await lockRowForUpdate(tx, this.db, tasks, eq(tasks.task_id, target.task_id));
        const task = await select(tx).from(tasks).where(eq(tasks.task_id, target.task_id)).one();
        if (
          !task ||
          !isTerminalTaskStatus(task.status) ||
          !attemptMatchesTaskActor(target, task, session, tenant) ||
          target.holder_observation_last_error !== OBSERVATION_RESERVED ||
          canonicalJson(target.binding) !== canonicalJson(expectedBinding)
        ) {
          throw new RepositoryError('OpenCode deletion observation binding changed');
        }
        await applyHolderObservationTransition(tx, target, outcome, errorCode, now);
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }

  /** Retire only this Session's verified-closed attempts and return exact file identities. */
  async prepareSessionDeleteFiles(
    sessionId: string,
    operationId: string,
    now = new Date(),
    authority?: OpenCodeSessionDeleteAuthority
  ): Promise<Array<{ attemptId: string; storeId: string; taskId: string }>> {
    const tenant = tenantId();
    return runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockRowForUpdate(tx, this.db, sessions, eq(sessions.session_id, sessionId));
        const session = await select(tx)
          .from(sessions)
          .where(eq(sessions.session_id, sessionId))
          .one();
        const marker = session?.data[OPENCODE_SESSION_DELETE_DATA_KEY] as
          | {
              operation_id?: unknown;
              status?: unknown;
              token_fingerprint?: unknown;
              run_id?: unknown;
            }
          | undefined;
        if (
          !session ||
          marker?.operation_id !== operationId ||
          !['pending', 'error'].includes(String(marker.status)) ||
          session.data.sdk_native_state_layout !== 'session_root_v1'
        ) {
          throw new RepositoryError('OpenCode Session deletion operation or layout is invalid');
        }
        if (marker.token_fingerprint !== undefined || authority) {
          if (
            !authority ||
            marker.token_fingerprint !== authority.tokenFingerprint ||
            (marker.run_id !== undefined && marker.run_id !== authority.runId)
          ) {
            throw new RepositoryError('Session delete invocation is no longer authorized');
          }
          await update(tx, sessions)
            .set({
              data: {
                ...session.data,
                [OPENCODE_SESSION_DELETE_DATA_KEY]: { ...marker, run_id: authority.runId },
              },
              updated_at: now,
            })
            .where(eq(sessions.session_id, sessionId))
            .run();
        }
        const rows: AttemptRow[] = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.session_id, sessionId)
            )
          )
          .all();
        const files: Array<{ attemptId: string; storeId: string; taskId: string }> = [];
        for (const row of rows) {
          await lockRowForUpdate(tx, this.db, tasks, eq(tasks.task_id, row.task_id));
          const task = await select(tx).from(tasks).where(eq(tasks.task_id, row.task_id)).one();
          if (
            !task ||
            !isTerminalTaskStatus(task.status) ||
            !row.holder_closed_observed_at ||
            (row.input_task_id !== null && row.input_read_closed_at === null) ||
            row.write_state === 'open' ||
            !attemptMatchesTaskActor(row, task, session, tenant)
          ) {
            throw new RepositoryError(
              'OpenCode deletion cannot prove every holder and reader closed'
            );
          }
          if (!row.retired_at) {
            await update(tx, opencodeCheckpointAttempts)
              .set({ retired_at: now, updated_at: now })
              .where(eq(opencodeCheckpointAttempts.attempt_id, row.attempt_id))
              .run();
          }
          files.push({ attemptId: row.attempt_id, storeId: row.store_id, taskId: row.task_id });
        }
        return files;
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }

  /** A file proof clears exactly its operation's own Session state, never the row. */
  async acknowledgeSessionDelete(
    sessionId: string,
    operationId: string,
    files: Array<{ attemptId: string; storeId: string; taskId: string }>,
    result: { outcome: 'deleted' } | { outcome: 'failed'; errorCode: string },
    now = new Date(),
    authority?: OpenCodeSessionDeleteAuthority
  ): Promise<void> {
    const tenant = tenantId();
    await runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockRowForUpdate(tx, this.db, sessions, eq(sessions.session_id, sessionId));
        const session = await select(tx)
          .from(sessions)
          .where(eq(sessions.session_id, sessionId))
          .one();
        if (!session) throw new EntityNotFoundError('Session', sessionId);
        const marker = session.data[OPENCODE_SESSION_DELETE_DATA_KEY] as
          | {
              operation_id?: unknown;
              status?: unknown;
              receipt?: unknown;
              token_fingerprint?: unknown;
              run_id?: unknown;
            }
          | undefined;
        if (marker?.operation_id !== operationId) {
          throw new RepositoryError('OpenCode Session deletion operation is no longer current');
        }
        if (
          (marker.token_fingerprint !== undefined || authority) &&
          (!authority ||
            marker.token_fingerprint !== authority.tokenFingerprint ||
            marker.run_id !== authority.runId)
        ) {
          throw new RepositoryError('Session delete receipt is from a stale invocation');
        }
        const receipt = files
          .map((item) => `${item.attemptId}:${item.storeId}:${item.taskId}`)
          .sort();
        if (marker.status === 'state_cleared') {
          if (
            result.outcome !== 'deleted' ||
            canonicalJson(marker.receipt) !== canonicalJson(receipt)
          ) {
            throw new RepositoryError('OpenCode Session deletion receipt does not match');
          }
          return;
        }
        if (!['pending', 'error'].includes(String(marker.status))) {
          throw new RepositoryError('OpenCode Session deletion is not acknowledgeable');
        }
        if (result.outcome !== 'deleted') {
          await update(tx, sessions)
            .set({
              data: {
                ...session.data,
                [OPENCODE_SESSION_DELETE_DATA_KEY]: {
                  ...marker,
                  operation_id: operationId,
                  status: 'error',
                },
              },
              updated_at: now,
            })
            .where(eq(sessions.session_id, sessionId))
            .run();
          return;
        }
        const rows: AttemptRow[] = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.session_id, sessionId)
            )
          )
          .all();
        const expected = rows
          .map((row) => `${row.attempt_id}:${row.store_id}:${row.task_id}`)
          .sort();
        if (canonicalJson(expected) !== canonicalJson(receipt)) {
          throw new RepositoryError('OpenCode Session deletion file result is incomplete or stale');
        }
        for (const row of rows) {
          await lockRowForUpdate(
            tx,
            this.db,
            opencodeCheckpointAttempts,
            eq(opencodeCheckpointAttempts.attempt_id, row.attempt_id)
          );
          await lockRowForUpdate(tx, this.db, tasks, eq(tasks.task_id, row.task_id));
          const task = await select(tx).from(tasks).where(eq(tasks.task_id, row.task_id)).one();
          if (
            !task ||
            !isTerminalTaskStatus(task.status) ||
            !attemptMatchesTaskActor(row, task, session, tenant) ||
            !row.holder_closed_observed_at ||
            (row.input_task_id !== null && row.input_read_closed_at === null) ||
            row.write_state === 'open' ||
            !row.retired_at
          ) {
            throw new RepositoryError('OpenCode Session deletion lacks closure proof');
          }
        }
        if (rows.length) {
          await deleteFrom(tx, opencodeCheckpointAttempts)
            .where(
              and(
                eq(opencodeCheckpointAttempts.tenant_id, tenant),
                eq(opencodeCheckpointAttempts.session_id, sessionId)
              )
            )
            .run();
        }
        const data = { ...session.data };
        delete data.sdk_native_state;
        delete data.sdk_native_state_store_id;
        delete data.sdk_native_state_layout;
        delete data.sdk_session_id;
        delete data.opencode_cleanup_cursor;
        data[OPENCODE_SESSION_DELETE_DATA_KEY] = {
          ...marker,
          operation_id: operationId,
          status: 'state_cleared',
          receipt,
        };
        await update(tx, sessions)
          .set({ data, updated_at: now })
          .where(eq(sessions.session_id, sessionId))
          .run();
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }

  /** Record one deletion outcome for an exact permanent tombstone. */
  async acknowledgeDelete(
    taskId: string,
    holderId: string,
    object: { storeId: string; taskId: string },
    result: OpenCodeCheckpointDeleteResult,
    now = new Date()
  ): Promise<void> {
    const tenant = tenantId();
    const route = await select(this.db, { session_id: tasks.session_id })
      .from(tasks)
      .where(eq(tasks.task_id, taskId))
      .one();
    if (!route) throw new EntityNotFoundError('Task', taskId);
    await runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockSessionBranchForExistingWork(tx, route.session_id);
        await lockRowForUpdate(tx, this.db, sessions, eq(sessions.session_id, route.session_id));
        const session = await select(tx)
          .from(sessions)
          .where(eq(sessions.session_id, route.session_id))
          .one();
        if (!session) throw new EntityNotFoundError('Session', route.session_id);
        const taskIds = [...new Set([taskId, object.taskId])].sort();
        for (const id of taskIds) await lockRowForUpdate(tx, this.db, tasks, eq(tasks.task_id, id));
        const caller = await select(tx).from(tasks).where(eq(tasks.task_id, taskId)).one();
        const current = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.session_id, route.session_id),
              eq(opencodeCheckpointAttempts.task_id, taskId),
              eq(opencodeCheckpointAttempts.holder_instance_id, holderId)
            )
          )
          .one();
        const target = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.session_id, route.session_id),
              eq(opencodeCheckpointAttempts.store_id, object.storeId),
              eq(opencodeCheckpointAttempts.task_id, object.taskId)
            )
          )
          .one();
        const targetTask = await select(tx)
          .from(tasks)
          .where(eq(tasks.task_id, object.taskId))
          .one();
        if (!caller || !current || current.retired_at || !target || !target.retired_at) {
          throw new RepositoryError(
            'Deletion acknowledgement requires an active holder and exact tombstone'
          );
        }
        if (
          !targetTask ||
          !attemptMatchesTaskActor(current, caller, session, tenant) ||
          !attemptMatchesTaskActor(target, targetTask, session, tenant)
        ) {
          throw new RepositoryError('OpenCode deletion actor binding is not authoritative');
        }
        await assertAcceptedOpenCodeLineage(tx, session);
        if (
          session.data.sdk_native_state?.storeId === object.storeId &&
          session.data.sdk_native_state?.attemptTaskId === object.taskId
        ) {
          throw new RepositoryError('Accepted OpenCode state cannot be deleted');
        }
        await this.lockAttempt(tx, target);
        const lockedTarget = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(eq(opencodeCheckpointAttempts.attempt_id, target.attempt_id))
          .one();
        if (!lockedTarget?.retired_at)
          throw new RepositoryError('OpenCode tombstone changed before acknowledgement');
        if (result.outcome === 'deleted') {
          await update(tx, opencodeCheckpointAttempts)
            .set({
              delete_observed_at: now,
              // Recheck an acknowledged absence once, not on every healthy
              // launch forever. The irreversible tombstone remains in the ledger.
              delete_retry_at: lockedTarget.delete_observed_at
                ? lockedTarget.delete_retry_at && lockedTarget.delete_retry_at <= now
                  ? null
                  : lockedTarget.delete_retry_at
                : new Date(now.getTime() + 24 * 60 * 60 * 1_000),
              delete_last_error: null,
              updated_at: now,
            })
            .where(eq(opencodeCheckpointAttempts.attempt_id, lockedTarget.attempt_id))
            .run();
        } else {
          const failures = lockedTarget.delete_failure_count + 1;
          await update(tx, opencodeCheckpointAttempts)
            .set({
              delete_failure_count: failures,
              delete_retry_at: retryAt(now, failures),
              delete_last_error: result.errorCode.slice(0, 96),
              updated_at: now,
            })
            .where(eq(opencodeCheckpointAttempts.attempt_id, lockedTarget.attempt_id))
            .run();
        }
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }

  private async lockAttempt(tx: Database, row: AttemptRow): Promise<void> {
    await lockRowForUpdate(
      tx,
      this.db,
      opencodeCheckpointAttempts,
      eq(opencodeCheckpointAttempts.attempt_id, row.attempt_id)
    );
  }

  private async saveCleanupCursor(
    tx: Database,
    session: typeof sessions.$inferSelect,
    cursor: OpenCodeCleanupCursor,
    now: Date
  ): Promise<void> {
    await update(tx, sessions)
      .set({
        data: { ...session.data, opencode_cleanup_cursor: cursor } as typeof session.data,
        updated_at: now,
      })
      .where(eq(sessions.session_id, session.session_id))
      .run();
  }

  private async mutateAttempt(
    taskId: string,
    holderId: string,
    mutation: (tx: Database, row: AttemptRow, task: typeof tasks.$inferSelect) => Promise<void>
  ): Promise<void> {
    const tenant = tenantId();
    const route = await select(this.db, { session_id: tasks.session_id })
      .from(tasks)
      .where(eq(tasks.task_id, taskId))
      .one();
    if (!route) throw new EntityNotFoundError('Task', taskId);
    await runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockSessionBranchForExistingWork(tx, route.session_id);
        await lockRowForUpdate(tx, this.db, sessions, eq(sessions.session_id, route.session_id));
        const session = await select(tx)
          .from(sessions)
          .where(eq(sessions.session_id, route.session_id))
          .one();
        if (!session) throw new EntityNotFoundError('Session', route.session_id);
        await lockRowForUpdate(tx, this.db, tasks, eq(tasks.task_id, taskId));
        const task = await select(tx).from(tasks).where(eq(tasks.task_id, taskId)).one();
        if (!task || task.session_id !== route.session_id)
          throw new EntityNotFoundError('Task', taskId);
        const row = await select(tx)
          .from(opencodeCheckpointAttempts)
          .where(
            and(
              eq(opencodeCheckpointAttempts.tenant_id, tenant),
              eq(opencodeCheckpointAttempts.task_id, taskId),
              eq(opencodeCheckpointAttempts.holder_instance_id, holderId)
            )
          )
          .one();
        if (!row) throw new RepositoryError('OpenCode holder is not admitted for this Task');
        if (
          session.agentic_tool !== 'opencode' ||
          (session.sdk_home_scope !== 'branch' && session.sdk_home_scope !== 'execution_home') ||
          (session.sdk_home_scope === 'execution_home' && task.created_by !== session.created_by) ||
          session.data.sdk_native_state_layout !== 'session_root_v1' ||
          row.owner_user_id !== session.created_by ||
          row.binding.tenantId !== tenant ||
          row.binding.sessionId !== session.session_id ||
          row.binding.taskId !== task.task_id ||
          row.binding.storeId !== row.store_id ||
          row.binding.holderInstanceId !== row.holder_instance_id ||
          row.binding.ownerUserId !== task.created_by
        ) {
          throw new RepositoryError('OpenCode holder is no longer authoritative');
        }
        await lockRowForUpdate(
          tx,
          this.db,
          opencodeCheckpointAttempts,
          eq(opencodeCheckpointAttempts.attempt_id, row.attempt_id)
        );
        await mutation(tx, row, task);
      },
      { sqliteImmediate: true, sqliteBusyRetries: 9 }
    );
  }
}
