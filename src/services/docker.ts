import Docker from 'dockerode';
import * as os from 'os';
import * as path from 'path';
import type { MountSettings } from 'dockerode';
import { DockerError } from './errors';

// Resolved lazily so tests (and any embedder) can point DOCKER_SOCKET at a
// throwaway socket after import instead of reaching the host daemon.
let dockerClient: Docker | null = null;
function dockerClientInstance(): Docker {
  if (!dockerClient) {
    dockerClient = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
  }
  return dockerClient;
}
const docker = new Proxy({} as Docker, {
  get(_target, prop) {
    const client = dockerClientInstance() as unknown as Record<PropertyKey, unknown>;
    const value = client[prop];
    return typeof value === 'function' ? (value as Function).bind(client) : value;
  },
});

function toDockerError(err: unknown): DockerError {
  const msg = err instanceof Error ? err.message : String(err);
  // Keep the original error as the cause: dockerode carries the daemon's status
  // code and body there, which is what distinguishes a client-side input error
  // (bad image/port) from an infrastructure failure (socket down, EACCES).
  return new DockerError(msg, { cause: err });
}

interface DockerAppConfig {
  image: string;
  port: number;
  env: Record<string, string>;
  command?: string;
  cpu_limit: string;
  mem_limit: string;
  build_command?: string;
  run_command?: string;
}

export function containerNameForApp(name: string): string {
  return `ld-app-${name}`;
}

export async function createContainer(
  appName: string,
  workDir: string,
  config: DockerAppConfig
): Promise<string> {
  const containerName = containerNameForApp(appName);
  try {
    // Remove existing container with same name if any
    await removeContainerIfExists(containerName);

    // P2: build once in a one-shot container before the app container starts.
    // Builds share the app volume, so outputs (node_modules/.next) persist and
    // the app container's command is just the run command — restarts stay fast.
    if (config.build_command) {
      await runBuildContainer(appName, workDir, config);
    }

    const envVars = Object.entries(config.env).map(([k, v]) => `${k}=${v}`);
    const runCmd = config.run_command || config.command;

    const container = await docker.createContainer({
      name: containerName,
      Image: config.image,
      Env: envVars,
      Cmd: runCmd ? ['sh', '-c', runCmd] : undefined,
      WorkingDir: CONTAINER_APP_ROOT,
      ExposedPorts: {
        [`${config.port}/tcp`]: {},
      },
      HostConfig: {
        Mounts: [await appVolumeMount(workDir)],
        CpuShares: parseCpuLimit(config.cpu_limit),
        Memory: parseMemLimit(config.mem_limit),
        NetworkMode: 'leafdock_default', // shared Docker network
        RestartPolicy: {
          Name: 'unless-stopped',
        },
      },
    });

    await container.start();
    return containerName;
  } catch (err) {
    // A container that exists but never started is invisible to the API (no DB
    // row is written when create fails) yet permanently occupies its name, so
    // the next create for this app silently force-removes it. Drop it here.
    await docker.getContainer(containerName).remove({ force: true }).catch(() => {});
    throw toDockerError(err);
  }
}

// The shared storage between leafdock and app containers. Explicit APP_VOLUME
// wins (host path → bind, name → volume); otherwise ask the Docker daemon what
// THIS container mounts at DATA_DIR and mount the same store into app
// containers — named volume and NAS bind-mount layouts both work with zero
// configuration. Resolved once and cached.
let storageCache: Promise<{ Type: 'volume' | 'bind'; Source: string }> | null = null;

function appStorage(): Promise<{ Type: 'volume' | 'bind'; Source: string }> {
  const explicit = process.env.APP_VOLUME;
  if (explicit) {
    // An absolute APP_VOLUME becomes a read-write host bind mounted into every
    // app container at /app, so a typo (`APP_VOLUME=/`, or a stray path from
    // the environment) hands every app the whole host filesystem. Fail closed
    // on values that cannot be a storage directory, so a misconfiguration is
    // loud at the first deploy instead of silently permissive.
    const isBind = explicit.startsWith('/') || /^[A-Za-z]:[\\/]/.test(explicit);
    if (isBind) {
      const resolved = path.resolve(explicit);
      if (resolved === '/' || resolved === path.dirname(resolved)) {
        throw new DockerError(
          `APP_VOLUME must not be the filesystem root (got "${explicit}") — it is mounted into every app container`
        );
      }
    } else if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(explicit)) {
      throw new DockerError(
        `APP_VOLUME is neither an absolute host path nor a valid volume name (got "${explicit}")`
      );
    }
    return Promise.resolve(
      isBind ? { Type: 'bind', Source: path.resolve(explicit) } : { Type: 'volume', Source: explicit }
    );
  }
  if (!storageCache) {
    storageCache = (async () => {
      try {
        // Inside a container the hostname is the container id.
        const info = await docker.getContainer(os.hostname()).inspect();
        const mount = (info.Mounts || []).find(m => m.Destination === (process.env.DATA_DIR || '/data'));
        if (mount?.Type === 'bind' && mount.Source) return { Type: 'bind', Source: mount.Source };
        if (mount?.Type === 'volume' && mount.Name) return { Type: 'volume', Source: mount.Name };
      } catch {
        // Not running inside docker (macOS dev) — fall through.
      }
      return { Type: 'volume', Source: 'leafdock_app_data' };
    })();
  }
  return storageCache;
}

