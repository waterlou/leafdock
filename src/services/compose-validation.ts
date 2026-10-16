import * as fs from 'fs';
import * as path from 'path';
import { parseDocument } from 'yaml';

/**
 * Host-safety policy for uploaded compose files.
 *
 * Leafdock runs `docker compose up` on the NAS host with a mounted docker
 * socket, so a compose file is effectively a root request against that host:
 * `network_mode: host` + `cap_add: [NET_ADMIN]` is enough to rewrite the host
 * firewall, `pid: host` exposes the host process table, `privileged: true` is
 * plain root, and a bind mount of `/` reads every file. A compose file that
 * can be uploaded by anyone holding the API key must therefore be *validated
 * before it is executed*, not merely stored.
 *
 * The policy is an allowlist: every service key, build key, mount key and
 * top-level key must be named below. A compose key that is not listed is
 * rejected, so a future/rare option (or a typo) can never silently reach the
 * daemon. Adding a key is a deliberate review step — that is the point.
 *
 * Rejections are collected and reported together (see ComposePolicyError), so
 * an author sees every problem at once instead of one per deploy attempt.
 */

export class ComposePolicyError extends Error {
  readonly code = 'compose_policy_violation';
  readonly violations: string[];

  constructor(violations: string[]) {
    const list = violations.length > 0 ? violations : ['compose file rejected by host-safety policy'];
    super(
      list.length === 1
        ? `Compose file rejected by host-safety policy: ${list[0]}`
        : `Compose file rejected by host-safety policy (${list.length} violations):\n- ${list.join('\n- ')}`
    );
    this.name = 'ComposePolicyError';
    this.violations = list;
  }
}

// --- policy tables ---------------------------------------------------------

// `x-*` extension keys are allowed at every level (anchors/aliases), `version`
// is accepted for older files, `name` sets the compose project name.
const ALLOWED_TOP_LEVEL_KEYS = new Set(['version', 'name', 'services', 'volumes', 'networks']);

// Deliberately absent: privileged, cap_add, devices, device_cgroup_rules, pid,
// ipc, network_mode, userns_mode, uts, cgroup, cgroup_parent, group_add,
// sysctls, volumes_from, extends, runtime, external_links, container_name,
// storage_opt, secrets, configs, and anything else not listed here.
const ALLOWED_SERVICE_KEYS = new Set([
  'image', 'build', 'command', 'entrypoint', 'environment', 'env_file', 'expose',
  'ports', 'restart', 'depends_on', 'healthcheck', 'labels', 'logging', 'networks',
  'volumes', 'tmpfs', 'working_dir', 'user', 'read_only', 'init', 'tty', 'stdin_open',
  'hostname', 'domainname', 'mac_address', 'platform', 'profiles', 'extra_hosts',
  'dns', 'dns_search', 'dns_opt', 'security_opt', 'cap_drop', 'ulimits', 'deploy',
  'stop_grace_period', 'stop_signal', 'shm_size', 'pids_limit', 'cpus', 'cpu_shares',
  'cpu_quota', 'cpu_period', 'cpuset', 'mem_limit', 'mem_reservation', 'memswap_limit',
  'mem_swappiness', 'oom_score_adj',
]);

// `privileged`, `network`, `entitlements`, `extra_hosts`, `isolation` and
// `ssh` are intentionally absent: a build must not be able to request host
// namespaces or BuildKit's security.insecure entitlement.
const ALLOWED_BUILD_KEYS = new Set([
  'context', 'dockerfile', 'args', 'target', 'labels', 'cache_from', 'cache_to',
  'shm_size', 'platforms', 'pull', 'no_cache', 'tags',
]);

const ALLOWED_MOUNT_KEYS = new Set([
  'type', 'source', 'target', 'read_only', 'consistency', 'bind', 'volume', 'tmpfs',
]);
const ALLOWED_BIND_KEYS = new Set(['create_host_path', 'propagation', 'selinux']);
const ALLOWED_VOLUME_DRIVER_KEYS = new Set(['nocopy', 'subpath']);
const ALLOWED_TMPFS_KEYS = new Set(['size', 'mode']);

// `driver_opts` (bind a host path behind a named volume) and `external` (reach
// a volume created elsewhere) are both rejected — see checkVolumeDefinition.
const ALLOWED_VOLUME_DEF_KEYS = new Set(['name', 'driver', 'labels']);

