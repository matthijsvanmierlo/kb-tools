import { storage } from '../storage.js';

/**
 * Hybrid Logical Clock (HLC) implementation.
 * Produces totally ordered stamps: "<ms 13 digits>-<counter 4 hex>-<deviceId>"
 */
export class HLC {
  constructor() {
    this.lastMs = 0;
    this.counter = 0;
    this._saveTimer = null;
  }

  static format(ms, counter, deviceId) {
    const msStr = String(ms).padStart(13, '0');
    const counterStr = (counter & 0xffff).toString(16).padStart(4, '0');
    return `${msStr}-${counterStr}-${deviceId || 'unknown'}`;
  }

  static parse(stamp) {
    if (!stamp || typeof stamp !== 'string') return null;
    const parts = stamp.split('-');
    if (parts.length < 3) return null;
    const ms = parseInt(parts[0], 10);
    const counter = parseInt(parts[1], 16);
    const deviceId = parts.slice(2).join('-');
    return { ms, counter, deviceId };
  }

  static compare(a, b) {
    return compareStamp(a, b);
  }

  async restore(store = storage) {
    try {
      const saved = await store.getMetadata('hlc_last_stamp');
      if (saved) {
        const p = parseStamp(saved);
        if (p.wall > this.lastMs) {
          this.lastMs = p.wall;
          this.counter = p.counter;
        }
      }
    } catch (_) {}
  }

  _persistThrottled(store = storage) {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(async () => {
      this._saveTimer = null;
      try {
        const stamp = HLC.format(this.lastMs, this.counter, 'persist');
        await store.setMetadata('hlc_last_stamp', stamp);
      } catch (_) {}
    }, 100);
  }

  generate(deviceId, store = storage) {
    const phys = Date.now();
    if (phys > this.lastMs) {
      this.lastMs = phys;
      this.counter = 0;
    } else {
      this.counter = (this.counter + 1) & 0xffff;
    }
    this._persistThrottled(store);
    return HLC.format(this.lastMs, this.counter, deviceId);
  }

  observe(remoteStamp, deviceId, store = storage) {
    const parsed = HLC.parse(remoteStamp);
    if (!parsed) return this.generate(deviceId, store);

    const now = Date.now();
    const maxAllowedFuture = now + 5 * 60 * 1000; // 5 min future cap
    const remoteMs = Math.min(parsed.ms, maxAllowedFuture);

    const maxMs = Math.max(now, Math.max(this.lastMs, remoteMs));

    if (maxMs === this.lastMs && maxMs === remoteMs) {
      this.counter = (Math.max(this.counter, parsed.counter) + 1) & 0xffff;
    } else if (maxMs === this.lastMs) {
      this.counter = (this.counter + 1) & 0xffff;
    } else if (maxMs === remoteMs) {
      this.counter = (parsed.counter + 1) & 0xffff;
    } else {
      this.counter = 0;
    }

    this.lastMs = maxMs;
    this._persistThrottled(store);
    return HLC.format(this.lastMs, this.counter, deviceId);
  }
}

/**
 * Parses wall-counter-device or legacy ISO date string into numerical fields
 */
export function parseStamp(s) {
  if (!s || typeof s !== 'string') return { wall: 0, counter: 0, device: '' };
  const hlcParsed = HLC.parse(s);
  if (hlcParsed && !Number.isNaN(hlcParsed.ms) && !Number.isNaN(hlcParsed.counter)) {
    return { wall: hlcParsed.ms, counter: hlcParsed.counter, device: hlcParsed.deviceId || '' };
  }
  const isoMs = Date.parse(s);
  if (!Number.isNaN(isoMs)) {
    return { wall: isoMs, counter: 0, device: '' };
  }
  return { wall: 0, counter: 0, device: String(s) };
}

/**
 * Compares two stamps (HLC format or legacy ISO updated_at string).
 * Returns -1 if a < b, 1 if a > b, 0 if equal.
 */
export function compareStamp(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const pa = parseStamp(a);
  const pb = parseStamp(b);
  if (pa.wall !== pb.wall) return pa.wall < pb.wall ? -1 : 1;
  if (pa.counter !== pb.counter) return pa.counter < pb.counter ? -1 : 1;
  if (pa.device !== pb.device) return pa.device < pb.device ? -1 : 1;
  return 0;
}

export const hlc = new HLC();
