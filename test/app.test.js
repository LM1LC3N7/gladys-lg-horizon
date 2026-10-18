// -----------------------------------------------------------------------------
// HorizonApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a memory store, a fake operator cloud behind `fetch`, a
// fake MQTT broker and a clock the tests move by hand. No network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HorizonApp } from '../src/app.js';
import { normalizeConfig } from '../src/config.js';
import { NOTHING, OPERATORS, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore, emptyData } from '../src/store.js';
import { fakeBroker } from './helpers/fakeBroker.js';
import { fakeClock } from './helpers/fakeClock.js';
import { BOX, HOUSEHOLD, fakeCloud } from './helpers/fakeCloud.js';

const SELECTOR = 'lg-horizon';
const ZIGGO = { operator: 'nl', username: 'me@example.com', password: 'secret pw' };
const TELENET = { operator: 'be-nl', refresh_token: 'typed-refresh' };
const id = (key, box = BOX) => `ext:${SELECTOR}:box:${box}${key ? `:${key}` : ''}`;

async function setup(
  t,
  { config = ZIGGO, store = new MemoryStore(), clock = fakeClock(), cloud, broker, before } = {},
) {
  const operator = OPERATORS[config.operator];
  cloud ??= fakeCloud({ operator, now: clock.now });
  broker ??= fakeBroker();
  const gladys = createFakeGladys({ selector: SELECTOR, config });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const app = new HorizonApp({
    gladys,
    logger,
    store,
    fetchImpl: cloud.fetch,
    connect: broker.connect,
    now: clock.now,
    timers: clock.timers,
  });
  registerHandlers(gladys, app, logger);
  before?.({ gladys, app, cloud, broker });
  await gladys.connect();
  await clock.settle();
  t.after(() => app.stop());
  return { gladys, app, cloud, broker, clock, store, logs };
}

async function createBox(gladys, clock, box = BOX) {
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id === id(undefined, box));
  assert.ok(device, 'the box is in the Discovery tab');
  await gladys.fake.deviceCreated(device);
  await clock.settle();
  return device;
}

const press = (gladys, device, key) =>
  gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id === id(key)),
    1,
  );

const status = (broker, state, box = BOX) =>
  broker.deliver(`${HOUSEHOLD}/${box}/status`, { source: box, state });

const ui = (broker, playerState, box = BOX) =>
  broker.deliver(`${HOUSEHOLD}/client`, {
    source: box,
    type: 'CPE.uiStatus',
    status: { uiStatus: 'mainUI', playerState },
  });

const LINEAR = {
  sourceType: 'linear',
  speed: 1,
  source: { channelId: 'NL_000001_019401', eventId: 'crid:~~2F~~2Fevent-1' },
};

/** A created box, running and showing NPO 1. */
async function running(t, options) {
  const env = await setup(t, options);
  const device = await createBox(env.gladys, env.clock);
  status(env.broker, 'ONLINE_RUNNING');
  await env.clock.settle();
  ui(env.broker, LINEAR);
  await env.clock.settle();
  return { ...env, device };
}