// `external` is rejected (see checkNetworkDefinitions): attaching to a network
// created outside this app reaches every other project that uses it. `driver_opts`
// (macvlan/ipvlan parent=eth0 attaches to the host NIC) and `driver: host` are
// rejected too, as is a `name` that is not a plain network name.
const ALLOWED_NETWORK_DEF_KEYS = new Set(['name', 'driver', 'internal', 'labels', 'attachable', 'enable_ipv4', 'enable_ipv6']);
const ALLOWED_NETWORK_DRIVERS = new Set(['bridge', 'default']);

// A docker network name: no '/', no whitespace, no leading separator. An
// unvalidated name reaches the daemon verbatim (`name: /tmp/x` used to create a
// network literally called `/tmp/x`).
const NETWORK_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

const ALLOWED_PORT_KEYS = new Set(['target', 'published', 'host_ip', 'protocol', 'mode', 'name', 'app_protocol']);

// syslog/journald/fluentd drivers hand container output to a host socket or a
// host-side agent; keep output inside docker's own log store.
const ALLOWED_LOGGING_DRIVERS = new Set(['json-file', 'local', 'none']);

const SERVICE_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// --- helpers --------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Resolve `p` against `appDir` and assert it stays inside. Symlinks are
 * followed for the part of the path that exists (a repo cloned by the git
 * endpoint can contain `boom -> /`, which a plain string prefix check would
 * happily accept), then the not-yet-existing remainder is appended.
 */
export function realpathInside(appDir: string, p: string): string | null {
  if (p === '' || p.includes('\0') || p.startsWith('~')) return null;
  const resolved = path.resolve(appDir, p);
  const realDir = realpathOf(appDir);
  const realTarget = realpathOf(resolved);
  const rel = path.relative(realDir, realTarget);
  if (rel === '') return realTarget;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return realTarget;
}

const realpathCache = new Map<string, string>();

function realpathOf(p: string): string {
  const cached = realpathCache.get(p);
  if (cached !== undefined) return cached;

  let existing = p;
  const tail: string[] = [];
  // Walk up to the deepest existing ancestor (the mount target may not exist
  // yet when create_host_path is set).
  for (;;) {
    try {
      const real = fs.realpathSync(existing);
      const out = tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
      realpathCache.set(p, out);
      return out;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) {
        realpathCache.set(p, p);
        return p;
      }
      tail.push(path.basename(existing));
      existing = parent;
    }
  }
}

/** 'any' allows every host port; a list allows exactly those (ranges expand). */
export interface PortAllowance {
  any: boolean;
  ports: Set<number>;
  raw: string;
}

/** Host paths a bind mount may use in addition to the app directory. */
export interface BindPathAllowance {
  roots: string[];
  raw: string;
}

// Paths an app must never reach, even if an admin lists them by mistake: the
// filesystem root, the kernel pseudo-filesystems, and the docker socket (a
// socket mount inside a container is host root).
const FORBIDDEN_BIND_PATHS = ['/', '/proc', '/sys', '/dev', '/etc'];

function resolveExisting(p: string): string {
  const real = realpathOf(path.resolve(p));
  return real.length > 1 ? real.replace(/\/+$/, '') : real;
}

function isForbiddenBindPath(real: string): boolean {
  const socket = resolveExisting(process.env.DOCKER_SOCKET || '/var/run/docker.sock');
  if (real === socket) return true;
  if (real.endsWith('/docker.sock')) return true;
  return FORBIDDEN_BIND_PATHS.some(p => real === resolveExisting(p));
}

/**
 * LEAFDOCK_ALLOWED_BIND_PATHS — comma/space separated absolute host paths that
 * apps may bind-mount. **Disabled by default**: with the variable unset (or
 * empty) an app can only bind-mount inside its own directory. Entries that are
 * relative, that resolve to one of FORBIDDEN_BIND_PATHS, or that point at the
 * docker socket are ignored, and the ignored list is reported in `raw` so a
 * misconfiguration is visible rather than silently permissive.
 */
