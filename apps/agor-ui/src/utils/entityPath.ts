import { ENTITY_PATH_SEGMENTS } from '@agor-live/client';

// Parse the leading entity segment out of the current pathname, e.g.
// `/ui/b/my-board/` → { kind: 'board', token: 'my-board' }. The regex is
// built from ENTITY_PATH_SEGMENTS so it stays in lockstep with the route
// table and tolerates the optional `/ui` basename. Returns null for Home (`/`)
// or any non-entity path.
const ENTITY_PATH_RE = new RegExp(
  `/(${ENTITY_PATH_SEGMENTS.board}|${ENTITY_PATH_SEGMENTS.session}|${ENTITY_PATH_SEGMENTS.branch}|${ENTITY_PATH_SEGMENTS.artifact})/([^/]+)`
);
type ParsedEntityPath = { kind: 'board' | 'session' | 'branch' | 'artifact'; token: string } | null;
export function parseEntityPath(pathname: string): ParsedEntityPath {
  const match = pathname.match(ENTITY_PATH_RE);
  if (!match) return null;
  const [, segment, token] = match;
  const kind =
    segment === ENTITY_PATH_SEGMENTS.board
      ? 'board'
      : segment === ENTITY_PATH_SEGMENTS.session
        ? 'session'
        : segment === ENTITY_PATH_SEGMENTS.branch
          ? 'branch'
          : 'artifact';
  return { kind, token };
}
