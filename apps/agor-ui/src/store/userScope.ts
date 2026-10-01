/**
 * User scope: everything Home and the teammates surfaces read, loaded in full
 * for the caller (design r3 §3), independent of the global hydration.
 *
 * - Gated (in `useAgorData`'s first paint): my newest `MY_SESSIONS_GATED_LIMIT`
 *   sessions. Fewer rows than the limit already means "all of mine".
 * - U1: all of my active sessions in ONE read (no offset pages: an archive
 *   during a paged read shifts rows and skips one), capped at
 *   `MY_SESSIONS_FULL_LIMIT`; hitting the cap sets `mySessionsTruncated`.
 * - U2: my branches (`branches{created_by}`).
 * - U3: every teammate branch I can view (`branches{teammate: true}`).
 * - U5: every branch my sessions or candidate comment threads reference that
 *   is still absent, read by id in chunks; ids the server does not return go
 *   into `absentBranchIds` (archived, deleted or invisible).
 *
 * Fork ancestors of other users are deliberately NOT fetched (decision Q4,
 * 2026-10-01); see `startedByUserLineage` in `homeSelectors.ts`.
 *
 * Every read applies with the fill-only merge and per-id touched fence
 * (`applyEntityFill`), under the authority scope it started with. Flags only
 * ever become true within one identity; `resetMaps` clears them. A failed read
 * leaves its flag unset (Home keeps its loading state) until the next run,
 * which `useAgorData` starts again on every silent reconnect resync.
 *
 * Realtime keeps the scope complete for rows; a store subscription keeps it
 * complete for new REFERENCES (a new session of mine, a new comment thread on a
 * branch that isn't loaded) by ensuring their branches, batched and debounced.
 */
import type { AgorClient, BoardComment, Branch, Session } from '@agor-live/client';
import { PAGINATION } from '@agor-live/client';
import { getTimeMs } from '../utils/entityTime';
import {
  beginPartitionLoad,
  endPartitionLoad,
  type HydratedCollection,
  MAX_WHOLESALE_RESTARTS,
  touchedSince,
  WholesaleReplacementError,
  wholesaleReplacedSince,
} from './agorHydration';
import { applyEntityFill } from './agorMaps';
import { type AgorState, agorStore } from './agorStore';
import { isLoadLifetimeCurrent, type LoadLifetime } from './loadLifetime';
import { sessionListQuery } from './sessionListQuery';

/** Gated first-paint page of my sessions (replaces the global recent slice). */
export const MY_SESSIONS_GATED_LIMIT = 200;
/** Cap of the single all-my-sessions read (U1). */
export const MY_SESSIONS_FULL_LIMIT = PAGINATION.MAX_LIMIT;
/** Debounce for ensuring branches of newly referenced ids. */
const REFERENCE_DEBOUNCE_MS = 100;

/** The newest-first query for my active sessions. */
export function mySessionsQuery(userId: string, limit: number) {
  return sessionListQuery({
    created_by: userId,
    archived: false,
    $sort: { updated_at: -1 },
    $limit: limit,
    $count: false,
  });
}

const rowsOf = <T>(result: unknown): T[] =>
  Array.isArray(result) ? (result as T[]) : ((result as { data?: T[] })?.data ?? []);

/**
 * Branch ids the user scope must resolve: the branch of every active session I
 * created, and of every candidate comment thread — unresolved, on a board that
 * isn't archived, where someone else spoke and the caller did not speak last.
 * A superset of the threads `makeCommentsForYouSelector` can show.
 */
export function referencedBranchIds(s: AgorState, userId: string): Set<string> {
  const ids = new Set<string>();
  for (const session of s.sessionById.values()) {
    if (!session.archived && session.created_by === userId && session.branch_id) {
      ids.add(session.branch_id);
    }
  }
  const threads = new Map<string, BoardComment[]>();
  for (const comment of s.commentById.values()) {
    const rootId = comment.parent_comment_id ?? comment.comment_id;
    const thread = threads.get(rootId);
    if (thread) thread.push(comment);
    else threads.set(rootId, [comment]);
  }
  for (const [rootId, comments] of threads) {
    const root = s.commentById.get(rootId);
    if (!root?.branch_id || root.resolved || s.boardById.get(root.board_id)?.archived) continue;
    let last = root;
    let someoneElse = false;
    for (const comment of comments) {
      if (comment.created_by !== userId) someoneElse = true;
      if (getTimeMs(comment, 'created_at') >= getTimeMs(last, 'created_at')) last = comment;
    }
    if (someoneElse && last.created_by !== userId) ids.add(root.branch_id);
  }
  return ids;
}

