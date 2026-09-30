// Restriction INTENT, not enforcement proof; the only writer is the in-Cell `agor tenant restriction apply` Job.
// The writer authenticates nobody: never call it from tenant-controlled request parameters.
import { sql } from 'drizzle-orm';
import {
  isTenantRestrictionClosed,
  type TenantRestrictionCommand,
  TenantRestrictionCommandSchema,
  type TenantRestrictionRecord,
  TenantRestrictionRecordSchema,
  transitionTenantRestriction,
} from '../types/tenant-restriction';
import type { Database } from './client';
import { executeRaw } from './database-wrapper';
import { assertValidTenantId } from './tenant-deletion';
import {
  getCurrentTenantId,
  isPostgresDatabaseHandle,
  runWithTenantDatabaseScope,
} from './tenant-scope';

export class TenantRestrictionUnsupportedError extends Error {
  constructor() {
    super('Tenant restriction intent requires PostgreSQL');
    this.name = 'TenantRestrictionUnsupportedError';
  }
}

export class TenantRestrictionDataError extends Error {
  constructor() {
    super('Invalid persisted tenant restriction intent');
    this.name = 'TenantRestrictionDataError';
  }
}

export class TenantRestrictedError extends Error {
  constructor() {
    // Deliberately omit controller, operation, placement and operator details.
    super('Tenant access is restricted');
    this.name = 'TenantRestrictedError';
  }
}

function requirePostgres(db: Database, tenantId: string): void {
  assertValidTenantId(tenantId);
  if (!isPostgresDatabaseHandle(db)) throw new TenantRestrictionUnsupportedError();
}

function rows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const value = (result as { rows?: unknown[] } | null)?.rows;
  if (!Array.isArray(value)) throw new TenantRestrictionDataError();
  return value as Record<string, unknown>[];
}

/** Acquire before branch/session/task locks; caller must hold a transaction. */
export async function lockTenantExecutionFence(db: Database, tenantId: string): Promise<void> {
  if (!isPostgresDatabaseHandle(db)) return;
  await assertRestrictionScope(db, tenantId);
  const key = JSON.stringify(['tenant-execution-v1', tenantId]);
  await executeRaw(
    db,
    sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${key}, 0))`
  );
}

/** Short persistence admission only; never hold this lock across executor I/O. */
export async function assertTenantExecutionAdmission(
  db: Database
): Promise<{ resumeAfter?: number }> {
  if (!isPostgresDatabaseHandle(db)) return {};
  const tenantId = getCurrentTenantId();
  if (!tenantId) throw new TenantRestrictionDataError();
  await lockTenantExecutionFence(db, tenantId);
  const boundary = await readTenantExecutionBoundary(db, tenantId);
  if (!boundary.allowed) throw new TenantRestrictedError();
  return boundary;
}

/** A hidden row is not proof of absence when RLS context disagrees with ALS. */
async function assertRestrictionScope(db: Database, tenantId: string): Promise<void> {
  const [context] = rows(
    await executeRaw(
      db,
      sql`
    SELECT current_setting('agor.tenant_id', true) AS tenant_id,
      COALESCE(current_setting('agor.system_scope', true), '') AS system_scope
  `
    )
  );
  if (context?.tenant_id !== tenantId || context.system_scope !== '') {
    throw new TenantRestrictionDataError();
  }
}

function parseRow(row: Record<string, unknown>): TenantRestrictionRecord {
  // Revision is bigint; corrupt stored data must never read as absent/unrestricted.
  const parsed = TenantRestrictionRecordSchema.safeParse({
    version: row.protocol_version,
    controllerId: row.controller_id,
    placementId: row.placement_id,
    operationId: row.operation_id,
    revision: typeof row.revision === 'string' ? Number(row.revision) : row.revision,
    phase: row.phase,
  });
  if (!parsed.success) throw new TenantRestrictionDataError();
  return parsed.data;
}

export interface TenantRestrictionIntentOptions {
  /** Transition line sink (default `console.info`); the CLI passes stderr to keep stdout parseable. */
  log?: (line: string) => void;
}

/** Keep an identifier bounded in the operational line; it is correlation only. */
function loggable(value: string): string {
  return value.length > 100 ? `${value.slice(0, 100)}…` : value;
}

/** Advisory lock serializes first insertion; never wait on sockets/processes/network under it. */
export async function applyTenantRestrictionIntent(
  db: Database,
  tenantId: string,
  input: TenantRestrictionCommand,
  options: TenantRestrictionIntentOptions = {}
): Promise<{ record: TenantRestrictionRecord; changed: boolean }> {
  requirePostgres(db, tenantId);
  const command = TenantRestrictionCommandSchema.parse(input);
  const outcome = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    await lockTenantExecutionFence(scoped, tenantId);
    const lockKey = JSON.stringify(['tenant-restriction-v1', tenantId, command.controllerId]);
    await executeRaw(
      scoped,
      sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${lockKey}, 0))`
    );
    const prior = rows(
      await executeRaw(
        scoped,
        sql`
      SELECT protocol_version, controller_id, placement_id, operation_id, revision, phase
      FROM public.tenant_restrictions
      WHERE tenant_id = ${tenantId} AND controller_id = ${command.controllerId}
      FOR UPDATE
    `
      )
    );
    const result = transitionTenantRestriction(prior[0] ? parseRow(prior[0]) : null, command);
    if (!result.changed) return result;
    const record = result.record;
    await executeRaw(
      scoped,
      sql`
      INSERT INTO public.tenant_restrictions
        (tenant_id, controller_id, placement_id, operation_id, revision, phase, protocol_version)
      VALUES (${tenantId}, ${record.controllerId}, ${record.placementId}, ${record.operationId},
        ${record.revision}, ${record.phase}, ${record.version})
      ON CONFLICT (tenant_id, controller_id) DO UPDATE SET
        operation_id = EXCLUDED.operation_id, revision = EXCLUDED.revision,
        phase = EXCLUDED.phase, updated_at = clock_timestamp()
    `
    );
    if (isTenantRestrictionClosed(record)) {
      // Hold pending prompts atomically; reactivation never clears the hold, only explicit resubmission.
      await executeRaw(
        scoped,
        sql`
        UPDATE public.tasks SET data = jsonb_set(data, '{tenant_restriction_hold}',
          jsonb_build_object('reason', 'tenant_restricted', 'held_at', clock_timestamp()))
        WHERE tenant_id = ${tenantId} AND status IN ('created', 'queued')
          AND NOT (data ? 'tenant_restriction_hold')
      `
      );
    }
    return result;
  });
  // After commit only: an aborted transaction must never log a transition.
  (options.log ?? console.info)(
    `[tenant.restriction] tenant_id=${loggable(tenantId)} controller_id=${command.controllerId} ` +
      `operation_id=${command.operationId} revision=${command.revision} ` +
      `action=${command.action} phase=${outcome.record.phase} changed=${outcome.changed}`
  );
  return outcome;
}

