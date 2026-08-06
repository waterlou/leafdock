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

// Optional on every type: relative directories inside the app dir that must
// survive file replacement (SQLite DBs, uploads, ...). Moved aside during
// update, restored after extraction.
export interface PreserveDirsConfig {
  preserve_dirs?: string[];
}

export type AppConfig = (StaticAppConfig | DockerAppConfig | DockerComposeAppConfig) & PreserveDirsConfig;

export interface AppInput {
  name: string;
  type: 'static' | 'docker' | 'docker-compose';
  prefix?: string;
  folder?: string;
  files: AppFile[];
  config?: AppConfig;
  icon?: string;
}

export interface AppOutput {
  name: string;
  type: 'static' | 'docker' | 'docker-compose';
  prefix: string;
  folder: string;
  status: 'running' | 'stopped' | 'error';
  files: AppFile[];
  config: AppConfig;
  icon: string;
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

// Emoji + flags + skin tones + ZWJ sequences only. Rejects every HTML-injectable
// character — the landing page renders icons via innerHTML. Keycap sequences
// (digit + FE0F + 20E3) are deliberately rejected; pick another emoji instead.
const ICON_REGEX = /^[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0F\u20E3]+$/u;

function validateIcon(icon: string): string {
  const trimmed = icon.trim();
  if (trimmed === '') return '';
  if (!ICON_REGEX.test(trimmed)) {
    throw new ValidationError('Invalid icon: must be an emoji');
  }
  return trimmed;
}

function prefixFromName(name: string): string {
  return `/${name}`;
}

// Index must be a bare filename: no leading '/', no path separators, no '..' traversal.
// Only static apps serve an index file, so skip other types — a legacy docker/compose
// row may carry an irrelevant top-level 'index' field that must not block updates.
function validateStaticConfig(config: AppConfig, type: 'static' | 'docker' | 'docker-compose'): void {
  if (type !== 'static') return;
  const { index } = config as StaticAppConfig;
  if (!index || index.startsWith('/') || /[\\/]/.test(index) || index === '..') {
    throw new ValidationError(`Invalid index file: ${index}`);
  }
}

// Merge defaults < stored config < patch so partial configs never lose stored fields.
function mergeConfig(
  type: 'static' | 'docker' | 'docker-compose',
  stored?: string,
  patch?: AppConfig
): AppConfig {
  if (patch?.preserve_dirs !== undefined) validatePreserveDirs(patch.preserve_dirs);
  const merged = { ...getDefaultConfig(type), ...(stored ? JSON.parse(stored) : {}), ...patch };
  validateStaticConfig(merged, type);
  return merged;
}

// Relative dir paths only: no absolute paths, no traversal, no backslashes.
function validatePreserveDirs(dirs: unknown): void {
  if (!Array.isArray(dirs)) {
    throw new ValidationError('"preserve_dirs" must be an array of directory paths.');
  }
  if (dirs.length > 20) {
    throw new ValidationError('"preserve_dirs" must have at most 20 entries.');
  }
  for (const d of dirs) {
    if (typeof d !== 'string' || d === '' || d.startsWith('/') || d.includes('\\')) {
      throw new ValidationError(`Invalid preserve_dirs entry: ${JSON.stringify(d)}`);
    }
    const segments = d.split('/');
    if (segments.some(s => s === '..' || s === '.')) {
      throw new ValidationError(`Invalid preserve_dirs entry: ${d}`);
    }
  }
}

// Move runtime-data dirs aside, run `body` (which replaces the app dir), then
// move them back into `targetDir`. On failure the dirs are restored anyway.
function withPreservedDirs(sourceDir: string, targetDir: string, preserveDirs: string[], body: () => void): void {
  if (preserveDirs.length === 0) {
    body();
    return;
  }
  const tmp = path.join(
    path.dirname(sourceDir),
    `.preserve-${path.basename(sourceDir)}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const moved: Array<{ from: string; to: string }> = [];
  const restore = (dir: string) => {
    for (const m of moved) {
      try {
        const dest = path.join(dir, path.relative(sourceDir, m.from));
        if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(m.to, dest);
      } catch {
        // best effort — never let restore failures mask the update result
      }
    }
  };
  try {
    for (const p of preserveDirs) {
      const from = path.join(sourceDir, p);
      if (!fs.existsSync(from)) continue;
      const to = path.join(tmp, p);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      moved.push({ from, to });
    }
    body();
    restore(targetDir);
  } catch (err) {
    restore(targetDir);
    throw err;
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  }
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

// Folder = every prefix segment except the app name (the last one).
// '/blog/post1' -> 'blog', '/post1' -> '' (root).
function folderFromPrefix(prefix: string): string {
  return prefix.split('/').slice(1, -1).join('/');
}

// Validate a folder path: drop empty segments (so 'a//b' -> 'a/b'), normalize to
// lowercase (so 'Demo' -> 'demo' — the URL, disk layout, and UI all use the
// normalized form), require every segment to match the app-name charset.
// '' (or '/', '//') = root. Rejects '..', '.', underscores, and anything else.
export function validateFolder(folder: string): string {
  const segments = folder.toLowerCase().split('/').filter(s => s.length > 0);
  for (const segment of segments) {
    if (!NAME_REGEX.test(segment)) {
      throw new ValidationError(`Invalid folder path: ${folder}`);
    }
  }
  return segments.join('/');
}

// Move keeps the prefix tail (custom prefixes like '/foo' stay '/blog/foo' when
// moved into folder 'blog' — only the folder part is replaced).
function prefixForMove(existing: db.AppRow, newFolder: string): string {
  const folder = folderFromPrefix(existing.prefix);
  const tail = folder ? existing.prefix.slice(folder.length + 1) : existing.prefix;
  return newFolder ? `/${newFolder}${tail}` : tail;
}

// Conflict when another app owns the exact prefix, or the new prefix would be
// shadowed by / shadow an existing prefix (tree overlap).
function findPrefixConflict(prefix: string, exceptName?: string): db.AppRow | null {
  for (const row of db.listApps()) {
    if (row.name === exceptName) continue;
    if (row.prefix === prefix) return row;
    if (prefix.startsWith(row.prefix + '/')) return row;
    if (row.prefix.startsWith(prefix + '/')) return row;
  }
  return null;
}

// Exact collision keeps the 'already in use' message (handleError -> prefix_conflict);
// tree conflicts are plain validation errors.
function throwIfPrefixConflict(prefix: string, exceptName?: string): void {
  const conflict = findPrefixConflict(prefix, exceptName);
  if (!conflict) return;
  if (conflict.prefix === prefix) {
    throw new ValidationError(`Prefix "${prefix}" is already in use`);
  }
  throw new ValidationError(`Prefix "${prefix}" conflicts with existing app at "${conflict.prefix}"`);
}

function getDataDir(): string {
  return process.env.DATA_DIR || '/data';
}

// Explicit folder when the caller has it (input, row, or move target); otherwise
// derive from the stored prefix (only valid once the row exists in the DB).
function appDir(name: string, folder?: string): string {
  if (folder === undefined) {
    folder = folderFromPrefix(db.getApp(name)?.prefix ?? '');
  }
  return path.join(getDataDir(), 'apps', ...(folder ? [folder] : []), name);
}

function writeFiles(name: string, folder: string, files: AppFile[]): void {
  const dir = appDir(name, folder);
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

function readFiles(name: string, folder: string): AppFile[] {
  const dir = appDir(name, folder);
  if (!fs.existsSync(dir)) return [];

  const files: AppFile[] = [];
  const walk = (currentDir: string) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      // Build artifacts (docker apps install node_modules / build .next into
      // the app dir): walking them makes every file-bearing response enormous
      // and slow, and can blow the JSON string limit entirely.
      if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name === '.next')) continue;
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
    folder: folderFromPrefix(row.prefix),
    status: row.status,
    config,
    icon: row.icon,
    files: readFiles(row.name, folderFromPrefix(row.prefix)),
    title: extractTitle(row.name, config) || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listApps(): { name: string; type: string; prefix: string; folder: string; status: string; icon: string; title?: string; created_at: string; updated_at: string }[] {
  return db.listApps().map(row => {
    const config = JSON.parse(row.config);
    return {
      name: row.name,
      type: row.type,
      prefix: row.prefix,
      folder: folderFromPrefix(row.prefix),
      status: row.status,
      icon: row.icon,
      title: extractTitle(row.name, config) || undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
}

// Display labels for folders: slug path -> label. Metadata only; URLs and disk
// layout always use the slug. Landing page renders these instead of the slug.
export function listFolderLabels(): Record<string, string> {
  return db.listFolderLabels();
}

export function setFolderLabel(folderPath: string, label: string): void {
  db.setFolderLabel(folderPath, label);
}

export function clearFolderLabel(folderPath: string): void {
  db.clearFolderLabel(folderPath);
}

export function getApp(name: string): AppOutput | null {
  const row = db.getApp(name);
  if (!row) return null;
  return rowToOutput(row);
}

export function downloadAppZip(name: string): Buffer {
  // Reject '..', '/' etc. before appDir() resolves them against the data dir —
  // without this, GET /apps/..%2Fzip would zip the whole data directory.
  validateName(name);
  const dir = appDir(name);
  if (!fs.existsSync(dir)) throw new ValidationError(`App "${name}" not found`);
  const zip = new AdmZip();
  const walk = (currentDir: string, prefix: string) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name === '.next')) continue;
      const fullPath = path.join(currentDir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, rel);
      } else {
        zip.addFile(rel, fs.readFileSync(fullPath));
      }
    }
  };
  walk(dir, '');
  return zip.toBuffer();
}

export async function createApp(input: AppInput): Promise<AppOutput> {
  validateName(input.name);

  if (input.folder !== undefined && input.prefix !== undefined) {
    throw new ValidationError('Provide either folder or prefix, not both');
  }

  // Folder and prefix are two views of the same location: folder drives the disk
  // layout, prefix drives the URL. Derive one from the other so a nested prefix
  // like '/blog/x' also gets a real directory.
  let folder = input.folder !== undefined ? validateFolder(input.folder) : '';
  const prefix = input.folder !== undefined
    ? (folder ? `/${folder}/${input.name}` : `/${input.name}`)
    : '/' + validateFolder(normalizePrefix((input.prefix || prefixFromName(input.name)).toLowerCase()).slice(1));
  folder = folderFromPrefix(prefix);

  const icon = input.icon !== undefined ? validateIcon(input.icon) : '';

  if (db.appExists(input.name)) {
    throw new ValidationError(`App "${input.name}" already exists`);
  }

  throwIfPrefixConflict(prefix);

  const now = new Date().toISOString();
  const config = mergeConfig(input.type, undefined, input.config);

  // Write files to disk
  writeFiles(input.name, folder, input.files);

  let containerId: string | null = null;

  try {
    if (input.type === 'docker') {
      const dockerConfig = config as DockerAppConfig;
      await docker.pullImage(dockerConfig.image);
      containerId = await docker.createContainer(input.name, appDir(input.name, folder), dockerConfig);
      await caddy.addDockerRoute(prefix, containerId, dockerConfig.port);
    } else if (input.type === 'docker-compose') {
      const composeConfig = config as DockerComposeAppConfig;
      await compose.composeUp(input.name, folder, composeConfig.services);
      await addComposeRoutes(prefix, input.name, composeConfig.services);
      containerId = JSON.stringify(
        Object.keys(composeConfig.services).reduce((acc, s) => {
          acc[s] = composeContainerName(input.name, s);
          return acc;
        }, {} as Record<string, string>)
      );
    } else {
      const staticConfig = config as StaticAppConfig;
      await caddy.addStaticRoute(prefix, appDir(input.name, folder), staticConfig.spa, staticConfig.index);
    }
  } catch (err) {
    // Clean up files on failure
    fs.rmSync(appDir(input.name, folder), { recursive: true, force: true });
    throw err;
  }

  const row: db.AppRow = {
    name: input.name,
    type: input.type,
    prefix,
    status: 'running',
    config: JSON.stringify(config),
    container_id: containerId,
    icon,
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
  appConfig?: AppConfig,
  folder?: string,
  icon?: string
): Promise<AppOutput> {
  validateName(name);

  const iconNorm = icon !== undefined ? validateIcon(icon) : '';
  const folderNorm = validateFolder(folder ?? '');
  const prefix = folderNorm ? `/${folderNorm}/${name}` : `/${name}`;

  if (db.appExists(name)) {
    throw new ValidationError(`App "${name}" already exists`);
  }

  throwIfPrefixConflict(prefix);

  // Extract zip to app directory
  const dir = appDir(name, folderNorm);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(dir, true);
  fs.rmSync(zipPath, { force: true });

  const now = new Date().toISOString();
  const config = mergeConfig(type, undefined, appConfig);

  let containerId: string | null = null;

  try {
    if (type === 'docker') {
      const dockerConfig = config as DockerAppConfig;
      await docker.pullImage(dockerConfig.image);
      containerId = await docker.createContainer(name, dir, dockerConfig);
      await caddy.addDockerRoute(prefix, containerId, dockerConfig.port);
    } else if (type === 'docker-compose') {
      const composeConfig = config as DockerComposeAppConfig;
      await compose.composeUp(name, folderNorm, composeConfig.services);
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
    icon: iconNorm,
    created_at: now,
    updated_at: now,
  };

  db.createApp(row);
  return rowToOutput(db.getApp(name)!);
}

export async function updateAppFromZip(
  name: string,
  zipPath: string,
  appConfig?: AppConfig,
  icon?: string
): Promise<AppOutput> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`);

  const now = new Date().toISOString();
  const merged = mergeConfig(existing.type, existing.config, appConfig);
  const updates: Parameters<typeof db.updateApp>[1] = { updated_at: now, config: JSON.stringify(merged) };
  if (icon !== undefined) updates.icon = validateIcon(icon);

  // Replace files, keeping configured runtime-data dirs (DBs, uploads) alive.
  const dir = appDir(name);
  withPreservedDirs(dir, dir, merged.preserve_dirs ?? [], () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(dir, true);
    fs.rmSync(zipPath, { force: true });
  });

