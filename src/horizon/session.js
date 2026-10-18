// -----------------------------------------------------------------------------
// The session with the operator's auth service (lghorizon `LGHorizonAuth`):
//
//   POST <api>/auth-service/v1/authorization          { username, password }
//   POST <api>/auth-service/v1/authorization/refresh  { refreshToken }
//
// Both answer { householdId, accessToken, refreshToken, refreshTokenExpiry,
// username }; the refresh token changes at every use, so the new one is
// handed to `onRefreshToken` (the app keeps it in /data). Errors 97401
// (credentials) and 97402 (token) are refusals: never tried again by
// themselves. One request at a time: concurrent callers share it.
// -----------------------------------------------------------------------------

import { AUTH_CODES, LIMITS, TIMINGS } from '../constants.js';
import { HorizonError, KINDS } from './errors.js';
import { CookieJar, httpRequest, retryAfterMs } from './http.js';

const isText = (v, max = 8192) => typeof v === 'string' && v !== '' && v.length <= max;

/** The household id goes into URLs and MQTT topics: a plain identifier only. */
export const isSafeHousehold = (v) => typeof v === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(v);

/** Classifies a non-2xx answer of the auth service. */
export function authError(answer, now = Date.now()) {
  const { status } = answer;
  if (status === 429) {
    return new HorizonError(KINDS.RATE_LIMITED, 'The auth service limits the requests (429)', {
      retryAfterMs: retryAfterMs(answer.headers?.get?.('retry-after'), now),
    });
  }
  if (status >= 500) {
    return new HorizonError(KINDS.UNAVAILABLE, `The auth service is unavailable (${status})`);
  }
  let json;
  try {
    json = JSON.parse(answer.body);
  } catch {
    json = undefined;
  }
  const error = json && typeof json === 'object' ? json.error : undefined;
  const code = Number(error?.statusCode);
  if (code === AUTH_CODES.INVALID_CREDENTIALS) {
    return new HorizonError(KINDS.REFUSED, 'Credentials refused (97401)', {
      reason: 'credentials',
    });
  }
  if (code === AUTH_CODES.INVALID_TOKEN) {
    return new HorizonError(KINDS.REFUSED, 'Refresh token refused (97402)', { reason: 'token' });
  }
  // The service's own JSON refusal (400, 401, 403) refuses the credentials.
  // A 403 without it comes from something in between (CloudFront, a proxy):
  // a passing error.
  if (error && typeof error === 'object' && [400, 401, 403].includes(status)) {
    return new HorizonError(KINDS.REFUSED, `Login refused (${status})`, { reason: 'credentials' });
  }
  if (status === 403) {
    return new HorizonError(KINDS.UNAVAILABLE, 'Access refused by something in between (403)');
  }
  return new HorizonError(KINDS.HTTP, `The auth service answered ${status}`, { status });
}

export class HorizonSession {
  /**
   * @param {object} options
   * @param {{ apiUrl: string }} options.operator
   * @param {{ username?: string, password?: string, refreshToken?: string }} options.credentials
   *   what the user typed; `storedRefreshToken` (from /data) wins over the typed token.
   */
  constructor({
    operator,
    credentials,
    storedRefreshToken,
    onRefreshToken = () => {},
    request = httpRequest,
    fetchImpl,
    now = Date.now,
    timings = TIMINGS,
  }) {
    this.operator = operator;
    this.username = credentials.username ?? '';
    this.password = credentials.password ?? '';
    this.refreshToken = storedRefreshToken || credentials.refreshToken || '';
    this.onRefreshToken = onRefreshToken;
    this.request = request;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timings = timings;
    this.jar = new CookieJar();
    this.accessToken = undefined;
    this.householdId = undefined;
    /** ms epoch, from refreshTokenExpiry (seconds). */
    this.refreshExpiry = undefined;
    this.renewing = undefined;
    this.lastUnauthorizedRenew = -Infinity;
    this.closed = false;
  }

  get hasCredentials() {
    return this.refreshToken !== '' || (this.username !== '' && this.password !== '');
  }

  get authenticated() {
    return this.accessToken !== undefined;
  }

  /** Stops using this session: a renewal in flight is dropped when it ends. */
  close() {
    this.closed = true;
    this.accessToken = undefined;
    this.jar.clear();
  }