/** Read all owners: clearing one owner's claim must not lift another's. */
export async function readTenantRestrictionIntents(
  db: Database,
  tenantId: string
): Promise<TenantRestrictionRecord[]> {
  requirePostgres(db, tenantId);
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    await assertRestrictionScope(scoped, tenantId);
    return rows(
      await executeRaw(
        scoped,
        sql`
      SELECT protocol_version, controller_id, placement_id, operation_id, revision, phase
      FROM public.tenant_restrictions WHERE tenant_id = ${tenantId}
      ORDER BY controller_id
    `
      )
    ).map(parseRow);
  });
}

/** Uncached admission read for serving adapters; DB errors and invalid rows reject the caller. */
export async function assertTenantUnrestricted(db: Database, tenantId: string): Promise<void> {
  const records = await readTenantRestrictionIntents(db, tenantId);
  if (records.some(isTenantRestrictionClosed)) throw new TenantRestrictedError();
}

/** Durable event cutoff: reactivation permits future events, never a missed backlog. */
export async function readTenantExecutionBoundary(
  db: Database,
  tenantId: string
): Promise<{
  allowed: boolean;
  resumeAfter?: number;
}> {
  requirePostgres(db, tenantId);
  return runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    await assertRestrictionScope(scoped, tenantId);
    const stored = rows(
      await executeRaw(
        scoped,
        sql`
      SELECT protocol_version, controller_id, placement_id, operation_id, revision, phase, updated_at
      FROM public.tenant_restrictions WHERE tenant_id = ${tenantId}
    `
      )
    );
    let resumeAfter: number | undefined;
    let allowed = true;
    for (const row of stored) {
      if (isTenantRestrictionClosed(parseRow(row))) allowed = false;
      const at = new Date(row.updated_at as string | Date).getTime();
      if (!Number.isFinite(at)) throw new TenantRestrictionDataError();
      resumeAfter = Math.max(resumeAfter ?? -Infinity, at);
    }
    return { allowed, ...(resumeAfter !== undefined ? { resumeAfter } : {}) };
  });
}
