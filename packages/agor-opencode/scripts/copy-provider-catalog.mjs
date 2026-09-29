import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, '.catalog', 'provider-catalog.json');
const targetDirectory = join(root, 'dist');
const target = join(targetDirectory, 'provider-catalog.json');
const artifact = JSON.parse(await readFile(source, 'utf8'));
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (
  artifact.schemaVersion !== 1 ||
  artifact.runtimeVersion !== packageJson.dependencies['@opencode-ai/sdk']
) {
  throw new Error('OpenCode provider catalog does not match the package SDK pin.');
}
await mkdir(targetDirectory, { recursive: true });
await copyFile(source, target);
await rm(source, { force: true });
await rm(dirname(source), { recursive: true, force: true });
await stat(target);
