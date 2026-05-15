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

  fs.writeFileSync(indexPath, `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Intranet Host</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<style>
  :root { --bg: #0d1117; --fg: #c9d1d9; --card-bg: #161b22; --card-border: #30363d; --link: #58a6ff; --muted: #8b949e; --hover: #1c2128; --tag-bg: #21262d; --green: #3fb950; --yellow: #d29922; --red: #f85149; --select-bg: #21262d; --select-border: #30363d; --err-bg: #21262d; }
  .light { --bg: #f6f8fa; --fg: #24292f; --card-bg: #ffffff; --card-border: #d0d7de; --link: #0969da; --muted: #656d76; --hover: #f3f4f6; --tag-bg: #e8eaed; --green: #1a7f37; --yellow: #9a6700; --red: #cf222e; --select-bg: #f6f8fa; --select-border: #d0d7de; --err-bg: #f6f8fa; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--fg); min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; }
  .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 40px; max-width: 600px; width: 100%; text-align: center; }
  h1 { color: var(--link); font-size: 24px; }
  .title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
  .title-row select, .title-row button { background: var(--select-bg); border: 1px solid var(--select-border); color: var(--fg); padding: 4px 8px; border-radius: 6px; font-size: 12px; cursor: pointer; }
  .title-row select:focus { outline: none; border-color: var(--link); }
  .title-row .edit-btn:hover { border-color: var(--link); }
  .title-row .edit-btn.active { background: var(--red); border-color: var(--red); color: #fff; }
  p { color: var(--muted); font-size: 14px; margin-bottom: 24px; }
  .apps { list-style: none; text-align: left; }
  .apps li { padding: 12px 16px; border: 1px solid var(--card-border); border-radius: 8px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .apps li:hover { background: var(--hover); }
  .app-name { color: var(--link); font-weight: 600; text-decoration: none; white-space: nowrap; }
  .app-name:hover { text-decoration: underline; }
  .app-info { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .app-type { color: var(--muted); font-size: 12px; background: var(--tag-bg); padding: 2px 8px; border-radius: 4px; }
  .status { font-size: 12px; }
  .status.running { color: var(--green); }
  .status.stopped { color: var(--yellow); }
  .status.error { color: var(--red); }
  .app-actions { display: none; gap: 4px; flex-shrink: 0; }
  .editing .app-actions { display: flex; }
  .app-actions button { border: none; border-radius: 4px; padding: 3px 8px; font-size: 11px; cursor: pointer; }
  .app-actions .del-btn { background: var(--red); color: #fff; }
  .app-actions .exp-btn { background: var(--select-bg); color: var(--fg); border: 1px solid var(--card-border); }
  .app-actions .del-btn:hover { opacity: 0.8; }
  .app-actions .exp-btn:hover { border-color: var(--link); }
  .empty { color: var(--muted); font-style: italic; padding: 20px; }
  .error-detail { margin-top: 24px; padding: 16px; background: var(--err-bg); border-radius: 8px; font-family: monospace; font-size: 13px; color: var(--muted); }
  .error-detail strong { color: var(--red); }
  .loading { color: var(--muted); }
  .theme-toggle { margin-top: 24px; background: var(--card-bg); border: 1px solid var(--card-border); color: var(--muted); padding: 6px 16px; border-radius: 20px; font-size: 13px; cursor: pointer; }
  .theme-toggle:hover { color: var(--fg); border-color: var(--link); }
</style>
</head>
<body>
<div class="card">
  <div class="title-row">
    <h1>Intranet Host</h1>
    <div style="display:flex;gap:6px;align-items:center">
      <select id="sort-select"><option value="date">Date</option><option value="name">Name</option></select>
      <button class="edit-btn" id="edit-btn">Edit</button>
    </div>
  </div>
  <p>Your apps are listed below.</p>
  <div id="app-list" class="loading">Loading apps...</div>
</div>
<button class="theme-toggle" id="theme-toggle">Switch to Light</button>
<script>
(function() {
  var t = localStorage.getItem('theme');
  if (t === 'light') { document.body.classList.add('light'); document.getElementById('theme-toggle').textContent = 'Switch to Dark'; }
})();

var appsData = [];
var editing = false;

function renderApps(container, apps, sortBy) {
  appsData = apps;
  var sorted = apps.slice().sort(function(a, b) {
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  container.innerHTML = '<ul class="apps' + (editing ? ' editing' : '') + '">' + sorted.map(function(a) {
    return '<li>' +
      '<a href="' + a.prefix + '/" class="app-name">' + a.name + '</a>' +
      '<span class="app-info"><span class="app-type">' + a.type + '</span> <span class="status ' + a.status + '">' + a.status + '</span></span>' +
      '<span class="app-actions">' +
        '<button class="exp-btn" data-name="' + a.name + '">Export</button>' +
        '<button class="del-btn" data-name="' + a.name + '">Delete</button>' +
      '</span></li>';
  }).join('') + '</ul>';
}

function getKey() { return localStorage.getItem('apiKey') || ''; }
function authHeaders() { return { 'Authorization': 'Bearer ' + getKey() }; }

document.getElementById('theme-toggle').onclick = function() {
  document.body.classList.toggle('light');
  var isLight = document.body.classList.contains('light');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  this.textContent = isLight ? 'Switch to Dark' : 'Switch to Light';
};

document.getElementById('edit-btn').onclick = function() {
  editing = !editing;
  this.textContent = editing ? 'Done' : 'Edit';
  this.classList.toggle('active', editing);
  var items = document.getElementById('app-list-items');
  if (items) renderApps(items, appsData, document.getElementById('sort-select').value);
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
        renderApps(document.getElementById('app-list-items'), appsData, document.getElementById('sort-select').value);
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
});

fetch('/api/v1/apps', { headers: authHeaders() })
  .then(function(r) { if (r.status === 401) throw new Error('auth'); return r.json(); })
  .then(function(data) {
    var list = document.getElementById('app-list');
    if (!data.apps || data.apps.length === 0) {
      list.innerHTML = '<div class="empty">No apps deployed yet.</div>';
      return;
    }
    list.innerHTML = '<div id="app-list-items"></div>';
    var items = document.getElementById('app-list-items');
    var select = document.getElementById('sort-select');
    var sort = select.value;
    renderApps(items, data.apps, sort);
    select.onchange = function() { renderApps(items, appsData, select.value); };
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
