import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  epochSeconds,
  isLauncherApp,
  isSafeId,
  parseChannels,
  parseCustomer,
  parseMessage,
  parseRecording,
  parseReplayEvent,
  parseUi,
  parseVod,
  programTitle,
} from '../src/horizon/parse.js';

test('ids: plain identifiers only, never a prototype name', () => {
  for (const ok of ['3C36E4-EOSSTB-003656000001', 'NL_000001_019401', 'crid:~~2F~~2Fx.y']) {
    assert.ok(isSafeId(ok), ok);
  }
  for (const bad of ['', '__proto__', 'constructor', 'a/b', 'a b', 'x'.repeat(161), 12, null]) {
    assert.ok(!isSafeId(bad), String(bad));
  }
});

test('the customer: boxes, profile language, ids', () => {
  const customer = parseCustomer({
    customerId: 'c-1',
    cityId: 12,
    profiles: [{ profileId: 'p-1', options: { lang: 'fr' } }],
    assignedDevices: [
      { deviceId: 'BOX-1', platformType: 'EOS2', settings: { deviceFriendlyName: ' Salon ' } },
      { deviceId: 'BOX-2' },
      { deviceId: '__proto__' },
      'nope',
    ],
  });
  assert.deepEqual(customer.boxes, [
    { id: 'BOX-1', name: 'Salon', platform: 'EOS2' },
    { id: 'BOX-2', name: 'LG Horizon BOX-2', platform: '' },
  ]);
  assert.deepEqual(
    [customer.customerId, customer.cityId, customer.profileId, customer.lang],
    ['c-1', 12, 'p-1', 'fr'],
  );
  assert.equal(
    parseCustomer({ profiles: [{ profileId: 'p', options: { lang: '../x' } }] }).lang,
    'en',
  );
  assert.equal(parseCustomer('x'), undefined);
});

test('channels, programs, VOD and recordings', () => {
  const channels = parseChannels([
    { id: 'A', name: 'One', logicalChannelNumber: 1 },
    { id: 'B' },
    { id: '__proto__', name: 'x' },
  ]);
  assert.deepEqual([...channels], [['A', { name: 'One', number: 1 }]]);
  assert.equal(epochSeconds(1_700_000_000), 1_700_000_000);
  assert.equal(epochSeconds(1_700_000_000_000), 1_700_000_000, 'milliseconds of older answers');
  assert.equal(epochSeconds('1'), undefined);
  assert.equal(programTitle('News', 'News'), 'News');
  assert.equal(programTitle('Show', 'Ep'), 'Show - Ep');
  assert.equal(programTitle(undefined, 'Ep'), 'Ep');
  assert.deepEqual(parseReplayEvent({ title: 'T', channelId: 'A', endTime: 10 }), {
    title: 'T',
    channelId: 'A',
    end: 10,
  });
  assert.equal(parseVod({ type: 'ASSET', title: 'Movie' }).title, 'Movie');
  assert.equal(parseVod({ type: 'episode', title: 'Pilot', seriesTitle: 'S' }).title, 'S - Pilot');
  assert.equal(parseRecording({ source: 'show', title: 'Whole show' }).title, 'Whole show');
  assert.equal(
    parseRecording({ source: 'single', showTitle: 'S', episodeTitle: 'E' }).title,
    'S - E',
  );
});

test('UI status: player, apps, launcher overlays, unknown', () => {
  assert.deepEqual(
    parseUi({
      uiStatus: 'mainUI',
      playerState: {
        sourceType: 'reviewBuffer',
        speed: 0,
        source: { channelId: 'A', eventId: 'e' },
      },
    }),
    {
      mode: 'player',
      sourceType: 'reviewBuffer',
      speed: 0,
      channelId: 'A',
      eventId: 'e',
      titleId: undefined,
      recordingId: undefined,
    },
  );
  assert.equal(
    parseUi({ uiStatus: 'mainUI', playerState: { sourceType: 'weird' } }).sourceType,
    'unknown',
  );
  assert.deepEqual(parseUi({ uiStatus: 'apps', appsState: { appName: 'Netflix' } }), {
    mode: 'app',
    appName: 'Netflix',
    launcher: false,
  });
  assert.ok(isLauncherApp('BBC Launcher', ''));
  assert.ok(isLauncherApp('X', 'https://cdn/appstore/x.png'));
  assert.ok(!isLauncherApp('', 'appstore'));
  assert.deepEqual(parseUi(null), { mode: 'unknown' });
});

test('MQTT messages: only the household, status by topic, UI status by type', () => {
  assert.deepEqual(
    parseMessage('hh/BOX/status', { source: 'BOX', state: 'online_standby' }, 'hh'),
    {
      kind: 'status',
      source: 'BOX',
      state: 'ONLINE_STANDBY',
    },
  );
  assert.equal(
    parseMessage('hh/BOX/status', { source: 'BOX', state: 'weird' }, 'hh').state,
    'UNKNOWN',
  );
  assert.equal(parseMessage('other/BOX/status', { source: 'BOX', state: 'X' }, 'hh'), undefined);
  assert.equal(parseMessage('hhx/BOX/status', { source: 'BOX' }, 'hh'), undefined);
  assert.equal(
    parseMessage('hh/BOX', { source: '__proto__', type: 'CPE.uiStatus' }, 'hh'),
    undefined,
  );
  assert.equal(parseMessage('hh/BOX', { source: 'BOX', type: 'CPE.capacity' }, 'hh'), undefined);
  assert.equal(parseMessage('hh/BOX', { source: 'BOX', type: 'CPE.uiStatus' }, 'hh').kind, 'ui');
  assert.equal(parseMessage('hh/BOX', [1], 'hh'), undefined);
});
