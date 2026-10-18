// -----------------------------------------------------------------------------
// A fake operator cloud behind `fetch`: the auth service, the backoffice
// configuration, the customer, the channels, the program lookups and the
// MQTT token, shaped like what lghorizon reads (made-up values). It records
// every request, and the access token travels in the ACCESSTOKEN cookie the
// auth answer sets, as the real service is understood to do.
// -----------------------------------------------------------------------------

import { OPERATORS } from '../../src/constants.js';

export const HOUSEHOLD = 'hh-1234';
export const BOX = '3C36E4-EOSSTB-003656000001';
export const BOX2 = '3C36E4-EOSSTB-003656000002';

const json = (status, body, headers = []) =>
  new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: [['content-type', 'application/json'], ...headers],
  });

export function fakeCloud({ operator = OPERATORS.nl, now = Date.now } = {}) {
  const api = operator.apiUrl;
  const host = new URL(api).hostname;
  const domain = host.split('.').slice(-2).join('.');
  const cloud = {
    requests: [],
    /** 'ok' | 'credentials' | 'token' | 'rate' | 'down' | 'cloudfront' */
    auth: 'ok',
    retryAfter: undefined,
    /** Status forced for the GETs whose path contains the key. */
    failures: new Map(),
    /** The refresh tokens the service accepts (the last one it gave). */
    validRefresh: new Set(['typed-refresh']),
    issued: 0,
    accessToken: undefined,
    setCookie: true,
    services: {
      personalizationService: { URL: `https://${host}/eng/web/personalization-service` },
      linearService: { URL: `https://${host}/eng/web/linear-service` },
      vodService: { URL: `https://${host}/eng/web/vod-service` },
      recordingService: { URL: `https://${host}/eng/web/recording-service` },
      authorizationService: { URL: `https://${host}/auth-service` },
      mqttBroker: { URL: 'wss://obomsg.prod.example.horizon.tv:443/mqtt' },
    },
    customer: {
      customerId: 'cust-1',
      cityId: 1234,
      profiles: [{ profileId: 'profile-1', name: 'Shared', options: { lang: 'nl' } }],
      assignedDevices: [
        {
          deviceId: BOX,
          hashedCPEId: 'hash-1',
          platformType: 'EOS',
          settings: { deviceFriendlyName: 'Living room' },
        },
      ],
    },
    channels: [
      { id: 'NL_000001_019401', name: 'NPO 1', logicalChannelNumber: 1, linearProducts: [] },
      { id: 'NL_000002_019402', name: 'NPO 2', logicalChannelNumber: 2, linearProducts: [] },
    ],
    events: {
      'crid:~~2F~~2Fevent-1': {
        eventId: 'crid:~~2F~~2Fevent-1',
        channelId: 'NL_000001_019401',
        title: 'Journaal',
        episodeName: '20:00',
        startTime: Math.round(now() / 1000) - 600,
        endTime: Math.round(now() / 1000) + 1200,
      },
    },
  };

  const issue = (username = 'me@example.com') => {
    cloud.issued += 1;
    const accessToken = `access-${cloud.issued}`;
    const refreshToken = `refresh-${cloud.issued}`;
    cloud.accessToken = accessToken;
    cloud.validRefresh = new Set([refreshToken]);
    return json(
      200,
      {
        householdId: HOUSEHOLD,
        accessToken,
        refreshToken,
        refreshTokenExpiry: Math.round(now() / 1000) + 7 * 86400,
        username,
      },
      cloud.setCookie
        ? [
            [
              'set-cookie',
              `ACCESSTOKEN=${accessToken}; Path=/; Domain=.${domain}; Secure; HttpOnly`,
            ],
            ['set-cookie', 'tracking=x; Path=/; Domain=.evil.example'],
          ]
        : [],
    );
  };

  const authAnswer = (body, path) => {
    switch (cloud.auth) {
      case 'credentials':
        return json(400, { error: { statusCode: 97401, message: 'Invalid credentials' } });
      case 'token':
        return json(400, { error: { statusCode: 97402, message: 'Invalid token' } });
      case 'rate':
        return json(429, {}, cloud.retryAfter ? [['retry-after', String(cloud.retryAfter)]] : []);
      case 'down':
        return json(503, {});
      case 'cloudfront':
        return new Response('<html>Request blocked</html>', { status: 403 });
      default:
        break;
    }
    if (path.endsWith('/refresh')) {
      if (!cloud.validRefresh.has(body.refreshToken)) {
        return json(400, { error: { statusCode: 97402, message: 'Invalid token' } });
      }
      return issue();
    }
    if (body.username !== 'me@example.com' || body.password !== 'secret pw') {
      return json(400, { error: { statusCode: 97401, message: 'Invalid credentials' } });
    }
    return issue(body.username);
  };

  cloud.fetch = async (url, init = {}) => {
    const target = new URL(url);
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    const body = init.body ? JSON.parse(init.body) : undefined;
    cloud.requests.push({ method: init.method ?? 'GET', url: String(url), headers, body });
    // A request held until the test opens the gate (`cloud.hold(part)`).
    for (const [part, gate] of cloud.gates) {
      if (String(url).includes(part)) {
        await gate.promise;
      }
    }
    if (target.origin === api && target.pathname.startsWith('/auth-service/v1/authorization')) {
      return authAnswer(body, target.pathname);
    }
    for (const [key, status] of cloud.failures) {
      if (target.pathname.includes(key) || target.search.includes(key)) {
        return json(
          status,
          {},
          cloud.retryAfter ? [['retry-after', String(cloud.retryAfter)]] : [],
        );
      }
    }
    if (target.pathname.endsWith('/en/config-service/conf/web/backoffice.json')) {
      return json(200, cloud.services);
    }
    const cookie = headers.cookie ?? '';
    if (!cloud.accessToken || !cookie.split('; ').includes(`ACCESSTOKEN=${cloud.accessToken}`)) {
      return json(401, {});
    }
    const path = target.pathname;
    if (path.endsWith(`/v1/customer/${HOUSEHOLD}`)) {
      return json(200, cloud.customer);
    }
    if (path.endsWith('/v2/channels')) {
      return json(200, cloud.channels);
    }
    if (path.includes('/v2/replayEvent/')) {
      const id = decodeURIComponent(path.split('/v2/replayEvent/')[1]);
      return Object.hasOwn(cloud.events, id) ? json(200, cloud.events[id]) : json(404, {});
    }
    if (path.endsWith('/v1/mqtt/token')) {
      return json(200, { token: `mqtt-${cloud.issued}` });
    }
    if (path.includes('/v2/detailscreen/')) {
      return json(200, { id: 'vod-1', type: 'EPISODE', title: 'Pilot', seriesTitle: 'Series' });
    }
    if (path.includes('/details/single/')) {
      return json(200, {
        id: 'rec-1',
        source: 'single',
        title: 'Recorded',
        showTitle: 'Show',
        episodeTitle: 'Episode 1',
        channelId: 'NL_000002_019402',
      });
    }
    return json(404, {});
  };

  /** Holds the requests whose URL contains `part`; returns the function that lets them go. */
  cloud.gates = new Map();
  cloud.hold = (part) => {
    let open;
    const promise = new Promise((resolve) => {
      open = resolve;
    });
    cloud.gates.set(part, { promise });
    return () => {
      cloud.gates.delete(part);
      open();
    };
  };

  /** The requests made to a path containing `part`. */
  cloud.count = (part) => cloud.requests.filter((r) => r.url.includes(part)).length;
  cloud.authCount = () => cloud.count('/auth-service/v1/authorization');

  return cloud;
}
