import storage from './storage.js';

/**
 * Base abstract class for KennisBoost sync transports.
 */
export class SyncTransport {
  static kind = 'null';

  /**
   * Initialize transport configuration.
   * @param {{ baseUrl?: string, token?: string, teacherId?: string }} config
   */
  async init(config = {}) {
    this.config = config;
    return this;
  }

  get capabilities() {
    return {
      hostPayload: false,
      collectSubmissions: false,
      pushChanges: false,
      pullChanges: false,
      roster: false
    };
  }

  /**
   * Check connection and server capabilities.
   * @returns {Promise<{ ok: boolean, serverVersion?: string|null, features?: string[], error?: string }>}
   */
  async health() {
    return { ok: false, serverVersion: null };
  }

  /**
   * Publish an encrypted payload to the relay.
   * @param {{ kind: string, ciphertext: string, expiresAt?: string, meta?: any }} param0
   * @returns {Promise<{ ref: string }>}
   */
  async publishPayload({ kind, ciphertext, expiresAt, meta }) {
    throw new Error('publishPayload not supported by this transport');
  }

  /**
   * Fetch an encrypted payload from the relay.
   * @param {string} ref
   * @returns {Promise<{ kind: string, ciphertext: string }>}
   */
  async fetchPayload(ref) {
    throw new Error('fetchPayload not supported by this transport');
  }

  /**
   * Create an assignment drop box for receiving submissions.
   * @param {{ assignmentId: string, publishVersion?: number, expiresAt?: string }} param0
   * @returns {Promise<{ dropId: string }>}
   */
  async createDrop({ assignmentId, publishVersion, expiresAt }) {
    throw new Error('createDrop not supported by this transport');
  }

  /**
   * Submit an encrypted submission envelope to a drop box (student side, no auth).
   * @param {string} dropId
   * @param {string} envelopeText
   * @returns {Promise<{ receiptId: string, received_at: string }>}
   */
  async submitToDrop(dropId, envelopeText) {
    throw new Error('submitToDrop not supported by this transport');
  }

  /**
   * List submissions in a drop box (teacher side, authenticated).
   * @param {string} dropId
   * @param {{ since?: string }} options
   * @returns {Promise<{ items: Array<{ id: string, received_at: string, text: string }> }>}
   */
  async listDrop(dropId, { since } = {}) {
    throw new Error('listDrop not supported by this transport');
  }

  /**
   * Delete a drop box.
   * @param {string} dropId
   * @returns {Promise<void>}
   */
  async deleteDrop(dropId) {
    throw new Error('deleteDrop not supported by this transport');
  }

  /**
   * State sync (Option B) - push change log ops.
   */
  async pushChanges(ops) {
    throw new Error('pushChanges not supported in this transport');
  }

  /**
   * State sync (Option B) - pull remote ops.
   */
  async pullChanges({ sinceServerSeq } = {}) {
    throw new Error('pullChanges not supported in this transport');
  }
}

/**
 * Null transport representing offline/serverless mode.
 */
export class NullTransport extends SyncTransport {
  static kind = 'null';
}

/**
 * RelayTransport communicating with the reference HTTP relay server (/api/v1).
 */
export class RelayTransport extends SyncTransport {
  static kind = 'relay';

  constructor(config = {}) {
    super();
    this.baseUrl = config.baseUrl || '';
    this.token = config.token || '';
    this.teacherId = config.teacherId || '';
  }

  async init(config = {}) {
    this.baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    this.token = config.token || '';
    this.teacherId = config.teacherId || '';
    return this;
  }

  get apiBase() {
    const base = (this.baseUrl || '').replace(/\/+$/, '');
    if (base.endsWith('/api/v1')) return base;
    return `${base}/api/v1`;
  }

  get capabilities() {
    return {
      hostPayload: true,
      collectSubmissions: true,
      pushChanges: false,
      pullChanges: false,
      roster: false
    };
  }

  async health() {
    try {
      const res = await fetch(`${this.apiBase}/health`);
      if (!res.ok) {
        return { ok: false, error: `Server returned HTTP ${res.status}` };
      }
      const data = await res.json();
      return {
        ok: Boolean(data.ok !== false),
        serverVersion: data.version || null,
        features: data.features || ['payloads', 'drops']
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async publishPayload({ kind, ciphertext, expiresAt, meta }) {
    const res = await fetch(`${this.apiBase}/payloads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify({
        kind,
        ciphertext,
        expires_at: expiresAt,
        meta
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to publish payload: ${res.status}`);
    }
    const data = await res.json();
    return { ref: data.ref };
  }

  async fetchPayload(ref) {
    const res = await fetch(`${this.apiBase}/payloads/${encodeURIComponent(ref)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to fetch payload: ${res.status}`);
    }
    const data = await res.json();
    return {
      kind: data.kind,
      ciphertext: data.ciphertext
    };
  }

  async createDrop({ assignmentId, publishVersion, expiresAt }) {
    const res = await fetch(`${this.apiBase}/drops`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify({
        assignment_id: assignmentId,
        publish_version: publishVersion,
        expires_at: expiresAt
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to create drop: ${res.status}`);
    }
    const data = await res.json();
    return { dropId: data.drop_id || data.dropId };
  }

  async submitToDrop(dropId, envelopeText) {
    const res = await fetch(`${this.apiBase}/drops/${encodeURIComponent(dropId)}/submissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain'
      },
      body: envelopeText
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to submit to drop: ${res.status}`);
    }
    const data = await res.json();
    return {
      receiptId: data.receipt_id || data.receiptId,
      received_at: data.received_at
    };
  }

  async listDrop(dropId, { since } = {}) {
    const url = new URL(`${this.apiBase}/drops/${encodeURIComponent(dropId)}/submissions`);
    if (since) url.searchParams.set('since', since);
    const res = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to list submissions: ${res.status}`);
    }
    const data = await res.json();
    return { items: data.items || [] };
  }

  async deleteDrop(dropId) {
    const res = await fetch(`${this.apiBase}/drops/${encodeURIComponent(dropId)}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });
    if (!res.ok && res.status !== 404) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to delete drop: ${res.status}`);
    }
  }
}

let _currentTransport = null;

/**
 * Get the current sync transport instance according to configuration precedence:
 * window.KB_CONFIG -> app_metadata.sync_config -> NullTransport
 *
 * @param {{ forceReload?: boolean }} options
 * @returns {Promise<SyncTransport>}
 */
export async function getTransport({ forceReload = false } = {}) {
  if (_currentTransport && !forceReload) {
    return _currentTransport;
  }

  let config = null;
  if (typeof window !== 'undefined' && window.KB_CONFIG && window.KB_CONFIG.baseUrl) {
    config = window.KB_CONFIG;
  } else {
    try {
      config = await storage.getMetadata('sync_config');
    } catch {
      config = null;
    }
  }

  if (config && config.baseUrl) {
    const relay = new RelayTransport();
    await relay.init(config);
    _currentTransport = relay;
  } else {
    _currentTransport = new NullTransport();
  }

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('kb-transport-changed', {
      detail: { transport: _currentTransport }
    }));
  }

  return _currentTransport;
}

/**
 * Update transport configuration and reload active transport.
 * @param {{ baseUrl?: string, token?: string, teacherId?: string }|null} config
 * @returns {Promise<SyncTransport>}
 */
export async function setTransportConfig(config) {
  if (config && config.baseUrl) {
    await storage.setMetadata('sync_config', config);
  } else {
    await storage.setMetadata('sync_config', null);
  }
  return await getTransport({ forceReload: true });
}
