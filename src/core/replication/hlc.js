/**
 * Hybrid Logical Clock (HLC) implementation.
 * Produces totally ordered stamps: "<ms 13 digits>-<counter 4 hex>-<deviceId>"
 */
export class HLC {
  constructor() {
    this.lastMs = 0;
    this.counter = 0;
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
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  generate(deviceId) {
    const phys = Date.now();
    if (phys > this.lastMs) {
      this.lastMs = phys;
      this.counter = 0;
    } else {
      this.counter = (this.counter + 1) & 0xffff;
    }
    return HLC.format(this.lastMs, this.counter, deviceId);
  }

  observe(remoteStamp, deviceId) {
    const parsed = HLC.parse(remoteStamp);
    if (!parsed) return this.generate(deviceId);

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
    return HLC.format(this.lastMs, this.counter, deviceId);
  }
}

export const hlc = new HLC();
