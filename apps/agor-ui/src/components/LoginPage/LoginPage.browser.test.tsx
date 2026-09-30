/** Real Chromium copy/layout proof; external-provider logout is outside this component. */
import { cleanup, render, screen } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { afterEach, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

afterEach(cleanup);

it('confirms explicit logout and makes signing back in clear at every viewport', () => {
  render(
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { motion: false } }}>
      <LoginPage
        onLogin={vi.fn()}
        hasLoggedOut
        externalLaunchLoginRedirectUrl="https://workspace.example.com/open"
        localLoginEnabled={false}
      />
    </ConfigProvider>
  );

  expect(screen.getByText('You are signed out of this workspace')).toBeInTheDocument();
  expect(screen.getByText('Sign in again to open this workspace.')).toBeInTheDocument();
  const signIn = screen.getByRole('link', { name: 'Sign in' });
  expect(signIn).toHaveAttribute(
    'href',
    expect.stringContaining('https://workspace.example.com/open?')
  );
  const bounds = signIn.getBoundingClientRect();
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  expect(screen.queryByText(/configured for external launch/)).not.toBeInTheDocument();
});

it('keeps fresh entry and launch failure distinct from a successful logout', () => {
  const { rerender } = render(
    <LoginPage
      onLogin={vi.fn()}
      externalLaunchLoginRedirectUrl="https://workspace.example.com/open"
    />
  );
  expect(screen.getByText('Open from your workspace')).toBeInTheDocument();
  expect(screen.queryByText('You are signed out of this workspace')).not.toBeInTheDocument();

  rerender(
    <LoginPage
      onLogin={vi.fn()}
      hasLoggedOut
      error="Launch sign-in failed. The one-time launch code may have expired or already been used."
      externalLaunchLoginRedirectUrl="https://workspace.example.com/open"
    />
  );
  expect(screen.getByText('Launch sign-in failed')).toBeInTheDocument();
  expect(screen.queryByText('You are signed out of this workspace')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Return to workspace' })).toBeInTheDocument();
});
