import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import * as db from '../db';
import * as caddy from './caddy';
import * as docker from './docker';
import * as compose from './compose';

export interface AppFile {
  path: string;
  content: string;
  encoding?: 'base64';
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

export interface DockerComposeAppConfig {
  compose_file?: string;
  services: Record<string, { port: number }>;
}

export type AppConfig = StaticAppConfig | DockerAppConfig | DockerComposeAppConfig;

export interface AppInput {
  name: string;
  type: 'static' | 'docker' | 'docker-compose';
  prefix?: string;
  files: AppFile[];
  config?: AppConfig;
}

export interface AppOutput {
  name: string;
  type: 'static' | 'docker' | 'docker-compose';
  prefix: string;
  status: 'running' | 'stopped' | 'error';
  files: AppFile[];
  config: AppConfig;
  title?: string;
  created_at: string;
  updated_at: string;
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

function normalizePrefix(prefix: string): string {
  return prefix.startsWith('/') ? prefix : `/${prefix}`;
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

    if (file.encoding === 'base64') {
      fs.writeFileSync(filePath, Buffer.from(file.content, 'base64'));
    } else {
      fs.writeFileSync(filePath, file.content, 'utf-8');
    }
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
        const buf = fs.readFileSync(fullPath);
        // Check if content is valid UTF-8
        if (isUtf8(buf)) {
          files.push({ path: relativePath, content: buf.toString('utf-8') });
        } else {
          files.push({ path: relativePath, content: buf.toString('base64'), encoding: 'base64' });
        }
      }
    }
  };
  walk(dir);
  return files;
}

function isUtf8(buf: Buffer): boolean {
  try {
    const decoded = buf.toString('utf-8');
    return Buffer.from(decoded, 'utf-8').equals(buf);
  } catch {
    return false;
  }
}

const titleCache = new Map<string, { title: string | null; mtime: number }>();

function extractTitle(name: string, config: AppConfig): string | null {
  const indexFile = 'index' in config ? (config as StaticAppConfig).index : 'index.html';
  const indexPath = path.join(appDir(name), indexFile);
  const pkgPath = path.join(appDir(name), 'package.json');

  // Compute latest mtime across all candidate files for cache invalidation
  const candidateFiles = [indexPath];
  let hasPkg = false;
  try { if (fs.existsSync(pkgPath)) { candidateFiles.push(pkgPath); hasPkg = true; } } catch {}

  const mtime = candidateFiles.reduce((max, f) => {
    try { return Math.max(max, fs.statSync(f).mtimeMs); } catch { return max; }
  }, 0);

  const cached = titleCache.get(name);
  if (cached && cached.mtime === mtime) return cached.title;

  // Try index HTML title
  try {
    const content = fs.readFileSync(indexPath, 'utf-8');
    const match = content.match(/<title>([^<]*)<\/title>/i);
    if (match) {
      const title = match[1].trim();
      titleCache.set(name, { title, mtime });
      return title;
    }
  } catch {}

  // Try package.json name (useful for docker apps)
  if (hasPkg) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.name && typeof pkg.name === 'string') {
        titleCache.set(name, { title: pkg.name, mtime });
        return pkg.name;
      }
    } catch {}
  }

  titleCache.set(name, { title: null, mtime });
  return null;
}

