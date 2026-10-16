import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import * as db from '../db';
import * as caddy from './caddy';
import * as docker from './docker';
import { parseMemLimitStrict, cpuSharesFromLimit } from './docker';
import * as compose from './compose';
import { inspectCompose } from './compose-validation';
import { GitSource, validateGitSource, cloneRepo, stripEscapingSymlinks } from './git';
import { ValidationError, DockerError } from './errors';

export { ValidationError, DockerError };

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
  // P2: build once (create/update) in a one-shot build container, then run
  // `run_command` (or `command`) in the app container. Config/env-only changes
  // then restart the app container without rebuilding — seconds, not minutes.
  build_command?: string;
  run_command?: string;
}

export interface DockerComposeAppConfig {
  compose_file?: string;
  services: Record<string, { port: number }>;
}

// Optional on every type: relative directories inside the app dir that must
// survive file replacement (SQLite DBs, uploads, ...). Moved aside during
// update, restored after extraction. strip_prefix only applies to
// docker/docker-compose routes (validated at merge time). git records the
// deploy source for apps created/updated via the git endpoints — set only by
// those endpoints, never by JSON/zip create (which reject it in config).
export interface SharedAppConfig {
  preserve_dirs?: string[];
  strip_prefix?: boolean;
  git?: GitSource;
}

export type AppConfig = (StaticAppConfig | DockerAppConfig | DockerComposeAppConfig) & SharedAppConfig;

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

// POSIX-ish env names. The value is passed to docker as one `NAME=value` argv
// element, so '=' or a newline in the name would inject an extra variable.
const ENV_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Every create path must reject an unknown type: it becomes the row's `type`,
// which the landing page renders (now escaped) and db writes. The zip and git
// endpoints previously took the client's string with only a cast, so a crafted
// value reached the row unchecked.
function validateType(type: unknown): asserts type is AppInput['type'] {
  if (type !== 'static' && type !== 'docker' && type !== 'docker-compose') {
    throw new ValidationError('"type" must be one of: static, docker, docker-compose.');
  }
}

