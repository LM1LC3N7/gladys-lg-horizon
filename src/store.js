// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume, file mode 0600):
//
//   boxes    the set-top boxes of the account (id, name, platform), so the
//            Discovery tab is filled again even while the cloud is down;
//   refresh  the latest refresh token the auth service gave (it changes at
//            every use, the typed one stops working), against the digest of
//            the credentials it came from;
//   block    a refusal of the credentials (digest, reason, time): no new
//            attempt until the credentials change or "Reconnect" is clicked;
//   pause    the end of a pause asked by the cloud (429).
//
// The box ids come from the network: the box table has no prototype, and an
// id that is not a plain identifier is never a key.
// -----------------------------------------------------------------------------

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS, TIMINGS } from './constants.js';
import { isSafeId } from './horizon/parse.js';

export const emptyData = () => ({
  boxes: Object.create(null),
  refresh: null,
  block: null,
  pause: null,
});

const HEX = /^[0-9a-f]{64}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const shortText = (v, max) => (typeof v === 'string' && v.length <= max ? v : undefined);

/** The saved data, checked field by field; `now` bounds a saved pause. */
export function sanitize(data, now = Date.now()) {
  const base = emptyData();
  if (!isObject(data)) {
    return base;
  }
  if (isObject(data.boxes)) {
    for (const [id, box] of Object.entries(data.boxes).slice(0, LIMITS.boxes * 2)) {
      if (isSafeId(id) && isObject(box) && box.id === id) {
        base.boxes[id] = {
          id,
          name: shortText(box.name, LIMITS.name) ?? id,
          platform: shortText(box.platform, 32) ?? '',
        };
      }
    }
  }
  const r = data.refresh;
  if (isObject(r) && HEX.test(r.fingerprint) && shortText(r.token, 8192)) {
    base.refresh = {
      fingerprint: r.fingerprint,
      token: r.token,
      expiry: Number.isFinite(r.expiry) ? r.expiry : null,
    };
  }
  const b = data.block;
  if (isObject(b) && HEX.test(b.fingerprint)) {
    base.block = {
      fingerprint: b.fingerprint,
      reason: b.reason === 'token' ? 'token' : 'credentials',
      at: Number.isFinite(b.at) ? b.at : now,
    };
  }
  const p = data.pause;
  if (isObject(p) && Number.isFinite(p.until) && p.until > now) {
    // A saved end is never trusted beyond the longest pause.
    base.pause = { until: Math.min(p.until, now + TIMINGS.pauseMax) };
  }
  return base;
}

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name = 'lg-horizon.json' } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    this.corrupted = false;
  }

  /**
   * The saved data. An unreadable file is moved aside to `lg-horizon.json.bad`
   * and `corrupted` is set, so the app says so instead of silently starting
   * over.
   */
  async load(now = Date.now()) {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return emptyData();
    }
    try {
      return sanitize(JSON.parse(text), now);
    } catch {
      this.corrupted = true;
      const bad = `${this.path}.bad`;
      await rename(this.path, bad).catch(() => {});
      await chmod(bad, 0o600).catch(() => {});
      return emptyData();
    }
  }

  async save(data) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData()) {
    this.data = JSON.parse(JSON.stringify(data));
    this.saves = 0;
    this.corrupted = false;
  }

  async load(now = Date.now()) {
    return sanitize(JSON.parse(JSON.stringify(this.data)), now);
  }

  async save(data) {
    // Through JSON, as the file store: what a restart would read back.
    this.data = JSON.parse(JSON.stringify(data));
    this.saves += 1;
  }
}
