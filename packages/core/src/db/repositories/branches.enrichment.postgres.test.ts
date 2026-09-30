import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import { createDatabase, type Database } from '../client';
import { update } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { boardObjects } from '../schema';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { BranchRepository } from './branches';
import { exerciseZoneEnrichment } from './branches.enrichment-test-helpers';

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'zone enrichment PostgreSQL/RLS parity',
  () => {
    let db: Database;
    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
    });
    afterAll(async () => {
      await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });
    it('matches SQLite and cannot enrich foreign branch/board IDs', async () => {
      const foreign = await runWithTenantDatabaseScope(
        db,
        `foreign-${generateId()}`,
        exerciseZoneEnrichment
      );
      await runWithTenantDatabaseScope(db, `local-${generateId()}`, async (scoped) => {
        const local = await exerciseZoneEnrichment(scoped);
        // Knowing the other tenant's IDs and passing their Branch objects is not
        // authorization to retrieve its placements or board zone labels.
        const result = await new BranchRepository(scoped).enrichManyWithZoneInfo(foreign);
        expect(result).toEqual(foreign);
        // Also force the second (boards) read to encounter a foreign ID. Legacy
        // cross-tenant references must not bypass RLS merely because the local
        // placement itself is visible. Ordinary service ACL admission is unchanged.
        await update(scoped, boardObjects)
          .set({ board_id: foreign[4].board_id! })
          .where(eq(boardObjects.branch_id, local[4].branch_id))
          .run();
        const [crossReference] = await new BranchRepository(scoped).enrichManyWithZoneInfo([
          local[4],
        ]);
        expect(crossReference.zone_id).toBeDefined();
        expect(crossReference.board_object_id).toBeDefined();
        expect(crossReference.zone_label).toBeUndefined();
        expect(
          result.every(
            (branch) => branch.board_object_id === undefined && branch.zone_label === undefined
          )
        ).toBe(true);
      });
    });
  }
);
