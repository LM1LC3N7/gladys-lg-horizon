// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { scryptSync } from 'node:crypto';
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

export function normalizeConfig(raw = {}, salt = undefined) {
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
    /** Set by the app once the salt of /data is known (`credentialDigest`). */
    fingerprint: salt ? credentialDigest(operatorKey, credentials, salt) : undefined,
  };
}

let memo = { key: undefined, digest: undefined };

/**
 * A digest of what the user typed to log in: a refusal is kept against it,
 * and only new credentials (or the "Reconnect" button) try again. scrypt with
 * a random salt kept beside it in /data: the digest alone is written there,
 * never the password, and it cannot be checked against guesses cheaply.
 */
export function credentialDigest(operatorKey, credentials, salt) {
  const key = JSON.stringify([
    operatorKey,
    credentials.username ?? '',
    credentials.password ?? '',
    credentials.refreshToken ?? '',
  ]);
  const cacheKey = `${salt}\n${key}`;
  if (memo.key !== cacheKey) {
    memo = {
      key: cacheKey,
      digest: scryptSync(key, Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString(
        'hex',
      ),
    };
  }
  return memo.digest;
}
