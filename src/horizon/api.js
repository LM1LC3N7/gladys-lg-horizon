// -----------------------------------------------------------------------------
// The REST calls of the operator's cloud the integration needs (lghorizon
// `LGHorizonApi`, `LGHorizonAuth.request`, the device state processor):
//
//   <api>/<cc>/en/config-service/conf/web/backoffice.json   service URLs
//   personalizationService /v1/customer/<household>?with=profiles,devices
//   linearService          /v2/channels?cityId=&language=&productClass=Orion-DASH
//   linearService          /v2/replayEvent/<eventId>?returnLinearContent=true&language=
//   vodService             /v2/detailscreen/<titleId>?language=&profileId=&cityId=
//   recordingService       /customers/<customerId>/details/single/<id>?profileId=&language=
//   authorizationService   /v1/mqtt/token
//   mqttBroker             (the WebSocket URL of the MQTT broker)
//
// Every call goes through `get`: the session cookies, one renewal on 401,
// 429 reported to the app (`onRateLimited`) and, while paused, nothing sent.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from '../constants.js';
import { HorizonError, KINDS } from './errors.js';
import { httpRequest, retryAfterMs } from './http.js';

const seg = (value) => encodeURIComponent(String(value));

/** A service URL from the backoffice configuration: HTTPS (or WSS) only, no credentials. */
function checkedUrl(raw, protocols) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return undefined;
  }
  if (!protocols.includes(url.protocol) || url.username || url.password) {
    return undefined;
  }
  return url.toString().replace(/\/$/, '');
}

export class HorizonApi {
  constructor({
    operator,
    session,
    request = httpRequest,
    fetchImpl,
    now = Date.now,
    timings = TIMINGS,
    pausedUntil = () => 0,
    onRateLimited = () => {},
  }) {
    this.operator = operator;
    this.session = session;
    this.request = request;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timings = timings;
    this.pausedUntil = pausedUntil;
    this.onRateLimited = onRateLimited;
    this.services = undefined;
  }

  checkPause() {
    if (this.pausedUntil() > this.now()) {
      throw new HorizonError(KINDS.PAUSED, 'Paused after a 429: nothing sent');
    }
  }

  async send(url, timeoutMs) {
    const token = this.session.accessToken;
    const cookie = this.session.cookieHeader(url);
    const answer = await this.request(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json', ...(cookie ? { cookie } : {}) },
        timeoutMs,
        maxBytes: LIMITS.responseBytes,
      },
      this.fetchImpl,
    );
    return { answer, token };
  }

  /** One GET, JSON answer. */
  async get(url, { timeoutMs = this.timings.httpTimeout } = {}) {
    this.checkPause();
    await this.session.ensure();
    this.checkPause();
    let { answer, token } = await this.send(url, timeoutMs);
    if (answer.status === 401) {
      const retry = await this.session.renewAfterUnauthorized(token);
      if (!retry) {
        throw new HorizonError(KINDS.UNAUTHORIZED, 'The access token is refused (401)');
      }
      this.checkPause();
      ({ answer } = await this.send(url, timeoutMs));
      if (answer.status === 401) {
        throw new HorizonError(KINDS.UNAUTHORIZED, 'The access token is refused (401)');
      }
    }
    if (answer.status === 429) {
      const err = new HorizonError(KINDS.RATE_LIMITED, 'The cloud limits the requests (429)', {
        retryAfterMs: retryAfterMs(answer.headers?.get?.('retry-after'), this.now()),
      });
      this.onRateLimited(err);
      throw err;
    }
    if (answer.status >= 500 || answer.status === 403) {
      throw new HorizonError(KINDS.UNAVAILABLE, `The cloud answered ${answer.status}`, {
        status: answer.status,
      });
    }
    if (answer.status < 200 || answer.status >= 300) {
      throw new HorizonError(KINDS.HTTP, `The cloud answered ${answer.status}`, {
        status: answer.status,
      });
    }
    try {
      return JSON.parse(answer.body);
    } catch {
      throw new HorizonError(KINDS.BAD_RESPONSE, 'Unreadable answer of the cloud');
    }
  }

  async serviceConfig() {
    if (!this.services) {
      const json = await this.get(
        `${this.operator.apiUrl}/${seg(this.operator.country)}/en/config-service/conf/web/backoffice.json`,
      );
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new HorizonError(KINDS.BAD_RESPONSE, 'No service configuration');
      }
      this.services = json;
    }
    return this.services;
  }

  async serviceUrl(name, protocols = ['https:']) {
    const services = await this.serviceConfig();
    const entry = Object.hasOwn(services, name) ? services[name] : undefined;
    const url = entry && typeof entry === 'object' ? checkedUrl(entry.URL, protocols) : undefined;
    if (!url) {
      throw new HorizonError(KINDS.BAD_RESPONSE, `No usable URL for the service ${name}`);
    }
    return url;
  }

  async customer() {
    const base = await this.serviceUrl('personalizationService');
    return this.get(`${base}/v1/customer/${seg(this.session.householdId)}?with=profiles%2Cdevices`);
  }

  async channels(cityId, lang) {
    const base = await this.serviceUrl('linearService');
    const json = await this.get(
      `${base}/v2/channels?cityId=${seg(cityId)}&language=${seg(lang)}&productClass=Orion-DASH`,
    );
    if (!Array.isArray(json)) {
      throw new HorizonError(KINDS.BAD_RESPONSE, 'No channel list');
    }
    return json;
  }

  async replayEvent(eventId, lang) {
    const base = await this.serviceUrl('linearService');
    return this.get(
      `${base}/v2/replayEvent/${seg(eventId)}?returnLinearContent=true&language=${seg(lang)}`,
    );
  }

  async vod(titleId, { lang, profileId, cityId }) {
    const base = await this.serviceUrl('vodService');
    return this.get(
      `${base}/v2/detailscreen/${seg(titleId)}?language=${seg(lang)}&profileId=${seg(profileId)}&cityId=${seg(cityId)}`,
    );
  }

  async recording(recordingId, { customerId, profileId, lang }) {
    const base = await this.serviceUrl('recordingService');
    return this.get(
      `${base}/customers/${seg(customerId)}/details/single/${seg(recordingId)}?profileId=${seg(profileId)}&language=${seg(lang)}`,
    );
  }

  async mqttToken() {
    const base = await this.serviceUrl('authorizationService');
    const json = await this.get(`${base}/v1/mqtt/token`);
    if (typeof json?.token !== 'string' || json.token === '' || json.token.length > 8192) {
      throw new HorizonError(KINDS.BAD_RESPONSE, 'No MQTT token');
    }
    return json.token;
  }

  /** The WebSocket URL of the MQTT broker (wss://…/mqtt). */
  mqttBrokerUrl() {
    return this.serviceUrl('mqttBroker', ['wss:']);
  }
}
