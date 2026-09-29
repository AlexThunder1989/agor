import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasTenantNativeStateFilesystemTree } from './tenant-native-state-filesystem-preflight';

describe('native-state deletion preflight', () => {
  it('checks only native paths without reading unrelated tenant file bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-native-preflight-'));
    try {
      await mkdir(join(root, 'other'), { recursive: true });
      await writeFile(join(root, 'other', 'unrelated.bin'), 'ordinary tenant data');
      expect(await hasTenantNativeStateFilesystemTree(root)).toBe(false);
      for (const homeName of ['home', 'homes']) {
        const native = join(root, homeName, 'owner', '.local', 'share', 'agor', 'opencode');
        await mkdir(native, { recursive: true });
        expect(await hasTenantNativeStateFilesystemTree(root)).toBe(true);
        await rm(join(root, homeName), { recursive: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed on a symlinked native-state ancestor without following it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-native-preflight-'));
    const outside = await mkdtemp(join(tmpdir(), 'agor-native-outside-'));
    try {
      await mkdir(join(root, 'homes', 'owner'), { recursive: true });
      await symlink(outside, join(root, 'homes', 'owner', '.local'));
      expect(await hasTenantNativeStateFilesystemTree(root)).toBe(true);
      await symlink(root, join(outside, 'linked-root'));
      await expect(
        hasTenantNativeStateFilesystemTree(join(outside, 'linked-root'))
      ).rejects.toThrow('symlinked tenant filesystem root');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('treats only empty canonical UUIDv7 Session mount roots as non-residue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-native-preflight-'));
    const sessionId = '018f0000-0000-7000-8000-000000000001';
    try {
      const protectedRoot = join(root, 'opencode-sessions');
      await mkdir(protectedRoot);
      expect(await hasTenantNativeStateFilesystemTree(root)).toBe(false);
      const sessionRoot = join(protectedRoot, sessionId);
      await mkdir(sessionRoot);
      expect(await hasTenantNativeStateFilesystemTree(root)).toBe(false);
      await mkdir(join(sessionRoot, 'nested', 'empty'), { recursive: true });
      expect(await hasTenantNativeStateFilesystemTree(root)).toBe(true);
      await rm(join(sessionRoot, 'nested'), { recursive: true });
      await mkdir(join(sessionRoot, 'stores'));
      expect(await hasTenantNativeStateFilesystemTree(root)).toBe(true);
      await rm(sessionRoot, { recursive: true });
      await mkdir(join(protectedRoot, 'not-a-session'));
      expect(await hasTenantNativeStateFilesystemTree(root)).toBe(true);
      await rm(protectedRoot, { recursive: true });
      await writeFile(protectedRoot, 'not a directory');
      expect(await hasTenantNativeStateFilesystemTree(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts an absent new root only after the tenant root is inspected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-native-preflight-'));
    try {
      expect(await hasTenantNativeStateFilesystemTree(root)).toBe(false);
      await writeFile(join(root, 'opencode-sessions'), 'not a directory');
      expect(await hasTenantNativeStateFilesystemTree(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed on a symlinked Session root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-native-preflight-'));
    const outside = await mkdtemp(join(tmpdir(), 'agor-native-outside-'));
    try {
      const protectedRoot = join(root, 'opencode-sessions');
      await mkdir(protectedRoot);
      await symlink(outside, join(protectedRoot, '018f0000-0000-7000-8000-000000000001'));
      expect(await hasTenantNativeStateFilesystemTree(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
