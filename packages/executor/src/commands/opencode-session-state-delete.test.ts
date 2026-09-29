import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createExecutorClient: vi.fn(),
  deleteOpenCodeSessionStateInWorker: vi.fn(),
  resolveOpenCodeNativeStateLayout: vi.fn(),
}));

vi.mock('@agor/agentic-tool-opencode/runtime', () => ({
  deleteOpenCodeSessionStateInWorker: mocks.deleteOpenCodeSessionStateInWorker,
  resolveOpenCodeNativeStateLayout: mocks.resolveOpenCodeNativeStateLayout,
}));
vi.mock('../services/feathers-client.js', () => ({
  createExecutorClient: mocks.createExecutorClient,
}));

import { handleOpenCodeSessionStateDelete } from './opencode-session-state-delete.js';

const payload = {
  command: 'opencode.session-state-delete' as const,
  sessionToken: 'scoped-command-token',
  daemonUrl: 'http://daemon.invalid',
  params: {
    branchId: '00000000-0000-7000-8000-000000000001',
    tenantId: 'tenant-a',
    sessionId: '00000000-0000-7000-8000-000000000002',
    operationId: '00000000-0000-7000-8000-000000000003',
  },
};

describe('OpenCode Session deletion command', () => {
  const client = {
    io: { close: vi.fn() },
    service: vi.fn(),
  };
  const prepareSessionDeleteCommand = vi.fn();
  const acknowledgeSessionDelete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('AGOR_CLOUD_EXECUTOR_RUN_ID', 'reserved-delete-run');
    client.service.mockReturnValue({
      prepareSessionDeleteCommand,
      acknowledgeSessionDelete,
    });
    mocks.createExecutorClient.mockResolvedValue(client);
    mocks.resolveOpenCodeNativeStateLayout.mockReturnValue('/mounted/session-root');
    mocks.deleteOpenCodeSessionStateInWorker.mockResolvedValue({ outcome: 'deleted' });
    prepareSessionDeleteCommand.mockResolvedValue({
      namespace_key: 'ns-a',
      store_id: '00000000-0000-7000-8000-000000000004',
      files: [
        {
          attempt_id: '00000000-0000-7000-8000-000000000005',
          store_id: '00000000-0000-7000-8000-000000000004',
          task_id: '00000000-0000-7000-8000-000000000006',
        },
      ],
    });
    acknowledgeSessionDelete.mockResolvedValue(undefined);
  });

  it('deletes only the prepared Session leaves and acknowledges the exact operation', async () => {
    const result = await handleOpenCodeSessionStateDelete(payload, { dryRun: false });

    expect(result).toMatchObject({
      success: true,
      data: {
        sessionId: payload.params.sessionId,
        operationId: payload.params.operationId,
        outcome: 'deleted',
      },
    });
    expect(mocks.createExecutorClient).toHaveBeenCalledWith(
      payload.daemonUrl,
      payload.sessionToken
    );
    expect(prepareSessionDeleteCommand).toHaveBeenCalledWith({
      session_id: payload.params.sessionId,
      operation_id: payload.params.operationId,
      run_id: 'reserved-delete-run',
    });
    expect(mocks.resolveOpenCodeNativeStateLayout).toHaveBeenCalledWith({
      namespaceKey: 'ns-a',
      agorSessionId: payload.params.sessionId,
      taskId: payload.params.operationId,
      storeId: '00000000-0000-7000-8000-000000000004',
    });
    expect(mocks.deleteOpenCodeSessionStateInWorker).toHaveBeenCalledWith('/mounted/session-root', [
      {
        storeId: '00000000-0000-7000-8000-000000000004',
        taskId: '00000000-0000-7000-8000-000000000006',
      },
    ]);
    expect(acknowledgeSessionDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: payload.params.sessionId,
        operation_id: payload.params.operationId,
        run_id: 'reserved-delete-run',
        files: [
          {
            attempt_id: '00000000-0000-7000-8000-000000000005',
            store_id: '00000000-0000-7000-8000-000000000004',
            task_id: '00000000-0000-7000-8000-000000000006',
          },
        ],
        result: { outcome: 'deleted' },
      })
    );
    expect(client.io.close).toHaveBeenCalledOnce();
  });

  it('records an unsuccessful file proof without reporting deletion success', async () => {
    mocks.deleteOpenCodeSessionStateInWorker.mockResolvedValue({
      outcome: 'failed',
      errorCode: 'UNKNOWN_ENTRY',
    });

    const result = await handleOpenCodeSessionStateDelete(payload, { dryRun: false });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'SESSION_STATE_DELETE_FAILED' },
    });
    expect(acknowledgeSessionDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: payload.params.sessionId,
        operation_id: payload.params.operationId,
        run_id: 'reserved-delete-run',
        result: { outcome: 'failed', error_code: 'UNKNOWN_ENTRY' },
      })
    );
    expect(client.io.close).toHaveBeenCalledOnce();
  });

  it('does not contact the daemon or delete files in dry-run mode', async () => {
    await expect(
      handleOpenCodeSessionStateDelete(payload, { dryRun: true })
    ).resolves.toMatchObject({
      success: false,
      error: { code: 'DELETE_PREVIEW_UNSUPPORTED' },
    });
    expect(mocks.createExecutorClient).not.toHaveBeenCalled();
    expect(mocks.deleteOpenCodeSessionStateInWorker).not.toHaveBeenCalled();
  });
});
