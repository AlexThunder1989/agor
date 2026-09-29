import {
  createOpenCodeModelCatalog,
  OPENCODE_VERSION,
  openCodeArtifactUnavailableReason,
} from '@agor/agentic-tool-opencode';
import { resolveOpenCodeCapabilities } from '@agor/agentic-tool-opencode/daemon';
import type { AgorConfig } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  DeepReadonly,
  OpenCodeModelCatalog,
  OpenCodeProviderCatalogArtifact,
} from '@agor/core/types';
import type { ExecutorCommandResult } from '../../utils/spawn-executor.js';
import {
  resolveAuthenticatedOpenCodeSubjectContext,
  resolveManagedOpenCodeSubject,
} from './credential-namespace.js';
import { startOpenCodeExecutorInvocation } from './executor-command.js';
import { blockOpenCodeNativeStateNamespace } from './native-state-coordinator.js';
import { readManagedOpenCodeProviderCatalog } from './provider-catalog.js';

const MODEL_CATALOG_FAILURE = 'OpenCode model catalog could not be loaded. Try again.';
const OPEN_CODE_MODEL_STATUSES = new Set(['active', 'alpha', 'beta', 'deprecated']);

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOpenCodeModelCatalog(value: unknown): value is OpenCodeModelCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const catalog = value as Partial<OpenCodeModelCatalog>;
  if (!isString(catalog.runtimeVersion) || !Array.isArray(catalog.providers)) return false;
  if (
    catalog.suggestedSelection !== undefined &&
    (!catalog.suggestedSelection ||
      typeof catalog.suggestedSelection !== 'object' ||
      Array.isArray(catalog.suggestedSelection) ||
      !isString(catalog.suggestedSelection.providerId) ||
      !isString(catalog.suggestedSelection.modelId))
  ) {
    return false;
  }
  return catalog.providers.every(
    (provider) =>
      provider &&
      isString(provider.id) &&
      isString(provider.name) &&
      typeof provider.availableForSelection === 'boolean' &&
      (provider.suggestedModel === undefined || isString(provider.suggestedModel)) &&
      Array.isArray(provider.models) &&
      provider.models.every(
        (model) =>
          model &&
          isString(model.id) &&
          isString(model.name) &&
          OPEN_CODE_MODEL_STATUSES.has(model.status)
      )
  );
}

async function readModelCatalog(
  db: TenantScopeAwareDatabase,
  config: DeepReadonly<AgorConfig>,
  params?: AuthenticatedParams
): Promise<OpenCodeModelCatalog> {
  const context = await resolveAuthenticatedOpenCodeSubjectContext(db, config, params);
  let result: ExecutorCommandResult;
  try {
    const handle = startOpenCodeExecutorInvocation(
      context.dataHome,
      { operation: 'read-model-catalog' },
      {
        env: context.executorEnv,
        logPrefix: '[OpenCode Models]',
      }
    );
    result = await handle.result;
    if (result.error?.code === 'EXECUTOR_CLEANUP_UNVERIFIED') {
      await blockOpenCodeNativeStateNamespace(context.namespaceKey, handle);
    }
  } catch {
    throw new BadRequest(MODEL_CATALOG_FAILURE);
  }
  if (!result.success || !isOpenCodeModelCatalog(result.data)) {
    throw new BadRequest(MODEL_CATALOG_FAILURE);
  }
  return result.data;
}

export class OpenCodeModelsService {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly config: DeepReadonly<AgorConfig>,
    private readonly agorVersion?: string,
    private readonly readProviderCatalog: (
      version?: string
    ) => Promise<OpenCodeProviderCatalogArtifact> = readManagedOpenCodeProviderCatalog
  ) {}

  async find(params?: AuthenticatedParams): Promise<OpenCodeModelCatalog> {
    if (Object.keys(params?.query ?? {}).length > 0) {
      throw new BadRequest('OpenCode model catalog does not accept query parameters.');
    }
    if (!params?.user?.user_id) throw new NotAuthenticated('Sign in before using OpenCode.');
    // Unsupported deployments answer with the known catalog marked unavailable
    // plus the structured reason, so readiness renders a permanent notice
    // instead of retrying an operation that can never succeed here.
    const capabilities = resolveOpenCodeCapabilities(this.config);
    if (capabilities.mode === 'unsupported') {
      return {
        runtimeVersion: OPENCODE_VERSION,
        providers: [],
        unsupported: capabilities.reason,
      };
    }
    if (capabilities.mode === 'managed-projection') {
      // The installed build artifact is the catalog authority; no OpenCode
      // process or provider request is started for hosted settings.
      const subject = await resolveManagedOpenCodeSubject(this.db, params);
      let artifact: OpenCodeProviderCatalogArtifact;
      let catalog: ReturnType<typeof createOpenCodeModelCatalog>;
      try {
        artifact = await this.readProviderCatalog(this.agorVersion);
        catalog = createOpenCodeModelCatalog(artifact, subject.savedProviderIds);
      } catch {
        return {
          runtimeVersion: OPENCODE_VERSION,
          providers: [],
          unsupported: openCodeArtifactUnavailableReason(),
        };
      }
      const providers = [...catalog.providers];
      const known = new Set(providers.map(({ id }) => id));
      for (const id of subject.savedProviderIds) {
        if (!known.has(id)) {
          providers.push({
            id,
            name: id,
            availableForSelection: false,
            models: [],
          });
        }
      }
      return {
        runtimeVersion: OPENCODE_VERSION,
        ...catalog,
        providers,
      };
    }
    return readModelCatalog(this.db, this.config, params);
  }
}

export function createOpenCodeModelsService(
  db: TenantScopeAwareDatabase,
  config: DeepReadonly<AgorConfig>,
  agorVersion?: string,
  readProviderCatalog?: (version?: string) => Promise<OpenCodeProviderCatalogArtifact>
) {
  return new OpenCodeModelsService(db, config, agorVersion, readProviderCatalog);
}
