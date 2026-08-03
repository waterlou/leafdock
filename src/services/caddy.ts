const CADDY_ADMIN_URL = process.env.CADDY_ADMIN_URL || 'http://localhost:2019';

interface CaddyRoute {
  match: Array<{ path: string[] }>;
  handle: Array<Record<string, unknown>>;
  '@id'?: string;
}

export function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${CADDY_ADMIN_URL}${path}`, {
    ...init,
    headers: {
      'Origin': 'http://localhost',
      ...init?.headers,
    },
  });
}

async function getRoutes(): Promise<CaddyRoute[]> {
  const res = await adminFetch('/config/apps/http/servers/srv0/routes');
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to get Caddy routes: ${res.status} ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function setRoutes(routes: CaddyRoute[]): Promise<void> {
  const res = await adminFetch('/config/apps/http/servers/srv0/routes', {
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

  const filtered = routes.filter(r => r['@id'] !== routeId && r['@id'] !== routeId + '-root');

  // Redirect exact prefix to prefix/ so relative URLs in HTML resolve correctly
  const redirectRoute: CaddyRoute = {
    '@id': routeId + '-root',
    match: [{ path: [prefix] }],
    handle: [{
      handler: 'static_response',
      status_code: 308,
      headers: { Location: [prefix + '/'] },
    }],
  };

  const subRoutes: Record<string, unknown>[] = [
    {
      handle: [{ handler: 'rewrite', strip_path_prefix: prefix }],
    },
    // After stripping prefix, root path '/' needs explicit rewrite to index
    // so the file_server receives a file path, not a directory path
    {
      match: [{ path: ['/'] }],
      handle: [{ handler: 'rewrite', uri: '/' + index }],
    },
  ];

  if (spa) {
    subRoutes.push({
      match: [{ not: [{ file: { root: appDir } }] }],
      handle: [{ handler: 'rewrite', uri: '/' + index }],
    });
  }

  subRoutes.push({
    handle: [{ handler: 'file_server', root: appDir }],
  });

  const serveRoute: CaddyRoute = {
    '@id': routeId,
    match: [{ path: [`${prefix}/*`] }],
    handle: [{ handler: 'subroute', routes: subRoutes }],
  };

  filtered.unshift(serveRoute, redirectRoute);
  await setRoutes(filtered);
}

export async function addDockerRoute(prefix: string, containerName: string, port: number): Promise<void> {
  const routes = await getRoutes();
  const routeId = `app-${prefix.replace(/^\//, '').replace(/\//g, '-')}`;

  const filtered = routes.filter(r => r['@id'] !== routeId && r['@id'] !== routeId + '-root');

  // Redirect exact prefix to prefix/ so relative URLs in HTML resolve correctly
  const redirectRoute: CaddyRoute = {
    '@id': routeId + '-root',
    match: [{ path: [prefix] }],
    handle: [{
      handler: 'static_response',
      status_code: 308,
      headers: { Location: [prefix + '/'] },
    }],
  };

  // Subroute strips the prefix before forwarding to the container
  const serveRoute: CaddyRoute = {
    '@id': routeId,
    match: [{ path: [`${prefix}/*`] }],
    handle: [{ handler: 'subroute', routes: [
      { handle: [{ handler: 'rewrite', strip_path_prefix: prefix }] },
      { handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: `${containerName}:${port}` }] }] },
    ]}],
  };

  filtered.unshift(serveRoute, redirectRoute);
  await setRoutes(filtered);
}

export async function removeRoute(prefix: string): Promise<void> {
  const routes = await getRoutes();
  const routeId = `app-${prefix.replace(/^\//, '').replace(/\//g, '-')}`;
  const filtered = routes.filter(r => r['@id'] !== routeId && r['@id'] !== routeId + '-root');
  await setRoutes(filtered);
}
