// -----------------------------------------------------------------------------
// The integration: the operator account (session renewed by a timer, refusals
// kept in /data until the user acts, 429 pauses kept in /data too), the boxes
// of the account as Gladys devices, the live link with them (MQTT over a
// secure WebSocket) and the commands (remote keys, sent only when the state
// read from the live link says they are wanted). index.js only wires the SDK
// handlers to it (src/handlers.js).
//
// Phases: missing (no credentials), blocked (credentials refused), paused
// (429), connecting, retry (a start failed: tried again later), ready.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { BOX_STATES, DEVICE_TYPE, FEATURES, KEYS, LIMITS, NOTHING, TIMINGS } from './constants.js';
import { HorizonApi } from './horizon/api.js';
import { HorizonError, KINDS } from './horizon/errors.js';
import { httpRequest } from './horizon/http.js';
import { LiveLink, makeId, mqttConnect } from './horizon/live.js';
import {
  parseChannels,
  parseCustomer,
  parseMessage,
  parseRecording,
  parseReplayEvent,
  parseVod,
} from './horizon/parse.js';
import { HorizonSession } from './horizon/session.js';
import { E, T } from './i18n.js';
import { COMMANDS, buildDevice, deviceName, featureKey, stateList } from './model.js';
import { FileStore, emptyData, newSalt } from './store.js';