test('Ziggo: login, the box in Discovery, the live link, states once created', async (t) => {
  const { gladys, cloud, broker, clock, store } = await setup(t);
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.external_id, id());
  assert.equal(device.name, 'Living room');
  const keys = device.features.map((f) => f.external_id.slice(id().length + 1));
  assert.deepEqual(keys, [
    'power',
    'online',
    'wake',
    'standby',
    'play',
    'pause',
    'channel_up',
    'channel_down',
    'channel',
    'program',
    'playback',
  ]);
  const byKey = Object.fromEntries(device.features.map((f) => [f.external_id.split(':').pop(), f]));
  // No switch: nothing an "everything off" could command; the power is read only.
  assert.ok(device.features.every((f) => f.category !== 'switch'));
  assert.deepEqual(
    [byKey.power.category, byKey.power.type, byKey.power.read_only],
    ['unknown', 'binary', true],
  );
  assert.deepEqual([byKey.standby.category, byKey.standby.type], ['button', 'push']);
  assert.deepEqual([byKey.wake.category, byKey.wake.type], ['button', 'push']);
  assert.deepEqual(
    [byKey.channel_up.category, byKey.channel_up.type],
    ['television', 'channel-up'],
  );
  assert.equal(byKey.channel.name, 'Chaîne', 'French names by default');
  assert.ok(device.features.every((f) => f.unit === undefined));

  // The login: user name and password once, then the cookie on every call.
  const login = cloud.requests.find((r) => r.url.endsWith('/auth-service/v1/authorization'));
  assert.deepEqual(login.body, { username: 'me@example.com', password: 'secret pw' });
  assert.equal(login.headers['x-device-code'], 'web');
  const customer = cloud.requests.find((r) => r.url.includes('/v1/customer/'));
  assert.equal(customer.headers.cookie, 'ACCESSTOKEN=access-1');
  assert.ok(
    cloud.requests.every((r) => !String(r.headers.cookie ?? '').includes('tracking')),
    'a cookie for another domain is never kept',
  );

  // The live link: household id and MQTT token, the household topics.
  const [connection] = broker.connections;
  assert.equal(connection.url, 'wss://obomsg.prod.example.horizon.tv/mqtt');
  assert.equal(connection.options.username, HOUSEHOLD);
  assert.equal(connection.options.password, 'mqtt-1');
  assert.equal(connection.options.reconnectPeriod, 0);
  assert.ok(connection.subscriptions.includes(`${HOUSEHOLD}/+/status`));
  assert.ok(connection.subscriptions.every((s) => s.startsWith(HOUSEHOLD)));
  assert.ok(
    broker.published.some(
      (p) => p.payload.type === 'CPE.getUiStatus' && p.topic === `${HOUSEHOLD}/${BOX}`,
    ),
  );
  assert.equal(gladys.fake.connectionStatus.connected, true);

  // The rotated refresh token is kept in /data, never the password.
  assert.equal(store.data.refresh.token, 'refresh-1');
  assert.equal(store.data.refresh.fingerprint, normalizeConfig(ZIGGO, store.data.salt).fingerprint);
  assert.match(store.data.salt, /^[0-9a-f]{32}$/);
  assert.equal(connection.options.wsOptions.maxPayload, 256 * 1024);
  assert.ok(!JSON.stringify(store.data).includes('secret pw'));

  assert.equal(gladys.fake.states.length, 0, 'no state before the device is created');
  await createBox(gladys, clock);
  status(broker, 'ONLINE_RUNNING');
  await clock.settle();
  assert.equal(gladys.fake.lastState(id('power')), 1);
  assert.equal(gladys.fake.lastState(id('online')), 1);
  ui(broker, LINEAR);
  await clock.settle();
  assert.equal(gladys.fake.lastState(id('channel')), 'NPO 1');
  assert.equal(gladys.fake.lastState(id('program')), 'Journaal - 20:00');
  assert.equal(gladys.fake.lastState(id('playback')), 1);

  // Standby: the texts are cleared.
  status(broker, 'ONLINE_STANDBY');
  await clock.settle();
  assert.equal(gladys.fake.lastState(id('power')), 0);
  assert.equal(gladys.fake.lastState(id('online')), 1);
  assert.equal(gladys.fake.lastState(id('channel')), NOTHING);
  assert.equal(gladys.fake.lastState(id('playback')), 0);
  status(broker, 'OFFLINE');
  await clock.settle();
  assert.equal(gladys.fake.lastState(id('online')), 0);
});

test('a program lookup that fails never blocks the channel', async (t) => {
  const { gladys, cloud, broker, clock } = await running(t);
  cloud.failures.set('/v2/replayEvent/', 500);
  ui(broker, {
    sourceType: 'linear',
    speed: 0,
    source: { channelId: 'NL_000002_019402', eventId: 'crid:~~2F~~2Fother' },
  });
  await clock.settle();
  assert.equal(gladys.fake.lastState(id('channel')), 'NPO 2');
  assert.equal(gladys.fake.lastState(id('program')), NOTHING);
  assert.equal(gladys.fake.lastState(id('playback')), 0);
});

