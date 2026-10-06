/**
 * Retention (design r3 §4.5): a row stays while some scope holds it. Rows
 * leave at natural points only — a partition evicted from the LRU
 * (`boardPartitions.ts`), the end of a reconnect resync — never on a timer.
 *
 * An eviction is a `replaceScope` with an empty, complete snapshot over the
 * rows being released: every one of them that no remaining scope's committed
 * membership holds (`otherCommittedMembers`) leaves, in one store update with
 * the coverage it drops. Rows outside the released set are never swept.
 */
import type { DataMaps } from './agorMaps';
import { agorStore } from './agorStore';
import {
  type Coverage,
  type LoadScope,
  replaceScope,
  type ScopeKey,
  type ScopeRows,
  withCoverage,
} from './scopeMerge';
import { otherCommittedMembers } from './userScope';

const NOTHING: ScopeRows = {
  branches: [],
  sessions: [],
  boardObjects: [],
  cards: [],
  complete: true,
};
const never = () => false;

type Claims = LoadScope['claims'];

/** Claims of any of `scopes`: a row any one of them claims. */
export function anyOf(scopes: readonly Pick<LoadScope, 'claims'>[]): Claims {
  const claims: Record<string, (row: never, maps: DataMaps) => boolean> = {};
  for (const collection of ['branches', 'sessions', 'boardObjects', 'cards'] as const) {
    const tests = scopes
      .map(
        (scope) => scope.claims[collection] as ((row: never, maps: DataMaps) => boolean) | undefined
      )
      .filter((test) => !!test);
    if (tests.length > 0) claims[collection] = (row, maps) => tests.some((test) => test(row, maps));
  }
  return claims as Claims;
}

const without = (coverage: Coverage, keys: readonly ScopeKey[]) =>
  keys.reduce<Coverage>((next, key) => withCoverage(next, key, null), coverage);

/**
 * Drop `dropKeys`' coverage and remove every row `claims` names that no
 * remaining scope holds, in one store update. A removed session's MCP links
 * and loaded mark go with it.
 */
export function evictRows(claims: Claims, dropKeys: readonly ScopeKey[] = []): void {
  const state = agorStore.getState();
  const holders = otherCommittedMembers({ ...state, coverage: without(state.coverage, dropKeys) });
  let removedSessions: string[] = [];
  state.applyMaps(
    (prev) => {
      const maps = replaceScope(prev, { claims }, NOTHING, never, holders);
      if (maps.sessionById === prev.sessionById) return maps;
      removedSessions = [...prev.sessionById.keys()].filter((id) => !maps.sessionById.has(id));
      const linked = removedSessions.filter((id) => maps.sessionMcpServerIds.has(id));
      if (linked.length === 0) return maps;
      const sessionMcpServerIds = new Map(maps.sessionMcpServerIds);
      for (const id of linked) sessionMcpServerIds.delete(id);
      return { ...maps, sessionMcpServerIds };
    },
    (_maps, coverage) => without(coverage, dropKeys),
    (_maps, current) => {
      const loaded = removedSessions.filter((id) => current.sessionMcpLoaded.has(id));
      if (loaded.length === 0) return {};
      const sessionMcpLoaded = new Set(current.sessionMcpLoaded);
      for (const id of loaded) sessionMcpLoaded.delete(id);
      return { sessionMcpLoaded };
    }
  );
}