function validateName(name: string): void {
  if (!name || !NAME_REGEX.test(name)) {
    throw new ValidationError(
      'Name must be lowercase letters, numbers, and hyphens. Must start with a letter.',
      'invalid_name'
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

// Container-side working directory: the app dir relative to the volume root
// (/app), mirroring the disk layout /data/apps[/<folder>]/<name>.
function containerWorkDir(name: string, folder: string): string {
  return `/app/apps${folder ? `/${folder}` : ''}/${name}`;
}

// Index must be a bare filename: no leading '/', no path separators, no '..' traversal.
// Checked for EVERY type, not just static: mergeConfig spreads the patch, so a
// docker/compose row can carry an `index` field, and extractTitle joins it onto
// the app directory (rowToOutput and listApps both call it) — a traversal value
// would make the API read an arbitrary host file as root.
function validateStaticConfig(config: AppConfig, type: 'static' | 'docker' | 'docker-compose'): void {
  if (!('index' in config) || config.index === undefined) return;
  const { index } = config as StaticAppConfig;
  if (typeof index !== 'string' || !index || index.startsWith('/') || /[\\/]/.test(index) || index === '..') {
    throw new ValidationError(`Invalid index file: ${String(index)}`);
  }
}

// Merge defaults < stored config < patch so partial configs never lose stored fields.
function mergeConfig(
  type: 'static' | 'docker' | 'docker-compose',
  stored?: string,
  patch?: AppConfig
): AppConfig {
  // git is a deploy-source record set by the git endpoints only; JSON/zip
  // creates and PATCHes must not smuggle one in (the API never stores
  // credentials, and a stray git field would misrepresent the deploy source).
  if (patch?.git !== undefined) {
    throw new ValidationError('"git" must be given at the top level, not inside config.');
  }
  if (patch?.preserve_dirs !== undefined) validatePreserveDirs(patch.preserve_dirs);
  // compose_file names the file composeUp executes, so it must be a bare
  // .yml/.yaml filename inside the app directory. Rejecting it here turns a bad
  // value into a 400 at the API boundary instead of a shell/argv hazard (or a
  // silent no-op) at deploy time. Same rule as composeFileName.
  if (type === 'docker-compose' && (patch as DockerComposeAppConfig | undefined)?.compose_file !== undefined) {
    compose.composeFileName(patch as DockerComposeAppConfig);
  }
  if (patch?.strip_prefix !== undefined) {
    if (typeof patch.strip_prefix !== 'boolean') {
      throw new ValidationError('"strip_prefix" must be a boolean.');
    }
    if (type === 'static' && !patch.strip_prefix) {
      throw new ValidationError('"strip_prefix": false only applies to docker and docker-compose apps.');
    }
  }
  for (const key of ['build_command', 'run_command'] as const) {
    // Config arrives as the AppConfig union; build_command/run_command are
    // docker-only, so narrow through Partial<DockerAppConfig>.
    const cmd = (patch as Partial<DockerAppConfig> | undefined)?.[key];
    if (cmd !== undefined && typeof cmd !== 'string') {
      throw new ValidationError(`"${key}" must be a string.`);
    }
  }
  const base = { ...getDefaultConfig(type), ...(stored ? JSON.parse(stored) : {}), ...patch } as Partial<DockerAppConfig> & AppConfig;
  // P3: env is a map — merge over the stored env so partial updates never
  // clobber other variables (e.g. re-sending one var dropping NEXTAUTH_SECRET).
  const patchEnv = (patch as Partial<DockerAppConfig> | undefined)?.env;
  if (patchEnv && typeof patchEnv === 'object' && stored) {
    const storedConfig = JSON.parse(stored) as Partial<DockerAppConfig>;
    if (storedConfig.env && typeof storedConfig.env === 'object') {
      base.env = { ...storedConfig.env, ...patchEnv };
    }
  }
  // P4: build-in-container apps need headroom; the 128m default OOMs builds.
  if (base.build_command && base.mem_limit === '128m') {
    base.mem_limit = '2g';
  }
  // Validate the merged result, not just the patch: a stored config may predate
  // these rules, and every value here reaches the docker daemon or Caddy.
  if (type === 'docker') validateDockerConfig(base as DockerAppConfig);
  if (type === 'docker-compose') validateComposeConfig(base as DockerComposeAppConfig);
  validateStaticConfig(base, type);
  return base;
}

// A service name becomes a URL segment (`/<app>/<service>`) in the Caddy route
// and part of the container name, so it must be a plain slug. Unvalidated, a
// name of `*` produces a Caddy path matcher `/<app>/*` that hijacks every
// sibling path under the app's prefix (verified against the admin API), and
// `..`/`/` produce nonsense routes. Same charset as an app name / folder
// segment, so it can never be a wildcard, a traversal, or an empty segment.
const SERVICE_NAME_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

function validateDockerConfig(config: DockerAppConfig): void {
  if (typeof config.image !== 'string' || config.image.trim() === '') {
    throw new ValidationError('"image" must be a non-empty string.');
  }
  const port = config.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError('"port" must be an integer between 1 and 65535.');
  }
  // cpu_limit is "cores" (docker shares are relative to 1024). Validate the
  // value that actually reaches the daemon: a config that isn't a positive
  // finite number yields NaN shares, and a huge one overflows to Infinity ->
  // JSON null -> docker's default, i.e. no limit at all. Using the same
  // arithmetic as deployment is what keeps the two from diverging.
  const shares = cpuSharesFromLimit(typeof config.cpu_limit === 'string' ? config.cpu_limit : '');
  if (!Number.isFinite(shares) || shares <= 0) {
    throw new ValidationError('"cpu_limit" must be a positive number (cores), e.g. "0.5".');
  }
  // mem_limit must parse and be > 0 — "0"/"0m" means unlimited in docker, which
  // is never what "set a memory limit" asked for. Note NaN <= 0 is false, so
  // test for a finite positive number rather than negating the comparison.
  const mem = typeof config.mem_limit === 'string' ? parseMemLimitStrict(config.mem_limit) : NaN;
  if (!Number.isFinite(mem) || mem <= 0) {
    throw new ValidationError('"mem_limit" must be a size like "128m" or "1g" (greater than zero).');
  }
  if (config.env === undefined || typeof config.env !== 'object' || config.env === null || Array.isArray(config.env)) {
    throw new ValidationError('"env" must be a map of name to value.');
  }
  // Each entry is passed to docker as a `NAME=value` argv element, so a name
  // containing '=' or a newline would inject an extra container variable.
  for (const [key, value] of Object.entries(config.env)) {
    if (!ENV_NAME_REGEX.test(key)) {
      throw new ValidationError(`Invalid env variable name: ${JSON.stringify(key)}`);
    }
    if (typeof value !== 'string') {
      throw new ValidationError(`"env.${key}" must be a string.`);
    }
    // docker receives one `NAME=value` argv element per entry; a newline in the
    // value terminates that element and introduces a second, undeclared
    // variable (verified against the daemon). NUL truncates it.
    if (/[\n\r\0]/.test(value)) {
      throw new ValidationError(`"env.${key}" must not contain newlines or NUL bytes.`);
    }
  }
}

function validateComposeConfig(config: DockerComposeAppConfig): void {
  const services = config.services;
  if (services === undefined || typeof services !== 'object' || services === null || Array.isArray(services)) {
    throw new ValidationError('"services" must be a map of service name to { port }.');
  }
  for (const [name, svc] of Object.entries(services)) {
    if (!SERVICE_NAME_REGEX.test(name)) {
      throw new ValidationError(
        `Invalid service name "${name}": must be lowercase letters, digits, hyphens or underscores (it is used as a URL path segment).`
      );
    }
    const port = svc !== null && typeof svc === 'object' && 'port' in svc ? svc.port : undefined;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ValidationError(`"services.${name}.port" must be an integer between 1 and 65535.`);
    }
  }
}

// Default routing mode is prefix-stripping; pass-through only when the app
// opts in via strip_prefix: false (native base-path apps).
function stripPrefix(config: AppConfig): boolean {
  return config.strip_prefix !== false;
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
      throw new ValidationError(`Invalid folder path: ${folder}`, 'invalid_name');
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
    throw new ValidationError(`Prefix "${prefix}" is already in use`, 'prefix_conflict');
  }
  throw new ValidationError(`Prefix "${prefix}" conflicts with existing app at "${conflict.prefix}"`, 'prefix_conflict');
}