test('apps, VOD and recordings are described; a launcher overlay keeps the channel', async (t) => {
  const { gladys, broker, clock } = await running(t);
  broker.deliver(`${HOUSEHOLD}/x`, {
    source: BOX,
    type: 'CPE.uiStatus',
    status: { uiStatus: 'apps', appsState: { appName: 'BBC Launcher', logoPath: '' } },
  });
  await clock.settle();
  assert.equal(gladys.fake.lastState(id('channel')), 'NPO 1');
  broker.deliver(`${HOUSEHOLD}/x`, {
    source: BOX,
    type: 'CPE.uiStatus',
    status: { uiStatus: 'apps', appsState: { appName: 'Netflix' } },
  });
  await clock.settle();
  assert.equal(gladys.fake.lastState(id('program')), 'Netflix');
  assert.equal(gladys.fake.lastState(id('channel')), NOTHING);
  ui(broker, { sourceType: 'VOD', speed: 1, source: { titleId: 'vod-1' } });
  await clock.settle();
  assert.equal(gladys.fake.lastState(id('program')), 'Series - Pilot');
  ui(broker, { sourceType: 'nDVR', speed: 1, source: { recordingId: 'rec-1' } });
  await clock.settle();
  assert.equal(gladys.fake.lastState(id('program')), 'Show - Episode 1');
  assert.equal(gladys.fake.lastState(id('channel')), 'NPO 2');
});

test('standby and wake-up: the power key only toward the other state, guarded', async (t) => {
  const { gladys, broker, clock, device } = await running(t);
  // Already running: nothing to send.
  assert.equal((await press(gladys, device, 'wake')).success, true);
  assert.deepEqual(broker.keys(), []);

  assert.equal((await press(gladys, device, 'standby')).success, true);
  assert.deepEqual(broker.keys(), [[`${HOUSEHOLD}/${BOX}`, 'Power']]);
  const key = broker.published.find((p) => p.payload.type === 'CPE.KeyEvent');
  assert.equal(key.options.qos, 2);
  assert.equal(key.payload.source, BOX.toLowerCase());
  assert.equal(key.payload.status.eventType, 'keyDownUp');

  // Until the box reports the expected state, another power key is refused.
  const busy = await press(gladys, device, 'wake');
  assert.equal(busy.success, false);
  assert.match(busy.error, /already under way/);
  status(broker, 'ONLINE_RUNNING'); // the state of departure does not end the guard
  await clock.settle();
  assert.equal((await press(gladys, device, 'standby')).success, false);
  status(broker, 'UNKNOWN'); // nor an unknown one
  await clock.settle();
  status(broker, 'ONLINE_STANDBY');
  await clock.settle();
  assert.equal((await press(gladys, device, 'wake')).success, true);
  assert.deepEqual(
    broker.keys().map(([, k]) => k),
    ['Power', 'Power'],
  );

  // Without the expected state, the guard ends after its time.
  await clock.advance(TIMINGS.powerGuard + 1);
  status(broker, 'ONLINE_STANDBY');
  await clock.settle();
  assert.equal((await press(gladys, device, 'wake')).success, true);
  assert.equal(broker.keys().length, 3);
});

test('play and pause follow the playback state; channel keys need a running box', async (t) => {
  const { gladys, broker, clock, device } = await running(t);
  assert.equal((await press(gladys, device, 'play')).success, true, 'already playing');
  assert.deepEqual(broker.keys(), []);
  assert.equal((await press(gladys, device, 'pause')).success, true);
  assert.deepEqual(
    broker.keys().map(([, k]) => k),
    ['MediaPlayPause'],
  );
  assert.equal((await press(gladys, device, 'play')).success, false, 'guarded');
  ui(broker, { ...LINEAR, speed: 0 });
  await clock.settle();
  assert.equal((await press(gladys, device, 'play')).success, true);
  assert.equal((await press(gladys, device, 'channel_up')).success, true);
  assert.equal((await press(gladys, device, 'channel_down')).success, true);
  assert.deepEqual(
    broker.keys().map(([, k]) => k),
    ['MediaPlayPause', 'MediaPlayPause', 'ChannelUp', 'ChannelDown'],
  );

  status(broker, 'ONLINE_STANDBY');
  await clock.settle();
  const refused = await press(gladys, device, 'channel_up');
  assert.equal(refused.success, false);
  assert.match(refused.error, /not running/);
  assert.equal(broker.keys().length, 4, 'nothing sent');
});

