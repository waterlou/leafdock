# Leafdock

A self-hosted platform for running web apps on your own hardware — no cloud, no subscription, no cold starts. Designed from the ground up for **AI agents** to deploy and manage apps through a REST API, but equally usable by humans with curl.

If cloud platforms like Vercel and Netlify optimize for the public internet, and CapRover is a self-hosted PaaS for humans, leafdock is the thinnest possible layer between *"Claude generated this app"* and *"it's running on my network."* It runs Docker containers on your NAS, serves them behind Caddy, and never touches the cloud — your data stays local, your apps run 24/7 with no cold starts, and the only cost is the hardware you already own.

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

## Installation

### Prerequisites

- Docker and Docker Compose (for Docker-based installs)
- Node.js 20+ (for npm install)
- Tailscale on the NAS (or any internal DNS pointing to the Docker host)

---

### Option 1: Docker Compose (recommended)

```bash
# Clone the repo
git clone <repo-url> leafdock
cd leafdock

# Generate a random API key
echo "MANAGEMENT_API_KEY=$(openssl rand -hex 32)" > .env

# Optional: set landing page title
echo "TITLE=My Intranet" >> .env

# Start all services
docker compose up -d
```

The management API is available at `http://<nas-hostname>/api/v1`. Apps are served at `http://<nas-hostname>/<app-name>` (or `/<folder>/<app-name>` inside a subfolder).

---

### Option 2: Docker (manual, without Compose)

```bash
# Create a Docker network
docker network create leafdock_default

# Build and run the combined Caddy + API container
docker build -t leafdock .

docker run -d \
  --name leafdock \
  --network leafdock_default \
  -p 80:80 \
  -e MANAGEMENT_API_KEY=$(openssl rand -hex 32) \
  -v leafdock_app_data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  leafdock
```

---

### Option 3: npm (development / bare metal)

```bash
# Clone and install
git clone <repo-url> leafdock
cd leafdock
npm install

# Start Caddy (required for routing and the landing page)
# Install caddy from https://caddyserver.com/ or use Docker:
docker run -d \
  --name leafdock-caddy \
  -p 80:80 \
  -v leafdock_app_data:/data \
  -v $PWD/Caddyfile:/etc/caddy/Caddyfile:ro \
  caddy:2-alpine

# Set environment variables
export MANAGEMENT_API_KEY=my-secret-key
export CADDY_ADMIN_URL=http://localhost:2019
export DOCKER_SOCKET=/var/run/docker.sock
export DATA_DIR=./data
export TITLE="My Intranet"

# Build and start
npm run build
npm start
```

Or run the whole stack with one command — ports are assigned automatically so nothing collides (pin them with `API_PORT=` / `HTTP_PORT=` if you need them stable):

```bash
npm run start:local
```

It prints the API and landing-page URLs, runs Caddy and the management API together, and stops Caddy when you Ctrl-C. `DATA_DIR` defaults to `./data`.

On the NAS (compose install): `./scripts/start-nas.sh` builds and starts the stack on a port that is actually free (overriding an occupied `HTTP_PORT` in `.env`), waits for the health check, and prints the URL.

For development with auto-reload:
```bash
npm run dev
```

## Deploy Your First App

```bash
curl -X POST http://localhost/api/v1/apps \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "hello",
    "type": "static",
    "icon": "🚀",
    "files": [
      {
        "path": "index.html",
        "content": "<!DOCTYPE html><html><body><h1>Hello!</h1></body></html>"
      }
    ]
  }'
```

Then visit `http://<nas-hostname>/hello`.

Prefer deploying from a git repo when the app lives in one — no file transfer, and updates re-pull the latest commit:

```bash
# Create from a repository (public GitHub, Gitea, or file:// for local)
curl -X POST http://localhost/api/v1/apps/git \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app","type":"static","git":{"url":"https://github.com/you/my-app.git"}}'

# Update — re-clones the repo (docker apps rebuild automatically)
curl -X PUT http://localhost/api/v1/apps/my-app/git \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"git":{"url":"https://github.com/you/my-app.git"}}'
```

Private repositories are authenticated from the leafdock environment (`GIT_TOKENS` or `GIT_TOKEN`) — the API never accepts or stores tokens. See `api-docs.md` for the full contract.

## Subfolders

Apps can live in subfolders: an app in folder `blog` is served at `http://<nas-hostname>/blog/my-app` and stored on disk at `/data/apps/blog/my-app/`. Folders can nest (`blog/tutorials`). The landing page shows only the current folder's apps plus its immediate subfolders; click a folder to drill into it. Inside a folder, the folder's display label becomes the page title and the Back / Root buttons sit at the header's edges — the Root button appears when you're more than one level deep.

