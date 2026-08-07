import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ValidationError } from './apps';

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
export function cloneRepo(source: GitSource, dest: string): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const tmp = fs.mkdtempSync(path.join(path.dirname(dest), '.git-clone-'));
  try {
    const args: string[] = ['clone', '--depth', '1'];
    const token = resolveGitToken(source.url);
    if (token) {
      const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
      args.push('-c', `http.extraheader=AUTHORIZATION: basic ${encoded}`);
    }
    if (source.branch) args.push('--branch', source.branch);
    args.push(source.url, tmp);

    try {
      execFileSync('git', args, { encoding: 'utf8' });
    } catch (err) {
      const e = err as { code?: string; stderr?: string };
      if (e.code === 'ENOENT') {
        throw new ValidationError('git is not installed in this environment');
      }
      const stderr = (e.stderr ?? '').toString();
      throw new ValidationError(`Git clone failed: ${stderr.slice(-2000)}`);
    }

    if (source.subdir) {
      const sub = path.join(tmp, source.subdir);
      if (!fs.existsSync(sub)) {
        throw new ValidationError(`Git subdir "${source.subdir}" not found in repository`);
      }
      fs.cpSync(sub, dest, { recursive: true });
    } else {
      fs.cpSync(tmp, dest, { recursive: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
