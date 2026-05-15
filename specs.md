# Leafdock — Project Specification

## Purpose

A Docker-based system that runs on a NAS and hosts AI-generated web applications
under URL prefixes (e.g., `https://nas.ts.net/my-app`). It exposes a management
API so AI agents can create, update, and remove apps programmatically.

## Architecture

```
                    ┌─────────────────────────────────┐
                    │        Docker Host (NAS)          │
                    │                                   │
  Tailscale ───────►│  Caddy (reverse proxy)            │
  (external,        │  ├─ /api/*  → management-api:3001 │
   configured       │  ├─ /app-a  → app-a static files  │
   separately)      │  ├─ /app-b  → app-b container     │
                    │  └─ /       → landing page        │
                    │                                   │
                    │  management-api (Node.js)          │
                    │  ├─ SQLite (app metadata)          │
                    │  ├─ /data/apps/<name>/ (files)     │
                    │  ├─ Talks to Caddy Admin API       │
                    │  └─ Talks to Docker socket         │
                    │                                   │
                    │  app-b container (docker type)     │
                    │  └─ internal network, port 3000    │
                    └─────────────────────────────────┘
```

## App Types

### Static

Files are written to `/data/apps/<name>/` and served by Caddy's `file_server`.
Best for HTML/CSS/JS frontends, SPAs, and static sites.

### Docker

The management API creates and manages a Docker container for the app. The app
source files are mounted into the container at `/app`. Caddy reverse-proxies to
the container's internal port. Best for full-stack apps with backend logic.

## Components

| Component | Role |
|-----------|------|
| **Caddy** | Reverse proxy, prefix routing, static file serving |
| **Management API** | Node.js/Express server that manages apps and configures Caddy |
| **SQLite** | Stores app metadata (name, type, prefix, config, status) |
| **Docker socket** | For creating/stopping docker-type app containers |

## Security

- Management API is auth-gated with a single Bearer token
- The system is designed to run behind Tailscale — no public internet exposure
- Docker socket access is contained within the internal Docker network
- App names are validated to be URL-safe slugs only

## Limitations

- JSON file upload means files must be UTF-8 text (no binary assets). For binary
  support, a multipart zip upload endpoint can be added later.
- Docker-type apps share the host's Docker daemon. Resource limits (CPU/mem) are
  configurable per app.
- No authentication/authorization for individual apps — all apps are equally
  accessible within the Tailscale network.
