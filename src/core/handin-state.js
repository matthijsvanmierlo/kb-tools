/**
 * Shared Hand-in State Model (KB-HANDIN-001)
 *
 * Ensures a single immutable envelope is sealed for a student's attempt across
 * all distribution channels (relay, .kbsub, .html, QR, copy) to prevent duplicates.
 */

export class HandinState {
  static makeKey(kind, itemId, studentId, publishVersion = 1) {
    const k = (kind === 'task' || kind === 'kb-task') ? 'task' : 'assignment';
    const sid = String(studentId || '').trim().toUpperCase();
    const ver = publishVersion || 1;
    return `handin:${k}:${itemId}:${sid}:${ver}`;
  }

  /**
   * Read the persistent handin state.
   */
  static get(kind, itemId, studentId, publishVersion = 1) {
    if (typeof localStorage === 'undefined') return null;
    try {
      const key = this.makeKey(kind, itemId, studentId, publishVersion);
      const val = localStorage.getItem(key);
      return val ? JSON.parse(val) : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Update or create the persistent handin state.
   */
  static set(kind, itemId, studentId, publishVersion = 1, state = {}) {
    if (typeof localStorage === 'undefined') return state;
    try {
      const key = this.makeKey(kind, itemId, studentId, publishVersion);
      const existing = this.get(kind, itemId, studentId, publishVersion) || {};
      const updated = {
        ...existing,
        ...state,
        channel_history: Array.isArray(state.channel_history)
          ? state.channel_history
          : (existing.channel_history || [])
      };
      localStorage.setItem(key, JSON.stringify(updated));
      return updated;
    } catch (_) {
      return state;
    }
  }

  /**
   * Record a channel delivery event (relay, download, share) in the attempt history.
   */
  static recordChannel(kind, itemId, studentId, publishVersion = 1, channel, extra = {}) {
    const current = this.get(kind, itemId, studentId, publishVersion) || {};
    const history = [...(current.channel_history || [])];
    history.push({
      channel,
      at: new Date().toISOString(),
      ...extra
    });
    return this.set(kind, itemId, studentId, publishVersion, {
      ...extra,
      channel_history: history
    });
  }

  /**
   * Clear the handin state (e.g. when initiating a new version/attempt).
   */
  static clear(kind, itemId, studentId, publishVersion = 1) {
    if (typeof localStorage === 'undefined') return;
    try {
      const key = this.makeKey(kind, itemId, studentId, publishVersion);
      localStorage.removeItem(key);
    } catch (_) {}
  }
}
