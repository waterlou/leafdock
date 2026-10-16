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

// The zip-bomb caps were applied on create only; the update path extracted the
// archive unchecked. Behavioural check on the real code path: build an archive
// whose central directory declares an oversized entry and drive both endpoints.
test('both zip extraction paths reject an oversize archive', async () => {
  const AdmZip = (await import('adm-zip')).default;
  const apps = await import('../src/services/apps');

  const big = new AdmZip();
  // Declare a 2GB entry without storing 2GB: adm-zip reads the central
  // directory size field, which is what validateZipEntries bounds.
  big.addFile('huge.bin', Buffer.alloc(1024));
  const entry = big.getEntry('huge.bin');
  entry.header.size = 3 * 1024 * 1024 * 1024;
  const zipPath = path.join(dataDir, 'oversize.zip');
  fs.writeFileSync(zipPath, big.toBuffer());

  await assert.rejects(
    () => apps.createAppFromZip('zipsize-create', 'static', zipPath),
    /Zip entry too large|expands beyond/
  );

  // Same archive via the update endpoint (the path that used to be unguarded).
  const now = new Date().toISOString();
  db.createApp({
    name: 'zipsize-update',
    type: 'static',
    prefix: '/zipsize-update',
    status: 'running',
    config: JSON.stringify({ index: 'index.html', spa: false }),
    container_id: null,
    icon: '',
    created_at: now,
    updated_at: now,
  });
  const zipPath2 = path.join(dataDir, 'oversize2.zip');
  fs.copyFileSync(zipPath, zipPath2);
  await assert.rejects(
    () => apps.updateAppFromZip('zipsize-update', zipPath2),
    /Zip entry too large|expands beyond/
  );
});

// adm-zip's decompression-bomb protection only applies `maxOutputLength` when
// the entry declares a size > 0, so a header forged to size 0 bypassed the cap
// entirely (GHSA-rcw4-f5rp-g42v). Verified: an archive declaring size 0
// inflated tens of MB in this process. Build a valid archive and patch the two
// uncompressed-size fields to 0.
test('rejects a zip entry that declares no uncompressed size but carries data', async () => {
  const AdmZip = (await import('adm-zip')).default;
  const raw = Buffer.alloc(8 * 1024 * 1024, 0x41);
  const built = new AdmZip();
  built.addFile('bomb.bin', raw);
  const buf = built.toBuffer();
  buf.writeUInt32LE(0, 22); // local file header: uncompressed size
  buf.writeUInt32LE(0, buf.readUInt32LE(buf.length - 6) + 24); // central directory
  const forged = path.join(dataDir, 'forged-size.zip');
  fs.writeFileSync(forged, buf);

  const entry = new AdmZip(forged).getEntries()[0];
  assert.equal(entry.header.size, 0, 'fixture should declare size 0');
  assert.ok(entry.header.compressedSize > 0, 'fixture should carry compressed data');

  const apps = await import('../src/services/apps');
  await assert.rejects(
    () => apps.createAppFromZip('forged-size', 'static', forged),
    /declares no uncompressed size/
  );
});

// A running docker/compose app has its own directory mounted read-write, so it
// can plant `ln -s /data/management.db leak`. Caddy's file_server follows such
// links out of its root (verified with a real Caddy), and the API's own file
// reads follow them too.
test('an app directory symlink cannot leak a file outside it', async () => {
  const dir = path.join(dataDir, 'apps', 'linkapp');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), 'app', 'utf-8');
  fs.writeFileSync(path.join(dataDir, 'outside-secret.txt'), 'TOP-SECRET', 'utf-8');
  fs.symlinkSync(path.join(dataDir, 'outside-secret.txt'), path.join(dir, 'leak.txt'));

  const { stripEscapingSymlinks } = await import('../src/services/git');
  stripEscapingSymlinks(dir);
  assert.equal(fs.existsSync(path.join(dir, 'leak.txt')), false, 'escaping symlink should be removed');
  assert.equal(fs.existsSync(path.join(dir, 'index.html')), true, 'real files must survive');
});
