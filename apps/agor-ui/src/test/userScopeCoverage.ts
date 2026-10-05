import { type ScopeCoverage, USER_SCOPE_KEYS } from '../store/scopeMerge';

type Piece = keyof typeof USER_SCOPE_KEYS;

/**
 * A `coverage` map whose listed user-scope pieces are loaded (`'capped'`:
 * loaded from a capped read), for tests that seed the store directly.
 */
export function userScopeCoverage(
  pieces: Partial<Record<Piece, boolean | 'capped'>>
): Map<string, ScopeCoverage> {
  const coverage = new Map<string, ScopeCoverage>();
  for (const [piece, state] of Object.entries(pieces) as [Piece, boolean | 'capped'][]) {
    if (!state) continue;
    coverage.set(USER_SCOPE_KEYS[piece], {
      status: 'loaded',
      authorityScope: 'fixture',
      loadEpoch: 0,
      members: {},
      complete: state !== 'capped',
    });
  }
  return coverage;
}
