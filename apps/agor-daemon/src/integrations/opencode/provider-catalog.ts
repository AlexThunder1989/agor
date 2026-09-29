import { OPENCODE_VERSION, openCodeArtifactUnavailableReason } from '@agor/agentic-tool-opencode';
import { resolveManagedAgenticToolIntegration } from '@agor/core/agentic-integrations';
import type { OpenCodeProviderCatalogArtifact } from '@agor/core/types';

export const OPEN_CODE_CATALOG_UNAVAILABLE = openCodeArtifactUnavailableReason();

export async function readManagedOpenCodeProviderCatalog(
  agorVersion?: string
): Promise<OpenCodeProviderCatalogArtifact> {
  const version = agorVersion ?? process.env.AGOR_VERSION ?? process.env.AGOR_INTEGRATION_VERSION;
  if (!version) throw new Error(OPEN_CODE_CATALOG_UNAVAILABLE.message);
  const integration = await resolveManagedAgenticToolIntegration('opencode', version);
  if (
    integration.AGOR_INTEGRATION_VERSION !== version ||
    typeof integration.readProviderCatalog !== 'function'
  ) {
    throw new Error(OPEN_CODE_CATALOG_UNAVAILABLE.message);
  }
  const value = await integration.readProviderCatalog();
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    (value as { runtimeVersion?: unknown }).runtimeVersion !== OPENCODE_VERSION ||
    !Array.isArray((value as { providers?: unknown }).providers) ||
    !Array.isArray((value as { connected?: unknown }).connected)
  ) {
    throw new Error(OPEN_CODE_CATALOG_UNAVAILABLE.message);
  }
  return value as OpenCodeProviderCatalogArtifact;
}
