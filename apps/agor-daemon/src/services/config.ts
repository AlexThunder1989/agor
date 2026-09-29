/**
 * Config Service
 *
 * Narrow read-only runtime configuration resolver.
 *
 * This is not a config.yaml CRUD surface. It only resolves task-scoped
 * user/tenant credentials for trusted executors; deployment configuration is
 * operator-owned and immutable at runtime.
 */

import {
  createOpenCodeModelCatalog,
  LEGACY_OPENCODE_PROVIDER_FIELDS,
  openCodeProviderEntryField,
  parseOpenCodeApiEntry,
  validateOpenCodeApiEntry,
} from '@agor/agentic-tool-opencode';
import { TOOL_API_KEY_NAMES } from '@agor/agentic-tools';
import {
  type AgorConfig,
  type ApiKeyName,
  hasExactUserExecutorCredentialHome,
  resolveApiKey,
} from '@agor/core/config';
import {
  runWithTenantDatabaseScope,
  TaskRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import { type Application, BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import {
  type AgenticToolName,
  type AuthenticatedParams,
  type DeepReadonly,
  type OpenCodeProviderCatalogArtifact,
  type Params,
  PROVIDER_CONNECTION_FIELDS,
  type TaskID,
  type UserID,
} from '@agor/core/types';
import {
  authenticatedTaskExecutorRuntimeAuthority,
  authenticatedTaskExecutorRuntimeScope,
  matchesTaskExecutorRuntimeScope,
} from '../auth/executor-runtime-scope.js';
import {
  OPEN_CODE_CATALOG_UNAVAILABLE,
  readManagedOpenCodeProviderCatalog,
} from '../integrations/opencode/provider-catalog.js';
import type { ClaudeBackendOAuth } from './claude-backend-oauth.js';
import {
  resolveExecutionCredentialHome,
  sameExecutionCredentialHome,
} from './credential-home-identity.js';

interface ClaudeRuntimeCredentialResolverLike {
  resolve(
    tenantId: string,
    userId: UserID
  ): Promise<{ connection: { CLAUDE_CODE_OAUTH_TOKEN: string }; useNativeAuth: false }>;
}

const RESOLVABLE_API_KEY_NAMES: Record<ApiKeyName, true> = {
  ANTHROPIC_API_KEY: true,
  ANTHROPIC_AUTH_TOKEN: true,
  CLAUDE_CODE_OAUTH_TOKEN: true,
  OPENAI_API_KEY: true,
  GEMINI_API_KEY: true,
  COPILOT_GITHUB_TOKEN: true,
  CURSOR_API_KEY: true,
};

function isResolvableApiKeyName(value: string): value is ApiKeyName {
  return Object.hasOwn(RESOLVABLE_API_KEY_NAMES, value);
}

/**
 * Config service class
 */
export class ConfigService {
  private db: TenantScopeAwareDatabase;
  /** App reference injected after registration for cross-service calls */
  app?: Application;

  constructor(
    db: TenantScopeAwareDatabase,
    private readonly config: DeepReadonly<AgorConfig> = {},
    private readonly claudeRuntimeCredentials?: ClaudeRuntimeCredentialResolverLike,
    private readonly claudeBackendOAuth?: ClaudeBackendOAuth,
    private readonly agorVersion?: string,
    private readonly readProviderCatalog: (
      version?: string
    ) => Promise<OpenCodeProviderCatalogArtifact> = readManagedOpenCodeProviderCatalog
  ) {
    this.db = db;
  }

  /**
   * Custom method: Resolve API key for a task
   *
   * This allows executors to request API key resolution without direct database access.
   * The service follows the tenant's explicit user/workspace resolution policy.
   *
   * Called via: client.service('config/resolve-api-key').create({ taskId, keyName })
   */
  async resolveApiKey(
    data: {
      taskId: TaskID;
      keyName?: string;
      providerId?: string;
      /**
       * Restrict the per-user lookup to this tool's credential bucket. Executors
       * always pass this; absent it, the resolver falls back to a cross-tool
       * sweep (legacy behavior preserved for non-SDK callers).
       */
      tool?: AgenticToolName;
    },
    params?: Params
  ): Promise<{
    apiKey: string | null;
    connection?: Record<string, string>;
    source: 'user' | 'tenant' | 'none';
    useNativeAuth: boolean;
    decryptionFailed?: boolean;
    providerUnavailable?: string;
    credentialExpiresAt?: string;
  }> {
    const { taskId, keyName, providerId, tool } = data;
    const selectedProviderId = providerId?.trim();
    if (providerId !== undefined && (!selectedProviderId || tool !== 'opencode')) {
      throw new BadRequest('OpenCode provider scope is invalid.');
    }
    if (selectedProviderId && keyName !== undefined) {
      throw new BadRequest('Resolve an OpenCode provider entry without an API key name.');
    }
    if (!selectedProviderId && (!keyName || !isResolvableApiKeyName(keyName))) {
      throw new BadRequest('Unsupported API key name');
    }

    // This method returns plaintext secret material and is only for trusted
    // daemon/executor flows. External callers must authenticate either as the
    // service account or with a task-scoped executor runtime JWT. Normal
    // user/API-key auth must not resolve raw configured keys. The former
    // general-purpose /config read endpoint no longer exists.
    const executorScope = authenticatedTaskExecutorRuntimeScope(params);
    const executorPrincipalUserId = (params as AuthenticatedParams | undefined)?.user?.user_id;
    if (params?.provider) {
      const caller = (params as AuthenticatedParams | undefined)?.user;
      const isServiceAccount = caller?._isServiceAccount === true;
      if (!isServiceAccount && !executorScope) {
        if (!caller) {
          throw new NotAuthenticated('Authentication required');
        }
        throw new Forbidden('Only executor runtime credentials may resolve API keys');
      }
      if (executorScope && executorScope.taskId !== taskId) {
        throw new Forbidden('Executor token task scope does not match this request');
      }
    }
    if (selectedProviderId && !executorScope) {
      throw new Forbidden('OpenCode provider credentials require task-scoped executor authority');
    }

    // Fetch task to get creator user ID and session. This is required for
    // executor-token calls and best-effort for internal/service-account calls.
    const internalParams: AuthenticatedParams = {
      provider: undefined,
      tenant: (params as AuthenticatedParams | undefined)?.tenant,
    };
    let userId: UserID | undefined;
    let sessionId: string | undefined;
    let verifiedSession: Record<string, unknown> | undefined;
    try {
      const tasksService = this.app?.service('tasks');
      if (tasksService) {
        const task = await tasksService.get(taskId, internalParams);
        userId = task?.created_by;
        sessionId = task?.session_id;
      }
    } catch (err) {
      console.warn(`[Config.resolveApiKey] Failed to fetch task ${taskId}:`, err);
      if (executorScope) {
        throw new Forbidden('Executor token task scope could not be verified');
      }
    }

    if (
      executorScope &&
      (!userId ||
        !sessionId ||
        executorPrincipalUserId !== userId ||
        !matchesTaskExecutorRuntimeScope(executorScope, {
          task_id: taskId,
          session_id: sessionId,
        }))
    ) {
      throw new Forbidden('Executor token task scope could not be verified');
    }

    // Executor runtime calls are narrowly scoped to the SDK for this session.
    // Do not let a compromised executor token ask for another tool's bucket or
    // an unrelated credential name.
    if (executorScope) {
      const verifiedSessionId = sessionId;
      if (!verifiedSessionId) {
        throw new Forbidden('Executor token task scope could not be verified');
      }
      if (!tool) {
        throw new BadRequest('Tool is required for executor API key resolution');
      }
      // Other SDKs resolve their canonical env fields. OpenCode resolves the
      // exact provider selected by this Session and never sweeps its bucket.
      const sessionsService = this.app?.service('sessions');
      if (!sessionsService) {
        throw new Forbidden('Executor token tool scope could not be verified');
      }
      const session = (await sessionsService.get(verifiedSessionId, internalParams)) as
        | Record<string, unknown>
        | undefined;
      verifiedSession = session;
      if (
        session?.agentic_tool !== tool ||
        (executorScope.branchId && executorScope.branchId !== session.branch_id)
      ) {
        throw new Forbidden('Executor token tool scope does not match this session');
      }
      if (selectedProviderId) {
        const modelConfig = session.model_config as { provider?: unknown } | undefined;
        if (modelConfig?.provider !== selectedProviderId) {
          throw new Forbidden('Executor token provider scope does not match this session.');
        }
      } else {
        const expectedKeyName = TOOL_API_KEY_NAMES[tool];
        const connectionFields: readonly string[] = PROVIDER_CONNECTION_FIELDS[tool];
        if (expectedKeyName !== keyName && !connectionFields.includes(keyName!)) {
          throw new Forbidden('Executor token is not valid for this API key');
        }
      }
    }

    if (selectedProviderId) {
      return this.resolveOpenCodeProviderCredential({
        providerId: selectedProviderId,
        userId,
        session: verifiedSession,
        params: internalParams,
      });
    }

    let result = await runWithTenantDatabaseScope(
      this.db,
      internalParams.tenant?.tenant_id,
      (tenantDb) => resolveApiKey(keyName! as ApiKeyName, { userId, db: tenantDb, tool })
    );
    if (result.managedOAuth) {
      const authority = authenticatedTaskExecutorRuntimeAuthority(params);
      if (
        !authority ||
        !this.claudeBackendOAuth ||
        tool !== 'claude-code' ||
        !userId ||
        authority.taskId !== taskId ||
        authority.userId !== userId ||
        authority.sessionId !== sessionId
      ) {
        throw new Forbidden('A live task executor is required for managed Claude credentials.');
      }
      const assertTask = async () => {
        await runWithTenantDatabaseScope(this.db, authority.tenantId, (db) =>
          new TaskRepository(db).assertRuntimeCredentialAuthority(taskId, {
            token_fingerprint: authority.tokenFingerprint,
            principal_user_id: authority.userId,
            session_id: authority.sessionId,
            branch_id: authority.branchId,
          })
        );
        const session = await this.app
          ?.service('sessions')
          .get(authority.sessionId, internalParams);
        if (!session || session.agentic_tool !== tool || session.branch_id !== authority.branchId) {
          throw new Forbidden('Task credential scope changed.');
        }
        if (session.sdk_home_scope !== 'branch') {
          await this.assertNativeAuthHomeMatchesSession(tool, userId, sessionId, internalParams);
        }
      };
      const managed = await this.claudeBackendOAuth.resolve(authority.tenantId, userId, assertTask);
      result = { ...result, ...managed, apiKey: undefined, managedOAuth: undefined };
    }
    if (result.useNativeAuth && tool === 'claude-code') {
      const tenantId = internalParams.tenant?.tenant_id;
      if (!tenantId || !userId || !this.claudeRuntimeCredentials) {
        throw new BadRequest(
          'Managed Claude subscription login is unavailable for this task. Use an API key or pasted subscription token.'
        );
      }
      // The token is short-lived, but it is still the prompter's credential.
      // Do not inject it into a session executing in another user's home; the
      // same identity agreement that protected native-file auth remains the
      // task-runtime credential boundary after canonical-file masking.
      await this.assertNativeAuthHomeMatchesSession(tool, userId, sessionId, internalParams);
      const managed = await this.claudeRuntimeCredentials.resolve(tenantId, userId);
      result = {
        ...result,
        apiKey: undefined,
        connection: managed.connection,
        useNativeAuth: false,
      };
    }
    if (result.useNativeAuth) {
      if (
        this.config.multi_tenancy?.mode === 'required_from_auth' &&
        !(hasExactUserExecutorCredentialHome(this.config) && tool === 'codex')
      ) {
        throw new BadRequest(
          'Shared machine subscription authentication is unavailable in hosted multitenant mode'
        );
      }
      await this.assertNativeAuthHomeMatchesSession(tool, userId, sessionId, internalParams);
    }

    // Map KeyResolutionResult to service response type
    return {
      apiKey: result.apiKey ?? null,
      connection: result.connection as Record<string, string> | undefined,
      source: result.source,
      useNativeAuth: result.useNativeAuth,
      ...(result.providerUnavailable ? { providerUnavailable: result.providerUnavailable } : {}),
      ...(result.credentialExpiresAt ? { credentialExpiresAt: result.credentialExpiresAt } : {}),
      ...(result.decryptionFailed && { decryptionFailed: true }),
    };
  }

  private async resolveOpenCodeProviderCredential(input: {
    providerId: string;
    userId?: UserID;
    session?: Record<string, unknown>;
    params: AuthenticatedParams;
  }): Promise<{
    apiKey: null;
    connection?: Record<string, string>;
    source: 'user' | 'none';
    useNativeAuth: false;
    decryptionFailed?: boolean;
    providerUnavailable?: string;
  }> {
    if (!input.userId) throw new Forbidden('Task actor could not be verified.');
    const modelConfig = input.session?.model_config as { provider?: unknown } | undefined;
    if (modelConfig?.provider !== input.providerId) {
      throw new Forbidden('Task actor provider does not match the selected session model.');
    }

    const entryField = openCodeProviderEntryField(input.providerId);
    const legacyField =
      LEGACY_OPENCODE_PROVIDER_FIELDS[
        input.providerId as keyof typeof LEGACY_OPENCODE_PROVIDER_FIELDS
      ];
    const entry = await runWithTenantDatabaseScope(
      this.db,
      input.params.tenant?.tenant_id,
      async (tenantDb) => {
        const repo = new UsersRepository(tenantDb);
        const current = await repo.getToolConfigFieldResult(input.userId!, 'opencode', entryField);
        if (current.stored) return { ...current, field: entryField };
        if (legacyField) {
          const legacy = await repo.getToolConfigFieldResult(
            input.userId!,
            'opencode',
            legacyField
          );
          if (legacy.stored) return { ...legacy, field: legacyField, legacy: true };
        }
        return { value: null, stored: false, decryptionFailed: false, field: entryField };
      }
    );
    const savedProviderIds = entry.stored ? new Set([input.providerId]) : new Set<string>();

    let artifact: OpenCodeProviderCatalogArtifact;
    try {
      artifact = await this.readProviderCatalog(this.agorVersion);
    } catch {
      return {
        apiKey: null,
        source: 'none',
        useNativeAuth: false,
        providerUnavailable: OPEN_CODE_CATALOG_UNAVAILABLE.message,
      };
    }
    let selected: ReturnType<typeof createOpenCodeModelCatalog>['providers'][number] | undefined;
    try {
      selected = createOpenCodeModelCatalog(artifact, savedProviderIds).providers.find(
        (provider) => provider.id === input.providerId
      );
    } catch {
      selected = undefined;
    }
    if (!selected?.availableForSelection) {
      const provider = artifact.providers.find(({ id }) => id === input.providerId);
      const allOAuth = Boolean(
        provider &&
          provider.authMethods.length > 0 &&
          provider.authMethods.every((method) => method.type === 'oauth')
      );
      return {
        apiKey: null,
        source: 'none',
        useNativeAuth: false,
        providerUnavailable: allOAuth
          ? 'OpenCode OAuth sign-in is not available in hosted OpenCode.'
          : artifact.connected.includes(input.providerId) && !entry.stored
            ? 'Credential-free providers require a saved API entry in hosted OpenCode.'
            : 'The selected provider is unavailable in the hosted OpenCode catalog.',
      };
    }
    if (!entry.stored) {
      await this.assertNativeAuthHomeMatchesSession(
        'opencode',
        input.userId,
        input.session?.session_id as string | undefined,
        input.params
      );
      return { apiKey: null, source: 'none', useNativeAuth: false };
    }
    if (entry.decryptionFailed || entry.value === null) {
      return {
        apiKey: null,
        source: 'user',
        useNativeAuth: false,
        decryptionFailed: true,
      };
    }
    try {
      if (entry.field === entryField) parseOpenCodeApiEntry(entry.value);
      else validateOpenCodeApiEntry({ type: 'api', key: entry.value });
    } catch {
      return {
        apiKey: null,
        source: 'user',
        useNativeAuth: false,
        decryptionFailed: true,
      };
    }
    return {
      apiKey: null,
      source: 'user',
      useNativeAuth: false,
      connection: { [entry.field]: entry.value },
    };
  }

  /**
   * Native auth resolves from the task creator, while the filesystem sandbox
   * mounts the session owner's home. Refuse a mismatch rather than borrowing
   * the owner's credential or silently missing the prompter's login.
   */
  private async assertNativeAuthHomeMatchesSession(
    tool: AgenticToolName | undefined,
    promptingUserId: UserID | undefined,
    sessionId: string | undefined,
    internalParams: AuthenticatedParams
  ): Promise<void> {
    if (!promptingUserId) return;

    const tenantId = internalParams.tenant?.tenant_id;
    const homeOf = (userId: UserID) =>
      resolveExecutionCredentialHome({
        userId,
        tenantId,
        config: this.config,
        withTenantDatabase: (work) => runWithTenantDatabaseScope(this.db, tenantId, work),
      });
    const requireCanonicalProviderHome =
      (tool === 'codex' || tool === 'claude-code') && this.config.deployment?.mode === 'ha';
    let prompterHome = requireCanonicalProviderHome ? await homeOf(promptingUserId) : undefined;
    if (prompterHome?.homeStoreSource === 'override') {
      throw new BadRequest(
        'HA subscription auth requires Agor’s canonical tenant/user home. ' +
          'Remove the filesystem_home override for this account or use an API key.'
      );
    }

    if (!sessionId) return;
    const sessionsService = this.app?.service('sessions');
    if (!sessionsService) return;
    const session = (await sessionsService.get(sessionId, internalParams)) as
      | {
          created_by?: string;
          unix_username?: string | null;
          sdk_home_scope?: 'execution_home' | 'branch';
        }
      | undefined;
    // A branch-scoped Session deliberately selects the immutable prompt actor's
    // per-user home and overlays that actor's pinned Codex auth inode. The
    // executor principal was already proven equal to Task.created_by above, so
    // comparing it with the Session owner would reject the intended
    // collaborator path. Execution-home Sessions retain the historical owner
    // home and therefore still require the comparison below.
    if ((tool === 'codex' || tool === 'opencode') && session?.sdk_home_scope === 'branch') return;
    const ownerUserId = session?.created_by;
    if (!ownerUserId) return;

    prompterHome ??= await homeOf(promptingUserId);
    let ownerHome =
      ownerUserId === promptingUserId ? prompterHome : await homeOf(ownerUserId as UserID);
    // Delegated sessions execute under the immutable home key stamped when the
    // session was created. Comparing only current user rows lets a same-owner
    // session silently read an old or reassigned home after that key changes.
    if ((this.config.execution?.unix_user_mode ?? 'simple') === 'delegated') {
      ownerHome = {
        ...ownerHome,
        delegatedHomeKey: session?.unix_username ?? null,
      };
    }
    if (requireCanonicalProviderHome && ownerHome.homeStoreSource === 'override') {
      throw new BadRequest(
        'HA subscription auth requires the session owner’s canonical tenant/user home. ' +
          'Remove the filesystem_home override or use an API key.'
      );
    }
    if (sameExecutionCredentialHome(prompterHome, ownerHome)) return;

    throw new Forbidden(
      'Subscription sign-in belongs to a different execution home than this session runs in. ' +
        "The session executes in its owner's home, so the prompting user's on-disk login is not " +
        'visible to it. Prompt a session you own, or configure an API key.'
    );
  }
}

/**
 * Service factory function
 */
export function createConfigService(
  db: TenantScopeAwareDatabase,
  config: DeepReadonly<AgorConfig>,
  claudeRuntimeCredentials?: ClaudeRuntimeCredentialResolverLike,
  claudeBackendOAuth?: ClaudeBackendOAuth,
  agorVersion?: string
): ConfigService {
  return new ConfigService(db, config, claudeRuntimeCredentials, claudeBackendOAuth, agorVersion);
}
