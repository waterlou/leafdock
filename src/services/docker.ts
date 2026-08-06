import Docker from 'dockerode';

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

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
    WorkingDir: workDir,
    ExposedPorts: {
      [`${config.port}/tcp`]: {},
    },
    HostConfig: {
      Mounts: [appVolumeMount()],
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
}

// The shared storage between leafdock and app containers. Defaults to a named
// volume (leafdock_app_data); if APP_VOLUME is an absolute host path (NAS
// setups often bind-mount a host dir to /data, e.g. /volume1/docker/leafdock),
// mount it as a bind instead — otherwise app containers would see a different,
// empty store and lose their uploaded files.
function appVolumeMount(): { Type: 'volume' | 'bind'; Source: string; Target: '/app' } {
  const src = process.env.APP_VOLUME || 'leafdock_app_data';
  if (src.startsWith('/') || /^[A-Za-z]:[\\/]/.test(src)) {
    return { Type: 'bind', Source: src, Target: '/app' };
  }
  return { Type: 'volume', Source: src, Target: '/app' };
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
    WorkingDir: workDir,
    HostConfig: {
      Mounts: [appVolumeMount()],
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
  } catch {
    // not running or missing
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
    if (existing) {
      const container = docker.getContainer(existing.Id);
      await container.restart();
    }
  } catch {
    throw new Error(`Container ${containerName} not found`);
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
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

function parseCpuLimit(limit: string): number {
  // Docker CPU shares are relative to 1024
  // "0.5" means half a core = 512 shares
  const num = parseFloat(limit);
  return Math.round(num * 1024);
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
