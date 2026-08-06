# Management API Documentation

Base URL: `https://nas.ts.net/api/v1`

## Authentication

All endpoints except `/health` require an API key:

```
Authorization: Bearer <MANAGEMENT_API_KEY>
```

The key is configured via the `MANAGEMENT_API_KEY` environment variable on the management-api container.

## Endpoints

### List Apps

```
GET /apps
```

Returns a summary list of all registered apps (without file contents).

**Response 200:**
```json
{
  "apps": [
    {
      "name": "todo-app",
      "type": "static",
      "prefix": "/todo-app",
      "folder": "",
      "status": "running",
      "icon": "",
      "created_at": "2026-05-14T10:00:00Z",
      "updated_at": "2026-05-14T10:00:00Z"
    }
  ],
  "folder_labels": {
    "blog": "New Demo Blog"
  }
}
```

---

### Create App

```
POST /apps
```

Register a new app. The request includes the app name, type, all source files, and configuration.

**Request body:**
```json
{
  "name": "todo-app",
  "type": "static",
  "prefix": "/todo-app",
  "files": [
    { "path": "index.html", "content": "<!DOCTYPE html><html>..." },
    { "path": "style.css", "content": "body { margin: 0; }" },
    { "path": "app.js", "content": "console.log('hello');" }
  ],
  "config": {
    "index": "index.html",
    "spa": true
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | URL-safe slug. Must match `^[a-z0-9]+(-[a-z0-9]+)*$` |
| `type` | yes | `"static"`, `"docker"`, or `"docker-compose"` |
| `prefix` | no | URL prefix. Defaults to `/<name>`. Normalized to lowercase. |
| `folder` | no | Optional subfolder (e.g. `"blog"` or `"blog/tutorials"`). Mutually exclusive with `prefix`. `""` (or omitted) = root. The disk layout mirrors it: an app in folder `blog` lives at `<data>/apps/blog/<name>` and is served at `/blog/<name>/`. Case is normalized to lowercase (`"Demo"` → `demo`). |
| `files` | yes | Array of `{path, content, encoding?}` objects. For binary files (images, video), set `encoding: "base64"` and base64-encode the content. |
| `config` | no | Type-specific config (see below) |
| `icon` | no | Optional emoji shown next to the app name on the landing page (e.g. `"🚀"`). Single emoji including flags, skin tones, and ZWJ families; `""` (or omitted) = none. |

**Static config:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `index` | string | `"index.html"` | Default document |
| `spa` | boolean | `false` | SPA mode — serve `index.html` for all unmatched paths |

**Docker config:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `image` | string | `"node:20-alpine"` | Docker image |
| `port` | number | `3000` | Container port to proxy to |
| `env` | object | `{}` | Environment variables passed to container |
| `command` | string | — | Override container command |
| `cpu_limit` | string | `"0.5"` | CPU shares |
| `mem_limit` | string | `"128m"` | Memory limit |

**Docker Compose config:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `compose_file` | string | `"docker-compose.yml"` | Compose file name |
| `services` | object | `{}` | Map of service name to `{ port }` for Caddy routing |

Only services that need HTTP routing should be listed in `services`. The first service gets the main prefix (`/<name>/`), additional services get sub-prefixes (`/<name>/<serviceName>/`). Internal services (databases, caches) stay on the compose internal network and should be omitted.

**Response 201:**
```json
{
  "name": "todo-app",
  "type": "static",
  "prefix": "/todo-app",
  "folder": "",
  "status": "running",
  "icon": "",
  "files": [
    { "path": "index.html", "content": "<!DOCTYPE html>..." },
    { "path": "style.css", "content": "body { margin: 0; }" },
    { "path": "app.js", "content": "console.log('hello');" }
  ],
  "config": { "index": "index.html", "spa": true },
  "created_at": "2026-05-14T10:00:00Z",
  "updated_at": "2026-05-14T10:00:00Z"
}
```

**Errors:**
- `409` — App name already exists
- `400` — Invalid name (not URL-safe), prefix conflicts with existing app, or missing required fields

---

### Create App (Zip Upload)

```
POST /apps/upload
```

Create a new app by uploading a zip file. The zip is extracted to the app's directory. Use this for apps with binary files (images, fonts, videos) to avoid base64 encoding.

**Request:** `multipart/form-data`

| Field | Required | Description |
|-------|----------|-------------|
| `file` | yes | `.zip` file containing the app's source files |
| `config` | yes | JSON string with app configuration (`name`, `type`, and optional `config` object) |

The `config` field is a text field containing a JSON object:

```json
{
  "name": "photo-gallery",
  "type": "static",
  "folder": "blog",
  "icon": "🚀",
  "config": {
    "index": "index.html",
    "spa": true
  }
}
```

The config JSON supports the same fields as the JSON Create App endpoint, except `files` (they come from the zip) and `prefix` (auto-derived from name). `folder` is supported: it selects the subfolder (same semantics as JSON create), otherwise the app is created at the root. `icon` is supported: sets the emoji shown next to the app name on the landing page.

**Response 201:** Full app object (same shape as JSON create).

**Errors:**
- `409` — App name already exists
- `400` — Missing name/type in config, invalid name or folder, or no zip file

**cURL example:**
```bash
curl -X POST https://nas.ts.net/api/v1/apps/upload \
  -H "Authorization: Bearer $API_KEY" \
  -F "file=@app.zip" \
  -F 'config={"name":"photo-gallery","type":"static","config":{"spa":true}}'
