import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createApp, syncRoutes } from '../src/services/apps';
import { ValidationError } from '../src/services/errors';
import * as db from '../src/db';
import type { AppConfig, AppInput } from '../src/services/apps';

// Config validation lives in mergeConfig (private), reached through createApp.
// These pin the rules that protect Caddy routing and the docker daemon, so a
// regression is caught without a daemon. DATA_DIR is read per call, so pointing
// it at a temp tree before the first create is enough.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leafdock-config-'));
process.env.DATA_DIR = dataDir;
// Keep the suite off the real host: point dockerode at a socket that cannot
// exist, so any accidental docker call fails fast instead of creating
// containers on the developer's machine (an earlier revision reached the live
// daemon because the ambient DOCKER_SOCKET was inherited).
process.env.DOCKER_SOCKET = path.join(dataDir, 'no-such-docker.sock');

test.before(() => db.initDb(dataDir));
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

let counter = 0;
function create(type: AppInput['type'], config: unknown) {
  return createApp({
    name: `cfg${counter++}`,
    type,
    files: [{ path: 'index.html', content: 'x' }],
    config: config as AppConfig,
  });
}

test('rejects a compose service name that would become a Caddy path wildcard', async () => {
  // A service key is interpolated into the route path as `/<app>/<service>`;
  // `*` turns that into a wildcard that matches sibling apps' paths.
  await assert.rejects(
    () => create('docker-compose', { services: { '*': { port: 3000 } } }),
    /Invalid service name/
  );
  await assert.rejects(
    () => create('docker-compose', { services: { '../evil': { port: 3000 } } }),
    /Invalid service name/
  );
  await assert.rejects(
    () => create('docker-compose', { services: { 'has space': { port: 3000 } } }),
    /Invalid service name/
  );
});

test('rejects a compose service port that is not a real port', async () => {
  await assert.rejects(
    () => create('docker-compose', { services: { web: { port: 'abc' } } }),
    /must be an integer between 1 and 65535/
  );
  await assert.rejects(
    () => create('docker-compose', { services: { web: { port: 70000 } } }),
    /must be an integer between 1 and 65535/
  );
});

test('rejects a cpu_limit that would become NaN (docker treats it as unlimited)', async () => {
  // parseFloat('abc') is NaN -> CpuShares NaN -> docker stores 0 shares, i.e.
  // no limit at all. Silently unlimited is the opposite of what was asked.
  for (const cpu of ['abc', '-1', '0', '']) {
    await assert.rejects(
      () => create('docker', { image: 'alpine', port: 3000, cpu_limit: cpu, mem_limit: '128m', env: {} }),
      /"cpu_limit" must be a positive number/,
      `cpu_limit ${JSON.stringify(cpu)} should be rejected`
    );
  }
});

test('rejects a mem_limit that means unlimited or cannot be parsed', async () => {
  // docker reads Memory: 0 as "no limit", and an unparsable value must not
  // silently fall back to the 128m default either.
  for (const mem of ['0', '0m', '0g', 'abc']) {
    await assert.rejects(
      () => create('docker', { image: 'alpine', port: 3000, cpu_limit: '0.5', mem_limit: mem, env: {} }),
      /"mem_limit" must be a size/,
      `mem_limit ${JSON.stringify(mem)} should be rejected`
    );
  }
});

test('rejects env names that would inject an extra container variable', async () => {
  // docker receives one `NAME=value` argv element per entry, so '=' or a
  // newline in the name splits into additional variables.
  await assert.rejects(
    () => create('docker', { image: 'alpine', port: 3000, cpu_limit: '0.5', mem_limit: '128m', env: { 'A=B': 'x' } }),
    /Invalid env variable name/
  );
  await assert.rejects(
    () => create('docker', { image: 'alpine', port: 3000, cpu_limit: '0.5', mem_limit: '128m', env: { 'FOO\nBAR': 'x' } }),
    /Invalid env variable name/
  );
  await assert.rejects(
    () => create('docker', { image: 'alpine', port: 3000, cpu_limit: '0.5', mem_limit: '128m', env: { OK: 123 } }),
    /must be a string/
  );
});