interface ScopeRun {
  client: AgorClient;
  userId: string;
  /** The lifetime of the load that started the run; never the current one. */
  lifetime: LoadLifetime;
}

let currentRun: ScopeRun | null = null;
let unsubscribe: (() => void) | null = null;
let referenceTimer: ReturnType<typeof setTimeout> | null = null;
const pendingBranchIds = new Set<string>();

const isCurrent = (run: ScopeRun) => currentRun === run && isLoadLifetimeCurrent(run.lifetime);

/**
 * Read rows and fill-merge them; null when the run went stale. Read errors
 * propagate, and so does a read whose every attempt spanned a wholesale
 * replacement (`WholesaleReplacementError`): its snapshot is never applied.
 */
async function fillRead(
  run: ScopeRun,
  read: () => Promise<{ branches?: Branch[]; sessions?: Session[] }>
): Promise<{ branches?: Branch[]; sessions?: Session[] } | null> {
  for (let attempt = 0; ; attempt++) {
    const fence = beginPartitionLoad();
    try {
      const rows = await read();
      if (!isCurrent(run)) return null;
      if (wholesaleReplacedSince(fence)) {
        if (attempt < MAX_WHOLESALE_RESTARTS) continue;
        throw new WholesaleReplacementError();
      }
      const touched = (collection: HydratedCollection, id: string) =>
        touchedSince(collection, id, fence.startRevisions[collection]);
      agorStore.getState().applyMaps((prev) => applyEntityFill(prev, rows, touched));
      return rows;
    } finally {
      endPartitionLoad();
    }
  }
}

/**
 * Read the given branch ids (chunks of `PAGINATION.MAX_ID_LIST`) and record the
 * ones the server doesn't return — and that didn't arrive meanwhile — as absent.
 */
async function ensureBranches(run: ScopeRun, ids: readonly string[]): Promise<boolean> {
  for (let i = 0; i < ids.length; i += PAGINATION.MAX_ID_LIST) {
    const chunk = ids.slice(i, i + PAGINATION.MAX_ID_LIST);
    const rows = await fillRead(run, async () => ({
      branches: rowsOf<Branch>(
        await run.client.service('branches').find({
          query: { branch_id: { $in: chunk }, archived: false, $limit: chunk.length },
        })
      ),
    }));
    if (!rows) return false;
    const returned = new Set((rows.branches ?? []).map((branch) => branch.branch_id as string));
    const state = agorStore.getState();
    const absent = chunk.filter((id) => !returned.has(id) && !state.branchById.has(id));
    if (absent.length > 0) {
      state.setUserScope({ absentBranchIds: new Set([...state.absentBranchIds, ...absent]) });
    }
  }
  return true;
}

/** Ids referenced but neither present, absent nor already being ensured. */
function missingReferences(s: AgorState, userId: string): string[] {
  const missing: string[] = [];
  for (const id of referencedBranchIds(s, userId)) {
    if (!s.branchById.has(id) && !s.absentBranchIds.has(id) && !pendingBranchIds.has(id)) {
      missing.push(id);
    }
  }
  return missing;
}

function scheduleReferenceCheck(run: ScopeRun): void {
  if (referenceTimer) return;
  referenceTimer = setTimeout(() => {
    referenceTimer = null;
    if (!isCurrent(run)) return;
    const state = agorStore.getState();
    // A branch arriving by any path (event, partition, ensure) clears its mark.
    if ([...state.absentBranchIds].some((id) => state.branchById.has(id))) {
      state.setUserScope({
        absentBranchIds: new Set(
          [...state.absentBranchIds].filter((id) => !state.branchById.has(id))
        ),
      });
    }
    const missing = missingReferences(agorStore.getState(), run.userId);
    if (missing.length === 0) return;
    for (const id of missing) pendingBranchIds.add(id);
    void ensureBranches(run, missing)
      .catch((err) => console.warn('[userScope] ensuring referenced branches failed:', err))
      .finally(() => {
        for (const id of missing) pendingBranchIds.delete(id);
      });
  }, REFERENCE_DEBOUNCE_MS);
}

