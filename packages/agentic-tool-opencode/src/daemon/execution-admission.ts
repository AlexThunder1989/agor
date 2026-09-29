import type { AgorConfig } from '@agor/core/config';
import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import { requireOpenCodeMode, resolveOpenCodeCapabilities } from './capabilities.js';

export function assertOpenCodeExecutionAllowed(input: {
  tenantId: string | undefined;
  config: Pick<AgorConfig, 'execution' | 'multi_tenancy' | 'agentic_tools'>;
  sessionOwnerId: string;
  sessionScope: 'execution_home' | 'branch';
  prompterUserId: string | undefined;
}): void {
  if (!input.tenantId) {
    throw new NotAuthenticated('Missing tenant context for OpenCode execution');
  }
  // Execution admits only the modes whose launch path exists in this build;
  // the resolver reports every other topology with a structured reason.
  const capabilities = resolveOpenCodeCapabilities(input.config);
  requireOpenCodeMode(capabilities, ['native-file', 'managed-projection'], 'execution');
  if (!input.prompterUserId) {
    throw new NotAuthenticated('Missing prompt actor for OpenCode execution');
  }
  // A managed checkpoint is keyed by Session, while its Task binding and
  // credentials retain the caller actor. Local native-file state has no such
  // split and therefore remains execution-home/owner-bound only.
  if (input.sessionScope === 'execution_home' && input.prompterUserId !== input.sessionOwnerId) {
    throw new Forbidden('Only the OpenCode session owner can prompt this session.');
  }
  if (input.sessionScope === 'branch' && capabilities.mode !== 'managed-projection') {
    throw new Forbidden('Branch-scoped OpenCode prompts require managed Session state.');
  }
}
