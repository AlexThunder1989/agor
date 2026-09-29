import type { OpenCodeProviderCatalogArtifact } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  buildOpenCodeAuthContent,
  createOpenCodeHostedProviderDiscovery,
  createOpenCodeModelCatalog,
  hostedProviderIdsFromConnection,
  openCodeProviderEntryField,
  parseOpenCodeApiEntry,
  validateOpenCodeApiEntry,
} from './known-models.js';
import { OPENCODE_VERSION } from './version.js';

function providerCatalog(): OpenCodeProviderCatalogArtifact {
  return {
    schemaVersion: 1,
    runtimeVersion: OPENCODE_VERSION,
    connected: ['opencode'],
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        env: ['OPENAI_API_KEY'],
        defaultModel: 'alpha-model',
        authMethods: [{ index: 0, type: 'api', label: 'API key' }],
        models: [
          { id: 'alpha-model', name: 'Alpha', status: 'alpha' },
          { id: 'latest', name: 'Latest', status: 'active' },
          { id: 'old', name: 'Old', status: 'deprecated' },
        ],
      },
      {
        id: 'generic-api',
        name: 'Generic API provider',
        env: ['GENERIC_API_KEY'],
        defaultModel: 'generic-model',
        authMethods: [],
        models: [{ id: 'generic-model', name: 'Generic model', status: 'active' }],
      },
      {
        id: 'opencode',
        name: 'OpenCode Zen',
        env: [],
        defaultModel: 'zen-free',
        authMethods: [{ index: 0, type: 'api', label: 'API key' }],
        models: [{ id: 'zen-free', name: 'Zen', status: 'active' }],
      },
      {
        id: 'oauth-only',
        name: 'OAuth Only',
        env: [],
        authMethods: [{ index: 0, type: 'oauth', label: 'Sign in' }],
        models: [{ id: 'model', name: 'OAuth model', status: 'active' }],
      },
    ],
  };
}

describe('OpenCode provider catalog projection', () => {
  it('filters alpha and deprecated models, recomputes defaults, and denies no-key connected providers', () => {
    const catalog = createOpenCodeModelCatalog(providerCatalog(), new Set());
    expect(catalog.providers.find(({ id }) => id === 'openai')).toMatchObject({
      availableForSelection: true,
      suggestedModel: 'latest',
      models: [{ id: 'latest', status: 'active' }],
    });
    expect(catalog.providers.find(({ id }) => id === 'opencode')?.availableForSelection).toBe(
      false
    );
    expect(catalog.providers.find(({ id }) => id === 'oauth-only')?.availableForSelection).toBe(
      false
    );
    expect(catalog.suggestedSelection).toEqual({ providerId: 'openai', modelId: 'latest' });
  });

  it('offers a credential-free provider only with a caller saved entry and keeps saved noncatalog ids removable', () => {
    const saved = new Set(['opencode', 'retired-provider']);
    const hosted = createOpenCodeHostedProviderDiscovery(providerCatalog(), saved);
    expect(hosted.providers.find(({ id }) => id === 'opencode')).toMatchObject({
      runtimeAvailable: true,
      credentialPresence: 'present',
    });
    expect(hosted.providers.find(({ id }) => id === 'oauth-only')).toMatchObject({
      runtimeAvailable: false,
      apiAuthAvailable: false,
      authMethods: [],
      unavailableReason: expect.stringContaining('OAuth'),
    });
    expect(hosted.providers.find(({ id }) => id === 'generic-api')).toMatchObject({
      runtimeAvailable: true,
      apiAuthAvailable: true,
      authMethods: [],
    });
    expect(hosted.providers.find(({ id }) => id === 'retired-provider')).toMatchObject({
      runtimeAvailable: false,
      credentialPresence: 'present',
      models: [],
    });
  });

  it('projects only the selected entry into auth.json and keeps the endpoint out of it', () => {
    const serialized = JSON.stringify({
      type: 'api',
      key: 'alice-secret',
      metadata: { resourceName: 'https://azure.example/v1' },
      endpoint: 'https://gateway.example.test/v1',
    });
    const projected = buildOpenCodeAuthContent(
      {
        [openCodeProviderEntryField('azure')]: serialized,
        [openCodeProviderEntryField('openai')]: JSON.stringify({ type: 'api', key: 'bob-secret' }),
      },
      'azure'
    );
    expect(projected.providerIds).toEqual(['azure']);
    expect(JSON.parse(projected.content ?? '')).toEqual({
      azure: {
        type: 'api',
        key: 'alice-secret',
        metadata: { resourceName: 'https://azure.example/v1' },
      },
    });
    expect(projected.endpoint).toBe('https://gateway.example.test/v1');
    expect(projected.content).not.toContain('gateway.example');
    expect(projected.secrets).toEqual(['alice-secret', projected.content]);
  });

  it('reads legacy aliases without returning unrelated entries', () => {
    const projected = buildOpenCodeAuthContent(
      {
        OPENCODE_API_KEY_OPENAI: ' legacy-openai ',
        OPENCODE_API_KEY_ANTHROPIC: 'other',
      },
      'openai'
    );
    expect(JSON.parse(projected.content ?? '')).toEqual({
      openai: { type: 'api', key: 'legacy-openai' },
    });
    expect(
      [
        ...hostedProviderIdsFromConnection({
          [openCodeProviderEntryField('custom')]: true,
          OPENCODE_API_KEY_ANTHROPIC: true,
        }),
      ].sort()
    ).toEqual(['anthropic', 'custom']);
  });
});

describe('OpenCode generic entry validation', () => {
  it('accepts safe token metadata and HTTPS metadata URLs without interpreting them', () => {
    expect(
      validateOpenCodeApiEntry({
        type: 'api',
        key: 'secret',
        metadata: { resourceName: 'https://resource.example/path', project: 'my-project-1' },
        endpoint: 'https://gateway.example/v1',
      })
    ).toEqual({
      type: 'api',
      key: 'secret',
      metadata: { resourceName: 'https://resource.example/path', project: 'my-project-1' },
      endpoint: 'https://gateway.example/v1',
    });
  });

  it.each([
    [{ type: 'oauth', key: 'secret' }, /API/],
    [{ type: 'api', key: 'x'.repeat(65 * 1024) }, /64 KiB/],
    [{ type: 'api', key: 'secret', metadata: { url: 'http://metadata.example' } }, /HTTPS/],
    [
      { type: 'api', key: 'secret', metadata: { url: 'https://user@metadata.example' } },
      /user information/,
    ],
    [{ type: 'api', key: 'secret', metadata: { profile: 'not a token' } }, /safe tokens/],
    [{ type: 'api', key: 'secret', endpoint: 'http://gateway.example' }, /HTTPS/],
    [{ type: 'api', key: 'secret', endpoint: 'https://user@gateway.example' }, /user information/],
  ])('rejects invalid provider entry %#', (entry, message) => {
    expect(() => validateOpenCodeApiEntry(entry)).toThrow(message);
  });

  it('fails closed when the encrypted value cannot be parsed or revalidated', () => {
    expect(() => parseOpenCodeApiEntry('{')).toThrow(/Re-enter/);
    expect(() => parseOpenCodeApiEntry(JSON.stringify({ type: 'oauth', key: 'secret' }))).toThrow(
      /Re-enter/
    );
  });
});
