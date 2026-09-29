import type {
  OpenCodeModelCatalog,
  OpenCodeProviderCatalogArtifact,
  OpenCodeProviderConnection,
  OpenCodeProviderDiscovery,
} from '@agor/core/types';
import { OPENCODE_VERSION } from './version.js';

export { OPENCODE_VERSION } from './version.js';

/** The only static names retained are the three pre-revision-7 storage aliases. */
export const LEGACY_OPENCODE_PROVIDER_FIELDS = Object.freeze({
  anthropic: 'OPENCODE_API_KEY_ANTHROPIC',
  openai: 'OPENCODE_API_KEY_OPENAI',
  'kimi-for-coding': 'OPENCODE_API_KEY_KIMI_FOR_CODING',
} as const);

const ENTRY_FIELD_PREFIX = 'provider:';
const SAFE_METADATA_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_KEY_BYTES = 64 * 1024;
const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_VALUE_BYTES = 1024;
const utf8Size = (value: string) => new TextEncoder().encode(value).byteLength;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export type OpenCodeApiEntry = {
  type: 'api';
  key: string;
  metadata?: Record<string, string>;
  endpoint?: string;
};

export function openCodeProviderEntryField(providerId: string): string {
  return `${ENTRY_FIELD_PREFIX}${encodeURIComponent(providerId)}`;
}

export function openCodeProviderIdFromEntryField(field: string): string | undefined {
  if (!field.startsWith(ENTRY_FIELD_PREFIX)) return undefined;
  try {
    const providerId = decodeURIComponent(field.slice(ENTRY_FIELD_PREFIX.length));
    return providerId && openCodeProviderEntryField(providerId) === field ? providerId : undefined;
  } catch {
    return undefined;
  }
}

