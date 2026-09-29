import {
  deleteOpenCodeSessionStateInWorker,
  resolveOpenCodeNativeStateLayout,
} from '@agor/agentic-tool-opencode/runtime';
import type { OpenCodeNativeStateService } from '@agor/core/api';
import { OPENCODE_CHECKPOINT_CLOUD_ENV } from '@agor/core/types';
import type { ExecutorResult, OpenCodeSessionStateDeletePayload } from '../payload-types.js';
import { createExecutorClient } from '../services/feathers-client.js';
import type { CommandOptions } from './index.js';

export async function handleOpenCodeSessionStateDelete(
  payload: OpenCodeSessionStateDeletePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) {
    return {
      success: false,
      error: {
        code: 'DELETE_PREVIEW_UNSUPPORTED',
        message: 'Session deletion has no file preview',
      },
    };
  }
  const { sessionId, operationId } = payload.params;
  const client = await createExecutorClient(payload.daemonUrl, payload.sessionToken);
  try {
    const runId = process.env[OPENCODE_CHECKPOINT_CLOUD_ENV.runId];
    if (!runId) throw new Error('Missing reserved delete run identity');
    const service = client.service('opencode-native-state') as OpenCodeNativeStateService;
    const work = await service.prepareSessionDeleteCommand({
      session_id: sessionId,
      operation_id: operationId,
      run_id: runId,
    });
    if (work.files.some((file) => file.store_id !== work.store_id)) {
      throw new Error('checkpoint store mismatch');
    }
    const layout = resolveOpenCodeNativeStateLayout({
      namespaceKey: work.namespace_key,
      agorSessionId: sessionId,
      // The operation identity is only a Job-local path component here; it is
      // never presented as or authorized like a Task.
      taskId: operationId,
      storeId: work.store_id,
    });
    const result = await deleteOpenCodeSessionStateInWorker(
      layout,
      work.files.map((file) => ({ storeId: file.store_id, taskId: file.task_id }))
    );
    await service.acknowledgeSessionDelete({
      session_id: sessionId,
      operation_id: operationId,
      run_id: runId,
      files: work.files,
      result:
        result.outcome === 'deleted'
          ? { outcome: 'deleted' }
          : { outcome: 'failed', error_code: result.errorCode },
    });
    return result.outcome === 'deleted'
      ? { success: true, data: { sessionId, operationId, outcome: 'deleted' } }
      : {
          success: false,
          error: {
            code: 'SESSION_STATE_DELETE_FAILED',
            message: 'OpenCode Session files could not be proven empty; state remains fenced',
          },
        };
  } catch {
    return {
      success: false,
      error: {
        code: 'SESSION_STATE_DELETE_UNKNOWN',
        message: `OpenCode Session ${sessionId} deletion is pending; retry the ordinary remove operation`,
      },
    };
  } finally {
    client.io.close();
  }
}
