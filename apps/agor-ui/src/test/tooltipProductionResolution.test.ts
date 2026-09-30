// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('AntD-transitive Trigger resolves to the lock/workspace patch, not only the dev pin', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const ui = createRequire(resolve(root, 'apps/agor-ui/package.json'));
  const antd = createRequire(ui.resolve('antd/package.json'));
  const tooltip = createRequire(antd.resolve('@rc-component/tooltip/package.json'));
  const productionPackage = tooltip.resolve('@rc-component/trigger/package.json');
  const production = createRequire(productionPackage);
  const pkg = JSON.parse(readFileSync(productionPackage, 'utf8'));
  const key = `@rc-component/trigger@${pkg.version}`;
  // Use the repository's declared YAML parser, not a private pnpm-store path.
  const core = createRequire(resolve(root, 'packages/core/package.json'));
  const yaml = core('js-yaml') as {
    load: (source: string) => {
      patchedDependencies: Record<string, string>;
      snapshots: Record<string, { dependencies?: Record<string, string> }>;
    };
  };
  const workspace = yaml.load(readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8'));
  const lock = yaml.load(readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8'));
  const patch = readFileSync(resolve(root, workspace.patchedDependencies[key]), 'utf8');
  expect(lock.patchedDependencies[key]).toBe(createHash('sha256').update(patch).digest('hex'));
  expect(realpathSync(ui.resolve('@rc-component/trigger/package.json'))).toBe(
    realpathSync(productionPackage)
  );
  expect(production.resolve('.')).toBe(production.resolve(`./${pkg.main}`));
  for (const consumer of [
    '@rc-component/tooltip',
    '@rc-component/dropdown',
    '@rc-component/select',
  ]) {
    const loader = createRequire(antd.resolve(`${consumer}/package.json`));
    expect(realpathSync(loader.resolve('@rc-component/trigger/package.json'))).toBe(
      realpathSync(productionPackage)
    );
    const snapshots = Object.entries(lock.snapshots).filter(([name]) =>
      name.startsWith(`${consumer}@`)
    );
    expect(snapshots.length).toBeGreaterThan(0);
    for (const [, snapshot] of snapshots) {
      expect(snapshot.dependencies?.['@rc-component/trigger']).toContain(
        `(patch_hash=${lock.patchedDependencies[key]})`
      );
    }
  }
  for (const format of ['es', 'lib']) {
    const entry = tooltip.resolve(`@rc-component/trigger/${format}`);
    const declaredEntry = format === 'es' ? pkg.module : pkg.main;
    expect(production.resolve(`./${declaredEntry}`)).toBe(entry);
    expect(realpathSync(entry)).toBe(realpathSync(ui.resolve(`@rc-component/trigger/${format}`)));
    const source = readFileSync(entry, 'utf8');
    expect(source).toContain(
      format === 'es' ? 'useTarget(parentContext, id)' : '_useTarget.default)(parentContext, id)'
    );
    expect(source).not.toContain('setPopupRef = useEvent');
    const helper = `${format}/hooks/useTarget.js`;
    const section = patch
      .split(`diff --git a/${helper} b/${helper}\n`)[1]
      ?.split('\ndiff --git ')[0];
    expect(section).toBeDefined();
    // Added helper bytes must match the patch exactly (not merely its version).
    const added = `${section
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
      .join('\n')}\n`;
    expect(readFileSync(resolve(dirname(entry), 'hooks/useTarget.js'), 'utf8')).toBe(added);
  }
});