export function parseAllowedBindPaths(raw: string | undefined): BindPathAllowance {
  const value = (raw ?? '').trim();
  if (value === '') return { roots: [], raw: 'none (app directory only)' };

  const roots: string[] = [];
  const ignored: string[] = [];
  for (const part of value.split(/[\s,;]+/).filter(s => s !== '')) {
    if (!path.isAbsolute(part) || part.startsWith('~')) {
      ignored.push(part);
      continue;
    }
    const real = resolveExisting(part);
    if (isForbiddenBindPath(real)) {
      ignored.push(part);
      continue;
    }
    roots.push(real);
  }

  const label = roots.length > 0 ? roots.join(', ') : 'none (app directory only)';
  return { roots, raw: ignored.length > 0 ? `${label}; ignored: ${ignored.join(', ')}` : label };
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function describeAllowed(allowance: BindPathAllowance): string {
  return allowance.roots.length > 0
    ? `allowed host paths: ${allowance.raw}`
    : 'no host paths are allowed (set LEAFDOCK_ALLOWED_BIND_PATHS to opt in)';
}

export function parseAllowedHostPorts(raw: string | undefined): PortAllowance {
  const value = (raw ?? '').trim();
  if (value === '') return { any: false, ports: new Set(), raw: 'none' };
  if (value.toLowerCase() === 'any' || value === '*') return { any: true, ports: new Set(), raw: 'any' };

  const ports = new Set<number>();
  for (const part of value.split(/[\s,]+/).filter(s => s !== '')) {
    const range = /^(\d{1,5})-(\d{1,5})$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let p = Math.min(from, to); p <= Math.max(from, to); p++) ports.add(p);
      continue;
    }
    if (/^\d{1,5}$/.test(part)) ports.add(Number(part));
  }
  return { any: false, ports, raw: [...ports].sort((a, b) => a - b).join(',') || 'none' };
}

// --- validator ------------------------------------------------------------

export interface ComposePolicyOptions {
  /** Absolute app directory; builds and env_files must stay inside it. */
  appDir: string;
  /** Raw LEAFDOCK_ALLOWED_HOST_PORTS value. */
  allowedHostPorts?: string;
  /** Raw LEAFDOCK_ALLOWED_BIND_PATHS value (host paths bind mounts may use). */
  allowedBindPaths?: string;
}

export interface ComposePolicyResult {
  valid: boolean;
  violations: string[];
  services: string[];
}

interface Policy {
  appDir: string;
  ports: PortAllowance;
  bindRoots: BindPathAllowance;
}

/** Parse + validate compose text. Never throws for policy reasons — use `assert`. */
export function inspectCompose(text: string, opts: ComposePolicyOptions): ComposePolicyResult {
  const violations: string[] = [];
  const policy: Policy = {
    appDir: opts.appDir,
    ports: parseAllowedHostPorts(opts.allowedHostPorts),
    bindRoots: parseAllowedBindPaths(opts.allowedBindPaths),
  };

  const doc = parseDocument(text, { merge: true, uniqueKeys: true });
  for (const err of doc.errors) {
    violations.push(`YAML error: ${err.message.split('\n')[0]}`);
  }
  if (violations.length > 0) return { valid: false, violations, services: [] };

  let root: unknown;
  try {
    root = doc.toJS({ merge: true, maxAliasCount: 1000 });
  } catch (err) {
    return { valid: false, violations: [`YAML error: ${(err as Error).message}`], services: [] };
  }

  if (!isRecord(root)) {
    return { valid: false, violations: ['compose file must be a YAML mapping of keys'], services: [] };
  }

  checkTopLevelKeys(root, violations);
  const services = checkServices(root, policy, violations);
  checkVolumeDefinitions(root, violations);
  checkNetworkDefinitions(root, violations);

  if (services.length === 0) {
    violations.push('compose file must define at least one service under "services"');
  }

  return { valid: violations.length === 0, violations, services };
}

/** Throwing flavour: raises ComposePolicyError with every violation. */
export function assertComposeAllowed(text: string, opts: ComposePolicyOptions): void {
  const result = inspectCompose(text, opts);
  if (!result.valid) throw new ComposePolicyError(result.violations);
}

/** Read + validate a compose file (throwing flavour). */
export function validateComposeFile(file: string, opts: ComposePolicyOptions): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    throw new ComposePolicyError([`compose file ${path.basename(file)} not found in the app directory`]);
  }
  assertComposeAllowed(text, opts);
}

// --- top level ------------------------------------------------------------

function checkTopLevelKeys(root: Record<string, unknown>, problems: string[]): void {
  for (const key of Object.keys(root)) {
    if (key.startsWith('x-') || ALLOWED_TOP_LEVEL_KEYS.has(key)) continue;
    if (key === 'secrets' || key === 'configs') {
      problems.push(`"${key}" at the top level can read arbitrary host files into a container and is not allowed`);
      continue;
    }
    if (key === 'include') {
      problems.push('"include" can pull in compose files from arbitrary host paths and is not allowed');
      continue;
    }
    problems.push(`unsupported top-level key "${key}"`);
  }
}

