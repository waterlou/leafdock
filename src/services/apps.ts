import * as fs from 'fs';
import * as path from 'path';
import * as db from '../db';
import * as caddy from './caddy';
import * as docker from './docker';

export interface AppFile {
  path: string;
  content: string;
}

export interface StaticAppConfig {
  index: string;
  spa: boolean;
}

export interface DockerAppConfig {
  image: string;
  port: number;
  env: Record<string, string>;
  command?: string;
  cpu_limit: string;
  mem_limit: string;
}

export type AppConfig = StaticAppConfig | DockerAppConfig;

export interface AppInput {
  name: string;
  type: 'static' | 'docker';
  prefix?: string;
  files: AppFile[];
  config?: AppConfig;
}

export interface AppOutput {
  name: string;
  type: 'static' | 'docker';
  prefix: string;
  status: 'running' | 'stopped' | 'error';
  files: AppFile[];
  config: AppConfig;
  created_at: string;
  updated_at: string;
  error_message?: string;
}

const NAME_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function validateName(name: string): void {
  if (!name || !NAME_REGEX.test(name)) {
    throw new ValidationError(
      'Name must be lowercase letters, numbers, and hyphens. Must start with a letter.'
    );
  }
}

function prefixFromName(name: string): string {
  return `/${name}`;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function getDataDir(): string {
  return process.env.DATA_DIR || '/data';
}

function appDir(name: string): string {
  return path.join(getDataDir(), 'apps', name);
}

function writeFiles(name: string, files: AppFile[]): void {
  const dir = appDir(name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  for (const file of files) {
    const filePath = path.join(dir, file.path);
    const parentDir = path.dirname(filePath);

    // Prevent path traversal
    if (!filePath.startsWith(dir) || file.path.includes('..')) {
      throw new ValidationError(`Invalid file path: ${file.path}`);
    }

    fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(filePath, file.content, 'utf-8');
  }
}

function readFiles(name: string): AppFile[] {
  const dir = appDir(name);
  if (!fs.existsSync(dir)) return [];

  const files: AppFile[] = [];
  const walk = (currentDir: string) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const relativePath = path.relative(dir, fullPath);
        files.push({
          path: relativePath,
          content: fs.readFileSync(fullPath, 'utf-8'),
        });
      }
    }
  };
  walk(dir);
  return files;
}

