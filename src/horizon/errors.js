// -----------------------------------------------------------------------------
// One error type for everything the operator's cloud can answer, with a kind
// the app decides on. Messages never carry a token, a password or a cookie.
// -----------------------------------------------------------------------------

export const KINDS = Object.freeze({
  /** The auth service refused the credentials or the refresh token: only the user fixes it. */
  REFUSED: 'refused',
  /** No credentials in the configuration. */
  NO_CREDENTIALS: 'no_credentials',
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  /** 5xx, or a 403 that is not the API's own answer (CloudFront, proxy). */
  UNAVAILABLE: 'unavailable',
  /** 429, with `retryAfterMs` when the answer said it. */
  RATE_LIMITED: 'rate_limited',
  /** An API call refused the access token even after one renewal. */
  UNAUTHORIZED: 'unauthorized',
  /** Any other HTTP status. */
  HTTP: 'http',
  BAD_RESPONSE: 'bad_response',
  /** The request was not sent: the integration is paused (429 earlier). */
  PAUSED: 'paused',
  /** MQTT: nothing was sent (no connection). */
  NOT_CONNECTED: 'not_connected',
  /** A command had no time left: nothing was sent. */
  BUDGET: 'budget',
  /** MQTT: published, but not acknowledged in time (it may have reached the box). */
  UNCONFIRMED: 'unconfirmed',
});

export class HorizonError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'HorizonError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

/** Errors worth trying again later on their own (as opposed to refused credentials). */
export const isTransient = (err) =>
  [KINDS.NETWORK, KINDS.TIMEOUT, KINDS.UNAVAILABLE, KINDS.HTTP, KINDS.BAD_RESPONSE].includes(
    err?.kind,
  );
