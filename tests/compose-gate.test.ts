import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as db from '../src/db';
import { assertComposePolicy } from '../src/services/compose';
import { ComposePolicyError } from '../src/services/compose-validation';
import { checkCompose } from '../src/services/apps';

// The gate lives in compose.ts (called by every compose lifecycle path).
// DATA_DIR is read per call, so pointing it at a temp tree gives an end-to-end
// check of the gate without a docker daemon.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leafdock-gate-'));
process.env.DATA_DIR = dataDir;

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function writeApp(name: string, folder: string, compose: string): string {
  const dir = path.join(dataDir, 'apps', ...(folder ? [folder] : []), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose, 'utf-8');
  return dir;
}

test('the deploy gate accepts a compliant app', () => {
  writeApp('good-app', '', 'services:\n  web:\n    image: nginx:alpine\n    ports: ["3000"]\n');
  assert.doesNotThrow(() => assertComposePolicy('good-app', ''));
});

test('the deploy gate blocks the escape that motivated this policy', () => {
  writeApp(
    'escape-app',
    '',
    [
      'services:',
      '  prober:',
      '    image: python:3.12-alpine',
      '    network_mode: host',
      '    pid: host',
      '    cap_add: [NET_ADMIN, NET_RAW]',
      '    volumes: ["/var/run/docker.sock:/var/run/docker.sock", "/:/host"]',
      '',
    ].join('\n')
  );

  assert.throws(
    () => assertComposePolicy('escape-app', ''),
    (err: unknown) => {
      assert.ok(err instanceof ComposePolicyError);
      const joined = err.violations.join('\n');
      // Every door this container used is named in the rejection.
      for (const pattern of [/network_mode/, /PID namespace/, /cap_add/, /docker\.sock/, /host-reserved/]) {
        assert.match(joined, pattern);
      }
      return true;
    }
  );
});

test('the deploy gate reads the file in a subfolder app', () => {
  writeApp('nested', 'blog', 'services:\n  web:\n    image: nginx\n    privileged: true\n');
  assert.throws(() => assertComposePolicy('nested', 'blog'), ComposePolicyError);
});

test('a missing compose file is reported as a policy violation, not a crash', () => {
  fs.mkdirSync(path.join(dataDir, 'apps', 'empty-app'), { recursive: true });
  assert.throws(
    () => assertComposePolicy('empty-app', ''),
    (err: unknown) => {
      assert.ok(err instanceof ComposePolicyError);
      assert.match(err.violations.join(' '), /not found/);
      return true;
    }
  );
});

// GET /api/v1/apps/:name/compose-check → apps.checkCompose, against a real DB row.
test('compose-check audits an app that is already stored', async () => {
  await db.initDb(dataDir);
  writeApp('stored-app', '', 'services:\n  web:\n    image: nginx\n    network_mode: host\n');
  const now = new Date().toISOString();
  db.createApp({
    name: 'stored-app',
    type: 'docker-compose',
    prefix: '/stored-app',
    status: 'running',
    config: JSON.stringify({ services: { web: { port: 80 } } }),
    container_id: null,
    icon: '',
    created_at: now,
    updated_at: now,
  });

  const result = checkCompose('stored-app');
  assert.equal(result.valid, false);
  assert.deepEqual(result.services, ['web']);
  assert.match(result.violations.join('\n'), /network_mode/);
});