test('no command on a state the live link no longer follows', async (t) => {
  const { gladys, broker, clock, device } = await running(t);
  broker.current().drop();
  await clock.settle();
  const down = await press(gladys, device, 'standby');
  assert.equal(down.success, false);
  assert.match(down.error, /nothing sent/);
  // Back up: until the box reports again, its state is unknown.
  await clock.advance(TIMINGS.mqttBackoff[0]);
  assert.ok(broker.current());
  const unknown = await press(gladys, device, 'standby');
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /unknown/);
  assert.deepEqual(broker.keys(), []);
  status(broker, 'ONLINE_RUNNING');
  await clock.settle();
  assert.equal((await press(gladys, device, 'standby')).success, true);
});

test('the ack of a command never waits for Gladys; an unconfirmed key is said so', async (t) => {
  const { gladys, broker, device } = await running(t);
  gladys.publishChangedStates = () => new Promise(() => {});
  assert.equal((await press(gladys, device, 'channel_up')).success, true);
  broker.ackPublishes = false;
  const started = Date.now();
  const answer = await press(gladys, device, 'channel_down');
  assert.equal(answer.success, false);
  assert.match(answer.error, /without confirmation/);
  assert.ok(Date.now() - started < 4_500, 'within the 5 s Gladys waits');
});

test('read-only features and unknown devices are refused', async (t) => {
  const { gladys, device } = await running(t);
  const answer = await press(gladys, device, 'power');
  assert.equal(answer.success, false);
  assert.match(answer.error, /cannot be commanded/);
});

test('refused credentials: stop kept in /data, no automatic retry, Reconnect tries once', async (t) => {
  const clock = fakeClock();
  const cloud = fakeCloud({ now: clock.now });
  cloud.auth = 'credentials';
  const store = new MemoryStore();
  const { gladys, app, broker } = await setup(t, { clock, cloud, store });
  assert.equal(cloud.authCount(), 1);
  assert.equal(store.data.block.reason, 'credentials');
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /ne réessaie pas tout seul/);
  assert.equal(broker.connections.length, 0);

  await clock.advance(48 * 3_600_000);
  assert.equal(cloud.authCount(), 1, 'never tried again by itself');

  // A reconnection to Gladys keeps the stop.
  await gladys.disconnect();
  await gladys.connect();
  await clock.settle();
  assert.equal(cloud.authCount(), 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);

  // A restart of the container keeps it too.
  await app.stop();
  const again = await setup(t, { clock, cloud, store });
  assert.equal(cloud.authCount(), 1);
  assert.match(again.gladys.fake.connectionStatus.message.en, /refused/);

  // Saving the same credentials (another field changed) does not retry.
  await again.gladys.fake.configUpdated({ ...ZIGGO, language: 'en' });
  await clock.settle();
  assert.equal(cloud.authCount(), 1);

  // The button: one attempt.
  const refusedAgain = await again.gladys.fake.action('reconnect');
  assert.equal(cloud.authCount(), 2);
  assert.match(refusedAgain.data.message.en, /still refuses/);
  cloud.auth = 'ok';
  await clock.advance(3_600_000);
  assert.equal(cloud.authCount(), 2);
  const ok = await again.gladys.fake.action('reconnect');
  assert.equal(cloud.authCount(), 3);
  assert.equal(store.data.block, null);
  assert.match(ok.data.message.en, /Connected|live link/);
});

test('new credentials end the stop at once', async (t) => {
  const clock = fakeClock();
  const cloud = fakeCloud({ now: clock.now });
  cloud.auth = 'credentials';
  const { gladys, store } = await setup(t, { clock, cloud });
  assert.ok(store.data.block);
  cloud.auth = 'ok';
  await gladys.fake.configUpdated({ ...ZIGGO, password: 'secret pw', username: 'me@example.com ' });
  await clock.settle();
  // Same values once trimmed: same digest, still stopped.
  assert.equal(cloud.authCount(), 1);
  await gladys.fake.configUpdated({ ...ZIGGO, password: 'other' });
  await clock.settle();
  assert.equal(cloud.authCount(), 2, 'other credentials: tried at once');
});

