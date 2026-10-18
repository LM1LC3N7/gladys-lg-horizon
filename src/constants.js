// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions), the operators, the
// remote keys, limits and timings. Every key here is stored by Gladys or by
// its users: never rename one.
// -----------------------------------------------------------------------------

/** `gladys.externalIds(DEVICE_TYPE, <deviceId of the set-top box>)`. */
export const DEVICE_TYPE = 'box';

export const FEATURES = Object.freeze({
  /** Read only: 1 running, 0 standby (or offline). */
  POWER: 'power',
  /** Read only: 1 the box is reachable through the cloud (running or standby), 0 offline. */
  ONLINE: 'online',
  /** Push buttons: the power key, sent only when the box is in the opposite state. */
  WAKE: 'wake',
  STANDBY: 'standby',
  /** Push buttons: the play/pause key, sent only when the box is in the opposite state. */
  PLAY: 'play',
  PAUSE: 'pause',
  /** Push buttons. */
  CHANNEL_UP: 'channel_up',
  CHANNEL_DOWN: 'channel_down',
  /** Read only texts. */
  CHANNEL: 'channel',
  PROGRAM: 'program',
  /** Read only: 1 playing, 0 paused or not running. */
  PLAYBACK: 'playback',
});

export const ACTIONS = Object.freeze({
  RECONNECT: 'reconnect',
});

/**
 * The operators of lghorizon 0.12.2 (`COUNTRY_SETTINGS`), its preproduction
 * entry left out. `auth`: what the login takes — `password` (user name and
 * password; a refresh token works too) or `refresh_token` (only a refresh
 * token, read from the operator's web TV site).
 */
export const OPERATORS = Object.freeze({
  nl: {
    name: 'Ziggo (NL)',
    country: 'nl',
    apiUrl: 'https://spark-prod-nl.gnp.cloud.ziggogo.tv',
    auth: 'password',
  },
  'be-nl': {
    name: 'Telenet (BE)',
    country: 'be',
    apiUrl: 'https://spark-prod-be.gnp.cloud.telenet.tv',
    auth: 'refresh_token',
  },
  'be-basetv': {
    name: 'BASE TV (BE)',
    country: 'be',
    apiUrl: 'https://spark-prod-be.gnp.cloud.base.tv',
    auth: 'refresh_token',
  },
  ch: {
    name: 'Sunrise (CH)',
    country: 'ch',
    apiUrl: 'https://spark-prod-ch.gnp.cloud.sunrisetv.ch',
    auth: 'refresh_token',
  },
  gb: {
    name: 'Virgin Media (UK)',
    country: 'gb',
    apiUrl: 'https://spark-prod-gb.gnp.cloud.virgintvgo.virginmedia.com',
    auth: 'refresh_token',
  },
  ie: {
    name: 'Virgin Media (IE)',
    country: 'ie',
    apiUrl: 'https://spark-prod-ie.gnp.cloud.virginmediatv.ie',
    auth: 'password',
  },
  pl: {
    name: 'UPC (PL)',
    country: 'pl',
    apiUrl: 'https://spark-prod-pl.gnp.cloud.upctv.pl',
    auth: 'password',
  },
});

/** W3C key names the boxes accept in a `CPE.KeyEvent` (lghorizon `const.py`). */
export const KEYS = Object.freeze({
  POWER: 'Power',
  PLAY_PAUSE: 'MediaPlayPause',
  CHANNEL_UP: 'ChannelUp',
  CHANNEL_DOWN: 'ChannelDown',
});

/** Running states of a box, as its MQTT status says them. */
export const BOX_STATES = Object.freeze({
  RUNNING: 'ONLINE_RUNNING',
  STANDBY: 'ONLINE_STANDBY',
  NETWORK_STANDBY: 'OFFLINE_NETWORK_STANDBY',
  OFFLINE: 'OFFLINE',
  UNKNOWN: 'UNKNOWN',
});

/** Error codes of the auth service (lghorizon `fetch_access_token`). */
export const AUTH_CODES = Object.freeze({
  INVALID_CREDENTIALS: 97401,
  INVALID_TOKEN: 97402,
});

export const TIMINGS = Object.freeze({
  /** One REST exchange outside of a command. */
  httpTimeout: 15_000,
  /**
   * Gladys waits 5 s for the ack of a command: the whole command (wait in the
   * per-box queue and the MQTT acknowledgement included) gets this.
   */
  commandBudget: 3_800,
  /**
   * The session is renewed by a timer: one day before the refresh token
   * expires, never sooner than `renewMin` nor later than `renewMax` from now.
   * A failed renewal is tried again after `renewRetry` (by index, the last one
   * repeating), never in a loop.
   */
  renewBeforeExpiry: 24 * 3_600_000,
  renewMin: 10 * 60_000,
  renewMax: 12 * 3_600_000,
  renewRetry: [5 * 60_000, 15 * 60_000, 60 * 60_000],
  /**
   * After an API call answered 401, the session is renewed at most once per
   * this; the next index each time a renewal did not end the 401.
   */
  unauthorizedRenewSpacing: [60_000, 15 * 60_000, 60 * 60_000],
  /** A program lookup that failed is not asked again before this. */
  lookupRetry: 10 * 60_000,
  /** A start that failed (network, server) is tried again after these delays. */
  startRetry: [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000],
  /** 429: a pause of this when the answer has no Retry-After, bounded by min and max. */
  pauseDefault: 15 * 60_000,
  pauseMin: 60_000,
  pauseMax: 6 * 3_600_000,
  /**
   * MQTT reconnection delays (by index, the last one repeating). The count
   * only goes back to zero once a connection stayed up `mqttStable`: a socket
   * that opens then drops at once never makes a fast loop.
   */
  mqttBackoff: [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000],
  mqttStable: 2 * 60_000,
  mqttConnectTimeout: 20_000,
  mqttKeepalive: 60,
  /** After a power key, any other power key is refused until the expected state, or this. */
  powerGuard: 45_000,
  /** After a play/pause key, any other one is refused until the expected state, or this. */
  playGuard: 10_000,
  /** The UI status of a running box is asked again after the program ends, or after this. */
  uiRefresh: 15 * 60_000,
  uiRefreshMin: 60_000,
  uiRefreshMax: 3 * 3_600_000,
  uiRefreshAfterEnd: 20_000,
  /** After a command, the UI status is asked again this much later. */
  recheckDelay: 3_000,
  /** The channel list and the box list are read again after these. */
  channelsRefresh: 12 * 3_600_000,
  customerRefresh: 6 * 3_600_000,
  /** A channel list that failed is asked again after this. */
  channelsRetry: 15 * 60_000,
  /** Writes to /data are grouped. */
  persistDelay: 1_000,
});

export const LIMITS = Object.freeze({
  boxes: 10,
  channels: 3_000,
  /** Largest MQTT message read. */
  messageBytes: 64 * 1024,
  /** Largest REST answer read (the channel list is the big one). */
  responseBytes: 8 * 1024 * 1024,
  /** Largest auth answer read. */
  authBytes: 64 * 1024,
  /** Length of a published text, and of a name. */
  text: 200,
  name: 64,
  /** Program lookups kept in memory. */
  eventCache: 200,
});

/** What a text feature shows when nothing plays. */
export const NOTHING = '—';
