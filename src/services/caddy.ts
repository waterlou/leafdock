const CADDY_ADMIN_URL = process.env.CADDY_ADMIN_URL || 'http://caddy:2019';

interface CaddyRoute {
  match: Array<{ path: string[] }>;
  handle: Array<Record<string, unknown>>;
  '@id'?: string;
}

async function getRoutes(): Promise<CaddyRoute[]> {
  const res = await fetch(`${CADDY_ADMIN_URL}/config/apps/http/servers/srv0/routes`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to get Caddy routes: ${res.status} ${body}`);
  }
  // Caddy returns null if no routes exist yet
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function setRoutes(routes: CaddyRoute[]): Promise<void> {
  const res = await fetch(`${CADDY_ADMIN_URL}/config/apps/http/servers/srv0/routes`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(routes),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to update Caddy routes: ${res.status} ${body}`);
  }
}

export async function addStaticRoute(prefix: string, appDir: string, spa: boolean, index: string): Promise<void> {
  const routes = await getRoutes();
  const routeId = `app-${prefix.replace(/^\//, '').replace(/\//g, '-')}`;

  // Remove existing route with same ID if present
  const filtered = routes.filter(r => r['@id'] !== routeId);

  const handle: Record<string, unknown>[] = [
    {
      handler: 'file_server',
      root: appDir,
    },
  ];

  if (spa) {
    // For SPA, first try to serve the file, fall back to index.html
    handle.push({
      handler: 'rewrite',
      uri: `{http.request.uri.path}/${index}`,
    });
  }

  const route: CaddyRoute = {
    '@id': routeId,
    match: [{ path: [prefix, `${prefix}/*`] }],
    handle,
  };

  filtered.push(route);
  await setRoutes(filtered);
}

export async function addDockerRoute(prefix: string, containerName: string, port: number): Promise<void> {
  const routes = await getRoutes();
  const routeId = `app-${prefix.replace(/^\//, '').replace(/\//g, '-')}`;

  const filtered = routes.filter(r => r['@id'] !== routeId);

  const route: CaddyRoute = {
    '@id': routeId,
    match: [{ path: [prefix, `${prefix}/*`] }],
    handle: [
      {
        handler: 'reverse_proxy',
        upstreams: [{ dial: `${containerName}:${port}` }],
      },
    ],
  };

  filtered.push(route);
  await setRoutes(filtered);
}

export async function removeRoute(prefix: string): Promise<void> {
  const routes = await getRoutes();
  const routeId = `app-${prefix.replace(/^\//, '').replace(/\//g, '-')}`;
  const filtered = routes.filter(r => r['@id'] !== routeId);
  await setRoutes(filtered);
}