function checkServices(
  root: Record<string, unknown>,
  policy: Policy,
  problems: string[]
): string[] {
  const raw = root.services;
  if (raw === undefined) {
    problems.push('missing required "services" section');
    return [];
  }
  if (!isRecord(raw)) {
    problems.push('"services" must be a mapping of service name to definition');
    return [];
  }

  const names = Object.keys(raw);
  for (const name of names) {
    if (!SERVICE_NAME_REGEX.test(name)) {
      problems.push(`invalid service name "${name}" (letters, digits, ".", "_", "-")`);
      continue;
    }
    const service = raw[name];
    if (!isRecord(service)) {
      problems.push(`service "${name}" must be a mapping`);
      continue;
    }
    checkService(name, service, policy, problems);
  }
  return names;
}

function checkService(
  name: string,
  service: Record<string, unknown>,
  policy: Policy,
  problems: string[]
): void {
  const at = (msg: string) => `${name}: ${msg}`;

  for (const key of Object.keys(service)) {
    if (key.startsWith('x-')) continue;
    if (!ALLOWED_SERVICE_KEYS.has(key)) {
      problems.push(at(denyReason(key)));
      continue;
    }
  }

  checkBuild(name, service.build, policy.appDir, problems);
  checkEnvFile(name, service.env_file, policy.appDir, problems);
  checkVolumes(name, service.volumes, policy, problems);
  checkPorts(name, service.ports, policy.ports, problems);
  checkServiceNetworks(name, service.networks, problems);
  checkSecurityOpt(name, service.security_opt, policy.appDir, problems);
  checkLogging(name, service.logging, problems);
}

// Deny messages name the actual escape, so a rejected deploy explains itself
// instead of sending the author to the source.
const DENY_REASONS: Record<string, string> = {
  privileged: 'granting a service "privileged" is host root — not allowed',
  cap_add: '"cap_add" hands the container host capabilities (NET_ADMIN alone rewrites the host firewall) — not allowed',
  devices: '"devices" exposes host devices to the container — not allowed',
  device_cgroup_rules: '"device_cgroup_rules" loosens the host device cgroup — not allowed',
  pid: 'sharing the host PID namespace ("pid: host") is not allowed',
  ipc: 'sharing the host IPC namespace ("ipc: host") is not allowed',
  uts: 'sharing the host UTS namespace ("uts: host") is not allowed',
  network_mode: '"network_mode" is not allowed — services run on the leafdock network and are routed by Caddy',
  userns_mode: '"userns_mode" can disable user-namespace isolation — not allowed',
  cgroup: '"cgroup" can join a host cgroup namespace — not allowed',
  cgroup_parent: '"cgroup_parent" can join a host cgroup — not allowed',
  group_add: '"group_add" can add the container user to host groups (e.g. docker) — not allowed',
  sysctls: '"sysctls" can change host kernel settings — not allowed',
  volumes_from: '"volumes_from" copies another container\'s mounts (including the docker socket) — not allowed',
  extends: '"extends" pulls service definitions from files outside this app — not allowed',
  runtime: 'a non-default "runtime" (e.g. nvidia/sysbox) is not allowed',
  external_links: '"external_links" reaches containers outside this app — not allowed',
  container_name: 'leafdock assigns container names (Caddy routes by them) — "container_name" is not allowed',
  storage_opt: '"storage_opt" is per-container storage-driver configuration — not allowed',
  secrets: '"secrets" can read host files into the container — not allowed',
  configs: '"configs" can read host files into the container — not allowed',
  isolation: '"isolation" changes the container runtime isolation mode — not allowed',
  annotations: 'OCI "annotations" are not supported',
  credential_spec: '"credential_spec" reaches host credential providers — not allowed',
  cpu_rt_runtime: '"cpu_rt_runtime" requires host realtime scheduling privileges — not allowed',
  cpu_rt_period: '"cpu_rt_period" requires host realtime scheduling privileges — not allowed',
  gpus: '"gpus" exposes host GPUs to the container — not allowed',
};

function denyReason(key: string): string {
  const known = DENY_REASONS[key];
  if (known && known !== '') return known;
  return `unsupported service key "${key}" — the host-safety allowlist rejects keys it does not know`;
}

