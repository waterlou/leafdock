import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inspectCompose, parseAllowedBindPaths, ComposePolicyError, assertComposeAllowed } from '../src/services/compose-validation';

// A throwaway app directory: some checks follow symlinks, so they need real
// paths on disk.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'leafdock-compose-policy-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let dirCount = 0;
function appDir(): string {
  const dir = path.join(tmpRoot, `app-${dirCount++}`);
  fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
  return dir;
}

function violations(compose: string, opts: { allowedHostPorts?: string; allowedBindPaths?: string } = {}, dir = appDir()): string[] {
  return inspectCompose(compose, { appDir: dir, ...opts }).violations;
}

function expectValid(compose: string, opts: { allowedHostPorts?: string; allowedBindPaths?: string } = {}, dir = appDir()): void {
  assert.deepEqual(violations(compose, opts, dir), []);
}

function expectViolation(compose: string, pattern: RegExp, opts: { allowedHostPorts?: string; allowedBindPaths?: string } = {}, dir = appDir()): void {
  const found = violations(compose, opts, dir);
  assert.ok(
    found.some(v => pattern.test(v)),
    `expected a violation matching ${pattern}, got ${JSON.stringify(found, null, 1)}`
  );
}

// --- host escapes: the reason this module exists ---------------------------

test('rejects host network namespace', () => {
  expectViolation('services:\n  web:\n    image: nginx\n    network_mode: host\n', /network_mode/);
});

test('rejects host process namespace', () => {
  expectViolation('services:\n  web:\n    image: nginx\n    pid: host\n', /PID namespace/);
});

test('rejects network_mode: container:<other>', () => {
  expectViolation('services:\n  web:\n    image: nginx\n    network_mode: "container:ld-other-web"\n', /network_mode/);
});

test('rejects capabilities that reach the host', () => {
  expectViolation(
    'services:\n  web:\n    image: nginx\n    cap_add: [NET_ADMIN, NET_RAW]\n',
    /cap_add/
  );
});

test('rejects privileged containers', () => {
  expectViolation('services:\n  web:\n    image: nginx\n    privileged: true\n', /privileged/);
});

test('rejects host devices, ipc, userns, cgroup and group_add', () => {
  expectViolation('services:\n  web:\n    image: nginx\n    devices: ["/dev/sda:/dev/sda"]\n', /devices/);
  expectViolation('services:\n  web:\n    image: nginx\n    ipc: host\n', /IPC namespace/);
  expectViolation('services:\n  web:\n    image: nginx\n    userns_mode: host\n', /userns_mode/);
  expectViolation('services:\n  web:\n    image: nginx\n    cgroup_parent: /system.slice/foo\n', /cgroup_parent/);
  expectViolation('services:\n  web:\n    image: nginx\n    group_add: [docker]\n', /group_add/);
});

test('rejects sysctls, volumes_from, extends and a non-default runtime', () => {
  expectViolation('services:\n  web:\n    image: nginx\n    sysctls:\n      net.ipv4.ip_forward: 1\n', /sysctls/);
  expectViolation('services:\n  web:\n    image: nginx\n    volumes_from: ["ld-other-web"]\n', /volumes_from/);
  expectViolation('services:\n  web:\n    image: nginx\n    extends: ./other.yml\n', /extends/);
  expectViolation('services:\n  web:\n    image: nginx\n    runtime: sysbox-runc\n', /runtime/);
});

test('rejects unknown service keys (allowlist, not blocklist)', () => {
  expectViolation('services:\n  web:\n    image: nginx\n    credential_spec:\n      file: docker-credential-secretservice\n', /credential_spec|allowlist/);
  expectViolation('services:\n  web:\n    image: nginx\n    some_future_escape: true\n', /allowlist/);
});

test('rejects weakened security_opt but allows no-new-privileges', () => {
  expectViolation('services:\n  web:\n    image: nginx\n    security_opt: [seccomp=unconfined]\n', /disables the syscall filter/);
  expectViolation('services:\n  web:\n    image: nginx\n    security_opt: ["apparmor=unconfined"]\n', /weakens isolation/);
  expectViolation('services:\n  web:\n    image: nginx\n    security_opt: ["label=disable"]\n', /weakens isolation/);
  expectValid('services:\n  web:\n    image: nginx\n    security_opt: ["no-new-privileges:true"]\n');
});

