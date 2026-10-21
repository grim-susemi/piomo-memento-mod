import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveAgentDir } from '../src/config.mjs';
import { build } from './build.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENTRY = 'src/extension.mjs';
const SHIM_NAME = 'omo-memento.js';
const MARKER = '// managed by omo-memento';

function fail(code, message = code, exitCode = 1) {
  return Object.assign(new Error(message), { code, exitCode });
}

function pathKey(path) {
  const normalized = resolve(path).replaceAll('\\', '/');
  return (normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized).toLowerCase();
}

function realPathKey(path) {
  const missing = [];
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return pathKey(join(realpathSync.native(existing), ...missing));
}

export function isEnvironmentAgentDir(agentDir, env = process.env) {
  const configured = resolveAgentDir(env);
  if (!configured) return false;
  return pathKey(agentDir) === pathKey(configured)
    || realPathKey(agentDir) === realPathKey(configured);
}

function filesUnder(directory, root = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path, root));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll(sep, '/'));
  }
  return files.sort();
}

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function replaceWrite(path, text) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, text, { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function foreignShim(shimPath) {
  return existsSync(shimPath) && readFileSync(shimPath, 'utf8').split(/\r?\n/, 1)[0] !== MARKER;
}

function nextGeneration(integration) {
  const numbers = existsSync(integration) ? readdirSync(integration)
    .map(name => /^generation-(\d{6})$/.exec(name))
    .filter(Boolean)
    .map(match => Number(match[1])) : [];
  return `generation-${String(Math.max(0, ...numbers) + 1).padStart(6, '0')}`;
}

function copyInto(dist, generationPath) {
  const copied = [];
  for (const source of ['src', 'bin']) {
    const directory = join(dist, source);
    if (!existsSync(directory)) continue;
    for (const file of filesUnder(directory)) {
      const target = join(generationPath, source, file);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(directory, file), target);
      copied.push(`${source}/${file}`);
    }
  }
  for (const [source, target] of [['package.json', 'package.json'], ['dist/manifest.json', 'dist/manifest.json']]) {
    const from = existsSync(join(dist, source)) ? join(dist, source) : join(ROOT, source);
    if (!existsSync(from)) continue;
    const destination = join(generationPath, target);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(from, destination);
    copied.push(target);
  }
  return copied.sort();
}

export function install({
  agentDir, uninstall = false, live = false, dist = null, buildProduct = build, env = process.env,
} = {}) {
  if (!agentDir) throw fail('agent_dir_required', 'Use --agent-dir <directory>.');
  const resolvedAgentDir = resolve(agentDir);
  if (!live) {
    if (isEnvironmentAgentDir(resolvedAgentDir, env)) {
      throw fail('live_agent_dir_refused',
        `Refusing to install into the agent directory resolved from the environment (${resolvedAgentDir}); pass --live only after owner approval.`, 2);
    }
    if (existsSync(join(resolvedAgentDir, 'settings.json'))) {
      throw fail('configured_agent_dir_refused',
        `Refusing to install into a configured agent directory (${resolvedAgentDir}) without --live; nothing changed.`, 2);
    }
  }

  const base = join(resolvedAgentDir, 'memento');
  const integration = join(base, 'integration');
  const currentPath = join(base, 'current.json');
  const extensions = join(resolvedAgentDir, 'extensions');
  const shimPath = join(extensions, SHIM_NAME);
  if (foreignShim(shimPath)) throw fail('foreign_shim', `Refusing non-managed ${SHIM_NAME}; nothing changed.`);
  if (uninstall) {
    const removed = existsSync(shimPath) ? [shimPath] : [];
    for (const path of removed) unlinkSync(path);
    return { status: 'uninstalled', agent_dir: resolvedAgentDir, shim_path: shimPath, removed, kept: ['generations', 'current.json', 'logs'] };
  }

  if (dist === null) {
    buildProduct();
    dist = join(ROOT, 'dist');
  }
  if (!existsSync(join(dist, ENTRY))) throw fail('dist_missing', 'Run npm run build first.');
  const generation = nextGeneration(integration);
  const generationPath = join(integration, generation);
  const copied = copyInto(dist, generationPath);
  if (!copied.includes(ENTRY)) throw fail('dist_incomplete', `The build output is missing ${ENTRY}.`);
  const files = {};
  for (const file of copied) files[file] = sha256Of(join(generationPath, file));

  mkdirSync(extensions, { recursive: true });
  const entryPath = `../memento/integration/${generation}/${ENTRY}`;
  replaceWrite(shimPath, `${MARKER}\nexport { default } from '${entryPath}';\n`);
  const installedAt = new Date().toISOString();
  replaceWrite(currentPath, `${JSON.stringify({ generation, installedAt, files }, null, 2)}\n`);
  return {
    status: 'installed', generation, generation_path: generationPath, agent_dir: resolvedAgentDir,
    shim_path: shimPath, entry: ENTRY, sha256: files,
  };
}

export function shimUrl(agentDir) {
  return pathToFileURL(join(resolve(agentDir), 'extensions', SHIM_NAME)).href;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      'agent-dir': { type: 'string' },
      uninstall: { type: 'boolean' },
      live: { type: 'boolean' },
    } });
    console.log(JSON.stringify(install({
      agentDir: values['agent-dir'], uninstall: !!values.uninstall, live: !!values.live,
    }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'refused', code: error.code ?? 'install_error', message: error.message }));
    process.exitCode = error.exitCode ?? 1;
  }
}
