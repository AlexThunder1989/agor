import { eq, inArray } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Branch } from '../../types';
import type { Database } from '../client';
import { insert, jsonExtract, select, update } from '../database-wrapper';
import { boardObjects, boards } from '../schema';
import { ensureTestUser } from '../test-helpers';
import { BoardObjectRepository } from './board-objects';
import { BoardRepository } from './boards';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';

/** Same fixture and old joined-query baseline on both dialects; no production data. */
export async function exerciseZoneEnrichment(db: Database) {
  const owner = await ensureTestUser(db, generateId());
  const repo = await new RepoRepository(db).create({
    name: 'Enrichment',
    slug: `enrichment-${generateId()}`,
    repo_type: 'remote',
    remote_url: 'https://example.invalid/repo.git',
    local_path: '/tmp/enrichment',
    default_branch: 'main',
  });
  const boardIds = [];
  const zoneId = `zone.'"[unusual]\\key`;
  for (let i = 0; i < 2; i++) {
    const board = await new BoardRepository(db).create({ name: `Board ${i}`, created_by: owner });
    boardIds.push(board.board_id);
    // Raw JSON lets this fixture cover stale and non-zone references without
    // invoking unrelated UI normalization. Large irrelevant canvas content is
    // what the old join repeatedly materialized to read a tiny zone label.
    await update(db, boards)
      .set({
        data: {
          objects: {
            [zoneId]: { type: 'zone', label: `Zone ${i}` },
            note: { type: 'text', label: 'Not a zone', text: 'x'.repeat(64 * 1024) },
          },
        },
      })
      .where(eq(boards.board_id, board.board_id))
      .run();
  }
  const repository = new BranchRepository(db);
  const objects = new BoardObjectRepository(db);
  const input: Branch[] = [];
  for (let i = 0; i < 64; i++) {
    const branch = await repository.create({
      repo_id: repo.repo_id,
      board_id: boardIds[i % 2],
      created_by: owner,
      name: `branch-${i}`,
      ref: `branch-${i}`,
      branch_unique_id: i + 1,
      path: `/tmp/enrichment/${i}`,
    });
    input.push(branch);
    if (i === 63) continue; // unpositioned
    await objects.create({
      board_id: branch.board_id!,
      branch_id: branch.branch_id,
      position: { x: i, y: -i },
      zone_id: i === 0 ? undefined : i === 1 ? 'stale' : i === 2 ? 'note' : zoneId,
    });
  }
  // Historical cross-board duplicate placement: retain last-row-wins semantics rather than
  // deduplicating branch placements along with board JSON. This raw insert also
  // avoids the upsert behavior of BoardObjectRepository.create.
  await insert(db, boardObjects)
    .values({
      object_id: generateId(),
      board_id: boardIds[0],
      branch_id: input[3].branch_id,
      created_at: new Date(),
      data: { position: { x: 999, y: -999 }, zone_id: zoneId },
    })
    .run();
  const ids = input.map((branch) => branch.branch_id);
  const decode = vi.spyOn(boards.data, 'mapFromDriverValue');
  try {
    const beforeStart = performance.now();
    const baseline: {
      branch_id: string | null;
      object_id: string;
      zone_id: string | null;
      position: string | { x: number; y: number } | null;
      board_data: unknown;
    }[] = await select(db, {
      branch_id: boardObjects.branch_id,
      object_id: boardObjects.object_id,
      zone_id: jsonExtract(db, boardObjects.data, 'zone_id'),
      position: jsonExtract(db, boardObjects.data, 'position'),
      board_data: boards.data,
    })
      .from(boardObjects)
      .leftJoin(boards, eq(boardObjects.board_id, boards.board_id))
      .where(inArray(boardObjects.branch_id, ids))
      .all();
    const beforeMs = performance.now() - beforeStart;
    const beforeRows = decode.mock.calls.length;
    const bytes = () =>
      decode.mock.results.reduce(
        (sum, result) => sum + Buffer.byteLength(JSON.stringify(result.value)),
        0
      );
    const beforeBytes = bytes();
    decode.mockClear();
    const afterStart = performance.now();
    const result = await repository.enrichManyWithZoneInfo([...input, input[3]]);
    const afterMs = performance.now() - afterStart;
    const afterRows = decode.mock.calls.length;
    const afterBytes = bytes();
    expect(beforeRows).toBe(64);
    expect(afterRows).toBe(2);
    expect(beforeBytes).toBe(afterBytes * 32);
    const byBranch = new Map(baseline.map((row) => [row.branch_id, row]));
    expect(result.map((branch) => branch.branch_id)).toEqual([...ids, input[3].branch_id]);
    for (const branch of result) {
      const row = byBranch.get(branch.branch_id);
      if (!row) {
        expect(branch).toBe(input[63]);
        continue;
      }
      const data = row.board_data as { objects?: Record<string, { type: string; label?: string }> };
      const zone = row.zone_id ? data.objects?.[row.zone_id] : undefined;
      expect(branch).toMatchObject({
        board_object_id: row.object_id,
        zone_id: row.zone_id || undefined,
        zone_label: zone?.type === 'zone' ? zone.label : undefined,
        position: typeof row.position === 'string' ? JSON.parse(row.position) : row.position,
      });
    }
    decode.mockClear();
    expect(await repository.enrichManyWithZoneInfo([])).toEqual([]);
    expect(await repository.enrichManyWithZoneInfo([input[0]])).toHaveLength(1);
    expect(decode).not.toHaveBeenCalled(); // no zone => no board JSON
    console.log('Synthetic board JSON materialization (not browser payload)', {
      beforeRows,
      afterRows,
      beforeBytes,
      afterBytes,
      joinedSelectMs: Math.round(beforeMs * 10) / 10,
      enrichedBatchMs: Math.round(afterMs * 10) / 10,
    });
    return input;
  } finally {
    decode.mockRestore();
  }
}