```

---

### Update App (Zip Upload)

```
PUT /apps/:name/upload
```

Replace an existing app's files by uploading a new zip. Optionally update the config.

**Request:** `multipart/form-data`

| Field | Required | Description |
|-------|----------|-------------|
| `file` | yes | `.zip` file containing the updated source files |
| `config` | no | Optional JSON string with updated configuration. May include `icon` to change the emoji shown next to the app name on the landing page. |

**Response 200:** Updated app object.

**Errors:**
- `404` — App not found
- `400` — No zip file

**cURL example:**
```bash
curl -X PUT https://nas.ts.net/api/v1/apps/photo-gallery/upload \
  -H "Authorization: Bearer $API_KEY" \
  -F "file=@updated-app.zip" \
  -F 'config={"config":{"index":"index.html","spa":false}}'
```

---

### Get App

```
GET /apps/:name
```

Returns full details including all files and config.

**Response 200:** Full app object (same shape as create response).

**Errors:**
- `404` — App not found

---

### Download App (Zip)

```
GET /apps/:name/zip
```

Downloads the app's source files as a `.zip` archive. Useful for pulling a deployed project down to edit locally, then re-uploading via `PUT /apps/:name/upload`. Files are at the zip root (same layout the upload expects).

**Response 200:** `application/zip` binary stream, `Content-Disposition: attachment; filename="<name>.zip"`.

**Errors:**
- `404` — App not found

**cURL example:**
```bash
curl -o app.zip https://nas.ts.net/api/v1/apps/photo-gallery/zip \
  -H "Authorization: Bearer $API_KEY"
