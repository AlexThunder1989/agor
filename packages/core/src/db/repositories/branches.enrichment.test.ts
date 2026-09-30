import { eq } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { generateId } from '../../lib/ids';
import { insert, update } from '../database-wrapper';
import { boardObjects, boards } from '../schema';
import { dbTest, ensureTestUser } from '../test-helpers';
import { BranchRepository } from './branches';
import { exerciseZoneEnrichment } from './branches.enrichment-test-helpers';
import { RepoRepository } from './repos';

dbTest(
  'preserves placement semantics and decodes JSON per distinct board, not per branch',
  async ({ db }) => {
    await exerciseZoneEnrichment(db);
  }
);

// 501 distinct boards force a second batch. Raw fixture rows avoid creating
// hundreds of unrelated ACL packages; enrichment reads use the normal repository.
dbTest('batches more than 500 distinct boards and ignores malformed positions', async ({ db }) => {
  const owner = await ensureTestUser(db, generateId());
  const repo = await new RepoRepository(db).create({
    name: 'Batch fixture',
    slug: `batch-${generateId()}`,
    repo_type: 'remote',
    remote_url: 'https://example.invalid/batch.git',
    local_path: '/tmp/batch',
    default_branch: 'main',
  });
  const repository = new BranchRepository(db);
  const branch = await repository.create({
    repo_id: repo.repo_id,
    created_by: owner,
    name: 'batch',
    ref: 'batch',
    branch_unique_id: 1,
    path: '/tmp/batch/branch',
  });
  const boardIds = Array.from({ length: 501 }, () => generateId());
  // Small fixture inserts stay under SQLite's bind limit independently of the
  // read batching being tested.
  for (const [index, boardId] of boardIds.entries()) {
    await insert(db, boards)
      .values({
        board_id: boardId,
        name: `Batch ${index}`,
        created_at: new Date(),
        created_by: owner,
        primary_owner_user_id: owner,
        data: { objects: { zone: { type: 'zone', label: `Zone ${index}` } } },
      })
      .run();
    await insert(db, boardObjects)
      .values({
        object_id: generateId(),
        board_id: boardId,
        branch_id: branch.branch_id,
        created_at: new Date(),
        data: { zone_id: 'zone', position: { x: index, y: 0 } },
      })
      .run();
  }
  const input = { ...branch, board_id: boardIds[0] };
  const reads = vi.spyOn(db, 'select');
  const decode = vi.spyOn(boards.data, 'mapFromDriverValue');
  try {
    const [result] = await repository.enrichManyWithZoneInfo([input]);
    expect(result.zone_label).toBe('Zone 500');
    expect(result.position).toEqual({ x: 500, y: 0 });
    expect(reads).toHaveBeenCalledTimes(3); // placements + 500 boards + 1 board
    expect(decode).toHaveBeenCalledTimes(501);
    for (const position of ['invalid JSON', { x: 'bad', y: 0 }, { x: 1 }, null]) {
      await update(db, boardObjects)
        .set({
          data: { zone_id: 'zone', position } as unknown as typeof boardObjects.$inferInsert.data,
        })
        .where(eq(boardObjects.branch_id, branch.branch_id))
        .run();
      const [malformed] = await repository.enrichManyWithZoneInfo([input]);
      expect(malformed.position).toBeUndefined();
      expect(malformed.zone_label).toBe('Zone 500');
    }
  } finally {
    reads.mockRestore();
    decode.mockRestore();
  }
});