function rowToOutput(row: db.AppRow): AppOutput {
  return {
    name: row.name,
    type: row.type,
    prefix: row.prefix,
    status: row.status,
    config: JSON.parse(row.config),
    files: readFiles(row.name),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listApps(): { name: string; type: string; prefix: string; status: string; created_at: string; updated_at: string }[] {
  return db.listApps().map(row => ({
    name: row.name,
    type: row.type,
    prefix: row.prefix,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export function getApp(name: string): AppOutput | null {
  const row = db.getApp(name);
  if (!row) return null;
  return rowToOutput(row);
}

export async function createApp(input: AppInput): Promise<AppOutput> {
  validateName(input.name);

  const prefix = input.prefix || prefixFromName(input.name);

  if (db.appExists(input.name)) {
    throw new ValidationError(`App "${input.name}" already exists`);
  }

  if (db.prefixExists(prefix)) {
    throw new ValidationError(`Prefix "${prefix}" is already in use`);
  }

  const now = new Date().toISOString();
  const config: AppConfig = { ...getDefaultConfig(input.type), ...input.config };

  // Write files to disk
  writeFiles(input.name, input.files);

  let containerId: string | null = null;

  try {
    if (input.type === 'docker') {
      const dockerConfig = config as DockerAppConfig;
      await docker.pullImage(dockerConfig.image);
      containerId = await docker.createContainer(input.name, appDir(input.name), dockerConfig);
      await caddy.addDockerRoute(prefix, containerId, dockerConfig.port);
    } else {
      const staticConfig = config as StaticAppConfig;
      await caddy.addStaticRoute(prefix, appDir(input.name), staticConfig.spa, staticConfig.index);
    }
  } catch (err) {
    // Clean up files on failure
    fs.rmSync(appDir(input.name), { recursive: true, force: true });
    throw err;
  }

  const row: db.AppRow = {
    name: input.name,
    type: input.type,
    prefix,
    status: 'running',
    config: JSON.stringify(config),
    container_id: containerId,
    created_at: now,
    updated_at: now,
  };

  db.createApp(row);
  return rowToOutput(db.getApp(input.name)!);
}

export async function updateApp(name: string, input: Partial<AppInput>): Promise<AppOutput> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`);

  const now = new Date().toISOString();
  const updates: Parameters<typeof db.updateApp>[1] = { updated_at: now };

  // Update files if provided
  if (input.files) {
    writeFiles(name, input.files);
  }

  // Update config if provided
  if (input.config) {
    updates.config = JSON.stringify(input.config);
  }

  // Update prefix if provided
  if (input.prefix && input.prefix !== existing.prefix) {
    if (db.prefixExists(input.prefix)) {
      throw new ValidationError(`Prefix "${input.prefix}" is already in use`);
    }
    // Remove old Caddy route, add new one
    await caddy.removeRoute(existing.prefix);

    if (existing.type === 'docker') {
      const dockerConfig = (input.config ? input.config : JSON.parse(existing.config)) as DockerAppConfig;
      const containerName = docker.containerNameForApp(existing.name);
      await caddy.addDockerRoute(input.prefix, containerName, dockerConfig.port);
    } else {
      const staticConfig = (input.config ? input.config : JSON.parse(existing.config)) as StaticAppConfig;
      await caddy.addStaticRoute(input.prefix, appDir(name), staticConfig.spa, staticConfig.index);
    }

    updates.prefix = input.prefix;
  }

  // If docker app and config changed, restart container
  if (existing.type === 'docker' && input.config) {
    try {
      await docker.restartContainer(name);
    } catch {
      // Container might not exist, recreate it
      const dockerConfig = input.config as DockerAppConfig;
      await docker.pullImage(dockerConfig.image);
      const containerId = await docker.createContainer(name, appDir(name), dockerConfig);
      updates.container_id = containerId;

      const prefix = input.prefix || existing.prefix;
      await caddy.removeRoute(prefix);
      await caddy.addDockerRoute(prefix, containerId, dockerConfig.port);
    }
  }

  // If static app and config changed with SPA toggle, update route
  if (existing.type === 'static' && (input.config || input.files)) {
    const config = (input.config ? input.config : JSON.parse(existing.config)) as StaticAppConfig;
    const prefix = input.prefix || existing.prefix;
    await caddy.removeRoute(prefix);
    await caddy.addStaticRoute(prefix, appDir(name), config.spa, config.index);
  }

  db.updateApp(name, updates);

  return rowToOutput(db.getApp(name)!);
}

export async function deleteApp(name: string): Promise<void> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`);

  // Remove Caddy route
  try {
    await caddy.removeRoute(existing.prefix);
  } catch {
    // Route might not exist, continue
  }

  // Stop docker container if applicable
  if (existing.type === 'docker') {
    try {
      await docker.stopContainer(name);
    } catch {
      // Container might already be gone
    }
  }

  // Remove files
  fs.rmSync(appDir(name), { recursive: true, force: true });

  // Remove from database
  db.deleteApp(name);
}

export async function getLogs(name: string, tail: number): Promise<string> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`);

  if (existing.type === 'docker') {
    return docker.getContainerLogs(name, tail);
  }

  // For static apps, check Caddy access logs
  try {
    const res = await caddy.adminFetch('/config/apps/http/servers/srv0/logs');
    if (res.ok) {
      const data = await (res.json() as Promise<{ logs?: string }>);
      // Filter logs for this app's prefix
      if (data.logs) {
        const lines = data.logs.split('\n').filter((l: string) =>
          l.includes(existing.prefix)
        );
        return lines.slice(-tail).join('\n');
      }
    }
  } catch {
    // Logs not available
  }

  return '(no logs available for static apps)';
}

export async function restartApp(name: string): Promise<AppOutput> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`);

  if (existing.type === 'docker') {
    await docker.restartContainer(name);
  }

  return rowToOutput(db.getApp(name)!);
}

function getDefaultConfig(type: 'static' | 'docker'): AppConfig {
  if (type === 'static') {
    return { index: 'index.html', spa: false };
  }
  return {
    image: 'node:20-alpine',
    port: 3000,
    env: {},
    cpu_limit: '0.5',
    mem_limit: '128m',
  };
}
