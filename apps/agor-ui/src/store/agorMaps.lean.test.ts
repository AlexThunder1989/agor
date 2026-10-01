import type { Session } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  buildSessionMaps,
  EMPTY_MAPS,
  restoreLeanSessionContext,
  restoreSessionDetailsInMaps,
} from './agorMaps';

const V1 = '2026-06-24T00:00:00.000Z';
const V2 = '2026-06-25T00:00:00.000Z';
const fullContext = {
  teamName: 'Backend',
  slash_commands: ['review'],
  scheduled_run: { rendered_prompt: 'prompt', run_index: 1 },
};

const session = (overrides: Partial<Session> = {}): Session =>
  ({
    session_id: 's-1',
    branch_id: 'b-1',
    status: 'idle',
    archived: false,
    created_at: V1,
    last_updated: V1,
    custom_context: fullContext,
    ...overrides,
  }) as unknown as Session;

const lean = (overrides: Partial<Session> = {}) =>
  session({
    custom_context: { teamName: 'Backend' },
    custom_context_omitted: ['slash_commands', 'scheduled_run'],
    ...overrides,
  });

describe('restoreLeanSessionContext', () => {
  it('restores withheld keys from a same-version full row and drops the marker', () => {
    const restored = restoreLeanSessionContext(lean({ status: 'running' }), session());
    expect(restored.custom_context).toEqual(fullContext);
    expect(restored).not.toHaveProperty('custom_context_omitted');
    // Every non-withheld field comes from the lean (incoming) row.
    expect(restored.status).toBe('running');
  });

  it('keeps the lean row when the full row is another version, lean, or incomplete', () => {
    const incoming = lean();
    expect(restoreLeanSessionContext(incoming, undefined)).toBe(incoming);
    expect(restoreLeanSessionContext(incoming, session({ last_updated: V2 }))).toBe(incoming);
    expect(restoreLeanSessionContext(incoming, lean())).toBe(incoming);
    expect(
      restoreLeanSessionContext(incoming, session({ custom_context: { teamName: 'Backend' } }))
    ).toBe(incoming);
    expect(restoreLeanSessionContext(incoming, session({ session_id: 's-2' }))).toBe(incoming);
  });

  it('passes complete rows through untouched', () => {
    const full = session({ last_updated: V2 });
    expect(restoreLeanSessionContext(full, session())).toBe(full);
  });
});

describe('restoreSessionDetailsInMaps', () => {
  it('fills the canonical row and its branch bucket, leaving remote surrogates alone', () => {
    const stored = lean();
    const maps = { ...EMPTY_MAPS, ...buildSessionMaps([stored]) };
    const surrogate = { ...stored, branch_id: 'b-2', remote_surrogate: {} } as unknown as Session;
    maps.sessionsByBranch.set('b-2', [surrogate]);

    const next = restoreSessionDetailsInMaps(maps, session());
    const restored = next.sessionById.get('s-1');
    expect(restored?.custom_context).toEqual(fullContext);
    expect(next.sessionsByBranch.get('b-1')).toEqual([restored]);
    expect(next.sessionsByBranch.get('b-1')?.[0]).toBe(restored);
    expect(next.sessionsByBranch.get('b-2')?.[0]).toBe(surrogate);
  });

  it('is a no-op for a different version, an unknown id, or an already-full row', () => {
    const leanMaps = { ...EMPTY_MAPS, ...buildSessionMaps([lean()]) };
    expect(restoreSessionDetailsInMaps(leanMaps, session({ last_updated: V2 }))).toBe(leanMaps);
    expect(restoreSessionDetailsInMaps(leanMaps, session({ session_id: 's-9' }))).toBe(leanMaps);
    const fullMaps = { ...EMPTY_MAPS, ...buildSessionMaps([session()]) };
    expect(restoreSessionDetailsInMaps(fullMaps, session())).toBe(fullMaps);
  });
});
