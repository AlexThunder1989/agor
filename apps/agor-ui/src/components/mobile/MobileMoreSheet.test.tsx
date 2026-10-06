import type { User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { MobileMoreSheet } from './MobileMoreSheet';

function Probe() {
  return <output aria-label="path">{useLocation().pathname}</output>;
}

function renderSheet(props: Partial<React.ComponentProps<typeof MobileMoreSheet>> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onOpenComments: vi.fn(),
    onNewSession: vi.fn(),
    onOpenWorkspaceSettings: vi.fn(),
    onOpenUserSettings: vi.fn(),
    onLogout: vi.fn(),
  };
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/m']}>
        <Probe />
        <MobileMoreSheet
          open
          user={{ user_id: 'u1', name: 'Kasia Designer' } as User}
          commentsBadge={3}
          {...handlers}
          {...props}
        />
      </MemoryRouter>
    </ThemeProvider>
  );
  return handlers;
}

const rowNames = () =>
  Array.from(screen.getByRole('dialog').querySelectorAll('.ant-list-item')).map(
    (row) => row.getAttribute('aria-label') ?? row.textContent
  );

afterEach(() => vi.restoreAllMocks());

describe('MobileMoreSheet', () => {
  it('lists the destinations in order, with no board tree', () => {
    renderSheet();
    expect(rowNames()).toEqual([
      'Profile: Kasia Designer',
      'Create new',
      'Search',
      'Comments and mentions, 3 unread',
      'Knowledge base',
      'Settings',
      'AppearanceLightDark',
      'Sign out',
    ]);
    expect(screen.queryByRole('button', { name: /board/i })).not.toBeInTheDocument();
  });

  it('closes before opening each destination', () => {
    const handlers = renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Comments and mentions, 3 unread' }));
    expect(handlers.onClose).toHaveBeenCalled();
    expect(handlers.onOpenComments).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(handlers.onOpenWorkspaceSettings).toHaveBeenCalledWith('boards');
    fireEvent.click(screen.getByRole('button', { name: 'Profile: Kasia Designer' }));
    expect(handlers.onOpenUserSettings).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByRole('status', { name: 'path' })).toHaveTextContent('/m/search');
  });

  it('discloses the create flows under Create new', () => {
    const handlers = renderSheet();
    const create = screen.getByRole('button', { name: 'Create new' });
    expect(create).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(create);
    expect(create).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Session' }));
    expect(handlers.onNewSession).toHaveBeenCalled();
    expect(create).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(create);
    fireEvent.click(screen.getByRole('button', { name: 'Teammate' }));
    expect(handlers.onOpenWorkspaceSettings).toHaveBeenCalledWith('teammates');
  });

  it('opens a configured external app link in a new tab', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderSheet({
      externalAppLink: 'https://console.example.test/',
      externalAppLabel: 'Open Agor Cloud',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Agor Cloud' }));
    expect(open).toHaveBeenCalledExactlyOnceWith(
      'https://console.example.test/',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('omits the external app row for a non-http(s) link', () => {
    renderSheet({ externalAppLink: 'javascript:alert(1)', externalAppLabel: 'Open Agor Cloud' });
    expect(screen.queryByText('Open Agor Cloud')).not.toBeInTheDocument();
  });
});