// Docker and compose containers share one flat name space:
//   docker app  <n>          -> ld-app-<n>
//   compose app <a> svc <s>  -> ld-<a>-<s>
// so docker app `x` and compose app `app` (service `x`) both resolve to
// `ld-app-x`. Creation force-removes any container with the matching name
// (removeContainerIfExists), so the second app silently destroys the first
// app's live container while its DB row still says "running". Reject the
// collision up front rather than let two apps own one name.
function containerNamesFor(type: AppInput['type'], name: string, config: AppConfig): string[] {
  if (type === 'docker') return [`ld-app-${name}`];
  if (type === 'docker-compose') {
    return Object.keys((config as DockerComposeAppConfig).services ?? {}).map(s => `ld-${name}-${s}`);
  }
  return [];
}

function throwIfContainerNameConflict(
  type: AppInput['type'],
  name: string,
  config: AppConfig,
  exceptName?: string
): void {
  const wanted = new Set(containerNamesFor(type, name, config));
  if (wanted.size === 0) return;
  for (const row of db.listApps()) {
    if (row.name === exceptName) continue;
    const theirs = containerNamesFor(row.type, row.name, JSON.parse(row.config));
    const clash = theirs.find(t => wanted.has(t));
    if (clash) {
      throw new ValidationError(
        `App "${name}" would use container name "${clash}", already used by app "${row.name}" — rename one of them`,
        'container_name_conflict'
      );
    }
  }
}

// Reserved URL space: the management API (/api/*), the machine-readable
// pointer (/llms.txt), and the root catch-all. App routes are inserted ahead
// of the Caddyfile system routes, so an app claiming these would intercept the
// management API (and receive the landing page's stored Bearer key) or shadow
// every other path on the host.
function throwIfReservedPrefix(prefix: string): void {
  if (prefix === '/' || prefix === '/api' || prefix.startsWith('/api/') || prefix === '/llms.txt') {
    throw new ValidationError(`Prefix "${prefix}" is reserved and cannot be used by apps`);
  }
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

// Zip-bomb guard: multer caps the archive at 100MB compressed, but the
// decompressed size is unbounded. Check the central-directory sizes before
// any extraction — adm-zip inflates each entry fully in memory, so a single
// huge entry is a memory DoS and a huge total fills /data.
const MAX_ZIP_ENTRIES = 100_000;
const MAX_ZIP_ENTRY_SIZE = 1024 * 1024 * 1024; // 1GB per file
const MAX_ZIP_TOTAL_SIZE = 2 * 1024 * 1024 * 1024; // 2GB total
// An entry whose declared uncompressed size is 0 while carrying compressed data
// is a forged header, not a file: adm-zip's inflater only sets
// `maxOutputLength` when the declared size is > 0, so such an entry inflates
// with no cap at all. Verified: a 64KB archive declaring size 0 inflated a
// 64MB buffer in this process; at multer's 100MB limit that is tens of GB of RAM
// in the PID holding the docker socket. A genuinely empty file declares 0 for
// its compressed size too, so it is unaffected.
function validateZipEntries(zip: AdmZip): void {
  const entries = zip.getEntries();
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new ValidationError(`Zip has too many entries (max ${MAX_ZIP_ENTRIES})`);
  }
  let total = 0;
  for (const entry of entries) {
    const size = entry.header.size;
    if (size === 0 && entry.header.compressedSize > 0) {
      throw new ValidationError(
        `Zip entry "${entry.entryName}" declares no uncompressed size but carries ${entry.header.compressedSize} compressed bytes — refusing to extract`
      );
    }
    if (size > MAX_ZIP_ENTRY_SIZE) {
      throw new ValidationError(`Zip entry too large: ${entry.entryName} (max 1GB per file)`);
    }
    total += size;
    if (total > MAX_ZIP_TOTAL_SIZE) {
      throw new ValidationError('Zip expands beyond 2GB — refusing to extract');
    }
  }
}