function checkBuild(name: string, build: unknown, appDir: string, problems: string[]): void {
  if (build === undefined) return;
  const at = (msg: string) => `${name}: ${msg}`;

  if (typeof build === 'string') {
    checkPathInside(name, 'build context', build, appDir, problems);
    return;
  }
  if (!isRecord(build)) {
    problems.push(at('"build" must be a path or a mapping'));
    return;
  }
  for (const key of Object.keys(build)) {
    if (key.startsWith('x-')) continue;
    if (ALLOWED_BUILD_KEYS.has(key)) continue;
    if (key === 'privileged' || key === 'entitlements') {
      problems.push(at(`build "${key}" requests build privileges (a privileged build step is host root) — not allowed`));
      continue;
    }
    if (key === 'network') {
      problems.push(at('build "network" would run build steps on a host-provided network — not allowed'));
      continue;
    }
    problems.push(at(`unsupported build key "${key}"`));
  }
  if (build.context !== undefined) {
    if (typeof build.context !== 'string') {
      problems.push(at('build "context" must be a path string'));
    } else if (/^[a-z]+:\/\//i.test(build.context)) {
      problems.push(at('a remote build "context" is not allowed — upload the source or use the git endpoint'));
    } else {
      checkPathInside(name, 'build context', build.context, appDir, problems);
    }
  }
  if (build.dockerfile !== undefined) {
    if (typeof build.dockerfile !== 'string') {
      problems.push(at('build "dockerfile" must be a path string'));
    } else {
      checkPathInside(name, 'Dockerfile', build.dockerfile, appDir, problems);
    }
  }
  if (build.pull !== undefined && typeof build.pull !== 'boolean') {
    problems.push(at('build "pull" must be a boolean'));
  }
}

function checkEnvFile(name: string, envFile: unknown, appDir: string, problems: string[]): void {
  if (envFile === undefined) return;
  for (const entry of asArray(envFile)) {
    if (typeof entry !== 'string') {
      problems.push(`${name}: "env_file" entries must be paths`);
      continue;
    }
    checkPathInside(name, 'env_file', entry, appDir, problems);
  }
}

