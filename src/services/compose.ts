import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DockerError, ValidationError } from './errors';
import { validateComposeFile } from './compose-validation';
import type { DockerComposeAppConfig } from './apps';

const execFileAsync = promisify(execFile);

const COMPOSE_PROJECT_PREFIX = 'ld-';

// Leafdock writes this override next to the app's compose file, so an app must
// not be able to name its own file the same thing.
const NETWORK_OVERRIDE_FILE = 'docker-compose.network.yml';

// A compose file is a host-root request: it is handed to `docker compose up`
// against a docker socket, so `network_mode: host` + `cap_add: [NET_ADMIN]`
// rewrites the host firewall, `pid: host` exposes the host process table,
// `privileged: true` is plain root, and a `/`-bind reads every file. The policy
// in compose-validation.ts rejects those shapes; assertComposePolicy is the
// single choke point every create/update/start path goes through.
//
// `compose_file` is a bare filename inside the app directory, never a path or a
// shell fragment: composeUp passes it as an argv element, and the name is
// validated here so a config value like "a.yml; rm -rf /" is refused at the API
// boundary (see mergeConfig in apps.ts) and again at deploy time.
const COMPOSE_FILE_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/;

export function composeFileName(config: DockerComposeAppConfig): string {
  const file = config?.compose_file;
  if (file === undefined || file === null || file === '') return 'docker-compose.yml';
  if (
    typeof file !== 'string' ||
    !COMPOSE_FILE_REGEX.test(file) ||
    file === NETWORK_OVERRIDE_FILE
  ) {
    throw new ValidationError(
      '"compose_file" must be a .yml/.yaml filename inside the app directory',
      'validation_error'
    );
  }
  return file;
}

function composeDir(name: string, folder = ''): string {
  return path.join(process.env.DATA_DIR || '/data', 'apps', ...(folder ? [folder] : []), name);
}

/**
 * Host-safety gate for docker-compose apps. Validates the file that this app
 * will actually execute; throws ComposePolicyError with every violation.
 */
export function assertComposePolicy(
  name: string,
  folder: string,
  composeFile = 'docker-compose.yml'
): void {
  const dir = composeDir(name, folder);
  validateComposeFile(path.join(dir, composeFile), {
    appDir: dir,
    allowedHostPorts: process.env.LEAFDOCK_ALLOWED_HOST_PORTS,
    allowedBindPaths: process.env.LEAFDOCK_ALLOWED_BIND_PATHS,
  });
}

// Environment for the compose child process. Uploaded compose files are
// interpolated against it (`${VAR}`), so leafdock's own environment
// (GIT_TOKEN(S), MANAGEMENT_API_KEY, …) must never be visible to an app author
// — only what the docker CLI needs is forwarded.
function composeChildEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function generateNetworkOverride(name: string, services: Record<string, { port: number }>): string {
  let yaml = `networks:\n  leafdock_default:\n    external: true\n\nservices:\n`;
  for (const serviceName of Object.keys(services)) {
    const containerName = `${COMPOSE_PROJECT_PREFIX}${name}-${serviceName}`;
    yaml += `  ${serviceName}:\n    container_name: ${containerName}\n    networks:\n      - leafdock_default\n`;
  }
  return yaml;
}

export async function composeUp(name: string, folder: string, config: DockerComposeAppConfig): Promise<void> {
  const dir = composeDir(name, folder);

  // Validate before anything is written or started: the compose file is what
  // the daemon will execute, so it must pass the host-safety policy first.
  assertComposePolicy(name, folder, composeFileName(config));

  const networkFile = path.join(dir, NETWORK_OVERRIDE_FILE);

  // Write network override so services join the Caddy network
  fs.writeFileSync(networkFile, generateNetworkOverride(name, config.services), 'utf-8');

  const args = [
    'compose', '-p', `${COMPOSE_PROJECT_PREFIX}${name}`,
    '-f', composeFileName(config),
    '-f', NETWORK_OVERRIDE_FILE,
    'up', '-d',
  ];
  try {
    await execFileAsync('docker', args, {
      cwd: dir,
      env: composeChildEnv(),
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DockerError(`docker compose up failed: ${msg}`);
  }
}

export async function composeDown(name: string, folder: string): Promise<void> {
  const dir = composeDir(name, folder);
  try {
    await execFileAsync(
      'docker',
      ['compose', '-p', `${COMPOSE_PROJECT_PREFIX}${name}`, 'down', '--remove-orphans'],
      { cwd: dir, env: composeChildEnv(), maxBuffer: 10 * 1024 * 1024 }
    );
  } catch {
    // Project might not exist
  }
  // Clean up network override
  const networkFile = path.join(dir, NETWORK_OVERRIDE_FILE);
  try { fs.rmSync(networkFile); } catch {}
}

export async function composeLogs(name: string, folder: string, tail: number): Promise<string> {
  const dir = composeDir(name, folder);
  try {
    // execFile cannot merge stderr with `2>&1`; concatenate both streams, which
    // is what the previous shell invocation produced.
    const { stdout, stderr } = await execFileAsync(
      'docker',
      ['compose', '-p', `${COMPOSE_PROJECT_PREFIX}${name}`, 'logs', `--tail=${tail}`, '--no-color'],
      { cwd: dir, env: composeChildEnv(), encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
    return stdout + stderr;
  } catch {
    return '(error fetching logs)';
  }
}
