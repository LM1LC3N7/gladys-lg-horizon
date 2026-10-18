// -----------------------------------------------------------------------------
// The only HTTP access: `fetch` with an explicit timer (not
// AbortSignal.timeout, whose timer does not keep the process alive), a capped
// answer size, and a small cookie jar.
//
// The cloud keeps the session in cookies (lghorizon relies on the aiohttp
// cookie jar since 0.9; before, it set ACCESSTOKEN itself): the cookies of the
// auth answer are kept and sent back to the hosts their Domain covers, over
// HTTPS only.
// -----------------------------------------------------------------------------

import { HorizonError, KINDS } from './errors.js';

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const text = String(value).trim();
  if (/^\d{1,9}$/.test(text)) {
    return Number(text) * 1000;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Reads at most `maxBytes` of a body; a longer answer is an error. */
async function readCapped(response, maxBytes) {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HorizonError(KINDS.BAD_RESPONSE, `Answer larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * One HTTP exchange. Resolves `{ status, headers, body, setCookies }` for any
 * status; rejects with a HorizonError NETWORK or TIMEOUT when nothing came back.
 */
export async function httpRequest(
  url,
  { method = 'GET', headers = {}, body, timeoutMs = 15_000, maxBytes = 1024 * 1024 } = {},
  fetchImpl = globalThis.fetch,
) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.max(1, timeoutMs),
  );
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
    const text = await readCapped(response, maxBytes);
    const setCookies =
      typeof response.headers?.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    return { status: response.status, headers: response.headers, body: text, setCookies };
  } catch (err) {
    if (err instanceof HorizonError) {
      throw err;
    }
    if (timedOut) {
      throw new HorizonError(KINDS.TIMEOUT, `No answer within ${timeoutMs} ms`);
    }
    throw new HorizonError(KINDS.NETWORK, `Network error (${err?.cause?.code ?? err?.name})`);
  } finally {
    clearTimeout(timer);
  }
}

const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{0,8192}$/;
const DOMAIN = /^[a-z0-9.-]{1,253}$/;

/**
 * The cookies of the session. Kept in a Map (no prototype), keyed by name and
 * domain; a cookie without Domain is sent back to its own host only.
 */
export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  clear() {
    this.cookies.clear();
  }

  /** Keeps the cookies of `setCookies` (Set-Cookie header values) answered by `fromUrl`. */
  store(fromUrl, setCookies) {
    const host = new URL(fromUrl).hostname.toLowerCase();
    for (const line of Array.isArray(setCookies) ? setCookies : []) {
      const [pair, ...attributes] = String(line).split(';');
      const index = pair.indexOf('=');
      if (index <= 0) {
        continue;
      }
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) {
        continue;
      }
      let domain = host;
      let hostOnly = true;
      let expired = false;
      let foreign = false;
      for (const attribute of attributes) {
        const [key, ...rest] = attribute.split('=');
        const k = key.trim().toLowerCase();
        const v = rest.join('=').trim();
        if (k === 'domain' && v) {
          const d = v.replace(/^\./, '').toLowerCase();
          // A cookie may only widen to a parent of the host that set it
          // (RFC 6265: any other Domain drops the cookie).
          if (DOMAIN.test(d) && d.includes('.') && (host === d || host.endsWith(`.${d}`))) {
            domain = d;
            hostOnly = false;
          } else {
            foreign = true;
          }
        } else if (k === 'max-age' && /^-?\d+$/.test(v) && Number(v) <= 0) {
          expired = true;
        }
      }
      if (foreign) {
        continue;
      }
      const key = `${name}@${domain}`;
      if (expired || value === '') {
        this.cookies.delete(key);
      } else {
        this.cookies.set(key, { name, value, domain, hostOnly });
      }
    }
  }

  has(name) {
    return [...this.cookies.values()].some((c) => c.name === name);
  }

  /** The Cookie header for `url`, or '' (never over plain HTTP). */
  header(url, extra = {}) {
    const target = new URL(url);
    if (target.protocol !== 'https:') {
      return '';
    }
    const host = target.hostname.toLowerCase();
    const pairs = new Map();
    for (const cookie of this.cookies.values()) {
      const match = cookie.hostOnly
        ? host === cookie.domain
        : host === cookie.domain || host.endsWith(`.${cookie.domain}`);
      if (match) {
        pairs.set(cookie.name, cookie.value);
      }
    }
    for (const [name, value] of Object.entries(extra)) {
      if (!pairs.has(name) && COOKIE_NAME.test(name) && COOKIE_VALUE.test(value)) {
        pairs.set(name, value);
      }
    }
    return [...pairs].map(([n, v]) => `${n}=${v}`).join('; ');
  }
}