// A custom seccomp profile restricts syscalls, so it is a hardening option —
// but only from the app's own directory.
test('allows a seccomp profile from the app directory only', () => {
  const dir = appDir();
  fs.writeFileSync(path.join(dir, 'seccomp.json'), '{"defaultAction":"SCMP_ACT_ALLOW"}', 'utf-8');
  expectValid('services:\n  web:\n    image: nginx\n    security_opt: ["seccomp=./seccomp.json"]\n', {}, dir);
  expectValid('services:\n  web:\n    image: nginx\n    security_opt: ["seccomp:seccomp.json"]\n', {}, dir);
  expectViolation('services:\n  web:\n    image: nginx\n    security_opt: ["seccomp=/etc/seccomp.json"]\n', /outside the app directory/, {}, dir);
  expectViolation('services:\n  web:\n    image: nginx\n    security_opt: ["seccomp=../seccomp.json"]\n', /outside the app directory/, {}, dir);
  expectViolation('services:\n  web:\n    image: nginx\n    security_opt: ["seccomp"]\n', /weakens isolation/, {}, dir);
});

test('rejects container_name (Caddy routes by container name)', () => {
  expectViolation('services:\n  web:\n    image: nginx\n    container_name: ld-other-web\n', /container_name/);
});

test('rejects host sinks for container logs', () => {
  expectViolation('services:\n  web:\n    image: nginx\n    logging:\n      driver: journald\n', /logging driver/);
  expectValid('services:\n  web:\n    image: nginx\n    logging:\n      driver: json-file\n      options:\n        max-size: 10m\n');
});

// --- filesystem ------------------------------------------------------------

test('rejects bind mounts outside the app directory', () => {
  expectViolation('services:\n  web:\n    image: nginx\n    volumes: ["/etc:/host-etc"]\n', /host-reserved path|outside the app directory/);
  expectViolation('services:\n  web:\n    image: nginx\n    volumes: ["/:/host"]\n', /host-reserved path/);
  expectViolation('services:\n  web:\n    image: nginx\n    volumes: ["../shared:/data"]\n', /outside the app directory/);
  expectViolation('services:\n  web:\n    image: nginx\n    volumes: ["~/.ssh:/keys"]\n', /home-relative path/);
});

test('rejects a bind mount that escapes through a symlink', () => {
  const dir = appDir();
  const sibling = path.join(tmpRoot, 'sibling-target');
  fs.mkdirSync(sibling, { recursive: true });
  fs.symlinkSync(sibling, path.join(dir, 'sibling-link'));
  fs.symlinkSync('/etc', path.join(dir, 'etc-link'));

  expectViolation('services:\n  web:\n    image: nginx\n    volumes: ["./sibling-link:/data"]\n', /outside the app directory/, {}, dir);
  // A symlink straight at /etc trips the reserved-path check instead — either
  // way it is refused.
  expectViolation('services:\n  web:\n    image: nginx\n    volumes: ["./etc-link:/host-etc"]\n', /host-reserved path|outside the app directory/, {}, dir);
});

test('allows bind mounts inside the app directory', () => {
  expectValid('services:\n  web:\n    image: nginx\n    volumes: ["./web:/usr/share/nginx/html", "data:/var/lib/data", "app-data:/srv"]\n');
});

// Compose reads a single-letter "X:" prefix as a Windows drive letter and never
// splits `v:/data` into SOURCE:TARGET, so the daemon gets an anonymous volume
// whose mount path is the literal `v:/data` and refuses to start it. The long
// syntax starts fine. Both are verified against the shipped compose CLI; the
// rejection must therefore name the real reason, not "a Windows path".
test('rejects a single-letter volume spec as un-splittable, and accepts the long syntax', () => {
  expectViolation(
    'services:\n  web:\n    image: nginx\n    volumes: ["v:/data"]\nvolumes:\n  v:\n',
    /single-letter "X:" prefix/
  );
  expectViolation(
    'services:\n  web:\n    image: nginx\n    volumes: ["p:/data"]\nvolumes:\n  p:\n',
    /single-letter "X:" prefix/
  );
  // Multi-letter names are split normally and remain allowed.
  expectValid('services:\n  web:\n    image: nginx\n    volumes: ["db:/data"]\nvolumes:\n  db:\n');
  expectValid('services:\n  web:\n    image: nginx\n    volumes: ["1:/data"]\nvolumes:\n  "1":\n');
  // The documented workaround for a single-letter volume.
  expectValid('services:\n  web:\n    image: nginx\n    volumes:\n      - type: volume\n        source: v\n        target: /data\nvolumes:\n  v:\n');
});

test('host paths are opt-in: LEAFDOCK_ALLOWED_BIND_PATHS', () => {
  const allowed = path.join(tmpRoot, 'media');
  fs.mkdirSync(path.join(allowed, 'photos'), { recursive: true });
  const compose = `services:\n  web:\n    image: nginx\n    volumes: ["${allowed}/photos:/photos:ro"]\n`;

  expectViolation(compose, /no host paths are allowed/);

  expectValid(compose, { allowedBindPaths: allowed });

  // A sibling directory is still not allowed, and neither is a root the admin
  // should never approve.
  const sibling = path.join(tmpRoot, 'other');
  fs.mkdirSync(path.join(sibling, 'x'), { recursive: true });
  expectViolation(
    `services:\n  web:\n    image: nginx\n    volumes: ["${sibling}/x:/x"]\n`,
    /outside the app directory/,
    { allowedBindPaths: allowed }
  );
  expectViolation(compose, /host-reserved path|no host paths/, { allowedBindPaths: '/' });
});

