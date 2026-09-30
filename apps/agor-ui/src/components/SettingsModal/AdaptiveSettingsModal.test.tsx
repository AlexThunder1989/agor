import { fireEvent, render, screen } from '@testing-library/react';
import { Grid } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdaptiveSettingsModal } from './AdaptiveSettingsModal';
import { renderWithSettingsShell } from './settingsDrillTestUtils';

describe('AdaptiveSettingsModal', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders phone dialogs as bottom sheets', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: false });
    render(
      <AdaptiveSettingsModal title="Create board" open onCancel={vi.fn()}>
        Board form
      </AdaptiveSettingsModal>
    );

    expect(screen.getByRole('dialog', { name: 'Create board' })).toHaveClass('ant-drawer-section');
    expect(screen.getByText('Board form')).toBeInTheDocument();
  });

  it('retains a modal at desktop widths', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: true });
    render(
      <AdaptiveSettingsModal title="Create board" open onCancel={vi.fn()}>
        Board form
      </AdaptiveSettingsModal>
    );

    expect(screen.getByRole('dialog', { name: 'Create board' })).toHaveClass('ant-modal');
  });

  it('renders in-place (no stacked dialog) and drives Save via the shell footer when embedded', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: true });
    const onOk = vi.fn();
    renderWithSettingsShell(
      <AdaptiveSettingsModal embedded open title="Create board" okText="Create" onOk={onOk}>
        Board form
      </AdaptiveSettingsModal>
    );

    // No stacked Modal/Drawer — the body renders inline in the drill frame.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Board form')).toBeInTheDocument();
    // The shell footer surfaces the mapped Save button (okText → Save label).
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onOk).toHaveBeenCalledTimes(1);
  });

  it('renders embedded in place at a mobile width (no stacked dialog)', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: false });
    const onOk = vi.fn();
    renderWithSettingsShell(
      <AdaptiveSettingsModal embedded open title="Create board" okText="Create" onOk={onOk}>
        Board form
      </AdaptiveSettingsModal>
    );

    // Embedded never becomes a Modal/Drawer, on desktop or mobile — it always
    // renders in place inside the drill frame (the shell handles compact layout).
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Board form')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onOk).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when embedded and closed', () => {
    vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: true });
    renderWithSettingsShell(
      <AdaptiveSettingsModal embedded open={false} title="Create board" onCancel={vi.fn()}>
        Board form
      </AdaptiveSettingsModal>
    );

    expect(screen.queryByText('Board form')).not.toBeInTheDocument();
  });
});