  // Refresh Caddy route
  const prefix = existing.prefix;
  await caddy.removeRoute(prefix);

  if (existing.type === 'docker') {
    const dockerConfig = merged as DockerAppConfig;
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
    await compose.composeDown(name, folderFromPrefix(prefix));
    const composeConfig = merged as DockerComposeAppConfig;
    await compose.composeUp(name, folderFromPrefix(prefix), composeConfig.services);
    await addComposeRoutes(prefix, name, composeConfig.services);
    updates.container_id = JSON.stringify(
      Object.keys(composeConfig.services).reduce((acc, s) => {
        acc[s] = composeContainerName(name, s);
        return acc;
      }, {} as Record<string, string>)
    );
  } else {
    const staticConfig = merged as StaticAppConfig;
    await caddy.addStaticRoute(prefix, dir, staticConfig.spa, staticConfig.index);
  }

  db.updateApp(name, updates);
  return rowToOutput(db.getApp(name)!);
}

// Single implementation for every location change (folder move, prefix rename):
// relocates files, swaps Caddy routes, recreates containers when running.
// `files` present = full replacement semantics (old files obsolete); absent =
// rename the existing directory (refusing to overwrite an unknown target dir).
async function applyMove(
  existing: db.AppRow,
  newFolder: string,
  newPrefix: string,
  files: AppFile[] | null
): Promise<void> {
  throwIfPrefixConflict(newPrefix, existing.name);

  const oldFolder = folderFromPrefix(existing.prefix);
  const oldDir = appDir(existing.name, oldFolder);
  const newDir = appDir(existing.name, newFolder);
  const running = existing.status !== 'stopped';

  const merged = mergeConfig(existing.type, existing.config);

  // docker-compose must be brought down from the old dir before it is moved
  if (existing.type === 'docker-compose' && running) {
    await compose.composeDown(existing.name, oldFolder);
  }

  if (files) {
    // Preserve runtime-data dirs while relocating: move aside from the old
    // dir, write the new files, restore into the new dir.
    withPreservedDirs(oldDir, newDir, merged.preserve_dirs ?? [], () => {
      writeFiles(existing.name, newFolder, files);
      if (oldDir !== newDir) {
        fs.rmSync(oldDir, { recursive: true, force: true });
      }
    });
  } else {
    if (fs.existsSync(newDir) && newDir !== oldDir) {
      throw new ValidationError('Target app directory already exists');
    }
    if (fs.existsSync(oldDir)) {
      fs.mkdirSync(path.dirname(newDir), { recursive: true });
      fs.renameSync(oldDir, newDir);
    }
  }

  // Routes (stopped apps get routes too — matches historical prefix-update
  // behavior; stopApp removes them again on the next stop)
  if (existing.type === 'docker-compose') {
    const oldServices = (JSON.parse(existing.config) as DockerComposeAppConfig).services;
    await removeComposeRoutes(existing.prefix, oldServices);
    await addComposeRoutes(newPrefix, existing.name, (merged as DockerComposeAppConfig).services);
  } else if (existing.type === 'docker') {
    await caddy.removeRoute(existing.prefix);
    await caddy.addDockerRoute(newPrefix, docker.containerNameForApp(existing.name), (merged as DockerAppConfig).port);
  } else {
    await caddy.removeRoute(existing.prefix);
    const staticConfig = merged as StaticAppConfig;
    await caddy.addStaticRoute(newPrefix, newDir, staticConfig.spa, staticConfig.index);
  }

  // Containers: only for running apps; stopped apps are rebuilt on startApp
  // from the new folder (its appDir(name) lookup resolves it)
  if (running) {
    if (existing.type === 'docker') {
      // createContainer removes the old container (stale mount) and recreates
      // with the new dir; container_id is name-based so it stays unchanged
      await docker.createContainer(existing.name, newDir, merged as DockerAppConfig);
    } else if (existing.type === 'docker-compose') {
      await compose.composeUp(existing.name, newFolder, (merged as DockerComposeAppConfig).services);
    }
  }
}