function assertSafeHttpsUrl(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute HTTPS URL without user information.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${field} must be an absolute HTTPS URL without user information.`);
  }
}

export function validateOpenCodeEndpoint(value: string): string {
  assertSafeHttpsUrl(value, 'Endpoint');
  return value;
}

function validateMetadata(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provider metadata must be a string map.');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_ENTRIES) {
    throw new Error(`Provider metadata may contain at most ${MAX_METADATA_ENTRIES} entries.`);
  }
  const metadata: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (typeof raw !== 'string' || utf8Size(raw) > MAX_METADATA_VALUE_BYTES) {
      throw new Error('Each provider metadata value must be a string of at most 1 KiB.');
    }
    if (hasControlCharacters(key) || hasControlCharacters(raw)) {
      throw new Error('Provider metadata must not contain control characters.');
    }
    if (raw.includes('://')) assertSafeHttpsUrl(raw, 'Provider metadata URL');
    else if (!SAFE_METADATA_TOKEN.test(raw)) {
      throw new Error('Provider metadata values must be safe tokens or HTTPS URLs.');
    }
    metadata[key] = raw;
  }
  return metadata;
}

export function validateOpenCodeApiEntry(value: unknown): OpenCodeApiEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provider entry must be an object.');
  }
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some((key) => !['type', 'key', 'metadata', 'endpoint'].includes(key))) {
    throw new Error('Provider entry contains unsupported fields.');
  }
  if (entry.type !== 'api') throw new Error('Only API provider entries are supported.');
  if (typeof entry.key !== 'string' || !entry.key.trim() || utf8Size(entry.key) > MAX_KEY_BYTES) {
    throw new Error('Provider key must be a non-empty string of at most 64 KiB.');
  }
  if (hasControlCharacters(entry.key)) {
    throw new Error('Provider key must not contain control characters.');
  }
  const metadata = validateMetadata(entry.metadata);
  let endpoint: string | undefined;
  if (entry.endpoint !== undefined) {
    if (typeof entry.endpoint !== 'string') throw new Error('Endpoint must be a string.');
    assertSafeHttpsUrl(entry.endpoint, 'Endpoint');
    endpoint = entry.endpoint;
  }
  return {
    type: 'api',
    key: entry.key,
    ...(metadata ? { metadata } : {}),
    ...(endpoint ? { endpoint } : {}),
  };
}

export function parseOpenCodeApiEntry(serialized: string): OpenCodeApiEntry {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('Provider entry is invalid. Re-enter it in Settings > OpenCode.');
  }
  try {
    return validateOpenCodeApiEntry(value);
  } catch {
    throw new Error('Provider entry is invalid. Re-enter it in Settings > OpenCode.');
  }
}

/** Revalidate the entry and serialize only OpenCode's auth.json fields. */
export function buildOpenCodeAuthContent(
  connection: Readonly<Record<string, string | undefined>>,
  providerId: string
): { content?: string; providerIds: string[]; secrets: string[]; endpoint?: string } {
  const field = openCodeProviderEntryField(providerId);
  const serialized = connection[field];
  let entry: OpenCodeApiEntry | undefined;
  if (serialized) {
    entry = parseOpenCodeApiEntry(serialized);
  } else {
    const legacyField =
      LEGACY_OPENCODE_PROVIDER_FIELDS[providerId as keyof typeof LEGACY_OPENCODE_PROVIDER_FIELDS];
    const legacyKey = legacyField ? connection[legacyField]?.trim() : undefined;
    if (legacyKey) entry = validateOpenCodeApiEntry({ type: 'api', key: legacyKey });
  }
  if (!entry) return { providerIds: [], secrets: [] };
  const authEntry = {
    type: 'api' as const,
    key: entry.key,
    ...(entry.metadata && Object.keys(entry.metadata).length ? { metadata: entry.metadata } : {}),
  };
  const content = JSON.stringify({ [providerId]: authEntry });
  return {
    content,
    providerIds: [providerId],
    secrets: [entry.key, content],
    ...(entry.endpoint ? { endpoint: entry.endpoint } : {}),
  };
}

export function hostedProviderIdsFromConnection(
  connection: Readonly<Record<string, string | boolean | undefined>>
): Set<string> {
  const saved = new Set<string>();
  for (const [field, value] of Object.entries(connection)) {
    if (value !== true && !(typeof value === 'string' && value.length > 0)) continue;
    const providerId = openCodeProviderIdFromEntryField(field);
    if (providerId) saved.add(providerId);
  }
  for (const [providerId, field] of Object.entries(LEGACY_OPENCODE_PROVIDER_FIELDS)) {
    const value = connection[field];
    if (value === true || (typeof value === 'string' && value.trim())) saved.add(providerId);
  }
  return saved;
}

function isValidArtifact(value: unknown): value is OpenCodeProviderCatalogArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const artifact = value as Partial<OpenCodeProviderCatalogArtifact>;
  return (
    artifact.schemaVersion === 1 &&
    artifact.runtimeVersion === OPENCODE_VERSION &&
    Array.isArray(artifact.connected) &&
    artifact.connected.every((id) => typeof id === 'string') &&
    Array.isArray(artifact.providers) &&
    artifact.providers.every(
      (provider) =>
        provider &&
        typeof provider.id === 'string' &&
        typeof provider.name === 'string' &&
        Array.isArray(provider.env) &&
        provider.env.every((name) => typeof name === 'string') &&
        Array.isArray(provider.models) &&
        Array.isArray(provider.authMethods)
    )
  );
}

function filteredProviders(artifact: OpenCodeProviderCatalogArtifact) {
  if (!isValidArtifact(artifact)) {
    throw new Error('OpenCode provider catalog is unavailable for this runtime version.');
  }
  const capturedConnected = new Set(artifact.connected);
  return artifact.providers.flatMap((provider) => {
    const models = provider.models.filter(
      (model) => model.status !== 'alpha' && model.status !== 'deprecated'
    );
    if (models.length === 0) return [];
    const authMethods = provider.authMethods.filter((method) => method.type === 'api');
    const defaultModel = models.some((model) => model.id === provider.defaultModel)
      ? provider.defaultModel
      : models[0]?.id;
    return [
      {
        ...provider,
        models,
        authMethods,
        defaultModel,
        allOAuth:
          provider.authMethods.length > 0 &&
          provider.authMethods.every((method) => method.type === 'oauth'),
        // Most OpenCode providers use the generic auth.json key shape and do
        // not contribute an interactive provider.auth() method. Only a
        // provider whose methods are exclusively OAuth is unavailable here.
        apiAuthAvailable: !(
          provider.authMethods.length > 0 &&
          provider.authMethods.every((method) => method.type === 'oauth')
        ),
        credentialFree: capturedConnected.has(provider.id),
      },
    ];
  });
}

function availability(provider: ReturnType<typeof filteredProviders>[number], saved: boolean) {
  if (provider.allOAuth) {
    return {
      available: false,
      unavailableReason: 'OpenCode OAuth sign-in is not available in hosted OpenCode.',
    };
  }
  if (provider.credentialFree && !saved) {
    return {
      available: false,
      unavailableReason: 'Credential-free providers require a saved API entry in hosted OpenCode.',
    };
  }
  return { available: true };
}

export function createOpenCodeModelCatalog(
  artifact: OpenCodeProviderCatalogArtifact,
  savedProviderIds: ReadonlySet<string>
): Omit<OpenCodeModelCatalog, 'runtimeVersion'> {
  const providers = filteredProviders(artifact);
  const catalogProviders = providers.map((provider) => {
    const state = availability(provider, savedProviderIds.has(provider.id));
    return {
      id: provider.id,
      name: provider.name,
      availableForSelection: state.available,
      apiAuthAvailable: provider.apiAuthAvailable,
      env: provider.env,
      ...(provider.defaultModel ? { suggestedModel: provider.defaultModel } : {}),
      models: provider.models,
    };
  });
  const suggested = catalogProviders.find(
    (provider) => provider.availableForSelection && provider.suggestedModel
  );
  return {
    ...(suggested?.suggestedModel
      ? { suggestedSelection: { providerId: suggested.id, modelId: suggested.suggestedModel } }
      : {}),
    providers: catalogProviders,
  };
}

/** Local catalog projection from the running OpenCode provider.list() response. */
export function createOpenCodeRuntimeModelCatalog(input: {
  providers: OpenCodeProviderCatalogArtifact['providers'];
  defaults: Record<string, string>;
  connected: readonly string[];
  savedProviderIds: ReadonlySet<string> | null;
}): OpenCodeModelCatalog {
  const connected = new Set(input.connected);
  const providers = input.providers.flatMap((provider) => {
    const models = provider.models.filter(
      (model) => model.status !== 'alpha' && model.status !== 'deprecated'
    );
    if (models.length === 0) return [];
    const suggestedModel = models.some((model) => model.id === input.defaults[provider.id])
      ? input.defaults[provider.id]
      : models[0]?.id;
    return [
      {
        id: provider.id,
        name: provider.name,
        availableForSelection:
          connected.has(provider.id) || input.savedProviderIds?.has(provider.id) === true,
        apiAuthAvailable: provider.authMethods.some((method) => method.type === 'api'),
        env: provider.env,
        ...(suggestedModel ? { suggestedModel } : {}),
        models,
      },
    ];
  });
  const suggested = providers.find((provider) => provider.availableForSelection);
  return {
    runtimeVersion: OPENCODE_VERSION,
    ...(suggested?.suggestedModel
      ? { suggestedSelection: { providerId: suggested.id, modelId: suggested.suggestedModel } }
      : {}),
    providers,
  };
}

export function createOpenCodeHostedProviderDiscovery(
  artifact: OpenCodeProviderCatalogArtifact,
  savedProviderIds: ReadonlySet<string>,
  savedEndpoints: ReadonlyMap<string, string> = new Map()
): Omit<OpenCodeProviderDiscovery, 'runtime' | 'runtimeVersion'> {
  const providers: OpenCodeProviderConnection[] = filteredProviders(artifact).map((provider) => {
    const saved = savedProviderIds.has(provider.id);
    const state = availability(provider, saved);
    return {
      id: provider.id,
      name: provider.name,
      runtimeAvailable: state.available,
      credentialPresence: saved ? 'present' : 'absent',
      apiAuthAvailable: provider.apiAuthAvailable,
      authMethods: provider.authMethods,
      ...(provider.defaultModel ? { suggestedModel: provider.defaultModel } : {}),
      ...(savedEndpoints.has(provider.id) ? { endpoint: savedEndpoints.get(provider.id) } : {}),
      ...(!state.available && state.unavailableReason
        ? { unavailableReason: state.unavailableReason }
        : {}),
      models: provider.models,
    };
  });
  const known = new Set(providers.map(({ id }) => id));
  for (const id of savedProviderIds) {
    if (known.has(id)) continue;
    providers.push({
      id,
      name: id,
      runtimeAvailable: false,
      credentialPresence: 'present',
      authMethods: [],
      unavailableReason: 'This saved provider is no longer in the hosted OpenCode catalog.',
      models: [],
    });
  }
  return { providers: providers.sort((left, right) => left.id.localeCompare(right.id)) };
}

export function openCodeArtifactUnavailableReason() {
  return {
    code: 'provider_catalog_unavailable' as const,
    message: 'The hosted OpenCode provider catalog is unavailable for this runtime version.',
  };
}
