import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve('opencode-ai/package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const nativeRoot = dirname(packageJsonPath);
const binary = resolve(
  nativeRoot,
  typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin.opencode
);
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies[
  '@opencode-ai/sdk'
];
await rm(join(root, '.catalog'), { recursive: true, force: true });
await rm(join(root, 'dist', 'provider-catalog.json'), { force: true });
const scratch = await mkdtemp(join(tmpdir(), 'agor-opencode-catalog-'));
const directories = Object.fromEntries(
  ['home', 'data', 'config', 'cache', 'state', 'work', 'managed'].map((name) => [
    name,
    join(scratch, name),
  ])
);
for (const path of Object.values(directories)) await mkdir(path, { recursive: true, mode: 0o700 });
const password = randomBytes(32).toString('hex');
const username = `agor-${randomBytes(8).toString('hex')}`;
const environment = {
  PATH: process.env.PATH ?? '',
  HOME: directories.home,
  XDG_DATA_HOME: directories.data,
  XDG_CONFIG_HOME: directories.config,
  XDG_CACHE_HOME: directories.cache,
  XDG_STATE_HOME: directories.state,
  OPENCODE_DB: join(directories.data, 'opencode.sqlite'),
  OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
  OPENCODE_PURE: 'true',
  OPENCODE_DISABLE_AUTOUPDATE: 'true',
  OPENCODE_DISABLE_MODELS_FETCH: 'true',
  OPENCODE_TEST_HOME: directories.home,
  OPENCODE_TEST_MANAGED_CONFIG_DIR: directories.managed,
  OPENCODE_SERVER_USERNAME: username,
  OPENCODE_SERVER_PASSWORD: password,
};

function spawnCaptured(args, env = environment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, {
      cwd: directories.work,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolvePromise(output)
        : reject(new Error(`Pinned OpenCode command failed (${code}): ${output.slice(-2000)}`))
    );
  });
}

function listen(child) {
  return new Promise((resolvePromise, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error('Pinned OpenCode catalog server did not become ready.')),
      30_000
    );
    const onData = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-8000);
      const match = output.match(/(?:^|\n)opencode server listening on (https?:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timer);
      try {
        const url = new URL(match[1].replace(/[),.;]+$/, ''));
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port)
          throw new Error('unsafe listener');
        resolvePromise(url.origin);
      } catch {
        reject(new Error('Pinned OpenCode reported an invalid catalog listener.'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Pinned OpenCode exited before catalog capture (${code}).`));
    });
  });
}

function promptProjection(prompt) {
  if (!prompt || !['text', 'select'].includes(prompt.type)) return undefined;
  const projected = {
    type: prompt.type,
    key: prompt.key,
    message: prompt.message,
    ...(typeof prompt.placeholder === 'string' ? { placeholder: prompt.placeholder } : {}),
    ...(prompt.type === 'select' && Array.isArray(prompt.options)
      ? {
          options: prompt.options.map((option) => ({
            label: option.label,
            value: option.value,
            ...(typeof option.hint === 'string' ? { hint: option.hint } : {}),
          })),
        }
      : {}),
    ...(prompt.when && typeof prompt.when === 'object'
      ? {
          when: {
            key: prompt.when.key,
            op: prompt.when.op,
            value: prompt.when.value,
          },
        }
      : {}),
  };
  return projected;
}

function modelProjection(model) {
  const allowedStatuses = new Set(['active', 'beta', 'alpha', 'deprecated']);
  if (!allowedStatuses.has(model.status))
    throw new Error(`OpenCode returned an unknown model status for ${model.id}.`);
  const numeric = (value) =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const limit = Object.fromEntries(
    ['context', 'input', 'output'].flatMap((key) => {
      const value = numeric(model.limit?.[key]);
      return value === undefined ? [] : [[key, value]];
    })
  );
  const capabilities = Object.fromEntries(
    Object.entries(model.capabilities ?? {}).filter(([, value]) => typeof value === 'boolean')
  );
  return {
    id: model.id,
    name: model.name,
    status: model.status,
    ...(Object.keys(limit).length ? { limit } : {}),
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
  };
}

try {
  const actualVersion = (await spawnCaptured(['--version'])).match(
    /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/
  )?.[0];
  if (actualVersion !== version)
    throw new Error(
      `OpenCode binary ${actualVersion ?? 'unknown'} does not match SDK pin ${version}.`
    );
  const child = spawn(binary, ['serve', '--hostname=127.0.0.1', '--port=0'], {
    cwd: directories.work,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const baseUrl = await listen(child);
    const client = createOpencodeClient({
      baseUrl,
      directory: directories.work,
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      },
    });
    const [list, auth] = await Promise.all([
      client.provider.list({ directory: directories.work }),
      client.provider.auth({ directory: directories.work }),
    ]);
    if (list.error || !list.data || auth.error)
      throw new Error('OpenCode provider catalog request failed.');
    const rawProviders = list.data.all;
    if (rawProviders.some((provider) => provider.key !== undefined && provider.key !== null)) {
      throw new Error('Catalog capture found a provider key; refusing to write the artifact.');
    }
    const providers = rawProviders.map((provider) => ({
      id: provider.id,
      name: provider.name,
      env: Array.isArray(provider.env)
        ? provider.env.filter((name) => typeof name === 'string')
        : [],
      models: Object.values(provider.models).map(modelProjection),
      ...(list.data.default[provider.id] ? { defaultModel: list.data.default[provider.id] } : {}),
      authMethods: (auth.data?.[provider.id] ?? []).map((method, index) => ({
        index,
        type: method.type,
        label: method.label,
        ...(method.prompts
          ? { prompts: method.prompts.map(promptProjection).filter(Boolean) }
          : {}),
      })),
    }));
    const artifact = {
      schemaVersion: 1,
      runtimeVersion: version,
      providers,
      connected: list.data.connected,
    };
    const outputDirectory = join(root, '.catalog');
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const target = join(outputDirectory, 'provider-catalog.json');
    await writeFile(target, `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
    await chmod(target, 0o600);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolvePromise) => {
      if (child.exitCode !== null) return resolvePromise();
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolvePromise();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