  async post(path, payload, extraHeaders = {}) {
    const url = `${this.operator.apiUrl}${path}`;
    const answer = await this.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          charset: 'utf-8',
          accept: 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify(payload),
        timeoutMs: this.timings.httpTimeout,
        maxBytes: LIMITS.authBytes,
      },
      this.fetchImpl,
    );
    if (answer.status < 200 || answer.status >= 300) {
      throw authError(answer, this.now());
    }
    let json;
    try {
      json = JSON.parse(answer.body);
    } catch {
      throw new HorizonError(KINDS.BAD_RESPONSE, 'Unreadable answer of the auth service');
    }
    if (
      !json ||
      typeof json !== 'object' ||
      !isSafeHousehold(json.householdId) ||
      !isText(json.accessToken) ||
      !isText(json.refreshToken)
    ) {
      throw new HorizonError(KINDS.BAD_RESPONSE, 'Incomplete answer of the auth service');
    }
    return { json, url, setCookies: answer.setCookies };
  }

  apply({ json, url, setCookies }) {
    this.jar.clear();
    this.jar.store(url, setCookies);
    this.accessToken = json.accessToken;
    this.refreshToken = json.refreshToken;
    this.householdId = json.householdId;
    const expiry = Number(json.refreshTokenExpiry);
    this.refreshExpiry = Number.isFinite(expiry) && expiry > 0 ? expiry * 1000 : undefined;
    try {
      this.onRefreshToken({ token: this.refreshToken, expiry: this.refreshExpiry });
    } catch {
      // Keeping the token is the app's business; the session is valid anyway.
    }
  }

  /**
   * A new access token: with the refresh token when there is one, else (or
   * when the refresh token is refused and a password is configured) with the
   * user name and password. One request at a time.
   */
  renew() {
    if (!this.hasCredentials) {
      return Promise.reject(new HorizonError(KINDS.NO_CREDENTIALS, 'No credentials'));
    }
    if (!this.renewing) {
      const run = async () => {
        if (this.refreshToken) {
          try {
            return await this.post('/auth-service/v1/authorization/refresh', {
              refreshToken: this.refreshToken,
            });
          } catch (err) {
            const canLogin = this.username !== '' && this.password !== '';
            if (err.kind !== KINDS.REFUSED || !canLogin) {
              throw err;
            }
            // The refresh token is refused but a password is configured: one login.
            this.refreshToken = '';
          }
        }
        return this.post(
          '/auth-service/v1/authorization',
          { username: this.username, password: this.password },
          { 'x-device-code': 'web' },
        );
      };
      this.renewing = run()
        .then((answer) => {
          if (this.closed) {
            throw new HorizonError(KINDS.NOT_CONNECTED, 'Session closed');
          }
          this.apply(answer);
        })
        .finally(() => {
          this.renewing = undefined;
        });
    }
    return this.renewing;
  }

  /** Authenticates when there is no access token yet. */
  async ensure() {
    if (!this.authenticated) {
      await this.renew();
    }
  }

  /**
   * An API call answered 401 with `token`: renewed once (unless another call
   * renewed it already), at most once per `unauthorizedRenewSpacing`.
   * @returns {Promise<boolean>} whether the call may be retried.
   */
  async renewAfterUnauthorized(token) {
    if (this.accessToken !== token && this.accessToken !== undefined) {
      return true;
    }
    if (this.now() - this.lastUnauthorizedRenew < this.timings.unauthorizedRenewSpacing) {
      return false;
    }
    this.lastUnauthorizedRenew = this.now();
    await this.renew();
    return true;
  }

  /** The base domain of the operator (`ziggogo.tv`...), where ACCESSTOKEN is sent. */
  get baseDomain() {
    return new URL(this.operator.apiUrl).hostname.split('.').slice(-2).join('.');
  }

  /** The Cookie header for an API URL. */
  cookieHeader(url) {
    const host = new URL(url).hostname.toLowerCase();
    const sameOperator = host === this.baseDomain || host.endsWith(`.${this.baseDomain}`);
    // The cookie the cloud sets is used as is; ACCESSTOKEN is added (as
    // lghorizon did before 0.9) only to the operator's own hosts, when the
    // auth answer set none.
    const extra =
      sameOperator && this.accessToken && !this.jar.has('ACCESSTOKEN')
        ? { ACCESSTOKEN: this.accessToken }
        : {};
    return this.jar.header(url, extra);
  }
}
