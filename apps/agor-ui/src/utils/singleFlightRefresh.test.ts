import type { AuthenticatedAgorClient } from '@agor-live/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the underlying refresh call so tests are hermetic — we want to
// exercise the single-flight and event-dispatch behaviour of this module,
// not the HTTP call inside `refreshAndStoreTokens`.
vi.mock('./tokenRefresh', async () => {
  const actual = await vi.importActual<typeof import('./tokenRefresh')>('./tokenRefresh');
  return {
    ...actual,
    refreshAndStoreTokens: vi.fn(),
  };
});

import {
  isRefreshUnrecoverable,
  markAuthenticationUnrecoverable,
  RefreshUnrecoverableError,
  refreshTokensSingleFlight,
  resetRefreshFailureState,
  TOKENS_REFRESH_UNRECOVERABLE_EVENT,
  TOKENS_REFRESHED_EVENT,
} from './singleFlightRefresh';
import { REFRESH_TOKEN_KEY, RefreshSupersededError, refreshAndStoreTokens } from './tokenRefresh';

const mockRefresh = refreshAndStoreTokens as unknown as ReturnType<typeof vi.fn>;

function makeResult(accessToken = 'new-access', refreshToken = 'new-refresh') {
  return {
    accessToken,
    refreshToken,
    user: { user_id: 'u1', email: 'u1@example.com', role: 'member' },
  };
}

function makeClient(): AuthenticatedAgorClient {
  return { authenticate: vi.fn() } as unknown as AuthenticatedAgorClient;
}

