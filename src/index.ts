import express from 'express';
import cors from 'cors';
import * as fs from 'fs';
import * as path from 'path';
import { initDb } from './db';
import { authMiddleware } from './middleware/auth';
import { jsonErrorHandler } from './middleware/json';
import { syncRoutes } from './services/apps';
import healthRouter from './routes/health';
import appsRouter from './routes/apps';
import foldersRouter from './routes/folders';

const PORT = parseInt(process.env.PORT || '3001', 10);
const DATA_DIR = process.env.DATA_DIR || '/data';

function ensureLandingPage(): void {
  const landingDir = path.join(DATA_DIR, 'landing');
  fs.mkdirSync(landingDir, { recursive: true });

  const indexPath = path.join(landingDir, 'index.html');
  const title = process.env.TITLE || 'Leafdock';

  // Machine-readable pointer for AI agents (llms.txt convention): the usage
  // skill is the authoritative how-to for the management API.
  fs.writeFileSync(path.join(landingDir, 'llms.txt'), `# ${title}

Deploy and manage web apps on this server through the REST API (base: /api/v1).

AI agents: read the full usage skill before deploying:
https://raw.githubusercontent.com/waterlou/leafdock/refs/heads/main/skills/leafdock/SKILL.md
`, 'utf-8');

  fs.writeFileSync(indexPath, `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="alternate" type="text/markdown" title="Leafdock AI skill" href="https://raw.githubusercontent.com/waterlou/leafdock/refs/heads/main/skills/leafdock/SKILL.md">
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<style>
  :root { --bg: #0d1117; --fg: #c9d1d9; --card-bg: #161b22; --card-border: #30363d; --link: #58a6ff; --muted: #8b949e; --hover: #1c2128; --tag-bg: #21262d; --green: #3fb950; --yellow: #d29922; --red: #f85149; --select-bg: #21262d; --select-border: #30363d; --err-bg: #21262d; }
  .light { --bg: #f6f8fa; --fg: #24292f; --card-bg: #ffffff; --card-border: #d0d7de; --link: #0969da; --muted: #656d76; --hover: #f3f4f6; --tag-bg: #e8eaed; --green: #1a7f37; --yellow: #9a6700; --red: #cf222e; --select-bg: #f6f8fa; --select-border: #d0d7de; --err-bg: #f6f8fa; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body, .card, .page-title, .app-type, .theme-toggle, .toolbar, .sort-group button, .edit-btn, .apps li, .app-actions button, .error-detail { transition: background 0.3s, color 0.3s, border-color 0.3s; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--fg); min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; }
  .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 40px; max-width: 600px; width: 100%; text-align: center; }
  .page-title-row { display: flex; align-items: center; justify-content: center; gap: 8px; }
  .page-title { color: var(--link); font-size: 24px; margin-bottom: 20px; text-align: center; transition: color 0.3s; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 16px; }
  .sort-group { display: flex; border: 1px solid var(--select-border); border-radius: 6px; overflow: hidden; }
  .sort-group button { background: var(--select-bg); border: none; color: var(--muted); padding: 4px 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .sort-group button + button { border-left: 1px solid var(--select-border); }
  .sort-group button.active { background: var(--link); color: #fff; }
  .sort-group button:hover:not(.active) { color: var(--fg); }
  .edit-btn { background: var(--select-bg); border: 1px solid var(--select-border); color: var(--fg); padding: 4px 8px; border-radius: 6px; font-size: 12px; cursor: pointer; }
  .edit-btn:hover { border-color: var(--link); }
  .edit-btn.active { background: var(--select-bg); border-color: var(--link); color: var(--link); }
  p { color: var(--muted); font-size: 14px; margin-bottom: 24px; transition: color 0.3s; }
  .apps { list-style: none; text-align: left; }
  .apps li { padding: 12px 16px; border: 1px solid var(--card-border); border-radius: 8px; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
  .apps li:hover { background: var(--hover); }
  .nav-btn { background: var(--select-bg); border: 1px solid var(--select-border); color: var(--fg); padding: 4px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; }
  .nav-btn:hover { border-color: var(--link); }
  .folder-row { color: var(--muted); font-weight: 600; font-size: 16px; cursor: pointer; }
  .folder-row::before { content: '▸'; color: var(--muted); font-size: 11px; }
  .folder-row:hover { color: var(--link); }
  .folder-row:hover::before { color: var(--link); }
  .app-name { color: var(--link); font-weight: 600; text-decoration: none; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; text-align: left; }
  .app-name:hover { text-decoration: underline; }
  .app-icon { font-size: 16px; flex-shrink: 0; }
  .app-info { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .app-type { color: var(--muted); font-size: 12px; background: var(--tag-bg); padding: 2px 8px; border-radius: 4px; }
  .status { font-size: 12px; }
  .status[data-action="toggle-status"] { cursor: pointer; }
  .status[data-action="toggle-status"]:hover { text-decoration: underline; }
  .status.running { color: var(--green); }
  .status.stopped { color: var(--yellow); }
  .status.error { color: var(--red); }
  /* Mobile: drop the type tag, collapse status text into a colored dot */
  @media (max-width: 600px) {
    .app-type { display: none; }
    .status { font-size: 0; }
    .status::before { content: '●'; font-size: 14px; }
  }
  .app-actions { display: flex; gap: 4px; flex-shrink: 0; overflow: hidden; max-width: 0; opacity: 0; visibility: hidden; transition: opacity 0.2s, visibility 0.2s, max-width 0.2s; }
  .editing .app-actions { max-width: 200px; opacity: 1; visibility: visible; }
  .app-actions button { border: none; border-radius: 4px; padding: 3px 8px; font-size: 11px; cursor: pointer; }
  .app-actions .del-btn { background: var(--red); color: #fff; }
  .app-actions .exp-btn { background: var(--select-bg); color: var(--fg); border: 1px solid var(--card-border); }
  .app-actions .del-btn:hover { opacity: 0.8; }
  .app-actions .exp-btn:hover { border-color: var(--link); }
  .empty { color: var(--muted); font-style: italic; padding: 20px; transition: color 0.3s; }
  .error-detail { margin-top: 24px; padding: 16px; background: var(--err-bg); border-radius: 8px; font-family: monospace; font-size: 13px; color: var(--muted); }
  .error-detail strong { color: var(--red); }
  .loading { color: var(--muted); }
  .theme-toggle { margin-top: 24px; background: var(--card-bg); border: 1px solid var(--card-border); color: var(--muted); width: 36px; height: 36px; border-radius: 50%; font-size: 18px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .theme-toggle:hover { color: var(--fg); border-color: var(--link); }
  .skill-link { margin-top: 12px; color: var(--muted); font-size: 11px; text-decoration: none; opacity: 0.6; }
  .skill-link:hover { opacity: 1; color: var(--link); }
</style>
</head>
<body>
<div class="page-title-row">
  <button class="nav-btn" id="back-btn" style="display:none">&#8592; Back</button>
  <button class="nav-btn" id="root-btn" style="display:none">Root</button>
  <h1 class="page-title" id="page-title">${title}</h1>
</div>
<div class="card">
  <div class="toolbar">
    <div class="sort-group" id="sort-group">
      <button class="active" data-sort="date"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></button>
      <button data-sort="name"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></button>
    </div>
    <button class="edit-btn" id="edit-btn">Edit</button>
  </div>
  <p>Your apps are listed below.</p>
  <div id="app-list" class="loading">Loading apps...</div>
</div>
<button class="theme-toggle" id="theme-toggle"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg></button>
<a class="skill-link" href="https://raw.githubusercontent.com/waterlou/leafdock/refs/heads/main/skills/leafdock/SKILL.md" target="_blank" rel="noreferrer">AI: deployment skill (markdown)</a>
<script>
var sunSVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
var moonSVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

(function() {
  var t = localStorage.getItem('theme');
  if (t === 'light') { document.body.classList.add('light'); document.getElementById('theme-toggle').innerHTML = moonSVG; }
})();

var appsData = [];
var editing = false;
var currentFolder = '';
var folderLabels = {};

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parentFolder(folder) {
  var i = folder.lastIndexOf('/');
  return i === -1 ? '' : folder.slice(0, i);
}

// The current folder from the URL path ('/new-demo/guides' -> 'new-demo/guides',
// '' at root). App paths never collide with folder paths: an app at the exact
// folder prefix would be a tree conflict at creation.
function folderFromPath() {
  var p = decodeURIComponent(location.pathname);
  while (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);
  if (!p || p === '/') return '';
  return p.charAt(0) === '/' ? p.slice(1) : p;
}

// A folder URL is only meaningful when some app lives in it (or nested under it).
function validFolder(folder) {
  return (appsData || []).some(function(a) {
    var f = a.folder || '';
    return f === folder || f.indexOf(folder + '/') === 0;
  });
}

// Navigate + keep the URL in sync so folders are deep-linkable and browser
// Back works.
function goToFolder(folder) {
  currentFolder = folder;
  var url = folder === '' ? '/' : '/' + folder;
  if (location.pathname !== url) history.pushState(null, '', url);
  renderApps(document.getElementById('app-list-items'), appsData, getSort());
}

// Immediate subfolders of 'folder' (one level only), as full paths from root.
function childFolders(apps, folder) {
  var seen = {};
  var out = [];
  apps.forEach(function(a) {
    var f = a.folder || '';
    if (f === folder) return;
    var rest = folder === '' ? f : (f.indexOf(folder + '/') === 0 ? f.slice(folder.length + 1) : null);
    if (rest === null) return;
    var first = rest.split('/')[0];
    if (!seen[first]) { seen[first] = true; out.push(first); }
  });
  return out.map(function(seg) { return folder === '' ? seg : folder + '/' + seg; }).sort();
}

function appItemHtml(a, depth) {
  var pad = 28 + (depth || 0) * 16;
  return '<li style="padding-left:' + pad + 'px">' +
    (a.icon ? '<span class="app-icon">' + a.icon + '</span>' : '') +
    '<a href="' + a.prefix + '/" class="app-name">' + (a.title || a.name) + '</a>' +
    '<span class="app-info"><span class="app-type">' + a.type + '</span> <span class="status ' + a.status + '"' + (editing ? ' data-action="toggle-status" data-name="' + a.name + '"' : '') + '>' + a.status + '</span></span>' +
    '<span class="app-actions">' +
      '<button class="exp-btn" data-name="' + a.name + '">Export</button>' +
      '<button class="del-btn" data-name="' + a.name + '">Delete</button>' +
    '</span></li>';
}

function folderRowHtml(folder, depth) {
  var seg = folder.split('/').pop();
  var name = folderLabels[folder] || seg;
  var pad = 12 + (depth || 0) * 16;
  return '<li class="folder-row" data-folder="' + escHtml(folder) + '" style="padding-left:' + pad + 'px">' + escHtml(name) + '</li>';
}

// Render the current folder level only: apps that live directly in it, plus
// its immediate subfolders as clickable rows. Clicking a folder drills in.
function renderApps(container, apps, sortBy) {
  appsData = apps;
  var filtered = editing ? apps : apps.filter(function(a) { return a.status === 'running'; });
  var here = filtered.filter(function(a) { return (a.folder || '') === currentFolder; });
  var folders = childFolders(filtered, currentFolder);
  var depth = currentFolder === '' ? 0 : currentFolder.split('/').length;
  var sorted = here.slice().sort(function(a, b) {
    if (sortBy === 'name') return (a.title || a.name).localeCompare(b.title || b.name);
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  updateNav();
  if (sorted.length === 0 && folders.length === 0) {
    container.innerHTML = '<div class="empty">' + (editing ? 'No apps. Deploy one using the API.' : 'No apps deployed yet.') + '</div>';
    return;
  }
  var html = '<ul class="apps' + (editing ? ' editing' : '') + '">';
  folders.forEach(function(folder) { html += folderRowHtml(folder, depth); });
  sorted.forEach(function(a) { html += appItemHtml(a, depth); });
  html += '</ul>';
  container.innerHTML = html;
}

// Breadcrumb for the current folder: each segment shows the label of its
// path-so-far when one exists, else the slug segment (e.g. 'New Demo / Guides'
// for path 'new-demo/guides' when both are labeled).
function folderPathLabel(folder) {
  var parts = folder.split('/');
  var out = [];
  var acc = '';
  parts.forEach(function(seg) {
    acc = acc === '' ? seg : acc + '/' + seg;
    out.push(folderLabels[acc] || seg);
  });
  return out.join(' / ');
}

function updateNav() {
  var back = document.getElementById('back-btn');
  var root = document.getElementById('root-btn');
  var titleEl = document.getElementById('page-title');
  if (currentFolder === '') {
    back.style.display = 'none';
    root.style.display = 'none';
    titleEl.textContent = '${title}';
    return;
  }
  back.style.display = 'inline-block';
  root.style.display = currentFolder.indexOf('/') !== -1 ? 'inline-block' : 'none';
  titleEl.textContent = folderPathLabel(currentFolder);
}

function getKey() { return localStorage.getItem('apiKey') || ''; }
function authHeaders() { return { 'Authorization': 'Bearer ' + getKey() }; }
function getSort() { return document.querySelector('#sort-group .active').getAttribute('data-sort'); }

document.getElementById('theme-toggle').onclick = function() {
  document.body.classList.toggle('light');
  var isLight = document.body.classList.contains('light');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  this.innerHTML = isLight ? moonSVG : sunSVG;
};

document.getElementById('edit-btn').onclick = function() {
  editing = !editing;
  this.textContent = editing ? 'Done' : 'Edit';
  this.classList.toggle('active', editing);
  var items = document.getElementById('app-list-items');
  if (items) renderApps(items, appsData, getSort());
};

document.getElementById('back-btn').onclick = function() {
  goToFolder(parentFolder(currentFolder));
};

document.getElementById('root-btn').onclick = function() {
  goToFolder('');
};

document.getElementById('sort-group').onclick = function(e) {
  var btn = e.target.closest('button');
  if (!btn) return;
  this.querySelectorAll('button').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  var items = document.getElementById('app-list-items');
  if (items) renderApps(items, appsData, getSort());
};

window.addEventListener('popstate', function() {
  var folder = folderFromPath();
  currentFolder = folder !== '' && validFolder(folder) ? folder : '';
  renderApps(document.getElementById('app-list-items'), appsData, getSort());
});

document.getElementById('app-list').addEventListener('click', function(e) {
  var btn = e.target;
  if (btn.classList.contains('folder-row')) {
    goToFolder(btn.getAttribute('data-folder'));
    return;
  }
  if (btn.classList.contains('del-btn')) {
    var name = btn.getAttribute('data-name');
    if (!confirm('Delete "' + name + '"? This cannot be undone.')) return;
    btn.textContent = '...';
    fetch('/api/v1/apps/' + encodeURIComponent(name), { method: 'DELETE', headers: authHeaders() })
      .then(function(r) {
        if (!r.ok) throw new Error('Delete failed');
        appsData = appsData.filter(function(a) { return a.name !== name; });
        renderApps(document.getElementById('app-list-items'), appsData, getSort());
      })
      .catch(function(err) { alert('Error: ' + err.message); });
  }
  if (btn.classList.contains('exp-btn')) {
    var name = btn.getAttribute('data-name');
    btn.textContent = '...';
    fetch('/api/v1/apps/' + encodeURIComponent(name), { headers: authHeaders() })
      .then(function(r) { if (!r.ok) throw new Error('Export failed'); return r.json(); })
      .then(function(app) {
        if (typeof JSZip === 'undefined') { alert('JSZip library not loaded, try refreshing'); return; }
        var zip = new JSZip();
        (app.files || []).forEach(function(f) {
          if (f.encoding === 'base64') {
            zip.file(f.path, f.content, { base64: true });
          } else {
            zip.file(f.path, f.content);
          }
        });
        return zip.generateAsync({ type: 'blob' }).then(function(blob) {
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = name + '.zip';
          document.body.appendChild(a); a.click();
          setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
        });
      })
      .catch(function(err) { alert('Error: ' + err.message); })
      .finally(function() { btn.textContent = 'Export'; });
  }
  if (btn.getAttribute('data-action') === 'toggle-status') {
    var name = btn.getAttribute('data-name');
    var isRunning = btn.classList.contains('running');
    var url = '/api/v1/apps/' + encodeURIComponent(name) + (isRunning ? '/stop' : '/start');
    btn.textContent = '...';
    fetch(url, { method: 'POST', headers: authHeaders() })
      .then(function(r) { if (!r.ok) throw new Error('Toggle failed'); return r.json(); })
      .then(function(updated) {
        for (var i = 0; i < appsData.length; i++) {
          if (appsData[i].name === name) { appsData[i].status = updated.status; break; }
        }
        renderApps(document.getElementById('app-list-items'), appsData, getSort());
      })
      .catch(function(err) { alert('Error: ' + err.message); });
  }
});

fetch('/api/v1/apps', { headers: authHeaders() })
  .then(function(r) { if (r.status === 401) throw new Error('auth'); return r.json(); })
  .then(function(data) {
    folderLabels = data.folder_labels || {};
    var fetched = data.apps || [];
    var initial = folderFromPath();
    currentFolder = initial !== '' && fetched.some(function(a) {
      var f = a.folder || '';
      return f === initial || f.indexOf(initial + '/') === 0;
    }) ? initial : '';
    var list = document.getElementById('app-list');
    list.innerHTML = '<div id="app-list-items"></div>';
    var items = document.getElementById('app-list-items');
    renderApps(items, fetched, 'date');
  })
  .catch(function(e) {
    var list = document.getElementById('app-list');
    if (e.message === 'auth') {
      list.innerHTML = '<div class="error-detail"><strong>Unauthorized</strong> &mdash; <a href="#" onclick="const k=prompt(\\'Enter API key:\\');if(k){localStorage.setItem(\\'apiKey\\',k);location.reload()}return false" style="color:var(--link)">set API key</a></div>';
    } else {
      list.innerHTML = '<div class="error-detail">Could not load apps. <strong>' + e.message + '</strong></div>';
    }
  });
</script>
</body>
</html>`, 'utf-8');
}

