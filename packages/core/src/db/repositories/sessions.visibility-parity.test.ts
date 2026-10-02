import { expect } from 'vitest';
import { dbTest } from '../test-helpers';
import {
  exerciseSessionVisibilityParity,
  seedSessionVisibilityFixture,
} from './sessions.visibility-parity-test-helpers';

dbTest(
  'per-row created_by / session id visibility matches the branch-set form for every principal (SQLite)',
  async ({ db }) => {
    const fixture = await seedSessionVisibilityFixture(db);
    expect(await exerciseSessionVisibilityParity(db, fixture)).toBeGreaterThan(1000);
  },
  120_000
);
