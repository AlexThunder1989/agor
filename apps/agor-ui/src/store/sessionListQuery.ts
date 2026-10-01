/**
 * The one place session LIST reads that feed the store are shaped.
 *
 * PR #2887 adds `sessions.find({ lean: true })`, which withholds bulky
 * single-session `custom_context` keys from list rows; under its contract the
 * store is never the source for those keys. Once this branch is rebased onto
 * #2887, add `lean: true` here — a one-line change for every caller. Until
 * then it must not be sent: an older daemon's query validator rejects it.
 */
export function sessionListQuery<Q extends Record<string, unknown>>(query: Q): Q {
  return query;
}