const short = (value) => String(value).slice(0, 32);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class HorizonApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'lg-horizon' }),
    store = new FileStore(),
    request = httpRequest,
    fetchImpl,
    connect = mqttConnect,
    now = Date.now,
    timers = globalThis,
    timings = TIMINGS,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.request = request;
    this.fetchImpl = fetchImpl;
    this.connect = connect;
    this.now = now;
    this.timers = timers;
    this.timings = timings;
    this.config = normalizeConfig();
    this.data = undefined;
    this.started = false;
    this.generation = 0;
    /** The digest of the credentials the current session was built from. */
    this.activeFingerprint = undefined;
    this.session = undefined;
    this.api = undefined;
    this.live = undefined;
    this.phase = 'idle';
    this.lastError = undefined;
    this.retryAt = undefined;
    this.startAttempts = 0;
    this.renewFailures = 0;
    /** { customerId, cityId, profileId, lang } */
    this.account = undefined;
    /** channel id -> { name, number } */
    this.channels = new Map();
    this.channelsOk = true;
    /** box id -> { state, fresh, channel, program, playing, seq } */
    this.views = new Map();
    /** `<box id>:power|play` -> { from, expect, until } */
    this.guards = new Map();
    /** box id -> tail of the command queue */
    this.queues = new Map();
    /** ids of the boxes created in Gladys */
    this.created = new Set();
    /** `<kind>:<id>` -> lookup result (programs, VOD titles, recordings) */
    this.lookups = new Map();
    /** `<kind>:<id>` -> when that lookup last failed */
    this.misses = new Map();
    /** name -> timer handle */
    this.named = new Map();
    this.persistTimer = undefined;
    this.lastStatus = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start with a configuration: on every connection to Gladys and on
   * every configuration save. A reconnection to Gladys keeps the session, the
   * pauses and the refusals: only the statuses, the Discovery and the states
   * the core forgot are published again. New credentials start a new session.
   */
  async start(raw = {}, { connected = false } = {}) {
    await this.loadData();
    this.config = normalizeConfig(raw, this.data.salt);
    this.started = true;
    if (connected) {
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
    }
    await this.step('read the Gladys devices', () => this.refreshCreated());
    await this.step('publish the devices', () => this.publishDevices());
    if (this.config.fingerprint !== this.activeFingerprint) {
      await this.step('connect to the operator', () => this.restartCloud());
    }
    await this.step('publish the states', () => this.republishStates());
    await this.step('publish the status', () => this.updateStatus());
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  async loadData() {
    if (this.data) {
      return;
    }
    try {
      this.data = await this.store.load(this.now());
    } catch {
      this.data = emptyData();
    }
    if (this.store.corrupted) {
      this.logger.warn('Unreadable /data/lg-horizon.json moved to lg-horizon.json.bad');
    }
    if (!this.data.salt) {
      // A new salt invalidates nothing: no digest was kept without one.
      this.data.salt = newSalt();
      this.data.block = null;
      this.data.refresh = null;
      this.saveNow();
    }
  }

  async stop() {
    this.started = false;
    this.teardown();
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      this.saveNow();
    }
    // Every write queued (a rotated refresh token included) lands before the exit.
    await this.store.flush?.().catch(() => {});
  }

  /** Ends the current session: no timer, no live link, nothing in flight kept. */
  teardown() {
    this.generation += 1;
    for (const handle of this.named.values()) {
      this.timers.clearTimeout(handle);
    }
    this.named.clear();
    this.live?.stop();
    this.live = undefined;
    this.session?.close();
    this.session = undefined;
    this.api = undefined;
    this.guards.clear();
    this.forgetLive();
  }

  /**
   * What the boxes said is no longer followed: no command decides on it,
   * until the live link reports again (running state, then UI status).
   */
  forgetLive() {
    for (const view of this.views.values()) {
      view.fresh = false;
      view.playing = undefined;
    }
  }

  /** A named background timer (one per name), dropped by teardown(). */
  setNamed(name, ms, task) {
    this.clearNamed(name);
    const generation = this.generation;
    const handle = this.timers.setTimeout(
      () => {
        this.named.delete(name);
        if (generation === this.generation) {
          Promise.resolve()
            .then(task)
            .catch((err) => this.logger.warn(`Background task ${name} failed: ${err.message}`));
        }
      },
      Math.max(0, ms),
    );
    this.named.set(name, handle);
  }

  clearNamed(name) {
    if (this.named.has(name)) {
      this.timers.clearTimeout(this.named.get(name));
      this.named.delete(name);
    }
  }

  persist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.saveNow();
    }, this.timings.persistDelay);
  }

  saveNow() {
    return this.store
      .save(this.data)
      .catch((err) => this.logger.warn(`Could not save /data: ${err.message}`));
  }

  // --- Refusals and pauses -----------------------------------------------------

  get blocked() {
    return this.data?.block?.fingerprint === this.config.fingerprint ? this.data.block : undefined;
  }

  pausedUntil() {
    const until = this.data?.pause?.until ?? 0;
    return until > this.now() ? until : 0;
  }

  /** A 429: everything that reaches the cloud waits, the end is kept in /data. */
  pause(err) {
    const wanted = Number.isFinite(err?.retryAfterMs)
      ? err.retryAfterMs
      : this.timings.pauseDefault;
    const until = this.now() + clamp(wanted, this.timings.pauseMin, this.timings.pauseMax);
    if (until > this.pausedUntil()) {
      this.data.pause = { until };
      this.saveNow();
      this.logger.warn(`The operator's cloud asked to slow down: paused for ${wanted} ms at least`);
    }
  }

  /** Refused credentials: kept in /data, nothing tried again until the user acts. */
  async block(reason) {
    this.data.block = { fingerprint: this.config.fingerprint, reason, at: this.now() };
    await this.saveNow();
    this.logger.warn(`The operator refused the ${reason === 'token' ? 'refresh token' : 'login'}`);
    this.teardown();
    this.phase = 'blocked';
    await this.updateStatus();
  }

  /**
   * What any failure leads to. `origin`: start (tried again with backoff),
   * renew (the renewal timer), other (a lookup: nothing more).
   */
  async failed(err, origin) {
    if (err?.kind === KINDS.REFUSED) {
      await this.block(err.reason);
      return;
    }
    if (err?.kind === KINDS.NO_CREDENTIALS) {
      this.teardown();
      this.phase = 'missing';
      await this.updateStatus();
      return;
    }
    if (err?.kind === KINDS.RATE_LIMITED) {
      this.pause(err);
    }
    const paused = this.pausedUntil();
    if (origin === 'start') {
      this.lastError = err?.message ?? String(err);
      if (paused) {
        this.phase = 'paused';
        this.setNamed('retry', paused - this.now(), () => this.connectCloud());
      } else {
        const delays = this.timings.startRetry;
        const wait = delays[Math.min(this.startAttempts, delays.length - 1)];
        this.startAttempts += 1;
        this.phase = 'retry';
        this.retryAt = this.now() + wait;
        this.setNamed('retry', wait, () => this.connectCloud());
      }
      this.logger.warn(`Could not connect to the operator: ${this.lastError}`);
      await this.updateStatus();
    } else if (origin === 'renew') {
      const delays = this.timings.renewRetry;
      const wait = Math.max(
        paused ? paused - this.now() : 0,
        delays[Math.min(this.renewFailures, delays.length - 1)],
      );
      this.renewFailures += 1;
      this.logger.warn(`Session renewal failed (${err?.message}): tried again in ${wait} ms`);
      this.setNamed('renew', wait, () => this.renew());
    }
  }

  // --- The cloud -----------------------------------------------------------------

  /** A new session from the configured credentials (and the refresh token kept for them). */
  async restartCloud() {
    const fp = this.config.fingerprint;
    const renewing = this.session?.renewing;
    if (renewing && this.activeFingerprint === fp) {
      // Same credentials: the renewal in flight rotates the refresh token;
      // its answer is waited for (bounded) so the new session starts from it.
      let timer;
      await Promise.race([
        renewing.catch(() => {}),
        new Promise((resolve) => {
          timer = this.timers.setTimeout(resolve, this.timings.httpTimeout);
        }),
      ]);
      this.timers.clearTimeout(timer);
    }
    this.teardown();
    this.activeFingerprint = fp;
    this.startAttempts = 0;
    this.renewFailures = 0;
    this.account = undefined;
    this.lookups.clear();
    this.misses.clear();
    if (this.data.block && this.data.block.fingerprint !== fp) {
      // Other credentials: the old refusal no longer applies.
      this.data.block = null;
      this.persist();
    }
    const session = new HorizonSession({
      operator: this.config.operator,
      credentials: this.config.credentials,
      // Read at each renewal: the newest token, whichever session got it.
      storedRefreshToken: () =>
        this.data.refresh?.fingerprint === fp ? this.data.refresh.token : undefined,
      // A token received is never thrown away (the previous one no longer
      // works): kept while the credentials it came from are still configured,
      // even when this session was closed in the meantime.
      onRefreshToken: ({ token, expiry }) => {
        if (this.config.fingerprint === fp) {
          this.data.refresh = { fingerprint: fp, token, expiry: expiry ?? null };
          this.saveNow();
        }
      },
      request: this.request,
      fetchImpl: this.fetchImpl,
      now: this.now,
      timings: this.timings,
    });
    this.session = session;
    this.api = new HorizonApi({
      operator: this.config.operator,
      session,
      request: this.request,
      fetchImpl: this.fetchImpl,
      now: this.now,
      timings: this.timings,
      pausedUntil: () => this.pausedUntil(),
      onRateLimited: (err) => this.pause(err),
    });
    this.live = new LiveLink({
      connect: this.connect,
      credentials: () => this.liveCredentials(),
      onMessage: (topic, json) => this.onMessage(topic, json),
      onUp: () => this.onLiveUp(),
      onDown: () => this.onLiveDown(),
      onFatal: (err) => this.failed(err, 'other'),
      logger: this.logger,
      timers: this.timers,
      now: this.now,
      timings: this.timings,
    });
    await this.connectCloud();
  }

  async connectCloud() {
    this.clearNamed('retry');
    this.retryAt = undefined;
    const generation = this.generation;
    if (!this.config.ready) {
      this.phase = 'missing';
      await this.updateStatus();
      return;
    }
    if (this.blocked) {
      this.phase = 'blocked';
      await this.updateStatus();
      return;
    }
    const paused = this.pausedUntil();
    if (paused) {
      this.phase = 'paused';
      this.setNamed('retry', paused - this.now(), () => this.connectCloud());
      await this.updateStatus();
      return;
    }
    this.phase = 'connecting';
    await this.updateStatus();
    try {
      await this.session.ensure();
      if (generation !== this.generation) {
        return;
      }
      await this.loadAccount();
      if (generation !== this.generation) {
        return;
      }
      await this.loadChannels();
      if (generation !== this.generation) {
        return;
      }
      this.startAttempts = 0;
      this.phase = 'ready';
      this.lastError = undefined;
      this.scheduleRenew();
      this.setNamed('customer', this.timings.customerRefresh, () => this.refreshAccount());
      this.live.start(this.session.householdId);
      await this.updateStatus();
    } catch (err) {
      if (generation === this.generation) {
        await this.failed(err, 'start');
      }
    }
  }

  /** The renewal of the session, by timer, one day before the refresh token expires. */
  scheduleRenew() {
    const expiry = this.session?.refreshExpiry;
    const wanted =
      expiry === undefined
        ? this.timings.renewMax
        : expiry - this.timings.renewBeforeExpiry - this.now();
    this.setNamed('renew', clamp(wanted, this.timings.renewMin, this.timings.renewMax), () =>
      this.renew(),
    );
  }

  async renew() {
    const paused = this.pausedUntil();
    if (paused) {
      this.setNamed('renew', paused - this.now(), () => this.renew());
      return;
    }
    const generation = this.generation;
    try {
      await this.session.renew();
      if (generation !== this.generation) {
        return;
      }
      this.renewFailures = 0;
      this.scheduleRenew();
    } catch (err) {
      if (generation === this.generation) {
        await this.failed(err, 'renew');
      }
    }
  }

  /** The customer: the account ids, the profile language and the boxes. */
  async loadAccount() {
    const customer = parseCustomer(await this.api.customer());
    if (!customer) {
      throw new HorizonError(KINDS.BAD_RESPONSE, 'No customer information');
    }
    this.account = {
      customerId: customer.customerId,
      cityId: customer.cityId,
      profileId: customer.profileId,
      lang: customer.lang,
    };
    const boxes = Object.create(null);
    for (const box of customer.boxes) {
      boxes[box.id] = box;
    }
    // A box gone from the account but created in Gladys stays known.
    for (const [id, box] of Object.entries(this.data.boxes)) {
      if (!(id in boxes) && this.created.has(id)) {
        boxes[id] = box;
      }
    }
    if (JSON.stringify(boxes) !== JSON.stringify(this.data.boxes)) {
      this.data.boxes = boxes;
      this.persist();
      // Devices already created in Gladys (a reset /data) are recognized again.
      await this.refreshCreated().catch(() => {});
      await this.publishDevices().catch((err) =>
        this.logger.warn(`Could not publish the devices: ${err.message}`),
      );
    }
  }

  async refreshAccount() {
    try {
      await this.loadAccount();
    } catch (err) {
      this.logger.warn(`Could not read the boxes of the account: ${err.message}`);
      await this.failed(err, 'other');
    }
    if (this.phase === 'ready') {
      this.setNamed('customer', this.timings.customerRefresh, () => this.refreshAccount());
    }
  }

  /** The channel names. Secondary: a failure only leaves the names missing for a while. */
  async loadChannels() {
    try {
      const list = await this.api.channels(this.account?.cityId ?? '', this.account?.lang ?? 'en');
      this.channels = parseChannels(list);
      this.channelsOk = true;
      this.setNamed('channels', this.timings.channelsRefresh, () => this.loadChannels());
    } catch (err) {
      if (err.kind === KINDS.REFUSED) {
        throw err;
      }
      this.channelsOk = false;
      this.logger.warn(`Could not read the channel list: ${err.message}`);
      if (err.kind === KINDS.RATE_LIMITED) {
        this.pause(err);
      }
      this.setNamed(
        'channels',
        Math.max(this.timings.channelsRetry, this.pausedUntil() - this.now()),
        () => this.loadChannels().then(() => this.updateStatus()),
      );
    }
  }

  /** The broker URL and a fresh MQTT token, for each new live connection. */
  async liveCredentials() {
    const paused = this.pausedUntil();
    if (paused) {
      throw new HorizonError(KINDS.PAUSED, 'Paused after a 429', {
        retryAfterMs: paused - this.now(),
      });
    }
    try {
      const url = await this.api.mqttBrokerUrl();
      const password = await this.api.mqttToken();
      return { url, username: this.session.householdId, password };
    } catch (err) {
      if (err.kind === KINDS.RATE_LIMITED) {
        this.pause(err);
      }
      if (err.kind === KINDS.RATE_LIMITED || err.kind === KINDS.PAUSED) {
        throw new HorizonError(err.kind, err.message, {
          retryAfterMs: Math.max(0, this.pausedUntil() - this.now()),
        });
      }
      throw err;
    }
  }

  // --- Live link -------------------------------------------------------------------

  get householdId() {
    return this.session?.householdId;
  }

  view(id) {
    let view = this.views.get(id);
    if (!view) {
      view = { state: BOX_STATES.UNKNOWN, fresh: false, seq: 0 };
      this.views.set(id, view);
    }
    return view;
  }

  onLiveUp() {
    const live = this.live;
    const hh = this.householdId;
    // Announce this client like the reference library does, then ask each box what it shows.
    live
      .publish(
        `${hh}/${live.clientId}/status`,
        { source: live.clientId, state: BOX_STATES.RUNNING, deviceType: 'HGO' },
        10_000,
      )
      .catch(() => {});
    for (const id of Object.keys(this.data.boxes)) {
      this.requestUi(id);
    }
    this.updateStatus();
  }

  onLiveDown() {
    this.forgetLive();
    this.updateStatus();
  }

  requestUi(id) {
    if (!this.live?.connected) {
      return;
    }
    this.live
      .publish(
        `${this.householdId}/${id}`,
        { id: makeId(8), type: 'CPE.getUiStatus', source: this.live.clientId },
        10_000,
      )
      .catch(() => {});
  }

  onMessage(topic, json) {
    const message = parseMessage(topic, json, this.householdId);
    if (!message || !Object.hasOwn(this.data.boxes, message.source)) {
      return;
    }
    if (message.kind === 'status') {
      this.onStatus(message.source, message.state);
    } else {
      this.onUi(message.source, message.ui).catch((err) =>
        this.logger.warn(`UI status of ${message.source} not handled: ${err.message}`),
      );
    }
  }

  onStatus(id, state) {
    const view = this.view(id);
    const previous = view.state;
    view.state = state;
    view.fresh = state !== BOX_STATES.UNKNOWN;
    const guard = this.guards.get(`${id}:power`);
    // Only the expected state ends the guard: neither the state of departure nor an unknown one.
    if (guard && state === guard.expect) {
      this.guards.delete(`${id}:power`);
    }
    if (state !== BOX_STATES.RUNNING) {
      view.seq += 1;
      view.channel = undefined;
      view.program = undefined;
      view.playing = undefined;
      this.guards.delete(`${id}:play`);
      this.clearNamed(`ui:${id}`);
    } else if (previous !== BOX_STATES.RUNNING) {
      this.requestUi(id);
    }
    this.publishBox(id);
  }

  async onUi(id, ui) {
    const view = this.view(id);
    if (view.state !== BOX_STATES.RUNNING || (ui.mode === 'app' && ui.launcher)) {
      return;
    }
    view.seq += 1;
    const seq = view.seq;
    // The playback state and its guard follow the message at once, before any
    // lookup: a command never decides on the state of an older message.
    view.playing =
      ui.mode === 'player' && typeof ui.speed === 'number' ? ui.speed !== 0 : undefined;
    const guard = this.guards.get(`${id}:play`);
    if (guard && typeof view.playing === 'boolean' && view.playing === guard.expect) {
      this.guards.delete(`${id}:play`);
    }
    this.publishBox(id);
    // The channel and the program: one lookup at a time per box, and only for
    // the latest message (an older one still waiting is skipped).
    const previous = view.describing ?? Promise.resolve();
    const run = previous.then(() => (seq === view.seq ? this.describe(ui) : undefined));
    view.describing = run.catch(() => {});
    const described = await run;
    if (!described || seq !== view.seq || view.state !== BOX_STATES.RUNNING) {
      return;
    }
    view.channel = described.channel;
    view.program = described.program;
    this.publishBox(id);
    this.scheduleUi(id, described.end);
  }

  /** The UI status is asked again after the program ends (its next one), or every 15 min. */
  scheduleUi(id, endSeconds) {
    const wait =
      endSeconds === undefined
        ? this.timings.uiRefresh
        : clamp(
            endSeconds * 1000 + this.timings.uiRefreshAfterEnd - this.now(),
            this.timings.uiRefreshMin,
            this.timings.uiRefreshMax,
          );
    this.setNamed(`ui:${id}`, wait, () => {
      if (this.views.get(id)?.state === BOX_STATES.RUNNING) {
        this.requestUi(id);
        this.scheduleUi(id, undefined);
      }
    });
  }

  channelName(channelId) {
    return (channelId && this.channels.get(channelId)?.name) || NOTHING;
  }

  /**
   * A cached lookup; a failure gives undefined (the channel is still
   * published) and is not asked again for `lookupRetry`.
   */
  async lookup(kind, id, task) {
    const key = `${kind}:${id}`;
    if (this.lookups.has(key)) {
      return this.lookups.get(key);
    }
    const missed = this.misses.get(key);
    if (missed !== undefined && this.now() - missed < this.timings.lookupRetry) {
      return undefined;
    }
    this.misses.delete(key);
    try {
      const value = await task();
      if (value) {
        if (this.lookups.size >= LIMITS.eventCache) {
          this.lookups.delete(this.lookups.keys().next().value);
        }
        this.lookups.set(key, value);
      }
      return value;
    } catch (err) {
      this.logger.debug?.(`Lookup ${kind} failed: ${err.message}`);
      if (this.misses.size >= LIMITS.eventCache) {
        this.misses.delete(this.misses.keys().next().value);
      }
      this.misses.set(key, this.now());
      if (err.kind === KINDS.REFUSED || err.kind === KINDS.RATE_LIMITED) {
        await this.failed(err, 'other');
      }
      return undefined;
    }
  }

  /** What a UI status shows: { channel, program, end? } (lghorizon device state processor). */
  async describe(ui) {
    if (ui.mode === 'app') {
      return { channel: NOTHING, program: ui.appName ?? NOTHING };
    }
    if (ui.mode !== 'player') {
      return { channel: NOTHING, program: NOTHING };
    }
    const account = this.account ?? {};
    const lang = account.lang ?? 'en';
    switch (ui.sourceType) {
      case 'linear':
      case 'reviewBuffer':
      case 'replay': {
        const event = ui.eventId
          ? await this.lookup('event', ui.eventId, async () =>
              parseReplayEvent(await this.api.replayEvent(ui.eventId, lang)),
            )
          : undefined;
        return {
          channel: this.channelName(ui.channelId ?? event?.channelId),
          program: event?.title ?? NOTHING,
          end: ui.sourceType === 'replay' ? undefined : event?.end,
        };
      }
      case 'VOD': {
        const vod =
          ui.titleId && account.profileId
            ? await this.lookup('vod', ui.titleId, async () =>
                parseVod(await this.api.vod(ui.titleId, { ...account, lang })),
              )
            : undefined;
        return { channel: NOTHING, program: vod?.title ?? NOTHING };
      }
      case 'nDVR': {
        const recording =
          ui.recordingId && account.customerId
            ? await this.lookup('recording', ui.recordingId, async () =>
                parseRecording(await this.api.recording(ui.recordingId, { ...account, lang })),
              )
            : undefined;
        return {
          channel: this.channelName(recording?.channelId ?? ui.channelId),
          program: recording?.title ?? NOTHING,
        };
      }
      default:
        return { channel: this.channelName(ui.channelId), program: NOTHING };
    }
  }

  // --- Gladys devices and states ---------------------------------------------------

  get boxes() {
    return Object.values(this.data?.boxes ?? {});
  }

  boxOfDevice(device) {
    return this.boxes.find(
      (b) => this.gladys.externalIds(DEVICE_TYPE, b.id).device === device?.external_id,
    );
  }

  /** The devices Gladys has (kept up to date by the SDK), by box id. */
  createdDevice(box) {
    const externalId = this.gladys.externalIds(DEVICE_TYPE, box.id).device;
    return (Array.isArray(this.gladys.devices) ? this.gladys.devices : []).find(
      (d) => d?.external_id === externalId,
    );
  }

  async refreshCreated() {
    let devices;
    try {
      devices = await this.gladys.getDevices();
    } catch (err) {
      if (!Array.isArray(this.gladys.devices)) {
        throw err;
      }
      devices = this.gladys.devices;
    }
    const byExternal = new Map(
      this.boxes.map((b) => [this.gladys.externalIds(DEVICE_TYPE, b.id).device, b.id]),
    );
    this.created = new Set(
      (Array.isArray(devices) ? devices : [])
        .map((d) => byExternal.get(d?.external_id))
        .filter(Boolean),
    );
  }

  async publishDevices() {
    if (!this.data) {
      return;
    }
    await this.gladys.publishDiscoveredDevices(
      this.boxes.map((box) =>
        buildDevice(this.gladys, box, this.config.language, this.createdDevice(box)),
      ),
    );
  }

  /** Publishes the states of a box, in the background: never awaited by a command. */
  publishBox(id) {
    const box = this.data.boxes[id];
    if (!box || !this.created.has(id)) {
      return;
    }
    const states = stateList(this.gladys, box, this.views.get(id));
    if (states.length === 0) {
      return;
    }
    Promise.resolve()
      .then(() => this.gladys.publishChangedStates(states))
      .catch((err) =>
        this.logger.warn(`Could not publish the states of ${deviceName(box)}: ${err.message}`),
      );
  }

  async republishStates() {
    for (const id of Object.keys(this.data.boxes)) {
      if (this.views.has(id)) {
        this.publishBox(id);
      }
    }
  }

  async deviceCreated(device) {
    const box = this.boxOfDevice(device);
    if (!box) {
      return;
    }
    this.created.add(box.id);
    this.publishBox(box.id);
    this.requestUi(box.id);
  }

  async deviceDeleted(device) {
    const box = this.boxOfDevice(device);
    if (box) {
      this.created.delete(box.id);
    }
  }

  // --- Commands ----------------------------------------------------------------------

  async setValue(device, feature) {
    const box = this.boxOfDevice(device);
    if (!box) {
      throw new Error(E.unknownBox);
    }
    const key = featureKey(device.external_id, feature?.external_id);
    if (!COMMANDS.has(key)) {
      throw new Error(E.notCommand(short(key)));
    }
    // The budget runs from the request of Gladys, the wait in the queue included.
    const started = this.now();
    return this.enqueue(box.id, () => this.command(box, key, started));
  }

  enqueue(id, task) {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.queues.set(
      id,
      run.catch(() => {}),
    );
    return run;
  }

  remaining(started) {
    return this.timings.commandBudget - (this.now() - started);
  }

  guarded(id, kind) {
    const guard = this.guards.get(`${id}:${kind}`);
    if (!guard) {
      return false;
    }
    if (this.now() >= guard.until) {
      this.guards.delete(`${id}:${kind}`);
      return false;
    }
    return true;
  }

  async command(box, key, started) {
    if (this.remaining(started) < 50) {
      // Gladys stopped waiting while this command was queued: dropped, never sent late.
      throw new HorizonError(KINDS.BUDGET, E.late);
    }
    if (this.blocked) {
      throw new Error(E.blocked);
    }
    if (this.phase !== 'ready' || !this.live) {
      throw new Error(E.notReady);
    }
    if (!this.live.connected) {
      throw new HorizonError(KINDS.NOT_CONNECTED, E.liveDown);
    }
    const view = this.views.get(box.id);
    // Only a state the live link reported, and followed since: never a remembered one.
    const state = view?.fresh ? view.state : BOX_STATES.UNKNOWN;
    const known = state === BOX_STATES.RUNNING || state === BOX_STATES.STANDBY;
    if (key === FEATURES.WAKE || key === FEATURES.STANDBY) {
      const wanted = key === FEATURES.WAKE ? BOX_STATES.RUNNING : BOX_STATES.STANDBY;
      // While a power key is under way, the state shown is about to change:
      // any power command is ignored, a "nothing to do" included.
      if (this.guarded(box.id, 'power')) {
        throw new Error(E.powerBusy);
      }
      if (state === wanted) {
        return undefined;
      }
      if (!known) {
        throw new Error(E.stateUnknown);
      }
      return this.send(box, KEYS.POWER, started, {
        kind: 'power',
        from: state,
        expect: wanted,
        ms: this.timings.powerGuard,
      });
    }
    if (state !== BOX_STATES.RUNNING) {
      throw new Error(known ? E.notRunning : E.stateUnknown);
    }
    if (key === FEATURES.PLAY || key === FEATURES.PAUSE) {
      const wanted = key === FEATURES.PLAY;
      if (this.guarded(box.id, 'play')) {
        throw new Error(E.playBusy);
      }
      if (typeof view.playing !== 'boolean') {
        throw new Error(E.playbackUnknown);
      }
      if (view.playing === wanted) {
        return undefined;
      }
      return this.send(box, KEYS.PLAY_PAUSE, started, {
        kind: 'play',
        from: view.playing,
        expect: wanted,
        ms: this.timings.playGuard,
      });
    }
    return this.send(
      box,
      key === FEATURES.CHANNEL_UP ? KEYS.CHANNEL_UP : KEYS.CHANNEL_DOWN,
      started,
    );
  }

  /**
   * One remote key (lghorizon `send_key_to_box`). The guard of a toggle is
   * set as soon as the key may have left, before the broker acknowledges it.
   * The ack of the command only waits for the broker, never for Gladys.
   */
  async send(box, w3cKey, started, guard) {
    const budget = this.remaining(started);
    if (budget < 50) {
      throw new HorizonError(KINDS.BUDGET, E.late);
    }
    const sending = this.live.publish(
      `${this.householdId}/${box.id}`,
      {
        type: 'CPE.KeyEvent',
        runtimeType: 'key',
        id: makeId(8),
        source: box.id.toLowerCase(),
        status: { w3cKey, eventType: 'keyDownUp' },
      },
      budget,
    );
    if (guard) {
      this.guards.set(`${box.id}:${guard.kind}`, {
        from: guard.from,
        expect: guard.expect,
        until: this.now() + guard.ms,
      });
    }
    try {
      await sending;
    } catch (err) {
      if (err.kind === KINDS.NOT_CONNECTED && guard) {
        // Nothing left: no guard for a key that never went out.
        this.guards.delete(`${box.id}:${guard.kind}`);
      }
      if (err.kind === KINDS.UNCONFIRMED) {
        this.setNamed(`recheck:${box.id}`, this.timings.recheckDelay, () => this.requestUi(box.id));
      }
      throw err;
    }
    this.setNamed(`recheck:${box.id}`, this.timings.recheckDelay, () => this.requestUi(box.id));
    return undefined;
  }

  // --- Configuration button --------------------------------------------------------

  /** "Reconnect": one attempt, the refusal kept for these credentials lifted. */
  async reconnect() {
    if (!this.data) {
      await this.loadData();
    }
    if (!this.config.ready) {
      return T.missing(this.config.operator.name, this.config.operator.auth);
    }
    const wasBlocked = Boolean(this.blocked);
    if (wasBlocked) {
      this.data.block = null;
      await this.saveNow();
    }
    await this.restartCloud();
    await this.publishDevices().catch(() => {});
    if (wasBlocked && this.phase === 'blocked') {
      return T.reconnectRefusedAgain;
    }
    return this.statusMessage().message ?? T.connected(this.boxes.length);
  }

  // --- Status ---------------------------------------------------------------------

  statusMessage() {
    const notes = [];
    if (this.store.corrupted) {
      notes.push(T.dataReset);
    }
    const join = (main) => {
      const all = [main, ...notes].filter(Boolean);
      return all.length
        ? { en: all.map((n) => n.en).join(' '), fr: all.map((n) => n.fr).join(' ') }
        : undefined;
    };
    switch (this.phase) {
      case 'missing':
        return {
          connected: false,
          message: join(T.missing(this.config.operator.name, this.config.operator.auth)),
        };
      case 'blocked':
        return { connected: false, message: join(T.refused(this.data.block?.reason)) };
      case 'paused':
        return { connected: false, message: join(T.paused(this.pausedUntil() || this.now())) };
      case 'retry':
        return {
          connected: false,
          message: join(T.retrying(this.lastError, (this.retryAt ?? this.now()) - this.now())),
        };
      case 'ready': {
        if (!this.live?.connected) {
          const next = this.live?.nextAttemptAt;
          return {
            connected: false,
            message: join(T.liveDown(next === undefined ? undefined : next - this.now())),
          };
        }
        if (!this.channelsOk) {
          notes.unshift(T.noChannels);
        }
        return {
          connected: true,
          message: join(this.boxes.length ? T.connected(this.boxes.length) : T.noBox),
        };
      }
      default:
        return { connected: false, message: join(T.connecting) };
    }
  }

  async updateStatus() {
    if (!this.started) {
      return;
    }
    const status = this.statusMessage();
    const key = JSON.stringify(status);
    if (key === this.lastStatus) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Could not publish the status: ${err.message}`);
    }
  }
}
