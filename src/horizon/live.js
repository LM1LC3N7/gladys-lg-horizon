// -----------------------------------------------------------------------------
// The live link with the boxes: the MQTT broker of the operator's cloud, over
// a secure WebSocket (lghorizon `LGHorizonMqttClient`): the household id as
// user name, a short-lived MQTT token (asked of the REST API at each
// connection) as password, a random client id the boxes answer to.
//
// The connection is opened by MQTT.js (MIT) with its own reconnection turned
// off: every connection needs a fresh token, and the delays are kept here.
// They only go back to the shortest once a connection stayed up
// `mqttStable`: a socket that opens then drops at once never loops fast.
// -----------------------------------------------------------------------------

import { randomInt } from 'node:crypto';
import mqtt from 'mqtt';
import { LIMITS, TIMINGS } from '../constants.js';
import { HorizonError, KINDS } from './errors.js';

/** Opens one MQTT connection (the only MQTT network access). */
export function mqttConnect(url, options) {
  return mqtt.connect(url, options);
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** lghorizon `make_id`: random letters and digits. */
export function makeId(length = 10) {
  let id = '';
  for (let i = 0; i < length; i += 1) {
    id += LETTERS[randomInt(LETTERS.length)];
  }
  return id;
}

/** Errors that only the user fixes: no reconnection. */
const FATAL = new Set([KINDS.REFUSED, KINDS.NO_CREDENTIALS]);

export class LiveLink {
  constructor({
    connect = mqttConnect,
    credentials,
    onMessage = () => {},
    onUp = () => {},
    onDown = () => {},
    onFatal = () => {},
    logger,
    timers = globalThis,
    now = Date.now,
    randomId = makeId,
    timings = TIMINGS,
  }) {
    this.connect = connect;
    this.credentials = credentials;
    this.onMessage = onMessage;
    this.onUp = onUp;
    this.onDown = onDown;
    this.onFatal = onFatal;
    this.logger = logger;
    this.timers = timers;
    this.now = now;
    this.randomId = randomId;
    this.timings = timings;
    this.householdId = undefined;
    this.clientId = undefined;
    this.client = undefined;
    this.up = false;
    this.upAt = undefined;
    this.failures = 0;
    this.timer = undefined;
    this.subackTimer = undefined;
    /** `{ client, handlers }`: the listeners this link added (removed one by one). */
    this.attached = undefined;
    /** When the next attempt is due (for the status), or undefined. */
    this.nextAttemptAt = undefined;
    this.running = false;
    this.opening = false;
  }

  get connected() {
    return this.up;
  }

  /** Starts (or keeps) the link of `householdId`. */
  start(householdId) {
    if (this.running && householdId === this.householdId) {
      return;
    }
    this.stop();
    this.running = true;
    this.householdId = householdId;
    this.clientId = this.randomId(10);
    this.failures = 0;
    this.open();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.nextAttemptAt = undefined;
    const wasUp = this.up;
    this.drop();
    if (wasUp) {
      this.onDown();
    }
  }

  drop() {
    const { client } = this;
    this.client = undefined;
    this.up = false;
    this.upAt = undefined;
    this.detach(client);
    client?.end?.(true);
  }

  /** Removes this link's own listeners (and its SUBACK timer) from `client`, nothing else. */
  detach(client) {
    this.clearSubackTimer();
    if (!client || this.attached?.client !== client) {
      return;
    }
    for (const [event, handler] of Object.entries(this.attached.handlers)) {
      client.removeListener(event, handler);
    }
    this.attached = undefined;
    // A late error of the closed client must not crash the process.
    client.on('error', () => {});
  }

  clearSubackTimer() {
    if (this.subackTimer) {
      this.timers.clearTimeout(this.subackTimer);
      this.subackTimer = undefined;
    }
  }

  retry(minimum = 0) {
    if (!this.running) {
      return;
    }
    const delays = this.timings.mqttBackoff;
    const wait = Math.max(minimum, delays[Math.min(this.failures, delays.length - 1)]);
    this.failures += 1;
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
    }
    this.nextAttemptAt = this.now() + wait;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.nextAttemptAt = undefined;
      this.open();
    }, wait);
  }

  async open() {
    if (!this.running || this.client || this.opening) {
      return;
    }
    const householdId = this.householdId;
    this.opening = true;
    let access;
    try {
      access = await this.credentials();
    } catch (err) {
      this.opening = false;
      if (!this.running || householdId !== this.householdId) {
        return;
      }
      this.logger?.warn(`Live link: no access to the broker (${err.message})`);
      if (FATAL.has(err?.kind)) {
        this.running = false;
        this.onFatal(err);
        return;
      }
      this.retry(Number.isFinite(err?.retryAfterMs) ? err.retryAfterMs : 0);
      this.onDown();
      return;
    }
    this.opening = false;
    if (!this.running || householdId !== this.householdId || this.client) {
      return;
    }
    const client = this.connect(access.url, {
      clientId: this.clientId,
      username: access.username,
      password: access.password,
      protocolVersion: 4,
      clean: true,
      keepalive: this.timings.mqttKeepalive,
      reconnectPeriod: 0,
      connectTimeout: this.timings.mqttConnectTimeout,
      resubscribe: false,
      // A message is at most 64 KB (LIMITS.messageBytes): no larger frame is read.
      wsOptions: { maxPayload: 256 * 1024 },
    });
    this.client = client;
    const hh = this.householdId;
    const handlers = {
      connect: () => {
        if (this.client !== client) {
          return;
        }
        this.upAt = this.now();
        // A broker that accepts the connection but never answers the
        // subscription: closed after `mqttConnectTimeout`, tried again later.
        this.clearSubackTimer();
        this.subackTimer = this.timers.setTimeout(() => {
          this.subackTimer = undefined;
          if (this.client === client && !this.up) {
            this.logger?.warn('Live link: no answer to the subscription');
            client.end(true);
          }
        }, this.timings.mqttConnectTimeout);
        // The running states of the boxes are required. The other topics of
        // the household (the answers to this client, `#` below the household:
        // the reference library subscribes to `#`) are a bonus: a refusal of
        // one of them is not an error.
        client.subscribe(`${hh}/+/status`, { qos: 0 }, (err) => {
          if (this.client !== client) {
            return;
          }
          this.clearSubackTimer();
          if (err) {
            this.logger?.warn('Live link: subscription refused');
            client.end(true);
            return;
          }
          for (const topic of [hh, `${hh}/${this.clientId}`, `${hh}/#`]) {
            client.subscribe(topic, { qos: 0 }, () => {});
          }
          this.up = true;
          this.logger?.info('Live link connected');
          this.onUp();
        });
      },
      message: (topic, payload) => this.message(topic, payload),
      error: (err) => {
        // MQTT.js errors carry no credentials; the token is never logged.
        this.logger?.warn(`Live link: ${err?.message ?? err}`);
      },
      close: () => {
        if (this.client !== client) {
          return;
        }
        this.closed(client);
      },
    };
    for (const [event, handler] of Object.entries(handlers)) {
      client.on(event, handler);
    }
    this.attached = { client, handlers };
  }

  /** The connection of `client` closed: spaced retry, the count reset only after a stable link. */
  closed(client) {
    const wasUp = this.up;
    const stable = this.upAt !== undefined && this.now() - this.upAt >= this.timings.mqttStable;
    this.client = undefined;
    this.up = false;
    this.upAt = undefined;
    this.detach(client);
    if (stable) {
      this.failures = 0;
    }
    if (wasUp) {
      this.logger?.warn('Live link disconnected');
    }
    this.retry();
    // After `retry`: the status can say when the next attempt is.
    this.onDown();
  }

  message(topic, payload) {
    if (!payload || payload.length > LIMITS.messageBytes) {
      return;
    }
    let json;
    try {
      json = JSON.parse(Buffer.from(payload).toString('utf8'));
    } catch {
      return;
    }
    try {
      this.onMessage(topic, json);
    } catch (err) {
      this.logger?.warn(`Live message not handled: ${err.message}`);
    }
  }

  /**
   * Publishes `payload` (QoS 2, as the reference library) and resolves once
   * the broker acknowledged it. Rejects NOT_CONNECTED when nothing was sent,
   * UNCONFIRMED when it may have been sent but was not acknowledged within
   * `timeoutMs` (a wall-clock deadline: the ack Gladys waits for).
   */
  publish(topic, payload, timeoutMs) {
    const client = this.client;
    if (!client || !this.up) {
      return Promise.reject(new HorizonError(KINDS.NOT_CONNECTED, 'Live link down: nothing sent'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => {
          settled = true;
          reject(new HorizonError(KINDS.UNCONFIRMED, 'Sent, without confirmation'));
        },
        Math.max(1, timeoutMs),
      );
      client.publish(topic, JSON.stringify(payload), { qos: 2 }, (err) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (err) {
          reject(new HorizonError(KINDS.UNCONFIRMED, 'Sent, without confirmation'));
        } else {
          resolve();
        }
      });
    });
  }
}
