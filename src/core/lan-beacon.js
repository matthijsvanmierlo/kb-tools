/**
 * LanBeacon - KB-LAN-001
 *
 * Proposal #5: Zero-Config In-Room LAN & WebRTC Submissions Beacon
 *
 * Enables completely internet-free classroom sync and submissions over
 * local Wi-Fi or WebRTC data channels without external cloud servers.
 */

export class LanBeacon {
  static _activeRooms = new Map();
  static _listeners = new Set();

  /**
   * Probe whether a local classroom relay server is reachable on the LAN subnet.
   *
   * @param {string} [host='127.0.0.1']
   * @param {number} [port=3000]
   * @param {number} [timeoutMs=1500]
   * @returns {Promise<boolean>}
   */
  static async probeLocalRelay(host = '127.0.0.1', port = 3000, timeoutMs = 1500) {
    const url = `http://${host}:${port}/health`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { signal: controller.signal, mode: 'cors' });
      clearTimeout(timeout);
      return res.ok;
    } catch (_) {
      clearTimeout(timeout);
      return false;
    }
  }

  /**
   * Create an in-room submission beacon for zero-internet classrooms.
   *
   * @param {object} params
   * @param {string} params.taskId
   * @param {string} [params.classId]
   * @param {string} [params.title]
   * @returns {{ roomId: string, pin: string, beaconUrl: string, qrPayload: string }}
   */
  static createSubmissionRoom({ taskId, classId = '', title = '' }) {
    const roomId = `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const pin = String(Math.floor(1000 + Math.random() * 9000));

    const room = {
      roomId,
      pin,
      taskId,
      classId,
      title,
      created_at: new Date().toISOString(),
      submissions: new Map()
    };

    this._activeRooms.set(roomId, room);

    const baseUrl = typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : 'http://localhost:3000/';

    const beaconUrl = `${baseUrl}#/room/${roomId}?pin=${pin}`;
    const qrPayload = JSON.stringify({
      kblan: 1,
      room_id: roomId,
      pin,
      task_id: taskId
    });

    return {
      roomId,
      pin,
      beaconUrl,
      qrPayload
    };
  }

  /**
   * Student sends a submission directly to an active in-room teacher beacon.
   *
   * @param {object} params
   * @param {string} params.roomId
   * @param {string} params.pin
   * @param {string} params.studentId
   * @param {string} params.ciphertext - KBSUB1... envelope text
   * @returns {Promise<{ success: boolean, receiptId: string, timestamp: string }>}
   */
  static async submitToRoom({ roomId, pin, studentId, ciphertext }) {
    const room = this._activeRooms.get(roomId);
    if (!room) {
      throw new Error('In-room beacon not found or session has ended.');
    }

    if (room.pin && room.pin !== String(pin).trim()) {
      throw new Error('Incorrect in-room session PIN.');
    }

    const trimmed = String(ciphertext || '').trim();
    if (!trimmed.startsWith('KBSUB1.')) {
      throw new Error('Invalid submission format (must be KBSUB1).');
    }

    const receiptId = `LAN-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const timestamp = new Date().toISOString();

    const submissionEntry = {
      receipt_id: receiptId,
      room_id: roomId,
      student_id: String(studentId).toUpperCase(),
      ciphertext: trimmed,
      received_at: timestamp
    };

    room.submissions.set(studentId, submissionEntry);

    // Notify registered listeners
    for (const listener of this._listeners) {
      try {
        listener(submissionEntry);
      } catch (_) {}
    }

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('kb-lan-submission-received', { detail: submissionEntry }));
    }

    return {
      success: true,
      receiptId,
      timestamp
    };
  }

  /**
   * Subscribe to incoming submissions received by in-room beacon.
   *
   * @param {Function} callback
   * @returns {Function} unsubscribe function
   */
  static onSubmissionReceived(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  /**
   * Close and clear an active room beacon.
   *
   * @param {string} roomId
   */
  static closeRoom(roomId) {
    this._activeRooms.delete(roomId);
  }
}

export default LanBeacon;
