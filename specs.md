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
                    │  ├─ /data/apps/[<folder>/]<name>/  │
                    │  ├─ Talks to Caddy Admin API       │
                    │  └─ Talks to Docker socket         │
                    │                                   │
                    │  app-b container (docker type)     │
                    │  └─ internal network, port 3000    │
                    └─────────────────────────────────┘
```

## App Types

### Static

Files are written to `/data/apps/<name>/` (or `/data/apps/<folder>/<name>/` in a
subfolder) and served by Caddy's `file_server`. Best for HTML/CSS/JS frontends,
SPAs, and static sites.

### Docker

The management API creates and manages a Docker container for the app. The app
source files are mounted into the container at `/app`. Caddy reverse-proxies to
the container's internal port. Best for full-stack apps with backend logic.

### Docker Compose

The app directory holds a `docker-compose.yml` (plus build contexts); the API
runs `docker compose up -d` in it. Caddy routes to individual services: the
first service in `config.services` gets the main prefix (`/<name>/`), additional
services get sub-prefixes (`/<name>/<serviceName>/`). Services that don't need
HTTP routing (databases, caches) stay on the compose internal network and are
omitted from `config.services`.

`config.compose_file` (optional) selects a different file in the same directory;
it must be a bare `.yml`/`.yaml` filename — no path separators, no shell
characters, and not `docker-compose.network.yml`, which leafdock writes itself.

Compose commands run as argv via `execFile` (never a shell string), and the
child process inherits a whitelist of variables (`PATH`, `HOME`, `DOCKER_HOST`,
`DOCKER_CONFIG`, `DOCKER_CONTEXT`, `TMPDIR`, `LANG`, `LC_ALL`, `TZ`) so an
uploaded file cannot interpolate `${MANAGEMENT_API_KEY}`, `${GIT_TOKEN}` or any
other leafdock secret into a service environment.

## Subfolders

Apps can be placed in subfolders: an app in folder `blog` lives at
`/data/apps/blog/<name>/` on disk and is served at `/blog/<name>`. The folder is
derived from the stored `prefix` (all segments except the last), so there is no
schema change — existing root-level rows are unaffected. The landing page groups
apps under folder headers, root apps first.

- `folder` is accepted by create (JSON and zip upload) and is mutually exclusive
  with `prefix` (which sets the full URL directly)
- `POST /apps/:name/move` with `{"folder": "blog"}` moves an app between
  subfolders (`""` moves back to the root); files are relocated on disk, Caddy
  routes are swapped, and docker / docker-compose containers are recreated
- Folder segments follow the app-name slug rules (lowercase letters, digits,
  hyphens); a folder cannot shadow or be shadowed by an existing app's URL tree
  (prefix conflicts are rejected on create and move)

## Components

| Component | Role |
|-----------|------|
| **Caddy** | Reverse proxy, prefix routing, static file serving |
| **Management API** | Node.js/Express server that manages apps and configures Caddy |
| **SQLite** | Stores app metadata (name, type, prefix, config, status; folder derived from prefix) |
| **Docker socket** | For creating/stopping docker-type app containers |

## Security

- Management API is auth-gated with a single Bearer token
- The system is designed to run behind Tailscale — no public internet exposure
- Docker socket access is contained within the internal Docker network
- App names and folder segments are validated to be URL-safe slugs only
- Caddy's admin API is bound to loopback and restricted to known origins

### Compose host-safety policy

Leafdock holds the docker socket, so an uploaded compose file is a request
against the host: `network_mode: host` + `cap_add: [NET_ADMIN]` rewrites the NAS
firewall, `pid: host` exposes the process table, `privileged: true` is plain
root, and a `/`-bind reads every file. Every compose file is therefore validated
against an allowlist (`src/services/compose-validation.ts`) *before*
`docker compose up`, and the gate runs on the file that will actually be read.
A rejection is `400 compose_policy_violation` with every violation listed;
nothing is written or started, and `composeDown` stays ungated so a
non-compliant app can still be stopped or deleted. `GET /apps/:name/compose-check`
applies the same policy to a stored file without deploying.

Denied by default: host namespaces (`network_mode`, `pid`, `ipc`, `uts`,
`userns_mode`), `privileged`, `cap_add`, `devices`, `sysctls`, `group_add`,
`volumes_from`, `extends`, `container_name`, top-level `secrets`/`configs`/
`include`, external and host-attached networks, named volumes with
`driver_opts`/`external`, bind mounts / `build.context` / `env_file` outside the
app directory, and fixed published host ports. Unknown keys are rejected rather
than ignored (allowlist, not blocklist), merge keys are resolved so an anchor
cannot hide a denied field, and duplicate keys are an error. `security_opt`
accepts `no-new-privileges` and a seccomp profile from the app directory;
`seccomp=unconfined`, `apparmor=unconfined` and `label=disable` are refused.

Two operator opt-ins exist, both **off by default** (see `.env.example`):

| Variable | Effect |
|----------|--------|
| `LEAFDOCK_ALLOWED_BIND_PATHS` | Extra absolute host paths bind mounts may use. `/`, `/proc`, `/sys`, `/dev`, `/etc` and the docker socket are refused even when listed. |
| `LEAFDOCK_ALLOWED_HOST_PORTS` | Host ports a service may publish (`8080`, `9000-9010`, `any`). Target-only specs get an ephemeral port and stay allowed. |

### What this policy does not cover

The gate removes the direct host escape routes from compose files; it is not a
sandbox.

- `image:` is still uploader-chosen and internet-reachable — a malicious image
  is not stopped by validation.
- `docker`-type apps execute uploaded code by design, so they are equally
  trusted.
- Every app container mounts the whole `/data` store at `/app`, so an app can
  read `management.db` and other apps' files. Scoping each app to its own
  directory is open work, as is daemon-side `userns-remap`.

## Limitations

- The JSON file upload requires UTF-8 text (no binary assets) — use the
  multipart zip upload (`POST /apps/upload`) for apps with images, fonts, or
  other binary files.
- Docker-type apps share the host's Docker daemon. Resource limits (CPU/mem) are
  configurable per app.
- No authentication/authorization for individual apps — all apps are equally
  accessible within the Tailscale network.
