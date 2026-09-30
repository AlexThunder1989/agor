import { render } from '@testing-library/react';
import { App as AntApp, Button, ConfigProvider } from 'antd';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import {
  type DrillController,
  type DrillTarget,
  SettingsDrillProvider,
  useDirtyLeaveGuard,
} from './SettingsDrill';

/**
 * Test harness that mirrors the Workspace Settings shell: it owns the
 * `drill`/`controller` state, provides the SettingsDrill context, and renders
 * the same controller-driven Save/Cancel footer the real shell renders. Use it
 * to unit-test a table's drill-in create/edit flow — clicking the table's
 * open action drives `openDrill`, and the footer's "Save"/section "Cancel"
 * buttons exercise the registered controller exactly as they do in the shell.
 */
const SettingsDrillHarness: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [controller, setControllerState] = useState<DrillController | null>(null);
  const controllerRef = useRef<DrillController | null>(null);
  const setController = useCallback((next: DrillController | null) => {
    controllerRef.current = next;
    setControllerState(next);
  }, []);
  const getDirty = useCallback(() => controllerRef.current?.dirty ?? false, []);
  const confirmLeaveIfDirty = useDirtyLeaveGuard(getDirty);
  const openDrill = useCallback((target: DrillTarget) => setDrill(target), []);
  const closeDrill = useCallback(() => {
    setDrill(null);
    setController(null);
  }, [setController]);
  const footer = useMemo(() => {
    if (!controller || controller.ownsFooter) return null;
    return (
      <div>
        <Button onClick={controller.onBack} disabled={controller.saving}>
          Cancel
        </Button>
        {controller.onSave ? (
          <Button
            type="primary"
            loading={controller.saving}
            disabled={controller.saveDisabled}
            onClick={() => void controller.onSave?.()}
          >
            {controller.saveLabel ?? 'Save'}
          </Button>
        ) : null}
      </div>
    );
  }, [controller]);

  return (
    <SettingsDrillProvider
      drill={drill}
      openDrill={openDrill}
      closeDrill={closeDrill}
      confirmLeaveIfDirty={confirmLeaveIfDirty}
      controller={controller}
      setController={setController}
    >
      {children}
      {footer}
    </SettingsDrillProvider>
  );
};

const SettingsShellWrapper: React.FC<{ children: ReactNode }> = ({ children }) => (
  <ConfigProvider theme={{ hashed: false }}>
    <AntApp>
      <SettingsDrillHarness>{children}</SettingsDrillHarness>
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
