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
 * (`applyEntityFill`), under the lifetime of the load that started the run.
 * Flags only ever become true within one identity; `resetMaps` clears them.
 * A failed U1/U2/U3 read leaves its flag unset (Home keeps its loading state)
 * until the next run, which `useAgorData` starts again on every silent
 * reconnect resync.
 *
 * Realtime keeps the scope complete for rows; a store subscription, installed
 * before the first read, keeps it complete for new REFERENCES (a new session of
 * mine, a new comment thread on a branch that isn't loaded) by ensuring their
 * branches: debounced, in chunks, at most `MAX_CONCURRENT_ID_READS` at once,
 * with a run-owned retry queue (capped backoff) for failed reads. Absent marks
 * are revalidated at the start of every run.
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
/** Referenced-branch id reads in flight at once, per run. */
export const MAX_CONCURRENT_ID_READS = 3;
/** Backoff of a failed referenced-branch read: base, cap and attempts. */
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;
export const MAX_REFERENCE_READ_ATTEMPTS = 6;

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
  /** Ids waiting to be sent in an id-list read. */
  queue: string[];
  /** Ids queued, in flight or waiting for a retry; never requested twice meanwhile. */
  pending: Set<string>;
  /** Ids whose reads failed every attempt; retried by the next run. */
  failed: Set<string>;
  /** Failed attempts per id, for the retry backoff. */
  attempts: Map<string, number>;
  /** Id-list reads in flight (at most `MAX_CONCURRENT_ID_READS`). */
  inflight: number;
  /** Every reference is known: my sessions (U1 or a complete gated page) and my branches (U2) loaded. */
  referencesKnown: boolean;
  referenceTimer: ReturnType<typeof setTimeout> | null;
  retryTimers: Set<ReturnType<typeof setTimeout>>;
  unsubscribe: (() => void) | null;
}

let currentRun: ScopeRun | null = null;

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

/** Add absent marks and drop the marks of branches that are present now. */
function updateAbsent(add: readonly string[]): void {
  const state = agorStore.getState();
  const next = new Set([...state.absentBranchIds, ...add]);
  for (const id of next) if (state.branchById.has(id)) next.delete(id);
  const same =
    next.size === state.absentBranchIds.size &&
    [...next].every((id) => state.absentBranchIds.has(id));
  if (!same) state.setUserScope({ absentBranchIds: next });
}

/** Ids referenced but neither present, absent, nor pending or failed in this run. */
function missingReferences(s: AgorState, run: ScopeRun): string[] {
  const missing: string[] = [];
  for (const id of referencedBranchIds(s, run.userId)) {
    if (
      !s.branchById.has(id) &&
      !s.absentBranchIds.has(id) &&
      !run.pending.has(id) &&
      !run.failed.has(id)
    ) {
      missing.push(id);
    }
  }
  return missing;
}

/** `homeBranchesLoaded` once every reference is known and none is unresolved. */
function settleHomeBranches(run: ScopeRun): void {
  if (!isCurrent(run) || !run.referencesKnown) return;
  if (run.pending.size > 0 || run.failed.size > 0) return;
  if (missingReferences(agorStore.getState(), run).length > 0) return;
  agorStore.getState().setUserScope({ homeBranchesLoaded: true });
}

/** Queue branch ids for id-list reads (deduplicated by `pending`). */
function queueBranches(run: ScopeRun, ids: Iterable<string>): void {
  for (const id of ids) {
    if (run.pending.has(id)) continue;
    run.pending.add(id);
    run.failed.delete(id);
    run.queue.push(id);
  }
  pumpBranchReads(run);
}

/** Send queued ids in chunks of `PAGINATION.MAX_ID_LIST`, at most `MAX_CONCURRENT_ID_READS` at once. */
function pumpBranchReads(run: ScopeRun): void {
  while (isCurrent(run) && run.inflight < MAX_CONCURRENT_ID_READS && run.queue.length > 0) {
    const chunk = run.queue.splice(0, PAGINATION.MAX_ID_LIST);
    run.inflight += 1;
    void readBranchChunk(run, chunk).finally(() => {
      run.inflight -= 1;
      pumpBranchReads(run);
      settleHomeBranches(run);
    });
  }
}

/**
 * Read one chunk of branch ids and record the ones the server doesn't return —
 * and that didn't arrive meanwhile — as absent. A failed read is retried with
 * backoff; the ids stay pending until it settles.
 */
async function readBranchChunk(run: ScopeRun, chunk: string[]): Promise<void> {
  try {
    const rows = await fillRead(run, async () => ({
      branches: rowsOf<Branch>(
        await run.client.service('branches').find({
          query: { branch_id: { $in: chunk }, archived: false, $limit: chunk.length },
        })
      ),
    }));
    if (!rows) return;
    const returned = new Set((rows.branches ?? []).map((branch) => branch.branch_id as string));
    const state = agorStore.getState();
    updateAbsent(chunk.filter((id) => !returned.has(id) && !state.branchById.has(id)));
    for (const id of chunk) {
      run.pending.delete(id);
      run.attempts.delete(id);
    }
  } catch (err) {
    if (!isCurrent(run)) return;
    console.warn('[userScope] referenced branches failed:', err);
    scheduleRetry(run, chunk);
  }
}

