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
      "status": "running",
      "created_at": "2026-05-14T10:00:00Z",
      "updated_at": "2026-05-14T10:00:00Z"
    }
  ]
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
| `type` | yes | `"static"` or `"docker"` |
| `prefix` | no | URL prefix. Defaults to `/<name>` |
| `files` | yes | Array of `{path, content, encoding?}` objects. For binary files (images, video), set `encoding: "base64"` and base64-encode the content. |
| `config` | no | Type-specific config (see below) |

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

**Response 201:**
```json
{
  "name": "todo-app",
  "type": "static",
  "prefix": "/todo-app",
  "status": "running",
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
  "config": {
    "index": "index.html",
    "spa": true
  }
}
```

The config JSON supports the same fields as the JSON Create App endpoint, except `files` (they come from the zip) and `prefix` (auto-derived from name).

**Response 201:** Full app object (same shape as JSON create).

**Errors:**
- `409` — App name already exists
- `400` — Missing name/type in config, invalid name, or no zip file

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
| `config` | no | Optional JSON string with updated configuration |

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

**Response 200:** Updated app object.

**Errors:**
- `404` — App not found

---

### Delete App

```
DELETE /apps/:name
```

Removes the app entirely: deletes all files, stops the container (if docker type), and removes the Caddy route. This is irreversible.

**Response 204:** No content.

**Errors:**
- `404` — App not found

---

### Get Logs

```
GET /apps/:name/logs?tail=100
```

Returns recent logs. For static apps, returns Caddy access logs. For docker apps, returns container stdout/stderr.

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

Restarts the app. For static apps this is a no-op (Caddy already serves the files). For docker apps it restarts the container.

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
