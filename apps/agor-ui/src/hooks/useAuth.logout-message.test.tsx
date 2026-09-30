import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TOKENS_REFRESH_UNRECOVERABLE_EVENT } from '../utils/singleFlightRefresh';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from '../utils/tokenRefresh';
import { useAuth } from './useAuth';

const authenticate = vi.fn();
vi.mock('@agor-live/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor-live/client')>()),
  createRestClient: vi.fn(async () => ({ authenticate })),
}));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/ui/');
  authenticate.mockReset();
  authenticate.mockResolvedValue({
    user: { user_id: 'alice', email: 'alice@example.test', role: 'member' },
    accessToken: 'alice-access',
    refreshToken: 'alice-refresh',
  });
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

it('shows a logout receipt only for explicit logout and clears it when another user signs in', async () => {
  const { result } = renderHook(() => useAuth());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.hasLoggedOut).toBe(false);

  await act(async () => {
    await result.current.login('alice@example.test', 'password');
  });
  await act(async () => {
    await result.current.logout();
  });
  expect(result.current.hasLoggedOut).toBe(true);
  expect(result.current.authenticated).toBe(false);
  expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
  expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();

  authenticate.mockResolvedValue({
    user: { user_id: 'bob', email: 'bob@example.test', role: 'member' },
    accessToken: 'bob-access',
    refreshToken: 'bob-refresh',
  });
  await act(async () => {
    await result.current.login('bob@example.test', 'password');
  });
  expect(result.current.hasLoggedOut).toBe(false);
  act(() => {
    window.dispatchEvent(new Event(TOKENS_REFRESH_UNRECOVERABLE_EVENT));
  });
  expect(result.current.authenticated).toBe(false);
  expect(result.current.hasLoggedOut).toBe(false);
});

it('does not claim user logout during a password-change authority cycle', async () => {
  const { result } = renderHook(() => useAuth());
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => {
    await result.current.login('alice@example.test', 'password');
  });
  const cycle = result.current.captureAuthorityCycle({
    isCurrent: () => true,
    onInvalidate: () => () => {},
  });
  expect(cycle).not.toBeNull();
  await act(async () => {
    await result.current.logoutForAuthorityCycle(cycle!);
  });
  expect(result.current.authenticated).toBe(false);
  expect(result.current.hasLoggedOut).toBe(false);
});
