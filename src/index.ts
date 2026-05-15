import express from 'express';
import cors from 'cors';
import * as fs from 'fs';
import * as path from 'path';
import { initDb } from './db';
import { authMiddleware } from './middleware/auth';
import { syncRoutes } from './services/apps';
import healthRouter from './routes/health';
import appsRouter from './routes/apps';

const PORT = parseInt(process.env.PORT || '3001', 10);
const DATA_DIR = process.env.DATA_DIR || '/data';

function ensureLandingPage(): void {
  const landingDir = path.join(DATA_DIR, 'landing');
  fs.mkdirSync(landingDir, { recursive: true });

  const indexPath = path.join(landingDir, 'index.html');
  const title = process.env.TITLE || 'Intranet Host';

  fs.writeFileSync(indexPath, `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<style>
  :root { --bg: #0d1117; --fg: #c9d1d9; --card-bg: #161b22; --card-border: #30363d; --link: #58a6ff; --muted: #8b949e; --hover: #1c2128; --tag-bg: #21262d; --green: #3fb950; --yellow: #d29922; --red: #f85149; --select-bg: #21262d; --select-border: #30363d; --err-bg: #21262d; }
  .light { --bg: #f6f8fa; --fg: #24292f; --card-bg: #ffffff; --card-border: #d0d7de; --link: #0969da; --muted: #656d76; --hover: #f3f4f6; --tag-bg: #e8eaed; --green: #1a7f37; --yellow: #9a6700; --red: #cf222e; --select-bg: #f6f8fa; --select-border: #d0d7de; --err-bg: #f6f8fa; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body, .card, .page-title, .app-type, .theme-toggle, .toolbar, .sort-group button, .edit-btn, .apps li, .app-actions button, .error-detail { transition: background 0.3s, color 0.3s, border-color 0.3s; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--fg); min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; }
  .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 40px; max-width: 600px; width: 100%; text-align: center; }
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
  .app-name { color: var(--link); font-weight: 600; text-decoration: none; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; text-align: left; }
  .app-name:hover { text-decoration: underline; }
  .app-info { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .app-type { color: var(--muted); font-size: 12px; background: var(--tag-bg); padding: 2px 8px; border-radius: 4px; }
  .status { font-size: 12px; }
  .status[data-action="toggle-status"] { cursor: pointer; }
  .status[data-action="toggle-status"]:hover { text-decoration: underline; }
  .status.running { color: var(--green); }
  .status.stopped { color: var(--yellow); }
  .status.error { color: var(--red); }
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
</style>
</head>
<body>
<h1 class="page-title">${title}</h1>
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
<script>
var sunSVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
var moonSVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

(function() {
  var t = localStorage.getItem('theme');
  if (t === 'light') { document.body.classList.add('light'); document.getElementById('theme-toggle').innerHTML = moonSVG; }
})();

var appsData = [];
var editing = false;

function renderApps(container, apps, sortBy) {
  appsData = apps;
  var filtered = editing ? apps : apps.filter(function(a) { return a.status === 'running'; });
  var sorted = filtered.slice().sort(function(a, b) {
    if (sortBy === 'name') return (a.title || a.name).localeCompare(b.title || b.name);
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  if (sorted.length === 0) {
    container.innerHTML = '<div class="empty">' + (editing ? 'No apps. Deploy one using the API.' : 'No apps deployed yet.') + '</div>';
    return;
  }
  container.innerHTML = '<ul class="apps' + (editing ? ' editing' : '') + '">' + sorted.map(function(a) {
    return '<li>' +
      '<a href="' + a.prefix + '/" class="app-name">' + (a.title || a.name) + '</a>' +
      '<span class="app-info"><span class="app-type">' + a.type + '</span> <span class="status ' + a.status + '"' + (editing ? ' data-action="toggle-status" data-name="' + a.name + '"' : '') + '>' + a.status + '</span></span>' +
      '<span class="app-actions">' +
        '<button class="exp-btn" data-name="' + a.name + '">Export</button>' +
        '<button class="del-btn" data-name="' + a.name + '">Delete</button>' +
      '</span></li>';
  }).join('') + '</ul>';
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

document.getElementById('sort-group').onclick = function(e) {
  var btn = e.target.closest('button');
  if (!btn) return;
  this.querySelectorAll('button').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  var items = document.getElementById('app-list-items');
  if (items) renderApps(items, appsData, getSort());
};

document.getElementById('app-list').addEventListener('click', function(e) {
  var btn = e.target;
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
    var list = document.getElementById('app-list');
    list.innerHTML = '<div id="app-list-items"></div>';
    var items = document.getElementById('app-list-items');
    renderApps(items, data.apps || [], 'date');
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

  // Health check — no auth
  app.use('/api/v1/health', healthRouter);

  // Management API — auth required
  app.use('/api/v1/apps', authMiddleware, appsRouter);

  app.listen(PORT, () => {
    console.log(`Management API listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