function writeFiles(name: string, folder: string, files: AppFile[]): void {
  const dir = appDir(name, folder);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  for (const file of files) {
    const filePath = path.join(dir, file.path);
    const parentDir = path.dirname(filePath);

    // Prevent path traversal: name/folder regexes and the '..' ban already
    // keep the join inside `dir`, but check the resolved relative path too so
    // a prefix-confusable path (a sibling dir named like `dir` plus a suffix)
    // can never slip through.
    const rel = path.relative(dir, filePath);
    if (file.path.includes('..') || rel.startsWith('..') || path.isAbsolute(rel)) {
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
      // Never follow a symlink: a link planted in the app directory (by a
      // running app container, which has the dir mounted read-write, or by a
      // crafted archive) would make this read an arbitrary host file — e.g.
      // management.db — and hand it back in the API response. Creation paths
      // strip escaping links, but reading is the last line of defence for links
      // that already exist.
      if (entry.isSymbolicLink()) continue;
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

  validateType(input.type);
  if (!Array.isArray(input.files)) {
    throw new ValidationError('"files" must be an array of { path, content } objects.');
  }

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
  throwIfReservedPrefix(prefix);

  const icon = input.icon !== undefined ? validateIcon(input.icon) : '';

  if (db.appExists(input.name)) {
    throw new ValidationError(`App "${input.name}" already exists`, 'app_already_exists');
  }

  throwIfPrefixConflict(prefix);

  const now = new Date().toISOString();
  const config = mergeConfig(input.type, undefined, input.config);
  throwIfContainerNameConflict(input.type, input.name, config);

  // Write files to disk
  writeFiles(input.name, folder, input.files);
  stripEscapingSymlinks(appDir(input.name, folder));

  let containerId: string | null = null;

  try {
    if (input.type === 'docker') {
      const dockerConfig = config as DockerAppConfig;
      await docker.pullImage(dockerConfig.image);
      containerId = await docker.createContainer(input.name, containerWorkDir(input.name, folder), dockerConfig);
      await caddy.addDockerRoute(prefix, containerId, dockerConfig.port, stripPrefix(config));
    } else if (input.type === 'docker-compose') {
      const composeConfig = config as DockerComposeAppConfig;
      await compose.composeUp(input.name, folder, composeConfig);
      await addComposeRoutes(prefix, input.name, composeConfig.services, stripPrefix(config));
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
  validateType(type);

  const iconNorm = icon !== undefined ? validateIcon(icon) : '';
  const folderNorm = validateFolder(folder ?? '');
  const prefix = folderNorm ? `/${folderNorm}/${name}` : `/${name}`;
  throwIfReservedPrefix(prefix);

  if (db.appExists(name)) {
    throw new ValidationError(`App "${name}" already exists`, 'app_already_exists');
  }

  throwIfPrefixConflict(prefix);

  // Extract zip to app directory
  const dir = appDir(name, folderNorm);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const zip = new AdmZip(zipPath);
  validateZipEntries(zip);
  zip.extractAllTo(dir, true);
  fs.rmSync(zipPath, { force: true });
  stripEscapingSymlinks(dir);

  const now = new Date().toISOString();
  const config = mergeConfig(type, undefined, appConfig);
  throwIfContainerNameConflict(type, name, config);

  let containerId: string | null = null;

  try {
    if (type === 'docker') {
      const dockerConfig = config as DockerAppConfig;
      await docker.pullImage(dockerConfig.image);
      containerId = await docker.createContainer(name, containerWorkDir(name, folderNorm), dockerConfig);
      await caddy.addDockerRoute(prefix, containerId, dockerConfig.port, stripPrefix(config));
    } else if (type === 'docker-compose') {
      const composeConfig = config as DockerComposeAppConfig;
      await compose.composeUp(name, folderNorm, composeConfig);
      await addComposeRoutes(prefix, name, composeConfig.services, stripPrefix(config));
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

async function updateAppFromZipLocked(
  name: string,
  zipPath: string,
  appConfig?: AppConfig,
  icon?: string
): Promise<AppOutput> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`, 'app_not_found');

  const now = new Date().toISOString();
  const merged = mergeConfig(existing.type, existing.config, appConfig);
  throwIfContainerNameConflict(existing.type, name, merged, name);
  const updates: Parameters<typeof db.updateApp>[1] = { updated_at: now, config: JSON.stringify(merged) };
  if (icon !== undefined) updates.icon = validateIcon(icon);

  // Replace files, keeping configured runtime-data dirs (DBs, uploads) alive.
  const dir = appDir(name);
  withPreservedDirs(dir, dir, merged.preserve_dirs ?? [], () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const zip = new AdmZip(zipPath);
    // Same central-directory caps as create: extraction inflates every entry in
    // memory, so an unchecked archive is a memory/disk DoS on the root process.
    validateZipEntries(zip);
    zip.extractAllTo(dir, true);
    fs.rmSync(zipPath, { force: true });
  });
  // The archive may carry symlink entries, and the previous version of this app
  // may itself have left links behind.
  stripEscapingSymlinks(dir);

  // Refresh Caddy route
  const prefix = existing.prefix;
  await caddy.removeRoute(prefix);

  if (existing.type === 'docker') {
    const dockerConfig = merged as DockerAppConfig;
    const containerName = docker.containerNameForApp(existing.name);
    await docker.stopContainer(name);
    await docker.pullImage(dockerConfig.image);
    const containerId = await docker.createContainer(name, containerWorkDir(name, folderFromPrefix(prefix)), dockerConfig);
    await caddy.addDockerRoute(prefix, containerId, dockerConfig.port, stripPrefix(merged));
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
    await compose.composeUp(name, folderFromPrefix(prefix), composeConfig);
    await addComposeRoutes(prefix, name, composeConfig.services, stripPrefix(merged));
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

export async function createAppFromGit(
  name: string,
  type: 'static' | 'docker' | 'docker-compose',
  git: GitSource,
  appConfig?: AppConfig,
  folder?: string,
  icon?: string
): Promise<AppOutput> {
  validateName(name);
  validateType(type);

  const iconNorm = icon !== undefined ? validateIcon(icon) : '';
  const folderNorm = validateFolder(folder ?? '');
  const prefix = folderNorm ? `/${folderNorm}/${name}` : `/${name}`;
  throwIfReservedPrefix(prefix);

  if (db.appExists(name)) {
    throw new ValidationError(`App "${name}" already exists`, 'app_already_exists');
  }

  throwIfPrefixConflict(prefix);

  const gitNorm = validateGitSource(git);
  if (appConfig?.git !== undefined) {
    throw new ValidationError('"git" must be given at the top level, not inside config.');
  }

  // Clone repository to app directory
  const dir = appDir(name, folderNorm);
  cloneRepo(gitNorm, dir);

  const now = new Date().toISOString();
  const configMerged = mergeConfig(type, undefined, appConfig);
  configMerged.git = gitNorm;
  throwIfContainerNameConflict(type, name, configMerged);

  let containerId: string | null = null;

  try {
    if (type === 'docker') {
      const dockerConfig = configMerged as DockerAppConfig;
      await docker.pullImage(dockerConfig.image);
      containerId = await docker.createContainer(name, containerWorkDir(name, folderNorm), dockerConfig);
      await caddy.addDockerRoute(prefix, containerId, dockerConfig.port, stripPrefix(configMerged));
    } else if (type === 'docker-compose') {
      const composeConfig = configMerged as DockerComposeAppConfig;
      await compose.composeUp(name, folderNorm, composeConfig);
      await addComposeRoutes(prefix, name, composeConfig.services, stripPrefix(configMerged));
      containerId = JSON.stringify(
        Object.keys(composeConfig.services).reduce((acc, s) => {
          acc[s] = composeContainerName(name, s);
          return acc;
        }, {} as Record<string, string>)
      );
    } else {
      const staticConfig = configMerged as StaticAppConfig;
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
    config: JSON.stringify(configMerged),
    container_id: containerId,
    icon: iconNorm,
    created_at: now,
    updated_at: now,
  };

  db.createApp(row);
  return rowToOutput(db.getApp(name)!);
}

async function updateAppFromGitLocked(
  name: string,
  git: GitSource,
  appConfig?: AppConfig,
  icon?: string
): Promise<AppOutput> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`, 'app_not_found');

  const gitNorm = validateGitSource(git);
  if (appConfig?.git !== undefined) {
    throw new ValidationError('"git" must be given at the top level, not inside config.');
  }

  const now = new Date().toISOString();
  const merged = mergeConfig(existing.type, existing.config, appConfig);
  merged.git = gitNorm;
  throwIfContainerNameConflict(existing.type, name, merged, name);
  const updates: Parameters<typeof db.updateApp>[1] = { updated_at: now, config: JSON.stringify(merged) };
  if (icon !== undefined) updates.icon = validateIcon(icon);

  // Re-clone, keeping configured runtime-data dirs (DBs, uploads) alive.
  // cloneRepo wipes and recreates the app dir itself.
  const dir = appDir(name);
  withPreservedDirs(dir, dir, merged.preserve_dirs ?? [], () => {
    cloneRepo(gitNorm, dir);
  });

  // Refresh Caddy route
  const prefix = existing.prefix;
  await caddy.removeRoute(prefix);

  if (existing.type === 'docker') {
    const dockerConfig = merged as DockerAppConfig;
    const containerName = docker.containerNameForApp(existing.name);
    await docker.stopContainer(name);
    await docker.pullImage(dockerConfig.image);
    const containerId = await docker.createContainer(name, containerWorkDir(name, folderFromPrefix(prefix)), dockerConfig);
    await caddy.addDockerRoute(prefix, containerId, dockerConfig.port, stripPrefix(merged));
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
    await compose.composeUp(name, folderFromPrefix(prefix), composeConfig);
    await addComposeRoutes(prefix, name, composeConfig.services, stripPrefix(merged));
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
  files: AppFile[] | null,
  config?: AppConfig
): Promise<void> {
  throwIfPrefixConflict(newPrefix, existing.name);
  throwIfReservedPrefix(newPrefix);

  const oldFolder = folderFromPrefix(existing.prefix);
  const oldDir = appDir(existing.name, oldFolder);
  const newDir = appDir(existing.name, newFolder);
  const running = existing.status !== 'stopped';

  // The caller's merged config (with this update's patch applied) wins when
  // provided; recreating containers from the stored config alone would drop
  // the very changes the move was requested with.
  const merged = config ?? mergeConfig(existing.type, existing.config);

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
    await addComposeRoutes(newPrefix, existing.name, (merged as DockerComposeAppConfig).services, stripPrefix(merged));
  } else if (existing.type === 'docker') {
    await caddy.removeRoute(existing.prefix);
    await caddy.addDockerRoute(newPrefix, docker.containerNameForApp(existing.name), (merged as DockerAppConfig).port, stripPrefix(merged));
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
      await docker.createContainer(existing.name, containerWorkDir(existing.name, newFolder), merged as DockerAppConfig);
    } else if (existing.type === 'docker-compose') {
      await compose.composeUp(existing.name, newFolder, merged as DockerComposeAppConfig);
    }
  }
}

// Serialize mutating operations per app: update/move/delete/stop/start
// interleave async docker/caddy calls with destructive fs ops (rmSync/
// renameSync), and two concurrent requests on the same app would otherwise
// race on stale DB rows and half-moved directories. The row is re-read after
// the lock is acquired.
const appLocks = new Map<string, Promise<void>>();

async function withAppLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = appLocks.get(name) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  appLocks.set(name, next);
  await prev.catch(() => {}); // a failed op must not break the chain
  try {
    return await fn();
  } finally {
    if (appLocks.get(name) === next) appLocks.delete(name);
    release();
  }
}

export async function moveApp(name: string, folder: string): Promise<AppOutput> {
  return updateApp(name, { folder });
}

// Both update entry points mutate the app directory and the container, so they
// take the same per-app lock as updateApp/move/delete/stop/start. Without it a
// concurrent delete could rmSync the directory mid-update (the update then
// recreates the container of an app that no longer exists), or a concurrent
// start could have its container removed.
export async function updateAppFromZip(
  name: string,
  zipPath: string,
  appConfig?: AppConfig,
  icon?: string
): Promise<AppOutput> {
  return withAppLock(name, () => updateAppFromZipLocked(name, zipPath, appConfig, icon));
}

export async function updateAppFromGit(
  name: string,
  git: unknown,
  appConfig?: AppConfig,
  icon?: string
): Promise<AppOutput> {
  return withAppLock(name, () => updateAppFromGitLocked(name, validateGitSource(git), appConfig, icon));
}

export async function updateApp(name: string, input: Partial<AppInput>): Promise<AppOutput> {
  return withAppLock(name, () => updateAppLocked(name, input));
}

async function updateAppLocked(name: string, input: Partial<AppInput>): Promise<AppOutput> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`, 'app_not_found');

  if (input.folder !== undefined && input.prefix !== undefined) {
    throw new ValidationError('Provide either folder or prefix, not both');
  }

  // Type is immutable after create — changing it would orphan the previous
  // container/routes while the docs promise a same-shape body.
  if (input.type !== undefined && input.type !== existing.type) {
    throw new ValidationError(`Cannot change app type from "${existing.type}" to "${input.type}"`);
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
    await applyMove(existing, newFolder!, newPrefix!, input.files ?? null, merged!);
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

  // If docker app and config or files changed, recreate the container: image/
  // env/command/port/limits are immutable after create, so a plain restart
  // would leave the running container on the OLD config while the DB says new
  // (and a files-only update would keep serving the old files). Moves already
  // recreated the container in applyMove.
  if (existing.type === 'docker' && (input.config || input.files) && !moved) {
    const dockerConfig = merged! as DockerAppConfig;
    await docker.stopContainer(name);
    await docker.pullImage(dockerConfig.image);
    const containerId = await docker.createContainer(name, containerWorkDir(name, folderFromPrefix(currentPrefix)), dockerConfig);
    updates.container_id = containerId;

    await caddy.removeRoute(currentPrefix);
    await caddy.addDockerRoute(currentPrefix, containerId, dockerConfig.port, stripPrefix(merged!));

    if (existing.status === 'stopped') {
      // Keep a stopped app stopped: createContainer starts the container, so
      // stop it again (kept, not removed — the new config is baked in and the
      // next startApp is a plain start).
      await docker.stopContainerKeep(name);
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
    await compose.composeUp(name, folderFromPrefix(currentPrefix), composeConfig);
    await addComposeRoutes(currentPrefix, name, composeConfig.services, stripPrefix(merged!));
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
  return withAppLock(name, () => deleteAppLocked(name));
}

async function deleteAppLocked(name: string): Promise<void> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`, 'app_not_found');

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

/**
 * Dry-run the compose host-safety policy for an existing app. Lets an admin
 * audit stored compose files (e.g. after a policy change) without deploying.
 */
export function checkCompose(name: string): { valid: boolean; violations: string[]; services: string[] } {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`, 'app_not_found');
  if (existing.type !== 'docker-compose') {
    throw new ValidationError(`App "${name}" is not a docker-compose app`);
  }

  const dir = appDir(name);
  // An audit reports what is wrong with the stored app rather than failing on
  // it: an unreadable config or a compose_file that the current rule refuses
  // (e.g. one stored before the name was confined) is itself a violation.
  let composeFile: string;
  try {
    composeFile = compose.composeFileName(JSON.parse(existing.config) as DockerComposeAppConfig);
  } catch (err) {
    return { valid: false, violations: [err instanceof Error ? err.message : String(err)], services: [] };
  }
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, composeFile), 'utf-8');
  } catch {
    return { valid: false, violations: [`${composeFile} not found in the app directory`], services: [] };
  }

  return inspectCompose(text, {
    appDir: dir,
    allowedHostPorts: process.env.LEAFDOCK_ALLOWED_HOST_PORTS,
    allowedBindPaths: process.env.LEAFDOCK_ALLOWED_BIND_PATHS,
  });
}

export async function getLogs(name: string, tail: number): Promise<string> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`, 'app_not_found');

  if (existing.type === 'docker') {
    return docker.getContainerLogs(name, tail);
  }

  if (existing.type === 'docker-compose') {
    return compose.composeLogs(name, folderFromPrefix(existing.prefix), tail);
  }

  // For static apps, read Caddy's access log (written by the `log` directive
  // in the Caddyfile into the data dir) and filter for this app's prefix.
  const logPath = path.join(process.env.DATA_DIR || '/data', 'caddy', 'access.log');
  try {
    if (!fs.existsSync(logPath)) return '(no logs available for static apps)';
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter((l: string) =>
      l.includes(existing.prefix)
    );
    return lines.slice(-tail).join('\n');
  } catch {
    return '(no logs available for static apps)';
  }
}

export async function restartApp(name: string): Promise<AppOutput> {
  return withAppLock(name, () => restartAppLocked(name));
}

async function restartAppLocked(name: string): Promise<AppOutput> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`, 'app_not_found');

  if (existing.type === 'docker') {
    try {
      await docker.restartContainer(name);
    } catch {
      // Container missing (e.g. a stopped non-build-split app) — recreate it
      // from the stored config so restart still brings the app up.
      const dockerConfig = JSON.parse(existing.config) as DockerAppConfig;
      await docker.pullImage(dockerConfig.image);
      await docker.createContainer(name, containerWorkDir(name, folderFromPrefix(existing.prefix)), dockerConfig);
    }
  } else if (existing.type === 'docker-compose') {
    const config = JSON.parse(existing.config) as DockerComposeAppConfig;
    await compose.composeDown(name, folderFromPrefix(existing.prefix));
    await compose.composeUp(name, folderFromPrefix(existing.prefix), config);
  }

  return rowToOutput(db.getApp(name)!);
}

export async function stopApp(name: string): Promise<AppOutput> {
  return withAppLock(name, () => stopAppLocked(name));
}

async function stopAppLocked(name: string): Promise<AppOutput> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`, 'app_not_found');
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
    const dockerConfig = JSON.parse(existing.config) as DockerAppConfig;
    try {
      // Build-split apps keep the container (with its build outputs) so the
      // next start is a plain container start, not a rebuild.
      if (dockerConfig.build_command) {
        await docker.stopContainerKeep(name);
      } else {
        await docker.stopContainer(name);
      }
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
  return withAppLock(name, () => startAppLocked(name));
}