async function main() {
  await initDb(DATA_DIR);
  ensureLandingPage();
  await syncRoutes();

  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  // Lenient JSON: repair common AI mistakes (single quotes, unquoted keys,
  // trailing commas); otherwise answer 400 in the documented error shape.
  app.use(jsonErrorHandler);

  // Health check — no auth
  app.use('/api/v1/health', healthRouter);

  // Management API — auth required
  app.use('/api/v1/apps', authMiddleware, appsRouter);
  app.use('/api/v1/folders', authMiddleware, foldersRouter);

  const server = app.listen(PORT, () => {
    console.log(`Management API listening on port ${PORT}`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      failPortInUse(PORT);
      return;
    }
    throw err;
  });
}

// A busy PORT is an ops problem, not a code one: print who owns the port and
// how to move leafdock, instead of a raw stack trace.
function failPortInUse(port: number): void {
  try {
    const execSync = require('child_process').execSync as (cmd: string) => Buffer;
    const pids = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null | head -1`).toString().trim();
    if (pids) {
      const cmd = execSync(`ps -p ${pids} -o command=`).toString().trim();
      console.error(`Port ${port} is already in use by PID ${pids} (${cmd}).`);
    } else {
      console.error(`Port ${port} is already in use.`);
    }
  } catch {
    console.error(`Port ${port} is already in use.`);
  }
  console.error(`Pick a free port and point Caddy's /api reverse_proxy at it, e.g.:`);
  console.error(`  PORT=3100 npx tsx src/index.ts`);
  process.exit(1);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
