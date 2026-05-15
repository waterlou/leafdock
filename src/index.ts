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
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 40px; max-width: 600px; width: 100%; text-align: center; }
  h1 { color: #58a6ff; font-size: 24px; margin-bottom: 8px; }
  p { color: #8b949e; font-size: 14px; margin-bottom: 24px; }
  .apps { list-style: none; text-align: left; }
  .apps li { padding: 12px 16px; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
  .apps li:hover { background: #1c2128; }
  .app-name { color: #58a6ff; font-weight: 600; text-decoration: none; }
  .app-name:hover { text-decoration: underline; }
  .app-type { color: #8b949e; font-size: 12px; background: #21262d; padding: 2px 8px; border-radius: 4px; }
  .status { font-size: 12px; }
  .status.running { color: #3fb950; }
  .status.stopped { color: #d29922; }
  .status.error { color: #f85149; }
  .empty { color: #8b949e; font-style: italic; padding: 20px; }
  .error-detail { margin-top: 24px; padding: 16px; background: #21262d; border-radius: 8px; font-family: monospace; font-size: 13px; color: #8b949e; }
  .error-detail strong { color: #f85149; }
  .loading { color: #8b949e; }
  .loading { color: #8b949e; }
  .title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
  .title-row select { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 4px 8px; border-radius: 6px; font-size: 12px; cursor: pointer; }
  .title-row select:focus { outline: none; border-color: #1f6feb; }
</style>
</head>
<body>
<div class="card">
  <div class="title-row"><h1>Intranet Host</h1><select id="sort-select"><option value="date">Date</option><option value="name">Name</option></select></div>
  <p>Your apps are listed below.</p>
  <div id="app-list" class="loading">Loading apps...</div>
</div>
<script>
function renderApps(container, apps, sortBy) {
  var sorted = apps.slice().sort(function(a, b) {
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  container.innerHTML = '<ul class="apps">' + sorted.map(function(a) {
    return '<li><a href="' + a.prefix + '/" class="app-name">' + a.name + '</a>' +
      '<span><span class="app-type">' + a.type + '</span> <span class="status ' + a.status + '">' + a.status + '</span></span></li>';
  }).join('') + '</ul>';
}

fetch('/api/v1/apps', { headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('apiKey') || '') } })
  .then(function(r) { if (r.status === 401) throw new Error('auth'); return r.json(); })
  .then(function(data) {
    var list = document.getElementById('app-list');
    if (!data.apps || data.apps.length === 0) {
      list.innerHTML = '<div class="empty">No apps deployed yet.</div>';
      return;
    }
    list.innerHTML = '<div id="app-list-items"></div>';
    var select = document.getElementById('sort-select');
    select.style.display = '';
    var items = document.getElementById('app-list-items');
    var sort = select.value; // 'date' is default
    renderApps(items, data.apps, sort);
    select.onchange = function() {
      renderApps(items, data.apps, select.value);
    };
  })
  .catch(e => {
    const list = document.getElementById('app-list');
    if (e.message === 'auth') {
      list.innerHTML = '<div class="error-detail"><strong>Unauthorized</strong> — <a href="#" onclick="const k=prompt(\\'Enter API key:\\');if(k){localStorage.setItem(\\'apiKey\\',k);location.reload()}return false" style="color:#58a6ff">set API key</a></div>';
    } else {
      list.innerHTML = '<div class="error-detail">Could not load apps. <strong>' + e.message + '</strong></div>';
    }
  });
</script>
</body>
</html>
`, 'utf-8');
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