test('Telenet: refresh token only; the rotated token is used after a restart; refusal stops', async (t) => {
  const clock = fakeClock();
  const cloud = fakeCloud({ operator: OPERATORS['be-nl'], now: clock.now });
  const store = new MemoryStore();
  const first = await setup(t, { config: TELENET, clock, cloud, store });
  const refresh = cloud.requests.filter((r) => r.url.endsWith('/authorization/refresh'));
  assert.deepEqual(
    refresh.map((r) => r.body),
    [{ refreshToken: 'typed-refresh' }],
  );
  assert.equal(store.data.refresh.token, 'refresh-1');
  assert.equal(first.gladys.fake.connectionStatus.connected, true);

  await first.app.stop();
  await setup(t, { config: TELENET, clock, cloud, store });
  const after = cloud.requests.filter((r) => r.url.endsWith('/authorization/refresh'));
  assert.equal(after.at(-1).body.refreshToken, 'refresh-1', 'the newest token, not the typed one');

  // The renewal timer: about one day before the refresh token expires (12 h at most).
  cloud.validRefresh = new Set();
  await clock.advance(TIMINGS.renewMax);
  assert.equal(store.data.block.reason, 'token');
  const count = cloud.authCount();
  await clock.advance(7 * 86_400_000);
  assert.equal(cloud.authCount(), count, 'no loop on a refused refresh token');
});

test('429: a pause kept in /data and read back bounded, applied to every path', async (t) => {
  const clock = fakeClock();
  const cloud = fakeCloud({ now: clock.now });
  cloud.auth = 'rate';
  cloud.retryAfter = 600;
  const store = new MemoryStore();
  const { gladys, app } = await setup(t, { clock, cloud, store });
  assert.equal(store.data.pause.until, clock.now() + 600_000);
  assert.match(gladys.fake.connectionStatus.message.en, /429/);
  await clock.advance(599_000);
  assert.equal(cloud.authCount(), 1, 'nothing during the pause');

  // A restart during the pause waits too; a saved end beyond 6 h is bounded.
  await app.stop();
  store.data.pause.until = clock.now() + 100 * 3_600_000;
  const again = await setup(t, { clock, cloud, store });
  assert.equal(cloud.authCount(), 1);
  cloud.auth = 'ok';
  await clock.advance(TIMINGS.pauseMax - 1_000);
  assert.equal(cloud.authCount(), 1);
  await clock.advance(2_000);
  assert.equal(cloud.authCount(), 2);
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
});

test('a 429 of the API pauses the live link and the lookups as well', async (t) => {
  const { cloud, broker, clock, store } = await running(t);
  cloud.failures.set('/v1/mqtt/token', 429);
  cloud.retryAfter = 120;
  broker.current().drop();
  await clock.advance(TIMINGS.mqttBackoff[0]);
  assert.ok(store.data.pause.until > clock.now());
  const tokens = cloud.count('/v1/mqtt/token');
  await clock.advance(60_000);
  assert.equal(cloud.count('/v1/mqtt/token'), tokens, 'nothing before the end of the pause');
  cloud.failures.clear();
  await clock.advance(TIMINGS.mqttBackoff[1] + 120_000);
  assert.ok(broker.current()?.options.password);
});

