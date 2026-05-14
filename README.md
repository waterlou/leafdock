# Intranet Host

A Docker-based system that runs on a NAS and hosts AI-generated web apps under URL prefixes. AI agents deploy and manage apps through a REST API — no manual config.

## How It Works

```
AI Agent                        NAS (Docker)
   │                               │
   │  POST /api/v1/apps            │
   │  { name, type, files, config }│
   │ ─────────────────────────────►│  management-api writes files,
   │                               │  creates Docker container,
   │  ◄─ 201 Created               │  configures Caddy route
   │                               │
   │                               │  https://nas.ts.net/my-app
   │ ─────────────────────────────►│  is now live
```

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Tailscale on the NAS (or any internal DNS pointing to the Docker host)

### Setup

```bash
# Clone and enter the project
cd intranet-host

# Set your API key
echo "MANAGEMENT_API_KEY=$(openssl rand -hex 32)" > .env

# Start
docker compose up -d
```

The management API is available at `http://<nas-hostname>/api/v1`. Apps go under `http://<nas-hostname>/<app-name>`.

### Deploy Your First App

```bash
curl -X POST http://localhost/api/v1/apps \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "hello",
    "type": "static",
    "files": [
      {
        "path": "index.html",
        "content": "<!DOCTYPE html><html><body><h1>Hello!</h1></body></html>"
      }
    ]
  }'
```

Then visit `http://<nas-hostname>/hello`.

## App Types

### Static

HTML/CSS/JS files served directly by Caddy. Best for frontend apps.

| Config option | Default | Description |
|---------------|---------|-------------|
| `index` | `index.html` | Default document |
| `spa` | `false` | Enable SPA mode (client-side routing) |

### Docker

A container built from your source files. The files are mounted at `/app` and the container runs on the internal Docker network. Best for full-stack apps.

| Config option | Default | Description |
|---------------|---------|-------------|
| `image` | `node:20-alpine` | Docker image to run |
| `port` | `3000` | Container port to proxy to |
| `env` | `{}` | Environment variables |
| `command` | — | Override the container command |
| `cpu_limit` | `0.5` | CPU shares (cores) |
| `mem_limit` | `128m` | Memory limit |

## API Overview

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/apps` | List all apps |
| `POST` | `/api/v1/apps` | Create an app |
| `GET` | `/api/v1/apps/:name` | Get app details |
| `PUT` | `/api/v1/apps/:name` | Full update (replace) |
| `PATCH` | `/api/v1/apps/:name` | Partial update |
| `DELETE` | `/api/v1/apps/:name` | Remove an app |
| `GET` | `/api/v1/apps/:name/logs` | View logs |
| `POST` | `/api/v1/apps/:name/restart` | Restart app |
| `GET` | `/api/v1/health` | Health check |

All `/apps` endpoints require `Authorization: Bearer <MANAGEMENT_API_KEY>`.

Full API docs in [api-docs.md](api-docs.md). AI agent usage examples in [skills.md](skills.md).

## Architecture

```
                   ┌─────────────────────────────────┐
                   │       Docker Host (NAS)           │
                   │                                   │
 Tailscale ───────►│  Caddy :80                        │
 (external)        │  ├─ /api/*  → management-api:3001  │
                   │  ├─ /app-a  → static files        │
                   │  ├─ /app-b  → app container        │
                   │  └─ /       → landing page        │
                   │                                   │
                   │  management-api (Node.js)          │
                   │  ├─ SQLite at /data/management.db  │
                   │  ├─ Apps at /data/apps/<name>/     │
                   │  ├─ Talks to Caddy admin API       │
                   │  └─ Talks to Docker socket         │
                   └─────────────────────────────────┘
```

## Project Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Service definitions |
| `Caddyfile` | Reverse proxy base config |
| `Dockerfile` | Management API image |
| `src/index.ts` | Express server entry point |
| `src/db.ts` | SQLite database layer |
| `src/routes/apps.ts` | App CRUD endpoints |
| `src/services/apps.ts` | App lifecycle logic |
| `src/services/caddy.ts` | Caddy admin API client |
| `src/services/docker.ts` | Docker container management |
| `specs.md` | Project specification |
| `api-docs.md` | Full API reference |
| `skills.md` | How-to guide for AI agents |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MANAGEMENT_API_KEY` | `change-me` | API key for auth |
| `PORT` | `3001` | Management API listen port |
| `DATA_DIR` | `/data` | SQLite and app files directory |
| `CADDY_ADMIN_URL` | `http://caddy:2019` | Caddy admin API address |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket path |

## Development

```bash
npm install
npm run dev          # tsx watch mode on port 3001
npm run build        # compile to dist/
```

Requires Node 20+. The dev server uses `sql.js` (pure JS SQLite) so it works on macOS, Linux, and Alpine without native compilation.