```

---

### Update App (Full)

```
PUT /apps/:name
```

Full replacement. Replaces all files, config, and restarts the app. The `name` in the URL must match the `name` in the body.

**Request body:** Same shape as POST.

**Response 200:** Updated app object.

**Errors:**
- `404` — App not found
- `400` — Name mismatch or validation failure

---

### Update App (Partial)

```
PATCH /apps/:name
```

Partial update. Only include the fields you want to change. When `files` is provided, it replaces ALL files (does not merge with existing).

`icon` is accepted and is pure metadata — it only changes the emoji shown next to the app name on the landing page; no container or route restart happens (e.g. `{ "icon": "📚" }`).

**Request body (example — change SPA mode only):**
```json
{
  "config": { "spa": false }
}
```

**Request body (example — redeploy with new files):**
```json
{
  "files": [
    { "path": "index.html", "content": "<!DOCTYPE html><html>..." }
  ]
}
```

**Moving an app:** `prefix` (or `folder`) relocates the app — files on disk are moved, the Caddy route is swapped, and docker / docker-compose containers are recreated. Provide one or the other, not both. `folder` moves the app while keeping any custom prefix tail (e.g. `"/foo"` → `"/blog/foo"`); `prefix` sets the full URL.

**Response 200:** Updated app object.

**Errors:**
- `404` — App not found

---

### Move App

```
POST /apps/:name/move
```

Move an app into or out of a subfolder. Files on disk are relocated (`<data>/apps/blog/<name>` ↔ `<data>/apps/<name>`), the Caddy route is swapped, and docker / docker-compose containers are recreated for running apps. Stopped apps have their files and routes moved; containers are rebuilt on the next start.

**Request body:**
```json
{ "folder": "blog" }
```

`""` moves the app back to the root. Moving to the folder the app already lives in is a no-op (200).

**Response 200:** Updated app object (with the new `prefix` / `folder`).

**Errors:**
- `404` — App not found
- `400` — Missing or invalid `folder`, prefix conflict, or target directory already occupied

**cURL example:**
```bash
curl -X POST https://nas.ts.net/api/v1/apps/blog-todo/move \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"folder":"blog"}'
```

---

### Set Folder Display Label

```
PUT /folders/:path
```

Set or clear the display label of a folder. The label is metadata only: the URL and the on-disk directory keep using the slug path (e.g. folder `new-demo` → URL `/new-demo/<name>` → disk `<data>/apps/new-demo/<name>`), and the landing page renders the label instead of the slug. Folders exist implicitly via app prefixes; the label persists even if no app currently lives in the folder.

**Request body:**
```json
{ "label": "New Demo" }
```

- `label` — display text shown on the landing page. Trimmed; up to 100 characters; any printable text (spaces, emoji, unicode). `""` (or omitting by sending an empty string) clears the label, falling back to the slug.

**Response 200:**
```json
{ "path": "new-demo", "label": "New Demo" }
```

**Errors:**
- `400` — Missing path or invalid path (same rules as `folder`: lowercase letters, digits, hyphens), missing/non-string `label`, control characters, or label > 100 chars

**cURL example:**
```bash
curl -X PUT https://nas.ts.net/api/v1/folders/new-demo \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label":"New Demo"}'
```

---

### Delete App

```
DELETE /apps/:name
```

Removes the app entirely: deletes all files, stops the container (if docker or docker-compose type), and removes the Caddy route. This is irreversible.

If the app was the last one in its folder, the folder's on-disk directory and display label are removed as well (folders are implicit — they exist only while apps live in them).

**Response 204:** No content.

**Errors:**
- `404` — App not found

---

### Get Logs

```
GET /apps/:name/logs?tail=100
```

Returns recent logs. For static apps, returns Caddy access logs. For docker apps, returns container stdout/stderr. For docker-compose apps, returns logs for all services via `docker compose logs`.

**Query parameters:**
- `tail` (optional, default `100`) — Number of log lines to return

**Response 200:**
```json
{
  "logs": "2026-05-14T10:01:00Z GET /todo-app 200 ...\n2026-05-14T10:01:01Z GET /todo-app/style.css 200 ..."
}
```

---

### Restart App

```
POST /apps/:name/restart
```

Restarts the app. For static apps this is a no-op. For docker apps it restarts the container. For docker-compose apps it runs `docker compose down` followed by `docker compose up`.

**Response 200:** App object with updated status.

---

### Health Check

```
GET /health
```

No authentication required.

**Response 200:**
```json
{ "status": "ok", "version": "1.0.0" }
```

## Error Format

All errors follow this structure:

```json
{
  "error": {
    "code": "app_not_found",
    "message": "No app named 'foo-bar' exists."
  }
}
```

**Error codes:**

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `app_not_found` | 404 | No app with that name exists |
| `app_already_exists` | 409 | An app with that name is already registered |
| `invalid_name` | 400 | Name contains invalid characters |
| `prefix_conflict` | 400 | The requested URL prefix is already in use |
| `validation_error` | 400 | Missing or invalid fields in request body |
| `docker_error` | 500 | Docker operation failed (check error_message) |
| `unauthorized` | 401 | Missing or invalid API key |
| `internal_error` | 500 | Unexpected server error |