- **Create in a folder** — add `"folder": "blog"` to the create payload (`""` or omitted = root; mutually exclusive with `prefix`, which sets the full URL instead)
- **Move** — `POST /api/v1/apps/:name/move` with body `{"folder": "blog"}` (`{"folder": ""}` moves back to root)
- **Display labels** — `PUT /api/v1/folders/:path` with `{"label":"New Demo"}` sets a human-readable folder name for the landing page; the URL and on-disk directory keep the slug (`new-demo`). `{"label":""}` clears it.
- **Deep links** — folders have their own URL: visiting `http://<nas-hostname>/new-demo` opens the folder view directly, and browser Back/Forward navigate between folders.
- Folders follow per segment: lowercase letters, digits, hyphens, starting with a letter. Input case is normalized — `Demo` is accepted but stored and shown as `demo`, matching the URL. Folders cannot shadow or be shadowed by an existing app's URL tree

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

### Docker Compose

Multiple containers defined in a `docker-compose.yml`. Caddy routes to individual services — the first service in `config.services` gets the main prefix, additional services get sub-prefixes. Best for multi-service apps (web + API + database).

| Config option | Default | Description |
|---------------|---------|-------------|
| `compose_file` | `docker-compose.yml` | Compose file name to use |
| `services` | `{}` | Map of service name to `{ port }` for Caddy routing |

The uploaded files (compose file, Dockerfiles, source) are placed in `/data/apps/<name>/` (or `/data/apps/<folder>/<name>/` in a subfolder) and `docker compose up -d` starts all services. Internal services like databases that don't need HTTP routing should be omitted from `config.services`.

> If you plan to contribute: `src/services/compose.ts` handles Docker Compose lifecycle, `src/services/docker.ts` handles single-container lifecycle.

## API Overview

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/apps` | List all apps |
| `POST` | `/api/v1/apps` | Create an app (JSON) |
| `POST` | `/api/v1/apps/upload` | Create an app (zip upload) |
| `GET` | `/api/v1/apps/:name` | Get app details |
| `PUT` | `/api/v1/apps/:name` | Full update (replace) |
| `PUT` | `/api/v1/apps/:name/upload` | Update app files (zip) |
| `PATCH` | `/api/v1/apps/:name` | Partial update |
| `DELETE` | `/api/v1/apps/:name` | Remove an app |
| `GET` | `/api/v1/apps/:name/logs` | View logs |
| `POST` | `/api/v1/apps/:name/restart` | Restart app |
| `POST` | `/api/v1/apps/:name/stop` | Stop app |
| `POST` | `/api/v1/apps/:name/start` | Start app |
| `POST` | `/api/v1/apps/:name/move` | Move app into/out of a subfolder |
| `PUT` | `/api/v1/folders/:path` | Set/clear a folder display label |
| `GET` | `/api/v1/health` | Health check |

All `/apps` endpoints require `Authorization: Bearer <MANAGEMENT_API_KEY>`.

Full API docs in [api-docs.md](api-docs.md). AI agent usage examples in [skills/leafdock/SKILL.md](skills/leafdock/SKILL.md).

## Architecture

```
                   ┌─────────────────────────────────┐
                   │       Docker Host (NAS)           │
                   │                                   │
 Tailscale ────────►│  leafdock (single container)      │
 (external)        │  ├─ Caddy :80                     │
                   │  │  ├─ /api/*  → localhost:3001    │
                   │  │  ├─ /app-a  → user container    │
                   │  │  ├─ /app-b  → user container    │
                   │  │  └─ /       → landing page     │
                   │  │                                 │
                   │  └─ management-api (Node.js)       │
                   │     ├─ SQLite at /data/management.db│
                   │     ├─ Apps at /data/apps/<name>/   │
                   │     ├─ Talks to Caddy admin API    │
                   │     └─ Talks to Docker socket      │
                   └─────────────────────────────────┘
```

## Project Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Single-service definition |
| `Caddyfile` | Reverse proxy config (baked into image) |
| `Dockerfile` | Combined image (Caddy + Node.js) |
| `docker-entrypoint.sh` | Starts Caddy and Node.js |
| `src/index.ts` | Express server entry point |
| `src/db.ts` | SQLite database layer |
| `src/routes/apps.ts` | App CRUD endpoints |
| `src/services/apps.ts` | App lifecycle logic |
| `src/services/caddy.ts` | Caddy admin API client |
| `src/services/docker.ts` | Docker container management |
| `src/services/compose.ts` | Docker Compose lifecycle |
| `specs.md` | Project specification |
| `api-docs.md` | Full API reference |
| `skills/leafdock/SKILL.md` | How-to guide for AI agents |
| `AGENTS.md` | Agent pointer to the skill file |
## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MANAGEMENT_API_KEY` | `change-me` | API key for auth |
| `PORT` | `3001` | Management API listen port |
| `DATA_DIR` | `/data` | SQLite and app files directory |
| `CADDY_ADMIN_URL` | `http://localhost:2019` | Caddy admin API address |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket path |
| `TITLE` | `Leafdock` | Landing page title |

## Development

```bash
npm install
npm run dev          # tsx watch mode on port 3001
npm run build        # compile to dist/
```

Requires Node 20+. The dev server uses `sql.js` (pure JS SQLite) so it works on macOS, Linux, and Alpine without native compilation.
