import { afterAll, beforeAll, describe, it } from 'vitest';
import { generateId } from '../../lib/ids';
import { createDatabase, type Database } from '../client';
import { initializeDatabase } from '../migrate';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { exerciseLeanSessionPage } from './sessions.lean-test-helpers';

const url = process.env.AGOR_TEST_POSTGRES_URL;

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'session lean page projection (PostgreSQL)',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
    });
    afterAll(async () => {
      await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('matches the in-memory projection on JSONB rows', async () => {
      await runWithTenantDatabaseScope(db, `lean-${generateId()}`, exerciseLeanSessionPage);
    });
  }
);
