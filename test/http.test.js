import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CookieJar, httpRequest, retryAfterMs } from '../src/horizon/http.js';
import { authError } from '../src/horizon/session.js';
import { HorizonApi } from '../src/horizon/api.js';
import { KINDS } from '../src/horizon/errors.js';

test('Retry-After: seconds or HTTP date', () => {
  assert.equal(retryAfterMs('120'), 120_000);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6_000);
  assert.equal(retryAfterMs('soon'), undefined);
  assert.equal(retryAfterMs(null), undefined);
});

test('the cookie jar: Domain within the host only, HTTPS only, expiry', () => {
  const jar = new CookieJar();
  jar.store('https://spark-prod-nl.gnp.cloud.ziggogo.tv/auth', [
    'ACCESSTOKEN=abc; Path=/; Domain=.ziggogo.tv; Secure; HttpOnly',
    'HOSTONLY=1; Path=/',
    'EVIL=1; Domain=.example.com',
    'TLD=1; Domain=tv',
    'BAD NAME=1',
  ]);
  assert.equal(
    jar.header('https://other.ziggogo.tv/x'),
    'ACCESSTOKEN=abc',
    'the domain cookie only',
  );
  assert.equal(
    jar.header('https://spark-prod-nl.gnp.cloud.ziggogo.tv/y'),
    'ACCESSTOKEN=abc; HOSTONLY=1',
  );
  assert.equal(jar.header('https://ziggogo.tv.evil.com/'), '');
  assert.equal(jar.header('http://other.ziggogo.tv/x'), '', 'never over plain HTTP');
  assert.equal(jar.header('https://a.example.com/', { ACCESSTOKEN: 'x' }), 'ACCESSTOKEN=x');
  jar.store('https://spark-prod-nl.gnp.cloud.ziggogo.tv/auth', [
    'ACCESSTOKEN=; Domain=.ziggogo.tv; Max-Age=0',
  ]);
  assert.ok(!jar.has('ACCESSTOKEN'));
});

const answer = (status, body, headers = {}) => ({
  status,
  body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: new Headers(headers),
});

test('auth errors: refusals are told apart from passing errors', () => {
  const kind = (a) => authError(a).kind;
  assert.equal(kind(answer(400, { error: { statusCode: 97401 } })), KINDS.REFUSED);
  assert.equal(authError(answer(400, { error: { statusCode: 97402 } })).reason, 'token');
  assert.equal(kind(answer(401, { error: { statusCode: 1, message: 'x' } })), KINDS.REFUSED);
  assert.equal(kind(answer(403, '<html>CloudFront</html>')), KINDS.UNAVAILABLE);
  assert.equal(kind(answer(503, {})), KINDS.UNAVAILABLE);
  const limited = authError(answer(429, {}, { 'retry-after': '30' }));
  assert.equal(limited.kind, KINDS.RATE_LIMITED);
  assert.equal(limited.retryAfterMs, 30_000);
  assert.equal(kind(answer(404, 'nope')), KINDS.HTTP);
});

test('HTTP: a capped answer, a timeout, a network error', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/big') {
      res.end('x'.repeat(5000));
    } else if (req.url === '/slow') {
      setTimeout(() => res.end('{}'), 500);
    } else {
      res.setHeader('set-cookie', ['A=1; Path=/']);
      res.end('{"ok":true}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ok = await httpRequest(`${base}/`, { maxBytes: 100 });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.setCookies, ['A=1; Path=/']);
  await assert.rejects(httpRequest(`${base}/big`, { maxBytes: 100 }), { kind: KINDS.BAD_RESPONSE });
  await assert.rejects(httpRequest(`${base}/slow`, { timeoutMs: 50 }), { kind: KINDS.TIMEOUT });
  await assert.rejects(httpRequest('http://127.0.0.1:1/', { timeoutMs: 2000 }), {
    kind: KINDS.NETWORK,
  });
});

test('API: service URLs must be HTTPS (WSS for the broker), paused calls are not sent', async () => {
  const sent = [];
  const session = {
    accessToken: 'a',
    householdId: 'hh',
    ensure: async () => {},
    cookieHeader: () => '',
  };
  const services = {
    linearService: { URL: 'http://plain.example/linear' },
    mqttBroker: { URL: 'https://not-a-socket.example/mqtt' },
    personalizationService: { URL: 'https://user:pw@x.example/p' },
  };
  let paused = 0;
  const api = new HorizonApi({
    operator: { apiUrl: 'https://api.example', country: 'nl' },
    session,
    pausedUntil: () => paused,
    now: () => 1000,
    request: async (url) => {
      sent.push(url);
      return answer(200, services);
    },
  });
  await assert.rejects(api.channels(1, 'nl'), { kind: KINDS.BAD_RESPONSE });
  await assert.rejects(api.mqttBrokerUrl(), { kind: KINDS.BAD_RESPONSE });
  await assert.rejects(api.customer(), { kind: KINDS.BAD_RESPONSE });
  assert.deepEqual(sent, ['https://api.example/nl/en/config-service/conf/web/backoffice.json']);
  api.services = undefined;
  paused = 5000;
  await assert.rejects(api.serviceConfig(), { kind: KINDS.PAUSED });
  assert.equal(sent.length, 1);
});