/** Retry failed ids with capped exponential backoff; give up after `MAX_REFERENCE_READ_ATTEMPTS`. */
function scheduleRetry(run: ScopeRun, ids: string[]): void {
  const attempt = Math.max(...ids.map((id) => (run.attempts.get(id) ?? 0) + 1));
  for (const id of ids) run.attempts.set(id, attempt);
  if (attempt >= MAX_REFERENCE_READ_ATTEMPTS) {
    for (const id of ids) {
      run.pending.delete(id);
      run.failed.add(id);
    }
    return;
  }
  const timer = setTimeout(
    () => {
      run.retryTimers.delete(timer);
      if (!isCurrent(run)) return;
      for (const id of ids) run.pending.delete(id);
      queueBranches(
        run,
        ids.filter((id) => !agorStore.getState().branchById.has(id))
      );
      settleHomeBranches(run);
    },
    Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS)
  );
  run.retryTimers.add(timer);
}

/** Clear marks of branches that arrived, queue new references, and settle. */
function checkReferences(run: ScopeRun): void {
  if (!isCurrent(run)) return;
  // A branch arriving by any path (event, partition, ensure) clears its mark.
  updateAbsent([]);
  queueBranches(run, missingReferences(agorStore.getState(), run));
  settleHomeBranches(run);
}

function scheduleReferenceCheck(run: ScopeRun): void {
  if (run.referenceTimer) return;
  run.referenceTimer = setTimeout(() => {
    run.referenceTimer = null;
    checkReferences(run);
  }, REFERENCE_DEBOUNCE_MS);
}

function subscribeToReferences(run: ScopeRun): void {
  run.unsubscribe = agorStore.subscribe((state, prev) => {
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

/** Stop the current run: unsubscribe, cancel its timers, and drop its pending applies. */
export function stopUserScope(): void {
  const run = currentRun;
  currentRun = null;
  if (!run) return;
  run.unsubscribe?.();
  run.unsubscribe = null;
  if (run.referenceTimer) clearTimeout(run.referenceTimer);
  run.referenceTimer = null;
  for (const timer of run.retryTimers) clearTimeout(timer);
  run.retryTimers.clear();
  run.queue = [];
}

/**
 * Load the user scope under `lifetime`, the lifetime of the load that started
 * it (captured before that load's first await). A lifetime that is no longer
 * current — another authority, or a cancellation since — is rejected, so a
 * load that outlived a logout/remount can never adopt the next user's
 * authority. `gatedMineComplete` says the gated first-paint page already holds
 * all of my active sessions (it returned fewer than `MY_SESSIONS_GATED_LIMIT`
 * rows and raced none of mine), so U1 can be skipped. Resolves when the
 * initial reads finished, failed, or were superseded; the reference
 * subscription and retries keep running until `stopUserScope`.
 */
export async function startUserScope(
  client: AgorClient,
  options: { userId: string; lifetime: LoadLifetime; gatedMineComplete: boolean }
): Promise<void> {
  if (!isLoadLifetimeCurrent(options.lifetime)) return;
  stopUserScope();
  const run: ScopeRun = {
    client,
    userId: options.userId,
    lifetime: options.lifetime,
    queue: [],
    pending: new Set(),
    failed: new Set(),
    attempts: new Map(),
    inflight: 0,
    referencesKnown: false,
    referenceTimer: null,
    retryTimers: new Set(),
    unsubscribe: null,
  };
  currentRun = run;
  const store = () => agorStore.getState();
  if (options.gatedMineComplete) store().setUserScope({ mySessionsLoaded: true });

  // Subscribe before any read: a reference that appears while the reads below
  // are in flight is seen by the subscription, never lost between a scan and
  // a late subscribe.
  subscribeToReferences(run);
  // Absent marks are negatives of the authority that produced them (a grant,
  // reconnect or role change can make a branch visible): revalidate them.
  queueBranches(run, store().absentBranchIds);
  // Early pass: resolve what the gated page already references now — full
  // page or not — so these small reads go out before U1 and the global
  // snapshots instead of queuing behind them on a slow socket.
  checkReferences(run);

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

  const settled = await Promise.allSettled([u1, u2, u3]);
  for (const result of settled) {
    if (result.status === 'rejected') console.warn('[userScope] read failed:', result.reason);
  }
  if (!isCurrent(run)) return;
  // Every reference is known once all of my sessions and my branches are in;
  // teammates (U3) only shrink the id list, so they needn't succeed.
  const ok = (index: number) => settled[index].status === 'fulfilled' && settled[index].value;
  if (!ok(0) || !ok(1)) return;
  run.referencesKnown = true;
  // Immediate catch-up scan (not debounced): references U1 added are queued now.
  checkReferences(run);
}
