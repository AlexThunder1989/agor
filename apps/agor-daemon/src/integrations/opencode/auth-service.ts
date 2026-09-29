import type { OpenCodeApiEntry } from '@agor/agentic-tool-opencode';
import {
  createOpenCodeHostedProviderDiscovery,
  createOpenCodeModelCatalog,
  LEGACY_OPENCODE_PROVIDER_FIELDS,
  OPENCODE_VERSION,
  openCodeProviderEntryField,
  parseOpenCodeApiEntry,
  validateOpenCodeApiEntry,
} from '@agor/agentic-tool-opencode';
import { resolveOpenCodeCapabilities } from '@agor/agentic-tool-opencode/daemon';
import type { AgorConfig } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { runWithTenantDatabaseScope, UsersRepository } from '@agor/core/db';
import { BadRequest, NotAuthenticated, NotFound } from '@agor/core/feathers';
import type {
  AgenticToolsUpdate,
  AuthenticatedParams,
  DeepReadonly,
  OpenCodeOAuthAttempt,
  OpenCodeOAuthAttemptPatch,
  OpenCodeOAuthConnectRequest,
  OpenCodeProviderCatalogArtifact,
  OpenCodeProviderDiscovery,
  OpenCodeProviderSettings,
} from '@agor/core/types';
import { resolveOpenCodeConfigurationDirectory } from './configuration-scope.js';
import {
  type AuthenticatedOpenCodeSubjectContext,
  type ManagedOpenCodeSubject,
  resolveAuthenticatedOpenCodeSubjectContext,
  resolveManagedOpenCodeSubject,
} from './credential-namespace.js';
import { startOpenCodeExecutorInvocation } from './executor-command.js';
import {
  blockOpenCodeNativeStateNamespace,
  inOpenCodeNativeStateMutationSlot,
  type OpenCodeNativeStateMutationFence,
} from './native-state-coordinator.js';
import { type OpenCodeOAuthExecutorHandle, startOpenCodeOAuthExecutor } from './oauth-executor.js';
import {
  OPEN_CODE_CATALOG_UNAVAILABLE,
  readManagedOpenCodeProviderCatalog,
} from './provider-catalog.js';

function assertOptionalStringRecord(
  value: unknown
): asserts value is Record<string, string> | undefined {
  if (
    value !== undefined &&
    (!value ||
      Array.isArray(value) ||
      typeof value !== 'object' ||
      Object.values(value).some((entry) => typeof entry !== 'string'))
  ) {
    throw new BadRequest('Provider prompt values must be strings.');
  }
}

type StoredOAuthAttempt = OpenCodeOAuthAttempt & {
  namespaceKey: string;
  handle?: OpenCodeOAuthExecutorHandle;
  attachment?: Promise<void>;
  cancelRequested: boolean;
  ready: Promise<void>;
  resolveReady: () => void;
};

const oauthAttempts = new Map<string, StoredOAuthAttempt>();
const OAUTH_TIMEOUT_MS = 10 * 60_000;
const OAUTH_TERMINAL_RETENTION_MS = 10 * 60_000;

type ValidatedOAuthRequest = {
  providerId: string;
  method: number;
  inputs?: Record<string, string>;
};

function validateOAuthRequest(data: OpenCodeOAuthConnectRequest): ValidatedOAuthRequest {
  const supportedFields = new Set(['operation', 'providerId', 'method', 'inputs']);
  const unsupported = Object.keys(data).find((field) => !supportedFields.has(field));
  if (unsupported) throw new BadRequest(`Unsupported field: ${unsupported}`);

  const providerId = data.providerId?.trim();
  if (!providerId || !Number.isInteger(data.method) || data.method < 0) {
    throw new BadRequest('Provider and OAuth method are required.');
  }
  assertOptionalStringRecord(data.inputs);
  return { providerId, method: data.method, inputs: data.inputs };
}