// Short syntax: [SOURCE:]TARGET[:MODE]. SOURCE starting with '/', '.' or '~'
// is a host path (bind); anything else is a named volume.
function checkVolumes(name: string, volumes: unknown, policy: Policy, problems: string[]): void {
  if (volumes === undefined) return;
  if (!Array.isArray(volumes)) {
    problems.push(`${name}: "volumes" must be a list`);
    return;
  }
  volumes.forEach((entry, index) => {
    const where = `volumes[${index}]`;
    if (typeof entry === 'string') {
      checkShortMount(name, where, entry, policy, problems);
      return;
    }
    if (!isRecord(entry)) {
      problems.push(`${name}: ${where} must be a string or a mapping`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (key.startsWith('x-')) continue;
      if (!ALLOWED_MOUNT_KEYS.has(key)) {
        problems.push(`${name}: ${where} has unsupported key "${key}"`);
      }
    }
    const type = entry.type ?? 'volume';
    if (type !== 'bind' && type !== 'volume' && type !== 'tmpfs') {
      problems.push(`${name}: ${where} has unsupported mount type "${String(type)}"`);
      return;
    }
    if (type === 'bind') {
      if (typeof entry.source !== 'string') {
        problems.push(`${name}: ${where} bind mount needs a "source" path`);
      } else {
        checkBindSource(name, `${where} bind source`, entry.source, policy, problems);
      }
    }
    if (entry.bind !== undefined) {
      if (!isRecord(entry.bind)) {
        problems.push(`${name}: ${where} "bind" must be a mapping`);
      } else {
        for (const key of Object.keys(entry.bind)) {
          if (!ALLOWED_BIND_KEYS.has(key)) {
            problems.push(`${name}: ${where} has unsupported bind option "${key}"`);
            continue;
          }
          if (key === 'propagation' && entry.bind[key] !== undefined && entry.bind[key] !== 'rprivate') {
            problems.push(`${name}: ${where} bind propagation "${String(entry.bind[key])}" shares host mount events — not allowed`);
          }
        }
      }
    }
    if (entry.volume !== undefined) {
      if (!isRecord(entry.volume)) {
        problems.push(`${name}: ${where} "volume" must be a mapping`);
      } else {
        for (const key of Object.keys(entry.volume)) {
          if (!ALLOWED_VOLUME_DRIVER_KEYS.has(key)) {
            problems.push(`${name}: ${where} has unsupported volume option "${key}"`);
          }
        }
      }
    }
    if (entry.tmpfs !== undefined) {
      if (!isRecord(entry.tmpfs)) {
        problems.push(`${name}: ${where} "tmpfs" must be a mapping`);
      } else {
        for (const key of Object.keys(entry.tmpfs)) {
          if (!ALLOWED_TMPFS_KEYS.has(key)) {
            problems.push(`${name}: ${where} has unsupported tmpfs option "${key}"`);
          }
        }
      }
    }
    if (entry.target !== undefined && typeof entry.target !== 'string') {
      problems.push(`${name}: ${where} "target" must be a container path`);
    }
  });
}

// Short syntax is SOURCE:TARGET[:MODE]; a single segment is an anonymous volume
// (target only).
//
// Compose reads a single-letter prefix followed by ':' as a Windows drive letter
// and therefore does NOT split `v:/data` into SOURCE:TARGET at all: the daemon
// receives an anonymous volume whose mount path is the literal string `v:/data`
// and refuses to start it ("mount path must be absolute"). Verified against the
// compose CLI leafdock ships: `v:/data` → `type: volume, target: v:/data` →
// up fails, while the long syntax (`type: volume, source: v, target: /data`)
// starts fine, as does any multi-letter name (`db:/data`, `1:/data`). So the
// rejection is correct — only the reason was misreported as "a Windows path",
// which sent authors looking in the wrong place. Both shapes land here.
function checkShortMount(name: string, where: string, entry: string, policy: Policy, problems: string[]): void {
  if (/^[A-Za-z]:[\\/]/.test(entry)) {
    problems.push(
      `${name}: ${where} "${entry}" begins with a single-letter "X:" prefix, which docker compose reads as a Windows drive letter — the mount is then rejected as non-absolute. For a single-letter named volume use the long syntax ({ type: volume, source: v, target: /data }); a Windows host path is not supported on the NAS.`
    );
    return;
  }
  const parts = entry.split(':');
  const target = parts.length === 1 ? parts[0] : parts[1];
  const source = parts.length === 1 ? null : parts[0];

  if (target === undefined || target.trim() === '' || !target.startsWith('/')) {
    problems.push(`${name}: ${where} needs an absolute container path (got "${entry}")`);
    return;
  }
  if (source === null || source === '') return; // anonymous volume

  if (source.startsWith('/') || source.startsWith('.') || source.startsWith('~')) {
    checkBindSource(name, `${where} host path`, source, policy, problems);
    return;
  }
  if (source.includes('/')) {
    problems.push(`${name}: ${where} names a volume with a path separator ("${source}") — use ./relative/path for a bind mount`);
  }
}

// Builds and env_files read host files into an image/container, so they stay
// inside the app directory — no opt-in.
function checkPathInside(
  service: string,
  what: string,
  candidate: string,
  appDir: string,
  problems: string[]
): void {
  if (isRemoteContext(candidate)) {
    problems.push(service + ': ' + what + ' "' + candidate + '" is a remote URL — upload the source or use the git endpoint');
    return;
  }
  const resolved = realpathInside(appDir, candidate);
  if (resolved === null) {
    problems.push(
      `${service}: ${what} "${candidate}" is outside the app directory — apps may only mount/build from their own folder`
    );
  }
}

// Compose accepts remote build contexts (git/URL) — those fetch code from
// somewhere the app author points at, so they are rejected in favour of the
// upload/git endpoints.
function isRemoteContext(candidate: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) || /^git@/i.test(candidate);
}

// Bind mounts may use the app directory, or a host path an admin approved via
// LEAFDOCK_ALLOWED_BIND_PATHS (empty by default → app directory only).
function checkBindSource(
  service: string,
  what: string,
  candidate: string,
  policy: Policy,
  problems: string[]
): void {
  if (realpathInside(policy.appDir, candidate) !== null) return;

  if (candidate.startsWith('~')) {
    problems.push(`${service}: ${what} "${candidate}" uses a home-relative path, which is not supported`);
    return;
  }
  // Absolute paths and './relative' paths are both bind mounts; anything else
  // is a named volume (handled by the caller).
  const real = resolveExisting(path.resolve(policy.appDir, candidate));
  if (isForbiddenBindPath(real)) {
    problems.push(`${service}: ${what} "${candidate}" is a host-reserved path and can never be mounted`);
    return;
  }
  if (policy.bindRoots.roots.some(root => isInside(root, real))) return;

  problems.push(
    `${service}: ${what} "${candidate}" is outside the app directory — ${describeAllowed(policy.bindRoots)}`
  );
}

