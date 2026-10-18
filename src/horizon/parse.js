// -----------------------------------------------------------------------------
// Pure readers of what the cloud answers and of the MQTT messages of the
// boxes (lghorizon `lghorizon_models.py`, `lghorizon_message_factory.py`).
// Nothing here trusts the shape it receives: unknown or missing fields give
// undefined, never an exception, and no object of the network is merged into
// another (no prototype to pollute).
// -----------------------------------------------------------------------------

import { BOX_STATES, LIMITS } from '../constants.js';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = LIMITS.text) =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined;
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

/** Ids that go into URLs, topics and keys: plain identifiers only, never a prototype name. */
export const isSafeId = (v) =>
  typeof v === 'string' && /^[A-Za-z0-9._:~-]{1,160}$/.test(v) && !RESERVED.has(v);

/** A box as the customer answer lists it (`assignedDevices`). */
export function parseBox(raw) {
  if (!isObject(raw) || !isSafeId(raw.deviceId)) {
    return undefined;
  }
  const settings = isObject(raw.settings) ? raw.settings : {};
  return {
    id: raw.deviceId,
    name: text(settings.deviceFriendlyName, LIMITS.name) ?? `LG Horizon ${raw.deviceId.slice(-6)}`,
    platform: text(raw.platformType, 32) ?? '',
  };
}

/** What the integration keeps of the customer answer. */
export function parseCustomer(json) {
  if (!isObject(json)) {
    return undefined;
  }
  const boxes = (Array.isArray(json.assignedDevices) ? json.assignedDevices : [])
    .map(parseBox)
    .filter(Boolean)
    .slice(0, LIMITS.boxes);
  const profiles = (Array.isArray(json.profiles) ? json.profiles : []).filter(
    (p) => isObject(p) && isSafeId(p.profileId),
  );
  const profile = profiles[0];
  const lang = isObject(profile?.options) ? text(profile.options.lang, 8) : undefined;
  const cityId = finite(json.cityId) ?? (isSafeId(json.cityId) ? json.cityId : undefined);
  return {
    customerId: isSafeId(json.customerId) ? json.customerId : undefined,
    cityId,
    profileId: profile?.profileId,
    lang: lang && /^[a-z]{2}(?:-[A-Za-z]{2})?$/.test(lang) ? lang : 'en',
    boxes,
  };
}

/** The channel list -> Map id -> { name, number }. */
export function parseChannels(list) {
  const channels = new Map();
  for (const raw of Array.isArray(list) ? list.slice(0, LIMITS.channels) : []) {
    if (!isObject(raw) || !isSafeId(raw.id)) {
      continue;
    }
    const name = text(raw.name);
    if (!name) {
      continue;
    }
    const number = finite(raw.logicalChannelNumber) ?? text(raw.logicalChannelNumber, 8);
    channels.set(raw.id, { name, number });
  }
  return channels;
}

/** Seconds since the epoch (the cloud gives seconds, older answers milliseconds). */
export function epochSeconds(v) {
  const n = finite(v);
  if (n === undefined || n <= 0) {
    return undefined;
  }
  return n > 1e12 ? Math.round(n / 1000) : n;
}

/** "Title - Episode" (the episode name only when it says something more). */
export function programTitle(title, episode) {
  const t = text(title);
  const e = text(episode);
  if (!t) {
    return e;
  }
  return e && e !== t ? `${t} - ${e}`.slice(0, LIMITS.text) : t;
}

/** A replay event (linear program): { title, channelId, end }. */
export function parseReplayEvent(json) {
  if (!isObject(json)) {
    return undefined;
  }
  return {
    title: programTitle(json.title, json.episodeName),
    channelId: isSafeId(json.channelId) ? json.channelId : undefined,
    end: epochSeconds(json.endTime),
  };
}

/** A VOD title: the series and the episode, or the movie. */
export function parseVod(json) {
  if (!isObject(json)) {
    return undefined;
  }
  const isEpisode = String(json.type ?? '').toUpperCase() === 'EPISODE';
  return {
    title: isEpisode ? programTitle(json.seriesTitle, json.title) : text(json.title),
  };
}

/** A network recording: { title, channelId }. */
export function parseRecording(json) {
  if (!isObject(json)) {
    return undefined;
  }
  const show = String(json.source ?? '').toLowerCase() === 'show';
  return {
    title: show ? text(json.title) : programTitle(json.showTitle ?? json.title, json.episodeTitle),
    channelId: isSafeId(json.channelId) ? json.channelId : undefined,
  };
}

const SOURCE_TYPES = new Map([
  ['LINEAR', 'linear'],
  ['REVIEWBUFFER', 'reviewBuffer'],
  ['REPLAY', 'replay'],
  ['VOD', 'VOD'],
  ['NDVR', 'nDVR'],
  ['LOCALDVR', 'localDVR'],
]);

/** "Launcher" overlays (BBC launcher...) do not replace what plays (lghorizon). */
export function isLauncherApp(appName, logoPath) {
  const name = String(appName ?? '').toLowerCase();
  if (!name) {
    return false;
  }
  return (
    name.includes('launcher') ||
    String(logoPath ?? '')
      .toLowerCase()
      .includes('appstore')
  );
}

/** The `status` object of a CPE.uiStatus message. */
export function parseUi(status) {
  if (!isObject(status)) {
    return { mode: 'unknown' };
  }
  const uiStatus = String(status.uiStatus ?? '').toLowerCase();
  if (uiStatus === 'apps') {
    const apps = isObject(status.appsState) ? status.appsState : {};
    return {
      mode: 'app',
      appName: text(apps.appName),
      launcher: isLauncherApp(apps.appName, apps.logoPath),
    };
  }
  if (uiStatus === 'mainui' && isObject(status.playerState)) {
    const player = status.playerState;
    const source = isObject(player.source) ? player.source : {};
    const id = (key) => (isSafeId(source[key]) ? source[key] : undefined);
    return {
      mode: 'player',
      sourceType: SOURCE_TYPES.get(String(player.sourceType ?? '').toUpperCase()) ?? 'unknown',
      speed: finite(player.speed),
      channelId: id('channelId'),
      eventId: id('eventId'),
      titleId: id('titleId'),
      recordingId: id('recordingId'),
    };
  }
  return { mode: 'unknown' };
}

/**
 * One MQTT message of the household: `{ kind: 'status', source, state }`,
 * `{ kind: 'ui', source, ui }`, or undefined (anything else). The topic must
 * be the household's own (`<household>` or `<household>/...`).
 */
export function parseMessage(topic, payload, householdId) {
  const t = String(topic ?? '');
  if (t !== householdId && !t.startsWith(`${householdId}/`)) {
    return undefined;
  }
  if (!isObject(payload) || !isSafeId(payload.source)) {
    return undefined;
  }
  // lghorizon: a topic containing "status" carries a running state.
  if (t.includes('status')) {
    const state = String(payload.state ?? '').toUpperCase();
    return {
      kind: 'status',
      source: payload.source,
      state: Object.values(BOX_STATES).includes(state) ? state : BOX_STATES.UNKNOWN,
    };
  }
  if (payload.type === 'CPE.uiStatus') {
    return { kind: 'ui', source: payload.source, ui: parseUi(payload.status) };
  }
  return undefined;
}