function subscribeToReferences(run: ScopeRun): void {
  unsubscribe?.();
  unsubscribe = agorStore.subscribe((state, prev) => {
    if (
      state.sessionById === prev.sessionById &&
      state.commentById === prev.commentById &&
      state.branchById === prev.branchById
    ) {
      return;
    }
    scheduleReferenceCheck(run);
  });
}

/** Stop the current run: unsubscribe, cancel timers, and drop its pending applies. */
export function stopUserScope(): void {
  currentRun = null;
  unsubscribe?.();
  unsubscribe = null;
  if (referenceTimer) clearTimeout(referenceTimer);
  referenceTimer = null;
  pendingBranchIds.clear();
}

/**
 * Load the user scope under `lifetime`, the lifetime of the load that started
 * it (captured before that load's first await). A lifetime that is no longer
 * current — another authority, or a cancellation since — is rejected, so a
 * load that outlived a logout/remount can never adopt the next user's
 * authority. `gatedMineComplete` says the gated first-paint page already holds
 * all of my active sessions (it returned fewer than `MY_SESSIONS_GATED_LIMIT`
 * rows), so U1 can be skipped. Resolves when the run finished, failed, or was
 * superseded.
 */
export async function startUserScope(
  client: AgorClient,
  options: { userId: string; lifetime: LoadLifetime; gatedMineComplete: boolean }
): Promise<void> {
  if (!isLoadLifetimeCurrent(options.lifetime)) return;
  stopUserScope();
  const run: ScopeRun = { client, userId: options.userId, lifetime: options.lifetime };
  currentRun = run;
  const store = () => agorStore.getState();
  if (options.gatedMineComplete) store().setUserScope({ mySessionsLoaded: true });

  const u1 = options.gatedMineComplete
    ? Promise.resolve(true)
    : fillRead(run, async () => ({
        sessions: rowsOf<Session>(
          await client
            .service('sessions')
            .find({ query: mySessionsQuery(run.userId, MY_SESSIONS_FULL_LIMIT) })
        ),
      })).then((rows) => {
        if (!rows) return false;
        store().setUserScope({
          mySessionsLoaded: true,
          mySessionsTruncated: (rows.sessions?.length ?? 0) >= MY_SESSIONS_FULL_LIMIT,
        });
        return true;
      });
  const u2 = fillRead(run, async () => ({
    branches: rowsOf<Branch>(
      await client.service('branches').findAll({
        query: { created_by: run.userId, archived: false, $limit: PAGINATION.DEFAULT_LIMIT },
      })
    ),
  })).then(Boolean);
  const u3 = fillRead(run, async () => ({
    branches: rowsOf<Branch>(
      await client.service('branches').find({
        query: { teammate: true, archived: false, $limit: PAGINATION.MAX_TEAMMATE_BRANCHES },
      })
    ),
  })).then((rows) => {
    if (!rows) return false;
    store().setUserScope({ teammatesLoaded: true });
    return true;
  });

  // When the gated page already holds all of my sessions, every reference is
  // known now: resolve it alongside U2/U3 instead of after them, so it isn't
  // queued behind the global snapshots on a slow socket. The pass after U1
  // below then only covers what is still missing.
  const early = options.gatedMineComplete
    ? ensureBranches(run, missingReferences(store(), run.userId))
    : Promise.resolve(true);
  const settled = await Promise.allSettled([u1, u2, u3, early]);
  for (const result of settled) {
    if (result.status === 'rejected') console.warn('[userScope] read failed:', result.reason);
  }
  if (!isCurrent(run)) return;
  // U5 needs the complete set of my sessions and the branches U2/U3 already
  // loaded; teammates (U3) only shrink the id list, so they needn't succeed.
  if (settled[0].status !== 'fulfilled' || !settled[0].value) return;
  if (settled[1].status !== 'fulfilled' || !settled[1].value) return;
  if (settled[3].status !== 'fulfilled' || !settled[3].value) return;
  try {
    const missing = missingReferences(store(), run.userId);
    if (!(await ensureBranches(run, missing))) return;
  } catch (err) {
    console.warn('[userScope] referenced branches failed:', err);
    return;
  }
  if (!isCurrent(run)) return;
  store().setUserScope({ homeBranchesLoaded: true });
  subscribeToReferences(run);
}