function checkPorts(name: string, ports: unknown, allowance: PortAllowance, problems: string[]): void {
  if (ports === undefined) return;
  if (!Array.isArray(ports)) {
    problems.push(`${name}: "ports" must be a list`);
    return;
  }
  ports.forEach((entry, index) => {
    const where = `ports[${index}]`;
    const published = publishedHostPorts(name, where, entry, problems);
    for (const port of published) {
      if (allowance.any || allowance.ports.has(port)) continue;
      problems.push(
        `${name}: ${where} publishes host port ${port}. Apps are routed through Caddy and must not claim host ports ` +
          `(a published port shadows whatever the host already serves there, including 22/8686). ` +
          `An admin can opt in with LEAFDOCK_ALLOWED_HOST_PORTS (currently: ${allowance.raw}).`
      );
    }
  });
}

function publishedHostPorts(name: string, where: string, entry: unknown, problems: string[]): number[] {
  if (typeof entry === 'number') return []; // container port only → ephemeral host port
  if (typeof entry === 'string') return parseShortPorts(name, where, entry, problems);
  if (isRecord(entry)) {
    for (const key of Object.keys(entry)) {
      if (key.startsWith('x-')) continue;
      if (!ALLOWED_PORT_KEYS.has(key)) {
        problems.push(`${name}: ${where} has unsupported key "${key}"`);
      }
    }
    const published = entry.published;
    if (published === undefined || published === null || published === '' || published === 0 || published === '0') return [];
    return expandPortSpec(name, where, String(published), problems);
  }
  problems.push(`${name}: ${where} must be a string or a mapping`);
  return [];
}

// Short syntax is TARGET | PUBLISHED:TARGET | HOST_IP:PUBLISHED:TARGET, with an
// optional /protocol suffix. A target-only spec gets an ephemeral host port,
// which cannot shadow a known host service — allowed.
function parseShortPorts(name: string, where: string, entry: string, problems: string[]): number[] {
  const [spec, protocol] = entry.split('/');
  if (protocol !== undefined) {
    const proto = protocol.toLowerCase();
    if (proto !== 'tcp' && proto !== 'udp' && proto !== 'sctp') {
      problems.push(`${name}: ${where} has unknown protocol "${protocol}"`);
      return [];
    }
  }

  let body = spec;
  if (body.startsWith('[')) {
    const end = body.indexOf(']');
    if (end === -1) {
      problems.push(`${name}: ${where} has an unparsable host address ("${entry}")`);
      return [];
    }
    body = body.slice(end + 1).replace(/^:/, '');
  }

  const parts = body.split(':');
  if (parts.length === 1) return []; // container port only → ephemeral host port
  if (parts.length === 2) return expandPortSpec(name, where, parts[0], problems);
  if (parts.length === 3) return expandPortSpec(name, where, parts[1], problems);
  problems.push(`${name}: ${where} has an unparsable port spec ("${entry}")`);
  return [];
}

function expandPortSpec(name: string, where: string, spec: string, problems: string[]): number[] {
  const single = /^(\d{1,5})$/.exec(spec);
  if (single) return [Number(single[1])];
  const range = /^(\d{1,5})-(\d{1,5})$/.exec(spec);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    const count = Math.abs(to - from) + 1;
    if (count > 256) {
      problems.push(`${name}: ${where} publishes a range of ${count} host ports — list them explicitly (max 256)`);
      return [];
    }
    const out: number[] = [];
    for (let p = Math.min(from, to); p <= Math.max(from, to); p++) out.push(p);
    return out;
  }
  problems.push(`${name}: ${where} has an unparsable host port spec "${spec}"`);
  return [];
}

function checkServiceNetworks(name: string, networks: unknown, problems: string[]): void {
  if (networks === undefined) return;
  const entries = Array.isArray(networks)
    ? networks
    : isRecord(networks)
      ? Object.keys(networks)
      : null;
  if (entries === null) {
    problems.push(`${name}: "networks" must be a list or a mapping`);
    return;
  }
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      problems.push(`${name}: "networks" entries must be network names`);
      continue;
    }
    if (entry === 'host' || entry === 'none') {
      problems.push(`${name}: joining the reserved "${entry}" network is not allowed`);
    }
  }
}