// Each app container gets exactly its own directory, never the whole store: the
// store root also holds management.db (every app's config, including
// NEXTAUTH_SECRET / GOOGLE_CLIENT_SECRET values in cleartext) and every sibling
// app's files. Mounting the store root at /app handed all of that to every app.
// The app's own directory is mounted directly at /app, so the container working
// directory is the plain `/app`; `Subpath` narrows a named volume to that one
// directory and a host bind gets the same path appended. Verified on this
// daemon: the container sees its own directory only — no management.db, no
// sibling apps. (A nested target such as /app/apps/<name> is NOT usable: the
// runtime then refuses the working directory as "outside the container mount
// namespace".)
// The app's own directory is mounted here; the container's working directory
// must be exactly this path (see appVolumeMount).
const CONTAINER_APP_ROOT = '/app';

interface AppMount extends MountSettings {
  /** Named-volume subdirectory to mount (docker >= 26). */
  VolumeOptions?: MountSettings['VolumeOptions'];
}

async function appVolumeMount(workDir: string): Promise<AppMount> {
  const storage = await appStorage();
  // workDir is a container path under /app (e.g. /app/apps/scope-a); the same
  // directory inside the store is the path with /app removed.
  if (!workDir.startsWith('/app/')) {
    throw new DockerError(`Unsupported container working directory ${workDir} — refusing to mount`);
  }
  const rel = workDir.slice('/app/'.length);
  if (rel === '' || rel.startsWith('..') || rel.includes('/../') || path.isAbsolute(rel)) {
    throw new DockerError(`App directory for ${workDir} is outside the data store — refusing to mount it`);
  }
  if (storage.Type === 'volume') {
    return {
      Type: 'volume',
      Source: storage.Source,
      Target: CONTAINER_APP_ROOT,
      VolumeOptions: { NoCopy: false, Labels: {}, DriverConfig: { Name: '', Options: {} }, Subpath: rel },
    };
  }
  return { Type: 'bind', Source: path.join(storage.Source, rel), Target: CONTAINER_APP_ROOT };
}

// Run config.build_command to completion in a throwaway container. Failures
// surface the container's log tail in the error so the API reports them.
async function runBuildContainer(appName: string, workDir: string, config: DockerAppConfig): Promise<void> {
  const buildCmd = config.build_command;
  if (!buildCmd) return;
  const buildName = `ld-build-${appName}`;
  await removeContainerIfExists(buildName);

  const envVars = Object.entries(config.env).map(([k, v]) => `${k}=${v}`);

  const container = await docker.createContainer({
    name: buildName,
    Image: config.image,
    Env: envVars,
    Cmd: ['sh', '-c', buildCmd],
    WorkingDir: CONTAINER_APP_ROOT,
    HostConfig: {
      Mounts: [await appVolumeMount(workDir)],
      CpuShares: parseCpuLimit(config.cpu_limit),
      Memory: parseMemLimit(config.mem_limit),
      NetworkMode: 'leafdock_default',
    },
  });

  await container.start();
  const status = await container.wait();
  if (status.StatusCode !== 0) {
    const logs = await container.logs({ stdout: true, stderr: true }).catch(() => Buffer.from(''));
    await container.remove({ force: true }).catch(() => {});
    const tail = logs.toString('utf-8').split('\n').slice(-40).join('\n');
    throw new Error(
      `Build failed (exit code ${status.StatusCode}) — last log lines:\n${tail}`
    );
  }
  await container.remove({ force: true });
}

// Build-split apps keep their container across stop/start so a start does not
// re-trigger the build. Plain stop/start of the existing container.
export async function stopContainerKeep(appName: string): Promise<void> {
  try {
    await docker.getContainer(containerNameForApp(appName)).stop();
  } catch (err) {
    // "already stopped" (304) and "no such container" (404) are expected; any
    // other failure must surface, otherwise the caller records status
    // 'stopped' while the container is still running and still routed.
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== 304 && status !== 404) throw toDockerError(err);
  }
}