function rowToOutput(row: db.AppRow): AppOutput {
  const config = JSON.parse(row.config);
  return {
    name: row.name,
    type: row.type,
    prefix: row.prefix,
    status: row.status,
    config,
    files: readFiles(row.name),
    title: extractTitle(row.name, config) || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listApps(): { name: string; type: string; prefix: string; status: string; title?: string; created_at: string; updated_at: string }[] {
  return db.listApps().map(row => {
    const config = JSON.parse(row.config);
    return {
      name: row.name,
      type: row.type,
      prefix: row.prefix,
      status: row.status,
      title: extractTitle(row.name, config) || undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
}

export function getApp(name: string): AppOutput | null {
  const row = db.getApp(name);
  if (!row) return null;
  return rowToOutput(row);
}

export async function createApp(input: AppInput): Promise<AppOutput> {
  validateName(input.name);

  const prefix = normalizePrefix(input.prefix || prefixFromName(input.name));

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
    } else if (input.type === 'docker-compose') {
      const composeConfig = config as DockerComposeAppConfig;
      await compose.composeUp(input.name, composeConfig.services);
      await addComposeRoutes(prefix, input.name, composeConfig.services);
      containerId = JSON.stringify(
        Object.keys(composeConfig.services).reduce((acc, s) => {
          acc[s] = composeContainerName(input.name, s);
          return acc;
        }, {} as Record<string, string>)
      );
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

export async function createAppFromZip(
  name: string,
  type: 'static' | 'docker' | 'docker-compose',
  zipPath: string,
  appConfig?: AppConfig
): Promise<AppOutput> {
  validateName(name);

  const prefix = prefixFromName(name);

  if (db.appExists(name)) {
    throw new ValidationError(`App "${name}" already exists`);
  }

  if (db.prefixExists(prefix)) {
    throw new ValidationError(`Prefix "${prefix}" is already in use`);
  }

  // Extract zip to app directory
  const dir = appDir(name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(dir, true);
  fs.rmSync(zipPath, { force: true });

  const now = new Date().toISOString();
  const config: AppConfig = { ...getDefaultConfig(type), ...appConfig };

  let containerId: string | null = null;

  try {
    if (type === 'docker') {
      const dockerConfig = config as DockerAppConfig;
      await docker.pullImage(dockerConfig.image);
      containerId = await docker.createContainer(name, dir, dockerConfig);
      await caddy.addDockerRoute(prefix, containerId, dockerConfig.port);
    } else if (type === 'docker-compose') {
      const composeConfig = config as DockerComposeAppConfig;
      await compose.composeUp(name, composeConfig.services);
      await addComposeRoutes(prefix, name, composeConfig.services);
      containerId = JSON.stringify(
        Object.keys(composeConfig.services).reduce((acc, s) => {
          acc[s] = composeContainerName(name, s);
          return acc;
        }, {} as Record<string, string>)
      );
    } else {
      const staticConfig = config as StaticAppConfig;
      await caddy.addStaticRoute(prefix, dir, staticConfig.spa, staticConfig.index);
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  const row: db.AppRow = {
    name,
    type,
    prefix,
    status: 'running',
    config: JSON.stringify(config),
    container_id: containerId,
    created_at: now,
    updated_at: now,
  };

  db.createApp(row);
  return rowToOutput(db.getApp(name)!);
}

export async function updateAppFromZip(
  name: string,
  zipPath: string,
  appConfig?: AppConfig
): Promise<AppOutput> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`);

  // Remove existing files and extract zip
  const dir = appDir(name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(dir, true);
  fs.rmSync(zipPath, { force: true });

  const now = new Date().toISOString();
  const updates: Parameters<typeof db.updateApp>[1] = { updated_at: now };

  if (appConfig) {
    updates.config = JSON.stringify(appConfig);
  }

  // Refresh Caddy route
  const prefix = existing.prefix;
  await caddy.removeRoute(prefix);

  if (existing.type === 'docker') {
    const dockerConfig = (appConfig ? appConfig : JSON.parse(existing.config)) as DockerAppConfig;
    const containerName = docker.containerNameForApp(existing.name);
    await docker.stopContainer(name);
    await docker.pullImage(dockerConfig.image);
    const containerId = await docker.createContainer(name, dir, dockerConfig);
    await caddy.addDockerRoute(prefix, containerId, dockerConfig.port);
    updates.container_id = containerId;
  } else if (existing.type === 'docker-compose') {
    const existingConfig = JSON.parse(existing.config) as DockerComposeAppConfig;
    // Remove sub-service routes (main prefix already removed above)
    const entries = Object.entries(existingConfig.services);
    for (let i = 1; i < entries.length; i++) {
      const [serviceName] = entries[i];
      try { await caddy.removeRoute(`${prefix}/${serviceName}`); } catch {}
    }
    await compose.composeDown(name);
    const composeConfig = (appConfig ? appConfig : existingConfig) as DockerComposeAppConfig;
    await compose.composeUp(name, composeConfig.services);
    await addComposeRoutes(prefix, name, composeConfig.services);
    updates.container_id = JSON.stringify(
      Object.keys(composeConfig.services).reduce((acc, s) => {
        acc[s] = composeContainerName(name, s);
        return acc;
      }, {} as Record<string, string>)
    );
  } else {
    const staticConfig: StaticAppConfig = { ...getDefaultConfig('static') as StaticAppConfig, ...(appConfig || JSON.parse(existing.config)) };
    await caddy.addStaticRoute(prefix, dir, staticConfig.spa, staticConfig.index);
  }

  db.updateApp(name, updates);
  return rowToOutput(db.getApp(name)!);
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

  // Update config if provided — merge with defaults so partial configs don't lose fields
  if (input.config) {
    const defaults = getDefaultConfig(existing.type);
    updates.config = JSON.stringify({ ...defaults, ...input.config });
  }

  // Update prefix if provided
  const newPrefix = input.prefix ? normalizePrefix(input.prefix) : null;
  if (newPrefix && newPrefix !== existing.prefix) {
    if (db.prefixExists(newPrefix)) {
      throw new ValidationError(`Prefix "${newPrefix}" is already in use`);
    }
    // Remove old Caddy route, add new one
    if (existing.type === 'docker-compose') {
      const oldComposeConfig = JSON.parse(existing.config) as DockerComposeAppConfig;
      await removeComposeRoutes(existing.prefix, oldComposeConfig.services);
    } else {
      await caddy.removeRoute(existing.prefix);
    }

    if (existing.type === 'docker') {
      const dockerConfig = (input.config ? input.config : JSON.parse(existing.config)) as DockerAppConfig;
      const containerName = docker.containerNameForApp(existing.name);
      await caddy.addDockerRoute(newPrefix, containerName, dockerConfig.port);
    } else if (existing.type === 'docker-compose') {
      const composeConfig = (input.config ? input.config : JSON.parse(existing.config)) as DockerComposeAppConfig;
      await addComposeRoutes(newPrefix, name, composeConfig.services);
    } else {
      const staticConfig = (input.config ? input.config : JSON.parse(existing.config)) as StaticAppConfig;
      await caddy.addStaticRoute(newPrefix, appDir(name), staticConfig.spa, staticConfig.index);
    }

    updates.prefix = newPrefix;
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
    const config: StaticAppConfig = { ...getDefaultConfig('static') as StaticAppConfig, ...(input.config || JSON.parse(existing.config)) };
    const prefix = input.prefix || existing.prefix;
    await caddy.removeRoute(prefix);
    await caddy.addStaticRoute(prefix, appDir(name), config.spa, config.index);
  }

  // If docker-compose app and config or files changed, restart compose
  if (existing.type === 'docker-compose' && (input.config || input.files)) {
    const oldConfig = JSON.parse(existing.config) as DockerComposeAppConfig;
    const composeConfig = (input.config ? input.config : oldConfig) as DockerComposeAppConfig;
    const prefix = input.prefix || existing.prefix;
    await removeComposeRoutes(prefix, oldConfig.services);
    await compose.composeDown(name);
    await compose.composeUp(name, composeConfig.services);
    await addComposeRoutes(prefix, name, composeConfig.services);
    updates.container_id = JSON.stringify(
      Object.keys(composeConfig.services).reduce((acc, s) => {
        acc[s] = composeContainerName(name, s);
        return acc;
      }, {} as Record<string, string>)
    );
  }

  db.updateApp(name, updates);

  return rowToOutput(db.getApp(name)!);
}

export async function deleteApp(name: string): Promise<void> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`);

  // Remove Caddy route
  if (existing.type === 'docker-compose') {
    const composeConfig = JSON.parse(existing.config) as DockerComposeAppConfig;
    try {
      await removeComposeRoutes(existing.prefix, composeConfig.services);
    } catch {
      // Routes might not exist
    }
  } else {
    try {
      await caddy.removeRoute(existing.prefix);
    } catch {
      // Route might not exist, continue
    }
  }

  // Stop containers if applicable
  if (existing.type === 'docker') {
    try {
      await docker.stopContainer(name);
    } catch {
      // Container might already be gone
    }
  } else if (existing.type === 'docker-compose') {
    try {
      await compose.composeDown(name);
    } catch {
      // Compose project might not exist
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

  if (existing.type === 'docker-compose') {
    return compose.composeLogs(name, tail);
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
  } else if (existing.type === 'docker-compose') {
    const config = JSON.parse(existing.config) as DockerComposeAppConfig;
    await compose.composeDown(name);
    await compose.composeUp(name, config.services);
  }

  return rowToOutput(db.getApp(name)!);
}

export async function stopApp(name: string): Promise<AppOutput> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`);
  if (existing.status === 'stopped') return rowToOutput(existing);

  // Remove Caddy route
  if (existing.type === 'docker-compose') {
    const composeConfig = JSON.parse(existing.config) as DockerComposeAppConfig;
    try {
      await removeComposeRoutes(existing.prefix, composeConfig.services);
    } catch {
      // Route might not exist
    }
  } else {
    try {
      await caddy.removeRoute(existing.prefix);
    } catch {
      // Route might not exist
    }
  }

  // Stop containers if applicable
  if (existing.type === 'docker') {
    try {
      await docker.stopContainer(name);
    } catch {
      // Container might already be gone
    }
  } else if (existing.type === 'docker-compose') {
    try {
      await compose.composeDown(name);
    } catch {
      // Compose project might not exist
    }
  }

  const now = new Date().toISOString();
  db.updateApp(name, { status: 'stopped', updated_at: now });
  return rowToOutput(db.getApp(name)!);
}

export async function startApp(name: string): Promise<AppOutput> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`);
  if (existing.status === 'running') return rowToOutput(existing);

  const config = { ...getDefaultConfig(existing.type), ...JSON.parse(existing.config) };
  const now = new Date().toISOString();
  const updates: Parameters<typeof db.updateApp>[1] = { status: 'running', config: JSON.stringify(config), updated_at: now };

  if (existing.type === 'docker') {
    const dockerConfig = config as DockerAppConfig;
    await docker.pullImage(dockerConfig.image);
    const containerId = await docker.createContainer(name, appDir(name), dockerConfig);
    await caddy.addDockerRoute(existing.prefix, containerId, dockerConfig.port);
    updates.container_id = containerId;
  } else if (existing.type === 'docker-compose') {
    const composeConfig = config as DockerComposeAppConfig;
    await compose.composeUp(name, composeConfig.services);
    await addComposeRoutes(existing.prefix, name, composeConfig.services);
    updates.container_id = JSON.stringify(
      Object.keys(composeConfig.services).reduce((acc, s) => {
        acc[s] = composeContainerName(name, s);
        return acc;
      }, {} as Record<string, string>)
    );
  } else {
    const staticConfig = config as StaticAppConfig;
    await caddy.addStaticRoute(existing.prefix, appDir(name), staticConfig.spa, staticConfig.index);
  }

  db.updateApp(name, updates);
  return rowToOutput(db.getApp(name)!);
}

export async function syncRoutes(): Promise<void> {
  // Wait for Caddy admin API to be ready
  for (let i = 0; i < 30; i++) {
    try {
      await caddy.adminFetch('/config/');
      break;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  const rows = db.listApps();
  for (const row of rows) {
    const config = JSON.parse(row.config);
    try {
      if (row.type === 'docker') {
        const dockerConfig = config as DockerAppConfig;
        const containerName = docker.containerNameForApp(row.name);
        await caddy.addDockerRoute(row.prefix, containerName, dockerConfig.port);
      } else if (row.type === 'docker-compose') {
        const composeConfig = config as DockerComposeAppConfig;
        await addComposeRoutes(row.prefix, row.name, composeConfig.services);
      } else {
        const staticConfig = config as StaticAppConfig;
        await caddy.addStaticRoute(row.prefix, appDir(row.name), staticConfig.spa, staticConfig.index);
      }
      console.log(`Restored route for "${row.name}"`);
    } catch (err) {
      console.error(`Failed to sync route for "${row.name}":`, err);
    }
  }
}

const COMPOSE_PROJECT_PREFIX = 'ld-';

function composeContainerName(appName: string, serviceName: string): string {
  return `${COMPOSE_PROJECT_PREFIX}${appName}-${serviceName}`;
}

async function addComposeRoutes(prefix: string, name: string, services: Record<string, { port: number }>): Promise<void> {
  const entries = Object.entries(services);
  for (let i = 0; i < entries.length; i++) {
    const [serviceName, config] = entries[i];
    const containerName = composeContainerName(name, serviceName);
    const servicePrefix = i === 0 ? prefix : `${prefix}/${serviceName}`;
    await caddy.addDockerRoute(servicePrefix, containerName, config.port);
  }
}

async function removeComposeRoutes(prefix: string, services: Record<string, { port: number }>): Promise<void> {
  const entries = Object.entries(services);
  for (let i = 0; i < entries.length; i++) {
    const [serviceName] = entries[i];
    const servicePrefix = i === 0 ? prefix : `${prefix}/${serviceName}`;
    try {
      await caddy.removeRoute(servicePrefix);
    } catch {
      // Route might not exist
    }
  }
}

function getDefaultConfig(type: 'static' | 'docker' | 'docker-compose'): AppConfig {
  if (type === 'static') {
    return { index: 'index.html', spa: false };
  }
  if (type === 'docker-compose') {
    return { services: {} };
  }
  return {
    image: 'node:20-alpine',
    port: 3000,
    env: {},
    cpu_limit: '0.5',
    mem_limit: '128m',
  };
}
