import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, credentialDigest, normalizeConfig } from '../src/config.js';
import { TIMINGS } from '../src/constants.js';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, MemoryStore, emptyData, newSalt, sanitize } from '../src/store.js';

test('the file store: concurrent writes are queued, the file is never corrupt', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lg-horizon-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore({ dir });
  const saves = [];
  for (let i = 0; i < 25; i += 1) {
    const data = emptyData();
    data.boxes[`BOX-${i}`] = { id: `BOX-${i}`, name: 'x'.repeat(i * 50), platform: '' };
    saves.push(store.save(data));
    if (i % 5 === 0) {
      // Read while writes are queued: always a whole file, never a torn one.
      JSON.parse(await readFile(join(dir, 'lg-horizon.json'), 'utf8').catch(() => '{}'));
    }
  }
  await Promise.all(saves);
  await store.flush();
  assert.deepEqual(Object.keys((await store.load()).boxes), ['BOX-24'], 'the last save wins');
  assert.deepEqual(
    (await readdir(dir)).filter((f) => f.endsWith('.tmp')),
    [],
    'no temporary file left',
  );
});

test('the file store: written atomically, an unreadable file moved aside', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lg-horizon-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore({ dir });
  assert.deepEqual(await store.load(), emptyData());
  const data = emptyData();
  data.boxes.BOX = { id: 'BOX', name: 'Salon', platform: '' };
  await store.save(data);
  assert.deepEqual(Object.keys((await store.load()).boxes), ['BOX']);
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(dir, 'lg-horizon.json'))).mode & 0o777, 0o600);
  }
  await writeFile(join(dir, 'lg-horizon.json'), '{nope');
  const broken = new FileStore({ dir });
  assert.deepEqual(await broken.load(), emptyData());
  assert.equal(broken.corrupted, true);
  assert.equal(await readFile(join(dir, 'lg-horizon.json.bad'), 'utf8'), '{nope');
});

test('configuration: operator, credentials by kind of login, digest', () => {
  const salt = newSalt();
  const ziggo = normalizeConfig({ operator: 'nl', username: ' me ', password: ' pw ' }, salt);
  assert.equal(ziggo.operator.name, 'Ziggo (NL)');
  assert.deepEqual(ziggo.credentials, { username: 'me', password: ' pw ', refreshToken: '' });
  assert.equal(ziggo.ready, true);
  assert.match(ziggo.fingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(
    ziggo.fingerprint,
    normalizeConfig({ operator: 'nl', username: 'me', password: 'pw' }, salt).fingerprint,
  );
  // scrypt with the salt: the same credentials under another salt give another digest.
  assert.equal(
    ziggo.fingerprint,
    credentialDigest('nl', { username: 'me', password: ' pw ', refreshToken: '' }, salt),
  );
  assert.notEqual(
    ziggo.fingerprint,
    normalizeConfig({ operator: 'nl', username: 'me', password: ' pw ' }, newSalt()).fingerprint,
  );
  assert.equal(normalizeConfig({ operator: 'nl' }).fingerprint, undefined, 'no salt, no digest');

  // Refresh-token operators ignore a typed user name and password.
  const telenet = normalizeConfig({ operator: 'be-nl', username: 'me', password: 'pw' });
  assert.deepEqual(telenet.credentials, { refreshToken: '' });
  assert.equal(telenet.ready, false);
  assert.equal(normalizeConfig({ operator: 'be-nl', refresh_token: ' t ' }).ready, true);

  assert.equal(normalizeConfig({ operator: 'nope' }).operatorKey, DEFAULT_CONFIG.operator);
  assert.equal(normalizeConfig({ operator: '__proto__' }).operatorKey, DEFAULT_CONFIG.operator);
  assert.equal(normalizeConfig({ operator: 'nl', username: 'me' }).ready, false);
  assert.equal(normalizeConfig({ language: 'en' }).language, 'en');
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
});

test('saved data: checked field by field, pause bounded, no prototype', () => {
  const now = 1_000_000;
  const fp = 'a'.repeat(64);
  const data = sanitize(
    {
      boxes: {
        BOX: { id: 'BOX', name: 'Salon', platform: 'EOS' },
        OTHER: { id: 'MISMATCH' },
        __proto__: { id: '__proto__' },
      },
      refresh: { fingerprint: fp, token: 'r', expiry: 5 },
      block: { fingerprint: fp, reason: 'weird', at: 3 },
      pause: { until: now + 100 * 3_600_000 },
    },
    now,
  );
  assert.deepEqual(Object.keys(data.boxes), ['BOX']);
  assert.equal(Object.getPrototypeOf(data.boxes), null);
  assert.deepEqual(data.refresh, { fingerprint: fp, token: 'r', expiry: 5 });
  assert.equal(data.block.reason, 'credentials');
  assert.equal(data.pause.until, now + TIMINGS.pauseMax);
  assert.equal(sanitize({ pause: { until: now - 1 } }, now).pause, null);
  assert.equal(sanitize({ block: { fingerprint: 'short' } }, now).block, null);
  assert.deepEqual(sanitize('x'), emptyData());
});

test('the memory store goes through JSON like the file store', async () => {
  const store = new MemoryStore();
  const data = emptyData();
  data.boxes.BOX = { id: 'BOX', name: 'Salon', platform: '' };
  await store.save(data);
  assert.deepEqual(Object.keys((await store.load()).boxes), ['BOX']);
  assert.equal(store.saves, 1);
});
