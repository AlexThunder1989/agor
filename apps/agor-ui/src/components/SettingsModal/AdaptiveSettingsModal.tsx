import type { ModalProps } from 'antd';
import { Button, Drawer, Flex, Grid, Modal } from 'antd';
import type { MouseEvent, ReactNode } from 'react';
import { DrillInFrame, useSettingsDrill } from './SettingsDrill';

export type AdaptiveSettingsModalProps = Omit<ModalProps, 'footer'> & {
  footer?: ReactNode;
  /**
   * Render the body in-place inside the Workspace Settings drill shell (shared
   * `DrillInFrame` breadcrumb + the shell's Save/Cancel footer) instead of
   * stacking a Modal / Drawer on top of the already-open Settings modal.
   *
   * "No modal on modal" is the core premise of the Settings redesign, so every
   * Create/Edit flow rendered from within Workspace Settings passes this. It
   * defaults to `false` → the standalone Modal/Drawer used anywhere OUTSIDE the
   * Settings shell is completely unchanged.
   */
  embedded?: boolean;
  /**
   * Drives the unsaved-changes guard on Back/Cancel when `embedded`. Wire it to
   * the form's touched/changed state so leaving a dirty form confirms first;
   * defaults to `false` (leave immediately).
   */
  dirty?: boolean;
};

type ModalCancelEvent = Parameters<NonNullable<ModalProps['onCancel']>>[0];

/** Desktop dialog that becomes a bottom sheet on phone-sized settings surfaces. */
export function AdaptiveSettingsModal({
  children,
  title,
  open,
  onCancel,
  onOk,
  okText = 'OK',
  cancelText = 'Cancel',
  okButtonProps,
  cancelButtonProps,
  confirmLoading,
  footer,
  afterClose,
  destroyOnHidden,
  width,
  closable,
  maskClosable,
  keyboard,
  embedded = false,
  dirty = false,
  ...modalProps
}: AdaptiveSettingsModalProps) {
  const screens = Grid.useBreakpoint();
  const compact = !screens.md;
  // Safe no-op default outside a provider, so non-embedded external callers are
  // unaffected by reading the drill context here.
  const { confirmLeaveIfDirty } = useSettingsDrill();

  // In-place drill-in for the Workspace Settings shell. The caller gates this on
  // its drill state and early-returns it in place of the list, so the Content
  // pane swaps list↔editor instead of overlaying a second dialog. The shared
  // shell footer renders Save/Cancel from the controller `DrillInFrame`
  // registers; Back runs the unsaved-changes guard, then the caller's `onCancel`
  // returns to the list (closeDrill).
  if (embedded) {
    if (!open) return null;
    const handleBack = () => {
      // Clean form → close synchronously (matches a plain onCancel and keeps
      // fireEvent-driven flows deterministic). Dirty → run the async discard
      // guard first, closing only if the user confirms.
      if (!dirty) {
        onCancel?.(undefined as unknown as ModalCancelEvent);
        return;
      }
      void confirmLeaveIfDirty().then((ok) => {
        if (ok) onCancel?.(undefined as unknown as ModalCancelEvent);
      });
    };
    // A caller that passes its own `footer` (e.g. Gateway's multi-step create
    // wizard) owns it: render it in-frame and tell the shell to suppress its own
    // Save/Cancel footer so the two don't stack. Otherwise the shell footer
    // drives Save (onOk) / Cancel (guarded back).
    const ownsFooter = footer !== undefined && footer !== null;
    return (
      <DrillInFrame
        title={title}
        dirty={dirty}
        saving={Boolean(confirmLoading)}
        saveLabel={typeof okText === 'string' ? okText : undefined}
        saveDisabled={okButtonProps?.disabled}
        onSave={
          ownsFooter || !onOk
            ? undefined
            : () => onOk(undefined as unknown as MouseEvent<HTMLButtonElement>)
        }
        onBack={handleBack}
        ownsFooter={ownsFooter}
      >
        {children}
        {ownsFooter ? <div style={{ marginTop: 16 }}>{footer}</div> : null}
      </DrillInFrame>
    );
  }

  if (!compact) {
    return (
      <Modal
        {...modalProps}
        title={title}
        open={open}
        onCancel={onCancel}
        onOk={onOk}
        okText={okText}
        cancelText={cancelText}
        okButtonProps={okButtonProps}
        cancelButtonProps={cancelButtonProps}
        confirmLoading={confirmLoading}
        footer={footer}
        afterClose={afterClose}
        destroyOnHidden={destroyOnHidden}
        width={width}
        closable={closable}
        maskClosable={maskClosable}
        keyboard={keyboard}
      >
        {children}
      </Modal>
    );
  }

  const resolvedFooter =
    footer === null ? null : footer !== undefined ? (
      footer
    ) : (
      <Flex justify="flex-end" gap={8} wrap>
        <Button {...cancelButtonProps} onClick={(event) => onCancel?.(event as ModalCancelEvent)}>
          {cancelText}
        </Button>
        <Button type="primary" {...okButtonProps} loading={confirmLoading} onClick={onOk}>
          {okText}
        </Button>
      </Flex>
    );

  return (
    <Drawer
      title={title}
      open={open}
      onClose={(event) => onCancel?.(event as ModalCancelEvent)}
      placement="bottom"
      size="large"
      closable={closable}
      maskClosable={maskClosable}
      keyboard={keyboard}
      destroyOnHidden={destroyOnHidden}
      afterOpenChange={(isOpen) => {
        if (!isOpen) afterClose?.();
      }}
      styles={{
        content: { borderStartStartRadius: 16, borderStartEndRadius: 16, overflow: 'hidden' },
        body: { overflowX: 'hidden', overflowY: 'auto', padding: 16 },
        footer: { padding: '12px 16px' },
      }}
      footer={resolvedFooter}
    >
      {children}
    </Drawer>
  );
}
