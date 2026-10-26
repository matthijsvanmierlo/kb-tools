/**
 * Draft History Tracker & Work Process Telemetry (KB-DRAFT-002)
 * Proposal #10: Non-invasive, local-only draft checkpointing with Ring Buffer
 * and factual work process metrics (no keyloggers, no outbox replication).
 */

import { storage } from './storage.js';

export const MAX_RING_BUFFER_SLOTS = 60;
const MIN_CHECKPOINT_INTERVAL_MS = 8000; // 8 seconds

export class DraftHistoryTracker {
  static _lastSavedTimestamps = new Map(); // `${itemId}|${studentId}` -> timestamp

  /**
   * Record a draft milestone if enough time has elapsed or a significant change occurred.
   *
   * @param {object} params
   * @param {string} params.itemId - Task ID or Assignment ID
   * @param {string} params.studentId - Student ID
   * @param {object|string} params.content - Current draft text, code, or answers
   * @param {boolean} [params.isPaste=false]
   * @param {number} [params.pasteLength=0]
   * @param {boolean} [params.force=false]
   * @returns {Promise<object|null>} the saved checkpoint or null if skipped
   */
  static async recordCheckpoint({
    itemId,
    studentId,
    content,
    isPaste = false,
    pasteLength = 0,
    force = false
  }) {
    if (!itemId || !studentId || content === undefined || content === null) {
      return null;
    }

    const key = `${itemId}|${String(studentId).toUpperCase()}`;
    const now = Date.now();
    const lastSaved = this._lastSavedTimestamps.get(key) || 0;

    // Throttle unless forced or large paste burst (>100 chars)
    if (!force && !isPaste && (now - lastSaved < MIN_CHECKPOINT_INTERVAL_MS)) {
      return null;
    }

    const nowIso = new Date(now).toISOString();
    this._lastSavedTimestamps.set(key, now);

    // Calculate text length for evolution sparkline
    let textLength = 0;
    if (typeof content === 'string') {
      textLength = content.length;
    } else if (typeof content === 'object') {
      if (typeof content.text === 'string') textLength += content.text.length;
      if (typeof content.text_md === 'string') textLength += content.text_md.length;
      if (Array.isArray(content.code_files)) {
        for (const f of content.code_files) {
          textLength += (f.content || '').length;
        }
      }
    }

    const checkpoint = {
      item_id: itemId,
      student_id: String(studentId).toUpperCase(),
      saved_at: nowIso,
      content,
      text_length: textLength,
      is_paste: Boolean(isPaste),
      paste_length: Number(pasteLength) || 0
    };

    try {
      const table = storage.table('draft_history');
      await table.add(checkpoint);

      // Enforce ring-buffer cap
      const allForStudent = await table
        .where('[item_id+student_id]')
        .equals([itemId, String(studentId).toUpperCase()])
        .sortBy('saved_at');

      if (allForStudent.length > MAX_RING_BUFFER_SLOTS) {
        const excess = allForStudent.length - MAX_RING_BUFFER_SLOTS;
        const toDeleteIds = allForStudent.slice(0, excess).map(c => c.id).filter(Boolean);
        if (toDeleteIds.length > 0) {
          await table.bulkDelete(toDeleteIds);
        }
      }

      return checkpoint;
    } catch (err) {
      console.warn('[DraftHistory] Checkpoint save warning:', err);
      return null;
    }
  }

  /**
   * Get all chronological checkpoints for an item.
   *
   * @param {string} itemId
   * @param {string} studentId
   * @returns {Promise<Array<object>>}
   */
  static async getCheckpoints(itemId, studentId) {
    if (!itemId || !studentId) return [];
    try {
      const table = storage.table('draft_history');
      return await table
        .where('[item_id+student_id]')
        .equals([itemId, String(studentId).toUpperCase()])
        .sortBy('saved_at');
    } catch (_) {
      return [];
    }
  }

  /**
   * Compute factual, non-invasive process telemetry from checkpoints.
   *
   * @param {string} itemId
   * @param {string} studentId
   * @returns {Promise<object>}
   */
  static async getProcessTelemetry(itemId, studentId) {
    const checkpoints = await this.getCheckpoints(itemId, studentId);
    if (!checkpoints.length) {
      return {
        has_telemetry: false,
        checkpoint_count: 0,
        active_minutes: 0,
        largest_paste: 0,
        paste_count: 0,
        evolution_curve: []
      };
    }

    const firstTime = new Date(checkpoints[0].saved_at).getTime();
    const lastTime = new Date(checkpoints[checkpoints.length - 1].saved_at).getTime();

    // Group editing timestamps into 1-minute buckets to estimate active writing duration
    const minuteBuckets = new Set();
    let largestPaste = 0;
    let pasteCount = 0;

    for (const cp of checkpoints) {
      const t = new Date(cp.saved_at).getTime();
      const minute = Math.floor(t / 60000);
      minuteBuckets.add(minute);

      if (cp.is_paste || cp.paste_length > 0) {
        pasteCount++;
        if (cp.paste_length > largestPaste) {
          largestPaste = cp.paste_length;
        }
      }
    }

    // Sample up to 20 points for the evolution curve
    const step = Math.max(1, Math.floor(checkpoints.length / 20));
    const evolutionCurve = [];
    for (let i = 0; i < checkpoints.length; i += step) {
      const cp = checkpoints[i];
      const offsetSec = Math.round((new Date(cp.saved_at).getTime() - firstTime) / 1000);
      evolutionCurve.push({
        sec: offsetSec,
        chars: cp.text_length || 0
      });
    }

    // Always include last point
    const lastCp = checkpoints[checkpoints.length - 1];
    const totalSec = Math.round((lastTime - firstTime) / 1000);
    if (!evolutionCurve.some(pt => pt.sec === totalSec)) {
      evolutionCurve.push({ sec: totalSec, chars: lastCp.text_length || 0 });
    }

    return {
      has_telemetry: true,
      checkpoint_count: checkpoints.length,
      first_saved_at: checkpoints[0].saved_at,
      last_saved_at: lastCp.saved_at,
      active_minutes: Math.max(1, minuteBuckets.size),
      largest_paste: largestPaste,
      paste_count: pasteCount,
      evolution_curve: evolutionCurve
    };
  }

  /**
   * Delete checkpoints for an item (e.g. after successful submission or wipe).
   */
  static async clearCheckpoints(itemId, studentId) {
    if (!itemId || !studentId) return;
    try {
      const table = storage.table('draft_history');
      const all = await table
        .where('[item_id+student_id]')
        .equals([itemId, String(studentId).toUpperCase()])
        .toArray();
      const ids = all.map(c => c.id).filter(Boolean);
      if (ids.length > 0) {
        await table.bulkDelete(ids);
      }
    } catch (_) {}
  }
}

export default DraftHistoryTracker;
