import { render } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { StandaloneSettingsDrillProvider } from './SettingsDrill';

/**
 * Wrapper that mirrors the Workspace Settings shell for tests:
 * `StandaloneSettingsDrillProvider` owns the drill/controller state and renders
 * the same controller-driven Save/Cancel footer the real shell renders, so a
 * table's drill-in create/edit flow is exercisable end-to-end (open action →
 * form in place → footer Save/Cancel).
 */
const SettingsShellWrapper: React.FC<{ children: ReactNode }> = ({ children }) => (
  <ConfigProvider theme={{ hashed: false }}>
    <AntApp>
      <StandaloneSettingsDrillProvider>{children}</StandaloneSettingsDrillProvider>
    </AntApp>
  </ConfigProvider>
);

/**
 * Render `ui` inside AntD providers + the settings drill shell harness. Uses the
 * testing-library `wrapper` option so `rerender` re-applies the same persistent
 * harness instance (drill state survives a rerender, e.g. an auth-generation
 * change), matching how the real shell keeps drill state across re-renders.
 */
export function renderWithSettingsShell(ui: ReactNode) {
  return render(ui, { wrapper: SettingsShellWrapper });
}
