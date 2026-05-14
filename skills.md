---
name: intranet-host
description: Deploy and manage web apps on an internal Docker host via REST API. Use when the user asks to deploy, host, or publish an app, website, or service to their NAS or internal network.
---

You have access to an **intranet host** — a Docker-based system that runs on the user's NAS and serves web apps under URL prefixes (e.g., `https://nas.ts.net/my-app`). You can deploy, update, list, and remove apps through its management API.

## Configuration

Ask the user for these values if you don't already have them:

- `INTRANET_HOST_URL` — base URL, e.g. `https://nas.ts.net`
- `INTRANET_HOST_KEY` — API key for the `Authorization: Bearer <key>` header

## App Types

### static
HTML/CSS/JS files served by Caddy's file server. Use for frontend-only apps, SPAs, landing pages.

Config: `{ index: "index.html", spa: false }`
- `spa: true` — all unmatched paths serve `index.html` (for React Router, Vue Router, etc.)

### docker
A container built from source files. Files are mounted at `/app`, the container runs on the internal Docker network. Use for full-stack apps with a backend.

Config: `{ image: "node:20-alpine", port: 3000, env: {}, command: "npm install && node server.js", cpu_limit: "0.5", mem_limit: "128m" }`

## API Reference

Base: `<INTRANET_HOST_URL>/api/v1`
Auth: `Authorization: Bearer <INTRANET_HOST_KEY>`
Content-Type: `application/json`

### List Apps
```
GET /apps
→ { apps: [{ name, type, prefix, status, created_at, updated_at }] }
```

### Get App
```
GET /apps/:name
→ { name, type, prefix, status, files: [{path, content}], config, created_at, updated_at }
```

### Create App
```
POST /apps
Body: { name, type, files: [{path, content}], config?, prefix? }
→ 201 + full app object
Errors: 409 name exists, 400 invalid name or prefix conflict
```

Name rules: `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` — lowercase, hyphens, must start with a letter. Examples: `todo-app`, `weather`, `api-gateway`.

### Update App (full replace)
```
PUT /apps/:name
Body: { name, type, files: [{path, content}], config? }
→ 200 + updated app object
```

### Update App (partial)
```
PATCH /apps/:name
Body: { config? } or { files? } or { prefix? }
→ 200 + updated app object
```
Providing `files` replaces ALL files. Providing `config` merges at the top level.

### Delete App
```
DELETE /apps/:name
→ 204
```
Irreversible — removes files, stops container (if docker), deletes route.

### Get Logs
```
GET /apps/:name/logs?tail=100
→ { logs: "..." }
```

### Restart App
```
POST /apps/:name/restart
→ 200 + app object
```
No-op for static apps. Restarts container for docker apps.

### Health Check
```
GET /health
→ { status: "ok", version: "1.0.0" }
```
No auth required.

## Workflow: Deploy a Static App

```javascript
const API = "<INTRANET_HOST_URL>/api/v1";
const HEADERS = {
  "Authorization": "Bearer <INTRANET_HOST_KEY>",
  "Content-Type": "application/json"
};

// 1. Check if app exists
let res = await fetch(`${API}/apps/my-app`, { headers: HEADERS });
const exists = res.ok;

// 2. Collect all source files as { path, content }
const files = [
  { path: "index.html", content: "<!DOCTYPE html>..." },
  { path: "style.css", content: "body { ... }" },
  { path: "app.js", content: "console.log('ready');" }
];

// 3. Create or update
const body = JSON.stringify({
  name: "my-app",
  type: "static",
  files,
  config: { spa: true }
});

res = await fetch(`${API}/apps`, {
  method: exists ? "PUT" : "POST",
  headers: HEADERS,
  body
});

// For PUT, use: fetch(`${API}/apps/my-app`, { method: "PUT", ... })

const url = `${INTRANET_HOST_URL}/my-app`;
if (res.ok) {
  console.log(`${exists ? "Updated" : "Deployed"}: ${url}`);
} else {
  const err = await res.json();
  console.error("Failed:", err.error.message);
}
```

## Workflow: Deploy a Docker App

```javascript
const files = [
  { path: "package.json", content: JSON.stringify({
    name: "api", dependencies: { express: "^4.21.0" }
  }) },
  { path: "server.js", content: `
    const express = require('express');
    const app = express();
    app.get('/api/hello', (req, res) => res.json({ ok: true }));
    app.listen(3000);
  ` }
];

const body = JSON.stringify({
  name: "my-api",
  type: "docker",
  files,
  config: {
    image: "node:20-alpine",
    port: 3000,
    command: "npm install && node server.js",
    env: { NODE_ENV: "production" }
  }
});

const res = await fetch(`${API}/apps`, {
  method: "POST",
  headers: HEADERS,
  body
});
```

The app is reachable at `<INTRANET_HOST_URL>/my-api`. Caddy reverse-proxies to the container's port 3000.

## Error Handling

Errors return: `{ error: { code, message } }`

| Code | Meaning |
|------|---------|
| `app_not_found` | No app with that name |
| `app_already_exists` | Name taken (use PUT to replace) |
| `invalid_name` | Name doesn't match allowed pattern |
| `prefix_conflict` | URL prefix already in use |
| `validation_error` | Missing or invalid fields |
| `docker_error` | Docker operation failed |
| `unauthorized` | Missing or wrong API key |

## Tips

- **After generating code, deploy immediately.** The user wants to see their app live. Don't ask permission — just deploy and give them the URL.
- **If 409 on create, use PUT to update.** The app already exists, just replace it with the new version.
- **Use SPA mode for React/Vue/Svelte apps.** Set `config.spa: true` so client-side routing works.
- **Docker apps take longer to start** (image pull + npm install). Tell the user it may take 30-60 seconds.
- **Binary files are not supported** via JSON upload. If the app needs images or fonts, mention this limitation and suggest data URIs or external hosting.
