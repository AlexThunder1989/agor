import { dbTest } from '../test-helpers';
import { exerciseZoneEnrichment } from './branches.enrichment-test-helpers';

dbTest(
  'preserves placement semantics and decodes JSON per distinct board, not per branch',
  async ({ db }) => {
    await exerciseZoneEnrichment(db);
  }
);