export async function moveApp(name: string, folder: string): Promise<AppOutput> {
  return updateApp(name, { folder });
}

export async function updateApp(name: string, input: Partial<AppInput>): Promise<AppOutput> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`);

  if (input.folder !== undefined && input.prefix !== undefined) {
    throw new ValidationError('Provide either folder or prefix, not both');
  }

  const now = new Date().toISOString();
  const updates: Parameters<typeof db.updateApp>[1] = { updated_at: now };

  if (input.icon !== undefined) updates.icon = validateIcon(input.icon);

  // Resolve the move target: folder and prefix are two views of one location
  let newPrefix: string | null = null;
  let newFolder: string | null = null;
  if (input.prefix) {
    newPrefix = '/' + validateFolder(normalizePrefix(input.prefix.toLowerCase()).slice(1));
    newFolder = folderFromPrefix(newPrefix);
  } else if (input.folder !== undefined) {
    newFolder = validateFolder(input.folder);
    newPrefix = prefixForMove(existing, newFolder);
  }
  const moved = newPrefix !== null && newPrefix !== existing.prefix;

  // Parse + validate stored config only when this update consumes it, so a corrupt
  // stored config can't break updates that don't touch config (e.g. files or prefix only).
  const merged: AppConfig | null = input.config || input.files || moved
    ? mergeConfig(existing.type, existing.config, input.config)
    : null;

  let currentPrefix = existing.prefix;

  // Update files / location
  if (moved) {
    await applyMove(existing, newFolder!, newPrefix!, input.files ?? null);
    currentPrefix = newPrefix!;
  } else if (input.files) {
    const targetDir = appDir(name, folderFromPrefix(existing.prefix));
    withPreservedDirs(targetDir, targetDir, merged?.preserve_dirs ?? [], () => {
      writeFiles(name, folderFromPrefix(existing.prefix), input.files!);
    });
  }

  // Update config if provided — merge with defaults and stored config so partial configs don't lose fields
  if (input.config) {
    updates.config = JSON.stringify(merged);
  }

  if (moved) {
    updates.prefix = newPrefix!;
  }

  // If docker app and config changed, restart container
  if (existing.type === 'docker' && input.config) {
    try {
      await docker.restartContainer(name);
    } catch {
      // Container might not exist, recreate it
      const dockerConfig = merged! as DockerAppConfig;
      await docker.pullImage(dockerConfig.image);
      const containerId = await docker.createContainer(name, appDir(name, folderFromPrefix(currentPrefix)), dockerConfig);
      updates.container_id = containerId;

      await caddy.removeRoute(currentPrefix);
      await caddy.addDockerRoute(currentPrefix, containerId, dockerConfig.port);
    }
  }

  // If static app and config, files, or location changed, update route
  if (existing.type === 'static' && (input.config || input.files || moved)) {
    const staticConfig = merged! as StaticAppConfig;
    await caddy.removeRoute(currentPrefix);
    await caddy.addStaticRoute(currentPrefix, appDir(name, folderFromPrefix(currentPrefix)), staticConfig.spa, staticConfig.index);
  }

  // If docker-compose app and config or files changed, restart compose
  // (double restart right after a move is idempotent)
  if (existing.type === 'docker-compose' && (input.config || input.files)) {
    const oldConfig = JSON.parse(existing.config) as DockerComposeAppConfig;
    const composeConfig = merged! as DockerComposeAppConfig;
    await removeComposeRoutes(currentPrefix, oldConfig.services);
    await compose.composeDown(name, folderFromPrefix(currentPrefix));
    await compose.composeUp(name, folderFromPrefix(currentPrefix), composeConfig.services);
    await addComposeRoutes(currentPrefix, name, composeConfig.services);
    updates.container_id = JSON.stringify(
      Object.keys(composeConfig.services).reduce((acc, s) => {
        acc[s] = composeContainerName(name, s);
        return acc;
      }, {} as Record<string, string>)
    );
  }

  db.updateApp(name, updates);

  // Moving the last app out of a folder leaves it empty: clean up its label
  // and directory (after the DB update so the app itself doesn't count).
  if (moved) cleanupFolder(folderFromPrefix(existing.prefix));

  return rowToOutput(db.getApp(name)!);
}

// Folders are implicit — they exist only via app prefixes. When an app leaves
// a folder (delete or move), drop the folder's display label and on-disk
// directory if nothing else uses them, walking up the chain for ancestors.
function cleanupFolder(folderPath: string): void {
  if (!folderPath) return;

  // Label paths affected: ancestors of folderPath, folderPath itself, and
  // everything nested under it.
  const relevant = new Set<string>();
  let f = folderPath;
  while (f) {
    relevant.add(f);
    const i = f.lastIndexOf('/');
    f = i === -1 ? '' : f.slice(0, i);
  }
  for (const p of Object.keys(db.listFolderLabels())) {
    if (p.startsWith(folderPath + '/')) relevant.add(p);
  }

  for (const p of relevant) {
    const alive = db.listApps().some(a => {
      const af = folderFromPrefix(a.prefix);
      return af === p || af.startsWith(p + '/');
    });
    if (!alive) db.clearFolderLabel(p);
  }

  // Remove empty directories up the chain (rmdir fails on non-empty or missing
  // dirs, which is exactly the stop condition). Never touches the apps root.
  let dirPath = folderPath;
  while (dirPath) {
    const dir = path.join(getDataDir(), 'apps', ...dirPath.split('/'));
    try { fs.rmdirSync(dir); } catch { break; }
    const i = dirPath.lastIndexOf('/');
    dirPath = i === -1 ? '' : dirPath.slice(0, i);
  }
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
      await compose.composeDown(name, folderFromPrefix(existing.prefix));
    } catch {
      // Compose project might not exist
    }
  }

  // Remove files
  fs.rmSync(appDir(name), { recursive: true, force: true });

  // Remove from database, then clean up the folder (labels + empty dirs) if
  // this was the last app in it.
  const folderPath = folderFromPrefix(existing.prefix);
  db.deleteApp(name);
  cleanupFolder(folderPath);
}

export async function getLogs(name: string, tail: number): Promise<string> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`);

  if (existing.type === 'docker') {
    return docker.getContainerLogs(name, tail);
  }

  if (existing.type === 'docker-compose') {
    return compose.composeLogs(name, folderFromPrefix(existing.prefix), tail);
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
    await compose.composeDown(name, folderFromPrefix(existing.prefix));
    await compose.composeUp(name, folderFromPrefix(existing.prefix), config.services);
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
      await compose.composeDown(name, folderFromPrefix(existing.prefix));
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

  const config = mergeConfig(existing.type, existing.config);
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
    await compose.composeUp(name, folderFromPrefix(existing.prefix), composeConfig.services);
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

  // Drop all existing app routes (legacy ids, drift), then rebuild from DB rows.
  // Caddy being unreachable at boot must not kill the server — routes are
  // best-effort here and per-app below.
  try {
    await caddy.clearAppRoutes();
  } catch (err) {
    console.error('Failed to clear app routes:', err);
  }

  const rows = db.listApps();
  for (const row of rows) {
    const config = mergeConfig(row.type, row.config);
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
