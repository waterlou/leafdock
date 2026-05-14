import Docker from 'dockerode';

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

export interface DockerAppConfig {
  image: string;
  port: number;
  env: Record<string, string>;
  command?: string;
  cpu_limit: string;
  mem_limit: string;
}

export function containerNameForApp(name: string): string {
  return `ih-app-${name}`;
}

export async function createContainer(
  appName: string,
  appDir: string,
  config: DockerAppConfig
): Promise<string> {
  const containerName = containerNameForApp(appName);

  // Remove existing container with same name if any
  await removeContainerIfExists(containerName);

  const envVars = Object.entries(config.env).map(([k, v]) => `${k}=${v}`);

  const container = await docker.createContainer({
    name: containerName,
    Image: config.image,
    Env: envVars,
    Cmd: config.command ? ['sh', '-c', config.command] : undefined,
    WorkingDir: '/app',
    ExposedPorts: {
      [`${config.port}/tcp`]: {},
    },
    HostConfig: {
      Binds: [`${appDir}:/app`],
      CpuShares: parseCpuLimit(config.cpu_limit),
      Memory: parseMemLimit(config.mem_limit),
      NetworkMode: 'intranet-host_default', // Docker Compose network
      RestartPolicy: {
        Name: 'unless-stopped',
      },
    },
  });

  await container.start();
  return containerName;
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
      const stream = await container.logs({
        stdout: true,
        stderr: true,
        tail,
        timestamps: true,
      });
      return stream.toString('utf-8');
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