beforeEach(() => {
  mockRefresh.mockReset();
  // The unrecoverable latch is a module-level singleton — reset between
  // tests so order-dependent state doesn't leak.
  resetRefreshFailureState();
  // The stored refresh token is what a refresh rejection is judged against.
  localStorage.setItem(REFRESH_TOKEN_KEY, 'rt');
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('refreshTokensSingleFlight', () => {
  it('deduplicates concurrent calls to a single underlying refresh', async () => {
    let resolveRefresh!: (v: ReturnType<typeof makeResult>) => void;
    mockRefresh.mockImplementation(
      () =>
        new Promise<ReturnType<typeof makeResult>>((resolve) => {
          resolveRefresh = resolve;
        })
    );

    const client = makeClient();
    const p1 = refreshTokensSingleFlight(client, 'rt');
    const p2 = refreshTokensSingleFlight(client, 'rt');
    const p3 = refreshTokensSingleFlight(client, 'rt');

    expect(mockRefresh).toHaveBeenCalledTimes(1);

    const result = makeResult();
    resolveRefresh(result);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe(result);
    expect(r2).toBe(result);
    expect(r3).toBe(result);
  });

  it('issues a new refresh after the previous one settles', async () => {
    mockRefresh
      .mockResolvedValueOnce(makeResult('first'))
      .mockResolvedValueOnce(makeResult('second'));

    const client = makeClient();
    const first = await refreshTokensSingleFlight(client, 'rt');
    expect(first.accessToken).toBe('first');

    const second = await refreshTokensSingleFlight(client, 'rt');
    expect(second.accessToken).toBe('second');
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight slot on failure so the next caller can retry', async () => {
    mockRefresh
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(makeResult('recovered'));

    const client = makeClient();
    await expect(refreshTokensSingleFlight(client, 'rt')).rejects.toThrow('boom');
    const retry = await refreshTokensSingleFlight(client, 'rt');
    expect(retry.accessToken).toBe('recovered');
  });

  it('dispatches TOKENS_REFRESHED_EVENT with the result on success', async () => {
    const result = makeResult();
    mockRefresh.mockResolvedValueOnce(result);

    const listener = vi.fn();
    window.addEventListener(TOKENS_REFRESHED_EVENT, listener);
    try {
      await refreshTokensSingleFlight(makeClient(), 'rt');
      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0][0] as CustomEvent;
      expect(event.detail).toBe(result);
    } finally {
      window.removeEventListener(TOKENS_REFRESHED_EVENT, listener);
    }
  });

  it('does not dispatch an event on failure', async () => {
    mockRefresh.mockRejectedValueOnce(new Error('nope'));
    const listener = vi.fn();
    window.addEventListener(TOKENS_REFRESHED_EVENT, listener);
    try {
      await expect(refreshTokensSingleFlight(makeClient(), 'rt')).rejects.toThrow();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(TOKENS_REFRESHED_EVENT, listener);
    }
  });

  it('throws RefreshUnrecoverableError on the first definite failure, latches, and fast-fails subsequent callers', async () => {
    // Simulate a Feathers `NotAuthenticated` from /authentication/refresh:
    // the refresh token has expired/been revoked.
    const authErr = Object.assign(new Error('jwt expired'), {
      name: 'NotAuthenticated',
      code: 401,
    });
    mockRefresh.mockRejectedValueOnce(authErr);

    const client = makeClient();
    const unrecoverableListener = vi.fn();
    window.addEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, unrecoverableListener);
    try {
      // First call must reject with RefreshUnrecoverableError (not the raw
      // auth error) so callers can use a single `instanceof` check on every
      // failure — first or fast-failed. The original error is attached as
      // `cause` for diagnostics.
      const firstErr = await refreshTokensSingleFlight(client, 'rt').catch((e) => e);
      expect(firstErr).toBeInstanceOf(RefreshUnrecoverableError);
      expect((firstErr as RefreshUnrecoverableError).cause).toBe(authErr);
      expect(isRefreshUnrecoverable()).toBe(true);
      expect(unrecoverableListener).toHaveBeenCalledTimes(1);

      // Second call MUST NOT hit the network — this is the loop-breaker.
      await expect(refreshTokensSingleFlight(client, 'rt')).rejects.toBeInstanceOf(
        RefreshUnrecoverableError
      );
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, unrecoverableListener);
    }
  });

  it('does NOT latch on transient (non-auth) failures', async () => {
    // Network blip / 5xx — the refresh token may still be good.
    const transient = Object.assign(new Error('server exploded'), { code: 500 });
    mockRefresh.mockRejectedValueOnce(transient);

    const unrecoverableListener = vi.fn();
    window.addEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, unrecoverableListener);
    try {
      await expect(refreshTokensSingleFlight(makeClient(), 'rt')).rejects.toBe(transient);
      expect(isRefreshUnrecoverable()).toBe(false);
      expect(unrecoverableListener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, unrecoverableListener);
    }
  });

  it('broadcasts once when a refreshed credential still cannot authenticate', () => {
    const listener = vi.fn();
    const cause = Object.assign(new Error('tenant claim rejected'), { code: 401 });
    window.addEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, listener);
    try {
      const first = markAuthenticationUnrecoverable(cause);
      const second = markAuthenticationUnrecoverable(cause);

      expect(first).toBeInstanceOf(RefreshUnrecoverableError);
      expect(first.cause).toBe(cause);
      expect(second).toBeInstanceOf(RefreshUnrecoverableError);
      expect(isRefreshUnrecoverable()).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, listener);
    }
  });

  it('clears the unrecoverable latch on the next successful refresh', async () => {
    const authErr = Object.assign(new Error('jwt expired'), {
      name: 'NotAuthenticated',
      code: 401,
    });
    mockRefresh.mockRejectedValueOnce(authErr).mockResolvedValueOnce(makeResult('fresh'));

    const client = makeClient();
    await expect(refreshTokensSingleFlight(client, 'rt')).rejects.toBeInstanceOf(
      RefreshUnrecoverableError
    );
    expect(isRefreshUnrecoverable()).toBe(true);

    // Caller explicitly resets (e.g. user logged back in) before retrying.
    resetRefreshFailureState();
    const recovered = await refreshTokensSingleFlight(client, 'rt');
    expect(recovered.accessToken).toBe('fresh');
    expect(isRefreshUnrecoverable()).toBe(false);
  });

  it('does not let a caller holding a different refresh token join an in-flight refresh', async () => {
    const resolvers: Array<(v: ReturnType<typeof makeResult>) => void> = [];
    mockRefresh.mockImplementation(
      () =>
        new Promise<ReturnType<typeof makeResult>>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const client = makeClient();
    const older = refreshTokensSingleFlight(client, 'rt');
    const newer = refreshTokensSingleFlight(client, 'rt-newer');
    const olderJoiner = refreshTokensSingleFlight(client, 'rt');

    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(mockRefresh).toHaveBeenNthCalledWith(1, expect.anything(), 'rt');
    expect(mockRefresh).toHaveBeenNthCalledWith(2, expect.anything(), 'rt-newer');
    expect(olderJoiner).toBe(older);
    expect(newer).not.toBe(older);

    const olderResult = makeResult('older');
    const newerResult = makeResult('newer');
    resolvers[0](olderResult);
    resolvers[1](newerResult);
    await expect(newer).resolves.toBe(newerResult);
    await expect(older).resolves.toBe(olderResult);
  });

  it('a settled older refresh does not evict the in-flight slot of a newer token', async () => {
    let resolveNewer!: (v: ReturnType<typeof makeResult>) => void;
    mockRefresh.mockImplementation((_client: unknown, token: string) =>
      token === 'rt-newer'
        ? new Promise<ReturnType<typeof makeResult>>((resolve) => {
            resolveNewer = resolve;
          })
        : Promise.resolve(makeResult('older'))
    );

    const client = makeClient();
    const newer = refreshTokensSingleFlight(client, 'rt-newer');
    await refreshTokensSingleFlight(client, 'rt');
    expect(refreshTokensSingleFlight(client, 'rt-newer')).toBe(newer);
    expect(mockRefresh).toHaveBeenCalledTimes(2);
    resolveNewer(makeResult('newer'));
    await newer;
  });

  it('a superseded refresh rejection neither latches nor broadcasts nor signs the user out', async () => {
    const authErr = Object.assign(new Error('jwt expired'), {
      name: 'NotAuthenticated',
      code: 401,
    });
    let rejectOlder!: (e: unknown) => void;
    mockRefresh.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectOlder = reject;
        })
    );

    const listener = vi.fn();
    window.addEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, listener);
    try {
      const older = refreshTokensSingleFlight(makeClient(), 'rt');
      // The user signs in again (or another tab rotates) while the POST is out.
      localStorage.setItem(REFRESH_TOKEN_KEY, 'rt-after-sign-in');
      rejectOlder(authErr);

      await expect(older).rejects.toBeInstanceOf(RefreshSupersededError);
      expect(isRefreshUnrecoverable()).toBe(false);
      expect(listener).not.toHaveBeenCalled();

      // The newer credentials are not fast-failed by the old rejection.
      mockRefresh.mockResolvedValueOnce(makeResult('newer'));
      await expect(refreshTokensSingleFlight(makeClient(), 'rt-after-sign-in')).resolves.toEqual(
        expect.objectContaining({ accessToken: 'newer' })
      );
    } finally {
      window.removeEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, listener);
    }
  });

  it('a rejection after logout cleared the stored token is superseded, not an unrecoverable broadcast', async () => {
    const authErr = Object.assign(new Error('jwt expired'), {
      name: 'NotAuthenticated',
      code: 401,
    });
    mockRefresh.mockImplementationOnce(async () => {
      localStorage.removeItem(REFRESH_TOKEN_KEY);
      throw authErr;
    });
    const listener = vi.fn();
    window.addEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, listener);
    try {
      await expect(refreshTokensSingleFlight(makeClient(), 'rt')).rejects.toBeInstanceOf(
        RefreshSupersededError
      );
      expect(isRefreshUnrecoverable()).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, listener);
    }
  });
});