test('a cloud that does not answer: tried again with growing delays, never dead', async (t) => {
  const clock = fakeClock();
  const cloud = fakeCloud({ now: clock.now });
  cloud.auth = 'down';
  const { gladys } = await setup(t, { clock, cloud });
  assert.equal(cloud.authCount(), 1);
  assert.match(gladys.fake.connectionStatus.message.en, /next try in 1 min/);
  await clock.advance(59_000);
  assert.equal(cloud.authCount(), 1);
  await clock.advance(1_000);
  assert.equal(cloud.authCount(), 2);
  await clock.advance(TIMINGS.startRetry[1]);
  assert.equal(cloud.authCount(), 3);
  // A 403 from something in between is a passing error too, not a refusal.
  cloud.auth = 'cloudfront';
  await clock.advance(TIMINGS.startRetry[2]);
  assert.equal(cloud.authCount(), 4);
  cloud.auth = 'ok';
  await clock.advance(TIMINGS.startRetry[3]);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('an API call answered 401: one renewal, then the call again', async (t) => {
  const { app, cloud, clock } = await running(t);
  cloud.accessToken = 'revoked';
  cloud.validRefresh = new Set(['refresh-1']);
  const before = cloud.authCount();
  await app.refreshAccount();
  await clock.settle();
  assert.equal(cloud.authCount(), before + 1);
  assert.equal(cloud.requests.at(-1).headers.cookie, 'ACCESSTOKEN=access-2');
});

test('a socket that opens then drops at once never loops', async (t) => {
  const { broker, clock } = await setup(t);
  const opened = () => broker.connections.length;
  assert.equal(opened(), 1);
  const times = [];
  for (let i = 0; i < 6; i += 1) {
    broker.current()?.drop();
    const before = opened();
    const start = clock.now();
    while (opened() === before) {
      await clock.advance(1_000);
    }
    times.push(clock.now() - start);
  }
  assert.deepEqual(
    times,
    TIMINGS.mqttBackoff.map((ms) => ms),
  );
  // A connection that stayed up long enough brings the delays back to the shortest.
  await clock.advance(TIMINGS.mqttStable);
  broker.current().drop();
  const before = opened();
  await clock.advance(TIMINGS.mqttBackoff[0]);
  assert.equal(opened(), before + 1);
});

test('MQTT subscription refused: the link is closed and tried again later', async (t) => {
  const clock = fakeClock();
  const broker = fakeBroker();
  broker.refuseStatus = true;
  const { gladys } = await setup(t, { clock, broker });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /live link .*down/);
  const count = broker.connections.length;
  await clock.advance(TIMINGS.mqttBackoff[0] - 1_000);
  assert.equal(broker.connections.length, count);
});

test('each reconnection to Gladys publishes the status and Discovery again, keeps the session', async (t) => {
  const { gladys, cloud, clock } = await running(t);
  const statuses = gladys.fake.connectionStatuses.length;
  const discoveries = gladys.fake.requests.filter((r) => r.path.includes('discover')).length;
  const auth = cloud.authCount();
  await gladys.disconnect();
  await gladys.connect();
  await clock.settle();
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.ok(gladys.fake.requests.filter((r) => r.path.includes('discover')).length > discoveries);
  assert.equal(cloud.authCount(), auth, 'no new login');
  assert.equal(gladys.fake.lastState(id('channel')), 'NPO 1');
});

test('a device published again never loses a feature of the created one', async (t) => {
  const { gladys, app } = await running(t);
  const created = gladys.devices.find((d) => d.external_id === id());
  assert.ok(created, 'the SDK keeps the created device');
  created.features.push({
    name: 'Old feature',
    external_id: id('old'),
    category: 'text',
    type: 'text',
    min: 0,
    max: 0,
    read_only: true,
    has_feedback: false,
    keep_history: false,
  });
  await app.publishDevices();
  const device = gladys.fake.discoveredDevices.find((d) => d.external_id === id());
  assert.ok(device.features.some((f) => f.external_id === id('old')));
});

test('untrusted ids never become keys (no prototype pollution)', async (t) => {
  const clock = fakeClock();
  const cloud = fakeCloud({ now: clock.now });
  cloud.customer.assignedDevices.push(
    { deviceId: '__proto__', settings: { deviceFriendlyName: 'x' } },
    { deviceId: 'a/b', settings: {} },
  );
  const { gladys, app, broker, store } = await setup(t, { clock, cloud });
  assert.deepEqual([...new Set(gladys.fake.discoveredDevices.map((d) => d.external_id))], [id()]);
  await clock.advance(TIMINGS.persistDelay);
  assert.deepEqual(Object.keys(store.data.boxes), [BOX]);
  broker.deliver(`${HOUSEHOLD}/__proto__/status`, { source: '__proto__', state: 'ONLINE_RUNNING' });
  broker.deliver(`other-household/${BOX}/status`, { source: BOX, state: 'ONLINE_RUNNING' });
  await clock.settle();
  assert.equal({}.state, undefined);
  assert.equal(Object.getPrototypeOf(app.data.boxes), null);
  assert.equal(app.views.get(BOX)?.state ?? 'UNKNOWN', 'UNKNOWN', 'another household is ignored');
});

test('a saved box list fills Discovery while the cloud is down', async (t) => {
  const clock = fakeClock();
  const cloud = fakeCloud({ now: clock.now });
  cloud.auth = 'down';
  const data = emptyData();
  data.boxes[BOX] = { id: BOX, name: 'Living room', platform: 'EOS' };
  const { gladys } = await setup(t, { clock, cloud, store: new MemoryStore(data) });
  assert.equal(gladys.fake.discoveredDevices[0]?.external_id, id());
});

test('missing credentials: a clear status, nothing sent', async (t) => {
  const { gladys, cloud } = await setup(t, { config: { operator: 'ch' } });
  assert.equal(cloud.requests.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /Sunrise/);
});

test('A: after the live link drops, play/pause waits for a new UI status', async (t) => {
  const { gladys, broker, clock, device } = await running(t);
  broker.current().drop();
  await clock.advance(TIMINGS.mqttBackoff[0]);
  status(broker, 'ONLINE_RUNNING');
  await clock.settle();
  const refused = await press(gladys, device, 'pause');
  assert.equal(refused.success, false);
  assert.match(refused.error, /Playback state unknown/);
  assert.deepEqual(broker.keys(), []);
  ui(broker, LINEAR);
  await clock.settle();
  assert.equal((await press(gladys, device, 'pause')).success, true);
  assert.deepEqual(
    broker.keys().map(([, k]) => k),
    ['MediaPlayPause'],
  );
});

test('B: the playback state and its guard follow a UI status before its lookup ends', async (t) => {
  const { gladys, cloud, broker, clock, device } = await running(t);
  assert.equal((await press(gladys, device, 'pause')).success, true);
  const release = cloud.hold('/v2/replayEvent/');
  t.after(release);
  ui(broker, { ...LINEAR, speed: 0, source: { ...LINEAR.source, eventId: 'crid:held' } });
  await clock.settle();
  assert.equal(gladys.fake.lastState(id('playback')), 0, 'published before the lookup');
  // The guard ended on the expected state; the new state is known: play goes out.
  assert.equal((await press(gladys, device, 'play')).success, true);
  assert.deepEqual(
    broker.keys().map(([, k]) => k),
    ['MediaPlayPause', 'MediaPlayPause'],
  );
  release();
  await clock.settle();
});

test('C: a refresh token received during a reconnection is kept and used', async (t) => {
  const clock = fakeClock();
  const cloud = fakeCloud({ operator: OPERATORS['be-nl'], now: clock.now });
  const store = new MemoryStore();
  const { gladys } = await setup(t, { config: TELENET, clock, cloud, store });
  assert.equal(store.data.refresh.token, 'refresh-1');
  const release = cloud.hold('/authorization/refresh');
  t.after(release);
  await clock.advance(TIMINGS.renewMax); // the renewal timer: its request is held
  const action = gladys.fake.action('reconnect');
  await clock.settle();
  release();
  const answer = await action;
  await clock.settle();
  assert.equal(answer.success, true);
  assert.equal(store.data.block, null, 'never refused');
  const refresh = cloud.requests.filter((r) => r.url.endsWith('/authorization/refresh'));
  assert.deepEqual(
    refresh.map((r) => r.body.refreshToken),
    ['typed-refresh', 'refresh-1', 'refresh-2'],
    'the new session starts from the token the old one received',
  );
  assert.equal(store.data.refresh.token, 'refresh-3');
});

test('D: stop waits for the writes in flight', async (t) => {
  const { app } = await setup(t);
  let flushed = false;
  app.store.flush = () =>
    new Promise((resolve) =>
      setImmediate(() => {
        flushed = true;
        resolve();
      }),
    );
  await app.stop();
  assert.equal(flushed, true);
});

test('E: a 429 of a renewal after a 401 pauses everything', async (t) => {
  const { app, cloud, clock, store } = await running(t);
  cloud.accessToken = 'revoked';
  cloud.auth = 'rate';
  cloud.retryAfter = 300;
  await app.refreshAccount();
  await clock.settle();
  assert.equal(store.data.pause.until, clock.now() + 300_000);
});

test('a 401 that a renewal does not end: renewals spaced 1 min, 15 min, then 1 h', async (t) => {
  const { app, cloud, clock } = await running(t);
  cloud.failures.set('/v1/customer/', 401);
  const renewals = () => cloud.count('/authorization/refresh');
  const tryOnce = async () => {
    await app.refreshAccount();
    await clock.settle();
  };
  const base = renewals();
  await tryOnce();
  assert.equal(renewals(), base + 1);
  await clock.advance(2 * 60_000);
  await tryOnce();
  assert.equal(renewals(), base + 1, 'not after 2 minutes: 15 now');
  await clock.advance(15 * 60_000);
  await tryOnce();
  assert.equal(renewals(), base + 2);
  await clock.advance(16 * 60_000);
  await tryOnce();
  assert.equal(renewals(), base + 2, 'one hour now');
  await clock.advance(60 * 60_000);
  await tryOnce();
  assert.equal(renewals(), base + 3);
});

test('any refusal of the refresh endpoint is a refusal of the token', async (t) => {
  const clock = fakeClock();
  const cloud = fakeCloud({ operator: OPERATORS['be-nl'], now: clock.now });
  cloud.auth = 'credentials';
  const { store, gladys } = await setup(t, { config: TELENET, clock, cloud });
  assert.equal(store.data.block.reason, 'token');
  assert.match(gladys.fake.connectionStatus.message.en, /refresh token/);
});

test('a broker that never answers the subscription: closed, tried again later', async (t) => {
  const clock = fakeClock();
  const broker = fakeBroker();
  broker.silentSubscribe = true;
  await setup(t, { clock, broker });
  const [first] = broker.connections;
  assert.equal(first.ended, false);
  await clock.advance(TIMINGS.mqttConnectTimeout);
  assert.equal(first.ended, true);
  await clock.advance(TIMINGS.mqttBackoff[0]);
  assert.equal(broker.connections.length, 2);
});

test('lookups: a failure is not asked again for 10 min; one lookup at a time per box', async (t) => {
  const { cloud, broker, clock, gladys } = await running(t);
  cloud.failures.set('/v2/replayEvent/', 500);
  const asked = () => cloud.count('/v2/replayEvent/');
  const other = { ...LINEAR, source: { ...LINEAR.source, eventId: 'crid:missing' } };
  const before = asked();
  ui(broker, other);
  await clock.settle();
  ui(broker, other);
  await clock.settle();
  assert.equal(asked(), before + 1);
  await clock.advance(TIMINGS.lookupRetry);
  ui(broker, other);
  await clock.settle();
  assert.equal(asked(), before + 2);

  cloud.failures.clear();
  const release = cloud.hold('/v2/replayEvent/');
  t.after(release);
  const burst = (n) =>
    ui(broker, { ...LINEAR, source: { ...LINEAR.source, eventId: `crid:burst-${n}` } });
  burst(1);
  await clock.settle();
  burst(2);
  burst(3);
  await clock.settle();
  assert.equal(asked(), before + 3, 'one in flight');
  release();
  await clock.settle(200);
  const urls = cloud.requests.filter((r) => r.url.includes('crid%3Aburst')).map((r) => r.url);
  assert.equal(urls.length, 2, 'the middle one is skipped');
  assert.ok(urls[1].includes('burst-3'));
  assert.equal(gladys.fake.lastState(id('channel')), 'NPO 1');
});

test('the live link removes only its own listeners', async (t) => {
  const { app, broker, clock } = await setup(t);
  const client = broker.current();
  const foreign = () => {};
  client.on('message', foreign);
  client.on('close', foreign);
  app.live.stop();
  await clock.settle();
  assert.deepEqual(client.listeners('message'), [foreign]);
  assert.deepEqual(client.listeners('close'), [foreign]);
});