export async function startContainer(appName: string): Promise<boolean> {
  try {
    await docker.getContainer(containerNameForApp(appName)).start();
    return true;
  } catch {
    return false; // missing — caller must create it
  }
}

async function removeContainerIfExists(containerName: string): Promise<void> {
  try {
    const containers = await docker.listContainers({ all: true });
    const existing = containers.find(c =>
      c.Names.includes(`/${containerName}`)
    );
    if (existing) {
      const container = docker.getContainer(existing.Id);
      try { await container.stop(); } catch { /* already stopped */ }
      await container.remove({ force: true });
    }
  } catch {
    // Container doesn't exist, no action needed
  }
}

export async function stopContainer(appName: string): Promise<void> {
  const containerName = containerNameForApp(appName);
  await removeContainerIfExists(containerName);
}

export async function restartContainer(appName: string): Promise<void> {
  const containerName = containerNameForApp(appName);
  try {
    const containers = await docker.listContainers({ all: true });
    const existing = containers.find(c =>
      c.Names.includes(`/${containerName}`)
    );
    if (!existing) {
      // Callers (restartApp) fall back to recreating from stored config.
      throw new DockerError(`Container ${containerName} not found`);
    }
    const container = docker.getContainer(existing.Id);
    await container.restart();
  } catch (err) {
    throw toDockerError(err);
  }
}

export async function getContainerLogs(appName: string, tail: number): Promise<string> {
  const containerName = containerNameForApp(appName);
  try {
    const containers = await docker.listContainers({ all: true });
    const existing = containers.find(c =>
      c.Names.includes(`/${containerName}`)
    );
    if (existing) {
      const container = docker.getContainer(existing.Id);
      const raw = (await container.logs({
        stdout: true,
        stderr: true,
        tail,
        timestamps: true,
      })) as Buffer;

      // Strip Docker's 8-byte stream header from each chunk
      const lines: string[] = [];
      let offset = 0;
      const buf = raw instanceof Buffer ? raw : Buffer.from(raw);
      while (offset < buf.length) {
        const header = buf.readUInt32BE(offset + 4); // length in bytes 4-7
        offset += 8;
        const line = buf.toString('utf-8', offset, offset + header);
        lines.push(line.trimEnd());
        offset += header;
      }
      return lines.join('\n');
    }
    return '(container not found)';
  } catch {
    return '(error fetching logs)';
  }
}

export async function pullImage(image: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(new DockerError(`Failed to pull image "${image}": ${err.message}`));
      docker.modem.followProgress(stream, (err) => {
        if (err) return reject(new DockerError(`Failed to pull image "${image}": ${err.message}`));
        resolve();
      });
    });
  });
}

// Docker CPU shares are relative to 1024 ("0.5" = half a core = 512 shares).
// The result is bounded to the range the daemon accepts: a huge core count
// overflows to Infinity, which JSON-serialises to null and the daemon then reads
// as "no CPU limit" — the opposite of what a limit request means. Exported so
// validation and deployment use the same arithmetic (a mismatch is how the
// overflow shipped in the first place).
const MIN_CPU_SHARES = 2;
const MAX_CPU_SHARES = 262144; // docker's accepted maximum

export function cpuSharesFromLimit(limit: string): number {
  const num = parseFloat(limit);
  return Math.round(num * 1024);
}

function parseCpuLimit(limit: string): number {
  const shares = cpuSharesFromLimit(limit);
  if (!Number.isFinite(shares) || shares < MIN_CPU_SHARES) return MIN_CPU_SHARES;
  return Math.min(shares, MAX_CPU_SHARES);
}

// Strict flavour for validation: returns NaN for anything that is not a plain
// positive size, so callers can reject it instead of silently falling back.
// parseMemLimit below keeps the lenient default for stored legacy values.
export function parseMemLimitStrict(limit: string): number {
  const match = limit.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|k|m|g)?$/);
  if (!match) return NaN;
  const num = parseFloat(match[1]);
  const unit = match[2] || 'b';
  const multipliers: Record<string, number> = {
    b: 1,
    k: 1024,
    m: 1024 * 1024,
    g: 1024 * 1024 * 1024,
  };
  return Math.round(num * multipliers[unit]);
}

function parseMemLimit(limit: string): number {
  // Parse strings like "128m", "1g" to bytes
  const match = limit.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|k|m|g)?$/);
  if (!match) return 128 * 1024 * 1024;
  const num = parseFloat(match[1]);
  const unit = match[2] || 'b';
  const multipliers: Record<string, number> = {
    b: 1,
    k: 1024,
    m: 1024 * 1024,
    g: 1024 * 1024 * 1024,
  };
  return Math.round(num * multipliers[unit]);
}
