import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// An installed generation lives at <agentDir>/memento/integration/generation-NNNNNN/src/config.mjs.
const INSTALLED_MODULE = /(?:^|\/)memento\/integration\/generation-\d{6}\/src\/config\.mjs$/;

export const CONFIG_NAME = 'config.json';

function slashed(path) {
  return path.replaceAll('\\', '/');
}

/**
 * Agent dir for local runtime files: the environment wins, otherwise it is
 * derived from an installed generation path. A checkout path derives nothing,
 * so an unconfigured run never invents the owner's agent dir.
 */
export function resolveAgentDir(env = process.env, moduleUrl = import.meta.url) {
  const explicit = env.SENPI_CODING_AGENT_DIR ?? env.OMO_CODING_AGENT_DIR;
  if (typeof explicit === 'string' && explicit.length > 0) return resolve(explicit);
  let file;
  try {
    file = fileURLToPath(moduleUrl);
  } catch {
    return '';
  }
  if (typeof file !== 'string' || !INSTALLED_MODULE.test(slashed(file))) return '';
  // src -> generation-NNNNNN -> integration -> memento -> agentDir
  return resolve(dirname(file), '../../../..');
}

export function configPathFor(agentDir) {
  return agentDir ? join(agentDir, 'memento', CONFIG_NAME) : '';
}

function unconfigured(agentDir, reason) {
  return { state: 'unconfigured', reason, agentDir, configPath: configPathFor(agentDir) };
}

function validate(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'config-invalid';
  if (typeof parsed.repoPath !== 'string' || parsed.repoPath.length === 0) return 'config-invalid';
  if (typeof parsed.tokenFile !== 'string' || parsed.tokenFile.length === 0) return 'config-invalid';
  if (parsed.remote !== undefined && parsed.remote !== null && typeof parsed.remote !== 'string') {
    return 'config-invalid';
  }
  return '';
}

/**
 * Reads <agentDir>/memento/config.json. Every failure is a state, never a throw.
 * The token file is only named here; it is never opened by this module.
 */
export function loadConfig({ agentDir, env = process.env } = {}) {
  const resolvedAgentDir = agentDir ? resolve(agentDir) : resolveAgentDir(env);
  if (!resolvedAgentDir) return unconfigured('', 'agent-dir-unknown');
  const configPath = configPathFor(resolvedAgentDir);
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    const reason = error?.code === 'ENOENT' ? 'config-missing' : 'config-unreadable';
    return unconfigured(resolvedAgentDir, reason);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unconfigured(resolvedAgentDir, 'config-invalid');
  }
  const invalid = validate(parsed);
  if (invalid) return unconfigured(resolvedAgentDir, invalid);
  return {
    state: 'configured',
    reason: '',
    agentDir: resolvedAgentDir,
    configPath,
    repoPath: parsed.repoPath,
    tokenFile: parsed.tokenFile,
    remote: typeof parsed.remote === 'string' && parsed.remote.length > 0 ? parsed.remote : null,
  };
}