test('the docker socket can never be bind-mounted, even if listed', () => {
  expectViolation(
    'services:\n  web:\n    image: nginx\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n',
    /host-reserved path/,
    { allowedBindPaths: '/var/run/docker.sock' }
  );
});

test('rejects named volumes that bind a host path behind the scenes', () => {
  expectViolation(
    'services:\n  web:\n    image: nginx\n    volumes: ["shared:/data"]\nvolumes:\n  shared:\n    driver_opts:\n      type: none\n      device: /\n      o: bind\n',
    /driver_opts/
  );
  expectViolation('volumes:\n  other:\n    external: true\nservices:\n  web:\n    image: nginx\n', /external/);
});

test('rejects builds that read outside the app directory or ask for privileges', () => {
  expectViolation('services:\n  web:\n    build: /etc\n', /build context/);
  expectViolation(
    'services:\n  web:\n    build:\n      context: .\n      privileged: true\n',
    /build privileges/
  );
  expectViolation(
    'services:\n  web:\n    build:\n      context: .\n      entitlements: [security.insecure]\n',
    /build privileges/
  );
  expectViolation('services:\n  web:\n    build:\n      context: .\n      network: host\n', /host-provided network/);
  expectViolation('services:\n  web:\n    build: https://github.com/example/repo.git\n', /remote (URL|build)/);
  expectViolation('services:\n  web:\n    build: git@github.com:example/repo.git\n', /remote (URL|build)/);
  expectValid('services:\n  web:\n    build:\n      context: ./web\n      dockerfile: Dockerfile\n      args:\n        NODE_ENV: production\n');
});

test('rejects env_file outside the app directory', () => {
  expectViolation('services:\n  web:\n    image: nginx\n    env_file: /etc/shadow\n', /env_file/);
  expectValid('services:\n  web:\n    image: nginx\n    env_file: ./.env\n');
});

// --- networks, secrets, includes ------------------------------------------

test('rejects host-networked and host-attached networks', () => {
  expectViolation('networks:\n  hostnet:\n    driver: host\nservices:\n  web:\n    image: nginx\n    networks: [hostnet]\n', /network driver/);
  expectViolation('networks:\n  mac:\n    driver: macvlan\n    driver_opts:\n      parent: eth0\nservices:\n  web:\n    image: nginx\n', /driver_opts/);
  expectViolation('services:\n  web:\n    image: nginx\n    networks: [host]\n', /reserved "host" network/);
  expectViolation(
    'networks:\n  h:\n    external: true\n    name: host\nservices:\n  web:\n    image: nginx\n    networks: [h]\n',
    /"external" joins a network created outside this app/
  );
});

// An app that joins a network it did not create reaches every other project on
// it, and the name reaches the daemon verbatim.
test('rejects external networks and malformed network names', () => {
  expectViolation(
    'networks:\n  other:\n    external: true\n    name: homeaccounting_default\nservices:\n  web:\n    image: nginx\n    networks: [other]\n',
    /"external" joins a network created outside this app/
  );
  expectViolation(
    'networks:\n  weird:\n    name: /tmp/leafdock-nettest\nservices:\n  web:\n    image: nginx\n    networks: [weird]\n',
    /"name" must be a plain docker network name/
  );
  expectViolation(
    'networks:\n  b:\n    name: bridge\nservices:\n  web:\n    image: nginx\n    networks: [b]\n',
    /built-in "bridge" network/
  );
  expectViolation(
    'networks:\n  n:\n    driver: none\nservices:\n  web:\n    image: nginx\n    networks: [n]\n',
    /network driver "none" is not allowed/
  );
  // A plain declared network is the supported shape.
  expectValid('networks:\n  internal-net:\n    driver: bridge\nservices:\n  web:\n    image: nginx\n    networks: [internal-net]\n');
});

test('rejects top-level secrets, configs and include', () => {
  expectViolation('services:\n  web:\n    image: nginx\nsecrets:\n  s:\n    file: /etc/shadow\n', /secrets/);
  expectViolation('services:\n  web:\n    image: nginx\nconfigs:\n  c:\n    file: /etc/passwd\n', /configs/);
  expectViolation('include:\n  - /tmp/evil.yml\nservices:\n  web:\n    image: nginx\n', /include/);
  expectViolation('services:\n  web:\n    image: nginx\n    secrets: [s]\n', /secrets/);
});

// --- published host ports --------------------------------------------------

