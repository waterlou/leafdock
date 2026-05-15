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
Content-Type: `application/json` (for text-only apps) or `multipart/form-data` (zip upload for apps with images/fonts/binary files)

:warning: **IMPORTANT — Zip upload is the RECOMMENDED method for creating any app with images, fonts, or other binary files. The JSON endpoint requires base64-encoding binary content, which the AI generates incorrectly.** Use `POST /apps/upload` (zip) instead of `POST /apps` (JSON) whenever the app has image files.

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

### Create App (Zip Upload) — RECOMMENDED
```
POST /apps/upload
Multipart: file=@app.zip, config='{"name":"my-app","type":"static","config":{"spa":true}}'
→ 201 + full app object
```
**Always use this method when the app has images, fonts, videos, or any binary files.** Send the entire app as a `.zip` file. The `config` field is a JSON string containing `name`, `type`, and optional `config` and `prefix`. The zip contents become the app's file structure.

cURL example:
```bash
curl -X POST $INTRANET_HOST_URL/api/v1/apps/upload \
  -H "Authorization: Bearer $INTRANET_HOST_KEY" \
  -F "file=@my-app.zip" \
  -F 'config={"name":"my-app","type":"static","config":{"spa":true}}'
```

To update an existing app with a new zip:
```
PUT /apps/:name/upload
Multipart: file=@app.zip, config?='{"config":{"spa":false}}'
→ 200 + updated app object
```

### Create App (JSON — text-only apps)
```
POST /apps
Body: { name, type, files: [{path, content}], config?, prefix? }
→ 201 + full app object
Errors: 409 name exists, 400 invalid name or prefix conflict
```
Only use this for apps with NO binary files (no images, no fonts, no videos). Each file is sent as `{path, content}` with UTF-8 text content.

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

## Workflow: Deploy a Static App (recommended)

Use zip upload for all apps with asset files (images, fonts, CSS, JS). This avoids base64 encoding issues.

```javascript
const API = "<INTRANET_HOST_URL>/api/v1";
const HEADERS = {
  "Authorization": "Bearer <INTRANET_HOST_KEY>",
};

// 1. Check if app exists
let res = await fetch(`${API}/apps/my-app`, { headers: HEADERS });
const exists = res.ok;
const method = exists ? "PUT" : "POST";
const url = exists ? `${API}/apps/my-app/upload` : `${API}/apps/upload`;

// 2. Create a zip with all files
//    Include images, fonts, etc. directly — no base64 needed
const zip = new JSZip();
zip.file("index.html", "<!DOCTYPE html>...");
zip.file("style.css", "body { ... }");
zip.file("app.js", "console.log('ready');");
zip.file("images/logo.png", imageBlob);  // binary file, no encoding needed
const zipBlob = await zip.generateAsync({ type: "blob" });

// 3. Upload as multipart form
const formData = new FormData();
formData.append("file", zipBlob, "app.zip");
formData.append("config", JSON.stringify({
  name: "my-app",
  type: "static",
  config: { spa: true }
}));

res = await fetch(url, {
  method: exists ? "PUT" : "POST",
  headers: { "Authorization": HEADERS.Authorization },
  body: formData
});

const appUrl = `${INTRANET_HOST_URL}/my-app`;
if (res.ok) {
  console.log(`${exists ? "Updated" : "Deployed"}: ${appUrl}`);
} else {
  const err = await res.json();
  console.error("Failed:", err.error.message);
}
```

### Quick cURL alternative (no JS needed)

```bash
# Create app
curl -X POST $INTRANET_HOST_URL/api/v1/apps/upload \
  -H "Authorization: Bearer $INTRANET_HOST_KEY" \
  -F "file=@my-app.zip" \
  -F 'config={"name":"my-app","type":"static","config":{"spa":true}}'

# Update existing app
curl -X PUT $INTRANET_HOST_URL/api/v1/apps/my-app/upload \
  -H "Authorization: Bearer $INTRANET_HOST_KEY" \
  -F "file=@my-app-v2.zip" \
  -F 'config={"config":{"spa":false}}'
```

> **If you don't have a zip library available** and the app has only text files (no images, fonts, or video), you can use the JSON endpoint instead:
> ```javascript
> // POST /apps with Content-Type: application/json
> // Only for text-only apps
> const body = JSON.stringify({
>   name: "my-app", type: "static",
>   files: [
>     { path: "index.html", content: "<!DOCTYPE html>..." },
>     { path: "style.css", content: "body { ... }" }
>   ],
>   config: { spa: true }
> });
> await fetch(`${API}/apps`, { method: "POST", headers: {...HEADERS, "Content-Type": "application/json"}, body });
> ```

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

> Docker apps with binary files (e.g. a Python app with ML models) should also use zip upload: `POST /apps/upload` with `file=@app.zip` and `config='{"name":"my-api","type":"docker","config":{...}}'`.

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
- **ALWAYS use zip upload for apps with images, fonts, or videos.** The JSON endpoint (`POST /apps`) requires base64-encoding binary content, which the AI generates incorrectly — files end up corrupt and invisible in the browser. Use `POST /apps/upload` with `multipart/form-data` instead. See the "Deploy a Static App" workflow above.
- **For text-only apps (no images/fonts/video), JSON upload is fine.** You can use `POST /apps` with `Content-Type: application/json`.
