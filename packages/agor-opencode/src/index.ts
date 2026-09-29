/** Agor-managed, release-aligned opencode integration. */
import { readFile } from 'node:fs/promises';

export const AGOR_INTEGRATION_VERSION = '0.26.8';
export const VENDOR_PACKAGE = '@opencode-ai/sdk';
export * as sdk from '@opencode-ai/sdk';
export * as sdkV2 from '@opencode-ai/sdk/v2';

/** Read the build-captured, public-only catalog shipped beside this wrapper. */
export async function readProviderCatalog(): Promise<unknown> {
  return JSON.parse(await readFile(new URL('./provider-catalog.json', import.meta.url), 'utf8'));
}