test('published host ports are denied by default', () => {
  expectViolation('services:\n  web:\n    image: nginx\n    ports: ["22:22"]\n', /publishes host port 22/);
  expectViolation('services:\n  web:\n    image: nginx\n    ports:\n      - target: 80\n        published: 8686\n', /publishes host port 8686/);
});

test('published host ports can be opted in by an admin', () => {
  expectValid('services:\n  web:\n    image: nginx\n    ports: ["8080:80"]\n', { allowedHostPorts: '8080' });
  expectValid('services:\n  web:\n    image: nginx\n    ports: ["9001:80", "9002:81"]\n', { allowedHostPorts: '9000-9010' });
  expectValid('services:\n  web:\n    image: nginx\n    ports: ["8080:80"]\n', { allowedHostPorts: 'any' });
  expectViolation(
    'services:\n  web:\n    image: nginx\n    ports: ["8081:80"]\n',
    /publishes host port 8081/,
    { allowedHostPorts: '8080' }
  );
});

test('ephemeral host ports (target only) stay allowed', () => {
  expectValid('services:\n  web:\n    image: nginx\n    ports: ["3000"]\n');
  expectValid('services:\n  web:\n    image: nginx\n    expose: ["5432"]\n');
});

// --- YAML handling ---------------------------------------------------------

test('rejects malformed YAML and duplicate keys', () => {
  expectViolation('services: [web\n', /YAML error/);
  expectViolation('services:\n  web:\n    image: nginx\n    image: httpd\n', /YAML error/);
});

test('resolves merge keys, so an anchor cannot hide a host escape', () => {
  expectViolation(
    'x-base: &base\n  image: nginx\n  privileged: true\nservices:\n  web:\n    <<: *base\n',
    /privileged/
  );
});

test('rejects files without services and non-mapping services', () => {
  expectViolation('version: "3"\n', /at least one service|missing required/);
  expectViolation('services: [web]\n', /must be a mapping/);
  expectViolation('services:\n  web: nginx\n', /must be a mapping/);
  expectViolation('services:\n  "we b":\n    image: nginx\n', /invalid service name/);
});

// --- legitimate apps keep working -----------------------------------------

test('accepts the documented multi-service example', () => {
  expectValid(
    [
      'services:',
      '  web:',
      '    build: ./web',
      '    ports: ["3000"]',
      '  api:',
      '    build: ./api',
      '    ports: ["4000"]',
      '    environment:',
      '      DATABASE_URL: postgres://db:5432/app',
      '    depends_on: [db]',
      '  db:',
      '    image: postgres:16',
      '    volumes: [pgdata:/var/lib/postgresql/data]',
      '    healthcheck:',
      '      test: ["CMD", "pg_isready"]',
      '      interval: 10s',
      'volumes:',
      '  pgdata:',
      '',
    ].join('\n')
  );
});

test('accepts hardening options', () => {
  expectValid(
    [
      'services:',
      '  web:',
      '    image: nginx:alpine',
      '    read_only: true',
      '    cap_drop: [ALL]',
      '    user: "1000:1000"',
      '    init: true',
      '    tmpfs: ["/tmp"]',
      '    working_dir: /srv',
      '    command: ["nginx", "-g", "daemon off;"]',
      '    restart: unless-stopped',
      '    labels:',
      '      app: demo',
      '    deploy:',
      '      resources:',
      '        limits:',
      '          cpus: "0.5"',
      '          memory: 256M',
      '    x-custom: ignored',
      '',
    ].join('\n')
  );
});

// --- parsing helpers -------------------------------------------------------

test('LEAFDOCK_ALLOWED_BIND_PATHS ignores relative, reserved and socket entries', () => {
  assert.deepEqual(parseAllowedBindPaths(undefined).roots, []);
  assert.deepEqual(parseAllowedBindPaths('').roots, []);
  assert.deepEqual(parseAllowedBindPaths('relative/path').roots, []);
  assert.deepEqual(parseAllowedBindPaths('/').roots, []);
  assert.deepEqual(parseAllowedBindPaths('/var/run/docker.sock').roots, []);
  const ok = path.join(tmpRoot, 'media');
  fs.mkdirSync(ok, { recursive: true });
  assert.deepEqual(parseAllowedBindPaths(ok).roots, fs.realpathSync(ok) ? [fs.realpathSync(ok)] : []);
  assert.match(parseAllowedBindPaths('/').raw, /ignored/);
});

test('assertComposeAllowed throws a ComposePolicyError carrying every violation', () => {
  assert.throws(
    () => assertComposeAllowed('services:\n  web:\n    image: nginx\n    privileged: true\n    network_mode: host\n', { appDir: appDir() }),
    (err: unknown) => {
      assert.ok(err instanceof ComposePolicyError);
      assert.equal(err.code, 'compose_policy_violation');
      assert.equal(err.violations.length, 2);
      return true;
    }
  );
});