function createOAuthAttempt(providerId: string, namespaceKey: string): StoredOAuthAttempt {
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  return {
    attemptId: crypto.randomUUID(),
    providerId,
    phase: 'authorizing',
    expiresAt: new Date(Date.now() + OAUTH_TIMEOUT_MS).toISOString(),
    namespaceKey,
    cancelRequested: false,
    ready,
    resolveReady,
  };
}

function isTerminalAttempt(attempt: StoredOAuthAttempt): boolean {
  return ['configured', 'cancelled', 'expired', 'failed'].includes(attempt.phase);
}

function scheduleAttemptPrune(attempt: StoredOAuthAttempt): void {
  const timer = setTimeout(() => {
    if (oauthAttempts.get(attempt.attemptId) === attempt) {
      oauthAttempts.delete(attempt.attemptId);
    }
  }, OAUTH_TERMINAL_RETENTION_MS);
  timer.unref();
}

/** Host surface the managed authority needs: the users service for encrypted per-tool patches. */
type UsersPatchHost = {
  service(path: 'users'): {
    patch(
      id: string,
      data: { agentic_tools: AgenticToolsUpdate },
      params?: AuthenticatedParams
    ): Promise<unknown>;
  };
};

export class OpenCodeAuthService {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly config: DeepReadonly<AgorConfig>,
    private readonly host?: UsersPatchHost,
    private readonly agorVersion?: string,
    private readonly readProviderCatalog: (
      version?: string
    ) => Promise<OpenCodeProviderCatalogArtifact> = readManagedOpenCodeProviderCatalog
  ) {}

  private credentialContext(
    params?: AuthenticatedParams
  ): Promise<AuthenticatedOpenCodeSubjectContext> {
    return resolveAuthenticatedOpenCodeSubjectContext(this.db, this.config, params);
  }

  /** Hosted settings are projected from the package's pinned OpenCode artifact. */
  private managedSettings(
    subject: ManagedOpenCodeSubject,
    artifact: OpenCodeProviderCatalogArtifact,
    savedEndpoints: ReadonlyMap<string, string>
  ): OpenCodeProviderSettings {
    return {
      runtime: 'available',
      runtimeVersion: OPENCODE_VERSION,
      ...createOpenCodeHostedProviderDiscovery(artifact, subject.savedProviderIds, savedEndpoints),
      isolation: { mode: 'managed-projection', boundary: 'executor-run' },
    };
  }

  /**
   * Save or clear one reviewed provider key through the users service, which
   * owns encryption-at-rest and self-only authority for the credential bucket.
   */
  private async patchManagedEntry(
    subject: ManagedOpenCodeSubject,
    providerId: string,
    entry: OpenCodeApiEntry | null,
    artifact: OpenCodeProviderCatalogArtifact | undefined,
    params?: AuthenticatedParams
  ): Promise<void> {
    if (!this.host) throw new BadRequest('OpenCode credential storage is not available.');
    if (
      entry &&
      (!artifact ||
        !createOpenCodeModelCatalog(artifact, new Set([providerId])).providers.some(
          (provider) => provider.id === providerId && provider.apiAuthAvailable
        ))
    ) {
      throw new BadRequest('That provider is not available for hosted API-key authentication.');
    }
    if (entry === null && !subject.savedProviderIds.has(providerId)) {
      throw new BadRequest('No saved OpenCode credential exists for that provider.');
    }
    // Self-patch under the caller's own authority; the users service rejects
    // any other target. Query params from this request must not leak through.
    const { query: _query, ...callerParams } = (params ?? {}) as AuthenticatedParams & {
      query?: unknown;
    };
    const field = openCodeProviderEntryField(providerId);
    const legacyField =
      LEGACY_OPENCODE_PROVIDER_FIELDS[providerId as keyof typeof LEGACY_OPENCODE_PROVIDER_FIELDS];
    await this.host.service('users').patch(
      subject.subjectUserId,
      {
        agentic_tools: {
          opencode: {
            [field]: entry === null ? null : JSON.stringify(entry),
            ...(legacyField ? { [legacyField]: null } : {}),
          },
        },
      },
      callerParams as AuthenticatedParams
    );
  }

  private async managedEndpoints(subject: ManagedOpenCodeSubject): Promise<Map<string, string>> {
    return runWithTenantDatabaseScope(this.db, subject.tenantId, async (tenantDb) => {
      const repo = new UsersRepository(tenantDb);
      const endpoints = new Map<string, string>();
      for (const providerId of subject.savedProviderIds) {
        const field = openCodeProviderEntryField(providerId);
        const result = await repo.getToolConfigFieldResult(
          subject.subjectUserId,
          'opencode',
          field
        );
        if (!result.value || result.decryptionFailed) continue;
        try {
          const entry = parseOpenCodeApiEntry(result.value);
          if (entry.endpoint) endpoints.set(providerId, entry.endpoint);
        } catch {
          // Presence remains observable even when a value needs re-entry.
        }
      }
      return endpoints;
    });
  }

  private async execute(
    context: AuthenticatedOpenCodeSubjectContext,
    params:
      | { operation: 'discover'; directory?: string }
      | {
          operation: 'connect-api-key';
          providerId: string;
          apiKey: string;
          metadata?: Record<string, string>;
        }
      | { operation: 'disconnect'; providerId: string },
    mutationFence?: OpenCodeNativeStateMutationFence
  ): Promise<OpenCodeProviderDiscovery> {
    const handle = startOpenCodeExecutorInvocation(context.dataHome, params, {
      env: context.executorEnv,
      logPrefix: '[OpenCode Auth]',
    });
    if (mutationFence) await mutationFence.attach(handle);
    const result = await handle.result;
    if (!mutationFence && result.error?.code === 'EXECUTOR_CLEANUP_UNVERIFIED') {
      await blockOpenCodeNativeStateNamespace(context.namespaceKey, handle);
    }
    if (!result.success || !result.data) {
      throw new BadRequest('OpenCode provider operation failed. Try again.');
    }
    return result.data as OpenCodeProviderDiscovery;
  }

  private settings(
    context: AuthenticatedOpenCodeSubjectContext,
    discovery: OpenCodeProviderDiscovery
  ): OpenCodeProviderSettings {
    return {
      ...discovery,
      isolation: {
        mode: context.mode,
        boundary: 'logical',
      },
    };
  }

  async find(
    params?: AuthenticatedParams & { query?: { branch_id?: unknown } }
  ): Promise<OpenCodeProviderSettings> {
    if (!params?.user?.user_id) throw new NotAuthenticated('Sign in before using OpenCode.');
    // A deployment that cannot run OpenCode answers with a structured,
    // permanent reason instead of an error the UI would offer to retry.
    const capabilities = resolveOpenCodeCapabilities(this.config);
    if (capabilities.mode === 'unsupported') {
      return {
        runtime: 'unsupported',
        runtimeVersion: OPENCODE_VERSION,
        unsupported: capabilities.reason,
        providers: [],
      };
    }
    if (capabilities.mode === 'managed-projection') {
      if (params?.query && Object.keys(params.query).length > 0) {
        throw new BadRequest('Hosted OpenCode settings do not accept branch discovery.');
      }
      const subject = await resolveManagedOpenCodeSubject(this.db, params);
      try {
        const artifact = await this.readProviderCatalog(this.agorVersion);
        return this.managedSettings(subject, artifact, await this.managedEndpoints(subject));
      } catch {
        return {
          runtime: 'unsupported',
          runtimeVersion: OPENCODE_VERSION,
          unsupported: OPEN_CODE_CATALOG_UNAVAILABLE,
          providers: [],
        };
      }
    }
    const context = await resolveAuthenticatedOpenCodeSubjectContext(this.db, this.config, params);
    const directory = await resolveOpenCodeConfigurationDirectory({
      db: this.db,
      context,
      config: this.config,
      params,
    });
    const result = await this.execute(context, {
      operation: 'discover',
      ...(directory ? { directory } : {}),
    });
    return this.settings(context, result);
  }

  async create(
    data:
      | {
          providerId?: string;
          apiKey?: string;
          metadata?: Record<string, string>;
          baseURL?: string;
          type?: string;
        }
      | OpenCodeOAuthConnectRequest,
    params?: AuthenticatedParams
  ): Promise<OpenCodeProviderSettings | OpenCodeOAuthAttempt> {
    if ('operation' in data) {
      return this.startOAuth(data, params);
    }
    const unsupported = Object.keys(data ?? {}).find(
      (field) => !['providerId', 'apiKey', 'metadata', 'baseURL', 'type'].includes(field)
    );
    if (unsupported) throw new BadRequest(`Unsupported field: ${unsupported}`);
    if (data.type !== undefined && data.type !== 'api') {
      throw new BadRequest('Only API provider entries are supported.');
    }
    const providerId = data?.providerId?.trim();
    const apiKey = data?.apiKey?.trim();
    if (!providerId || !apiKey) throw new BadRequest('Provider and API key are required.');
    const metadata = data.metadata;
    assertOptionalStringRecord(metadata);

    if (resolveOpenCodeCapabilities(this.config).mode === 'managed-projection') {
      let entry: OpenCodeApiEntry;
      try {
        entry = validateOpenCodeApiEntry({
          type: data.type ?? 'api',
          key: apiKey,
          ...(metadata ? { metadata } : {}),
          ...(data.baseURL ? { endpoint: data.baseURL } : {}),
        });
      } catch (error) {
        throw new BadRequest(error instanceof Error ? error.message : 'Provider entry is invalid.');
      }
      const subject = await resolveManagedOpenCodeSubject(this.db, params);
      let artifact: OpenCodeProviderCatalogArtifact;
      try {
        artifact = await this.readProviderCatalog(this.agorVersion);
      } catch {
        throw new BadRequest(OPEN_CODE_CATALOG_UNAVAILABLE.message);
      }
      await this.patchManagedEntry(subject, providerId, entry, artifact, params);
      const updated = {
        ...subject,
        savedProviderIds: new Set([...subject.savedProviderIds, providerId]),
      };
      return this.managedSettings(updated, artifact, await this.managedEndpoints(updated));
    }
    if (data.baseURL !== undefined) {
      throw new BadRequest('Provider endpoints are only supported for hosted OpenCode.');
    }

    const context = await this.credentialContext(params);
    const result = await inOpenCodeNativeStateMutationSlot(context.namespaceKey, (fence) =>
      this.execute(context, { operation: 'connect-api-key', providerId, apiKey, metadata }, fence)
    );
    return this.settings(context, result);
  }

  private publicAttempt(attempt: StoredOAuthAttempt): OpenCodeOAuthAttempt {
    const { attemptId, providerId, phase, authorization, expiresAt, settings } = attempt;
    return {
      attemptId,
      providerId,
      phase,
      expiresAt,
      ...(authorization ? { authorization } : {}),
      ...(settings ? { settings } : {}),
    };
  }

  private settleAttempt(
    attempt: StoredOAuthAttempt,
    result: Awaited<OpenCodeOAuthExecutorHandle['result']>,
    context: AuthenticatedOpenCodeSubjectContext
  ): void {
    if (isTerminalAttempt(attempt)) return;
    if (result.success && result.data) {
      const discovery = result.data as OpenCodeProviderDiscovery;
      const savedCredentialPresent = discovery.providers.some(
        (provider) =>
          provider.id === attempt.providerId && provider.credentialPresence === 'present'
      );
      if (savedCredentialPresent) {
        attempt.settings = this.settings(context, discovery);
        attempt.phase = 'configured';
      } else {
        attempt.phase = 'failed';
      }
    } else if (result.error?.code === 'OPENCODE_OAUTH_TIMEOUT') {
      attempt.phase = 'expired';
    } else if (result.error?.code === 'OPENCODE_OAUTH_CANCELLED') {
      attempt.phase = 'cancelled';
    } else {
      attempt.phase = 'failed';
    }
    attempt.resolveReady();
  }

  private async ownedAttempt(
    id: string,
    params?: AuthenticatedParams
  ): Promise<StoredOAuthAttempt> {
    const context = await this.credentialContext(params);
    const attempt = oauthAttempts.get(id);
    if (!attempt || attempt.namespaceKey !== context.namespaceKey) {
      throw new NotFound('OpenCode OAuth attempt was not found.');
    }
    return attempt;
  }

  private async runOAuthAttempt(
    attempt: StoredOAuthAttempt,
    context: AuthenticatedOpenCodeSubjectContext,
    request: ValidatedOAuthRequest
  ): Promise<void> {
    await inOpenCodeNativeStateMutationSlot(context.namespaceKey, async (fence) => {
      if (attempt.cancelRequested) {
        await fence.releaseWithoutWriter();
        attempt.phase = 'cancelled';
        attempt.resolveReady();
        scheduleAttemptPrune(attempt);
        return;
      }
      const handle = startOpenCodeOAuthExecutor(
        context.dataHome,
        {
          operation: 'connect-oauth',
          providerId: request.providerId,
          method: request.method,
          ...(request.inputs && Object.keys(request.inputs).length > 0
            ? { inputs: request.inputs }
            : {}),
        },
        {
          env: context.executorEnv,
          logPrefix: '[OpenCode Auth]',
          timeoutMs: OAUTH_TIMEOUT_MS,
        },
        (event) => {
          if (attempt.cancelRequested) return;
          if (event.type === 'authorized') {
            attempt.authorization = event.authorization;
            attempt.phase = 'awaiting_callback';
            attempt.resolveReady();
            return;
          }
          attempt.phase = 'completing';
        }
      );
      attempt.handle = handle;
      const attachment = fence.attach(handle);
      attempt.attachment = attachment;
      await attachment;
      if (attempt.cancelRequested) await handle.cancel();

      const result = await handle.result;
      this.settleAttempt(attempt, result, context);
      scheduleAttemptPrune(attempt);
    });
  }

  private failOAuthAttempt(attempt: StoredOAuthAttempt): void {
    if (!attempt.cancelRequested) attempt.phase = 'failed';
    attempt.resolveReady();
    scheduleAttemptPrune(attempt);
  }

  private async startOAuth(
    data: OpenCodeOAuthConnectRequest,
    params?: AuthenticatedParams
  ): Promise<OpenCodeOAuthAttempt> {
    if (resolveOpenCodeCapabilities(this.config).mode === 'managed-projection') {
      throw new BadRequest('Hosted OpenCode does not support OAuth sign-in.');
    }
    const request = validateOAuthRequest(data);
    const context = await this.credentialContext(params);
    const attempt = createOAuthAttempt(request.providerId, context.namespaceKey);
    oauthAttempts.set(attempt.attemptId, attempt);

    void this.runOAuthAttempt(attempt, context, request).catch(() =>
      this.failOAuthAttempt(attempt)
    );

    await attempt.ready;
    return this.publicAttempt(attempt);
  }

  async get(id: string, params?: AuthenticatedParams): Promise<OpenCodeOAuthAttempt> {
    return this.publicAttempt(await this.ownedAttempt(id, params));
  }

  private async submitOAuthCode(
    attempt: StoredOAuthAttempt,
    data: { code: string },
    params?: AuthenticatedParams
  ): Promise<OpenCodeOAuthAttempt> {
    if (Object.keys(data).some((field) => field !== 'code')) {
      throw new BadRequest('Unsupported OAuth callback field.');
    }
    const code = data.code?.trim();
    if (
      !code ||
      attempt.phase !== 'awaiting_callback' ||
      attempt.authorization?.method !== 'code' ||
      !attempt.handle
    ) {
      throw new BadRequest('This OAuth attempt is not awaiting a code.');
    }
    if (!(await attempt.handle.submitCode(code))) {
      throw new BadRequest('This OAuth attempt no longer accepts a code.');
    }
    if (attempt.cancelRequested) {
      this.settleAttempt(
        attempt,
        await attempt.handle.result,
        await this.credentialContext(params)
      );
      return this.publicAttempt(attempt);
    }
    attempt.phase = 'completing';
    return this.publicAttempt(attempt);
  }

  private async cancelOAuthAttempt(
    attempt: StoredOAuthAttempt,
    data: { cancel: true },
    params?: AuthenticatedParams
  ): Promise<OpenCodeOAuthAttempt> {
    if (data.cancel !== true || Object.keys(data).some((field) => field !== 'cancel')) {
      throw new BadRequest('Only OAuth cancellation or code submission is supported.');
    }
    attempt.cancelRequested = true;
    if (!attempt.handle) {
      attempt.phase = 'cancelled';
      attempt.resolveReady();
      return this.publicAttempt(attempt);
    }
    await attempt.attachment?.catch(() => undefined);
    const result = await attempt.handle.cancel();
    this.settleAttempt(attempt, result, await this.credentialContext(params));
    return this.publicAttempt(attempt);
  }

  async patch(
    id: string,
    data: OpenCodeOAuthAttemptPatch,
    params?: AuthenticatedParams
  ): Promise<OpenCodeOAuthAttempt> {
    const attempt = await this.ownedAttempt(id, params);
    if (isTerminalAttempt(attempt)) return this.publicAttempt(attempt);
    if ('code' in data) {
      return this.submitOAuthCode(attempt, data, params);
    }
    return this.cancelOAuthAttempt(attempt, data, params);
  }

  async remove(id: string, params?: AuthenticatedParams): Promise<OpenCodeProviderSettings> {
    const providerId = id?.trim();
    if (!providerId) throw new BadRequest('Provider is required.');
    if (resolveOpenCodeCapabilities(this.config).mode === 'managed-projection') {
      const subject = await resolveManagedOpenCodeSubject(this.db, params);
      let artifact: OpenCodeProviderCatalogArtifact | undefined;
      try {
        artifact = await this.readProviderCatalog(this.agorVersion);
      } catch {
        artifact = undefined;
      }
      await this.patchManagedEntry(subject, providerId, null, artifact, params);
      const updated = {
        ...subject,
        savedProviderIds: new Set([...subject.savedProviderIds].filter((id) => id !== providerId)),
      };
      if (!artifact) {
        return {
          runtime: 'unsupported',
          runtimeVersion: OPENCODE_VERSION,
          unsupported: OPEN_CODE_CATALOG_UNAVAILABLE,
          providers: [],
        };
      }
      return this.managedSettings(updated, artifact, await this.managedEndpoints(updated));
    }
    const context = await this.credentialContext(params);
    const result = await inOpenCodeNativeStateMutationSlot(context.namespaceKey, (fence) =>
      this.execute(context, { operation: 'disconnect', providerId }, fence)
    );
    return this.settings(context, result);
  }
}

export function createOpenCodeAuthService(
  db: TenantScopeAwareDatabase,
  config: DeepReadonly<AgorConfig>,
  host?: UsersPatchHost,
  agorVersion?: string,
  readProviderCatalog?: (version?: string) => Promise<OpenCodeProviderCatalogArtifact>
) {
  return new OpenCodeAuthService(db, config, host, agorVersion, readProviderCatalog);
}
