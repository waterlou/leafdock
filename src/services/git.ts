import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ValidationError } from './errors';

// Git source for an app. The URL is stored in config.git (branch/subdir only —
// never a token: private-repo authentication comes from the leafdock
// environment, GIT_TOKENS / GIT_TOKEN, resolved at clone time).
export interface GitSource {
  url: string;
  branch?: string;
  subdir?: string;
}

// Accepts http(s):// for GitHub/Gitea and file:// for local testing. Anything
// else (ssh, git://, ftp) is rejected up front.
function isAllowedGitUrl(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://') || url.startsWith('file://');
}

export function validateGitSource(g: unknown): GitSource {
  if (typeof g !== 'object' || g === null || Array.isArray(g)) {
    throw new ValidationError('"git" must be an object.');
  }
  const obj = g as Record<string, unknown>;
  const { url, branch, subdir } = obj;

  if (typeof url !== 'string' || url === '' || !isAllowedGitUrl(url)) {
    throw new ValidationError('Invalid git URL: must be http(s):// or file://');
  }

  // Embedded credentials would be stored in config.git and returned by the
  // API — contradicting the "tokens never stored" guarantee. Private repos go
  // through GIT_TOKENS/GIT_TOKEN in the environment instead.
  if (url.startsWith('http')) {
    try {
      if (new URL(url).username) {
        throw new ValidationError('Git URLs must not embed credentials — use GIT_TOKENS/GIT_TOKEN instead.');
      }
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      // Malformed URL — let git report the failure at clone time.
    }
  }

  if (branch !== undefined && (typeof branch !== 'string' || branch === '')) {
    throw new ValidationError('Invalid git branch: must be a non-empty string');
  }

  if (subdir !== undefined) {
    if (
      typeof subdir !== 'string' ||
      subdir === '' ||
      subdir.startsWith('/') ||
      subdir.includes('\\')
    ) {
      throw new ValidationError('Invalid git subdir: must be a relative path');
    }
    if (subdir.split('/').some(s => s === '..' || s === '.')) {
      throw new ValidationError('Invalid git subdir: must not contain "." or ".." segments');
    }
  }

  const out: GitSource = { url };
  if (branch !== undefined) out.branch = branch;
  if (subdir !== undefined) out.subdir = subdir;
  return out;
}

// Resolve the credential for a repo host from the environment. Never reads
// tokens from requests, the DB, or config.git. Host-keyed GIT_TOKENS wins over
// the single GIT_TOKEN; file:// URLs (empty host) never authenticate.
export function resolveGitToken(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return undefined;
  }
  if (!host) return undefined;

  const raw = process.env.GIT_TOKENS;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const value = (parsed as Record<string, unknown>)[host];
        if (typeof value === 'string' && value !== '') return value;
      } else {
        console.warn('GIT_TOKENS is not a JSON object of host->token — ignoring');
      }
    } catch {
      console.warn('GIT_TOKENS is not a JSON object of host->token — ignoring');
    }
  }

  const single = process.env.GIT_TOKEN;
  if (single && single !== '') return single;
  return undefined;
}

// Full re-clone into `dest` (dest is wiped first). The token never appears in
// argv (process lists leak it) — it is passed as a git config extraheader,
// which both GitHub PATs and Gitea tokens accept via Basic auth.
// Delete symlinks whose target resolves outside `root` (the app dir). Links
// resolving inside are kept — they can only reach the app's own content, and
// breaking them would harm legit repos. Absolute targets and chains like
// a -> b -> /etc/passwd are both caught because the link itself is checked,
// not the chain's final destination.
function stripEscapingSymlinks(root: string): void {
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        let target: string;
        try {
          target = path.resolve(path.dirname(full), fs.readlinkSync(full));
        } catch {
          fs.rmSync(full, { force: true });
          continue;
        }
        // A link to the root itself would make Caddy serve the whole app dir
        // recursively — treat it like an escape.
        if (target === root || path.relative(root, target).startsWith('..')) {
          fs.rmSync(full, { force: true });
        }
      } else if (st.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(root);
}

export function cloneRepo(source: GitSource, dest: string): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const tmp = fs.mkdtempSync(path.join(path.dirname(dest), '.git-clone-'));
  try {
    const args: string[] = ['clone', '--depth', '1'];
    if (source.branch) args.push('--branch', source.branch);
    args.push(source.url, tmp);

    // The token never touches argv — process lists leak it — and never
    // touches disk; it is injected via GIT_CONFIG_* env vars as an http
    // extraheader, which both GitHub PATs and Gitea tokens accept via Basic
    // auth.
    const env: NodeJS.ProcessEnv = { ...process.env };
    const token = resolveGitToken(source.url);
    if (token) {
      const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraheader';
      env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${encoded}`;
    }

    try {
      execFileSync('git', args, { encoding: 'utf8', env });
    } catch (err) {
      const e = err as { code?: string; stderr?: string };
      if (e.code === 'ENOENT') {
        throw new ValidationError('git is not installed in this environment');
      }
      let stderr = (e.stderr ?? '').toString();
      // git echoes the URL on failure; don't hand it back verbatim.
      stderr = stderr.split(source.url).join('<url>');
      throw new ValidationError(`Git clone failed: ${stderr.slice(-2000)}`);
    }

    if (source.subdir) {
      const sub = path.join(tmp, source.subdir);
      if (!fs.existsSync(sub)) {
        throw new ValidationError(`Git subdir "${source.subdir}" not found in repository`);
      }
      // verbatimSymlinks: cpSync would otherwise rewrite link targets to
      // absolute paths into the throwaway clone dir, breaking inside-links
      // (and fooling the escape check below).
      fs.cpSync(sub, dest, { recursive: true, verbatimSymlinks: true });
    } else {
      fs.cpSync(tmp, dest, { recursive: true, verbatimSymlinks: true });
    }

    // The checkout's .git is useless at runtime (updates re-clone) and would
    // let file:// clones exfiltrate other git apps' committed history.
    fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true });

    // Git materializes symlink entries as-is; a link pointing outside the app
    // dir (e.g. /data/management.db) would be served publicly by Caddy's
    // file_server and read through by the API. Drop links that escape the
    // tree; links staying inside are harmless (they only reach the app's own
    // content).
    stripEscapingSymlinks(dest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