async function startAppLocked(name: string): Promise<AppOutput> {
  const existing = db.getApp(name);
  if (!existing) throw new ValidationError(`App "${name}" not found`, 'app_not_found');
  if (existing.status === 'running') return rowToOutput(existing);

  const config = mergeConfig(existing.type, existing.config);
  const now = new Date().toISOString();
  const updates: Parameters<typeof db.updateApp>[1] = { status: 'running', config: JSON.stringify(config), updated_at: now };

  if (existing.type === 'docker') {
    const dockerConfig = config as DockerAppConfig;
    if (dockerConfig.build_command) {
      // Container is kept across stop/start — start it in place when it still
      // exists, so no rebuild happens on a simple start.
      if (await docker.startContainer(name)) {
        await caddy.addDockerRoute(existing.prefix, docker.containerNameForApp(name), dockerConfig.port, stripPrefix(config));
      } else {
        await docker.pullImage(dockerConfig.image);
        const containerId = await docker.createContainer(name, containerWorkDir(name, folderFromPrefix(existing.prefix)), dockerConfig);
        await caddy.addDockerRoute(existing.prefix, containerId, dockerConfig.port, stripPrefix(config));
        updates.container_id = containerId;
      }
    } else {
      await docker.pullImage(dockerConfig.image);
      const containerId = await docker.createContainer(name, containerWorkDir(name, folderFromPrefix(existing.prefix)), dockerConfig);
      await caddy.addDockerRoute(existing.prefix, containerId, dockerConfig.port, stripPrefix(config));
      updates.container_id = containerId;
    }
  } else if (existing.type === 'docker-compose') {
    const composeConfig = config as DockerComposeAppConfig;
    await compose.composeUp(name, folderFromPrefix(existing.prefix), composeConfig);
    await addComposeRoutes(existing.prefix, name, composeConfig.services, stripPrefix(config));
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
    // mergeConfig validates, so a legacy row whose stored config predates a
    // rule (an old compose service name, a pre-validation cpu_limit, ...) throws
    // here. Inside the try it costs that one app its route; outside it aborts
    // this whole pass, and syncRoutes rejects main(), which exits the process —
    // a boot-time outage from one bad row that requires reading logs to find.
    let config: AppConfig;
    try {
      config = mergeConfig(row.type, row.config);
    } catch (err) {
      console.error(`Skipping route for "${row.name}": stored config is invalid:`, err);
      continue;
    }
    try {
      if (row.type === 'docker') {
        const dockerConfig = config as DockerAppConfig;
        const containerName = docker.containerNameForApp(row.name);
        await caddy.addDockerRoute(row.prefix, containerName, dockerConfig.port, stripPrefix(config));
      } else if (row.type === 'docker-compose') {
        const composeConfig = config as DockerComposeAppConfig;
        await addComposeRoutes(row.prefix, row.name, composeConfig.services, stripPrefix(config));
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

async function addComposeRoutes(prefix: string, name: string, services: Record<string, { port: number }>, stripPrefix = true): Promise<void> {
  const entries = Object.entries(services);
  for (let i = 0; i < entries.length; i++) {
    const [serviceName, config] = entries[i];
    const containerName = composeContainerName(name, serviceName);
    const servicePrefix = i === 0 ? prefix : `${prefix}/${serviceName}`;
    await caddy.addDockerRoute(servicePrefix, containerName, config.port, stripPrefix);
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