// security_opt may harden a service but must not weaken it. `no-new-privileges`
// is the safe flag; a custom seccomp profile is allowed only from the app's own
// directory (a profile can restrict syscalls but never add privileges, so the
// only thing worth policing is where it is read from). Everything else —
// `seccomp=unconfined`, `apparmor=unconfined`, `label=disable` — is refused.
function checkSecurityOpt(name: string, value: unknown, appDir: string, problems: string[]): void {
  if (value === undefined) return;
  for (const entry of asArray(value)) {
    if (typeof entry !== 'string') {
      problems.push(`${name}: security_opt entry must be a string`);
      continue;
    }
    const trimmed = entry.trim();
    if (/^no-new-privileges(:true)?$/i.test(trimmed)) continue;

    const seccomp = /^seccomp\s*[:=]\s*(.+)$/i.exec(trimmed);
    if (seccomp) {
      const profile = seccomp[1].trim();
      if (/^unconfined$/i.test(profile)) {
        problems.push(`${name}: security_opt "seccomp=unconfined" disables the syscall filter — drop the entry instead`);
        continue;
      }
      if (realpathInside(appDir, profile) === null) {
        problems.push(`${name}: seccomp profile "${profile}" is outside the app directory — apps may only use a profile from their own folder`);
      }
      continue;
    }

    problems.push(
      `${name}: security_opt "${trimmed}" weakens isolation (apparmor/label=disable) — only "no-new-privileges" and a seccomp profile from the app directory are allowed`
    );
  }
}

function checkLogging(name: string, value: unknown, problems: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    problems.push(`${name}: "logging" must be a mapping`);
    return;
  }
  const driver = value.driver;
  if (driver === undefined) return;
  if (typeof driver !== 'string' || !ALLOWED_LOGGING_DRIVERS.has(driver)) {
    problems.push(`${name}: logging driver "${String(driver)}" writes to a host-side sink — use json-file, local or none`);
  }
}

function checkVolumeDefinitions(root: Record<string, unknown>, problems: string[]): void {
  const volumes = root.volumes;
  if (volumes === undefined) return;
  if (!isRecord(volumes)) {
    problems.push('"volumes" at the top level must be a mapping');
    return;
  }
  for (const [key, def] of Object.entries(volumes)) {
    if (def === null || def === undefined) continue;
    if (!isRecord(def)) {
      problems.push(`volumes.${key} must be a mapping`);
      continue;
    }
    for (const opt of Object.keys(def)) {
      if (opt.startsWith('x-')) continue;
      if (opt === 'driver_opts') {
        problems.push(`volumes.${key}: "driver_opts" can bind a host path (device/o=bind) into a named volume — not allowed`);
        continue;
      }
      if (opt === 'external') {
        problems.push(`volumes.${key}: "external" reaches volumes created outside this app — declare a normal volume instead`);
        continue;
      }
      if (opt === 'driver') {
        if (def.driver !== 'local') {
          problems.push(`volumes.${key}: volume driver "${String(def.driver)}" is not allowed`);
        }
        continue;
      }
      if (!ALLOWED_VOLUME_DEF_KEYS.has(opt)) {
        problems.push(`volumes.${key}: unsupported key "${opt}"`);
      }
    }
  }
}

function checkNetworkDefinitions(root: Record<string, unknown>, problems: string[]): void {
  const networks = root.networks;
  if (networks === undefined) return;
  if (!isRecord(networks)) {
    problems.push('"networks" at the top level must be a mapping');
    return;
  }
  for (const [key, def] of Object.entries(networks)) {
    if (def === null || def === undefined) continue;
    if (!isRecord(def)) {
      problems.push(`networks.${key} must be a mapping`);
      continue;
    }
    for (const opt of Object.keys(def)) {
      if (opt.startsWith('x-')) continue;
      if (opt === 'driver_opts') {
        problems.push(`networks.${key}: "driver_opts" can attach a network to a host interface (macvlan/ipvlan) — not allowed`);
        continue;
      }
      if (opt === 'external') {
        problems.push(`networks.${key}: "external" joins a network created outside this app, reaching every other project on it — declare a normal network instead`);
        continue;
      }
      if (opt === 'name') {
        const desired = def.name;
        if (typeof desired !== 'string' || !NETWORK_NAME_REGEX.test(desired)) {
          problems.push(`networks.${key}: "name" must be a plain docker network name — not allowed`);
        } else if (desired === 'host' || desired === 'none' || desired === 'bridge') {
          problems.push(`networks.${key}: the built-in "${desired}" network is not allowed`);
        }
        continue;
      }
      if (opt === 'driver') {
        const driver = def.driver;
        if (typeof driver !== 'string' || !ALLOWED_NETWORK_DRIVERS.has(driver)) {
          problems.push(`networks.${key}: network driver "${String(driver)}" is not allowed (bridge, default)`);
        }
        continue;
      }
      if (!ALLOWED_NETWORK_DEF_KEYS.has(opt)) {
        problems.push(`networks.${key}: unsupported key "${opt}"`);
      }
    }
  }
}
