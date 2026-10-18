// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { OPERATORS } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  operator: 'nl',
  language: 'fr',
};

const clean = (value, max) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length <= max ? text : '';
};

export function normalizeConfig(raw = {}) {
  const c = {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)),
  };
  const operatorKey = Object.hasOwn(OPERATORS, c.operator) ? c.operator : DEFAULT_CONFIG.operator;
  const operator = OPERATORS[operatorKey];
  const username = clean(c.username, 256);
  // Passwords are not trimmed: a space may belong to one.
  const password = typeof c.password === 'string' && c.password.length <= 256 ? c.password : '';
  const refreshToken = clean(c.refresh_token, 8192);
  const credentials =
    operator.auth === 'refresh_token'
      ? { refreshToken }
      : { username, password: username ? password : '', refreshToken };
  const ready =
    credentials.refreshToken !== '' ||
    (operator.auth === 'password' && credentials.username !== '' && credentials.password !== '');
  return {
    operatorKey,
    operator,
    credentials,
    ready,
    language: c.language === 'en' ? 'en' : 'fr',
    fingerprint: fingerprint(operatorKey, credentials),
  };
}

/**
 * A digest of what the user typed to log in: a refusal is kept against it,
 * and only new credentials (or the "Reconnect" button) try again. The digest
 * alone is written to /data, never the password.
 */
export function fingerprint(operatorKey, credentials) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        operatorKey,
        credentials.username ?? '',
        credentials.password ?? '',
        credentials.refreshToken ?? '',
      ]),
    )
    .digest('hex');
}