test('still accepts well-formed docker and compose configs', async () => {
  // createApp goes on to pull an image, so assert on validation only: a config
  // that passes mergeConfig fails later with a docker error, never a
  // validation_error about the fields themselves.
  const expectNotValidation = async (type: AppInput['type'], config: unknown) => {
    try {
      await create(type, config);
    } catch (err) {
      // ValidationError is what mergeConfig throws; anything else (docker pull,
      // Caddy) means the config itself was accepted.
      assert.ok(!(err instanceof ValidationError), `unexpected validation rejection: ${(err as Error).message}`);
      return;
    }
  };
  await expectNotValidation('docker', {
    image: 'node:20-alpine',
    port: 3000,
    cpu_limit: '0.5',
    mem_limit: '128m',
    env: { NODE_ENV: 'production', _PRIVATE: 'ok' },
  });
  await expectNotValidation('docker-compose', { services: { web: { port: 3000 }, api_v2: { port: 4000 } } });
});

// Docker and compose containers share one flat name space: a docker app `x`
// gets `ld-app-x`, and a compose app `app` with service `x` gets `ld-app-x`
// too. The second create force-removes the first app's live container, so the
// collision must be refused. The guard runs before any deploy, so no daemon is
// needed (the docker CLI the compose path shells out to is never reached).
test('rejects an app whose container name collides with an existing app', async () => {
  const now = new Date().toISOString();
  db.createApp({
    name: 'collide-docker',
    type: 'docker',
    prefix: '/collide-docker',
    status: 'running',
    config: JSON.stringify({ image: 'alpine', port: 3000, cpu_limit: '0.5', mem_limit: '128m', env: {} }),
    container_id: 'ld-app-collide-docker',
    icon: '',
    created_at: now,
    updated_at: now,
  });

  // compose app "app" with service "collide-docker" -> container ld-app-collide-docker
  await assert.rejects(
    () =>
      createApp({
        name: 'app',
        type: 'docker-compose',
        files: [{ path: 'docker-compose.yml', content: 'services:\n  collide-docker:\n    image: alpine\n' }],
        config: { services: { 'collide-docker': { port: 80 } } } as AppConfig,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.code, 'container_name_conflict');
      assert.match(err.message, /ld-app-collide-docker/);
      return true;
    }
  );
});

// `index` was validated only for static apps, but mergeConfig spreads the patch
// and extractTitle joins `index` onto the app directory for every row, so a
// docker/compose app carrying an index could make the API read an arbitrary
// host file as root.
test('rejects an index that escapes the app directory on any app type', async () => {
  for (const type of ['static', 'docker', 'docker-compose'] as const) {
    await assert.rejects(
      () => create(type, { index: '../../../etc/hostname' }),
      /Invalid index file/,
      `${type} should reject a traversing index`
    );
    await assert.rejects(
      () => create(type, { index: 'sub/../x.html' }),
      /Invalid index file/,
      `${type} should reject a path separator`
    );
  }
});

// A stored row can predate a validation rule (an old compose service name, a
// pre-validation cpu_limit). mergeConfig throws for those, and that throw used
// to sit outside syncRoutes' per-row try, so one bad row aborted the whole
// route pass — syncRoutes rejects main(), which exits the process.
test('an invalid stored config does not abort the route pass', async () => {
  const now = new Date().toISOString();
  // A row whose config the current rules reject (service name with a space).
  db.createApp({
    name: 'legacy-bad',
    type: 'docker-compose',
    prefix: '/legacy-bad',
    status: 'running',
    config: JSON.stringify({ services: { 'bad name': { port: 80 } } }),
    container_id: null,
    icon: '',
    created_at: now,
    updated_at: now,
  });
  // And a healthy row that must still get its route.
  db.createApp({
    name: 'legacy-good',
    type: 'static',
    prefix: '/legacy-good',
    status: 'running',
    config: JSON.stringify({ index: 'index.html', spa: false }),
    container_id: null,
    icon: '',
    created_at: now,
    updated_at: now,
  });

  // Caddy is unreachable here, so every row logs a failure; the point is that
  // syncRoutes resolves rather than rejecting on the invalid row.
  await assert.doesNotReject(() => syncRoutes());
});
